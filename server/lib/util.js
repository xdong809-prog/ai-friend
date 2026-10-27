"use strict";
/*
 * 通用小工具：文件读写（原子写）、按 key 串行的锁、时间格式化、数值夹取。
 * 全部只用 Node 内置模块。
 */
const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return fallback;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 先写临时文件再改名：断电或崩溃时不会留下写了一半的 JSON。Windows 上被杀毒软件占用时重试几次。 */
function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      sleepSync(30 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  throw lastErr;
}

function writeJsonAtomic(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

/** 同一个 key 的任务排队执行，不同 key 互不影响。 */
function createKeyedLock() {
  const tails = new Map();
  return function run(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const pad = (n) => String(n).padStart(2, "0");
const WEEK = "日一二三四五六";

function partOfDay(h) {
  if (h < 5) return "凌晨";
  if (h < 8) return "早上";
  if (h < 11) return "上午";
  if (h < 13) return "中午";
  if (h < 17) return "下午";
  if (h < 19) return "傍晚";
  if (h < 23) return "晚上";
  return "深夜";
}

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 2026年10月26日 星期一 晚上 22:01 */
function fmtNow(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]} ${partOfDay(d.getHours())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 10月26日 22:01 */
function fmtShort(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 两个时间点之间隔了多久（给模型看的中文描述） */
function fmtGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60000);
  if (min < 2) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} 天`;
  return `${Math.round(d / 30)} 个月`;
}

/** 两个日期相差几天（按本地日期，不按 24 小时） */
function dayDiff(fromTs, toYmd) {
  const [y, m, d] = String(toYmd).split("-").map(Number);
  if (!y || !m || !d) return NaN;
  const a = new Date(fromTs);
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const end = new Date(y, m - 1, d).getTime();
  return Math.round((end - start) / 86400000);
}

/** 文件名安全化：只留字母数字和 _-. */
function safeName(raw) {
  const s = String(raw || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  return s || "default";
}

module.exports = {
  ensureDir,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
  createKeyedLock,
  clamp,
  pad,
  partOfDay,
  ymd,
  fmtNow,
  fmtShort,
  fmtGap,
  dayDiff,
  safeName,
};
