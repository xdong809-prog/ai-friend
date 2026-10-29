"use strict";
/* 群聊总结：默认不记录；勾选的群记下来；定时 / 网页 / QQ 指令总结后私聊发给主人 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { start, fakeNet } = require("./_helpers");
const { checkGroupDigest } = require("../server");
const { normalizeConfig } = require("../lib/config");

const BOT = 10001;
const OWNER = 123456;
const GID = 55555;
const OTHER = 66666;
const BASE = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 40, selfId: BOT } };
const ON = { groupDigest: { enabled: true, groups: [String(GID)] } };
const txt = (t) => ({ type: "text", data: { text: t } });
const group = (id, gid, user, name, message) => ({ post_type: "message", message_type: "group", group_id: gid, self_id: BOT, user_id: user, message_id: id, sender: { card: name }, message });
const priv = (id, text) => ({ post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: id, message: [txt(text)] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isVoice = (m) => m[0].content.includes("托你帮忙盯着");
const isNotes = (m) => m[0].content.includes("整理 QQ 群聊记录");
const SUMMARY = "**篮球群**这边今天在约周六下午打球\n- 阿强还@你问你去不去，记得回他";

function setup(extra = {}) {
  const calls = [];
  const net = fakeNet({
    llm: (m) => {
      if (m[0].content.includes("记忆整理")) return "{}";
      calls.push(m);
      if (isNotes(m)) return "在约周六打球";
      if (isVoice(m)) return SUMMARY;
      return "〔想〕嗯\n〔心情〕平静\n好呀";
    },
    onebot: (action) => {
      if (action === "get_group_list") return [{ group_id: GID, group_name: "篮球群", member_count: 30 }, { group_id: OTHER, group_name: "工作群", member_count: 80 }];
      if (action === "get_msg") return { message: [txt("原消息")], sender: { user_id: 1 } };
      return { message_id: 1 };
    },
  });
  const config = { ...BASE, ...extra, qq: { ...BASE.qq, ...(extra.qq || {}) } };
  return { calls, net, config };
}
const sends = (net, action) => net.calls.onebot.filter((c) => c.action === action).map((c) => c.params);
const fileOf = (s, gid) => path.join(s.root, "data", "groups", gid + ".jsonl");
const lines = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
async function finished(s) {
  await wait(30);
  while (s.digest.status().running) await wait(20);
}

test("默认关闭：群消息一条都不记", async () => {
  const { net, config } = setup();
  const s = await start({ config, net });
  await s.api("POST", "/onebot", group(1, GID, 222, "阿强", [txt("今晚谁打球")]));
  await wait(50);
  assert.equal(fs.existsSync(path.join(s.root, "data", "groups")), false);
  await s.close();
});

test("开启后只记勾选的群；不在群里说话也照样记，被引用的消息不去额外拉取", async () => {
  const { net, config } = setup({ ...ON, qq: { group: false } });
  const s = await start({ config, net });
  await s.api("POST", "/onebot", group(1, GID, 222, "阿强", [txt("今晚谁打球 "), { type: "at", data: { qq: String(OWNER) } }]));
  await s.api("POST", "/onebot", group(2, GID, 333, "小美", [{ type: "reply", data: { id: "9" } }, txt("我去"), { type: "image", data: { url: "http://x/a.png" } }]));
  await s.api("POST", "/onebot", group(3, OTHER, 444, "老板", [txt("明天开会")]));
  await wait(80);
  const got = lines(fileOf(s, String(GID)));
  assert.equal(got.length, 2);
  assert.equal(got[0].name, "阿强");
  assert.equal(got[0].atOwner, true);
  assert.equal(got[1].text, "我去[图片]");
  assert.equal(fs.existsSync(fileOf(s, String(OTHER))), false);
  assert.equal(sends(net, "send_group_msg").length, 0);
  assert.equal(sends(net, "get_msg").length, 0);
  await s.close();
});

test("网页点「现在总结」：用好友口吻写、发到主人 QQ、记进聊天记录；没新消息就不再花钱", async () => {
  const { net, config, calls } = setup(ON);
  const s = await start({ config, net });
  await s.api("POST", "/onebot", group(1, GID, 222, "阿强", [txt("周六下午打球？")]));
  await s.api("POST", "/onebot", group(2, GID, OWNER, "我", [txt("看情况")]));
  await wait(60);

  const list = await s.api("GET", "/api/groups");
  assert.deepEqual(list.json.groups.find((g) => g.id === String(GID)), { id: String(GID), name: "篮球群", members: 30, watching: true, pending: 2, lastSummaryAt: 0 });
  assert.equal(list.json.groups.find((g) => g.id === String(OTHER)).watching, false);

  const r = await s.api("POST", "/api/groups/digest", { send: true });
  assert.equal(r.json.ok, true);
  await finished(s);
  const voice = calls.filter(isVoice);
  assert.equal(voice.length, 1);
  assert.match(voice[0][1].content, /\d\d:\d\d 阿强：周六下午打球？/);
  assert.match(voice[0][1].content, /我（就是对方本人）：看情况/);
  assert.match(voice[0][0].content, /「篮球群」/);

  const expect = "篮球群这边今天在约周六下午打球\n阿强还@你问你去不去，记得回他";
  const pm = sends(net, "send_private_msg");
  assert.equal(pm.length, 1);
  assert.equal(pm[0].user_id, OWNER);
  assert.equal(pm[0].message.map((x) => x.data.text).join(""), expect);
  const h = s.memory.history("main", 5).messages;
  assert.equal(h[h.length - 1].role, "assistant");
  assert.equal(h[h.length - 1].text, expect);

  const g = await s.api("GET", "/api/groups/digest");
  assert.equal(g.json.recent.length, 1);
  assert.equal(g.json.recent[0].sent, true);
  assert.match(g.json.resultText, /总结了 1 个群：「篮球群」2 条/);

  await s.api("POST", "/api/groups/digest", { send: true });
  await finished(s);
  assert.equal(calls.filter(isVoice).length, 1);
  assert.match((await s.api("GET", "/api/groups/digest")).json.resultText, /「篮球群」没有新消息/);
  await s.close();
});

test("没开或没勾选时，网页和 QQ 指令都会提示先去打开", async () => {
  const { net, config } = setup();
  const s = await start({ config, net });
  const r = await s.api("POST", "/api/groups/digest", { send: true });
  assert.equal(r.status, 400);
  await s.api("POST", "/onebot", priv(1, "/群总结"));
  await wait(80);
  assert.match(sends(net, "send_private_msg")[0].message[0].data.text, /还没开启群聊总结/);
  await s.close();
});

test("定时：到点前不做；到点后每天只做一次；新消息太少这次跳过", async () => {
  const { net, config, calls } = setup({ groupDigest: { ...ON.groupDigest, minMessages: 3 } });
  const s = await start({ config, net });
  s.digest.record(String(GID), { uid: "222", name: "阿强", text: "在吗" });
  const at = (h, m, d = 28) => new Date(2026, 9, d, h, m).getTime();
  assert.equal(checkGroupDigest(s, at(20, 59)), null);
  const out = await checkGroupDigest(s, at(21, 5));
  assert.match(out.results[0].skipped, /只有 1 条/);
  assert.equal(calls.filter(isVoice).length, 0);
  assert.equal(checkGroupDigest(s, at(22, 0)), null);

  for (const t of ["打球", "几点", "三点"]) s.digest.record(String(GID), { uid: "222", name: "阿强", text: t });
  const next = await checkGroupDigest(s, at(21, 1, 29));
  assert.equal(next.results[0].count, 4);
  assert.equal(calls.filter(isVoice).length, 1);
  assert.equal(sends(net, "send_private_msg").length, 1);
  await s.close();
});

test("主人在 QQ 发「/群总结」：消息少也马上总结，总结直接发过来", async () => {
  const { net, config, calls } = setup({ groupDigest: { ...ON.groupDigest, minMessages: 50 } });
  const s = await start({ config, net });
  s.digest.record(String(GID), { uid: "222", name: "阿强", text: "周六打球" });
  await s.api("POST", "/onebot", priv(1, "/群总结"));
  await wait(80);
  await finished(s);
  await wait(30);
  const pm = sends(net, "send_private_msg").map((p) => p.message.map((x) => x.data.text).join(""));
  assert.deepEqual(pm, ["好，我去翻翻群里聊了啥", "篮球群这边今天在约周六下午打球\n阿强还@你问你去不去，记得回他"]);
  assert.equal(calls.filter(isVoice).length, 1);
  await s.close();
});

test("群聊太长：先分段整理笔记再写总结，只发一条", async () => {
  const { net, config, calls } = setup(ON);
  const s = await start({ config, net });
  for (let i = 0; i < 60; i++) s.digest.record(String(GID), { uid: "222", name: "阿强", text: `第${i}条 ` + "长".repeat(300) });
  const out = await s.digest.runAll({ force: true, send: true });
  assert.equal(out.results[0].count, 60);
  assert.equal(calls.filter(isNotes).length, 2);
  assert.equal(calls.filter(isVoice).length, 1);
  assert.match(calls.filter(isVoice)[0][1].content, /分段整理的笔记/);
  assert.equal(sends(net, "send_private_msg").length, 1);
  await s.close();
});

test("删除记录的群消息；关掉后不再记录", async () => {
  const { net, config } = setup(ON);
  const s = await start({ config, net });
  s.digest.record(String(GID), { uid: "222", name: "阿强", text: "在吗" });
  assert.equal((await s.api("POST", "/api/groups/clear")).json.removed, 1);
  assert.equal(fs.existsSync(fileOf(s, String(GID))), false);
  await s.api("POST", "/api/config", { groupDigest: { enabled: false } });
  await s.api("POST", "/onebot", group(1, GID, 222, "阿强", [txt("还在吗")]));
  await wait(60);
  assert.equal(fs.existsSync(fileOf(s, String(GID))), false);
  await s.close();
});

test("设置归一化：时间不对用默认值，群号只留数字", () => {
  const c = normalizeConfig({ groupDigest: { enabled: true, time: "25:00", groups: "12345, abc, 678901", minMessages: 0 } });
  assert.equal(c.groupDigest.time, "21:00");
  assert.deepEqual(c.groupDigest.groups, ["12345", "678901"]);
  assert.equal(c.groupDigest.minMessages, 1);
  assert.equal(normalizeConfig({ groupDigest: { time: "9:5" } }).groupDigest.time, "09:05");
  assert.equal(normalizeConfig({}).groupDigest.enabled, false);
});
