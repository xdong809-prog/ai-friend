"use strict";
/* 角色：导入别人的聊天记录 → 新建一个扮演他/她的 AI（只在网页上聊） */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { start, fakeNet } = require("./_helpers");
const { parseChat, decodeBuffer } = require("../lib/chatimport");

const QQ_TXT = [
  "消息记录（此消息记录为文本格式，不支持重新导入）",
  "",
  "================================================================",
  "消息分组:我的好友",
  "================================================================",
  "消息对象:阿杰",
  "================================================================",
  "",
  "2021-03-05 21:30:01 阿杰(123456789)",
  "老王 在吗",
  "明天去爬山不",
  "",
  "2021-03-05 21:31:15 我自己",
  "去啊[图片]",
  "",
  "2021-03-05 21:32:00 阿杰(123456789)",
  "那八点楼下见～",
  "",
  "2021-03-06 08:05:00 我自己",
  "我到了",
  "",
  "2021-03-06 08:06:30 阿杰(123456789)",
  "哈哈哈哈你又早到",
  "",
].join("\r\n");

/** 老版 QQ 导出常是 GBK 编码：用 GB18030 编码一遍，顺便测解码 */
function gbk(text) {
  const out = [];
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) {
      out.push(ch.charCodeAt(0));
      continue;
    }
    // Node 没有 GBK 编码器：用对照表查
    const code = GBK_TABLE.get(ch);
    if (!code) throw new Error("GBK 里没有这个字：" + ch);
    out.push(code >> 8, code & 0xff);
  }
  return Buffer.from(out);
}
// 用解码器反查：遍历 GBK 双字节区，建一个「字 → 编码」的表
const GBK_TABLE = (() => {
  const dec = new TextDecoder("gb18030");
  const map = new Map();
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      const ch = dec.decode(Buffer.from([hi, lo]));
      if (ch.length === 1 && !map.has(ch)) map.set(ch, (hi << 8) | lo);
    }
  }
  return map;
})();

test("解析 QQ 导出的 txt：认出聊天对象、多行消息、去掉名字后面的 QQ 号", () => {
  const r = parseChat(QQ_TXT, { filename: "阿杰.txt" });
  assert.equal(r.format, "header");
  assert.equal(r.partner, "阿杰");
  assert.deepEqual(r.speakers.map((s) => [s.name, s.count]), [["阿杰", 3], ["我自己", 2]]);
  assert.equal(r.messages[0].text, "老王 在吗\n明天去爬山不");
  assert.equal(r.messages[0].ts, new Date(2021, 2, 5, 21, 30, 1).getTime());
});

test("解析微信导出的 csv：自己发的叫「我」，图片换成占位，系统提示跳过，引号里的逗号和换行不乱", () => {
  const csv =
    "localId,TalkerId,Type,SubType,IsSender,CreateTime,Status,StrContent,StrTime,Remark,NickName,Sender\n" +
    '1,2,1,0,0,1680000000,2,"你好, 在干嘛",2023-03-28 18:40:00,小林,林林,wxid_a\n' +
    '2,2,1,0,1,1680000060,2,"上班呢\n好累",2023-03-28 18:41:00,小林,林林,wxid_me\n' +
    "3,2,3,0,0,1680000120,2,<msg><img/></msg>,2023-03-28 18:42:00,小林,林林,wxid_a\n" +
    "4,2,10000,0,0,1680000130,2,你撤回了一条消息,2023-03-28 18:42:10,小林,林林,wxid_a\n";
  const r = parseChat(csv, { filename: "小林.csv" });
  assert.equal(r.format, "csv");
  assert.equal(r.meKnown, true);
  assert.deepEqual(r.messages.map((m) => [m.name, m.text]), [["小林", "你好, 在干嘛"], ["我", "上班呢\n好累"], ["小林", "[图片]"]]);
  assert.equal(r.speakers.find((s) => s.name === "我").me, true);
});

test("解析其他写法：名字在前的 txt、一行一条、没有时间的「名字：内容」；读得了 GBK 和带 BOM 的 UTF-16", () => {
  assert.equal(parseChat("小林 2023-05-01 12:00:00\n吃了吗\n我 2023-05-01 12:01:00\n吃了\n").format, "header-name-first");
  const one = parseChat("[2023-05-01 12:00] 小林：吃了吗\n2023-05-01 12:01:30 我: 吃了\n");
  assert.equal(one.format, "one-line");
  assert.deepEqual(one.messages.map((m) => m.text), ["吃了吗", "吃了"]);
  const plain = parseChat("小林：吃了吗\n我：吃了\n", { now: 1e12 });
  assert.equal(plain.format, "plain");
  assert.ok(plain.messages[0].ts < plain.messages[1].ts);
  assert.equal(decodeBuffer(gbk("阿杰：在吗")), "阿杰：在吗");
  assert.equal(decodeBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("在吗", "utf16le")])), "在吗");
  assert.equal(parseChat("随便写的一段话，不是聊天记录").messages.length, 0);
});

// ---------- 导入和聊天 ----------

const isStyle = (m) => m[0].content.includes("研究一个人的聊天风格");
const isSegment = (m) => m[0].content.includes("在回忆你和「我」以前的聊天");
const isMerge = (m) => m[0].content.includes("整理你和对方之间的回忆");

function setup() {
  const calls = [];
  const net = fakeNet({
    llm: (m) => {
      calls.push(m);
      if (isStyle(m)) return JSON.stringify({ persona: "说话很短，爱用「哈哈哈哈」，句尾常带～", relationship: "大学室友", userCall: "老王", examples: ["哈哈哈哈你又早到", "那八点楼下见～"] });
      if (isSegment(m)) return JSON.stringify({ story: "3月5日约了第二天去爬山，老王早到了", aboutUser: ["喜欢爬山", "约好了总是早到"], aboutSelf: ["我周末爱爬山"] });
      if (isMerge(m)) return JSON.stringify({ summary: "我和老王是大学室友，2021年3月6日一起去爬过山，他早到了。", selfFacts: ["我周末爱爬山"] });
      if (m[0].content.includes("记忆整理")) return "{}";
      return "〔想〕他问爬山的事\n〔心情〕开心\n记得啊那次你又早到～";
    },
  });
  return { calls, net, config: { llm: { apiKey: "sk-test-1234567890" } } };
}

async function upload(s, buf, file) {
  const res = await fetch(`${s.base}/api/personas/preview?file=${encodeURIComponent(file)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf });
  return { status: res.status, json: await res.json() };
}
async function finished(s) {
  await new Promise((r) => setTimeout(r, 30));
  while (s.personas.status().running) await new Promise((r) => setTimeout(r, 20));
}

test("导入 GBK 编码的 QQ 记录：认出谁是谁，整理出说话方式和回忆，聊天记录按原时间写进角色自己的会话", async () => {
  const { net, config, calls } = setup();
  const s = await start({ config, net });
  const pv = await upload(s, gbk(QQ_TXT), "阿杰.txt");
  assert.equal(pv.status, 200);
  assert.equal(pv.json.count, 5);
  assert.deepEqual(pv.json.guess, { me: "我自己", them: "阿杰" });

  const r = await s.api("POST", "/api/personas/import", { token: pv.json.token, me: "我自己", them: "阿杰" });
  assert.equal(r.json.ok, true);
  await finished(s);
  assert.equal(s.personas.status().error, "");
  assert.equal(calls.filter(isStyle).length, 1);
  assert.equal(calls.filter(isSegment).length, 1);
  assert.equal(calls.filter(isMerge).length, 1);

  const list = (await s.api("GET", "/api/personas")).json.list;
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.name, "阿杰");
  assert.equal(p.relationship, "大学室友");
  assert.equal(p.userCall, "老王");
  assert.equal(p.messages, 5);
  assert.equal(p.facts, 2);
  assert.match(p.summary, /大学室友/);
  assert.deepEqual(p.selfFacts, ["我周末爱爬山"]);

  const h = s.memory.history(`p_${p.id}`, 10).messages;
  assert.deepEqual(h.map((m) => m.role), ["assistant", "user", "assistant", "user", "assistant"]);
  assert.equal(h[0].ts, new Date(2021, 2, 5, 21, 30, 1).getTime());
  assert.equal(s.memory.history("main", 5).total, 0); // 主好友的聊天不受影响
  assert.deepEqual(s.personas.namesFor(`p_${p.id}`), { name: "阿杰", userCall: "老王" });
  await s.close();
});

test("和角色聊：用它自己的名字、说话方式和回忆，提示它别照搬原话；改设定马上生效；删掉后聊不了", async () => {
  const { net, config, calls } = setup();
  const s = await start({ config, net });
  const pv = await upload(s, Buffer.from(QQ_TXT, "utf8"), "阿杰.txt");
  await s.api("POST", "/api/personas/import", { token: pv.json.token, me: "我自己", them: "阿杰", name: "杰哥" });
  await finished(s);
  const id = s.personas.list()[0].id;

  const r = await s.api("POST", "/api/chat", { texts: ["还记得那次去爬山吗"], persona: id });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.bubbles, ["记得啊那次你又早到～"]);
  const chat = calls[calls.length - 1];
  const sys = chat[0].content;
  assert.match(sys, /你是「杰哥」。你和「老王」是大学室友/);
  assert.match(sys, /爱用「哈哈哈哈」/);
  assert.match(sys, /我周末爱爬山/);
  assert.match(sys, /不要原样照搬以前说过的句子/);
  assert.match(sys, /都是你以前的原话/);
  const dyn = chat[chat.length - 2].content;
  assert.match(dyn, /一起去爬过山/);
  assert.match(dyn, /喜欢爬山/);
  assert.doesNotMatch(dyn, /你此刻大概在/); // 真实的人，不给他编此刻在干嘛
  // 以前的原话作为聊天记录带上了（他说的是 assistant，你说的是 user）
  const said = chat.filter((m) => m.role !== "system");
  assert.match(said.filter((m) => m.role === "assistant").map((m) => m.content).join("\n"), /哈哈哈哈你又早到/);
  assert.match(said.filter((m) => m.role === "user").map((m) => m.content).join("\n"), /我到了/);

  const h = (await s.api("GET", `/api/history?persona=${id}`)).json;
  assert.equal(h.total, 7);
  assert.equal(h.messages[h.messages.length - 1].text, "记得啊那次你又早到～");
  assert.equal((await s.api("GET", "/api/history")).json.total, 0);

  await s.api("POST", "/api/personas/update", { id, persona: "说话很冲，爱抬杠" });
  await s.api("POST", "/api/chat", { texts: ["在吗"], persona: id });
  assert.match(calls[calls.length - 1][0].content, /说话很冲，爱抬杠/);

  assert.equal((await s.api("POST", "/api/personas/remove", { id })).json.ok, true);
  assert.equal((await s.api("GET", "/api/personas")).json.list.length, 0);
  assert.ok(fs.readdirSync(path.join(s.root, "data", "sessions")).some((f) => f.startsWith(`p_${id}.jsonl.bak-`)));
  assert.equal((await s.api("POST", "/api/chat", { texts: ["在吗"], persona: id })).status, 404);
  await s.close();
});

test("聊天记录很长：调用模型的次数有上限，每次给的内容有上限，每轮只带最近 30 条原文", async () => {
  const { net, config, calls } = setup();
  const s = await start({ config, net });
  const rows = [];
  const t0 = new Date(2022, 0, 1, 9, 0, 0).getTime();
  for (let i = 0; i < 2500; i++) {
    const d = new Date(t0 + i * 3600000);
    const ts = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}:00`;
    rows.push(`${ts} ${i % 2 ? "我自己" : "阿杰"}`, `第${i}条消息，随便聊聊今天的事情`, "");
  }
  const pv = await upload(s, Buffer.from(rows.join("\n")), "阿杰.txt");
  assert.equal(pv.json.count, 2500);
  await s.api("POST", "/api/personas/import", { token: pv.json.token, me: "我自己", them: "阿杰" });
  await finished(s);
  assert.equal(calls.filter(isSegment).length, 10);
  assert.equal(calls.length, 12);
  for (const m of calls) assert.ok(m[1].content.length < 9000, "一次给模型的内容太长：" + m[1].content.length);

  const id = s.personas.list()[0].id;
  assert.equal(s.memory.history(`p_${id}`, 1).total, 2500);
  await s.api("POST", "/api/chat", { texts: ["在吗"], persona: id });
  const chat = calls[calls.length - 1];
  assert.ok(chat.length < 40, "带的原文太多：" + chat.length);
  assert.match(chat.map((m) => m.content).join("\n"), /第2499条/);
  assert.doesNotMatch(chat.map((m) => m.content).join("\n"), /第2400条/);
  await s.close();
});

test("读不懂的文件、选错人、预览过期都有明白的提示", async () => {
  const { net, config } = setup();
  const s = await start({ config, net });
  const bad = await upload(s, Buffer.from("这不是聊天记录"), "x.txt");
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /没认出这是聊天记录/);
  const pv = await upload(s, Buffer.from(QQ_TXT), "阿杰.txt");
  await s.api("POST", "/api/personas/import", { token: pv.json.token, me: "阿杰", them: "阿杰" });
  await finished(s);
  assert.match(s.personas.status().error, /不能是同一个人/);
  await s.api("POST", "/api/personas/import", { token: "过期了", me: "我自己", them: "阿杰" });
  await finished(s);
  assert.match(s.personas.status().error, /预览过期了/);
  assert.equal(s.personas.list().length, 0);
  await s.close();
});
