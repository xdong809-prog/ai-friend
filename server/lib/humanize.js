"use strict";
/*
 * 真人化处理：解析模型输出（〔想〕〔心情〕+ 消息行）、去 AI 腔、拆成自然的几条消息、
 * 处理 QQ 小表情、计算「看消息 + 打字」的停顿时间。
 */
const { NAME_TO_ID, faceAllowed } = require("./qqfaces");
const { clamp } = require("./util");

const MOODS = ["开心", "平静", "低落", "烦躁", "害羞", "兴奋", "担心", "委屈"];

function normalizeMood(raw) {
  const s = String(raw || "");
  for (const m of MOODS) if (s.includes(m)) return m;
  if (/高兴|快乐|愉快|嘿嘿|哈哈/.test(s)) return "开心";
  if (/难过|伤心|失落|丧/.test(s)) return "低落";
  if (/生气|烦|无语|恼/.test(s)) return "烦躁";
  if (/激动|期待/.test(s)) return "兴奋";
  if (/心疼|关心|着急|紧张/.test(s)) return "担心";
  return "平静";
}

const TAG_RE = (words) => new RegExp(`^[*\\s]*[〔【\\[(（]\\s*(?:${words})\\s*[〕】\\])）]\\s*[:：]?\\s*(.*)$`);
const THOUGHT_RE = TAG_RE("想|内心|心里|思考|内心活动");
const MOOD_RE = TAG_RE("心情|情绪|状态");
const SEARCH_RE = TAG_RE("搜索|联网搜索|查");
const STICKER_RE = /\[表情包\s*[:：]\s*([^\]\n]{1,12})\]/g;
/** 单独一条、只是在「表态收到」的客服式回复，有别的内容时直接去掉 */
const ACK_ONLY_RE = /^(?:明白|收到|了解|好的|知道了|我知道了)(?:了|啦|啊)?[，,。.!！~～]*$/;

/** AI 腔：命中的整句删掉 */
const AI_PHRASES = [
  /作为(?:一个|一名)?\s*(?:AI|人工智能|语言模型|助手)/i,
  /我(?:只)?是(?:一个)?(?:AI|人工智能|语言模型)(?:助手)?(?:，|,)?(?:没有|无法|不能)/i,
  /有什么(?:我)?可以帮(?:到|助)?你的/,
  /希望(?:这|以上|我的回答)?(?:些)?(?:能|可以)?对你有(?:所)?帮助/,
  /如果你?还有(?:其他|任何)(?:问题|需要)/,
  /(?:请)?随时(?:告诉|找|联系)我/,
  /^(?:总之|综上所述|总而言之)[，,]/,
  /很高兴(?:能)?(?:为你|帮你|和你)(?:服务|解答)/,
];

function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`+/g, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*•·]|\d{1,2}[.、)）]|消息\s*\d*\s*[:：]|第[一二三四五]条[:：]?)\s*/, "")
    .trim();
}

function stripQuotes(s) {
  const m = s.match(/^[「“"『](.*)[」”"』]$/);
  return m ? m[1].trim() : s;
}

/**
 * 解析模型原始输出。
 * @returns {{thought:string, mood:string, lines:string[], search:string}}
 */
function parseOutput(raw, { selfName = "" } = {}) {
  let thought = "";
  let mood = "";
  let search = "";
  const lines = [];
  // 模型偶尔把几个标记写在同一行，先拆开
  const text = String(raw || "").replace(/(?!^)\s*([〔【](?:想|心情|情绪|搜索)[〕】])/g, "\n$1");
  for (const rawLine of text.split(/\r?\n/)) {
    let t = rawLine.trim();
    if (!t) continue;
    let m = t.match(THOUGHT_RE);
    if (m) {
      thought = m[1].trim();
      continue;
    }
    m = t.match(MOOD_RE);
    if (m) {
      mood = normalizeMood(m[1].slice(0, 6));
      const rest = m[1].replace(/^\s*(?:开心|平静|低落|烦躁|害羞|兴奋|担心|委屈)[\s，,。]*/, "").trim();
      if (rest && rest !== m[1].trim()) lines.push(stripQuotes(stripMarkdown(rest)));
      continue;
    }
    m = t.match(SEARCH_RE);
    if (m) {
      search = m[1].replace(/[「」“”"]/g, "").trim().slice(0, 60);
      continue;
    }
    if (/^〔[^〕]*〕/.test(t)) continue; // 其他内部标记，不外发
    t = stripMarkdown(t);
    if (selfName && (t.startsWith(selfName + "：") || t.startsWith(selfName + ":"))) t = t.slice(selfName.length + 1).trim();
    t = stripQuotes(t);
    if (t) lines.push(t);
  }
  return { thought, mood: mood || "平静", lines, search };
}

function removeAiTone(lines) {
  const out = [];
  for (const line of lines) {
    const sentences = line.split(/(?<=[。！？!?~～])/);
    const kept = sentences.filter((s) => !AI_PHRASES.some((re) => re.test(s.trim())));
    const joined = kept.join("").trim();
    if (joined) out.push(joined);
  }
  return out.length ? out : lines;
}

/** 太长的一行按句子切开，再拼成每条不超过 maxLen 的消息 */
function splitLong(line, maxLen = 38) {
  // 英文为主的消息按单词算，字符数天然更多，放宽上限
  const ascii = (line.match(/[\x20-\x7e]/g) || []).length;
  if (ascii > line.length * 0.6) maxLen = Math.max(maxLen, 110);
  if (line.length <= maxLen) return [line];
  const parts = line.split(/(?<=[。！？!?；;~～…])|(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + p).length > maxLen) {
      out.push(cur);
      cur = p;
    } else {
      cur += cur && /[A-Za-z0-9.,!?'"]$/.test(cur) && /^[A-Za-z0-9]/.test(p) ? " " + p : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 句末句号去掉，更像聊天；「。。。」「…」保留 */
function tidyEnding(s) {
  return s.replace(/(?<![。.])[。](?=(\s*\[QQ脸:[^\]]+\])?\s*$)/, "").trim();
}

/** 处理 [QQ脸:名称]：校验名字、按心情过滤、整轮最多保留一个 */
function processFaces(bubbles, mood) {
  let used = 0;
  return bubbles
    .map((b) =>
      b.replace(/\[(?:QQ脸|表情|face)\s*[:：]\s*([^\]\n]{1,8})\]/gi, (all, name) => {
        const n = name.trim();
        if (used >= 1 || !faceAllowed(n, mood)) return "";
        used++;
        return `[QQ脸:${n}]`;
      }).trim()
    )
    .filter(Boolean);
}

/**
 * 把解析后的行变成最终要发的几条消息。
 * @returns {string[]}
 */
function toBubbles(lines, { mood = "平静", maxBubbles = 4, stickers = true } = {}) {
  // 先把 [表情包:关键词] 抠出来，单独成一条（整轮最多一张）
  let sticker = "";
  let stickerAt = -1;
  const textLines = [];
  for (const l of lines) {
    let found = "";
    const rest = l.replace(STICKER_RE, (all, kw) => {
      if (!found) found = kw.trim();
      return "";
    }).trim();
    if (found && !sticker && stickers) {
      sticker = found;
      stickerAt = textLines.length + (rest ? 1 : 0);
    }
    if (rest) textLines.push(rest);
  }
  let out = removeAiTone(textLines).flatMap((l) => splitLong(l)).map(tidyEnding).filter(Boolean);
  if (out.length > 1) out = out.filter((b) => !ACK_ONLY_RE.test(b));
  out = processFaces(out, mood);
  const max = sticker ? maxBubbles - 1 : maxBubbles;
  if (out.length > max && max >= 1) {
    const head = out.slice(0, max - 1);
    head.push(out.slice(max - 1).join(" "));
    out = head;
  }
  if (sticker) out.splice(Math.min(Math.max(stickerAt, 0), out.length), 0, `[表情包:${sticker}]`);
  return out;
}

/** 这一条是不是「发一张表情包」 */
function stickerOf(bubble) {
  const m = /^\[表情包:([^\]]+)\]$/.exec(String(bubble || ""));
  return m ? m[1] : "";
}

/** [QQ脸:名称] → 网页显示用的 [名称] */
function facesToText(s) {
  return String(s).replace(/\[QQ脸:([^\]]+)\]/g, "[$1]");
}

/** 切出 OneBot 消息段：文字 + face */
function toSegments(bubble) {
  const segs = [];
  const re = /\[QQ脸:([^\]]+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(bubble))) {
    if (m.index > last) segs.push({ type: "text", data: { text: bubble.slice(last, m.index) } });
    const id = NAME_TO_ID.get(m[1]);
    if (id !== undefined) segs.push({ type: "face", data: { id: String(id) } });
    last = re.lastIndex;
  }
  if (last < bubble.length) segs.push({ type: "text", data: { text: bubble.slice(last) } });
  return segs.filter((s) => s.type !== "text" || s.data.text);
}

/**
 * 发送节奏：先「看消息」，再按字数「打字」。
 * elapsedMs 是生成回复已经花掉的时间，会从第一条的等待里扣掉。
 */
function plan(bubbles, { inputLength = 10, elapsedMs = 0, maxReplyDelayMs = 6000, random = Math.random, enabled = true } = {}) {
  if (!enabled) return { firstDelayMs: 0, delays: bubbles.map(() => 0) };
  const typing = (s) => clamp(Math.round((350 + s.length * 140) * (0.8 + random() * 0.4)), 500, 3800);
  const read = clamp(400 + inputLength * 35 + random() * 900, 400, 3000);
  const firstDelayMs = clamp(Math.round(read + typing(bubbles[0] || "") - elapsedMs), 0, maxReplyDelayMs);
  const delays = bubbles.map((b, i) => (i === 0 ? 0 : typing(b)));
  return { firstDelayMs, delays };
}

module.exports = { MOODS, normalizeMood, parseOutput, toBubbles, stickerOf, removeAiTone, splitLong, tidyEnding, facesToText, toSegments, plan };
