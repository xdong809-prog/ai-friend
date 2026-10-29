"use strict";
/*
 * 读别人的聊天记录文件（导入成「角色」用）。只做解析，不碰磁盘、不调模型。
 *
 * 认得这几种：
 *   - QQ 电脑版「导出消息记录」的 .txt：
 *       2016-01-02 21:30:01 张三
 *       你好啊
 *   - 微信导出工具（留痕 / WeChatMsg 等）的 .txt：同上，或者「张三 2023-05-01 12:00:00」名字在前；
 *     也认一行一条的「2023-05-01 12:00:00 张三: 你好」「[2023-05-01 12:00] 张三：你好」
 *   - 微信导出工具的 .csv（StrContent / IsSender / StrTime / Type 这些列），也认中文列名
 *   - 兜底：每行「名字：内容」（没有时间）
 * 编码：UTF-8、带 BOM 的 UTF-16、GBK（老版 QQ 导出的常见编码）都能读。
 */

const MAX_MESSAGES = 100000;
const MAX_TEXT = 2000;

/** 文件字节 → 文字：看 BOM，不是合法 UTF-8 就按 GBK（GB18030）读 */
function decodeBuffer(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 不是 UTF-8 */
  }
  try {
    return new TextDecoder("gb18030").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

const DATE = String.raw`(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?`;
const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?`;
const HEAD_DATE_FIRST = new RegExp(`^${DATE}\\s+${TIME}\\s+(.+?)\\s*$`);
const HEAD_NAME_FIRST = new RegExp(`^(.+?)\\s+${DATE}\\s+${TIME}\\s*$`);
const ONE_LINE = new RegExp(`^\\[?${DATE}[ T]+${TIME}\\]?\\s*(.{1,40}?)\\s*[:：]\\s*(.+)$`);
const PLAIN = /^([^\s:：\[\]]{1,20})\s*[:：]\s*(.+)$/;

function toTs(y, mo, d, h, mi, s) {
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0)).getTime();
}

/** QQ 导出里名字后面常带「(QQ号)」或「<邮箱>」 */
function cleanName(name) {
  return String(name || "")
    .replace(/\s*[(（]\d{5,12}[)）]\s*$/, "")
    .replace(/\s*<[^<>]*>\s*$/, "")
    .trim()
    .slice(0, 40);
}

function pushMsg(out, ts, name, text) {
  const t = String(text || "").replace(/\r/g, "").trim().slice(0, MAX_TEXT);
  const n = cleanName(name);
  if (!t || !n || out.length >= MAX_MESSAGES) return;
  out.push({ ts, name: n, text: t });
}

/** 「时间 名字」一行、下面若干行是内容（QQ txt 和多数微信导出 txt） */
function parseHeaderLines(lines, re, order) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur) pushMsg(out, cur.ts, cur.name, cur.body.join("\n"));
    cur = null;
  };
  for (const line of lines) {
    const m = re.exec(line);
    if (m) {
      flush();
      const g = order === "date" ? { d: m.slice(1, 7), name: m[7] } : { d: m.slice(2, 8), name: m[1] };
      cur = { ts: toTs(...g.d), name: g.name, body: [] };
    } else if (cur && line.trim()) cur.body.push(line.trim());
  }
  flush();
  return out;
}

function parseOneLine(lines) {
  const out = [];
  for (const line of lines) {
    const m = ONE_LINE.exec(line);
    if (m) pushMsg(out, toTs(m[1], m[2], m[3], m[4], m[5], m[6]), m[7], m[8]);
  }
  return out;
}

/** 没有时间的「名字：内容」：按顺序给一个假时间（每条隔一分钟，最后一条是一天前） */
function parsePlain(lines, now) {
  const rows = [];
  for (const line of lines) {
    const m = PLAIN.exec(line.trim());
    if (m) rows.push(m);
  }
  const out = [];
  const start = now - 86400000 - rows.length * 60000;
  rows.forEach((m, i) => pushMsg(out, start + i * 60000, m[1], m[2]));
  return out;
}

// ---------- CSV ----------

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const COLS = {
  content: ["strcontent", "content", "msg", "message", "内容", "消息内容", "消息", "聊天内容"],
  time: ["strtime", "createtime", "time", "datetime", "date", "时间", "发送时间", "消息时间"],
  // 按顺序取第一个不空的：备注名 > 昵称 > 微信号
  name: ["remark", "备注", "nickname", "昵称", "发送人", "发送者", "发言人", "说话人", "name", "sender", "talker"],
  isSender: ["issender", "is_sender", "issend", "是否发送", "是否是自己", "是否自己发送"],
  type: ["type", "msgtype", "类型", "消息类型"],
};
// 微信消息类型：不是文字的换成占位，系统消息跳过
const WX_TYPES = { 1: "", 3: "[图片]", 34: "[语音]", 43: "[视频]", 47: "[表情包]", 48: "[位置]", 49: "[分享]", 50: "[通话]" };

function findCol(header, names) {
  const h = header.map((x) => x.trim().toLowerCase());
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function parseTimeCell(v) {
  const s = String(v || "").trim();
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const m = new RegExp(`${DATE}[ T]+${TIME}`).exec(s);
  return m ? toTs(m[1], m[2], m[3], m[4], m[5], m[6]) : NaN;
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return null;
  const header = rows[0];
  const ci = findCol(header, COLS.content);
  const ti = findCol(header, COLS.time);
  if (ci < 0 || ti < 0) return null;
  // 微信导出工具里 StrTime 是可读时间，CreateTime 是时间戳；两个都有时用可读的那个
  const ti2 = findCol(header, ["strtime"]);
  const nameCols = COLS.name.map((n) => findCol(header, [n])).filter((i) => i >= 0);
  const si = findCol(header, COLS.isSender);
  const ty = findCol(header, COLS.type);
  const out = [];
  let withSender = false;
  for (const r of rows.slice(1)) {
    const ts = parseTimeCell(r[ti2 >= 0 ? ti2 : ti]);
    if (!Number.isFinite(ts)) continue;
    let text = r[ci] || "";
    if (ty >= 0) {
      const code = Number(r[ty]);
      if (code === 10000 || code === 10002) continue; // 系统提示、撤回
      if (Object.prototype.hasOwnProperty.call(WX_TYPES, code) && WX_TYPES[code]) text = WX_TYPES[code];
      else if (!Object.prototype.hasOwnProperty.call(WX_TYPES, code) && code) text = /^\s*</.test(text) ? "[消息]" : text;
    }
    const mine = si >= 0 ? /^(1|true|是|yes)$/i.test(String(r[si]).trim()) : null;
    if (mine !== null) withSender = true;
    // 有「是不是自己发的」这一列时，自己发的统一叫「我」（这类导出里名字列常常写的是对方）
    const named = nameCols.map((i) => String(r[i] || "").trim()).find(Boolean);
    const name = mine ? "我" : named || (mine === false ? "对方" : "");
    const before = out.length;
    pushMsg(out, ts, name, text);
    if (out.length > before && mine !== null) out[out.length - 1].me = mine;
  }
  return { messages: out, meKnown: withSender };
}

// ---------- 入口 ----------

/**
 * 解析聊天记录文字。
 * @returns {{format:string, messages:{ts:number,name:string,text:string,me?:boolean}[], speakers:{name:string,count:number,me?:boolean}[], partner:string, meKnown:boolean}}
 */
function parseChat(text, { filename = "", now = Date.now() } = {}) {
  const src = String(text || "").replace(/^﻿/, "");
  const lines = src.split(/\r?\n/);
  let format = "";
  let messages = [];
  let meKnown = false;

  const firstLine = (lines.find((l) => l.trim()) || "").toLowerCase();
  if (/\.csv$/i.test(filename) || (firstLine.includes(",") && Object.values(COLS).flat().some((c) => firstLine.split(",").map((x) => x.trim().replace(/"/g, "")).includes(c)))) {
    const r = parseCsv(src);
    if (r && r.messages.length) {
      format = "csv";
      messages = r.messages;
      meKnown = r.meKnown;
    }
  }
  if (!messages.length) {
    // 看哪种写法的行最多
    let one = 0;
    let dateFirst = 0;
    let nameFirst = 0;
    for (const l of lines) {
      if (ONE_LINE.test(l)) one++;
      else if (HEAD_DATE_FIRST.test(l)) dateFirst++;
      else if (HEAD_NAME_FIRST.test(l)) nameFirst++;
    }
    const best = Math.max(one, dateFirst, nameFirst);
    if (best >= 2) {
      if (best === dateFirst) {
        format = "header";
        messages = parseHeaderLines(lines, HEAD_DATE_FIRST, "date");
      } else if (best === nameFirst) {
        format = "header-name-first";
        messages = parseHeaderLines(lines, HEAD_NAME_FIRST, "name");
      } else {
        format = "one-line";
        messages = parseOneLine(lines);
      }
    }
  }
  if (!messages.length) {
    messages = parsePlain(lines, now);
    if (messages.length) format = "plain";
  }
  messages.sort((a, b) => a.ts - b.ts);

  const counts = new Map();
  for (const m of messages) {
    const c = counts.get(m.name) || { name: m.name, count: 0 };
    c.count++;
    if (m.me !== undefined) c.me = m.me;
    counts.set(m.name, c);
  }
  const speakers = [...counts.values()].sort((a, b) => b.count - a.count);
  // QQ 导出文件开头的「消息对象:张三」就是聊天对象
  const pm = /^消息对象[:：]\s*(.+)$/m.exec(src);
  const partner = pm ? cleanName(pm[1]) : "";
  return { format, messages, speakers, partner, meKnown };
}

module.exports = { decodeBuffer, parseChat, parseCsvRows, cleanName };
