"use strict";
/*
 * 对话大脑：一轮回复的完整编排。
 *   记录消息 → 「记住/忘掉」指令 → （需要时）联网搜索 → 组装上下文 → 调大模型
 *   → 解析〔想〕〔心情〕〔搜索〕→ 去 AI 腔、拆条、挑表情包 → 保存 → 后台整理摘要与记忆
 *
 * 发给模型的消息顺序（为了命中 DeepSeek 的自动前缀缓存，越靠前越稳定）：
 *   1. system：人设 + 规则 + 输出格式（固定）
 *   2. 之前的聊天（只会在末尾追加）
 *   3. system：记忆、摘要、相关旧聊天、此刻状态、本轮提示（每轮会变）
 *   4. user：对方最新发来的消息
 */
const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJsonAtomic, ensureDir, safeName, fmtNow, fmtGap, fmtShort, createKeyedLock } = require("./util");
const { buildStaticPrompt, buildDynamicPrompt, lifeNow, hashStr } = require("./persona");
const { parseOutput, toBubbles, stickerOf, plan } = require("./humanize");
const { offlineReply } = require("./offline");
const { detectSearchIntent } = require("./search");

const GAP_NOTE_MS = 60 * 60 * 1000; // 两条消息隔超过 1 小时，就在上下文里标出来
const RAW_LOG_MAX = 2 * 1024 * 1024;

function createBrain({ config, memory, llm, dataDir, log, stickers = null, search = null, now = Date.now, random = Math.random }) {
  const stateDir = path.join(dataDir, "state");
  ensureDir(stateDir);
  const rawLog = path.join(dataDir, "logs", "llm-raw.jsonl");
  const lock = createKeyedLock();
  const lastHintAt = new Map();

  const stateFile = (id) => path.join(stateDir, safeName(id) + ".json");
  function getState(id) {
    return { mood: "平静", moodAt: 0, lastThought: "", lastUserAt: 0, lastReplyAt: 0, lastProactiveAt: 0, ...(readJson(stateFile(id), {}) || {}) };
  }
  function saveState(id, s) {
    writeJsonAtomic(stateFile(id), s);
  }

  /** 模型原始输出记到本地日志（排查「为什么它这么说」用，只存在本机） */
  function logRaw(sessionId, raw) {
    try {
      ensureDir(path.dirname(rawLog));
      try {
        if (fs.statSync(rawLog).size > RAW_LOG_MAX) fs.renameSync(rawLog, rawLog + ".1");
      } catch {
        /* 还没有日志 */
      }
      fs.appendFileSync(rawLog, JSON.stringify({ ts: now(), sessionId, raw: String(raw).slice(0, 3000) }) + "\n", "utf8");
    } catch {
      /* 日志失败不影响聊天 */
    }
  }

  function userCall() {
    return config.friend.userName || "对方";
  }

  function abilities() {
    return {
      stickers: Boolean(stickers && config.stickers.enabled && stickers.count() > 0),
      search: Boolean(search && config.search.enabled && config.search.sources.length),
    };
  }

  /** 你最近几条消息里是不是已经聊过自己此刻在干嘛了（看有没有连着 4 个字一样） */
  function lifeMentioned(life, recentMsgs) {
    const mine = (recentMsgs || []).filter((m) => m.role === "assistant").slice(-8).map((m) => m.text).join("\n");
    if (!mine) return false;
    const core = life.replace(/[，,。！？\s]/g, "");
    for (let i = 0; i + 4 <= core.length; i++) if (mine.includes(core.slice(i, i + 4))) return true;
    return false;
  }

  function stateBlock(st, t, gapMs, recentMsgs = []) {
    const moodAge = t - (st.moodAt || 0);
    const fresh = moodAge < 3 * 3600 * 1000;
    const rows = [`现在是 ${fmtNow(t)}。`];
    if (gapMs > GAP_NOTE_MS) rows.push(`距离上次聊天已经过了 ${fmtGap(gapMs)}。`);
    else if (gapMs > 0) rows.push("你们正聊着。");
    else rows.push("这是你们第一次聊天。");
    rows.push(`你现在的心情：${fresh ? st.mood : "平静"}。`);
    const life = lifeNow(t, hashStr(config.friend.name));
    if (lifeMentioned(life, recentMsgs)) rows.push(`你此刻在：${life}。这个你刚才已经说过了，这轮别再提，注意力放在对方身上。`);
    else rows.push(`你此刻大概在：${life}（这是你的生活背景，可以自然提一句，不用每次说）。`);
    const h = new Date(t).getHours();
    if (h < 6) rows.push("已经是深夜了，你有点困：回得短一点，可以让对方早点睡，但别每句都催。");
    return "【此刻】\n" + rows.join("\n");
  }

  /** 会话消息 → 大模型 messages。相邻同角色合并；隔太久的加时间标记；你说过的话带上当时的〔想〕〔心情〕 */
  function toChatMessages(list, { isGroup }) {
    const out = [];
    let prevTs = 0;
    for (const m of list) {
      let content = m.text;
      if (m.role === "user") {
        if (isGroup && m.name) content = `${m.name}：${content}`;
        if (prevTs && m.ts - prevTs > GAP_NOTE_MS) content = `（${fmtShort(m.ts)}，隔了 ${fmtGap(m.ts - prevTs)}）${content}`;
      } else if (m.thought) {
        content = `〔想〕${m.thought}\n〔心情〕${m.mood || "平静"}\n${content}`;
      }
      prevTs = m.ts || prevTs;
      const last = out[out.length - 1];
      if (last && last.role === m.role) last.content += "\n" + content;
      else out.push({ role: m.role, content });
    }
    while (out.length && out[0].role === "assistant") out.shift();
    return out;
  }

  /** 在最后一条 user 消息前插入「每轮会变」的 system 消息 */
  function assemble(staticPrompt, chat, dynamicPrompt, fallbackUserText) {
    const msgs = chat.slice();
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: fallbackUserText || "（对方没说话）" });
    const last = msgs.pop();
    return [{ role: "system", content: staticPrompt }, ...msgs, { role: "system", content: dynamicPrompt }, last];
  }

  function relevantBlock(items) {
    if (!items.length) return "";
    return "【可能相关的更早聊天】（只是参考，别生硬地提）\n" + items.map((r) => `- ${fmtShort(r.ts)} ${userCall()}：${r.user}${r.reply ? ` / 你：${r.reply}` : ""}`).join("\n");
  }

  /** 把要发的几条变成「文字 / 表情包图片」；挑不到合适表情包的标记直接去掉 */
  function resolveParts(bubbles, mood, allowStickers) {
    const parts = [];
    for (const b of bubbles) {
      const kw = stickerOf(b);
      if (!kw) {
        parts.push({ type: "text", text: b });
        continue;
      }
      const s = allowStickers && stickers ? stickers.pick(kw, mood) : null;
      if (s) parts.push({ type: "sticker", id: s.id, keyword: kw, desc: s.desc, path: s.path });
    }
    return parts;
  }

  function finish(raw, { inputText, startedAt, isGroup, ab }) {
    const parsed = parseOutput(raw, { selfName: config.friend.name });
    let bubbles = toBubbles(parsed.lines, { mood: parsed.mood, maxBubbles: config.humanize.maxBubbles, stickers: ab.stickers });
    if (isGroup) bubbles = bubbles.slice(0, 2);
    const parts = resolveParts(bubbles, parsed.mood, ab.stickers);
    if (!parts.length) return { empty: true, search: parsed.search, thought: parsed.thought, mood: parsed.mood };
    const late = new Date(startedAt).getHours() < 6; // 深夜回得慢一点
    const p = plan(parts.map((x) => (x.type === "text" ? x.text : "图")), {
      inputLength: inputText.length,
      elapsedMs: now() - startedAt,
      maxReplyDelayMs: Math.round(config.humanize.maxReplyDelayMs * (late ? 1.6 : 1)),
      random,
      enabled: config.humanize.enabled && config.humanize.typingDelay,
    });
    if (late && config.humanize.enabled && config.humanize.typingDelay && inputText) {
      p.firstDelayMs = Math.min(Math.round(config.humanize.maxReplyDelayMs * 1.6), p.firstDelayMs + 1000 + Math.round(random() * 3000));
    }
    return { parts, thought: parsed.thought, mood: parsed.mood, search: parsed.search, ...p };
  }

  /**
   * 回复一轮。
   * @param {object} a
   * @param {string} a.sessionId
   * @param {string[]} a.texts           这一轮对方发来的消息（连发会合并成多条；图片已经换成了「[图片：描述]」）
   * @param {string} [a.channel]        web | qq
   * @param {boolean} [a.isGroup]
   * @param {string} [a.speaker]         群聊里说话人的名字
   * @param {{role:string,text:string,ts:number,name?:string}[]} [a.groupContext]  群聊最近的消息（含这一轮）
   * @param {string} [a.quote]           对方引用的那条消息原文
   * @param {string[]} [a.extraNotes]    适配层补充给模型的说明
   * @param {number} [a.saved]           texts 里前几条上一版已经记进聊天记录了（重新想时用，避免记两遍）
   * @param {(result:object)=>Promise<boolean>} [a.beforeCommit]
   *   想好之后、存档之前调用（适配层在这里「看消息、打字」）；返回 false 表示对方又发了新消息，
   *   这版不存不发，返回 { stale: true }，由适配层连同新消息一起重新回
   */
  function reply(a) {
    return lock(a.sessionId, () => doReply(a));
  }

  async function doReply({ sessionId, texts, channel = "web", isGroup = false, speaker = "", groupContext = null, quote = "", extraNotes = [], saved = 0, beforeCommit = null }) {
    const startedAt = now();
    const inputs = (texts || []).map((s) => String(s || "").trim()).filter(Boolean);
    if (!inputs.length) return null;
    const joined = inputs.join("\n");
    const fresh = inputs.slice(saved);
    const st = getState(sessionId);
    const lastMsg = isGroup ? null : memory.history(sessionId, 1).messages[0];
    const prevAt = Math.max(st.lastUserAt || 0, st.lastReplyAt || 0, (lastMsg && lastMsg.ts) || 0);
    const gapMs = prevAt ? startedAt - prevAt : 0;
    const ab = abilities();

    const notes = [...extraNotes];
    let history;
    let memoryBlock = "";
    let summary = "";
    let relevant = "";

    if (!isGroup) {
      for (const t of fresh) memory.append(sessionId, { role: "user", text: t, ts: now() });
      for (const t of fresh) {
        const n = memory.handleCommand(sessionId, t);
        if (n) notes.push(n);
      }
      if (!llm.enabled() && fresh.length) memory.ruleExtract(sessionId, fresh.join("\n"));
      const r = memory.recent(sessionId);
      history = r.messages;
      summary = r.summary;
      memoryBlock = memory.memoryBlock(sessionId, userCall());
      const firstSeq = history.length ? history[0].seq : Infinity;
      relevant = relevantBlock(memory.relevant(sessionId, joined, firstSeq));
    } else {
      history = (groupContext || []).slice(-40);
      notes.push(`现在是「${speaker || "有人"}」@了你，你要回应他/她。`);
    }
    if (quote) notes.push(`对方这次是引用（回复）了这条消息：「${quote.slice(0, 200)}」，要结合它来理解对方的话。`);
    if (inputs.length > 1) notes.push(`对方刚刚连着发了 ${inputs.length} 条，这是一段完整的话：先连起来弄懂对方整体想说什么、最在意的是哪一点，再像朋友那样整体回应，不要一条一条分别回。`);

    st.lastUserAt = startedAt;

    if (!llm.enabled()) {
      const bubbles = offlineReply(joined, random);
      if (channel === "web" && now() - (lastHintAt.get(sessionId) || 0) > 3600 * 1000) {
        lastHintAt.set(sessionId, now());
        bubbles.push("（还没接上大模型：在「设置」里填 API Key 后我才能真正聊天）");
      }
      const parts = bubbles.map((text) => ({ type: "text", text }));
      const offline = { parts, thought: "", mood: "平静", ...plan(bubbles, { random, enabled: false }) };
      if (beforeCommit && !(await beforeCommit(offline))) return { stale: true };
      return commit(sessionId, offline, { st, isGroup, engine: "offline" });
    }

    // 明显要查实时信息的，先查再回，省一次来回
    let searched = null;
    if (ab.search && !isGroup) {
      const intent = detectSearchIntent(joined);
      if (intent.should) searched = await search.search(intent.query);
    }

    const staticPrompt = buildStaticPrompt({ config, isGroup, abilities: { ...ab, search: ab.search && !searched } });
    const chat = toChatMessages(history, { isGroup });
    const dynamicFor = (extra) =>
      buildDynamicPrompt({
        memoryBlock,
        summary,
        relevant,
        stateBlock: stateBlock(st, startedAt, gapMs, history),
        note: [...notes, ...extra].filter(Boolean).join("\n"),
      });
    const call = async (extra, opts = {}) => {
      const raw = await llm.chat(assemble(staticPrompt, chat, dynamicFor(extra), joined), opts);
      logRaw(sessionId, raw);
      return finish(raw, { inputText: joined, startedAt, isGroup, ab });
    };

    let result = null;
    let engine = "llm";
    try {
      const first = searched ? [search.toNote(searched)] : [];
      result = await call(first);
      if (result.search && ab.search && !searched) {
        searched = await search.search(result.search);
        result = await call([search.toNote(searched), "资料已经给你了，这次不要再输出〔搜索〕，直接回复。"]);
      }
      if (result.empty) {
        log.warn("模型这次没写要发的消息，重试一次");
        result = await call([...first, "上一次你没有写要发出去的消息。这次〔想〕〔心情〕之后一定要写消息。"], { temperature: Math.min(1.2, config.llm.temperature + 0.1) });
      }
      if (result.empty) result = null;
    } catch (err) {
      log.warn("大模型调用失败：" + (err.friendly || err.message));
      result = null;
    }
    if (!result) {
      engine = "offline";
      const bubbles = offlineReply(joined, random);
      result = { parts: bubbles.map((text) => ({ type: "text", text })), thought: "", mood: st.mood || "平静", ...plan(bubbles, { random, enabled: config.humanize.enabled }) };
    }
    if (searched) result.searchInfo = { query: searched.query, engine: searched.engine, results: searched.results.map((r) => ({ title: r.title, url: r.url, site: r.site })) };
    if (beforeCommit && !(await beforeCommit(result))) return { stale: true };
    const out = commit(sessionId, result, { st, isGroup, engine });
    if (!isGroup && engine === "llm") background(sessionId);
    return out;
  }

  function partsToText(parts) {
    return parts.map((p) => (p.type === "sticker" ? `[表情包:${p.keyword}]` : p.text)).join("\n");
  }

  function commit(sessionId, result, { st, isGroup, engine }) {
    const t = now();
    const text = partsToText(result.parts);
    if (!isGroup) memory.append(sessionId, { role: "assistant", text, ts: t, thought: engine === "llm" ? result.thought : "", mood: engine === "llm" ? result.mood : "" });
    st.lastReplyAt = t;
    if (engine === "llm") {
      st.mood = result.mood;
      st.moodAt = t;
      st.lastThought = (result.thought || "").slice(0, 80);
    }
    saveState(sessionId, st);
    if (result.thought) log.debug(`〔想〕${result.thought}（${result.mood}）`);
    const bubbles = result.parts.map((p) => (p.type === "sticker" ? `[表情包:${p.keyword}]` : p.text));
    return { engine, sessionId, bubbles, ...result, text };
  }

  /** 后台整理：先压摘要，再抽记忆。失败只记日志，不影响聊天。 */
  function background(sessionId) {
    Promise.resolve()
      .then(() => memory.maybeSummarize(sessionId, llm))
      .catch((e) => log.warn("整理摘要失败：" + (e.friendly || e.message)))
      .then(() => memory.maybeExtract(sessionId, llm))
      .catch((e) => log.warn("整理记忆失败：" + (e.friendly || e.message)));
  }

  /**
   * 主动找对方聊天。
   * @param {string} sessionId
   * @param {{note?:string}} [o]  note：这次为什么主动找（比如关心某个安排）；不给就是随口开个头
   */
  function proactive(sessionId, o = {}) {
    return lock(sessionId, async () => {
      if (!llm.enabled()) return null;
      const t = now();
      const st = getState(sessionId);
      const last = Math.max(st.lastUserAt || 0, st.lastReplyAt || 0);
      const r = memory.recent(sessionId);
      const ab = { ...abilities(), search: false };
      const messages = assemble(
        buildStaticPrompt({ config, abilities: ab }),
        [...toChatMessages(r.messages, { isGroup: false }), { role: "user", content: "（系统提示：现在轮到你主动发消息，请直接按格式输出）" }],
        buildDynamicPrompt({
          memoryBlock: memory.memoryBlock(sessionId, userCall()),
          summary: r.summary,
          stateBlock: stateBlock(st, t, last ? t - last : 0, r.messages),
          note:
            "现在是你主动给对方发消息（对方还没说话）。" +
            (o.note ||
              "像朋友那样随口开个头：分享你此刻在干嘛、关心一下对方之前提过的安排、或者聊个你突然想到的小事。只发 1~2 条，不要说「好久不见」「在吗」这种客套，不要连着发问。"),
        }),
        ""
      );
      const raw = await llm.chat(messages);
      logRaw(sessionId, raw);
      const result = finish(raw, { inputText: "", startedAt: t, isGroup: false, ab });
      if (!result || result.empty) return null;
      st.lastProactiveAt = t;
      return commit(sessionId, result, { st, isGroup: false, engine: "llm" });
    });
  }

  return { reply, proactive, getState, toChatMessages, abilities };
}

module.exports = { createBrain };
