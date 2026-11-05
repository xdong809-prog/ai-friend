"use strict";
/*
 * 提醒：它答应了「明早 8 点叫你」，到点就真的发消息。
 *
 * 模型在回复里单独写一行就算记下了（解析在 humanize.parseOutput，登记在 brain.doReply）：
 *   〔提醒〕2026-11-06 08:00｜叫他起床
 *   〔提醒〕每天 11:00｜喝水         （也可以写 工作日 / 周末 / 每周一三）
 *   〔取消提醒〕喝水
 * 到点由 server.js 的 checkReminders 发送。存在 data/reminders.json，重启不丢。
 */
const path = require("node:path");
const { readJson, writeJsonAtomic, pad, fmtShort } = require("./util");

const WEEK = "日一二三四五六";
const MAX_ACTIVE = 100;
const KEEP_FINISHED_MS = 7 * 86400000; // 发过的、错过的在网页上留 7 天
const DATETIME = String.raw`\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s+\d{1,2}[:：]\d{2}`;
const REPEATED = String.raw`(?:每天|每日|工作日|周末|每周|每星期)[一二三四五六日天、，,\s]*?\s*\d{1,2}[:：]\d{2}`;
const RELATIVE = String.raw`\d+\s*(?:分钟|小时)后`;
const SPEC_THEN_TEXT = new RegExp(`^(${DATETIME}|${REPEATED}|${RELATIVE})\\s*[，,：:]?\\s*(.+)$`);

function hhmm(h, mi) {
  const hour = Number(h);
  const minute = Number(mi);
  return hour < 24 && minute < 60 ? `${pad(hour)}:${pad(minute)}` : "";
}

/**
 * 「2026-11-06 08:00」「每天 11:00」「工作日 8:30」「周末 10:00」「每周一三 20:00」「30分钟后」
 * → {at} 或 {repeat:{days,time}}；看不懂或时间已经过了返回 null
 */
function parseSpec(raw, t = Date.now()) {
  const s = String(raw || "").trim();
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2})[:：](\d{2})$/.exec(s);
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const date = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (date.getMonth() !== mo - 1 || date.getDate() !== d || !hhmm(h, mi)) return null;
    return date.getTime() > t ? { at: date.getTime(), repeat: null } : null;
  }
  m = /^(\d+)\s*(分钟|小时)后$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n > 0 ? { at: t + n * (m[2] === "分钟" ? 60000 : 3600000), repeat: null } : null;
  }
  m = /^(每天|每日|工作日|周末|每周|每星期)([一二三四五六日天、，,\s]*?)\s*(\d{1,2})[:：](\d{2})$/.exec(s);
  if (!m) return null;
  const time = hhmm(m[3], m[4]);
  if (!time) return null;
  let days;
  if (m[1] === "每天" || m[1] === "每日") days = [0, 1, 2, 3, 4, 5, 6];
  else if (m[1] === "工作日") days = [1, 2, 3, 4, 5];
  else if (m[1] === "周末") days = [0, 6];
  else days = [...new Set([...m[2].replace(/天/g, "日")].map((c) => WEEK.indexOf(c)).filter((i) => i >= 0))].sort();
  if (!days.length) return null;
  const repeat = { days, time };
  return { at: nextAt(repeat, t), repeat };
}

/** 重复提醒：after 之后的下一次 */
function nextAt(repeat, after) {
  const [h, mi] = repeat.time.split(":").map(Number);
  const d = new Date(after);
  for (let i = 0; i <= 7; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, mi, 0, 0);
    if (c.getTime() > after && repeat.days.includes(c.getDay())) return c.getTime();
  }
  return after + 86400000;
}

/** 重复提醒：t 之前（含 t）最近的一次 */
function lastAt(repeat, t) {
  const [h, mi] = repeat.time.split(":").map(Number);
  const d = new Date(t);
  for (let i = 0; i <= 7; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, h, mi, 0, 0);
    if (c.getTime() <= t && repeat.days.includes(c.getDay())) return c.getTime();
  }
  return 0;
}

/** 给人看的时间：「每天 11:00」「11月6日 08:00」 */
function whenText(r) {
  if (!r.repeat) return fmtShort(r.at);
  const { days, time } = r.repeat;
  const key = days.join("");
  if (key === "0123456") return `每天 ${time}`;
  if (key === "12345") return `工作日 ${time}`;
  if (key === "06") return `周末 ${time}`;
  return `每周${days.map((i) => WEEK[i]).join("")} ${time}`;
}

/** 〔提醒〕后面那段 → {spec, text}。分隔符写漏了也尽量认 */
function parseLine(line) {
  const s = String(line || "").trim();
  const m = /^(.+?)\s*[｜|]\s*(.+)$/.exec(s) || SPEC_THEN_TEXT.exec(s);
  return m ? { spec: m[1].trim(), text: m[2].trim() } : null;
}

function createReminders({ dataDir, log, now = Date.now }) {
  const file = path.join(dataDir, "reminders.json");
  const firing = new Set(); // 正在发的（模型可能要想十几秒，别被下一轮检查重复发）
  let list = load();

  function load() {
    const j = readJson(file, null);
    return j && Array.isArray(j.list) ? j.list : [];
  }
  function save() {
    const t = now();
    list = list.filter((r) => r.status === "active" || t - (r.finishedAt || 0) < KEEP_FINISHED_MS);
    writeJsonAtomic(file, { list });
  }
  const find = (id) => list.find((r) => r.id === String(id || ""));

  /** 全部（网页用）：还没到的按时间排，后面是发过的和错过的 */
  function all() {
    const rank = { active: 0, missed: 1, done: 2 };
    return list
      .slice()
      .sort((a, b) => rank[a.status] - rank[b.status] || (a.status === "active" ? a.at - b.at : (b.finishedAt || 0) - (a.finishedAt || 0)))
      .map((r) => ({ ...r, when: whenText(r) }));
  }
  const active = () => all().filter((r) => r.status === "active");

  /** 新增。时间看不懂或已经过了返回 null；一样的提醒不重复加 */
  function add({ spec, text }) {
    const t = now();
    const parsed = parseSpec(spec, t);
    const body = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!parsed || !body) return null;
    const same = list.find((r) => r.status === "active" && r.text === body && (parsed.repeat ? whenText(r) === whenText(parsed) : r.at === parsed.at));
    if (same) return { ...same };
    if (list.filter((r) => r.status === "active").length >= MAX_ACTIVE) return null;
    const r = { id: `${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: body, at: parsed.at, repeat: parsed.repeat, status: "active", createdAt: t, attempts: 0 };
    list.push(r);
    save();
    log.info(`记下提醒：${whenText(r)} ${r.text}`);
    return { ...r };
  }

  /** 模型写的一行〔提醒〕 */
  function addLine(line) {
    const p = parseLine(line);
    return p ? add(p) : null;
  }

  function remove(id) {
    const r = find(id);
    if (!r) return false;
    list = list.filter((x) => x !== r);
    save();
    return true;
  }

  /** 模型写的〔取消提醒〕关键词：内容互相包含的都取消；「全部」取消所有 */
  function cancel(keyword) {
    const kw = String(keyword || "").trim();
    if (!kw) return [];
    const hit = list.filter((r) => r.status === "active" && (/^(?:全部|所有)/.test(kw) || r.text.includes(kw) || kw.includes(r.text)));
    if (!hit.length) return [];
    list = list.filter((r) => !hit.includes(r));
    save();
    log.info(`取消了提醒：${hit.map((r) => r.text).join("、")}`);
    return hit;
  }

  /** 到点了、还没在发、也不在等重试的 */
  function due(t = now()) {
    return list.filter((r) => r.status === "active" && r.at <= t && !firing.has(r.id) && (!r.retryAt || r.retryAt <= t));
  }
  const begin = (id) => firing.add(id);
  const end = (id) => firing.delete(id);

  /** 发出去了：一次性的结束，重复的排下一次 */
  function markFired(id, t = now()) {
    const r = find(id);
    if (!r) return;
    r.attempts = 0;
    delete r.retryAt;
    if (r.repeat) r.at = nextAt(r.repeat, t);
    else {
      r.status = "done";
      r.finishedAt = t;
    }
    save();
  }

  /** 一次性提醒过了太久才发现（比如电脑关着）：不发了，网页上标「错过了」 */
  function markMissed(id, t = now()) {
    const r = find(id);
    if (!r) return;
    r.status = "missed";
    r.finishedAt = t;
    save();
    log.warn(`错过了提醒：${whenText(r)} ${r.text}`);
  }

  /** 重复提醒错过了（不补了）：直接排下一次 */
  function reschedule(id, t = now()) {
    const r = find(id);
    if (!r || !r.repeat) return;
    r.at = nextAt(r.repeat, t);
    r.attempts = 0;
    delete r.retryAt;
    save();
  }

  /** 发送失败：等一会儿再试（1、2、4…分钟，最多 5 分钟） */
  function markFailed(id, t = now()) {
    const r = find(id);
    if (!r) return;
    r.attempts = (r.attempts || 0) + 1;
    r.retryAt = t + Math.min(300000, 60000 * 2 ** (r.attempts - 1));
    save();
  }

  /** 每轮告诉模型：现在答应了哪些提醒 */
  function block() {
    const rows = active().slice(0, 20).map((r) => `- ${r.when} ${r.text}`);
    return rows.length ? `【你答应要提醒对方的事】（系统到点会让你发，不用你记时间）\n${rows.join("\n")}` : "";
  }

  return { all, active, add, addLine, remove, cancel, due, begin, end, markFired, markMissed, reschedule, markFailed, block };
}

module.exports = { createReminders, parseSpec, parseLine, nextAt, lastAt, whenText };
