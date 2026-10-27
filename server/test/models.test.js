"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { start } = require("./_helpers");
const { normalizeConfig } = require("../lib/config");

function json(obj, status = 200) {
  const text = JSON.stringify(obj);
  return { ok: status < 400, status, text: async () => text, json: async () => obj, headers: { get: () => "application/json" } };
}

/** 假的多家服务商：按地址区分，记录每次请求 */
function multiNet(handlers) {
  const calls = [];
  async function fetch(url, opts = {}) {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, body, headers: opts.headers || {} });
    for (const [prefix, fn] of Object.entries(handlers)) if (u.startsWith(prefix)) return fn(u, body, opts);
    return json({ status: "ok", retcode: 0, data: {} });
  }
  return { fetch, calls };
}

const reply = (text) => json({ choices: [{ message: { content: text } }] });
const chatOrMemory = (text) => (u, body) => (body && body.messages && String(body.messages[0].content).includes("记忆整理") ? reply("{}") : reply(text));

const TWO = {
  providers: [
    { id: "ds", preset: "deepseek", apiKey: "sk-ds-1111111", model: "deepseek-chat" },
    { id: "kimi", preset: "moonshot", apiKey: "sk-kimi-22222", model: "kimi-k3" },
  ],
  llm: { active: "ds", fallback: "kimi" },
};

test("旧配置自动迁移成模型列表：原来的 Key、备用模型、看图都保留", () => {
  const c = normalizeConfig({ llm: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-old-123456", model: "deepseek-chat", fallbackModel: "deepseek-v4-pro" } });
  assert.deepEqual(
    c.providers.map((p) => [p.id, p.model, p.apiKey]),
    [
      ["deepseek", "deepseek-chat", "sk-old-123456"],
      ["deepseek-2", "deepseek-v4-pro", "sk-old-123456"],
    ]
  );
  assert.equal(c.llm.active, "deepseek");
  assert.equal(c.llm.fallback, "deepseek-2");
  assert.equal(c.llm.visionProvider, "deepseek");
});

test("切换聊天模型：请求发到新服务商，带它自己的 Key 和模型名", async () => {
  const net = multiNet({ "https://api.deepseek.com": chatOrMemory("〔想〕a\n〔心情〕平静\nDS回复"), "https://api.moonshot.cn": chatOrMemory("〔想〕b\n〔心情〕平静\nKimi回复") });
  const s = await start({ config: TWO, net });
  assert.deepEqual((await s.api("POST", "/api/chat", { text: "在吗" })).json.bubbles, ["DS回复"]);
  await s.api("POST", "/api/config", { llm: { active: "kimi" } });
  assert.deepEqual((await s.api("POST", "/api/chat", { text: "在吗" })).json.bubbles, ["Kimi回复"]);
  const k = net.calls.find((c) => c.url.startsWith("https://api.moonshot.cn/v1/chat/completions"));
  assert.equal(k.headers.Authorization, "Bearer sk-kimi-22222");
  assert.equal(k.body.model, "kimi-k3");
  await s.close();
});

test("聊天模型挂了：自动换备用模型，不会没人理", async () => {
  const net = multiNet({ "https://api.deepseek.com": () => json({ error: "boom" }, 500), "https://api.moonshot.cn": chatOrMemory("〔想〕b\n〔心情〕平静\n我在") });
  const s = await start({ config: TWO, net });
  const r = await s.api("POST", "/api/chat", { text: "在吗" });
  assert.equal(r.json.engine, "llm");
  assert.deepEqual(r.json.bubbles, ["我在"]);
  await s.close();
});

test("自动适配：服务商不认 temperature 时去掉它重试，并记住下次不再带", async () => {
  let n = 0;
  const net = multiNet({
    "https://api.anthropic.com": (u, body) => {
      n++;
      if ("temperature" in body) return json({ error: { message: "temperature: must be 1 for this model" } }, 400);
      return chatOrMemory("〔想〕a\n〔心情〕平静\nhello")(u, body);
    },
  });
  const s = await start({ config: { providers: [{ id: "c", preset: "custom", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-1234567", model: "claude-sonnet-5-5", noTemperature: false }], llm: { active: "c" } }, net });
  assert.deepEqual((await s.api("POST", "/api/chat", { text: "hi" })).json.bubbles, ["hello"]);
  const before = n;
  await s.api("POST", "/api/chat", { text: "hi again" });
  const chatCalls = net.calls.filter((c) => c.body && c.body.messages && !String(c.body.messages[0].content).includes("记忆整理")).slice(-1);
  assert.ok(!("temperature" in chatCalls[0].body));
  assert.ok(n - before <= 2, "第二轮不再先试一次带 temperature 的");
  await s.close();
});

test("Claude 预设默认不发 temperature", async () => {
  const net = multiNet({ "https://api.anthropic.com": chatOrMemory("〔想〕a\n〔心情〕平静\nhey") });
  const s = await start({ config: { providers: [{ id: "c", preset: "claude", apiKey: "sk-ant-1234567", model: "claude-sonnet-5-5" }], llm: { active: "c" } }, net });
  await s.api("POST", "/api/chat", { text: "hi" });
  const call = net.calls.find((c) => c.url.includes("/chat/completions"));
  assert.ok(!("temperature" in call.body));
  assert.equal(call.url, "https://api.anthropic.com/v1/chat/completions");
  await s.close();
});

test("本机 Ollama 不需要 Key 也能用", async () => {
  const net = multiNet({ "http://127.0.0.1:11434": chatOrMemory("〔想〕a\n〔心情〕平静\n本地模型在") });
  const s = await start({ config: { providers: [{ id: "o", preset: "ollama", model: "qwen3:8b" }], llm: { active: "o" } }, net });
  const r = await s.api("POST", "/api/chat", { text: "在吗" });
  assert.deepEqual(r.json.bubbles, ["本地模型在"]);
  assert.equal(net.calls.find((c) => c.url.includes("11434")).headers.Authorization, undefined);
  await s.close();
});

test("获取模型列表 / 测试连接：可以用还没保存的草稿，Key 留空时沿用已保存的", async () => {
  const net = multiNet({
    "https://api.moonshot.cn/v1/models": (u, b, opts) => (opts.headers.Authorization === "Bearer sk-kimi-22222" ? json({ data: [{ id: "kimi-k3" }, { id: "kimi-k3.1-pro" }] }) : json({}, 401)),
    "https://api.moonshot.cn/v1/chat": () => reply("你好呀"),
  });
  const s = await start({ config: TWO, net });
  const list = await s.api("POST", "/api/models/list", { id: "kimi", draft: { apiKey: "" } });
  assert.deepEqual(list.json.models, ["kimi-k3", "kimi-k3.1-pro"]);
  const bad = await s.api("POST", "/api/models/list", { draft: { preset: "moonshot", apiKey: "sk-wrong-0000" } });
  assert.equal(bad.json.ok, false);
  const t = await s.api("POST", "/api/models/test", { draft: { preset: "moonshot", apiKey: "sk-new-333333", model: "kimi-k3.1-pro" } });
  assert.equal(t.json.ok, true);
  assert.equal(net.calls.find((c) => c.url.endsWith("/chat/completions")).body.model, "kimi-k3.1-pro");
  await s.close();
});

test("看图用自己选的服务商，不受聊天模型切换影响", async () => {
  const net = multiNet({ "https://api.deepseek.com": chatOrMemory("x"), "https://api.moonshot.cn": chatOrMemory("x") });
  const s = await start({ config: { ...TWO, llm: { active: "kimi", visionProvider: "ds", visionModel: "deepseek-flash" } }, net });
  const r = s.llm.resolve("vision");
  assert.equal(r.provider.id, "ds");
  assert.equal(r.model, "deepseek-flash");
  await s.close();
});

test("QQ 指令「/模型」：列出模型、按编号或名字切换", async () => {
  const net = multiNet({ "https://api.deepseek.com": chatOrMemory("x"), "https://api.moonshot.cn": chatOrMemory("x") });
  const s = await start({ config: { ...TWO, owner: { qq: ["123456"] }, qq: { selfId: 10001, mergeWindowMs: 20 } }, net });
  const send = async (text) => {
    await s.api("POST", "/onebot", { post_type: "message", message_type: "private", self_id: 10001, user_id: 123456, message_id: Math.random(), message: [{ type: "text", data: { text } }] });
    await new Promise((r) => setTimeout(r, 80));
    const sent = net.calls.filter((c) => c.url.endsWith("/send_private_msg"));
    return sent[sent.length - 1].body.message[0].data.text;
  };
  assert.match(await send("/模型"), /1\. DeepSeek · deepseek-chat  ← 正在用[\s\S]*2\. Kimi · kimi-k3/);
  assert.match(await send("/模型 2"), /换成「Kimi · kimi-k3」/);
  assert.equal(s.config.llm.active, "kimi");
  assert.match(await send("/模型 deepseek"), /换成「DeepSeek/);
  const disk = JSON.parse(fs.readFileSync(path.join(s.root, "config.json"), "utf8"));
  assert.equal(disk.llm.active, "ds");
  assert.ok(!net.calls.some((c) => c.body && c.body.messages && String(c.body.messages[c.body.messages.length - 1].content).includes("/模型")), "指令不会发给大模型");
  await s.close();
});

test("风格：外国人风趣风格带示范对话；语言选项生效", async () => {
  let seen;
  const net = multiNet({ "https://api.deepseek.com": (u, b) => (String(b.messages[0].content).includes("记忆整理") ? reply("{}") : ((seen = b.messages), reply("〔想〕a\n〔心情〕平静\nlovely"))) });
  const s = await start({ config: { ...TWO, friend: { style: "brit", language: "mix" } }, net });
  await s.api("POST", "/api/chat", { text: "我迟到了" });
  assert.match(seen[0].content, /英国朋友/);
  assert.match(seen[0].content, /【你说话的感觉】[\s\S]*多么美好的一天开端/);
  assert.match(seen[0].content, /夹一些英文单词/);
  const styles = (await s.api("GET", "/api/config")).json.styles;
  assert.ok(styles.some((x) => x.id === "yankee" && x.group === "风趣外国人"));
  await s.close();
});
