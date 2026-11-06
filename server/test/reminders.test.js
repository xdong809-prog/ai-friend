"use strict";
/* 提醒：它答应了就真的到点发；时间写错、被打断的草稿、QQ 掉线都有明确的处理 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { start, fakeNet } = require("./_helpers");
const { checkReminders } = require("../server");
const { parseSpec, parseLine, nextAt, whenText, createReminders } = require("../lib/reminders");
const { parseOutput } = require("../lib/humanize");

const BOT = 10001;
const OWNER = 123456;
const BASE = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 40, selfId: BOT } };
const txt = (t) => ({ type: "text", data: { text: t } });
const priv = (id, text) => ({ post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: id, message: [txt(text)] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const silentLog = { info() {}, warn() {}, debug() {}, error() {} };
const FAR = "2099-01-01 08:00";

/** say：模型要说的话，可以是函数（第几次调用 → 文本） */
function setup(say, extra = {}) {
  const chats = [];
  let onebotFail = false;
  const net = fakeNet({
    llm: async (m) => {
      if (m[0].content.includes("记忆整理")) return "{}";
      chats.push(m);
      return typeof say === "function" ? say(chats.length, m) : say;
    },
    onebot: (action) => {
      if (onebotFail && action === "send_private_msg") throw new Error("发送失败");
      if (action === "get_status") return { online: extra.online !== false };
      return { message_id: 1 };
    },
  });
  const config = { ...BASE, ...extra.config, qq: { ...BASE.qq, ...((extra.config && extra.config.qq) || {}) } };
  return { chats, net, config, failSends: (v) => (onebotFail = v) };
}
const sends = (net) => net.calls.onebot.filter((c) => c.action === "send_private_msg").map((c) => c.params.message.map((x) => x.data.text).join(""));

test("认识的时间写法：一次性、每天、工作日、周末、每周几、几分钟后；过去的和不存在的日期不算", () => {
  const t = at(2026, 11, 5, 10, 0); // 星期四
  assert.equal(parseSpec("2026-11-06 08:00", t).at, at(2026, 11, 6, 8, 0));
  assert.equal(parseSpec("2026/11/6 8:00", t).at, at(2026, 11, 6, 8, 0));
  assert.equal(parseSpec("2026-11-05 09:00", t), null);
  assert.equal(parseSpec("2026-02-30 08:00", t), null);
  assert.equal(parseSpec("2026-11-06 25:00", t), null);
  assert.equal(parseSpec("30分钟后", t).at, t + 30 * 60000);
  assert.equal(parseSpec("2小时后", t).at, t + 2 * 3600000);
  assert.deepEqual(parseSpec("每天 11:00", t).repeat, { days: [0, 1, 2, 3, 4, 5, 6], time: "11:00" });
  assert.equal(parseSpec("每天 11:00", t).at, at(2026, 11, 5, 11, 0));
  assert.equal(parseSpec("每天 09:00", t).at, at(2026, 11, 6, 9, 0));
  assert.equal(parseSpec("工作日 8:30", at(2026, 11, 6, 9, 0)).at, at(2026, 11, 9, 8, 30)); // 周五早上过了 → 下周一
  assert.equal(parseSpec("周末 10:00", t).at, at(2026, 11, 7, 10, 0));
  assert.deepEqual(parseSpec("每周一三 20:00", t).repeat.days, [1, 3]);
  assert.deepEqual(parseSpec("每周日 20:00", t).repeat.days, [0]);
  assert.equal(parseSpec("明天早上", t), null);
  assert.equal(parseSpec("每周 20:00", t), null);
  assert.deepEqual(parseLine("每天 11:00｜喝水"), { spec: "每天 11:00", text: "喝水" });
  assert.deepEqual(parseLine("2026-11-06 08:00 叫他起床"), { spec: "2026-11-06 08:00", text: "叫他起床" });
  assert.equal(parseLine("喝水"), null);
  assert.equal(whenText(parseSpec("工作日 8:30", t)), "工作日 08:30");
  assert.equal(whenText(parseSpec("每周一三 20:00", t)), "每周一三 20:00");
  assert.equal(nextAt({ days: [4], time: "10:00" }, t), at(2026, 11, 12, 10, 0)); // 正好到点：排到下周
});

test("〔提醒〕〔取消提醒〕〔规矩〕都不会发出去；普通消息里的「（提醒）」不受影响", () => {
  const r = parseOutput("〔想〕嗯\n〔心情〕开心\n好的明早叫你\n〔提醒〕2026-11-06 08:00｜叫他起床\n〔取消提醒〕喝水\n〔规矩〕少用问句\n（提醒）别忘了带伞");
  assert.deepEqual(r.lines, ["好的明早叫你", "（提醒）别忘了带伞"]);
  assert.deepEqual(r.marks, { reminders: ["2026-11-06 08:00｜叫他起床"], cancels: ["喝水"], rules: ["少用问句"], voice: "" });
  // 模型把标记写在同一行也能拆开
  const same = parseOutput("〔想〕嗯 〔心情〕开心\n好〔提醒〕每天 11:00｜喝水");
  assert.deepEqual(same.lines, ["好"]);
  assert.deepEqual(same.marks.reminders, ["每天 11:00｜喝水"]);
});

test("聊天里答应了就记下来：消息照常发、标记不外发；下一轮模型知道有哪些提醒；能取消", async () => {
  const { net, config, chats } = setup((n) => (n === 1 ? `〔想〕嗯\n〔心情〕开心\n好 到时候叫你\n〔提醒〕${FAR}｜叫他起床` : n === 2 ? "〔想〕嗯\n〔心情〕开心\n有的" : "〔想〕嗯\n〔心情〕开心\n行 不叫了\n〔取消提醒〕起床"));
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, "2099 年元旦早上 8 点叫我"));
  await wait(120);
  await s.onebot.idle();
  assert.deepEqual(sends(net), ["好 到时候叫你"]);
  assert.match(chats[0][0].content, /〔提醒〕时间｜要提醒的事/);
  assert.equal(s.reminders.active().length, 1);
  assert.equal(s.reminders.active()[0].text, "叫他起床");

  await s.api("POST", "/onebot", priv(2, "我有哪些提醒"));
  await wait(120);
  await s.onebot.idle();
  assert.match(chats[1][chats[1].length - 2].content, /【你答应要提醒对方的事】[\s\S]*叫他起床/);

  await s.api("POST", "/onebot", priv(3, "不用叫我了"));
  await wait(120);
  await s.onebot.idle();
  assert.equal(s.reminders.active().length, 0);
  await s.close();
});

test("时间写错了不会假装记下：补一句实话，让对方再说一次", async () => {
  const { net, config } = setup("〔想〕嗯\n〔心情〕平静\n好的\n〔提醒〕明天早上｜叫他起床");
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, "明早叫我"));
  await wait(120);
  await s.onebot.idle();
  assert.equal(s.reminders.active().length, 0);
  const out = sends(net);
  assert.equal(out[0], "好的");
  assert.match(out[1], /提醒的时间我没记下来/);
  await s.close();
});

test("被新消息打断的草稿不算数：只留最后真正发出去那版的提醒", async () => {
  const { net, config } = setup(async (n) => {
    if (n === 1) {
      await wait(300);
      return `〔想〕嗯\n〔心情〕平静\n好\n〔提醒〕${FAR}｜第一版`;
    }
    return `〔想〕嗯\n〔心情〕平静\n好的 两件事\n〔提醒〕${FAR}｜最终版`;
  });
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, "提醒我一件事"));
  await wait(150); // 模型正在想第一版
  await s.api("POST", "/onebot", priv(2, "算了换一件"));
  await wait(500);
  await s.onebot.idle();
  assert.deepEqual(s.reminders.active().map((r) => r.text), ["最终版"]);
  await s.close();
});

test("导入的角色和没开 QQ 时不能定提醒：提示词让它别答应，写了也不算", async () => {
  const off = setup(`〔想〕嗯\n〔心情〕平静\n好\n〔提醒〕${FAR}｜喝水`, { config: { qq: { enabled: false } } });
  const noQQ = await start({ config: off.config, net: off.net });
  await noQQ.api("POST", "/api/chat", { texts: ["叫我起床"] });
  assert.match(off.chats[0][0].content, /没有定时提醒的功能/);
  assert.equal(noQQ.reminders.active().length, 0);
  await noQQ.close();

  const { net, config, chats } = setup(`〔想〕嗯\n〔心情〕平静\n好\n〔提醒〕${FAR}｜喝水`);
  const s = await start({ config, net });
  const dir = path.join(s.root, "data", "personas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ list: [{ id: "c1", name: "阿杰", persona: "爱损人", source: { them: "阿杰" } }] }));
  await s.api("POST", "/api/chat", { texts: ["叫我起床"], persona: "c1" });
  assert.match(chats[0][0].content, /没有定时提醒的功能/);
  assert.equal(s.reminders.active().length, 0);
  await s.close();
});

test("到点发送：按好友口吻发、只发一次；一次性的结束，重复的排到下次", async () => {
  const { net, config, chats } = setup("〔想〕到点了\n〔心情〕开心\n该喝水啦");
  const s = await start({ config, net });
  const once = s.reminders.add({ spec: FAR, text: "喝水" });
  const t = once.at;
  assert.equal(await checkReminders(s, t - 1000), 0);
  assert.equal(sends(net).length, 0);

  assert.equal(await checkReminders(s, t + 1000), 1);
  assert.deepEqual(sends(net), ["该喝水啦"]);
  assert.match(chats[0][chats[0].length - 2].content, /你之前答应要提醒对方：「喝水」/);
  assert.equal(s.reminders.active().length, 0);
  assert.equal(s.reminders.all()[0].status, "done");
  assert.equal(await checkReminders(s, t + 2000), 0);

  const daily = s.reminders.add({ spec: "每天 08:00", text: "吃药" });
  assert.equal(await checkReminders(s, daily.at + 1000), 1);
  const after = s.reminders.active()[0];
  assert.equal(after.at, daily.at + 86400000);
  assert.equal(await checkReminders(s, daily.at + 2000), 0);
  await s.close();
});

test("模型出问题也要发出去：退回纯文字，并记进聊天记录", async () => {
  const { net, config } = setup(() => ({ __status: 401 }));
  const s = await start({ config, net });
  const r = s.reminders.add({ spec: FAR, text: "喝水" });
  assert.equal(await checkReminders(s, r.at + 1000), 1);
  assert.deepEqual(sends(net), ["到点啦：喝水"]);
  const h = s.memory.history("main", 1).messages[0];
  assert.equal(h.role, "assistant");
  assert.equal(h.text, "到点啦：喝水");
  await s.close();
});

test("发送失败：留着等一会儿重试，不反复花钱调模型", async () => {
  const { net, config, chats, failSends } = setup("〔想〕到点了\n〔心情〕开心\n该喝水啦");
  const s = await start({ config, net });
  const r = s.reminders.add({ spec: FAR, text: "喝水" });
  const t = r.at + 1000;
  failSends(true);
  assert.equal(await checkReminders(s, t), 0);
  assert.equal(s.reminders.active().length, 1);
  assert.equal(chats.length, 1);
  assert.equal(await checkReminders(s, t + 1000), 0); // 还没到重试时间，什么都不做
  assert.equal(chats.length, 1);

  failSends(false);
  assert.equal(await checkReminders(s, t + 61000), 1);
  assert.equal(chats.length, 1); // 重试直接发文字
  assert.equal(sends(net).pop(), "到点啦：喝水");
  assert.equal(s.reminders.active().length, 0);
  await s.close();
});

test("QQ 掉线时先留着，回来了补发并说明晚了；太久的一次性算错过，重复的排到下次", async () => {
  const { net, config, chats } = setup("〔想〕到点了\n〔心情〕开心\n该喝水啦", { online: false });
  const s = await start({ config, net });
  await s.watchdog.check();
  assert.equal(s.watchdog.status().online, false);
  const r = s.reminders.add({ spec: FAR, text: "喝水" });
  assert.equal(await checkReminders(s, r.at + 3600000), 0);
  assert.equal(s.reminders.active().length, 1);
  await s.close();

  const s2 = setup("〔想〕到点了\n〔心情〕开心\n该喝水啦，晚了一小时");
  const b = await start({ config: s2.config, net: s2.net });
  const late = b.reminders.add({ spec: FAR, text: "喝水" });
  assert.equal(await checkReminders(b, late.at + 3600000), 1);
  assert.match(s2.chats[0][s2.chats[0].length - 2].content, /晚了 1 小时/);

  const old = b.reminders.add({ spec: "2099-02-01 08:00", text: "开会" });
  assert.equal(await checkReminders(b, old.at + 13 * 3600000), 0);
  assert.equal(b.reminders.all().find((x) => x.id === old.id).status, "missed");

  const daily = b.reminders.add({ spec: "每天 08:00", text: "吃药" });
  const missedDays = daily.at + 3 * 86400000 + 13 * 3600000; // 三天后的 21:00：今天早上那次也过了 12 小时以上
  const before = sends(s2.net).length;
  assert.equal(await checkReminders(b, missedDays), 0);
  assert.equal(sends(s2.net).length, before);
  assert.ok(b.reminders.active().find((x) => x.id === daily.id).at > missedDays);
  assert.equal(chats.length, 0);
  await b.close();
});

test("网页接口：添加、列出、删除；时间不对给出提示。QQ 发 /提醒 能查看", async () => {
  const { net, config } = setup("〔想〕嗯\n〔心情〕平静\n好");
  const s = await start({ config, net });
  const bad = await s.api("POST", "/api/reminders", { op: "add", spec: "2000-01-01 08:00", text: "喝水" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /时间不对/);
  const added = await s.api("POST", "/api/reminders", { op: "add", spec: "每天 11:00", text: "喝水" });
  assert.equal(added.json.list[0].when, "每天 11:00");
  const again = await s.api("POST", "/api/reminders", { op: "add", spec: "每天 11:00", text: "喝水" });
  assert.equal(again.json.list.length, 1); // 一样的不重复加

  await s.api("POST", "/onebot", priv(1, "/提醒"));
  await wait(80);
  assert.match(sends(net)[0], /1\. 每天 11:00 喝水/);

  const gone = await s.api("POST", "/api/reminders", { op: "remove", id: added.json.reminder.id });
  assert.equal(gone.json.list.length, 0);
  await s.close();
});

test("重启不丢：提醒存在文件里；发过的留 7 天后自动清掉", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-rem-"));
  let t = at(2026, 11, 5, 10, 0);
  const now = () => t;
  const a = createReminders({ dataDir, log: silentLog, now });
  const r = a.add({ spec: "2026-11-06 08:00", text: "叫他起床" });
  a.add({ spec: "每天 11:00", text: "喝水" });
  const b = createReminders({ dataDir, log: silentLog, now });
  assert.deepEqual(b.active().map((x) => x.text), ["喝水", "叫他起床"]);
  b.markFired(r.id, t);
  t += 8 * 86400000;
  b.add({ spec: "2026-12-01 08:00", text: "新的" }); // 保存时清理
  assert.ok(!b.all().some((x) => x.id === r.id));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
