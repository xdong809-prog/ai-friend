"use strict";
/*
 * HTTP 小工具 + 本机访问守卫。
 * 守卫的两道检查：
 *   1) Host 白名单：防 DNS rebinding，也防内网穿透把整个服务暴露出去；
 *   2) Origin 校验：别的网站在浏览器里发来的跨站请求一律拒绝。
 * 这样即使服务开着，你浏览的其他网页也读不到聊天记录、改不了配置。
 */

function readBody(req, { limit = 256 * 1024, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("请求超时"), { status: 408 })), timeoutMs);
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.resume();
        finish(Object.assign(new Error("请求太大"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => finish(Object.assign(e, { status: 400 })));
  });
}

async function readJsonBody(req, opts) {
  const raw = await readBody(req, opts);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("不是合法的 JSON"), { status: 400 });
  }
}

function send(res, status, body, type) {
  if (res.headersSent) return;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buf);
}

const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
const sendText = (res, status, text) => send(res, status, text, "text/plain; charset=utf-8");

function createLocalGuard({ getPort, publicPaths = [] } = {}) {
  const PUBLIC = new Set(publicPaths);
  function hosts() {
    const p = getPort();
    return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  }
  function check(req, pathname) {
    if (PUBLIC.has(pathname)) return { ok: true };
    const allowed = hosts();
    const host = String(req.headers.host || "").toLowerCase();
    if (!allowed.has(host)) return { ok: false, status: 403, error: "只允许在本机访问" };
    const origin = req.headers.origin;
    if (origin === undefined) return { ok: true };
    if (origin === "null") return { ok: false, status: 403, error: "请用 http://127.0.0.1 地址打开网页" };
    let u;
    try {
      u = new URL(origin);
    } catch {
      return { ok: false, status: 403, error: "来源不合法" };
    }
    if (!allowed.has(u.host.toLowerCase())) return { ok: false, status: 403, error: "拒绝了来自其他网站的请求" };
    return { ok: true, origin };
  }
  return { check };
}

module.exports = { readBody, readJsonBody, send, sendJson, sendText, createLocalGuard };
