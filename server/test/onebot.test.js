"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { start, fakeNet } = require("./_helpers");
const { parseCQ } = require("../lib/onebot");

const BOT = 10001;
const OWNER = 123456;
const base = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 60, selfId: BOT } };

function priv(id, message, user = OWNER) {
  return { post_type: "message", message_type: "private", self_id: BOT, user_id: user, message_id: id, message };
}
function group(id, user, name, message) {
  return { post_type: "message", message_type: "group", group_id: 55555, self_id: BOT, user_id: user, message_id: id, sender: { card: name }, message };
}
const txt = (t) => ({ type: "text", data: { text: t } });

async function settle(s) {
  await new Promise((r) => setTimeout(r, 150));
  await s.onebot.idle();
}

function setup(extra = {}, llmText = "〔想〕嗯\n〔心情〕开心\n哈哈好啊[QQ脸:呲牙]\n走起") {
  const chats = [];
  const net = fakeNet({
    llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : (chats.push(m), llmText)),
    onebot: (action) => (action === "get_msg" ? { message: [txt("明晚吃火锅？")], sender: { user_id: BOT } } : { message_id: 1 }),
  });
  return { chats, net, cfg: { ...base, ...extra, qq: { ...base.qq, ...(extra.qq || {}) } } };
}

const sends = (net, action) => net.calls.onebot.filter((c) => c.action === action).map((c) => c.params);

test("主人私聊：立即 204，回复分条发出，[QQ脸] 变成 face 段", async () => {
  const { net, cfg } = setup();
  const s = await start({ config: cfg, net });
  const r = await s.api("POST", "/onebot", priv(1, [txt("周末出去玩吗")]));
  assert.equal(r.status, 204);
  await settle(s);
  const out = sends(net, "send_private_msg");
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { user_id: OWNER, message: [txt("哈哈好啊"), { type: "face", data: { id: "13" } }] });
  assert.deepEqual(out[1].message, [txt("走起")]);
  await s.close();
});

test("连发合并：短时间内的几条只回一次", async () => {
  // 合并窗口给宽一点：Windows 上本机 HTTP 请求有时一次就要几十毫秒
  const { net, cfg, chats } = setup({ qq: { mergeWindowMs: 500 } });
  const s = await start({ config: cfg, net });
  await s.api("POST", "/onebot", priv(1, [txt("我跟你说")]));
  await s.api("POST", "/onebot", priv(2, [txt("我今天"), { type: "face", data: { id: "14" } }]));
  await s.api("POST", "/onebot", priv(3, [txt("升职了！")]));
  await new Promise((r) => setTimeout(r, 700));
  await settle(s);
  assert.equal(chats.length, 1);
  assert.equal(chats[0][chats[0].length - 1].content, "我跟你说\n我今天[微笑(QQ里常是无语/阴阳怪气)]\n升职了！");
  await s.close();
});

test("引用回复：被引用的原文交给模型理解", async () => {
  const { net, cfg, chats } = setup();
  const s = await start({ config: cfg, net });
  await s.api("POST", "/onebot", priv(1, [{ type: "reply", data: { id: "77" } }, txt("行啊")]));
  await settle(s);
  assert.match(chats[0][chats[0].length - 2].content, /引用（回复）了这条消息：「明晚吃火锅？」/);
  await s.close();
});

test("只理主人：陌生人私聊不回；重复的 message_id 只处理一次", async () => {
  const { net, cfg, chats } = setup();
  const s = await start({ config: cfg, net });
  await s.api("POST", "/onebot", priv(1, [txt("你好")], 999));
  await s.api("POST", "/onebot", priv(2, [txt("在吗")]));
  await s.api("POST", "/onebot", priv(2, [txt("在吗")]));
  await settle(s);
  assert.equal(chats.length, 1);
  assert.equal(sends(net, "send_private_msg").every((p) => p.user_id === OWNER), true);
  await s.close();
});

test("群聊：不 @ 不回，但会记住上下文；@ 了才回，并引用对方那条", async () => {
  const { net, cfg, chats } = setup();
  const s = await start({ config: cfg, net });
  await s.api("POST", "/onebot", group(10, 222, "阿强", [txt("今晚谁打球")]));
  await settle(s);
  assert.equal(chats.length, 0);
  await s.api("POST", "/onebot", group(11, 333, "小美", [{ type: "at", data: { qq: String(BOT) } }, txt(" 你去不")]));
  await settle(s);
  assert.equal(chats.length, 1);
  assert.equal(chats[0][chats[0].length - 1].content, "阿强：今晚谁打球\n小美：你去不");
  assert.match(chats[0][chats[0].length - 2].content, /「小美」@了你/);
  const g = sends(net, "send_group_msg");
  assert.equal(g[0].group_id, 55555);
  assert.deepEqual(g[0].message[0], { type: "reply", data: { id: "11" } });
  assert.ok(g.length <= 2, "群里最多发两条");
  await s.close();
});

test("群白名单之外的群不回", async () => {
  const { net, cfg, chats } = setup({ qq: { groupAllowList: ["88888"] } });
  const s = await start({ config: cfg, net });
  await s.api("POST", "/onebot", group(11, 333, "小美", [{ type: "at", data: { qq: String(BOT) } }, txt("在吗")]));
  await settle(s);
  assert.equal(chats.length, 0);
  await s.close();
});

test("戳一戳：主人私聊戳它会回应", async () => {
  const { net, cfg, chats } = setup();
  const s = await start({ config: cfg, net });
  await s.api("POST", "/onebot", { post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: BOT, user_id: OWNER, target_id: BOT });
  await settle(s);
  assert.equal(chats.length, 1);
  assert.match(chats[0][chats[0].length - 1].content, /戳了戳你/);
  await s.close();
});

test("上报签名：required 模式下没签名或签错都拒绝，签对了放行", async () => {
  const { net, cfg } = setup({ qq: { token: "secret-token", inboundAuth: "required" } });
  const s = await start({ config: cfg, net });
  const body = JSON.stringify(priv(1, [txt("hi")]));
  assert.equal((await s.api("POST", "/onebot", body)).status, 401);
  assert.equal((await s.api("POST", "/onebot", body, { "X-Signature": "sha1=00" })).status, 401);
  const sig = "sha1=" + crypto.createHmac("sha1", "secret-token").update(body).digest("hex");
  assert.equal((await s.api("POST", "/onebot", body, { "X-Signature": sig })).status, 204);
  assert.equal((await s.api("POST", "/onebot", body, { Authorization: "Bearer secret-token" })).status, 204);
  await s.close();
});

test("发消息时带上 NapCat 的 token", async () => {
  const { net, cfg } = setup({ qq: { token: "secret-token" } });
  const s = await start({ config: cfg, net });
  await s.api("POST", "/onebot", priv(1, [txt("hi")]), { Authorization: "Bearer secret-token" });
  await settle(s);
  const call = net.calls.onebot.find((c) => c.action === "send_private_msg");
  assert.equal(call.headers.Authorization, "Bearer secret-token");
  await s.close();
});

test("兼容字符串格式的消息（CQ 码）", () => {
  assert.deepEqual(parseCQ("[CQ:face,id=14]你好[CQ:at,qq=10001]"), [
    { type: "face", data: { id: "14" } },
    { type: "text", data: { text: "你好" } },
    { type: "at", data: { qq: "10001" } },
  ]);
});

test("掉线提醒：启动时没连上不打扰；在线后掉线才提醒；恢复也提醒", async () => {
  const { createWatchdog } = require("../lib/watchdog");
  let online = false;
  let t = 0;
  const msgs = [];
  const wd = createWatchdog({
    config: {},
    onebot: { callApi: async () => ({ data: { online } }), fetchSelfId: async () => ({ user_id: 1, nickname: "小号" }) },
    notify: (m) => msgs.push(m),
    log: { info() {}, warn() {} },
    now: () => t,
  });
  await wd.check();
  assert.equal(msgs.length, 0, "刚启动没连上不提醒");
  online = true;
  await wd.check();
  assert.equal(msgs.length, 0, "第一次上线不用提醒");
  online = false;
  await wd.check();
  assert.match(msgs[0], /掉线/);
  online = true;
  await wd.check();
  assert.match(msgs[1], /重新在线/);
});

test("掉线提醒：启动 3 分钟还连不上，提醒一次", async () => {
  const { createWatchdog } = require("../lib/watchdog");
  let t = 0;
  const msgs = [];
  const wd = createWatchdog({ config: {}, onebot: { callApi: async () => { throw new Error("fetch failed"); } }, notify: (m) => msgs.push(m), log: { info() {}, warn() {} }, now: () => t });
  await wd.check();
  t = 4 * 60 * 1000;
  await wd.check();
  await wd.check();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /一直没连上/);
});
