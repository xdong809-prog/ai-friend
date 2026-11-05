"use strict";
/* 教它说话：你纠正一次，它记成长期规矩；主好友和各角色各有一份 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { start, fakeNet } = require("./_helpers");

const BOT = 10001;
const OWNER = 123456;
const GROUP = 55555;
const BASE = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 40, selfId: BOT } };
const txt = (t) => ({ type: "text", data: { text: t } });
const priv = (id, text) => ({ post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: id, message: [txt(text)] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isTeach = (m) => m[0].content.includes("改说话方式");

function setup(say) {
  const chats = [];
  const net = fakeNet({
    llm: (m) => {
      if (m[0].content.includes("记忆整理")) return "{}";
      chats.push(m);
      if (isTeach(m)) return "规矩：别在句尾连着问问题";
      return typeof say === "function" ? say(chats.length) : say;
    },
    onebot: () => ({ message_id: 1 }),
  });
  return { chats, net };
}
const sends = (net, action = "send_private_msg") => net.calls.onebot.filter((c) => c.action === action).map((c) => c.params.message.map((x) => x.data.text).join(""));
async function settle(s) {
  await wait(120);
  await s.onebot.idle();
}

test("聊天里说「别老问我」：记成规矩、不发出去，下一轮起写进固定提示词", async () => {
  const { net, chats } = setup((n) => (n === 1 ? "〔想〕他烦我老问\n〔心情〕委屈\n行吧\n〔规矩〕少用问句结尾，别追着问" : "〔想〕嗯\n〔心情〕平静\n好"));
  const s = await start({ config: BASE, net });
  await s.api("POST", "/onebot", priv(1, "你别老问我"));
  await settle(s);
  assert.deepEqual(sends(net), ["行吧"]);
  assert.deepEqual(s.memory.getProfile("main").rules.map((r) => r.text), ["少用问句结尾，别追着问"]);
  assert.doesNotMatch(chats[0][0].content, /对方教过你的说话规矩/);

  await s.api("POST", "/onebot", priv(2, "今天好累"));
  await settle(s);
  assert.match(chats[1][0].content, /【对方教过你的说话规矩】[\s\S]*少用问句结尾/);
  await s.close();
});

test("群聊里写的规矩不算，也不把规矩带进群聊", async () => {
  const { net, chats } = setup("〔想〕嗯\n〔心情〕平静\n哈哈\n〔规矩〕群里别发言");
  const s = await start({ config: BASE, net });
  s.memory.applyOps("main", { addRules: ["叫他老王"] });
  await s.api("POST", "/onebot", { post_type: "message", message_type: "group", group_id: GROUP, self_id: BOT, user_id: 222, message_id: 1, sender: { card: "阿强" }, message: [{ type: "at", data: { qq: String(BOT) } }, txt(" 你好")] });
  await settle(s);
  assert.equal(chats.length, 1);
  assert.doesNotMatch(chats[0][0].content, /叫他老王/);
  assert.deepEqual(s.memory.getProfile("main").rules.map((r) => r.text), ["叫他老王"]);
  assert.deepEqual(s.memory.getProfile(`qqg_${GROUP}`).rules, []);
  await s.close();
});

test("网页点「不像你」：模型写成规矩；可以不写原因；没有模型时用你写的原因", async () => {
  const { net, chats } = setup("〔想〕嗯\n〔心情〕平静\n好");
  const s = await start({ config: BASE, net });
  const r = await s.api("POST", "/api/rules/feedback", { text: "那你今天吃了吗？", note: "老是问问题" });
  assert.equal(r.json.rule, "别在句尾连着问问题");
  assert.match(chats[0][1].content, /那你今天吃了吗/);
  assert.match(chats[0][1].content, /老是问问题/);
  assert.equal(s.memory.getProfile("main").rules.length, 1);
  await s.close();

  const none = setup("x");
  const noModel = await start({ config: { ...BASE, llm: {} }, net: none.net });
  assert.equal((await noModel.api("POST", "/api/rules/feedback", { text: "好的" })).status, 400);
  const withNote = await noModel.api("POST", "/api/rules/feedback", { text: "好的", note: "别这么客气" });
  assert.equal(withNote.json.rule, "别这么客气");
  await noModel.close();
});

test("手动增删、说法相近的算同一条、最多留 20 条", async () => {
  const { net } = setup("x");
  const s = await start({ config: BASE, net });
  await s.api("POST", "/api/memory", { op: "addRule", text: "少用问句结尾" });
  await s.api("POST", "/api/memory", { op: "addRule", text: "少用问句结尾吧" });
  assert.deepEqual(s.memory.getProfile("main").rules.map((r) => r.text), ["少用问句结尾吧"]);
  const gone = await s.api("POST", "/api/memory", { op: "removeRule", text: "少用问句结尾吧" });
  assert.deepEqual(gone.json.profile.rules, []);
  // 25 条互相不相近的
  const many = Array.from({ length: 25 }, (_, i) => `规矩编号${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地人"[i]}${"东南西北春夏秋冬风雨雷电山水林火土金木日月星辰云"[i]}`);
  s.memory.applyOps("main", { addRules: many });
  const left = s.memory.getProfile("main").rules;
  assert.equal(left.length, 20);
  assert.equal(left[left.length - 1].text, many[24]); // 留下的是最新的
  await s.close();
});

test("QQ 指令：/规矩 查看、添加、按编号删除", async () => {
  const { net, chats } = setup("x");
  const s = await start({ config: BASE, net });
  await s.api("POST", "/onebot", priv(1, "/规矩"));
  await s.api("POST", "/onebot", priv(2, "/规矩 少用问句结尾"));
  await s.api("POST", "/onebot", priv(3, "/规矩"));
  await s.api("POST", "/onebot", priv(4, "/规矩 删 5"));
  await s.api("POST", "/onebot", priv(5, "/规矩 删 1"));
  await wait(120);
  const out = sends(net);
  assert.match(out[0], /还没有规矩/);
  assert.equal(out[1], "记下了：少用问句结尾");
  assert.match(out[2], /1\. 少用问句结尾/);
  assert.equal(out[3], "没有第 5 条");
  assert.equal(out[4], "删掉了：少用问句结尾");
  assert.deepEqual(s.memory.getProfile("main").rules, []);
  assert.equal(chats.length, 0); // 指令不经过模型
  await s.close();
});

test("角色有自己的规矩：只影响这个角色，不影响主好友", async () => {
  const { net, chats } = setup("〔想〕嗯\n〔心情〕平静\n好");
  const s = await start({ config: BASE, net });
  // 角色本来是导入出来的，这里直接写索引，省去导入流程
  const dir = path.join(s.root, "data", "personas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ list: [{ id: "c1", name: "阿杰", persona: "爱损人", source: { them: "阿杰" } }] }));

  await s.api("POST", "/api/rules/feedback", { text: "好的呀", note: "太客气", persona: "c1" });
  assert.equal(s.memory.getProfile("p_c1").rules.length, 1);
  assert.equal(s.memory.getProfile("main").rules.length, 0);
  assert.equal(s.personas.list()[0].rules.length, 1);

  await s.api("POST", "/api/chat", { texts: ["在吗"], persona: "c1" });
  assert.match(chats[chats.length - 1][0].content, /对方教过你的说话规矩/);
  await s.api("POST", "/api/chat", { texts: ["在吗"] });
  assert.doesNotMatch(chats[chats.length - 1][0].content, /对方教过你的说话规矩/);

  const r = await s.api("POST", "/api/memory", { op: "removeRule", text: s.memory.getProfile("p_c1").rules[0].text, persona: "c1" });
  assert.deepEqual(r.json.profile.rules, []);
  await s.close();
});
