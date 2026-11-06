"use strict";
/* 日记和纪念日：一天写一篇、聊得少不写、漏了补写；纪念日当天第一句回复会提到 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, fakeNet } = require("./_helpers");
const { checkDiary } = require("../server");
const { milestoneOn, upcoming, parseBirthday, dayTitle } = require("../lib/diary");

const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const isDiary = (m) => m[0].content.includes("睡前会写一小段日记");

function setup(t) {
  const calls = [];
  const clock = { t };
  const net = fakeNet({
    llm: (m) => {
      if (m[0].content.includes("记忆整理")) return "{}";
      calls.push(m);
      if (isDiary(m)) return "## 日记\n- 今天他说面试过了，我比他还高兴。\n希望他别又熬夜。";
      return "〔想〕嗯\n〔心情〕开心\n好呀";
    },
  });
  return { calls, net, clock, config: { llm: { apiKey: "sk-test-1234567890" }, qq: { enabled: false } } };
}

/** 往主聊天里塞 n 条某天的消息（一问一答） */
function chatOn(s, day, n, hour = 20) {
  const [y, m, d] = day.split("-").map(Number);
  for (let i = 0; i < n; i++) s.memory.append("main", { role: i % 2 ? "assistant" : "user", text: i % 2 ? `回第${i}句` : `今天第${i}句`, ts: at(y, m, d, hour, i) });
}

test("纪念日：第 7/30/100 天、周年、生日；生日的几种写法都认", () => {
  const first = at(2026, 1, 1, 20);
  assert.equal(milestoneOn("2026-01-07", first, null), "今天是你们认识的第 7 天");
  assert.equal(milestoneOn("2026-04-10", first, null), "今天是你们认识的第 100 天");
  assert.equal(milestoneOn("2027-01-01", first, null), "今天是你们认识 1 周年");
  assert.equal(milestoneOn("2026-01-01", first, null), ""); // 第一天不算
  assert.equal(milestoneOn("2026-05-20", first, [5, 20], "老王"), "今天是老王的生日");
  assert.deepEqual(parseBirthday("5月20日"), [5, 20]);
  assert.deepEqual(parseBirthday("2000年5月20号"), [5, 20]);
  assert.deepEqual(parseBirthday("05-20"), [5, 20]);
  assert.equal(parseBirthday("夏天"), null);
  const next = upcoming(at(2026, 1, 5), first, [3, 8]);
  assert.deepEqual(next.slice(0, 3).map((u) => [u.day, u.inDays, u.text]), [
    ["2026-01-07", 2, "你们认识的第 7 天"],
    ["2026-01-30", 25, "你们认识的第 30 天"],
    ["2026-03-08", 62, "对方的生日"],
  ]);
  assert.equal(dayTitle("2026-11-05"), "11月5日 星期四");
});

test("写日记：只用那一天的聊天、用它的口吻、去掉标题和列表符号；写过不重写，强制可以重写", async () => {
  const { net, config, calls, clock } = setup(at(2026, 11, 5, 23, 40));
  const s = await start({ config, net, now: () => clock.t });
  chatOn(s, "2026-11-04", 8);
  chatOn(s, "2026-11-05", 8);
  const r = await s.diary.write("2026-11-05");
  assert.equal(r.written, true);
  assert.equal(calls.length, 1);
  const prompt = calls[0][1].content;
  assert.match(prompt, /11月5日 星期四/);
  assert.match(prompt, /20:00 对方：今天第0句/);
  assert.match(prompt, /20:01 我：回第1句/);
  assert.equal(s.diary.list()[0].text, "今天他说面试过了，我比他还高兴。\n希望他别又熬夜。");
  assert.equal(s.diary.list()[0].title, "11月5日 星期四");

  assert.equal((await s.diary.write("2026-11-05")).skipped, "已经写过了");
  await s.diary.write("2026-11-05", { force: true });
  assert.equal(calls.length, 2);
  assert.equal(s.diary.list().length, 1); // 重写是替换，不是多一篇
  await s.close();
});

test("定时：到点前不写今天的；到点后写今天的，并补写最近漏掉的；聊得太少的跳过；关掉就不写", async () => {
  const { net, config, calls, clock } = setup(at(2026, 11, 5, 23, 0));
  const s = await start({ config, net, now: () => clock.t });
  chatOn(s, "2026-11-02", 10);
  chatOn(s, "2026-11-03", 3); // 太少
  chatOn(s, "2026-11-05", 10);
  await checkDiary(s, clock.t);
  assert.deepEqual(s.diary.list().map((e) => e.day), ["2026-11-02"]); // 23:00 还没到 23:30，今天先不写
  clock.t = at(2026, 11, 5, 23, 31);
  await checkDiary(s, clock.t);
  assert.deepEqual(s.diary.list().map((e) => e.day), ["2026-11-05", "2026-11-02"]);
  assert.equal(calls.filter(isDiary).length, 2);
  assert.equal(checkDiary(s, clock.t), null); // 都写过了
  await s.close();

  const off = setup(at(2026, 11, 5, 23, 40));
  const s2 = await start({ config: { ...off.config, diary: { enabled: false } }, net: off.net, now: () => off.clock.t });
  chatOn(s2, "2026-11-05", 10);
  assert.equal(checkDiary(s2, off.clock.t), null);
  await s2.close();
});

test("纪念日当天：第一句回复的提示里有，回过之后同一天不再提；角色不提", async () => {
  const { net, config, calls, clock } = setup(at(2026, 1, 1, 20));
  const s = await start({ config, net, now: () => clock.t });
  await s.api("POST", "/api/chat", { texts: ["你好呀"] }); // 第一次聊天：1 月 1 日
  assert.doesNotMatch(calls[0][calls[0].length - 2].content, /认识的第/);
  clock.t = at(2026, 1, 7, 9);
  await s.api("POST", "/api/chat", { texts: ["早"] });
  assert.match(calls[1][calls[1].length - 2].content, /今天是你们认识的第 7 天。合适的时候可以自然地提一句/);
  await s.api("POST", "/api/chat", { texts: ["吃了吗"] });
  assert.doesNotMatch(calls[2][calls[2].length - 2].content, /认识的第 7 天/);

  // 记忆里有生日
  s.memory.applyOps("main", { set: { 生日: "1月8日" } });
  clock.t = at(2026, 1, 8, 9);
  await s.api("POST", "/api/chat", { texts: ["早"] });
  assert.match(calls[3][calls[3].length - 2].content, /今天是对方的生日/);

  // 导入的角色不提主好友的纪念日
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(s.root, "data", "personas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ list: [{ id: "c1", name: "阿杰", persona: "爱损人", source: { them: "阿杰" } }] }));
  clock.t = at(2027, 1, 8, 9); // 主好友的周年 + 生日
  await s.api("POST", "/api/chat", { texts: ["在吗"], persona: "c1" });
  assert.doesNotMatch(calls[4][calls[4].length - 2].content, /周年|生日/);
  await s.close();
});

test("网页：时间线（认识第几天、接下来的日子）、日记列表、现在写今天的", async () => {
  const { net, config, clock } = setup(at(2026, 11, 5, 10));
  const s = await start({ config, net, now: () => clock.t });
  chatOn(s, "2026-11-01", 4, 9);
  chatOn(s, "2026-11-05", 2, 9);
  const r = (await s.api("GET", "/api/diary")).json;
  assert.equal(r.timeline.dayNo, 5);
  assert.equal(r.timeline.messages, 6);
  assert.deepEqual(r.timeline.upcoming[0], { day: "2026-11-07", inDays: 2, text: "你们认识的第 7 天" });
  assert.deepEqual(r.list, []);
  await s.api("POST", "/api/diary/write");
  while (s.diary.status().running) await new Promise((x) => setTimeout(x, 20));
  const after = (await s.api("GET", "/api/diary")).json;
  assert.equal(after.list.length, 1); // 只聊了 2 条，手动点也能写
  assert.equal(after.list[0].day, "2026-11-05");
  await s.close();
});
