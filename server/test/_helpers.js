"use strict";
/*
 * 测试工具：在临时目录里搭一个完整的服务，大模型与 NapCat 都用假的（不联网、不碰真实 data/）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("../server");

const ROOT = path.resolve(__dirname, "..", "..");

function makeRoot(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aif-"));
  fs.symlinkSync(path.join(ROOT, "web"), path.join(root, "web"), "junction");
  fs.copyFileSync(path.join(ROOT, "config.example.json"), path.join(root, "config.example.json"));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const merged = deepMerge(base, config);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(merged, null, 2));
  return root;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? deepMerge(a[k], v) : v;
  }
  return out;
}

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj };
}

/**
 * 假网络。llm(messages, body) 返回模型要说的文本；onebot(action, params) 返回 data。
 */
function fakeNet({ llm = () => "〔想〕嗯\n〔心情〕平静\n好呀", onebot = () => ({}), files = {}, web = null } = {}) {
  const calls = { llm: [], onebot: [], files: [], web: [] };
  async function fetch(url, opts = {}) {
    if (files[url]) {
      calls.files.push(url);
      const buf = files[url];
      return { ok: true, status: 200, headers: { get: () => "image/gif" }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
    }
    if (web && !String(url).startsWith("http://127.0.0.1:3000") && !String(url).endsWith("/chat/completions")) {
      calls.web.push(url);
      const r = await web(String(url));
      const buf = Buffer.from(r === null ? "" : r, "utf8");
      return { ok: r !== null, status: r === null ? 500 : 200, headers: { get: () => "text/html; charset=utf-8" }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), text: async () => String(r) };
    }
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url).endsWith("/chat/completions")) {
      calls.llm.push(body);
      const out = await llm(body.messages, body);
      if (out && out.__status) return jsonResponse({ error: "x" }, out.__status);
      return jsonResponse({ choices: [{ message: { content: out } }] });
    }
    const action = String(url).split("/").pop();
    calls.onebot.push({ action, params: body, headers: opts.headers });
    const data = await onebot(action, body);
    return jsonResponse({ status: "ok", retcode: 0, data });
  }
  return { fetch, calls };
}

async function start({ config = {}, net = fakeNet(), now, random = () => 0.5 } = {}) {
  const root = makeRoot(config);
  const ctx = build({ root, dataDir: path.join(root, "data"), env: {}, fetch: net.fetch, silent: true, now, random, sleep: async () => {} });
  await new Promise((r) => ctx.app.server.listen(0, "127.0.0.1", r));
  ctx.app.server.unref(); // 测试失败时也不会卡住进程
  const port = ctx.app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await globalThis.fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const close = () => new Promise((r) => ctx.app.server.close(r));
  return { ...ctx, root, port, base, api, close, net };
}

module.exports = { start, fakeNet, makeRoot };
