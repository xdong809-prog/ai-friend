"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMemory, similar } = require("../lib/memory");
const { normalizeConfig } = require("../lib/config");

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function mk(over = {}, now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aifm-"));
  const config = normalizeConfig({ chat: { historyMessages: 10, summaryTrigger: 12, keepRecent: 4, extractEvery: 2, ...over } });
  return { mem: createMemory({ dataDir: dir, config, log: silent, now }), dir, config };
}

function fakeLLM(reply) {
  const calls = [];
  return { calls, enabled: () => true, chat: async (m, o) => (calls.push({ m, o }), typeof reply === "function" ? reply(m, o) : reply) };
}

test("聊天记录追加、带递增序号，重启后能读回", () => {
  const { mem, dir, config } = mk();
  mem.append("main", { role: "user", text: "你好" });
  mem.append("main", { role: "assistant", text: "嗨" });
  const again = createMemory({ dataDir: dir, config, log: silent });
  const h = again.history("main");
  assert.equal(h.total, 2);
  assert.deepEqual(h.messages.map((m) => m.seq), [1, 2]);
  assert.equal(again.lastSeq("main"), 2);
});

test("单值信息被新说法覆盖，多值事实累加去重", () => {
  const { mem } = mk();
  mem.applyOps("main", { set: { 城市: "北京" }, add: ["养了一只猫"] });
  mem.applyOps("main", { set: { 城市: "杭州" }, add: ["养了一只猫", "喜欢吃火锅"] });
  const p = mem.getProfile("main");
  assert.equal(p.basics["城市"].value, "杭州");
  assert.deepEqual(p.facts.map((f) => f.text), ["养了一只猫", "喜欢吃火锅"]);
});

test("remove 删掉矛盾的旧事实", () => {
  const { mem } = mk();
  mem.applyOps("main", { add: ["住在北京朝阳区", "喜欢跑步"] });
  mem.applyOps("main", { remove: ["住在北京朝阳区"] });
  assert.deepEqual(mem.getProfile("main").facts.map((f) => f.text), ["喜欢跑步"]);
});

test("「记住 / 忘掉」指令立即生效", () => {
  const { mem } = mk();
  assert.match(mem.handleCommand("main", "记住：我不吃香菜"), /记下/);
  assert.equal(mem.getProfile("main").facts[0].text, "我不吃香菜");
  assert.match(mem.handleCommand("main", "忘掉香菜"), /删掉/);
  assert.equal(mem.getProfile("main").facts.length, 0);
  assert.equal(mem.handleCommand("main", "今天天气不错"), "");
});

test("安排：近期的进提示词，过了几天没聊结果的提醒去问", () => {
  const today = new Date(2026, 9, 26, 20).getTime();
  const { mem } = mk({}, () => today);
  mem.applyOps("main", { events: [{ date: "2026-10-30", text: "去面试" }, { date: "2026-10-24", text: "考驾照科目二" }] });
  const block = mem.memoryBlock("main", "小林");
  assert.match(block, /10月30日（还有 4 天）：去面试/);
  assert.match(block, /10月24日（2 天前，已经过了）：考驾照科目二 —— 还不知道结果/);
  mem.applyOps("main", { done_events: ["考驾照科目二"] });
  assert.doesNotMatch(mem.memoryBlock("main", "小林"), /科目二/);
});

test("滚动摘要：近期原文和摘要首尾相接，没有遗漏", async () => {
  const { mem } = mk();
  for (let i = 1; i <= 16; i++) mem.append("main", { role: i % 2 ? "user" : "assistant", text: "第" + i + "条" });
  const llm = fakeLLM("摘要：聊了 1 到 12 条");
  assert.equal(await mem.maybeSummarize("main", llm), true);
  const r = mem.recent("main");
  const p = mem.getProfile("main");
  assert.equal(p.summarizedUpTo, 12);
  assert.equal(r.summary, "摘要：聊了 1 到 12 条");
  assert.equal(r.messages[0].seq, p.summarizedUpTo + 1, "近期原文正好接在摘要后面");
  assert.equal(r.messages.length, 4);
});

test("记忆整理：大模型返回的 JSON 被应用，并记录整理到哪一条", async () => {
  const { mem } = mk();
  mem.append("main", { role: "user", text: "我搬到杭州了" });
  mem.append("main", { role: "user", text: "周五去面试" });
  const llm = fakeLLM('```json\n{"set":{"城市":"杭州"},"events":[{"date":"2026-10-30","text":"去面试"}]}\n```');
  assert.equal(await mem.maybeExtract("main", llm), true);
  const p = mem.getProfile("main");
  assert.equal(p.basics["城市"].value, "杭州");
  assert.equal(p.events[0].text, "去面试");
  assert.equal(p.extractedUpTo, 2);
  assert.equal(llm.calls[0].o.json, true);
  // 没有新消息就不再调用
  assert.equal(await mem.maybeExtract("main", llm), false);
  assert.equal(llm.calls.length, 1);
});

test("相关旧聊天：按关键词找回更早的对话", () => {
  const { mem } = mk();
  mem.append("main", { role: "user", text: "我家猫团子最近不爱吃饭" });
  mem.append("main", { role: "assistant", text: "带去看看医生吧" });
  for (let i = 0; i < 6; i++) mem.append("main", { role: "user", text: "随便聊聊天气" + i });
  const r = mem.relevant("main", "团子今天又不吃饭了", 8, 3);
  assert.equal(r.length, 1);
  assert.match(r[0].user, /团子/);
  assert.match(r[0].reply, /医生/);
});

test("清空聊天记录是改名备份，不是删除", () => {
  const { mem, dir } = mk();
  mem.append("main", { role: "user", text: "你好" });
  mem.clearHistory("main");
  assert.equal(mem.history("main").total, 0);
  assert.ok(fs.readdirSync(path.join(dir, "sessions")).some((n) => n.startsWith("main.jsonl.bak-")));
});

test("相似度判断", () => {
  assert.ok(similar("养了一只猫", "养了一只橘猫"));
  assert.ok(!similar("喜欢火锅", "讨厌跑步"));
});
