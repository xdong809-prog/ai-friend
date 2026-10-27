"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, fakeNet } = require("./_helpers");

const KEY = { llm: { apiKey: "sk-test-1234567890" } };

function chatOnly(fn) {
  return (m, body) => (m[0].content.includes("记忆整理") ? "{}" : m[0].content.includes("聊天笔记") ? "摘要" : fn(m, body));
}

test("没有 Key：离线兜底回复，网页提示去填 Key", async () => {
  const s = await start();
  const r = await s.api("POST", "/api/chat", { text: "在吗" });
  assert.equal(r.json.engine, "offline");
  assert.ok(r.json.bubbles.length >= 1);
  assert.ok(r.json.bubbles.some((b) => /API Key/.test(b)));
  await s.close();
});

test("连发的几条作为一段话送给模型，并提示「连着发了 N 条」", async () => {
  let seen;
  const net = fakeNet({ llm: chatOnly((m) => ((seen = m), "〔想〕嗯\n〔心情〕平静\n知道啦")) });
  const s = await start({ config: KEY, net });
  await s.api("POST", "/api/chat", { texts: ["我跟你说", "今天被老板骂了", "气死"] });
  assert.equal(seen[seen.length - 1].content, "我跟你说\n今天被老板骂了\n气死");
  assert.match(seen[seen.length - 2].content, /连着发了 3 条/);
  assert.equal(seen[seen.length - 2].role, "system", "每轮变化的信息放在最新消息前的第二条 system 里");
  await s.close();
});

test("上下文：之前的对话按顺序完整带上，你说过的话带着当时的〔想〕，固定提示词在最前面", async () => {
  const seen = [];
  const net = fakeNet({ llm: chatOnly((m) => (seen.push(m), "〔想〕秘密想法\n〔心情〕开心\n好呀")) });
  const s = await start({ config: KEY, net });
  await s.api("POST", "/api/chat", { text: "周末去爬山吗" });
  await s.api("POST", "/api/chat", { text: "那就周六" });
  const last = seen[seen.length - 1];
  assert.deepEqual(
    last.slice(1).map((x) => [x.role, x.role === "system" ? "(本轮信息)" : x.content]),
    [
      ["user", "周末去爬山吗"],
      ["assistant", "〔想〕秘密想法\n〔心情〕开心\n好呀"],
      ["system", "(本轮信息)"],
      ["user", "那就周六"],
    ]
  );
  // 固定部分两轮完全一样（能命中模型服务的前缀缓存）
  assert.equal(seen[0][0].content, last[0].content);
  const h = await s.api("GET", "/api/history");
  assert.ok(!JSON.stringify(h.json).includes("秘密想法"), "内心活动不会出现在给你看的聊天记录里");
  await s.close();
});

test("隔了很久再聊：提示词和历史里都标出间隔", async () => {
  let t = Date.now() - 3 * 86400000;
  let seen;
  const net = fakeNet({ llm: chatOnly((m) => ((seen = m), "〔想〕嗯\n〔心情〕平静\n嗯")) });
  const s = await start({ config: KEY, net, now: () => t });
  await s.api("POST", "/api/chat", { text: "晚安" });
  t += 3 * 86400000;
  await s.api("POST", "/api/chat", { text: "早" });
  assert.match(seen[seen.length - 2].content, /已经过了 3 天/);
  assert.match(seen[seen.length - 1].content, /隔了 3 天）早$/);
  await s.close();
});

test("模型只写了内心活动没写消息：自动重试一次", async () => {
  let n = 0;
  const net = fakeNet({ llm: chatOnly(() => (++n === 1 ? "〔想〕不知道说啥\n〔心情〕平静" : "〔想〕嗯\n〔心情〕平静\n我在呢")) });
  const s = await start({ config: KEY, net });
  const r = await s.api("POST", "/api/chat", { text: "在吗" });
  assert.deepEqual(r.json.bubbles, ["我在呢"]);
  assert.equal(n, 2);
  await s.close();
});

test("大模型报错：回退到离线回复，不会没人理", async () => {
  const net = fakeNet({ llm: () => ({ __status: 500 }) });
  const s = await start({ config: KEY, net });
  const r = await s.api("POST", "/api/chat", { text: "哈哈哈" });
  assert.equal(r.status, 200);
  assert.equal(r.json.engine, "offline");
  assert.ok(r.json.bubbles.length);
  await s.close();
});

test("同一会话并发请求按顺序回复，聊天记录不乱", async () => {
  let i = 0;
  const net = fakeNet({ llm: chatOnly(async () => (await new Promise((r) => setTimeout(r, 20)), `〔想〕x\n〔心情〕平静\n回复${++i}`)) });
  const s = await start({ config: KEY, net });
  await Promise.all([s.api("POST", "/api/chat", { text: "一" }), s.api("POST", "/api/chat", { text: "二" })]);
  const h = await s.api("GET", "/api/history");
  assert.deepEqual(h.json.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  await s.close();
});
