"use strict";
/*
 * 群聊总结：帮主人盯着勾选的 QQ 群，定时（或主人要的时候）用好友的口吻私聊告诉他群里聊了啥。
 *
 * 默认关闭。主人在网页「群聊总结」页自己打开、勾选群之后：
 *   - 只记录勾选的群，存在本机 data/groups/<群号>.jsonl（不看图，图片记成「[图片]」）；
 *   - 总结时把这段群聊发给「整理记忆」用的那个模型，太长就先分段整理笔记再合起来；
 *   - 总结发到主人 QQ 私聊，同时记进和主人的聊天记录（主人接着问，它知道自己说过什么）；
 *   - 每次总结都存一份在 data/groups/summaries.jsonl，网页上能看。
 */
const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, readJson, writeJsonAtomic, writeFileAtomic, safeName, ymd, pad, fmtShort } = require("./util");
const { styleOf } = require("./persona");
const { removeAiTone } = require("./humanize");

const CHUNK_CHARS = 12000; // 一次交给模型的群聊原文上限，超过就分段先整理笔记
const MAX_CHARS = 60000; // 一次总结最多看这么多字（太多就只看最近的）
const MAX_TEXT = 500; // 每条群消息最多记这么多字
const SUMMARY_MAX = 1500;

function createGroupDigest({ config, dataDir, llm, memory, log, now = Date.now, deliver = async () => false, listGroups = async () => [] }) {
  const dir = path.join(dataDir, "groups");
  const stateFile = path.join(dir, "state.json");
  const summariesFile = path.join(dir, "summaries.jsonl");
  const msgFile = (gid) => path.join(dir, safeName(gid) + ".jsonl");
  let job = null;

  function getState() {
    const s = readJson(stateFile, {}) || {};
    return { groups: {}, dailyDone: "", ...s };
  }
  function saveState(s) {
    writeJsonAtomic(stateFile, s);
  }
  function groupState(s, gid) {
    if (!s.groups[gid]) s.groups[gid] = { name: "", lastAt: 0, lastRunAt: 0 };
    return s.groups[gid];
  }

  function watching(gid) {
    const g = config.groupDigest;
    return Boolean(g && g.enabled && g.groups.includes(String(gid)));
  }

  /** 记一条群消息（没开、没勾选这个群就什么都不做） */
  function record(gid, { ts = now(), uid = "", name = "", text = "", atOwner = false, self = false } = {}) {
    gid = String(gid);
    if (!watching(gid)) return false;
    const t = String(text || "").trim().slice(0, MAX_TEXT);
    if (!t) return false;
    ensureDir(dir);
    const msg = { ts, uid: String(uid), name: String(name).slice(0, 30), text: t };
    if (atOwner) msg.atOwner = true;
    if (self) msg.self = true;
    fs.appendFileSync(msgFile(gid), JSON.stringify(msg) + "\n", "utf8");
    return true;
  }

  function readMessages(gid) {
    let raw = "";
    try {
      raw = fs.readFileSync(msgFile(gid), "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 写了一半的行，跳过 */
      }
    }
    return out;
  }

  function pending(gid) {
    const lastAt = (getState().groups[String(gid)] || {}).lastAt || 0;
    return readMessages(gid).filter((m) => m.ts > lastAt).length;
  }

  /** 记下群名字（来自 NapCat 的 get_group_list） */
  function rememberNames(list) {
    const s = getState();
    let changed = false;
    for (const g of list || []) {
      const gid = String(g.group_id || "");
      const name = String(g.group_name || "").slice(0, 60);
      if (!gid || !name) continue;
      const st = groupState(s, gid);
      if (st.name !== name) {
        st.name = name;
        changed = true;
      }
    }
    if (changed) saveState(s);
  }

  function nameOf(gid) {
    return (getState().groups[String(gid)] || {}).name || `群${gid}`;
  }

  /** 群列表（网页用）：NapCat 能连上就用它的列表，连不上就只列勾选过的群 */
  async function groups() {
    let list = [];
    let online = true;
    try {
      list = (await listGroups()) || [];
      rememberNames(list);
    } catch (e) {
      online = false;
      log.debug("取群列表失败：" + e.message);
    }
    const s = getState();
    const seen = new Set();
    const rows = [];
    const add = (gid, members) => {
      if (seen.has(gid)) return;
      seen.add(gid);
      const st = s.groups[gid] || {};
      rows.push({ id: gid, name: st.name || `群${gid}`, members: members || 0, watching: watching(gid), pending: pending(gid), lastSummaryAt: st.lastRunAt || 0 });
    };
    for (const g of list) add(String(g.group_id), Number(g.member_count) || 0);
    for (const gid of config.groupDigest.groups) add(gid, 0);
    return { online, groups: rows };
  }

  // ---------- 总结 ----------

  function userCall() {
    return config.friend.userName || "对方";
  }

  /** 群消息 → 「21:03 阿强：今晚谁打球」，跨天时插一行日期 */
  function formatLines(msgs) {
    const owners = config.owner.qq.map(String);
    let day = "";
    const lines = [];
    for (const m of msgs) {
      const d = new Date(m.ts);
      const today = ymd(m.ts);
      if (today !== day) {
        day = today;
        lines.push(`—— ${d.getMonth() + 1}月${d.getDate()}日 ——`);
      }
      let who = m.name || m.uid || "有人";
      if (m.self) who = `${config.friend.name}（就是你自己）`;
      else if (owners.includes(m.uid)) who += `（就是${userCall()}本人）`;
      lines.push(`${pad(d.getHours())}:${pad(d.getMinutes())} ${who}${m.atOwner ? ` @了${userCall()}` : ""}：${m.text}`);
    }
    return lines;
  }

  function chunkLines(lines, size) {
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const l of lines) {
      if (len + l.length > size && cur.length) {
        chunks.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(l);
      len += l.length + 1;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  function cleanText(raw) {
    const lines = String(raw || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.replace(/^\s*(?:#+\s*|[-*•]\s+|\d+[.、)]\s*)/, "").replace(/\*\*/g, "").trim())
      .filter(Boolean);
    return removeAiTone(lines).join("\n").trim().slice(0, SUMMARY_MAX);
  }

  async function writeSummary(gid, msgs) {
    const name = nameOf(gid);
    const f = config.friend;
    const call = userCall();
    let lines = formatLines(msgs);
    let dropped = 0;
    while (lines.join("\n").length > MAX_CHARS && lines.length > 1) {
      lines.shift();
      dropped++;
    }
    const range = `${fmtShort(msgs[0].ts)} 到 ${fmtShort(msgs[msgs.length - 1].ts)}`;
    let material;
    const text = lines.join("\n");
    if (text.length <= CHUNK_CHARS) {
      material = `群聊记录（${msgs.length} 条，${range}）：\n${text}`;
    } else {
      // 太长：先分段整理成笔记，再用笔记写总结
      const chunks = chunkLines(lines, CHUNK_CHARS);
      const notes = [];
      for (let i = 0; i < chunks.length; i++) {
        const note = await llm.chat(
          [
            { role: "system", content: "你在帮人整理 QQ 群聊记录，只写记录里有的内容。" },
            {
              role: "user",
              content:
                `下面是「${name}」群的一段聊天（第 ${i + 1}/${chunks.length} 段）。用几行简短的笔记写下：定下来的事、通知和时间、有人@或问「${call}」的内容、主要在聊什么。不超过 300 字。\n\n` +
                chunks[i].join("\n"),
            },
          ],
          { use: "memory", temperature: 0.3, maxTokens: 800 }
        );
        notes.push(`第 ${i + 1} 段：${String(note).trim()}`);
      }
      material = `群聊记录太长（${msgs.length} 条，${range}），下面是分段整理的笔记：\n${notes.join("\n\n")}`;
    }
    if (dropped) material = `（更早的 ${dropped} 条太多了没看）\n` + material;
    const who = [
      `你是「${f.name}」，和${call === "对方" ? "对方" : `「${call}」`}是${f.relationship || "好朋友"}。`,
      `你的性格：${styleOf(f.style).persona}`,
      f.customPrompt ? `补充设定（优先遵守）：${f.customPrompt}` : "",
      `${call}加了一些 QQ 群，平时没空看，托你帮忙盯着。现在你要在 QQ 私聊里告诉${call}「${name}」群里这段时间聊了啥。`,
    ]
      .filter(Boolean)
      .join("\n");
    const rules =
      "用你平时和对方私聊的口吻，像朋友转述那样说，开头点一下是哪个群。\n" +
      `先说要紧的：定下来的事、通知、截止时间、有人@${call}或者问${call}的、和${call}有关的；没有就不用硬说。\n` +
      "闲聊、刷屏一句带过，不用每个人每句话都讲。只说记录里有的，别编，看不懂的就别提。\n" +
      "纯文本，不要 markdown、标题、编号，可以分成两三小段。不超过 300 字。";
    const raw = await llm.chat(
      [
        { role: "system", content: who },
        { role: "user", content: `${material}\n\n${rules}` },
      ],
      { use: "memory", temperature: 0.6, maxTokens: 1000 }
    );
    return cleanText(raw);
  }

  /** 删掉超过保留天数的原始记录 */
  function prune(gid) {
    const cutoff = now() - config.groupDigest.keepDays * 86400000;
    const msgs = readMessages(gid);
    const keep = msgs.filter((m) => m.ts >= cutoff);
    if (keep.length === msgs.length) return;
    if (!keep.length) {
      try {
        fs.unlinkSync(msgFile(gid));
      } catch {
        /* 已经没有了 */
      }
      return;
    }
    writeFileAtomic(msgFile(gid), keep.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }

  /**
   * 总结一个群从上次总结到现在的消息。
   * @returns {{gid:string,name:string,count:number,skipped?:string,text?:string,from?:number,to?:number}}
   */
  async function summarize(gid, { force = false } = {}) {
    gid = String(gid);
    const lastAt = (getState().groups[gid] || {}).lastAt || 0;
    const msgs = readMessages(gid).filter((m) => m.ts > lastAt);
    const base = { gid, name: nameOf(gid), count: msgs.length };
    if (!msgs.length) return { ...base, skipped: "没有新消息" };
    if (!force && msgs.length < config.groupDigest.minMessages) return { ...base, skipped: `新消息只有 ${msgs.length} 条，不到 ${config.groupDigest.minMessages} 条` };
    const text = await writeSummary(gid, msgs);
    if (!text) throw new Error("模型没写出总结");
    const s = getState();
    const st = groupState(s, gid);
    st.lastAt = msgs[msgs.length - 1].ts;
    st.lastRunAt = now();
    saveState(s);
    prune(gid);
    return { ...base, text, from: msgs[0].ts, to: msgs[msgs.length - 1].ts };
  }

  function saveSummary(r, sent) {
    ensureDir(dir);
    fs.appendFileSync(summariesFile, JSON.stringify({ ts: now(), gid: r.gid, name: r.name, from: r.from, to: r.to, count: r.count, text: r.text, sent }) + "\n", "utf8");
  }

  /**
   * 总结所有勾选的群。
   * @param {{force?:boolean, send?:boolean, onProgress?:(t:string)=>void}} [o]
   *   force：消息少也总结（主人自己要的时候）；send：发到主人 QQ
   */
  async function runAll({ force = false, send = true, onProgress = () => {} } = {}) {
    const g = config.groupDigest;
    if (!g.enabled || !g.groups.length) return { results: [], note: "还没开启群聊总结：去网页「群聊总结」页打开，并勾选要总结的群" };
    if (!llm.enabled("memory")) return { results: [], note: "还没有可用的大模型，总结要靠大模型来写" };
    try {
      rememberNames((await listGroups()) || []);
    } catch {
      /* 连不上 NapCat 就用记下的群名 */
    }
    const results = [];
    for (const gid of g.groups) {
      onProgress(`总结「${nameOf(gid)}」`);
      try {
        const r = await summarize(gid, { force });
        if (r.text) {
          let sent = false;
          if (send) {
            sent = await deliver(r.text).catch((e) => (log.warn("发群聊总结失败：" + e.message), false));
            // 发出去了才算它「说过」：主人接着问，它知道自己说的是什么
            if (sent) memory.append("main", { role: "assistant", text: r.text, ts: now() });
          }
          saveSummary(r, sent);
          r.sent = sent;
          log.info(`群聊总结：「${r.name}」${r.count} 条 → ${r.text.length} 字${send ? (sent ? "，已发到 QQ" : "，发 QQ 失败") : ""}`);
        }
        results.push(r);
      } catch (e) {
        log.warn(`总结「${nameOf(gid)}」失败：` + (e.friendly || e.message));
        results.push({ gid, name: nameOf(gid), error: e.friendly || e.message });
      }
    }
    return { results };
  }

  /** 一句话说明这次的结果（QQ 指令和网页用） */
  function describe(out) {
    if (out.note) return out.note;
    const done = out.results.filter((r) => r.text);
    const failed = out.results.filter((r) => r.error);
    const rows = [];
    if (done.length) rows.push(`总结了 ${done.length} 个群：${done.map((r) => `「${r.name}」${r.count} 条${r.sent === false ? "（没发出去）" : ""}`).join("、")}`);
    const skipped = out.results.filter((r) => r.skipped);
    if (skipped.length) rows.push(skipped.map((r) => `「${r.name}」${r.skipped}`).join("；"));
    if (failed.length) rows.push(failed.map((r) => `「${r.name}」没总结成：${r.error}`).join("；"));
    return rows.join("\n") || "没有勾选的群";
  }

  /** 后台跑一次（网页按钮、QQ 指令、定时都走这里，同一时间只跑一个） */
  function start(opts = {}) {
    if (job && job.running) return { already: true, promise: job.promise };
    const j = { running: true, progress: "准备中", startedAt: now() };
    j.promise = runAll({ ...opts, onProgress: (t) => (j.progress = t) })
      .then((out) => {
        j.result = { ...out, text: describe(out) };
        return out;
      })
      .catch((e) => {
        j.error = e.friendly || e.message;
        log.warn("群聊总结失败：" + j.error);
        throw e;
      })
      .finally(() => {
        j.running = false;
        j.finishedAt = now();
      });
    j.promise.catch(() => {});
    job = j;
    return { already: false, promise: j.promise };
  }

  function status() {
    if (!job) return { running: false };
    return { running: job.running, progress: job.progress, startedAt: job.startedAt, finishedAt: job.finishedAt || 0, resultText: job.result ? job.result.text : "", error: job.error || "" };
  }

  /** 最近的总结，新的在前 */
  function recent(limit = 30) {
    let raw = "";
    try {
      raw = fs.readFileSync(summariesFile, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n").reverse()) {
      if (out.length >= limit) break;
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  }

  /** 删掉记录下来的群消息原文（总结历史和群名保留） */
  function clear() {
    let n = 0;
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl") || f === "summaries.jsonl") continue;
      fs.unlinkSync(path.join(dir, f));
      n++;
    }
    const s = getState();
    for (const st of Object.values(s.groups)) st.lastAt = now();
    saveState(s);
    return n;
  }

  function lastDaily() {
    return getState().dailyDone || "";
  }
  function markDaily(day) {
    const s = getState();
    s.dailyDone = day;
    saveState(s);
  }

  return { watching, record, pending, rememberNames, groups, summarize, runAll, describe, start, status, recent, clear, lastDaily, markDaily };
}

module.exports = { createGroupDigest };
