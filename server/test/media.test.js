"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { start, fakeNet } = require("./_helpers");
const { parseOutput, toBubbles } = require("../lib/humanize");
const { faceText } = require("../lib/qqfaces");

const BOT = 10001;
const OWNER = 123456;
const BASE = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 40, selfId: BOT } };

/** 造一张「GIF」：文件头对就行，内容随便 */
function gif(seed) {
  return Buffer.concat([Buffer.from("GIF89a"), crypto.createHash("sha256").update(String(seed)).digest(), Buffer.alloc(64, 1)]);
}
const isVisionCall = (m) => Array.isArray(m[0].content);
const priv = (id, message) => ({ post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: id, message });
async function settle(s) {
  await new Promise((r) => setTimeout(r, 120));
  await s.onebot.idle();
}

test("看图：你发的表情包会被看懂、写进上下文，并收进它的表情包库", async () => {
  const chats = [];
  const net = fakeNet({
    files: { "https://multimedia.nt.qq.com.cn/a": gif("a") },
    llm: (m) => {
      if (isVisionCall(m)) return '{"desc":"熊猫头捂脸，配字：我真的会谢","mood":"无语","sticker":true}';
      if (m[0].content.includes("记忆整理")) return "{}";
      chats.push(m);
      return "〔想〕他在无语\n〔心情〕开心\n哈哈哈怎么了";
    },
  });
  const s = await start({ config: BASE, net });
  await s.api("POST", "/onebot", priv(1, [{ type: "image", data: { url: "https://multimedia.nt.qq.com.cn/a", sub_type: 1, summary: "[动画表情]" } }]));
  await settle(s);
  assert.equal(chats.length, 1);
  assert.equal(chats[0][chats[0].length - 1].content, "[表情包：熊猫头捂脸，配字：我真的会谢]");
  assert.equal(s.stickers.count(), 1, "收进了表情包库");
  // 同一张图第二次不再花钱看
  await s.api("POST", "/onebot", priv(2, [{ type: "image", data: { url: "https://multimedia.nt.qq.com.cn/a", sub_type: 1 } }]));
  await settle(s);
  assert.equal(net.calls.llm.filter((b) => Array.isArray(b.messages[0].content)).length, 1);
  await s.close();
});

test("看不了图时如实标成「[图片]」，提示词要求别装作看见", async () => {
  const chats = [];
  const net = fakeNet({ llm: (m) => (isVisionCall(m) ? { __status: 500 } : m[0].content.includes("记忆整理") ? "{}" : (chats.push(m), "〔想〕嗯\n〔心情〕平静\n图没刷出来")) });
  const s = await start({ config: BASE, net });
  await s.api("POST", "/onebot", priv(1, [{ type: "image", data: { url: "https://x.test/none.jpg", sub_type: 0 } }]));
  await settle(s);
  assert.equal(chats[0][chats[0].length - 1].content, "[图片]");
  assert.match(chats[0][0].content, /说明你看不到那张图。不要假装看到了/);
  await s.close();
});

test("发表情包：模型写 [表情包:关键词]，按心情从库里挑一张，以图片发出", async () => {
  const net = fakeNet({ llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : "〔想〕逗他\n〔心情〕委屈\n凶我干嘛\n[表情包:委屈]") });
  const s = await start({ config: BASE, net });
  const id = s.stickers.add(gif("sad"), { desc: "小猫泪眼汪汪，配字：委屈", mood: "委屈", source: "test" });
  s.stickers.add(gif("happy"), { desc: "小狗开心转圈", mood: "开心", source: "test" });
  await s.api("POST", "/onebot", priv(1, [{ type: "text", data: { text: "你有病吧" } }]));
  await settle(s);
  const sends = net.calls.onebot.filter((c) => c.action === "send_private_msg").map((c) => c.params.message);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], [{ type: "text", data: { text: "凶我干嘛" } }]);
  assert.equal(sends[1][0].type, "image");
  assert.equal(sends[1][0].data.sub_type, 1);
  assert.equal(sends[1][0].data.file, "base64://" + gif("sad").toString("base64"));
  // 网页端拿到的是图片地址
  const r = await s.api("POST", "/api/chat", { text: "再来" });
  const sticker = r.json.parts.find((p) => p.type === "sticker");
  assert.ok(sticker, JSON.stringify(r.json.parts));
  assert.equal((await fetch(s.base + sticker.url)).status, 200);
  assert.ok(id);
  await s.close();
});

test("表情包库是空的：提示词里不提发表情包，模型写了也不会发出奇怪的字", async () => {
  const chats = [];
  const net = fakeNet({ llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : (chats.push(m), "〔想〕嗯\n〔心情〕开心\n好耶\n[表情包:开心]")) });
  const s = await start({ config: BASE, net });
  const r = await s.api("POST", "/api/chat", { text: "我考过了" });
  assert.deepEqual(r.json.bubbles, ["好耶"]);
  assert.doesNotMatch(chats[0][0].content, /\[表情包:关键词\]/);
  await s.close();
});

test("首次启动从旧项目导入已打好标签的表情包，跳过截图和二维码", async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "aif-old-"));
  fs.mkdirSync(path.join(old, "output", "stickers", "groups"), { recursive: true });
  fs.mkdirSync(path.join(old, "data", "stickers"), { recursive: true });
  const a = gif("old-a");
  const b = gif("old-b");
  const ida = crypto.createHash("sha1").update(a).digest("hex");
  const idb = crypto.createHash("sha1").update(b).digest("hex");
  fs.writeFileSync(path.join(old, "output", "stickers", "groups", ida + ".gif"), a);
  fs.writeFileSync(path.join(old, "output", "stickers", "groups", idb + ".gif"), b);
  fs.writeFileSync(
    path.join(old, "data", "stickers", "brain.json"),
    JSON.stringify({ [ida]: { desc: "灰白小猫举爪得意", mood: "happy", valence: 0.5 }, [idb]: { desc: "联机需求二维码截图", mood: "neutral" } })
  );
  const s = await start({ config: { ...BASE, stickers: { importFrom: old } } });
  const r = s.stickers.importLegacy();
  assert.equal(r.imported, 1);
  assert.equal(s.stickers.list()[0].mood, "开心");
  assert.equal(s.stickers.importLegacy().imported, 0, "只导入一次");
  await s.close();
});

test("「正在输入」：处理私聊时调用 NapCat 的 set_input_status", async () => {
  const net = fakeNet({ llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : "〔想〕嗯\n〔心情〕平静\n在呢") });
  const s = await start({ config: BASE, net });
  await s.api("POST", "/onebot", priv(1, [{ type: "text", data: { text: "在吗" } }]));
  await settle(s);
  const typing = net.calls.onebot.find((c) => c.action === "set_input_status");
  assert.ok(typing);
  assert.equal(typing.params.user_id, String(OWNER));
  assert.equal(typing.params.status, 1);
  await s.close();
});

test("被戳：有时会戳回去，并告诉模型自己戳回去了", async () => {
  const chats = [];
  const net = fakeNet({ llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : (chats.push(m), "〔想〕嘿\n〔心情〕开心\n戳我干嘛")) });
  const s = await start({ config: BASE, net, random: () => 0.1 });
  await s.api("POST", "/onebot", { post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: BOT, user_id: OWNER, target_id: BOT });
  await settle(s);
  assert.ok(net.calls.onebot.some((c) => c.action === "friend_poke"));
  assert.match(chats[0][chats[0].length - 2].content, /戳回去了/);
  await s.close();
});

test("QQ 表情：超级表情也认得；[微笑] 标注成阴阳怪气", () => {
  assert.equal(faceText(20), "[偷笑]");
  assert.equal(faceText(393), "[新年中龙]");
  assert.match(faceText(14), /阴阳怪气/);
  assert.equal(faceText(99999), "[QQ表情]");
});

test("解析：几个标记写在同一行也能拆开；〔搜索〕被识别；客服式「明白」被去掉", () => {
  const r = parseOutput("〔想〕他问天气〔心情〕平静〔搜索〕杭州天气");
  assert.equal(r.thought, "他问天气");
  assert.equal(r.search, "杭州天气");
  assert.deepEqual(r.lines, []);
  const r2 = parseOutput("〔想〕嗯\n〔心情〕开心 哈哈好");
  assert.deepEqual(r2.lines, ["哈哈好"]);
  assert.deepEqual(toBubbles(["明白", "那你说怎么办嘛"]), ["那你说怎么办嘛"]);
  assert.deepEqual(toBubbles(["笑死[表情包:笑死]"]), ["笑死", "[表情包:笑死]"]);
});
