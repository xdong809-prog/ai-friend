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
const { createMemory } = require("./lib/memory");
const { createBrain } = require("./lib/brain");
const { createOneBot } = require("./lib/onebot");
const { createWatchdog, createNotifier } = require("./lib/watchdog");
const { createVision } = require("./lib/vision");
const { createStickers } = require("./lib/stickers");
const { createSearch } = require("./lib/search");
const { createApp, VERSION } = require("./lib/app");

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
 */
function createCommands({ root, config, llm, log, env }) {
  const { savePatch, replaceInPlace } = require("./lib/config");
  function handle(text) {
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

function build({ root = ROOT, dataDir = path.join(root, "data"), env = process.env, fetch = globalThis.fetch, silent = false, now, random, sleep } = {}) {
  const created = ensureConfigFile(root);
  const config = loadConfig(root, env);
  const logFile = !silent && process.stdout.isTTY ? path.join(dataDir, "logs", "server.log") : "";
  const log = createLogger({ silent, file: logFile, getSecrets: () => [...config.providers.map((p) => p.apiKey), config.llm.apiKey, config.qq.token, config.notify.webhook] });
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  if (created) log.info("第一次运行，已从 config.example.json 生成 config.json");
  const llm = createLLM({ config, log, fetch });
  const memory = createMemory({ dataDir, config, log, now });
  const vision = createVision({ config, llm, dataDir, log, fetch, now });
  const stickers = createStickers({ config, dataDir, vision, log, random, now });
  const search = createSearch({ config, log, fetch, now });
  const brain = createBrain({ config, memory, llm, dataDir, log, stickers, search, now, random });
  const commands = createCommands({ root, config, llm, log, env });
  const onebot = createOneBot({ config, brain, log, vision, stickers, commands, fetch, now, random, sleep });
  const notify = createNotifier({ config, log, fetch });
  const watchdog = createWatchdog({ config, onebot, notify, log, now });
  const app = createApp({ root, config, log, memory, brain, llm, onebot, watchdog, vision, stickers, search, now });
  return { config, log, llm, memory, vision, stickers, search, brain, onebot, watchdog, app };
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
    if (config.qq.enabled) {
      log.info(`QQ：等待 NapCat 把消息发到 http://${HOST}:${config.port}/onebot；发消息走 ${config.qq.apiBase}`);
      if (!config.owner.qq.length) log.warn("还没设置主人 QQ，建议在网页「设置」里填上");
      watchdog.start(60000);
      startProactive(ctx);
      startFollowUp(ctx);
    }
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log.info("正在关闭…");
    watchdog.stop();
    ctx.vision.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) main();

module.exports = { build, checkFollowUp, ROOT, HOST };
