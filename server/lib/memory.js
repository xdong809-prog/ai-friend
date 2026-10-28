"use strict";
/*
 * 记忆系统。三层，保证「聊过的东西不会掉进缝里」：
 *   1) 近期原文：摘要之后的所有消息都原样进上下文（有条数和字数上限）；
 *   2) 滚动摘要：近期原文太多时，把最早的一段压缩进摘要，并记下压到了哪一条（summarizedUpTo）；
 *   3) 长期记忆：大模型从聊天里整理出的档案（单值信息会被新说法覆盖）、事实、带日期的安排。
 * 另外按关键词从更早的聊天里捞几条相关片段，作为参考。
 *
 * 磁盘结构（data/）：
 *   sessions/<会话>.jsonl   每行 {seq, role:"user"|"assistant", text, ts, name?}
 *   profiles/<会话>.json    {basics, facts, events, summary, summarizedUpTo, extractedUpTo, updatedAt}
 *   archive/<会话>-<时间>.jsonl.gz   「压缩」时打包归档的旧聊天原文（可以恢复）
 */
const fs = require("node:fs");
const zlib = require("node:zlib");
const path = require("node:path");
const { ensureDir, readJson, writeJsonAtomic, safeName, ymd, fmtShort, dayDiff, createKeyedLock } = require("./util");
const { parseJsonLoose } = require("./llm");

const MAX_CACHE = 4000;
const MAX_FACTS = 80;
const MAX_BASICS = 24;
const MAX_EVENTS = 40;

function norm(s) {
  return String(s || "").toLowerCase().replace(/[\s，。,.!！?？、~～"'“”‘’：:；;（）()【】\[\]-]/g, "");
}

function bigrams(s) {
  const t = norm(s);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const A = bigrams(x);
  const B = bigrams(y);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.7;
}

function emptyProfile() {
  return { version: 2, basics: {}, facts: [], events: [], summary: "", summarizedUpTo: 0, extractedUpTo: 0, updatedAt: 0 };
}

function createMemory({ dataDir, config, log, now = Date.now }) {
  const sessDir = path.join(dataDir, "sessions");
  const profDir = path.join(dataDir, "profiles");
  const archDir = path.join(dataDir, "archive");
  ensureDir(sessDir);
  ensureDir(profDir);
  const cache = new Map();
  const jobLock = createKeyedLock();

  const sessFile = (id) => path.join(sessDir, safeName(id) + ".jsonl");
  const profFile = (id) => path.join(profDir, safeName(id) + ".json");

  // ---------- 聊天记录 ----------

  function load(id) {
    if (cache.has(id)) return cache.get(id);
    const list = [];
    let text = "";
    try {
      text = fs.readFileSync(sessFile(id), "utf8");
    } catch {
      /* 新会话 */
    }
    let seq = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (!o || typeof o.text !== "string") continue;
        seq = Number.isFinite(o.seq) && o.seq > seq ? o.seq : seq + 1;
        const msg = { seq, role: o.role === "assistant" ? "assistant" : "user", text: o.text, ts: Number(o.ts) || 0 };
        if (o.name) msg.name = o.name;
        if (o.thought) msg.thought = o.thought;
        if (o.mood) msg.mood = o.mood;
        list.push(msg);
      } catch {
        /* 跳过坏行 */
      }
    }
    const entry = { list: list.slice(-MAX_CACHE), lastSeq: seq, total: list.length };
    cache.set(id, entry);
    return entry;
  }

  function append(id, { role, text, ts, name, thought, mood }) {
    const entry = load(id);
    const msg = { seq: entry.lastSeq + 1, role: role === "assistant" ? "assistant" : "user", text: String(text).slice(0, 4000), ts: ts || now() };
    if (name) msg.name = String(name).slice(0, 30);
    if (thought) msg.thought = String(thought).slice(0, 120);
    if (mood) msg.mood = String(mood).slice(0, 6);
    entry.lastSeq = msg.seq;
    entry.total++;
    entry.list.push(msg);
    if (entry.list.length > MAX_CACHE) entry.list.splice(0, entry.list.length - MAX_CACHE);
    ensureDir(sessDir);
    fs.appendFileSync(sessFile(id), JSON.stringify(msg) + "\n", "utf8");
    return msg;
  }

  function history(id, limit = 100) {
    const entry = load(id);
    return { messages: entry.list.slice(-limit), total: entry.total };
  }

  /** 清空聊天记录：不真删，改名成 .bak-时间 备份 */
  function clearHistory(id) {
    const file = sessFile(id);
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.bak-${now()}`);
    cache.delete(id);
    const p = getProfile(id);
    p.summarizedUpTo = 0;
    p.extractedUpTo = 0;
    p.summary = "";
    saveProfile(id, p);
  }

  // ---------- 档案 ----------

  function getProfile(id) {
    const p = readJson(profFile(id), null);
    if (!p || typeof p !== "object") return emptyProfile();
    const out = { ...emptyProfile(), ...p };
    if (!out.basics || typeof out.basics !== "object" || Array.isArray(out.basics)) out.basics = {};
    if (!Array.isArray(out.facts)) out.facts = [];
    if (!Array.isArray(out.events)) out.events = [];
    out.facts = out.facts.map((f) => (typeof f === "string" ? { text: f, at: 0 } : f)).filter((f) => f && f.text);
    return out;
  }

  function saveProfile(id, p) {
    p.updatedAt = now();
    writeJsonAtomic(profFile(id), p);
  }

  /** 应用一组记忆改动（大模型整理的结果、网页手动编辑、「记住/忘掉」指令都走这里） */
  function applyOps(id, ops) {
    if (!ops || typeof ops !== "object") return { changed: false };
    const p = getProfile(id);
    const t = now();
    let changed = false;
    const log2 = [];

    if (ops.set && typeof ops.set === "object") {
      for (const [k0, v0] of Object.entries(ops.set)) {
        const k = String(k0).trim().slice(0, 10);
        if (!k) continue;
        const v = v0 === null || v0 === undefined ? "" : String(v0).trim().slice(0, 60);
        if (!v) {
          if (p.basics[k]) {
            delete p.basics[k];
            changed = true;
          }
          continue;
        }
        if (!p.basics[k] || p.basics[k].value !== v) {
          if (p.basics[k]) log2.push(`${k}：${p.basics[k].value} → ${v}`);
          p.basics[k] = { value: v, at: t };
          changed = true;
        }
      }
      const keys = Object.keys(p.basics);
      if (keys.length > MAX_BASICS) {
        keys.sort((a, b) => p.basics[a].at - p.basics[b].at).slice(0, keys.length - MAX_BASICS).forEach((k) => delete p.basics[k]);
      }
    }

    const removeList = Array.isArray(ops.remove) ? ops.remove.map(String).filter(Boolean) : [];
    if (removeList.length) {
      const before = p.facts.length;
      p.facts = p.facts.filter((f) => !removeList.some((r) => similar(f.text, r)));
      for (const r of removeList) {
        for (const k of Object.keys(p.basics)) {
          if (similar(k, r) || similar(`${k}${p.basics[k].value}`, r) || similar(p.basics[k].value, r)) {
            delete p.basics[k];
            changed = true;
          }
        }
      }
      if (p.facts.length !== before) changed = true;
    }

    if (Array.isArray(ops.add)) {
      for (const raw of ops.add) {
        const text = String(raw || "").trim().slice(0, 80);
        if (text.length < 2) continue;
        const i = p.facts.findIndex((f) => similar(f.text, text));
        if (i >= 0) {
          // 新说法更完整就替换，并移到最后（越靠后越新）
          const old = p.facts.splice(i, 1)[0];
          p.facts.push({ text: text.length >= old.text.length ? text : old.text, at: t });
        } else {
          p.facts.push({ text, at: t });
        }
        changed = true;
      }
      if (p.facts.length > MAX_FACTS) p.facts = p.facts.slice(-MAX_FACTS);
    }

    if (Array.isArray(ops.events)) {
      for (const e of ops.events) {
        const text = String((e && e.text) || "").trim().slice(0, 60);
        if (!text) continue;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || "")) ? e.date : "";
        const hit = p.events.find((x) => similar(x.text, text) && (!date || !x.date || x.date === date));
        if (hit) {
          if (date) hit.date = date;
          hit.text = text;
        } else {
          p.events.push({ id: Math.random().toString(36).slice(2, 10), text, date, at: t, done: false });
        }
        changed = true;
      }
    }
    if (Array.isArray(ops.done_events)) {
      for (const d of ops.done_events) {
        for (const e of p.events) if (!e.done && similar(e.text, d)) {
          e.done = true;
          changed = true;
        }
      }
    }
    if (Array.isArray(ops.removeEvents)) {
      const before = p.events.length;
      p.events = p.events.filter((e) => !ops.removeEvents.includes(e.id));
      if (p.events.length !== before) changed = true;
    }
    // 过期太久的安排清掉：完成的留 7 天，没完成的过期 30 天
    p.events = p.events
      .filter((e) => {
        if (!e.date) return now() - e.at < 60 * 86400000;
        const diff = dayDiff(now(), e.date);
        return e.done ? diff > -7 : diff > -30;
      })
      .slice(-MAX_EVENTS);
    if (typeof ops.summary === "string") {
      p.summary = ops.summary.slice(0, 1500);
      changed = true;
    }
    if (changed) saveProfile(id, p);
    if (log2.length) log.info("记忆更新：" + log2.join("；"));
    return { changed, profile: p };
  }

  // ---------- 按记忆主动关心 ----------

  /**
   * 现在适合主动关心的安排（每个安排最多两次：前一晚说句加油，当天晚上 / 第二天问结果）。
   * @returns {{event:object, stage:"before"|"after", note:string}|null}
   */
  function dueFollowUp(id, t = now()) {
    const p = getProfile(id);
    const h = new Date(t).getHours();
    for (const e of p.events) {
      if (!e.date || e.done) continue;
      const f = e.followed || {};
      const diff = dayDiff(t, e.date);
      if (diff === 1 && h >= 20 && !f.before && !f.after) {
        return { event: e, stage: "before", note: `对方明天（${e.date.slice(5).replace("-", "月")}日）有安排：「${e.text}」。现在是前一天晚上，你主动发消息，像朋友那样随口关心一句或者给他打打气。1~2 条，别像提醒事项，别说「记得」「别忘了」。` };
      }
      if (((diff === 0 && h >= 19) || diff === -1 || (diff === -2 && h < 14)) && !f.after) {
        const when = diff === 0 ? "今天" : diff === -1 ? "昨天" : "前天";
        return { event: e, stage: "after", note: `对方${when}有安排：「${e.text}」，你还不知道结果。现在你主动发消息问问怎么样了，像朋友那样自然，可以带点你自己的情绪（好奇、替他紧张……）。1~2 条，别一次问好几个问题。` };
      }
    }
    return null;
  }

  function markFollowUp(id, eventId, stage, t = now()) {
    const p = getProfile(id);
    const e = p.events.find((x) => x.id === eventId);
    if (!e) return false;
    e.followed = { ...(e.followed || {}), [stage]: t };
    saveProfile(id, p);
    return true;
  }

  // ---------- 给模型看的内容 ----------

  function memoryBlock(id, userCall) {
    const p = getProfile(id);
    const lines = [];
    const basics = Object.entries(p.basics).map(([k, v]) => `${k}：${v.value}`);
    if (basics.length) lines.push("基本信息：" + basics.join("；"));
    if (p.facts.length) {
      lines.push("其他：");
      for (const f of p.facts.slice(-40)) lines.push(`- ${f.text}${f.at ? `（${fmtShort(f.at).split(" ")[0]}）` : ""}`);
    }
    const ev = eventsBlock(p);
    if (!lines.length && !ev) return "";
    const head = `【你记得的关于${userCall}的事】（括号里是什么时候知道的；越新越准）`;
    return [lines.length ? head + "\n" + lines.join("\n") : "", ev].filter(Boolean).join("\n\n");
  }

  function eventsBlock(p) {
    const t = now();
    const rows = [];
    for (const e of p.events) {
      if (!e.date) {
        if (!e.done) rows.push(`- （日期不确定）${e.text}`);
        continue;
      }
      const diff = dayDiff(t, e.date);
      const [, m, d] = e.date.split("-").map(Number);
      const when = diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : diff === -1 ? "昨天" : diff > 0 ? `还有 ${diff} 天` : `${-diff} 天前`;
      const asked = e.followed && e.followed.after ? "（你已经主动问过结果了，别再追问，等他自己说）" : "";
      if (diff >= 0 && diff <= 14) rows.push(`- ${m}月${d}日（${when}）：${e.text}${e.done ? "（已聊过）" : asked}`);
      else if (diff < 0 && diff >= -5 && !e.done) rows.push(`- ${m}月${d}日（${when}，已经过了）：${e.text}${asked || " —— 还不知道结果，合适的时候可以问问"}`);
    }
    if (!rows.length) return "";
    return "【对方近期的安排】（合适的时候自然地关心一下，别生硬）\n" + rows.join("\n");
  }

  /** 摘要之后的近期原文，按条数和字数截取（从新往旧取） */
  function recent(id) {
    const { chat } = config;
    const p = getProfile(id);
    const entry = load(id);
    const pending = entry.list.filter((m) => m.seq > p.summarizedUpTo);
    const out = [];
    let chars = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      const m = pending[i];
      chars += m.text.length + 12;
      if (out.length >= chat.historyMessages || (out.length > 4 && chars > chat.historyChars)) break;
      out.unshift(m);
    }
    return { messages: out, summary: p.summary, profile: p };
  }

  /** 从更早的聊天里按关键词找相关片段（问题 + 当时的回答） */
  function relevant(id, text, beforeSeq, limit = config.chat.relevantSnippets) {
    if (!limit) return [];
    const q = bigrams(text);
    if (q.size < 2) return [];
    const list = load(id).list;
    const scored = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.seq >= beforeSeq || m.role !== "user" || m.text.length < 4) continue;
      const g = bigrams(m.text);
      let s = 0;
      for (const x of q) if (g.has(x)) s++;
      if (s >= 2) scored.push({ i, s: s + Math.min(2, m.text.length / 40) });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).sort((a, b) => a.i - b.i).map(({ i }) => {
      const u = list[i];
      const a = list[i + 1] && list[i + 1].role === "assistant" ? list[i + 1] : null;
      return { ts: u.ts, user: u.text.slice(0, 120), reply: a ? a.text.slice(0, 120) : "" };
    });
  }

  // ---------- 后台整理：摘要与记忆抽取 ----------

  function formatForLLM(msgs, selfName, userCall) {
    return msgs
      .map((m) => `[${fmtShort(m.ts)}] ${m.role === "assistant" ? selfName : m.name || userCall}：${m.text}`)
      .join("\n");
  }

  /** 近期原文太长时，把最早的一段压进摘要 */
  function maybeSummarize(id, llm) {
    return jobLock(id + ":summary", async () => {
      const { chat, friend } = config;
      const p = getProfile(id);
      const pending = load(id).list.filter((m) => m.seq > p.summarizedUpTo);
      if (pending.length <= chat.summaryTrigger || !llm.enabled("memory")) return false;
      const chunk = pending.slice(0, pending.length - chat.keepRecent);
      if (!chunk.length) return false;
      const summary = await summarizeChunk(p.summary, chunk, llm);
      if (!summary) return false;
      const fresh = getProfile(id); // 重新读，避免覆盖期间别的改动
      fresh.summary = summary;
      fresh.summarizedUpTo = chunk[chunk.length - 1].seq;
      saveProfile(id, fresh);
      log.info(`聊天摘要已更新（压缩了 ${chunk.length} 条，剩 ${pending.length - chunk.length} 条原文）`);
      return true;
    });
  }

  /** 把一段聊天合并进已有摘要，返回新摘要 */
  async function summarizeChunk(oldSummary, chunk, llm) {
      const { friend } = config;
      const userCall = friend.userName || "对方";
      const prompt = [
        { role: "system", content: `你在帮「${friend.name}」整理和${userCall}的聊天笔记。用「我」指${friend.name}，用「${userCall === "对方" ? "对方" : userCall}」指聊天对象。` },
        {
          role: "user",
          content:
            `已有的摘要：\n${oldSummary || "（暂无）"}\n\n新的一段聊天：\n${formatForLLM(chunk, friend.name, userCall)}\n\n` +
            "请把新聊天合并进摘要，输出一段新的完整摘要（不超过 500 字，纯文本，不要标题和列表符号）。要保留：聊过的主要话题和结论、对方的情绪变化、还没聊完或没解决的事、我答应过对方的事、我们之间的梗和称呼、对方的说话习惯和雷区（比如讨厌我怎么说话）、我们现在的关系状态、具体时间（写成几月几日）。可以删掉已经不重要的寒暄。",
        },
      ];
      const text = await llm.chat(prompt, { use: "memory", temperature: 0.3, maxTokens: 1200 });
      return String(text).replace(/\s+\n/g, "\n").trim().slice(0, 1500);
  }

  /** 每隔几条用户消息，让大模型从新聊天里整理长期记忆 */
  function maybeExtract(id, llm, { force = false } = {}) {
    return jobLock(id + ":extract", async () => {
      const { chat, friend } = config;
      const p = getProfile(id);
      const fresh = load(id).list.filter((m) => m.seq > p.extractedUpTo);
      const userCount = fresh.filter((m) => m.role === "user").length;
      if (!llm.enabled("memory") || !userCount || (!force && userCount < chat.extractEvery)) return false;
      return extractSlice(id, llm, fresh.slice(-40));
    });
  }

  /** 让大模型从一段聊天里整理长期记忆，并记下整理到了哪一条 */
  async function extractSlice(id, llm, slice) {
      const { friend } = config;
      const p = getProfile(id);
      const userCall = friend.userName || "对方";
      const current = {
        basics: Object.fromEntries(Object.entries(p.basics).map(([k, v]) => [k, v.value])),
        facts: p.facts.map((f) => f.text),
        events: p.events.filter((e) => !e.done).map((e) => ({ date: e.date, text: e.text })),
      };
      const today = ymd(now());
      const sys = `你是一个细心的记忆整理助手，帮「${friend.name}」记住关于聊天对象（下面称「对方」）的事。只输出 JSON。`;
      const user = `今天是 ${today}（星期${"日一二三四五六"[new Date(now()).getDay()]}）。

【目前的记忆】
${JSON.stringify(current, null, 0)}

【新的聊天】
${formatForLLM(slice, friend.name, userCall)}

请根据新的聊天更新记忆，输出 JSON：
{"set":{"名字":"…"},"add":["…"],"remove":["…"],"events":[{"date":"YYYY-MM-DD","text":"…"}],"done_events":["…"]}

规则：
1. 只记关于「对方」本人、以后聊天用得上的信息：称呼、所在地、工作/学校、家人朋友宠物、喜欢和讨厌的东西、习惯、正在做的事和目标、重要经历、长期的烦恼。不记寒暄、一次性的小事、玩笑和假设、${friend.name}自己说的话。
2. 只有一个答案的信息（名字、昵称、城市、职业、学校、生日、年龄、感情状态等）放 set，键用简短中文；新说法会覆盖旧的。
3. 有时间的安排、计划、重要日子放 events，把「明天」「周五」「下个月3号」换算成具体日期；没有明确日期的 date 填 ""。已经发生并聊过结果的安排放 done_events（写原文）。
4. 和新信息矛盾或已经不成立的旧事实，原文放进 remove（比如以前说住北京、现在说搬到杭州了）。
5. add 里每条用简短中文、从第三人称写，例如「养了一只叫团子的橘猫」；已经记过的不要重复。
6. 没有值得记的就输出 {}。`;
      const raw = await llm.chat(
        [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        { use: "memory", temperature: 0.1, maxTokens: 1200, json: true }
      );
      const ops = parseJsonLoose(raw);
      const last = slice[slice.length - 1].seq;
      if (ops) applyOps(id, ops);
      const p2 = getProfile(id);
      p2.extractedUpTo = last;
      saveProfile(id, p2);
      if (!ops) log.warn("记忆整理：模型输出不是 JSON，这次跳过");
      return Boolean(ops);
  }

  // ---------- 压缩：保留大底记忆，压缩聊天原文，减少每轮发给模型的内容和占用 ----------

  const archiveFiles = (id) => {
    try {
      const prefix = safeName(id) + "-";
      return fs
        .readdirSync(archDir)
        .filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl.gz"))
        .sort()
        .map((n) => ({ name: n, bytes: fs.statSync(path.join(archDir, n)).size }));
    } catch {
      return [];
    }
  };

  /** 现在的占用情况（压缩前后对比用） */
  function stats(id) {
    const p = getProfile(id);
    const entry = load(id);
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(sessFile(id)).size;
    } catch {
      /* 还没有记录 */
    }
    const r = recent(id);
    const recentChars = r.messages.reduce((n, m) => n + m.text.length + (m.thought ? m.thought.length + 10 : 0), 0);
    const memChars = memoryBlock(id, config.friend.userName || "对方").length;
    const cut = Math.min(p.summarizedUpTo, p.extractedUpTo);
    const archives = archiveFiles(id);
    return {
      messages: entry.list.length,
      fileBytes,
      unsummarized: entry.list.filter((m) => m.seq > p.summarizedUpTo).length,
      unextracted: entry.list.filter((m) => m.seq > p.extractedUpTo).length,
      archivable: entry.list.filter((m) => m.seq <= cut).length,
      recentMessages: r.messages.length,
      summaryChars: (p.summary || "").length,
      facts: p.facts.length,
      basics: Object.keys(p.basics).length,
      contextChars: recentChars + (p.summary || "").length + memChars,
      archives: archives.length,
      archiveBytes: archives.reduce((n, a) => n + a.bytes, 0),
    };
  }

  function backupProfile(id) {
    try {
      fs.copyFileSync(profFile(id), `${profFile(id)}.bak-${now()}`);
    } catch {
      /* 还没有档案 */
    }
  }

  /** 让大模型把摘要压紧、把重复或过时的事实合并（只在结果看起来靠谱时才采用） */
  async function tidyProfile(id, llm) {
    const { friend } = config;
    const p = getProfile(id);
    if (!p.summary && p.facts.length < 6) return { summary: false, facts: false };
    const userCall = friend.userName || "对方";
    const raw = await llm.chat(
      [
        { role: "system", content: `你在帮「${friend.name}」把关于${userCall}的记忆整理得更精炼。只输出 JSON。` },
        {
          role: "user",
          content:
            `【聊天摘要】\n${p.summary || "（暂无）"}\n\n【记得的事】\n${JSON.stringify(p.facts.map((f) => f.text))}\n\n` +
            '请输出 {"summary":"…","facts":["…"]}：\n' +
            "1. summary：把摘要压缩到 350 字以内，用「我」指" + friend.name + "。必须保留：我们的关系和约定、称呼和梗、对方的性格和雷区、重要经历、还没聊完的事、具体日期。删掉寒暄和已经不重要的细节。\n" +
            "2. facts：把记得的事去重、合并意思相同的、删掉明显过时或被新说法推翻的；每条简短、第三人称；重要的一条都不能丢。",
        },
      ],
      { use: "memory", temperature: 0.2, maxTokens: 1600, json: true }
    );
    const j = parseJsonLoose(raw) || {};
    const fresh = getProfile(id);
    const done = { summary: false, facts: false };
    const sum = typeof j.summary === "string" ? j.summary.replace(/\s+\n/g, "\n").trim() : "";
    if (sum && (sum.length >= 60 || !fresh.summary) && sum.length < (fresh.summary || "").length) {
      fresh.summary = sum.slice(0, 1500);
      done.summary = true;
    }
    if (Array.isArray(j.facts)) {
      const list = [...new Set(j.facts.map((x) => String(x || "").trim().slice(0, 80)).filter((x) => x.length >= 2))];
      // 合并后至少还剩原来的一半，才认为没有丢东西
      if (list.length && list.length <= fresh.facts.length && list.length >= Math.ceil(fresh.facts.length / 2)) {
        fresh.facts = list.map((text) => {
          const old = fresh.facts.find((f) => f.text === text) || fresh.facts.find((f) => similar(f.text, text));
          return { text, at: old ? old.at : now() };
        });
        done.facts = true;
      }
    }
    if (done.summary || done.facts) saveProfile(id, fresh);
    return done;
  }

  /** 把已经压进摘要、也整理过记忆的旧原文打包成 .gz，从聊天记录里拿走（同步完成，不会和新消息写入交错） */
  function archiveOld(id) {
    const p = getProfile(id);
    const cut = Math.min(p.summarizedUpTo, p.extractedUpTo);
    if (!cut) return 0;
    const file = sessFile(id);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return 0;
    }
    const old = [];
    const keep = [];
    let seq = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || typeof o.text !== "string") continue;
      seq = Number.isFinite(o.seq) && o.seq > seq ? o.seq : seq + 1;
      const out = JSON.stringify({ ...o, seq }); // 写明序号，归档后编号也不会乱
      (seq <= cut ? old : keep).push(out);
    }
    if (!old.length) return 0;
    ensureDir(archDir);
    const t = now();
    fs.writeFileSync(path.join(archDir, `${safeName(id)}-${t}.jsonl.gz`), zlib.gzipSync(old.join("\n") + "\n"));
    const tmp = `${file}.tmp-${t}`;
    fs.writeFileSync(tmp, keep.length ? keep.join("\n") + "\n" : "", "utf8");
    fs.renameSync(tmp, file);
    cache.delete(id);
    return old.length;
  }

  /** 把归档的原文放回聊天记录（按序号合并，不会重复） */
  function restoreArchives(id) {
    const files = archiveFiles(id);
    if (!files.length) return 0;
    const byseq = new Map();
    for (const f of files) {
      const text = zlib.gunzipSync(fs.readFileSync(path.join(archDir, f.name))).toString("utf8");
      for (const line of text.split("\n")) {
        try {
          const o = JSON.parse(line);
          if (o && Number.isFinite(o.seq)) byseq.set(o.seq, line);
        } catch {
          /* 空行 */
        }
      }
    }
    const file = sessFile(id);
    let cur = "";
    try {
      cur = fs.readFileSync(file, "utf8");
    } catch {
      /* 没有 */
    }
    let count = 0;
    for (const line of cur.split("\n")) {
      try {
        const o = JSON.parse(line);
        if (o && Number.isFinite(o.seq)) byseq.set(o.seq, line);
      } catch {
        /* 空行 */
      }
    }
    const lines = [...byseq.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const tmp = `${file}.tmp-${now()}`;
    fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
    for (const f of files) {
      fs.renameSync(path.join(archDir, f.name), path.join(archDir, f.name + ".restored"));
      count++;
    }
    cache.delete(id);
    log.info(`已把 ${count} 个归档恢复回聊天记录`);
    return count;
  }

  /**
   * 一键压缩（用户自己点了才做）：
   *   1. 还没整理进长期记忆的聊天，全部整理一遍 —— 大底记忆不会丢；
   *   2. 除了最近 keepRecent 条，其余聊天全部压进摘要 —— 每轮发给模型的内容变少；
   *   3. （tidy）把摘要压紧、合并重复的记忆；
   *   4. （archive）把已经压缩过的旧原文打包成 .gz 归档 —— 占用变小，随时可以恢复。
   * 改动前会先备份记忆档案（profiles/*.json.bak-时间）。
   */
  function compress(id, llm, { keepRecent = 10, tidy = true, archive = true, onProgress = () => {} } = {}) {
    return jobLock(id + ":compress", async () => {
      if (!llm.enabled("memory")) throw Object.assign(new Error("还没有可用的大模型，压缩要靠大模型写摘要"), { friendly: "还没有可用的大模型，压缩要靠大模型写摘要" });
      const before = stats(id);
      backupProfile(id);
      const steps = [];

      // 1. 整理长期记忆
      await jobLock(id + ":extract", async () => {
        let rounds = 0;
        for (;;) {
          const p = getProfile(id);
          const rest = load(id).list.filter((m) => m.seq > p.extractedUpTo);
          if (!rest.some((m) => m.role === "user") || rounds >= 30) break;
          onProgress(`整理长期记忆（还剩 ${rest.length} 条）`);
          await extractSlice(id, llm, rest.slice(0, 40));
          rounds++;
        }
        if (rounds) steps.push(`整理了 ${rounds} 批聊天进长期记忆`);
      });

      // 2. 压进摘要
      await jobLock(id + ":summary", async () => {
        let folded = 0;
        for (let rounds = 0; rounds < 30; rounds++) {
          const p = getProfile(id);
          const pending = load(id).list.filter((m) => m.seq > p.summarizedUpTo);
          const chunk = pending.slice(0, Math.max(0, pending.length - keepRecent)).slice(0, 80);
          if (!chunk.length) break;
          onProgress(`压缩聊天原文（还剩 ${pending.length - keepRecent} 条）`);
          const summary = await summarizeChunk(p.summary, chunk, llm);
          if (!summary) break;
          const fresh = getProfile(id);
          fresh.summary = summary;
          fresh.summarizedUpTo = chunk[chunk.length - 1].seq;
          saveProfile(id, fresh);
          folded += chunk.length;
        }
        if (folded) steps.push(`把 ${folded} 条聊天原文压进了摘要`);
      });

      // 3. 精炼
      if (tidy) {
        onProgress("精炼摘要和记忆");
        try {
          const d = await tidyProfile(id, llm);
          if (d.summary) steps.push("摘要压得更紧了");
          if (d.facts) steps.push("合并了重复的记忆");
        } catch (e) {
          log.warn("精炼记忆失败（不影响压缩结果）：" + (e.friendly || e.message));
        }
      }

      // 4. 归档
      let archived = 0;
      if (archive) {
        archived = archiveOld(id);
        if (archived) steps.push(`${archived} 条旧原文打包归档了`);
      }
      const after = stats(id);
      log.info(`压缩完成：每轮发给模型的内容 ${before.contextChars} → ${after.contextChars} 字；${steps.join("；") || "没有需要压缩的"}`);
      return { before, after, archived, steps };
    });
  }

  // ---------- 「记住 / 忘掉」指令（不用模型，立刻生效） ----------

  function handleCommand(id, text) {
    const t = String(text).trim();
    let m = t.match(/^(?:请)?(?:帮我)?(?:记住|记一下|记好)(?:了)?[:：，, ]\s*(.{2,80})$/);
    if (m) {
      applyOps(id, { add: [m[1].replace(/[。！!]+$/, "")] });
      return `对方让你记住「${m[1]}」，你已经记下了。自然地回应一句就行，不要复述成清单。`;
    }
    m = t.match(/^(?:请)?(?:帮我)?(?:忘掉|忘了|别记|删掉记忆|不要记)(?:住)?[:：，, ]?\s*(.{1,80})$/);
    if (m && !/^(吧|吗|啊|了)$/.test(m[1])) {
      const target = m[1].replace(/[。！!]+$/, "");
      const p = getProfile(id);
      const hit = p.facts.filter((f) => similar(f.text, target)).length + Object.keys(p.basics).filter((k) => similar(k, target) || similar(p.basics[k].value, target)).length;
      applyOps(id, { remove: [target] });
      return hit ? `对方让你忘掉「${target}」，相关记忆已经删掉了。` : `对方让你忘掉「${target}」，但你本来就没记这件事。`;
    }
    return "";
  }

  /** 没有大模型时的简单规则抽取（兜底，只抓最确定的几种） */
  function ruleExtract(id, text) {
    const t = String(text);
    if (/[?？吗]/.test(t)) return;
    const set = {};
    let m = t.match(/我(?:叫|的名字是|名字叫)([一-龥A-Za-z]{1,8})(?=$|[，,。！!\s])/);
    if (m) set["名字"] = m[1];
    m = t.match(/我(?:住在|家在|在)([一-龥]{2,6}?)(?:上班|工作|读书|上学|生活)/);
    if (m) set["所在地"] = m[1];
    if (Object.keys(set).length) applyOps(id, { set });
  }

  function listSessions() {
    try {
      return fs
        .readdirSync(sessDir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.slice(0, -6));
    } catch {
      return [];
    }
  }

  return {
    append,
    history,
    clearHistory,
    getProfile,
    applyOps,
    memoryBlock,
    recent,
    relevant,
    maybeSummarize,
    maybeExtract,
    compress,
    stats,
    restoreArchives,
    dueFollowUp,
    markFollowUp,
    handleCommand,
    ruleExtract,
    listSessions,
    lastSeq: (id) => load(id).lastSeq,
  };
}

/** 压缩任务：可能要跑一两分钟，网页和 QQ 指令都通过它启动、查进度；同一会话同时只跑一个 */
function createCompressJob({ memory, llm, log, now = Date.now }) {
  const jobs = new Map();
  function status(id) {
    const j = jobs.get(id);
    const out = j
      ? { running: j.running, progress: j.progress, startedAt: j.startedAt, finishedAt: j.finishedAt || 0, result: j.result || null, resultText: j.result ? describeCompress(j.result) : "", error: j.error || "" }
      : { running: false };
    return { ...out, stats: memory.stats(id) };
  }
  function start(id, opts = {}) {
    const cur = jobs.get(id);
    if (cur && cur.running) return { already: true, promise: cur.promise };
    const job = { running: true, progress: "准备中", startedAt: now() };
    job.promise = memory
      .compress(id, llm, { ...opts, onProgress: (t) => (job.progress = t) })
      .then((r) => {
        job.result = r;
        return r;
      })
      .catch((e) => {
        job.error = e.friendly || e.message;
        log.warn("压缩失败：" + job.error);
        throw e;
      })
      .finally(() => {
        job.running = false;
        job.finishedAt = now();
      });
    job.promise.catch(() => {});
    jobs.set(id, job);
    return { already: false, promise: job.promise };
  }
  return { start, status };
}

/** 压缩结果 → 一句给人看的话 */
function describeCompress(r) {
  const b = r.before;
  const a = r.after;
  const pct = b.contextChars ? Math.round((1 - a.contextChars / b.contextChars) * 100) : 0;
  const kb = (n) => (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  const rows = [];
  if (!r.steps.length) rows.push("没有需要压缩的内容，现在已经很精简了");
  else rows.push(r.steps.join("；"));
  rows.push(`每轮发给模型的内容：${b.contextChars} → ${a.contextChars} 字${pct > 0 ? `（少了 ${pct}%）` : ""}`);
  if (r.archived) rows.push(`聊天记录文件：${kb(b.fileBytes)} → ${kb(a.fileBytes)}（旧原文已归档，可以恢复）`);
  rows.push(`长期记忆：${a.basics} 项基本信息、${a.facts} 件事，摘要 ${a.summaryChars} 字`);
  return rows.join("\n");
}

module.exports = { createMemory, createCompressJob, describeCompress, similar };
