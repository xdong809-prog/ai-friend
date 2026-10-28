"use strict";
/* v4.3：根据真实聊天记录做的修复 + 按记忆主动关心 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { start, fakeNet } = require("./_helpers");
const { parseVisionOutput } = require("../lib/vision");
const { checkFollowUp } = require("../server");

const BOT = 10001;
const OWNER = 123456;
const BASE = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 40, selfId: BOT } };
const isVision = (m) => Array.isArray(m[0].content);
const isMemory = (m) => m[0].content.includes("记忆整理");
const priv = (id, message) => ({ post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: id, message });
function gif(seed) {
  return Buffer.concat([Buffer.from("GIF89a"), crypto.createHash("sha256").update(String(seed)).digest(), Buffer.alloc(64, 1)]);
}
async function settle(s) {
  await new Promise((r) => setTimeout(r, 120));
  await s.onebot.idle();
}

test("看图结果被截断 / JSON 里混了引号：也能抠出描述，不会把半截 JSON 当描述", () => {
  assert.equal(parseVisionOutput('{"desc":"掷骰子押“大”净赚100，骰子5+2+6=').desc, "掷骰子押“大”净赚100，骰子5+2+6=");
  const j = parseVisionOutput('{"desc":"他说"你好"然后走了","mood":"开心","sticker":true}');
  assert.equal(j.desc, "他说你好然后走了");
  assert.equal(j.mood, "开心");
  assert.equal(j.sticker, true);
  assert.equal(parseVisionOutput("一只橘猫趴在键盘上").desc, "一只橘猫趴在键盘上");
});

test("旧版存坏的看图缓存，启动时自动修正", async () => {
  const s0 = await start({ config: BASE });
  const dataDir = path.join(s0.root, "data");
  await s0.close();
  fs.writeFileSync(path.join(dataDir, "vision-cache.json"), JSON.stringify({ aaa: { desc: '{"desc":"小狗转圈', mood: "平静", sticker: false, at: 1 }, bbb: { desc: "{}", at: 1 } }));
  const { createVision } = require("../lib/vision");
  const v = createVision({ config: s0.config, llm: s0.llm, dataDir, log: s0.log });
  assert.equal(v.cached("aaa").desc, "小狗转圈");
  assert.equal(v.cached("bbb"), null);
});

test("图片链接下载失败：改用 NapCat 缓存在本机的文件来看图", async () => {
  const chats = [];
  const s0 = await start({ config: BASE });
  const local = path.join(s0.root, "cached.gif");
  fs.writeFileSync(local, gif("local"));
  await s0.close();
  const net = fakeNet({
    llm: (m) => (isVision(m) ? '{"desc":"小猫比心","mood":"喜欢","sticker":true}' : isMemory(m) ? "{}" : (chats.push(m), "〔想〕嘿\n〔心情〕开心\n收到你的心了")),
    onebot: (action, p) => (action === "get_image" ? { file: local } : {}),
  });
  const s = await start({ config: BASE, net });
  await s.api("POST", "/onebot", priv(1, [{ type: "image", data: { url: "https://expired.test/x", file: "abc.gif", sub_type: 1 } }]));
  await settle(s);
  assert.ok(net.calls.onebot.some((c) => c.action === "get_image" && c.params.file === "abc.gif"));
  assert.equal(chats[0][chats[0].length - 1].content, "[表情包：小猫比心]");
  await s.close();
});

test("备用模型和正在用的是同一个时，出错会自动换另一个能用的模型", async () => {
  const net = fakeNet({
    llm: (m, body) => (body.model === "bad-model" ? { __status: 500 } : isMemory(m) ? "{}" : "〔想〕嗯\n〔心情〕平静\n我在"),
  });
  const s = await start({
    config: {
      providers: [
        { id: "a", name: "A", preset: "custom", baseUrl: "https://a.test/v1", apiKey: "sk-aaaaaaaaaa", model: "bad-model" },
        { id: "b", name: "B", preset: "custom", baseUrl: "https://b.test/v1", apiKey: "sk-bbbbbbbbbb", model: "good-model" },
      ],
      llm: { active: "a", fallback: "a" },
    },
    net,
  });
  const r = await s.api("POST", "/api/chat", { text: "在吗" });
  assert.equal(r.json.engine, "llm");
  assert.deepEqual(r.json.bubbles, ["我在"]);
  await s.close();
});

test("自己在干嘛已经说过了：下一轮提示它别再绕回去说", async () => {
  const seen = [];
  const net = fakeNet({ llm: (m) => (isMemory(m) ? "{}" : (seen.push(m), "〔想〕嗯\n〔心情〕平静\n" + (seen.length === 1 ? "我在" + require("../lib/persona").lifeNow(Date.now(), require("../lib/persona").hashStr("小满")) : "好"))) });
  const s = await start({ config: { ...BASE, friend: { name: "小满" } }, net });
  await s.api("POST", "/api/chat", { text: "你在干嘛" });
  assert.doesNotMatch(seen[0][seen[0].length - 2].content, /刚才已经说过了/);
  await s.api("POST", "/api/chat", { text: "哦" });
  assert.match(seen[1][seen[1].length - 2].content, /刚才已经说过了，这轮别再提/);
  await s.close();
});

/** 造一个 QQ 在线、带着安排的环境 */
async function careEnv(eventDate, nowRef) {
  const sent = [];
  const prompts = [];
  const net = fakeNet({
    llm: (m) => (isMemory(m) ? "{}" : (prompts.push(m), "〔想〕想问问他\n〔心情〕担心\n面试咋样了")),
    onebot: (action, p) => {
      if (action === "send_private_msg") sent.push(p);
      return {};
    },
  });
  const s = await start({ config: BASE, net, now: () => nowRef.t });
  s.memory.applyOps("main", { events: [{ date: eventDate, text: "去字节面试" }] });
  return { s, sent, prompts, ctx: { ...s, watchdog: { status: () => ({ online: true }) } } };
}

function at(dateStr, h) {
  const d = new Date(dateStr + "T00:00:00");
  d.setHours(h, 7, 0, 0);
  return d.getTime();
}

test("按记忆主动关心：面试前一晚打气，当天晚上问结果，每种只发一次", async () => {
  const nowRef = { t: at("2026-11-02", 20) };
  const { s, sent, prompts, ctx } = await careEnv("2026-11-03", nowRef);
  // 前一天 20 点后：打气
  assert.ok(await checkFollowUp(ctx, nowRef.t, () => 0));
  assert.equal(sent.length, 1);
  assert.match(prompts[0][prompts[0].length - 2].content, /明天.*去字节面试.*打打气/s);
  // 3 小时内不会再发
  assert.equal(checkFollowUp(ctx, nowRef.t + 30 * 60 * 1000, () => 0), null);
  // 当天下午还没到时间：不发
  nowRef.t = at("2026-11-03", 15);
  assert.equal(checkFollowUp(ctx, nowRef.t, () => 0), null);
  // 当天 19 点后：问结果
  nowRef.t = at("2026-11-03", 19);
  assert.ok(await checkFollowUp(ctx, nowRef.t, () => 0));
  assert.equal(sent.length, 2);
  assert.match(prompts[1][prompts[1].length - 2].content, /今天有安排：「去字节面试」.*问问怎么样了/s);
  // 问过了就不再问；聊天时提示它别追问
  nowRef.t = at("2026-11-04", 11);
  assert.equal(checkFollowUp(ctx, nowRef.t, () => 0), null);
  assert.match(s.memory.memoryBlock("main", "宝宝"), /你已经主动问过结果了/);
  await s.close();
});

test("按记忆主动关心：正聊着、深夜、或者关掉了，都不打扰", async () => {
  const nowRef = { t: at("2026-11-03", 20) };
  const { s, sent, ctx } = await careEnv("2026-11-03", nowRef);
  await s.api("POST", "/api/chat", { text: "刚到家" });
  assert.equal(checkFollowUp(ctx, nowRef.t + 10 * 60 * 1000, () => 0), null, "90 分钟内聊过");
  assert.equal(checkFollowUp(ctx, at("2026-11-03", 23), () => 0), null, "太晚了");
  s.config.proactive.followUp = false;
  assert.equal(checkFollowUp(ctx, nowRef.t + 3 * 3600 * 1000, () => 0), null, "关掉了");
  assert.equal(sent.length, 0);
  await s.close();
});
