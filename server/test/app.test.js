"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { start } = require("./_helpers");
const { savePatch, loadConfig } = require("../lib/config");

test("本机守卫：别的网站发来的请求、伪造 Host 的请求都被拒绝", async () => {
  const s = await start();
  assert.equal((await s.api("GET", "/api/history", undefined, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await s.api("POST", "/api/config", { friend: { name: "坏人" } }, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await s.api("GET", "/api/memory", undefined, { Origin: "null" })).status, 403);
  assert.equal((await s.api("GET", "/api/history")).status, 200);
  assert.equal((await s.api("GET", "/api/history", undefined, { Origin: s.base })).status, 200);
  const status = await new Promise((resolve, reject) => {
    const req = require("node:http").request({ host: "127.0.0.1", port: s.port, path: "/api/history", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403, "DNS rebinding / 伪造 Host 被拒绝");
  await s.close();
});

test("配置接口不下发任何密钥", async () => {
  const s = await start({ config: { llm: { apiKey: "sk-secret-abcdef123" }, qq: { token: "tok-secret-1" } } });
  const r = await s.api("GET", "/api/config");
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes("sk-secret"));
  assert.ok(!text.includes("tok-secret"));
  assert.equal(r.json.config.llm.hasKey, true);
  await s.close();
});

test("保存设置：只改提交的字段；模型的 Key 留空不覆盖原 Key；立即生效", async () => {
  const s = await start({ config: { llm: { apiKey: "sk-keep-me-123456" }, friend: { name: "小满", style: "gentle" } } });
  const pub = (await s.api("GET", "/api/config")).json.config;
  const r = await s.api("POST", "/api/config", { friend: { name: "阿凛" }, providers: pub.providers });
  assert.equal(r.status, 200);
  const disk = JSON.parse(fs.readFileSync(path.join(s.root, "config.json"), "utf8"));
  assert.equal(disk.friend.name, "阿凛");
  assert.equal(disk.friend.style, "gentle");
  assert.equal(disk.providers[0].apiKey, "sk-keep-me-123456");
  assert.equal(s.config.friend.name, "阿凛");
  await s.close();
});

test("环境变量里的 Key 不会被写进 config.json", async () => {
  const s = await start({ config: { llm: { apiKey: "sk-on-disk-1111" } } });
  const env = { LLM_API_KEY: "sk-from-env-999999" };
  const runtime = savePatch(s.root, { friend: { name: "软软" } }, env);
  assert.equal(runtime.providers[0].apiKey, "sk-from-env-999999");
  const disk = JSON.parse(fs.readFileSync(path.join(s.root, "config.json"), "utf8"));
  assert.equal(disk.providers[0].apiKey, "sk-on-disk-1111");
  assert.equal(loadConfig(s.root, {}).providers[0].apiKey, "sk-on-disk-1111");
  await s.close();
});

test("非法配置值被纠正", async () => {
  const s = await start();
  await s.api("POST", "/api/config", { friend: { style: "不存在" }, owner: { qq: "12345678, abc, 87654321" }, qq: { mergeWindowMs: 999999 } });
  assert.equal(s.config.friend.style, "gentle");
  assert.deepEqual(s.config.owner.qq, ["12345678", "87654321"]);
  assert.equal(s.config.qq.mergeWindowMs, 15000);
  await s.close();
});

test("网页静态文件能打开，不能越权读别的文件", async () => {
  const s = await start();
  assert.equal((await s.api("GET", "/")).status, 200);
  assert.equal((await s.api("GET", "/app.js")).status, 200);
  assert.equal((await s.api("GET", "/../config.json")).status, 404);
  assert.equal((await s.api("GET", "/%2e%2e/config.json")).status, 404);
  assert.equal((await s.api("GET", "/api/nope")).status, 404);
  await s.close();
});

test("记忆接口：增删改都能用", async () => {
  const s = await start();
  let r = await s.api("POST", "/api/memory", { op: "addFact", text: "不吃香菜" });
  assert.equal(r.json.profile.facts[0].text, "不吃香菜");
  r = await s.api("POST", "/api/memory", { op: "setBasic", key: "生日", value: "5月20日" });
  assert.equal(r.json.profile.basics["生日"].value, "5月20日");
  r = await s.api("POST", "/api/memory", { op: "addEvent", text: "去面试", date: "2026-10-30" });
  const id = r.json.profile.events[0].id;
  r = await s.api("POST", "/api/memory", { op: "removeEvent", id });
  assert.equal(r.json.profile.events.length, 0);
  r = await s.api("POST", "/api/memory", { op: "removeFact", text: "不吃香菜" });
  assert.equal(r.json.profile.facts.length, 0);
  assert.equal((await s.api("POST", "/api/memory", { op: "乱写" })).status, 400);
  await s.close();
});

test("/health 能看到大模型和 QQ 的状态", async () => {
  const s = await start();
  const h = (await s.api("GET", "/health")).json;
  assert.equal(h.ok, true);
  assert.equal(h.llm.enabled, false);
  assert.equal(h.qq.enabled, true);
  await s.close();
});
