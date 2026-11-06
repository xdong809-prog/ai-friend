"use strict";
/*
 * 语音（只在 QQ 私聊）：听懂你发的语音，偶尔用声音回你。
 *
 * 走通用的 OpenAI 兼容接口，用「模型」页里已经添加好的某个服务商（比如硅基流动）的地址和 Key：
 *   听写：POST {baseUrl}/audio/transcriptions（multipart：file、model）→ {text}
 *   说话：POST {baseUrl}/audio/speech（JSON：model、input、voice、response_format）→ mp3
 * QQ 语音是 silk 格式：收到时让 NapCat 的 get_record 转成 mp3（它自带 ffmpeg，会直接给 base64）；
 * 发的时候把 mp3 用 base64:// 交给 NapCat，它负责转成 silk。
 * 没开或者没配好时，一切和以前一样：语音显示成「[语音]」，回复只发文字。
 */

const TIMEOUT_MS = 30000;
const MAX_AUDIO = 10 * 1024 * 1024; // 太大的语音不送去听写
const MAX_SPEAK = 120; // 一条语音最多念这么多字

/** 硅基流动 CosyVoice2 的预设声音（模型页的下拉框用） */
const VOICES = [
  ["claire", "温柔女声"],
  ["anna", "沉稳女声"],
  ["bella", "激情女声"],
  ["diana", "欢快女声"],
  ["alex", "沉稳男声"],
  ["benjamin", "低沉男声"],
  ["charles", "磁性男声"],
  ["david", "欢快男声"],
];

function createVoice({ config, log, fetch = globalThis.fetch }) {
  const stats = { heard: 0, said: 0, lastError: "" };

  function provider() {
    const v = config.voice;
    const p = v && config.providers.find((x) => x.id === v.provider);
    return p && p.baseUrl && p.apiKey ? p : null;
  }
  /** 能听懂语音 */
  const enabled = () => Boolean(config.voice && config.voice.enabled && provider());
  /** 能用声音回 */
  const canSpeak = () => enabled() && config.voice.replyMode !== "off";

  const base = (p) => p.baseUrl.replace(/\/+$/, "");
  const fail = (message) => {
    stats.lastError = message;
    return new Error(message);
  };

  async function errorText(res) {
    const raw = await res.text().catch(() => "");
    return `HTTP ${res.status}${raw ? "：" + raw.slice(0, 120) : ""}`;
  }

  /** 语音（mp3）→ 文字 */
  async function transcribe(buf, filename = "voice.mp3") {
    const p = provider();
    if (!p) throw fail("语音没配置好");
    if (!buf || !buf.length) throw fail("语音是空的");
    if (buf.length > MAX_AUDIO) throw fail("语音太长了");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), filename);
    form.append("model", config.voice.sttModel);
    const res = await fetch(`${base(p)}/audio/transcriptions`, { method: "POST", headers: { Authorization: "Bearer " + p.apiKey }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw fail("听写失败：" + (await errorText(res)));
    const data = await res.json().catch(() => ({}));
    const text = String((data && data.text) || "").trim();
    if (!text) throw fail("没听出内容");
    stats.heard++;
    stats.lastError = "";
    return text;
  }

  /** 文字 → 语音（mp3） */
  async function speak(text) {
    const p = provider();
    if (!p) throw fail("语音没配置好");
    const input = String(text || "").replace(/\[QQ脸:[^\]]*\]/g, "").trim().slice(0, MAX_SPEAK);
    if (!input) throw fail("没有要说的话");
    const v = config.voice;
    const res = await fetch(`${base(p)}/audio/speech`, {
      method: "POST",
      headers: { Authorization: "Bearer " + p.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: v.ttsModel, input, voice: v.ttsVoice, response_format: "mp3" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw fail("合成语音失败：" + (await errorText(res)));
    const type = String((res.headers && res.headers.get && res.headers.get("content-type")) || "");
    if (/json|text\//i.test(type)) throw fail("合成语音失败：服务没返回声音（" + (await res.text().catch(() => "")).slice(0, 120) + "）");
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw fail("合成语音失败：声音是空的");
    stats.said++;
    stats.lastError = "";
    return buf;
  }

  return { enabled, canSpeak, transcribe, speak, stats: () => ({ enabled: enabled(), ...stats }) };
}

module.exports = { createVoice, VOICES, MAX_SPEAK };
