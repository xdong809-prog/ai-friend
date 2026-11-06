"use strict";
/*
 * 一键备份和恢复。
 *
 * 备份是普通的 .tar.gz（常见解压软件能打开），只用 Node 内置模块生成：
 *   manifest.json   版本和时间
 *   settings.json   设置，已去掉 API Key、Token、Webhook
 *   data/...        聊天记录、记忆、表情包等（不含日志、旧备份和 .bak 文件）
 *
 * 恢复分两步，避免运行中的服务把内存里的旧内容写回去盖掉：
 *   1. stageRestore：校验并解压到 data/.restore-pending/，提示用户重启；
 *   2. applyPendingRestore：下次启动时，先把现有数据打包存到 data/backups/，再换成备份里的内容。
 * 设置用 savePatch 合并：Key、Token 留空表示不改，所以现有的不会被覆盖。
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { ensureDir, ymd, pad } = require("./util");
const { normalizeConfig, readRawConfig, savePatch } = require("./config");

const APP = "ai-friend";
const PENDING = ".restore-pending";
const BACKUPS = "backups";
const SKIP_TOP = new Set(["logs", BACKUPS, PENDING]);
const MAX_UNPACKED = 4 * 1024 * 1024 * 1024; // 解压后最大 4 GB，防止坏文件撑爆内存
const KEEP_SNAPSHOTS = 5;

// ---------- tar ----------

/** PAX 记录「长度 key=value\n」，长度包含它自己的位数，所以要试着算 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body);
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, "utf8");
}

function tarHeader(name, size, mtimeMs, type = "0") {
  const h = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, "utf8");
  let namePart = name;
  let prefix = "";
  if (nameBuf.length > 100) {
    // ustar：长路径拆成 prefix + name，从某个 / 分开
    const parts = name.split("/");
    let i = parts.length - 1;
    while (i > 0 && Buffer.byteLength(parts.slice(i - 1).join("/")) <= 100) i--;
    namePart = parts.slice(i).join("/");
    prefix = parts.slice(0, i).join("/");
    if (Buffer.byteLength(namePart) > 100 || Buffer.byteLength(prefix) > 155) return null;
  }
  h.write(namePart, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(Math.floor(mtimeMs / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // 算校验和时这 8 字节按空格算
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0" + "00", 257, 8, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

function tarPack(entries) {
  const out = [];
  const push = (header, data) => {
    out.push(header, data);
    const rest = data.length % 512;
    if (rest) out.push(Buffer.alloc(512 - rest));
  };
  entries.forEach((e, i) => {
    const mtime = e.mtimeMs || Date.now();
    // 中文或者太长的路径：先放一个 PAX 头写明 UTF-8 的完整路径（Windows 自带的 tar、7-Zip 都认），
    // 后面普通头里的名字只是给不认 PAX 的老工具看的
    const pax = /[^\x20-\x7e]/.test(e.name) || Buffer.byteLength(e.name) > 100;
    if (pax) {
      const rec = paxRecord("path", e.name);
      push(tarHeader(`PaxHeader/${i}`, rec.length, mtime, "x"), rec);
    }
    const header = tarHeader(e.name, e.data.length, mtime) || (pax && tarHeader(`long-name-${i}`, e.data.length, mtime));
    if (header) push(header, e.data);
  });
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

/** PAX 头里的 key=value */
function parsePax(buf) {
  const out = {};
  const s = buf.toString("utf8");
  for (let i = 0; i < s.length; ) {
    const sp = s.indexOf(" ", i);
    const len = parseInt(s.slice(i, sp), 10);
    if (!(len > 0)) break;
    const rec = Buffer.from(s.slice(i)).subarray(0, len).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(rec.indexOf(" ") + 1, eq)] = rec.slice(eq + 1).replace(/\n$/, "");
    i += rec.length;
  }
  return out;
}

const cstr = (buf) => {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString("utf8");
};

function tarUnpack(buf) {
  const files = [];
  let paxPath = "";
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(cstr(h.subarray(148, 156)).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== stored) throw new Error("文件损坏（校验不对）");
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8);
    const prefix = cstr(h.subarray(345, 500));
    const name = (prefix ? prefix + "/" : "") + cstr(h.subarray(0, 100));
    const type = String.fromCharCode(h[156] || 48);
    const start = off + 512;
    if (start + size > buf.length) throw new Error("文件不完整");
    const data = buf.subarray(start, start + size);
    if (type === "x") paxPath = parsePax(data).path || "";
    else if (type === "0") {
      files.push({ name: paxPath || name, data });
      paxPath = "";
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

// ---------- 备份 ----------

/** 设置（去掉所有密钥） */
function cleanSettings(root) {
  const c = normalizeConfig(readRawConfig(root));
  c.providers = c.providers.map((p) => ({ ...p, apiKey: "" }));
  if (c.llm) delete c.llm.apiKey;
  c.qq.token = "";
  c.notify.webhook = "";
  delete c.port; // 端口和这台电脑的环境有关，不跟着备份走
  return c;
}

function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!base && (SKIP_TOP.has(e.name) || e.name.startsWith(PENDING))) continue;
      out.push(...walk(path.join(dir, e.name), rel));
    } else if (e.isFile() && !/\.bak-|\.tmp-/.test(e.name)) out.push(rel);
  }
  return out;
}

/** 打一份备份：返回 .tar.gz 的内容 */
function createBackup({ root, dataDir, version = "", now = Date.now }) {
  const t = now();
  const entries = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify({ app: APP, version, createdAt: t }, null, 2)), mtimeMs: t },
    { name: "settings.json", data: Buffer.from(JSON.stringify(cleanSettings(root), null, 2)), mtimeMs: t },
  ];
  for (const rel of walk(dataDir)) {
    const file = path.join(dataDir, rel);
    entries.push({ name: `data/${rel}`, data: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs });
  }
  return zlib.gzipSync(tarPack(entries));
}

function backupFileName(t) {
  const d = new Date(t);
  return `ai-friend-backup-${ymd(t).replace(/-/g, "")}-${pad(d.getHours())}${pad(d.getMinutes())}.tar.gz`;
}

// ---------- 恢复 ----------

/** 只允许 manifest.json、settings.json 和 data/ 下的相对路径；挡住 .. 和绝对路径（防止写到别的地方去） */
function safeEntry(name) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) return false;
  if (parts[0] === "data") return parts.length >= 2 && !SKIP_TOP.has(parts[1]);
  return parts.length === 1 && (name === "manifest.json" || name === "settings.json");
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** 第一步：校验并解压到 data/.restore-pending/。不碰现有数据 */
function stageRestore(buf, { dataDir }) {
  let raw;
  try {
    raw = zlib.gunzipSync(buf, { maxOutputLength: MAX_UNPACKED });
  } catch {
    throw bad("这不是备份文件（解压失败）");
  }
  let files;
  try {
    files = tarUnpack(raw);
  } catch (e) {
    throw bad("备份文件坏了：" + e.message);
  }
  const manifest = files.find((f) => f.name === "manifest.json");
  let info = null;
  try {
    info = manifest && JSON.parse(manifest.data.toString("utf8"));
  } catch {
    /* 下面统一报错 */
  }
  if (!info || info.app !== APP) throw bad("这不是 AI 好友的备份文件");
  const unsafe = files.find((f) => !safeEntry(f.name));
  if (unsafe) throw bad("备份文件里有不安全的路径，不恢复：" + unsafe.name.slice(0, 80));

  const pending = path.join(dataDir, PENDING);
  const tmp = `${pending}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(tmp, ...f.name.split("/"));
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, f.data);
  }
  fs.rmSync(pending, { recursive: true, force: true });
  fs.renameSync(tmp, pending);
  return { files: files.filter((f) => f.name.startsWith("data/")).length, createdAt: info.createdAt || 0, version: info.version || "" };
}

function pendingInfo(dataDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dataDir, PENDING, "manifest.json"), "utf8"));
    return { createdAt: m.createdAt || 0, version: m.version || "" };
  } catch {
    return null;
  }
}

function cancelRestore(dataDir) {
  fs.rmSync(path.join(dataDir, PENDING), { recursive: true, force: true });
}

/** 第二步：启动时调用（要在读数据之前）。先留一份现状，再换内容。出错时现有数据尽量不动 */
function applyPendingRestore({ root, dataDir, log, version = "", now = Date.now }) {
  const pending = path.join(dataDir, PENDING);
  if (!pendingInfo(dataDir)) return false;
  const t = now();
  const snapshots = path.join(dataDir, BACKUPS);
  try {
    ensureDir(snapshots);
    fs.writeFileSync(path.join(snapshots, `before-restore-${t}.tar.gz`), createBackup({ root, dataDir, version, now }));
    const old = fs.readdirSync(snapshots).filter((n) => n.startsWith("before-restore-")).sort();
    for (const n of old.slice(0, Math.max(0, old.length - KEEP_SNAPSHOTS))) fs.rmSync(path.join(snapshots, n), { force: true });

    for (const e of fs.readdirSync(dataDir)) {
      if (!SKIP_TOP.has(e)) fs.rmSync(path.join(dataDir, e), { recursive: true, force: true });
    }
    const incoming = path.join(pending, "data");
    if (fs.existsSync(incoming)) {
      for (const e of fs.readdirSync(incoming)) fs.renameSync(path.join(incoming, e), path.join(dataDir, e));
    }
    const settingsFile = path.join(pending, "settings.json");
    if (fs.existsSync(settingsFile)) savePatch(root, JSON.parse(fs.readFileSync(settingsFile, "utf8")));
    fs.rmSync(pending, { recursive: true, force: true });
    log.info(`已从备份恢复。恢复前的数据存在 data/${BACKUPS}/before-restore-${t}.tar.gz`);
    return true;
  } catch (e) {
    // 不留着 pending，免得每次启动都重来一遍；现状快照还在
    log.error(`恢复备份失败：${e.message}。恢复前的数据在 data/${BACKUPS}/ 里`);
    try {
      fs.renameSync(pending, `${pending}-failed-${t}`);
    } catch {
      /* 改不了名也不影响启动 */
    }
    return false;
  }
}

module.exports = { createBackup, backupFileName, stageRestore, pendingInfo, cancelRestore, applyPendingRestore, tarPack, tarUnpack, safeEntry };
