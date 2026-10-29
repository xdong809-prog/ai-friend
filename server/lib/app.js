"use strict";
/*
 * HTTP 路由。所有接口只在本机可用（见 http.js 的守卫），/onebot 额外校验 NapCat 签名。
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { readBody, readJsonBody, sendJson, sendText, send, createLocalGuard } = require("./http");
const { savePatch, publicConfig, replaceInPlace } = require("./config");
const { STYLES } = require("./persona");
const { facesToText } = require("./humanize");
const { FACE_NAMES_FOR_PROMPT } = require("./qqfaces");
const { PRESETS, presetOf } = require("./presets");
const { friendlyError } = require("./llm");

const VERSION = "4.6.0";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function createApp({ root, config, log, memory, brain, llm, onebot, watchdog, vision = null, stickers = null, search = null, compressJob = null, digest = null, now = Date.now }) {
  const webDir = path.join(root, "web");
  let server;
  const guard = createLocalGuard({
    getPort: () => (server && server.address() && server.address().port) || config.port,
    publicPaths: [],
  });
  const startedAt = now();

  function health() {
    const st = brain.getState("main");
    return {
      ok: true,
      version: VERSION,
      uptimeSec: Math.round((now() - startedAt) / 1000),
      friend: { name: config.friend.name, style: config.friend.style, mood: st.mood },
      llm: { enabled: llm.enabled(), model: (llm.current() || {}).name || "", ...llm.stats() },
      qq: { enabled: config.qq.enabled, ...watchdog.status(), ...onebot.stats(), owners: config.owner.qq.length },
      vision: vision ? vision.stats() : { enabled: false },
      stickers: { enabled: config.stickers.enabled, count: stickers ? stickers.count() : 0 },
      search: { enabled: config.search.enabled, ...(search ? search.stats() : {}) },
    };
  }

  /** 网页提交的「模型草稿」：Key 留空时沿用已保存的同 id 那一项 */
  function draftProvider(b) {
    const saved = config.providers.find((p) => p.id === b.id) || {};
    const d = b.draft && typeof b.draft === "object" ? b.draft : {};
    const preset = presetOf(d.preset || saved.preset) || {};
    return {
      id: saved.id || "draft",
      name: d.name || saved.name || preset.name || "测试",
      preset: d.preset || saved.preset || "custom",
      baseUrl: String(d.baseUrl || saved.baseUrl || preset.baseUrl || "").replace(/\/+$/, ""),
      apiKey: d.apiKey && d.apiKey !== "__clear__" ? String(d.apiKey) : saved.apiKey || "",
      model: String(d.model || saved.model || ""),
      noTemperature: typeof d.noTemperature === "boolean" ? d.noTemperature : Boolean(saved.noTemperature || preset.noTemperature),
    };
  }

  /** 回复里的表情包换成网页能显示的图片地址 */
  function webParts(parts) {
    return (parts || []).map((p) => (p.type === "sticker" ? { type: "sticker", url: `/api/stickers/${p.id}`, keyword: p.keyword } : { type: "text", text: facesToText(p.text) }));
  }

  async function serveStatic(req, res, pathname) {
    let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (rel.includes("\0") || rel.includes("..")) return sendText(res, 404, "没有这个页面");
    const file = path.join(webDir, rel);
    if (!file.startsWith(webDir + path.sep)) return sendText(res, 404, "没有这个页面");
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(webDir) + path.sep) || !fs.statSync(real).isFile()) throw new Error();
      const body = fs.readFileSync(real);
      return send(res, 200, req.method === "HEAD" ? Buffer.alloc(0) : body, MIME[path.extname(real)] || "application/octet-stream");
    } catch {
      return sendText(res, 404, "没有这个页面");
    }
  }

  const routes = {
    "GET /health": async () => health(),
    "GET /api/config": async () => ({
      config: publicConfig(config),
      styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label, group: s.group || "", defaultName: s.defaultName, persona: s.persona })),
      presets: PRESETS,
      current: llm.current(),
      faces: FACE_NAMES_FOR_PROMPT.split("、"),
      version: VERSION,
    }),
    "POST /api/config": async (req) => {
      const body = await readJsonBody(req);
      const next = savePatch(root, body);
      replaceInPlace(config, next);
      log.info("设置已保存");
      return { ok: true, config: publicConfig(config) };
    },
    "POST /api/test-llm": async () => {
      const t = now();
      try {
        const text = await llm.chat([{ role: "user", content: "用一句很短的话跟我打个招呼" }], { maxTokens: 200, timeoutMs: 30000, noFallback: true });
        return { ok: true, ms: now() - t, sample: text.slice(0, 60) };
      } catch (e) {
        return { ok: false, error: e.friendly || e.message };
      }
    },
    // 测试某个模型（已保存的用 id；还没保存的传 draft，Key 留空则沿用已保存的）
    "POST /api/models/test": async (req) => {
      const b = await readJsonBody(req);
      const p = draftProvider(b);
      if (!p.baseUrl || !p.model) return { ok: false, error: "先填接口地址和模型名" };
      const t = now();
      try {
        const text = await llm.chat([{ role: "user", content: "用一句很短的话跟我打个招呼" }], { provider: p, maxTokens: 300, timeoutMs: 40000, noFallback: true });
        return { ok: true, ms: now() - t, sample: text.slice(0, 80) };
      } catch (e) {
        return { ok: false, error: e.friendly || e.message };
      }
    },
    "POST /api/models/list": async (req) => {
      const b = await readJsonBody(req);
      const p = draftProvider(b);
      if (!p.baseUrl) return { ok: false, error: "先填接口地址" };
      try {
        return { ok: true, models: (await llm.listModels(p)).slice(0, 500) };
      } catch (e) {
        return { ok: false, error: e.status === 404 ? "这家服务商不提供模型列表，请按官网文档手动填模型名" : e.status === 401 ? "Key 不对" : friendlyError(e) };
      }
    },
    "POST /api/test-qq": async () => {
      const online = await watchdog.check();
      return { ok: online, ...watchdog.status() };
    },
    "POST /api/chat": async (req) => {
      const body = await readJsonBody(req);
      const texts = (Array.isArray(body.texts) ? body.texts : [body.text]).map((s) => String(s || "").slice(0, 2000)).filter((s) => s.trim());
      if (!texts.length) return { status: 400, body: { ok: false, error: "消息不能为空" } };
      const r = await brain.reply({ sessionId: "main", channel: "web", texts });
      return {
        ok: true,
        engine: r.engine,
        bubbles: r.bubbles.map(facesToText),
        parts: webParts(r.parts),
        firstDelayMs: r.firstDelayMs,
        delays: r.delays,
        mood: r.mood,
        search: r.searchInfo || null,
        thought: body.debug ? r.thought : undefined,
      };
    },
    "GET /api/stickers": async () => ({
      ok: true,
      count: stickers ? stickers.count() : 0,
      items: (stickers ? stickers.list() : [])
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
        .slice(0, 300)
        .map((s) => ({ id: s.id, url: `/api/stickers/${s.id}`, desc: s.desc, mood: s.mood, source: s.source, uses: s.uses || 0 })),
    }),
    "POST /api/stickers/remove": async (req) => {
      const b = await readJsonBody(req);
      return { ok: Boolean(stickers && stickers.remove(String(b.id || ""))) };
    },
    "GET /api/history": async (req, url) => {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
      const h = memory.history("main", limit);
      return { ok: true, total: h.total, messages: h.messages.map((m) => ({ role: m.role, text: facesToText(m.text), ts: m.ts })) };
    },
    "DELETE /api/history": async () => {
      memory.clearHistory("main");
      return { ok: true };
    },
    "GET /api/memory": async () => ({ ok: true, profile: memory.getProfile("main") }),
    // 压缩：用户自己点了才做。POST 开始（马上返回），GET 查进度和前后对比
    "GET /api/compress": async () => ({ ok: true, ...compressJob.status("main") }),
    "POST /api/compress": async (req) => {
      const b = await readJsonBody(req);
      if (!llm.enabled("memory")) return { status: 400, body: { ok: false, error: "还没有可用的大模型，压缩要靠大模型写摘要。先去「模型」页添加一个" } };
      const keepRecent = Math.max(4, Math.min(40, Number(b.keepRecent) || 10));
      const { already } = compressJob.start("main", { keepRecent, tidy: b.tidy !== false, archive: b.archive !== false });
      return { ok: true, already, ...compressJob.status("main") };
    },
    "POST /api/compress/restore": async () => {
      if (compressJob.status("main").running) return { status: 409, body: { ok: false, error: "正在压缩，等它做完再恢复" } };
      const n = memory.restoreArchives("main");
      return { ok: true, restored: n, ...compressJob.status("main") };
    },
    // 群聊总结：群列表（带是否勾选、有几条新消息）；开关和勾选走 POST /api/config 的 groupDigest
    "GET /api/groups": async () => ({ ok: true, ...(await digest.groups()) }),
    "GET /api/groups/digest": async () => ({ ok: true, ...digest.status(), recent: digest.recent(30) }),
    "POST /api/groups/digest": async (req) => {
      const b = await readJsonBody(req);
      const g = config.groupDigest;
      if (!g.enabled || !g.groups.length) return { status: 400, body: { ok: false, error: "先打开群聊总结，并勾选要总结的群" } };
      if (!llm.enabled("memory")) return { status: 400, body: { ok: false, error: "还没有可用的大模型，总结要靠大模型来写。先去「模型」页添加一个" } };
      const { already } = digest.start({ force: true, send: b.send !== false });
      return { ok: true, already, ...digest.status(), recent: digest.recent(30) };
    },
    "POST /api/groups/clear": async () => {
      if (digest.status().running) return { status: 409, body: { ok: false, error: "正在总结，等它做完再删" } };
      return { ok: true, removed: digest.clear() };
    },
    "POST /api/memory": async (req) => {
      const b = await readJsonBody(req);
      const id = "main";
      switch (b.op) {
        case "addFact":
          memory.applyOps(id, { add: [String(b.text || "")] });
          break;
        case "removeFact":
          memory.applyOps(id, { remove: [String(b.text || "")] });
          break;
        case "setBasic":
          memory.applyOps(id, { set: { [String(b.key || "")]: String(b.value || "") } });
          break;
        case "removeBasic":
          memory.applyOps(id, { set: { [String(b.key || "")]: "" } });
          break;
        case "addEvent":
          memory.applyOps(id, { events: [{ text: String(b.text || ""), date: String(b.date || "") }] });
          break;
        case "removeEvent":
          memory.applyOps(id, { removeEvents: [String(b.id || "")] });
          break;
        case "setSummary":
          memory.applyOps(id, { summary: String(b.text || "") });
          break;
        case "organize":
          try {
            await memory.maybeExtract(id, llm, { force: true });
          } catch (e) {
            return { status: 502, body: { ok: false, error: e.friendly || e.message } };
          }
          break;
        default:
          return { status: 400, body: { ok: false, error: "不认识的操作" } };
      }
      return { ok: true, profile: memory.getProfile(id) };
    },
  };

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return sendText(res, 400, "地址不对");
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/onebot") {
      if (req.method !== "POST") return sendText(res, 405, "只接受 POST");
      const host = String(req.headers.host || "").toLowerCase();
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return sendText(res, 403, "只允许本机");
      const raw = await readBody(req, { limit: 2 * 1024 * 1024 });
      const r = onebot.accept(req.headers, raw);
      if (r.status === 204) {
        res.writeHead(204);
        return res.end();
      }
      return sendJson(res, r.status, { ok: false, error: r.error });
    }

    const verdict = guard.check(req, pathname);
    if (!verdict.ok) return sendJson(res, verdict.status, { ok: false, error: verdict.error });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const stickerMatch = /^\/api\/stickers\/([a-f0-9]{40})$/.exec(pathname);
    if (stickerMatch && (req.method === "GET" || req.method === "HEAD")) {
      const p = stickers && stickers.filePath(stickerMatch[1]);
      if (!p) return sendText(res, 404, "没有这张表情包");
      return send(res, 200, req.method === "HEAD" ? Buffer.alloc(0) : fs.readFileSync(p), MIME[path.extname(p)] || "application/octet-stream");
    }

    const route = routes[`${req.method === "HEAD" ? "GET" : req.method} ${pathname}`];
    if (route) {
      const out = await route(req, url);
      if (out && out.status && out.body) return sendJson(res, out.status, out.body);
      return sendJson(res, 200, out);
    }
    if (pathname.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: "没有这个接口" });
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
    return sendText(res, 405, "不支持的请求方式");
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error("处理请求出错：" + (err.stack || err.message));
      if (!res.headersSent) sendJson(res, err.status || 500, { ok: false, error: err.status ? err.message : "服务器内部错误" });
    });
  });
  return { server, health, VERSION };
}

module.exports = { createApp, VERSION };
