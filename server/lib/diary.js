"use strict";
/*
 * 它的日记和你们的时间线。
 *
 * 日记：每晚（默认 23:30 之后）把当天和主人的聊天交给「整理记忆」的模型，用它自己的口吻写一篇 300 字内的短日记，
 *   存在 data/diary.jsonl，只在网页「日记」页看。一天一次调用；当天聊得太少（不到 6 条）不写；
 *   服务当晚没开的话，下次启动补写最近 3 天。日记不进每轮的上下文（省钱）。
 * 纪念日：从第一次聊天算起的第 7、30、100、200……天、每年的这一天，以及记忆里记着的生日。
 *   当天它的第一句回复会收到提示，可以自然地提一句（见 brain.js 的 stateBlock）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, writeFileAtomic, ymd, pad, dayDiff } = require("./util");
const { styleOf } = require("./persona");
const { removeAiTone } = require("./humanize");
const { sampleLines } = require("./personas");

const MIN_MESSAGES = 6;
const BACKFILL_DAYS = 3;
const MAX_CHARS = 6000; // 一天的聊天最多交给模型这么多字（多了均匀抽样）
const DAY_MARKS = [7, 30, 100, 200, 300, 500, 1000];
const WEEK = "日一二三四五六";

/** 「11月5日 星期四」 */
function dayTitle(day) {
  const [y, m, d] = day.split("-").map(Number);
  return `${m}月${d}日 星期${WEEK[new Date(y, m - 1, d).getDay()]}`;
}

/** 生日：「5月20日」「5-20」「2000年5月20日」→ [月, 日] */
function parseBirthday(value) {
  const m = /(\d{1,2})\s*月\s*(\d{1,2})/.exec(String(value || "")) || /(?:^|\D)(\d{1,2})[-/.](\d{1,2})(?:\D|$)/.exec(String(value || ""));
  if (!m) return null;
  const month = Number(m[1]);
  const date = Number(m[2]);
  return month >= 1 && month <= 12 && date >= 1 && date <= 31 ? [month, date] : null;
}

/**
 * 某一天是不是纪念日。firstAt：第一次聊天的时间；birthday：[月, 日] 或 null
 * @returns {string} 给模型看的一句话；不是就返回空字符串
 */
function milestoneOn(day, firstAt, birthday, userCall = "对方") {
  const [y, m, d] = day.split("-").map(Number);
  const notes = [];
  if (firstAt) {
    const n = dayDiff(firstAt, day) + 1;
    const first = new Date(firstAt);
    if (DAY_MARKS.includes(n)) notes.push(`今天是你们认识的第 ${n} 天`);
    else if (n > 1 && first.getMonth() + 1 === m && first.getDate() === d) notes.push(`今天是你们认识 ${y - first.getFullYear()} 周年`);
  }
  if (birthday && birthday[0] === m && birthday[1] === d) notes.push(`今天是${userCall}的生日`);
  return notes.join("，");
}

/** 从 from 开始往后 days 天里的纪念日（网页时间线用） */
function upcoming(fromTs, firstAt, birthday, days = 400, userCall = "对方") {
  const out = [];
  const start = new Date(fromTs);
  for (let i = 0; i <= days && out.length < 5; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const day = ymd(date.getTime());
    const text = milestoneOn(day, firstAt, birthday, userCall);
    if (text) out.push({ day, inDays: i, text: text.replace(/^今天是/, "").replace(/，今天是/g, "，") });
  }
  return out;
}

function createDiary({ config, dataDir, memory, llm, log, now = Date.now }) {
  const file = path.join(dataDir, "diary.jsonl");
  let job = null;

  function readAll() {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const byDay = new Map();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.day && e.text) byDay.set(e.day, e); // 同一天写过两次的，留后写的
      } catch {
        /* 跳过坏行 */
      }
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  const has = (day) => readAll().some((e) => e.day === day);

  function messagesOf(day) {
    return memory.history("main", 4000).messages.filter((m) => ymd(m.ts) === day);
  }

  function cleanText(raw) {
    const lines = String(raw || "")
      .replace(/\r/g, "")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l)) // 模型自己加的标题整行不要
      .map((l) => l.replace(/^\s*[-*•]\s+/, "").replace(/\*\*/g, "").trim())
      .filter(Boolean);
    return removeAiTone(lines).join("\n").trim().slice(0, 800);
  }

  /** 写某一天的日记。force：消息少也写、写过也重写 */
  async function write(day, { force = false } = {}) {
    const msgs = messagesOf(day);
    if (!msgs.length) return { day, skipped: "这天没有聊天" };
    if (!force && msgs.length < MIN_MESSAGES) return { day, skipped: `这天只聊了 ${msgs.length} 条` };
    if (!force && has(day)) return { day, skipped: "已经写过了" };
    const f = config.friend;
    const call = f.userName || "对方";
    const lines = sampleLines(
      msgs.map((m) => {
        const d = new Date(m.ts);
        return `${pad(d.getHours())}:${pad(d.getMinutes())} ${m.role === "assistant" ? "我" : call}：${m.text.replace(/\n/g, " ")}`;
      }),
      MAX_CHARS
    );
    const who = [`你是「${f.name}」，和${call === "对方" ? "对方" : `「${call}」`}是${f.relationship || "好朋友"}。`, `你的性格：${styleOf(f.style).persona}`, f.customPrompt ? `补充设定：${f.customPrompt}` : "", `你每天睡前会写一小段日记，记下今天和${call}聊了什么、你心里怎么想。`]
      .filter(Boolean)
      .join("\n");
    const raw = await llm.chat(
      [
        { role: "system", content: who },
        {
          role: "user",
          content:
            `今天是${dayTitle(day)}。下面是你们今天的聊天（记录里的「我」就是你${lines.length < msgs.length ? "，内容太多只抽了一部分" : ""}）：\n${lines.join("\n")}\n\n` +
            "写今天的日记：用第一人称，像真人写给自己看的，300 字以内。写具体的事和你的感受，可以有小情绪、小吐槽、小期待；不要写成聊天总结，不要标题、列表和日期，不要编记录里没有的事。",
        },
      ],
      { use: "memory", temperature: 0.8, maxTokens: 1000 }
    );
    const text = cleanText(raw);
    if (!text) throw new Error("模型没写出日记");
    const entry = { day, text, count: msgs.length, at: now() };
    const others = readAll().filter((e) => e.day !== day);
    ensureDir(dataDir);
    writeFileAtomic(file, [...others, entry].sort((a, b) => (a.day < b.day ? -1 : 1)).map((e) => JSON.stringify(e)).join("\n") + "\n");
    log.info(`写好了 ${day} 的日记（${msgs.length} 条聊天 → ${text.length} 字）`);
    return { day, written: true, text };
  }

  /** 现在该写哪几天：今天（到点以后）和最近 3 天里没写的，聊得太少的跳过 */
  function due(t = now()) {
    const d = config.diary;
    if (!d || !d.enabled || !llm.enabled("memory")) return [];
    const done = new Set(readAll().map((e) => e.day));
    const days = [];
    const [hh, mm] = d.time.split(":").map(Number);
    const date = new Date(t);
    for (let back = BACKFILL_DAYS; back >= 0; back--) {
      const day = ymd(new Date(date.getFullYear(), date.getMonth(), date.getDate() - back).getTime());
      if (back === 0 && date.getHours() * 60 + date.getMinutes() < hh * 60 + mm) continue;
      if (!done.has(day) && messagesOf(day).length >= MIN_MESSAGES) days.push(day);
    }
    return days;
  }

  /** 后台写（定时和网页按钮都走这里，同一时间只写一份） */
  function start(days, { force = false } = {}) {
    if (job && job.running) return { already: true, promise: job.promise };
    const j = { running: true, progress: "", startedAt: now() };
    j.promise = (async () => {
      const results = [];
      for (const day of days) {
        j.progress = `写 ${dayTitle(day)} 的日记`;
        try {
          results.push(await write(day, { force }));
        } catch (e) {
          log.warn(`写 ${day} 的日记失败：` + (e.friendly || e.message));
          results.push({ day, error: e.friendly || e.message });
        }
      }
      return results;
    })().finally(() => {
      j.running = false;
      j.finishedAt = now();
    });
    j.promise.then((r) => (j.results = r));
    job = j;
    return { already: false, promise: j.promise };
  }

  function status() {
    if (!job) return { running: false };
    const r = job.results || [];
    const failed = r.find((x) => x.error);
    const skipped = r.find((x) => x.skipped);
    return { running: job.running, progress: job.progress, finishedAt: job.finishedAt || 0, error: failed ? failed.error : "", skipped: skipped ? skipped.skipped : "" };
  }

  /** 第一次聊天的时间：brain 记在状态里（压缩归档后也不变）；没记过就看聊天记录 */
  function firstAt(state) {
    return (state && state.firstAt) || memory.firstTs("main") || 0;
  }

  function birthdayOf() {
    const basics = memory.getProfile("main").basics;
    const key = Object.keys(basics).find((k) => /生日/.test(k));
    return key ? parseBirthday(basics[key].value) : null;
  }

  /** 网页时间线：认识第几天、聊了多少条、接下来的纪念日 */
  function timeline(state) {
    const t = now();
    const first = firstAt(state);
    const call = config.friend.userName || "你";
    return {
      firstAt: first,
      dayNo: first ? dayDiff(first, ymd(t)) + 1 : 0,
      messages: memory.history("main", 1).total,
      upcoming: first || birthdayOf() ? upcoming(t, first, birthdayOf(), 400, call) : [],
    };
  }

  /** 给 brain：今天是不是纪念日（只对主好友） */
  function todayNote(state, t = now()) {
    return milestoneOn(ymd(t), firstAt(state), birthdayOf(), config.friend.userName || "对方");
  }

  /** 网页列表：新的在前，带上「11月5日 星期四」 */
  const list = (limit = 60) => readAll().slice(0, limit).map((e) => ({ ...e, title: dayTitle(e.day) }));

  return { list, write, due, start, status, timeline, todayNote };
}

module.exports = { createDiary, milestoneOn, upcoming, parseBirthday, dayTitle };
