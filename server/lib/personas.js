"use strict";
/*
 * 角色：把你和某个人的聊天记录导进来，新建一个扮演这个人的 AI（只在网页上聊）。
 *
 * 导入时（要用「整理记忆」那个模型，按聊天长短最多十来次调用）：
 *   1. 琢磨这个人的说话方式：性格、口头禅、标点习惯、怎么称呼你，挑几句原话当语气示范；
 *   2. 把聊天按时间切成最多 10 段，每段整理「这段时间聊了什么、关于你的事、关于他/她自己的事」；
 *   3. 合起来写成长期回忆（摘要）；关于你的事进记忆档案，关于他/她自己的事进角色设定；
 *   4. 聊天原文按原来的时间写进这个角色的聊天记录：最近几十条每轮带给模型，更早的能被「翻旧账」按关键词找出来。
 * 聊天时用这些回忆和语气来回，但不照搬原话（见 persona.js 的提示词）。
 *
 * 存储：data/personas/index.json（角色列表）；聊天记录和记忆跟主聊天一样放在 sessions/ 和 profiles/，会话 id 是 p_<角色 id>。
 */
const path = require("node:path");
const { readJson, writeJsonAtomic, ensureDir, fmtShort } = require("./util");
const { parseJsonLoose } = require("./llm");
const { decodeBuffer, parseChat } = require("./chatimport");

const SEGMENTS = 10; // 整理回忆最多分几段
const SEGMENT_CHARS = 7000; // 每段最多交给模型这么多字（多了就均匀抽样）
const STYLE_CHARS = 6000; // 琢磨说话方式时最多看这么多字
const KEEP_RECENT = 30; // 导入后最近几条原文每轮带给模型
const PREVIEW_TTL = 30 * 60 * 1000;

const strList = (v, n, len = 80) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, len)).filter((x) => x.length >= 2))].slice(0, n);

/** 从长列表里均匀挑，总字数不超过 maxChars（保持原来的先后顺序） */
function sampleLines(lines, maxChars) {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= maxChars) return lines;
  const keep = Math.max(1, Math.floor(lines.length * (maxChars / total)));
  const step = lines.length / keep;
  const out = [];
  for (let i = 0; i < keep; i++) out.push(lines[Math.floor(i * step)]);
  return out;
}

function createPersonas({ config, dataDir, memory, llm, log, now = Date.now }) {
  const dir = path.join(dataDir, "personas");
  const indexFile = path.join(dir, "index.json");
  const previews = new Map();
  let job = null;

  const sessionOf = (id) => `p_${id}`;
  function all() {
    const j = readJson(indexFile, null);
    return j && Array.isArray(j.list) ? j.list : [];
  }
  function saveAll(list) {
    ensureDir(dir);
    writeJsonAtomic(indexFile, { list });
  }
  function get(id) {
    return all().find((p) => p.id === String(id || "")) || null;
  }

  /** 网页列表用：加上聊天条数和记忆情况 */
  function list() {
    return all().map((p) => {
      const sid = sessionOf(p.id);
      const prof = memory.getProfile(sid);
      return { ...p, messages: memory.history(sid, 1).total, facts: prof.facts.length + Object.keys(prof.basics).length, summary: prof.summary };
    });
  }

  /** 给 memory 用：p_xxx 会话里「我」是这个角色 */
  function namesFor(sessionId) {
    const m = /^p_(.+)$/.exec(String(sessionId || ""));
    const p = m && get(m[1]);
    return p ? { name: p.name, userCall: p.userCall || "对方" } : null;
  }

  /** 给 brain / persona.js 用：替换 config.friend 的那份人设 */
  function friendFor(id) {
    const p = get(id);
    if (!p) return null;
    return {
      name: p.name,
      relationship: p.relationship || "老朋友",
      userName: p.userCall || "",
      persona: p.persona || "说话自然随意，像老朋友一样",
      examples: p.examples || [],
      selfFacts: p.selfFacts || [],
      customPrompt: p.customPrompt || "",
      language: config.friend.language,
      imported: true,
    };
  }

  // ---------- 预览：先认出格式和谁是谁，让用户选 ----------

  function preview(buf, filename = "") {
    const parsed = parseChat(decodeBuffer(buf), { filename, now: now() });
    if (!parsed.messages.length) throw Object.assign(new Error("没认出这是聊天记录。支持 QQ 导出的 .txt，以及留痕 / WeChatMsg 等工具导出的微信 .txt / .csv"), { status: 400 });
    for (const [k, v] of previews) if (now() - v.at > PREVIEW_TTL) previews.delete(k);
    const token = `${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    previews.set(token, { at: now(), parsed, filename });
    const msgs = parsed.messages;
    // 猜一下：带「是不是自己」标记的直接用；否则「我」或名字不是聊天对象的那个
    const me = (parsed.speakers.find((s) => s.me) || parsed.speakers.find((s) => s.name === "我") || parsed.speakers.find((s) => parsed.partner && s.name !== parsed.partner) || {}).name || "";
    const them = parsed.partner && parsed.speakers.some((s) => s.name === parsed.partner) ? parsed.partner : (parsed.speakers.find((s) => s.name !== me) || {}).name || "";
    return {
      token,
      format: parsed.format,
      count: msgs.length,
      from: msgs[0].ts,
      to: msgs[msgs.length - 1].ts,
      speakers: parsed.speakers.slice(0, 20),
      guess: { me, them },
      sample: msgs.slice(0, 6).map((m) => ({ name: m.name, text: m.text.slice(0, 80), ts: m.ts })),
    };
  }

  // ---------- 导入 ----------

  const line = (m, me) => `${fmtShort(m.ts)} ${m.name === me ? "我" : m.name}：${m.text.replace(/\n/g, " ")}`;

  async function studyStyle(msgs, me, them) {
    // 给整段对话（两个人的话都在），比只给他/她的句子更能看出怎么接话、怎么对你
    const lines = sampleLines(msgs.map((m) => line(m, me)), STYLE_CHARS);
    const raw = await llm.chat(
      [
        { role: "system", content: "你在研究一个人的聊天风格，好让 AI 能像他/她一样说话。只输出 JSON。" },
        {
          role: "user",
          content:
            `下面是「${them}」和我（记录里写作「我」）的聊天记录片段：\n${lines.join("\n")}\n\n` +
            `请分析「${them}」，输出 JSON：\n` +
            '{"persona":"…","relationship":"…","userCall":"…","examples":["…"]}\n' +
            `persona：${them}的性格和说话方式，150 字以内，写具体：语气、口头禅和常用词、爱用的表情或语气词、标点和断句习惯、回复一般多长、对我的态度。\n` +
            `relationship：${them}和我是什么关系，10 字以内，看不出来就写空字符串。\n` +
            `userCall：${them}平时怎么称呼我，看不出来就写空字符串。\n` +
            `examples：挑 8 句最能代表${them}说话感觉的原话（短句，照抄原文）。`,
        },
      ],
      { use: "memory", temperature: 0.3, maxTokens: 1200, json: true }
    );
    const j = parseJsonLoose(raw) || {};
    return {
      persona: String(j.persona || "").trim().slice(0, 400),
      relationship: String(j.relationship || "").trim().slice(0, 30),
      userCall: String(j.userCall || "").trim().slice(0, 16),
      examples: strList(j.examples, 10, 60),
    };
  }

  async function studySegment(seg, me, them, i, n) {
    const lines = sampleLines(seg.map((m) => line(m, me)), SEGMENT_CHARS);
    const raw = await llm.chat(
      [
        { role: "system", content: `你是「${them}」，在回忆你和「我」以前的聊天。只输出 JSON。` },
        {
          role: "user",
          content:
            `这是你们 ${fmtShort(seg[0].ts)} 到 ${fmtShort(seg[seg.length - 1].ts)} 的聊天（第 ${i + 1}/${n} 段${lines.length < seg.length ? "，内容太多只抽了一部分" : ""}）：\n${lines.join("\n")}\n\n` +
            '输出 JSON：{"story":"…","aboutUser":["…"],"aboutSelf":["…"]}\n' +
            `story：用「我」指你自己（${them}），写这段时间你们聊了什么、一起经历了什么、有什么约定和梗，150 字以内，写具体日期。\n` +
            `aboutUser：关于对方（记录里的「我」）本人、以后聊天用得上的事实：称呼、所在地、工作学校、家人朋友、喜好、经历、烦恼。每条简短、第三人称，最多 8 条。\n` +
            `aboutSelf：关于你自己（${them}）的事实：住哪、做什么、家人朋友、喜好、经历。每条简短，用「我」开头，最多 8 条。\n` +
            "只写记录里有的，没有就给空数组。",
        },
      ],
      { use: "memory", temperature: 0.3, maxTokens: 1200, json: true }
    );
    const j = parseJsonLoose(raw) || {};
    return { story: String(j.story || "").trim().slice(0, 400), aboutUser: strList(j.aboutUser, 8), aboutSelf: strList(j.aboutSelf, 8) };
  }

  async function mergeStories(parts, them) {
    const stories = parts.map((p, i) => `第 ${i + 1} 段：${p.story}`).filter((s) => s.length > 6);
    const selfFacts = strList(parts.flatMap((p) => p.aboutSelf), 40);
    if (!stories.length) return { summary: "", selfFacts: selfFacts.slice(0, 15) };
    const raw = await llm.chat(
      [
        { role: "system", content: `你是「${them}」，在整理你和对方之间的回忆。只输出 JSON。` },
        {
          role: "user",
          content:
            `分段的回忆：\n${stories.join("\n")}\n\n关于你自己的零散事实：\n${JSON.stringify(selfFacts)}\n\n` +
            '输出 JSON：{"summary":"…","selfFacts":["…"]}\n' +
            "summary：把回忆合成一段，用「我」指你自己，600 字以内，按时间顺序；保留你们的关系变化、重要的事和日期、约定、梗和称呼、还没了结的事。\n" +
            "selfFacts：关于你自己的事实去重合并，最多 15 条，每条简短，用「我」开头；互相矛盾的留更新的说法。",
        },
      ],
      { use: "memory", temperature: 0.3, maxTokens: 1600, json: true }
    );
    const j = parseJsonLoose(raw) || {};
    const summary = String(j.summary || "").trim().slice(0, 1500) || stories.join("\n").slice(0, 1500);
    return { summary, selfFacts: strList(j.selfFacts, 15).length ? strList(j.selfFacts, 15) : selfFacts.slice(0, 15) };
  }

  async function runImport({ token, me, them, name, relationship }, onProgress) {
    const pv = previews.get(String(token || ""));
    if (!pv) throw Object.assign(new Error("预览过期了，重新选一下文件"), { status: 400 });
    const names = pv.parsed.speakers.map((s) => s.name);
    if (!names.includes(me) || !names.includes(them) || me === them) throw Object.assign(new Error("先选好哪个是你、要扮演的是谁（不能是同一个人）"), { status: 400 });
    // 只要你们俩之间的消息（群聊导出里别人的话不要）
    const msgs = pv.parsed.messages.filter((m) => m.name === me || m.name === them);
    if (!msgs.some((m) => m.name === them)) throw Object.assign(new Error(`记录里没有「${them}」说的话`), { status: 400 });

    onProgress(`琢磨「${them}」的说话方式`);
    const style = await studyStyle(msgs, me, them);

    const n = Math.min(SEGMENTS, Math.max(1, Math.ceil(msgs.length / 200)));
    const size = Math.ceil(msgs.length / n);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const seg = msgs.slice(i * size, (i + 1) * size);
      if (!seg.length) continue;
      onProgress(`整理你们的回忆（${i + 1}/${n}）`);
      parts.push(await studySegment(seg, me, them, i, n));
    }
    onProgress("把回忆合起来");
    const merged = await mergeStories(parts, them);

    const p = {
      id: `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || them).trim().slice(0, 16) || them,
      relationship: String(relationship || "").trim().slice(0, 30) || style.relationship,
      userCall: style.userCall,
      persona: style.persona,
      examples: style.examples,
      selfFacts: merged.selfFacts,
      customPrompt: "",
      createdAt: now(),
      source: { file: String(pv.filename || "").slice(0, 120), me, them, count: msgs.length, from: msgs[0].ts, to: msgs[msgs.length - 1].ts },
    };
    onProgress("写入聊天记录");
    const sid = sessionOf(p.id);
    saveAll([...all(), p]); // 先登记，写记忆时就会用这个角色的名字
    memory.importMessages(sid, msgs.map((m) => ({ role: m.name === them ? "assistant" : "user", text: m.text, ts: m.ts })), { summary: merged.summary, keepRecent: KEEP_RECENT });
    const aboutUser = strList(parts.flatMap((x) => x.aboutUser), 40);
    if (aboutUser.length) memory.applyOps(sid, { add: aboutUser });
    previews.delete(token);
    log.info(`导入了角色「${p.name}」：${msgs.length} 条聊天，${aboutUser.length} 条关于你的事，${p.selfFacts.length} 条关于他/她自己的事`);
    return p;
  }

  /** 后台导入（要跑一会儿），网页轮询进度；同一时间只跑一个 */
  function startImport(opts) {
    if (job && job.running) return { already: true };
    if (!llm.enabled("memory")) throw Object.assign(new Error("还没有可用的大模型，导入要靠大模型整理回忆和说话方式。先去「模型」页添加一个"), { status: 400 });
    const j = { running: true, progress: "准备中", startedAt: now() };
    j.promise = runImport(opts, (t) => (j.progress = t))
      .then((p) => (j.result = { id: p.id, name: p.name }))
      .catch((e) => {
        j.error = e.friendly || e.message;
        log.warn("导入聊天记录失败：" + j.error);
      })
      .finally(() => {
        j.running = false;
        j.finishedAt = now();
      });
    job = j;
    return { already: false, promise: j.promise };
  }

  function status() {
    if (!job) return { running: false };
    return { running: job.running, progress: job.progress, finishedAt: job.finishedAt || 0, result: job.result || null, error: job.error || "" };
  }

  /** 网页上改名字、关系、称呼、说话方式、补充设定 */
  function update(id, patch = {}) {
    const listAll = all();
    const p = listAll.find((x) => x.id === String(id || ""));
    if (!p) return null;
    const fields = { name: 16, relationship: 30, userCall: 16, persona: 600, customPrompt: 1500 };
    for (const [k, max] of Object.entries(fields)) {
      if (typeof patch[k] === "string") p[k] = patch[k].trim().slice(0, max);
    }
    if (!p.name) p.name = p.source.them;
    saveAll(listAll);
    return p;
  }

  function remove(id) {
    const listAll = all();
    const p = listAll.find((x) => x.id === String(id || ""));
    if (!p) return false;
    saveAll(listAll.filter((x) => x !== p));
    memory.removeSession(sessionOf(p.id));
    log.info(`删掉了角色「${p.name}」（聊天记录和记忆已改名备份）`);
    return true;
  }

  return { list, get, sessionOf, namesFor, friendFor, preview, startImport, status, update, remove };
}

module.exports = { createPersonas, sampleLines };
