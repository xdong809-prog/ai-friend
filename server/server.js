"use strict";
/*
 * AI 好友 v4 —— 入口。
 * 双击「启动.bat」或在项目根目录运行：node server/server.js
 * 只监听 127.0.0.1（本机），网页地址 http://127.0.0.1:8787/
 */
const fs = require("node:fs");
const path = require("node:path");
const { ensureConfigFile, loadConfig } = require("./lib/config");
const { createLogger } = require("./lib/log");
const { createLLM } = require("./lib/llm");
const { createMemory, createCompressJob, describeCompress } = require("./lib/memory");
const { createBrain } = require("./lib/brain");
const { createOneBot } = require("./lib/onebot");
const { createWatchdog, createNotifier } = require("./lib/watchdog");
const { createVision } = require("./lib/vision");
const { createStickers } = require("./lib/stickers");
const { createSearch } = require("./lib/search");
const { createGroupDigest } = require("./lib/groupdigest");
const { createPersonas } = require("./lib/personas");
const { createReminders, lastAt, whenText } = require("./lib/reminders");
const { createLinkReader, httpGet } = require("./lib/linkreader");
const { createUsage } = require("./lib/usage");
const { createDiary } = require("./lib/diary");
const { createVoice } = require("./lib/voice");
const { applyPendingRestore } = require("./lib/backup");
const { createApp, VERSION } = require("./lib/app");
const { ymd, fmtGap } = require("./lib/util");

const REMINDER_LATE_LIMIT_MS = 12 * 3600 * 1000;

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";

function rotateLog(dataDir) {
  const file = path.join(dataDir, "logs", "server.log");
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + ".1");
  } catch {
    /* 没有日志文件 */
  }
}

/**
 * 主人在 QQ 里可以用的小指令（不经过大模型）：
 *   /模型          看现在用的是哪个、有哪些可以换
 *   /模型 2        换成第 2 个；也可以写名字的一部分，比如「/模型 kimi」
 *   /压缩          压缩聊天记录
 *   /群总结        马上总结勾选的群（要先在网页「群聊总结」页打开）
 *   /提醒          看现在有哪些提醒
 *   /规矩          看你教过它的说话规矩；「/规矩 少用问句」加一条；「/规矩 删 2」删第 2 条
 */
function createCommands({ root, config, llm, log, env, compressJob = null, digest = null, memory = null, reminders = null }) {
  const { savePatch, replaceInPlace } = require("./lib/config");
  function handle(text) {
    const said = String(text || "").trim();
    if (reminders && /^[\/／]\s*提醒\s*$/.test(said)) {
      const rows = reminders.active();
      if (!rows.length) return "现在没有提醒。跟我说「明早 8 点叫我」这样就行";
      return `现在的提醒：\n${rows.map((r, i) => `${i + 1}. ${r.when} ${r.text}`).join("\n")}\n\n想取消直接跟我说，或者去网页「记忆」页删`;
    }
    const ruleCmd = memory && /^[\/／]\s*规矩\s*(.*)$/.exec(said);
    if (ruleCmd) {
      const arg = ruleCmd[1].trim();
      const rules = memory.getProfile("main").rules;
      if (!arg) return rules.length ? `你教过我的规矩：\n${rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n")}\n\n发「/规矩 删 2」删掉第 2 条` : "还没有规矩。发「/规矩 少用问句结尾」加一条，或者直接跟我说哪里不喜欢";
      const del = /^(?:删|删除)\s*(\d+)$/.exec(arg);
      if (del) {
        const item = rules[Number(del[1]) - 1];
        if (!item) return `没有第 ${del[1]} 条`;
        memory.applyOps("main", { removeRules: [item.text] });
        return `删掉了：${item.text}`;
      }
      memory.applyOps("main", { addRules: [arg] });
      return `记下了：${arg.slice(0, 60)}`;
    }
    if (digest && /^[\/／]\s*(?:群总结|群聊总结)\s*$/.test(String(text || "").trim())) {
      const g = config.groupDigest;
      if (!g.enabled || !g.groups.length) return "还没开启群聊总结：打开网页「群聊总结」页，打开开关并勾选要总结的群";
      const { already, promise } = digest.start({ force: true, send: true });
      return {
        now: already ? "正在看群消息呢，好了发你" : "好，我去翻翻群里聊了啥",
        // 总结本身会直接发过来；只有一条都没发出去时才补一句为什么
        later: promise
          .then((out) => (out.results.some((r) => r.sent) ? "" : digest.describe(out)))
          .catch((e) => "群聊总结没成功：" + (e.friendly || e.message)),
      };
    }
    if (compressJob && /^[\/／]\s*(?:压缩|compress)\s*$/i.test(String(text || "").trim())) {
      const { already, promise } = compressJob.start("main");
      return {
        now: already ? "正在压缩，稍等一下，好了告诉你" : "开始压缩聊天记录：先把聊过的整理进长期记忆，再压缩原文。可能要一两分钟",
        later: promise.then((r) => "压缩好了\n" + describeCompress(r)).catch((e) => "压缩没成功：" + (e.friendly || e.message) + "。聊天记录没有被改动"),
      };
    }
    const m = /^[\/／]\s*(?:模型|model|换模型)\s*(.*)$/i.exec(String(text || "").trim());
    if (!m) return null;
    const list = config.providers;
    if (!list.length) return "还没有添加任何模型。打开网页的「模型」页添加。";
    const q = m[1].trim();
    if (!q) {
      const cur = config.llm.active;
      const rows = list.map((p, i) => `${i + 1}. ${p.name}${p.id === cur ? "  ← 正在用" : ""}${llm.usable(p) ? "" : "（没填 Key）"}`);
      return `现在聊天用的是：${(llm.current() || {}).name || "未设置"}\n\n${rows.join("\n")}\n\n发「/模型 编号」或「/模型 名字」切换`;
    }
    const n = Number(q);
    const qq = q.toLowerCase();
    const hit = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : list.find((p) => p.name.toLowerCase().includes(qq) || p.model.toLowerCase().includes(qq) || p.id === qq);
    if (!hit) return `没找到「${q}」。发「/模型」看看有哪些。`;
    if (!llm.usable(hit)) return `「${hit.name}」还没填 Key，先去网页「模型」页填一下。`;
    replaceInPlace(config, savePatch(root, { llm: { active: hit.id } }, env));
    log.info(`聊天模型换成了：${hit.name}`);
    return `好，聊天模型换成「${hit.name}」了`;
  }
  return { handle };
}

function build({ root = ROOT, dataDir = path.join(root, "data"), env = process.env, fetch = globalThis.fetch, silent = false, now, random, sleep, linkGet = httpGet } = {}) {
  const created = ensureConfigFile(root);
  const config = loadConfig(root, env);
  const logFile = !silent && process.stdout.isTTY ? path.join(dataDir, "logs", "server.log") : "";
  const log = createLogger({ silent, file: logFile, getSecrets: () => [...config.providers.map((p) => p.apiKey), config.llm.apiKey, config.qq.token, config.notify.webhook] });
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  if (created) log.info("第一次运行，已从 config.example.json 生成 config.json");
  const usage = createUsage({ dataDir, now });
  const llm = createLLM({ config, log, fetch, usage });
  // personas 在下面才建好；namesFor 只在之后整理记忆时被调用
  const memory = createMemory({ dataDir, config, log, now, namesFor: (id) => personas.namesFor(id) });
  const vision = createVision({ config, llm, dataDir, log, fetch, now });
  const stickers = createStickers({ config, dataDir, vision, log, random, now });
  const search = createSearch({ config, log, fetch, now });
  const links = createLinkReader({ config, log, now, get: linkGet });
  const reminders = createReminders({ dataDir, log, now });
  const diary = createDiary({ config, dataDir, memory, llm, log, now });
  const voice = createVoice({ config, log, fetch });
  const brain = createBrain({ config, memory, llm, dataDir, log, stickers, search, reminders, diary, voice, now, random });
  const compressJob = createCompressJob({ memory, llm, log, now });
  const personas = createPersonas({ config, dataDir, memory, llm, log, now });
  // onebot 和 watchdog 在下面才建好；这两个函数只在之后被调用
  const digest = createGroupDigest({
    config,
    dataDir,
    llm,
    memory,
    log,
    now,
    deliver: (text) => onebot.sendToOwner(text),
    listGroups: async () => (await onebot.callApi("get_group_list", {})).data || [],
  });
  const commands = createCommands({ root, config, llm, log, env, compressJob, digest, memory, reminders });
  const onebot = createOneBot({ config, brain, log, vision, stickers, commands, digest, links, voice, fetch, now, random, sleep });
  const notify = createNotifier({ config, log, fetch });
  const watchdog = createWatchdog({ config, onebot, notify, log, now });
  const app = createApp({ root, config, log, memory, brain, llm, onebot, watchdog, vision, stickers, search, compressJob, digest, personas, reminders, links, usage, diary, voice, dataDir, now });
  return { config, log, llm, memory, vision, stickers, search, brain, onebot, watchdog, compressJob, digest, personas, reminders, links, usage, diary, voice, app };
}

/**
 * 提醒：到点就按好友的口吻发消息；模型出问题就发纯文字，保证一定发出去。
 * QQ 掉线时先留着，回来了再补。一次性提醒过了 12 小时算错过；重复提醒只补最近一次，太久的直接排下一次。
 * @returns {Promise<number>} 这次发出去几条
 */
async function checkReminders({ config, reminders, onebot, memory, watchdog, log }, t = Date.now()) {
  if (!config.qq.enabled || !config.owner.qq.length) return 0;
  let sent = 0;
  for (const r of reminders.due(t)) {
    const late = t - (r.repeat ? lastAt(r.repeat, t) : r.at);
    if (late > REMINDER_LATE_LIMIT_MS) {
      if (r.repeat) reminders.reschedule(r.id, t);
      else reminders.markMissed(r.id, t);
      continue;
    }
    if (watchdog.status().online === false) continue;
    reminders.begin(r.id);
    try {
      const lateNote = late > 3 * 60000 ? `本来应该 ${whenText(r)} 提醒的，现在晚了 ${fmtGap(late)}，顺口说一声。` : "";
      const note = `现在到点了，你之前答应要提醒对方：「${r.text}」。${lateNote}发 1~2 条消息把这件事说清楚，像朋友那样自然。`;
      let ok = false;
      if (!r.attempts) {
        try {
          ok = await onebot.sendProactive({ note });
        } catch (e) {
          log.warn("提醒用模型写失败，改发纯文字：" + (e.friendly || e.message));
        }
      }
      if (!ok) {
        const text = `到点啦：${r.text}`;
        ok = await onebot.sendToOwner(text);
        if (ok) memory.append("main", { role: "assistant", text, ts: t });
      }
      if (ok) {
        reminders.markFired(r.id, t);
        sent++;
      } else reminders.markFailed(r.id, t);
    } finally {
      reminders.end(r.id);
    }
  }
  return sent;
}

/** 日记：到点写今天的，顺便补写最近几天漏掉的（服务当晚没开的时候） */
function checkDiary({ diary }, t = Date.now()) {
  const days = diary.due(t);
  return days.length ? diary.start(days).promise : null;
}

function startDiary(ctx) {
  const run = () => {
    try {
      const r = checkDiary(ctx);
      if (r) r.catch((e) => ctx.log.warn("写日记失败：" + e.message));
    } catch (e) {
      ctx.log.warn("写日记失败：" + e.message);
    }
  };
  const first = setTimeout(run, 60 * 1000); // 启动一分钟后补写漏掉的
  const timer = setInterval(run, 10 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
}

function startReminders(ctx) {
  const timer = setInterval(() => {
    checkReminders(ctx).catch((e) => ctx.log.warn("发提醒失败：" + e.message));
  }, 20 * 1000);
  if (timer.unref) timer.unref();
}

/**
 * 群聊总结：每天到了设定的时间（默认 21:00）总结一次勾选的群，发到主人 QQ。每天最多一次。
 * 新消息不够 minMessages 条的群这次跳过，留到下次一起说。
 */
function checkGroupDigest({ config, digest, watchdog }, t = Date.now()) {
  const g = config.groupDigest;
  if (!g.enabled || !g.daily || !g.groups.length || !config.qq.enabled || !config.owner.qq.length) return null;
  if (watchdog.status().online === false) return null; // QQ 掉线时先不做，回来了再说
  const [hh, mm] = g.time.split(":").map(Number);
  const d = new Date(t);
  if (d.getHours() * 60 + d.getMinutes() < hh * 60 + mm) return null;
  const today = ymd(t);
  if (digest.lastDaily() === today) return null;
  digest.markDaily(today);
  return digest.start({ send: true }).promise;
}

function startGroupDigest(ctx) {
  const timer = setInterval(() => {
    try {
      const r = checkGroupDigest(ctx);
      if (r) r.catch((e) => ctx.log.warn("群聊总结失败：" + e.message));
    } catch (e) {
      ctx.log.warn("群聊总结失败：" + e.message);
    }
  }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

/**
 * 按记忆主动关心：每 10 分钟看一眼「对方的安排」，到点了就发一条（默认开）。
 *   前一天 20 点后：打打气；当天 19 点后 / 第二天：问问结果。每个安排每种最多一次。
 * 正聊着（90 分钟内说过话）不打扰，因为聊天时它自己会看到这些安排。
 */
function checkFollowUp({ config, brain, onebot, memory, watchdog, log }, t = Date.now(), random = Math.random) {
  const p = config.proactive;
  if (!p.followUp || !config.qq.enabled || !config.owner.qq.length) return null;
  if (watchdog.status().online === false) return null;
  const h = new Date(t).getHours();
  if (h < Math.min(p.from, 10) || h >= Math.max(p.to, 22)) return null;
  const st = brain.getState("main");
  const last = Math.max(st.lastUserAt || 0, st.lastReplyAt || 0);
  if (t - last < 90 * 60 * 1000 || t - (st.lastProactiveAt || 0) < 3 * 3600 * 1000) return null;
  const due = memory.dueFollowUp("main", t);
  if (!due || random() > 0.5) return null; // 不卡整点，更像人
  return (async () => {
    const ok = await onebot.sendProactive({ note: due.note });
    if (ok) {
      memory.markFollowUp("main", due.event.id, due.stage, t);
      log.info(`主动关心了：${due.event.text}（${due.stage === "before" ? "前一晚打气" : "问结果"}）`);
    }
    return ok;
  })();
}

function startFollowUp(ctx) {
  const timer = setInterval(() => {
    try {
      const r = checkFollowUp(ctx);
      if (r) r.catch((e) => ctx.log.warn("主动关心失败：" + e.message));
    } catch (e) {
      ctx.log.warn("主动关心失败：" + e.message);
    }
  }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

/** 主动聊天：每 15 分钟看一眼，满足条件才发（默认关闭） */
function startProactive({ config, brain, onebot, log, watchdog }) {
  const timer = setInterval(async () => {
    try {
      const p = config.proactive;
      if (!p.enabled || !config.qq.enabled || !config.owner.qq.length) return;
      if (watchdog.status().online === false) return;
      const h = new Date().getHours();
      if (h < p.from || h >= p.to) return;
      const st = brain.getState("main");
      const quiet = p.quietHours * 3600 * 1000;
      const last = Math.max(st.lastUserAt || 0, st.lastReplyAt || 0);
      if (Date.now() - last < quiet || Date.now() - (st.lastProactiveAt || 0) < quiet) return;
      if (Math.random() > 0.35) return; // 别每次都卡着整点发，更像人
      await onebot.sendProactive();
    } catch (e) {
      log.warn("主动消息失败：" + e.message);
    }
  }, 15 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function main() {
  const dataDir = path.join(ROOT, "data");
  rotateLog(dataDir);
  // 上次在网页上选了「恢复备份」的话，要赶在读任何数据之前换好
  applyPendingRestore({ root: ROOT, dataDir, version: VERSION, log: { info: (m) => console.log(m), error: (m) => console.error(m) } });
  const ctx = build({ root: ROOT, dataDir });
  const { config, log, app, watchdog, llm } = ctx;
  const server = app.server;

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(`端口 ${config.port} 被占用了。最常见的原因：旧版 AI 好友或者上一次的服务还开着。`);
      log.error("处理办法：关掉旧的黑窗口 / 运行「一键关闭.bat」，或者在 config.json 里把 port 改成别的数字（NapCat 的上报地址也要跟着改）。");
    } else {
      log.error("启动失败：" + err.message);
    }
    process.exit(1);
  });

  server.listen(config.port, HOST, () => {
    log.info(`AI 好友 v${VERSION} 已启动：http://${HOST}:${config.port}/`);
    if (process.env.AIF_OPEN === "1" && process.platform === "win32") {
      require("node:child_process").exec(`start "" "http://${HOST}:${config.port}/"`, () => {});
    }
    log.info(`好友：${config.friend.name}（${config.friend.style}）；聊天模型：${(llm.current() || {}).name || "未设置"}（已添加 ${config.providers.length} 个模型）`);
    try {
      ctx.stickers.importLegacy();
    } catch (e) {
      log.warn("导入旧版表情包失败：" + e.message);
    }
    log.info(`表情包库：${ctx.stickers.count()} 张；看图：${ctx.vision.enabled() ? "开（" + ctx.vision.stats().model + "）" : "关"}；联网搜索：${config.search.enabled ? "开" : "关"}`);
    if (!llm.enabled()) log.warn("还没有可用的大模型，现在只能简单回复。打开网页 →「模型」页添加一个并填 Key");
    startDiary(ctx); // 日记不靠 QQ，只开网页也写
    if (config.qq.enabled) {
      log.info(`QQ：等待 NapCat 把消息发到 http://${HOST}:${config.port}/onebot；发消息走 ${config.qq.apiBase}`);
      if (!config.owner.qq.length) log.warn("还没设置主人 QQ，建议在网页「设置」里填上");
      watchdog.start(60000);
      startProactive(ctx);
      startFollowUp(ctx);
      startGroupDigest(ctx);
      startReminders(ctx);
    }
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log.info("正在关闭…");
    watchdog.stop();
    ctx.vision.flush();
    ctx.usage.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) main();

module.exports = { build, checkFollowUp, checkGroupDigest, checkReminders, checkDiary, ROOT, HOST };
