"use strict";
/* 压缩聊天记录：用户自己点了才做；大底记忆保留，原文压成摘要，旧原文可归档、可恢复 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { start, fakeNet } = require("./_helpers");

const BOT = 10001;
const OWNER = 123456;
const BASE = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 40, selfId: BOT } };

/** 假模型：整理记忆 / 写摘要 / 精炼 / 聊天各回各的 */
function brainNet({ tidyFacts } = {}) {
  const calls = { extract: 0, summary: 0, tidy: 0 };
  const net = fakeNet({
    llm: (m) => {
      const sys = m[0].content;
      const user = (m[1] && m[1].content) || "";
      if (sys.includes("记忆整理助手")) {
        calls.extract++;
        return JSON.stringify({ set: { 名字: "小东" }, add: [`聊过第 ${calls.extract} 批的事`, "喜欢打篮球"] });
      }
      if (sys.includes("整理和")) {
        calls.summary++;
        return `第 ${calls.summary} 版摘要：我们聊了很多关于学校、篮球和考试的事，他最近在准备期末，压力有点大，我答应周末陪他复习。`.repeat(2);
      }
      if (sys.includes("更精炼")) {
        calls.tidy++;
        const facts = JSON.parse(user.match(/【记得的事】\n(\[.*\])/)[1]);
        return JSON.stringify({ summary: "精炼摘要：他在准备期末，我答应周末陪他复习，他叫我小鱼。".repeat(3), facts: tidyFacts ? tidyFacts(facts) : facts });
      }
      return "〔想〕嗯\n〔心情〕平静\n好呀";
    },
  });
  return { net, calls };
}

function fill(s, n, t0 = Date.now() - n * 60000) {
  for (let i = 0; i < n; i++) {
    s.memory.append("main", { role: i % 2 ? "assistant" : "user", text: `第${i + 1}条消息，聊聊学校和篮球的事情`, ts: t0 + i * 60000 });
  }
}

async function waitDone(s) {
  for (let i = 0; i < 200; i++) {
    const r = await s.api("GET", "/api/compress");
    if (!r.json.running) return r.json;
    await new Promise((x) => setTimeout(x, 20));
  }
  throw new Error("压缩一直没结束");
}

test("不点就不压缩：没有归档、原文都在", async () => {
  const { net } = brainNet();
  const s = await start({ config: BASE, net });
  fill(s, 30);
  const r = await s.api("GET", "/api/compress");
  assert.equal(r.json.running, false);
  assert.equal(r.json.stats.messages, 30);
  assert.equal(r.json.stats.archives, 0);
  assert.ok(!fs.existsSync(path.join(s.root, "data", "archive")));
  await s.close();
});

test("点了压缩：先整理记忆再压摘要，每轮发给模型的内容变少，旧原文归档，记忆档案有备份", async () => {
  const { net, calls } = brainNet();
  const s = await start({ config: BASE, net });
  s.memory.applyOps("main", { add: ["养了一只橘猫"] });
  fill(s, 120);
  const before = (await s.api("GET", "/api/compress")).json.stats;
  const r = await s.api("POST", "/api/compress", { keepRecent: 10 });
  assert.equal(r.status, 200);
  const done = await waitDone(s);
  assert.equal(done.error, "");
  assert.ok(calls.extract >= 3, "120 条分几批全部整理进长期记忆");
  assert.ok(calls.summary >= 2, "分批压进摘要");
  assert.equal(calls.tidy, 1);

  const p = s.memory.getProfile("main");
  assert.equal(p.summarizedUpTo, 110, "只留最近 10 条原文");
  assert.equal(p.extractedUpTo, 120);
  assert.equal(p.basics["名字"].value, "小东", "大底记忆还在");
  assert.ok(p.facts.some((f) => f.text === "喜欢打篮球"));
  assert.ok(p.facts.some((f) => f.text === "养了一只橘猫"), "压缩前就有的记忆也还在");
  assert.match(p.summary, /^精炼摘要/);

  const a = done.stats;
  assert.ok(a.contextChars < before.contextChars, `${before.contextChars} → ${a.contextChars}`);
  assert.equal(a.messages, 10);
  assert.ok(a.fileBytes < before.fileBytes);
  assert.equal(a.archives, 1);
  assert.match(done.resultText, /每轮发给模型的内容：\d+ → \d+ 字/);

  // 归档文件里正好是那 110 条
  const archDir = path.join(s.root, "data", "archive");
  const gz = fs.readdirSync(archDir)[0];
  const lines = zlib.gunzipSync(fs.readFileSync(path.join(archDir, gz))).toString("utf8").trim().split("\n");
  assert.equal(lines.length, 110);
  assert.equal(JSON.parse(lines[109]).seq, 110);
  // 档案备份
  assert.ok(fs.readdirSync(path.join(s.root, "data", "profiles")).some((n) => n.startsWith("main.json.bak-")));

  // 压缩后接着聊：编号接着往下，上下文从摘要 + 最近原文开始
  let seen;
  net.calls.llm.length = 0;
  const chat = await s.api("POST", "/api/chat", { text: "我回来了" });
  assert.equal(chat.json.engine, "llm");
  assert.equal(s.memory.lastSeq("main"), 122);
  seen = net.calls.llm.find((b) => b.messages[0].content.includes("你是「")).messages;
  assert.match(seen[seen.length - 2].content, /精炼摘要/);
  assert.ok(seen.length <= 14, "只带了最近的原文");
  await s.close();
});

test("恢复归档：旧原文按顺序放回聊天记录，摘要和记忆不变", async () => {
  const { net } = brainNet();
  const s = await start({ config: BASE, net });
  fill(s, 60);
  await s.api("POST", "/api/compress", { keepRecent: 10 });
  await waitDone(s);
  s.memory.append("main", { role: "user", text: "压缩之后又说了一句", ts: Date.now() });
  const summary = s.memory.getProfile("main").summary;
  const r = await s.api("POST", "/api/compress/restore");
  assert.equal(r.json.restored, 1);
  const h = await s.api("GET", "/api/history?limit=200");
  assert.equal(h.json.total, 61);
  const seqs = s.memory.history("main", 200).messages.map((m) => m.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, 61);
  assert.equal(s.memory.getProfile("main").summary, summary);
  assert.equal(r.json.stats.archives, 0);
  await s.close();
});

test("精炼时模型删掉太多记忆：不采用，原来的记忆原样保留", async () => {
  const { net } = brainNet({ tidyFacts: (facts) => facts.slice(0, 1) });
  const s = await start({ config: BASE, net });
  s.memory.applyOps("main", { add: ["养了一只橘猫", "不吃香菜", "在上大学", "喜欢周杰伦", "住在杭州", "怕黑", "会弹吉他"] });
  fill(s, 20);
  await s.api("POST", "/api/compress", { keepRecent: 10, archive: false });
  const done = await waitDone(s);
  const facts = s.memory.getProfile("main").facts.map((f) => f.text);
  for (const f of ["养了一只橘猫", "不吃香菜", "怕黑", "会弹吉他"]) assert.ok(facts.includes(f), f);
  assert.equal(done.stats.archives, 0, "没勾归档就不归档");
  assert.equal(done.stats.messages, 20);
  await s.close();
});

test("没有大模型时点压缩：直接提示，什么都不改", async () => {
  const s = await start({ config: { ...BASE, llm: { apiKey: "" }, providers: [] } });
  fill(s, 30);
  const r = await s.api("POST", "/api/compress", {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /还没有可用的大模型/);
  assert.equal((await s.api("GET", "/api/compress")).json.stats.messages, 30);
  await s.close();
});

test("QQ 里发「/压缩」：先回一句，做完再把结果发过来", async () => {
  const { net } = brainNet();
  const s = await start({ config: BASE, net });
  fill(s, 40);
  await s.api("POST", "/onebot", { post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: 9, message: [{ type: "text", data: { text: "/压缩" } }] });
  await waitDone(s);
  await new Promise((r) => setTimeout(r, 50));
  const texts = net.calls.onebot.filter((c) => c.action === "send_private_msg").map((c) => c.params.message[0].data.text);
  assert.match(texts[0], /开始压缩/);
  assert.match(texts[1], /^压缩好了\n/);
  assert.equal(s.memory.history("main", 100).messages.some((m) => m.text === "/压缩"), false, "指令不进聊天记录");
  await s.close();
});
