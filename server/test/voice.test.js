"use strict";
/* 语音：听得懂就转成文字，听不懂如实说；要发语音就合成，合成或发送失败就改发文字；没配置时一切照旧 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, fakeNet } = require("./_helpers");
const { normalizeConfig } = require("../lib/config");

const BOT = 10001;
const OWNER = 123456;
const SF = { id: "sf", preset: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-sf-1234567", model: "Qwen/Qwen3-8B" };
const DS = { id: "ds", preset: "deepseek", apiKey: "sk-ds-1234567", model: "deepseek-v4-pro" };
const VOICE_ON = { enabled: true, provider: "sf" };
const MP3 = Buffer.from("ID3假的mp3声音");
const txt = (t) => ({ type: "text", data: { text: t } });
const record = { type: "record", data: { file: "abc.amr" } };
const priv = (id, message) => ({ post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: id, message });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.say          模型的回复
 * @param {object} [o.voice]      config.voice
 * @param {boolean} [o.sttFail]   听写接口报错
 * @param {boolean} [o.ttsFail]   合成接口报错
 * @param {boolean} [o.recordFail] NapCat 发语音段报错
 */
function setup({ say = "〔想〕嗯\n〔心情〕开心\n好呀", voice = VOICE_ON, sttFail = false, ttsFail = false, recordFail = false } = {}) {
  const chats = [];
  const audio = [];
  const net = fakeNet({
    llm: (m) => {
      if (m[0].content.includes("记忆整理")) return "{}";
      chats.push(m);
      return say;
    },
    onebot: (action, body) => {
      if (action === "get_record") return { file: "C:/napcat/abc.amr.mp3", base64: MP3.toString("base64") };
      if (recordFail && action === "send_private_msg" && body.message[0].type === "record") throw new Error("转码失败");
      return { message_id: 1 };
    },
  });
  // 语音接口另外接：听写是 multipart，合成返回二进制
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/audio/transcriptions")) {
      const form = opts.body;
      audio.push({ kind: "stt", auth: opts.headers.Authorization, model: form.get("model"), size: (await form.get("file").arrayBuffer()).byteLength });
      if (sttFail) return { ok: false, status: 500, text: async () => "服务忙", json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ text: "今晚吃火锅吗" }) };
    }
    if (u.endsWith("/audio/speech")) {
      audio.push({ kind: "tts", auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
      if (ttsFail) return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => '{"message":"余额不足"}' };
      return { ok: true, status: 200, headers: { get: () => "audio/mpeg" }, arrayBuffer: async () => MP3.buffer.slice(MP3.byteOffset, MP3.byteOffset + MP3.length) };
    }
    return net.fetch(url, opts);
  };
  const config = { providers: [DS, SF], llm: { active: "ds" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs: 40, selfId: BOT }, voice };
  return { chats, audio, net: { fetch, calls: net.calls }, raw: net, config };
}
const sent = (net) => net.calls.onebot.filter((c) => c.action === "send_private_msg").map((c) => c.params.message);
async function settle(s) {
  await wait(120);
  await s.onebot.idle();
}

test("听懂语音：让 NapCat 转成 mp3，听写成文字给模型", async () => {
  const { chats, audio, net, config } = setup();
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, [record]));
  await settle(s);
  assert.deepEqual(net.calls.onebot.filter((c) => c.action === "get_record").map((c) => c.params), [{ file: "abc.amr", out_format: "mp3" }]);
  assert.deepEqual(audio[0], { kind: "stt", auth: "Bearer sk-sf-1234567", model: "FunAudioLLM/SenseVoiceSmall", size: MP3.length });
  assert.equal(chats[0][chats[0].length - 1].content, "[语音：今晚吃火锅吗]");
  assert.equal(s.memory.history("main", 2).messages[0].text, "[语音：今晚吃火锅吗]");
  await s.close();
});

test("没开语音、或者听写失败：如实显示「[语音]」，提示词让它别假装听到", async () => {
  const off = setup({ voice: { enabled: false, provider: "sf" } });
  const a = await start({ config: off.config, net: off.net });
  await a.api("POST", "/onebot", priv(1, [record]));
  await settle(a);
  assert.equal(off.chats[0][off.chats[0].length - 1].content, "[语音]");
  assert.equal(off.net.calls.onebot.filter((c) => c.action === "get_record").length, 0);
  assert.match(off.chats[0][0].content, /只写了「\[语音\]」的说明你没听到内容/);
  assert.doesNotMatch(off.chats[0][0].content, /〔语音〕要说的话/); // 不能发语音时不教它写
  await a.close();

  const bad = setup({ sttFail: true });
  const b = await start({ config: bad.config, net: bad.net });
  await b.api("POST", "/onebot", priv(1, [txt("你听"), record]));
  await settle(b);
  assert.equal(bad.chats[0][bad.chats[0].length - 1].content, "你听[语音]");
  await b.close();
});

test("用声音回：〔语音〕那句合成 mp3、用 base64 语音段发出；聊天记录里存文字", async () => {
  const { audio, net, config } = setup({ say: "〔想〕他想听我说话\n〔心情〕开心\n来了来了\n〔语音〕好呀，今晚就去吃火锅" });
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, [txt("发条语音给我听听")]));
  await settle(s);
  const out = sent(net);
  assert.deepEqual(out[0], [{ type: "text", data: { text: "来了来了" } }]);
  assert.deepEqual(out[1], [{ type: "record", data: { file: "base64://" + MP3.toString("base64") } }]);
  const tts = audio.find((a) => a.kind === "tts");
  assert.deepEqual(tts.body, { model: "FunAudioLLM/CosyVoice2-0.5B", input: "好呀，今晚就去吃火锅", voice: "FunAudioLLM/CosyVoice2-0.5B:claire", response_format: "mp3" });
  assert.equal(s.memory.history("main", 1).messages[0].text, "来了来了\n（语音）好呀，今晚就去吃火锅");
  await s.close();
});

test("合成失败、或者 NapCat 发不出语音：改发同样的文字", async () => {
  const say = "〔想〕嗯\n〔心情〕开心\n〔语音〕好呀，今晚就去";
  const a = setup({ say, ttsFail: true });
  const s1 = await start({ config: a.config, net: a.net });
  await s1.api("POST", "/onebot", priv(1, [txt("发语音")]));
  await settle(s1);
  assert.deepEqual(sent(a.net), [[{ type: "text", data: { text: "好呀，今晚就去" } }]]);
  assert.match(s1.voice.stats().lastError, /余额不足/);
  await s1.close();

  const b = setup({ say, recordFail: true });
  const s2 = await start({ config: b.config, net: b.net });
  await s2.api("POST", "/onebot", priv(1, [txt("发语音")]));
  await settle(s2);
  const out = sent(b.net);
  assert.equal(out[0][0].type, "record");
  assert.deepEqual(out[1], [{ type: "text", data: { text: "好呀，今晚就去" } }]);
  await s2.close();
});

test("什么时候能发：只在 QQ 私聊；网页、关成「从不」时〔语音〕当普通文字；「你发语音也回语音」会提示它", async () => {
  const say = "〔想〕嗯\n〔心情〕开心\n〔语音〕好呀";
  const web = setup({ say });
  const s = await start({ config: web.config, net: web.net });
  const r = await s.api("POST", "/api/chat", { texts: ["发语音"] });
  assert.deepEqual(r.json.bubbles, ["好呀"]);
  assert.equal(web.audio.length, 0);
  await s.close();

  const off = setup({ say, voice: { ...VOICE_ON, replyMode: "off" } });
  const s2 = await start({ config: off.config, net: off.net });
  await s2.api("POST", "/onebot", priv(1, [txt("发语音")]));
  await settle(s2);
  assert.deepEqual(sent(off.net), [[{ type: "text", data: { text: "好呀" } }]]);
  assert.doesNotMatch(off.chats[0][0].content, /〔语音〕要说的话/);
  await s2.close();

  const mirror = setup({ voice: { ...VOICE_ON, replyMode: "mirror" } });
  const s3 = await start({ config: mirror.config, net: mirror.net });
  await s3.api("POST", "/onebot", priv(1, [record]));
  await settle(s3);
  assert.match(mirror.chats[0][mirror.chats[0].length - 2].content, /对方这次发的是语音，你也可以用〔语音〕回一句/);
  assert.match(mirror.chats[0][0].content, /〔语音〕要说的话/);
  await s3.close();
});

test("网页试听返回 mp3；没配好时提示；设置归一化：服务商不存在就清空、回复方式只认三种", async () => {
  const { net, config } = setup();
  const s = await start({ config, net });
  const res = await fetch(`${s.base}/api/voice/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), MP3.toString());
  await s.close();

  const off = setup({ voice: { enabled: true, provider: "ds-not-there" } });
  const s2 = await start({ config: off.config, net: off.net });
  const bad = await fetch(`${s2.base}/api/voice/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 400);
  await s2.close();

  const c = normalizeConfig({ providers: [SF], voice: { enabled: true, provider: "nope", replyMode: "always" } });
  assert.equal(c.voice.provider, "");
  assert.equal(c.voice.replyMode, "asked");
  assert.equal(c.voice.ttsVoice, "FunAudioLLM/CosyVoice2-0.5B:claire");
});
