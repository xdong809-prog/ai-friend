"use strict";
/* 一键备份和恢复：备份里没有密钥；恢复先放好、重启才换，换之前留一份现状；坏文件和危险路径不恢复 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { start, fakeNet } = require("./_helpers");
const { tarPack, tarUnpack, safeEntry, stageRestore, applyPendingRestore, pendingInfo } = require("../lib/backup");

const silentLog = { info() {}, warn() {}, debug() {}, error() {} };
const CONFIG = {
  providers: [{ id: "ds", preset: "deepseek", apiKey: "sk-secret-123456", model: "deepseek-v4-pro" }],
  llm: { active: "ds" },
  qq: { token: "qq-token-secret" },
  notify: { webhook: "https://push.example.com/secret" },
  friend: { name: "小鱼" },
};

async function download(s) {
  const res = await fetch(`${s.base}/api/backup`);
  return { res, files: tarUnpack(zlib.gunzipSync(Buffer.from(await res.arrayBuffer()))) };
}

test("tar 能打包能解开：中文文件名、超过 100 字节的长路径都行", () => {
  const long = "data/" + "很长的文件夹名字".repeat(5) + "/" + "x".repeat(60) + ".json";
  assert.ok(Buffer.byteLength(long) > 100);
  const files = tarUnpack(tarPack([{ name: "data/记忆.json", data: Buffer.from("你好") }, { name: long, data: Buffer.alloc(1300, 7) }]));
  assert.deepEqual(files.map((f) => f.name), ["data/记忆.json", long]);
  assert.equal(files[0].data.toString(), "你好");
  assert.equal(files[1].data.length, 1300);
});

test("下载备份：是 tar.gz 附件；有聊天记录和设置，没有 Key、Token、Webhook，也没有日志和旧备份", async () => {
  const s = await start({ config: CONFIG, net: fakeNet() });
  s.memory.append("main", { role: "user", text: "我叫老王", ts: 1 });
  const dataDir = path.join(s.root, "data");
  fs.writeFileSync(path.join(dataDir, "sessions", "main.jsonl.bak-1"), "旧的");
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "logs", "server.log"), "日志");
  const { res, files } = await download(s);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="ai-friend-backup-\d{8}-\d{4}\.tar\.gz"/);
  const names = files.map((f) => f.name);
  assert.ok(names.includes("manifest.json"));
  assert.ok(names.includes("data/sessions/main.jsonl"));
  assert.ok(!names.some((n) => n.includes("logs/") || n.includes(".bak-")));
  const settings = files.find((f) => f.name === "settings.json").data.toString();
  assert.match(settings, /小鱼/);
  for (const secret of ["sk-secret-123456", "qq-token-secret", "push.example.com"]) assert.ok(!settings.includes(secret), secret);
  await s.close();
});

test("恢复：先放好、重启时才换；换之前留一份现状；设置回来了，现在的 Key 不变", async () => {
  const s = await start({ config: CONFIG, net: fakeNet() });
  s.memory.append("main", { role: "user", text: "备份里的话", ts: 1 });
  const { files } = await download(s);
  const backup = zlib.gzipSync(tarPack(files));
  await s.close();

  // 换一台（另一个目录）：已经聊了别的
  const s2 = await start({ config: CONFIG, net: fakeNet() });
  s2.memory.append("main", { role: "user", text: "恢复前的话", ts: 3 });
  const up = await fetch(`${s2.base}/api/backup/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: backup });
  const r = await up.json();
  assert.equal(r.ok, true);
  assert.ok(r.pending);
  assert.doesNotMatch(fs.readFileSync(path.join(s2.root, "data", "sessions", "main.jsonl"), "utf8"), /备份里的话/); // 重启前还没换
  await s2.close();

  // 期间改了名字、换了 Key
  const root = s2.root;
  const d2 = path.join(root, "data");
  const c2 = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  c2.friend.name = "改了名";
  c2.providers[0].apiKey = "sk-new-key-999999";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(c2));

  assert.equal(applyPendingRestore({ root, dataDir: d2, log: silentLog }), true);
  assert.match(fs.readFileSync(path.join(d2, "sessions", "main.jsonl"), "utf8"), /备份里的话/);
  assert.equal(pendingInfo(d2), null);
  const snaps = fs.readdirSync(path.join(d2, "backups"));
  assert.equal(snaps.length, 1);
  const snap = tarUnpack(zlib.gunzipSync(fs.readFileSync(path.join(d2, "backups", snaps[0]))));
  assert.match(snap.find((f) => f.name === "data/sessions/main.jsonl").data.toString(), /恢复前的话/);
  const after = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.equal(after.friend.name, "小鱼");
  assert.equal(after.providers[0].apiKey, "sk-new-key-999999");
  assert.equal(applyPendingRestore({ root, dataDir: d2, log: silentLog }), false); // 没有要恢复的就什么都不做
});

test("坏文件、别的压缩包、带 .. 或绝对路径的都不恢复，现有数据不受影响；可以取消", async () => {
  assert.equal(safeEntry("data/sessions/main.jsonl"), true);
  for (const bad of ["../evil", "data/../config.json", "/etc/passwd", "C:/x", "data\\x", "data/logs/x", "data/.restore-pending/x", "config.json", "data"]) assert.equal(safeEntry(bad), false, bad);

  const s = await start({ config: CONFIG, net: fakeNet() });
  const dataDir = path.join(s.root, "data");
  const post = async (body) => {
    const res = await fetch(`${s.base}/api/backup/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
    return { status: res.status, json: await res.json() };
  };
  assert.match((await post(Buffer.from("随便什么"))).json.error, /不是备份文件/);
  const other = zlib.gzipSync(tarPack([{ name: "readme.txt", data: Buffer.from("x") }]));
  assert.match((await post(other)).json.error, /不是 AI 好友的备份/);
  const manifest = { name: "manifest.json", data: Buffer.from(JSON.stringify({ app: "ai-friend" })) };
  const evil = zlib.gzipSync(tarPack([manifest, { name: "data/../../evil.txt", data: Buffer.from("x") }]));
  const r = await post(evil);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不安全的路径/);
  assert.equal(pendingInfo(dataDir), null);
  assert.equal(fs.existsSync(path.join(s.root, "evil.txt")), false);

  const good = zlib.gzipSync(tarPack([manifest, { name: "data/sessions/main.jsonl", data: Buffer.from("") }]));
  assert.equal((await post(good)).status, 200);
  assert.ok(pendingInfo(dataDir));
  const cancel = await s.api("POST", "/api/backup/cancel");
  assert.equal(cancel.json.pending, null);
  assert.equal(pendingInfo(dataDir), null);
  await s.close();
});

test("暂存不会写到 data 外面：stageRestore 只往 .restore-pending 里写", () => {
  const dataDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "aif-bk-"));
  const manifest = { name: "manifest.json", data: Buffer.from(JSON.stringify({ app: "ai-friend", createdAt: 5 })) };
  const r = stageRestore(zlib.gzipSync(tarPack([manifest, { name: "data/profiles/main.json", data: Buffer.from("{}") }])), { dataDir });
  assert.equal(r.files, 1);
  assert.deepEqual(fs.readdirSync(dataDir), [".restore-pending"]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
