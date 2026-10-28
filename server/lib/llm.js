"use strict";
/*
 * 大模型客户端：支持同时配置多个服务商（都走 OpenAI 兼容的 /chat/completions）。
 *   - 用途分工：chat（聊天）、memory（整理记忆/压缩摘要）、vision（看图），各自可以选不同的模型；
 *   - 聊天模型失败时自动换「备用模型」；
 *   - 自动适配各家的小差异：不接受 temperature（Claude 新模型）、要用 max_completion_tokens（部分 GPT）、
 *     不支持 JSON 模式……遇到对应报错会调整参数重试一次，并记住，下次直接用对的参数；
 *   - 自动去掉推理模型输出里的 <think>…</think>；
 *   - 记录 DeepSeek 等的前缀缓存命中量。
 */
const { presetOf, isLocalUrl } = require("./presets");

function friendlyError(err) {
  if (!err) return "未知错误";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "大模型响应超时";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(String(err.message || "") + String(err.cause && err.cause.code))) {
    return "连不上大模型接口（检查网络；国外的服务需要能访问国外网络）";
  }
  if (err.status === 401 || err.status === 403) return "API Key 无效或没有权限";
  if (err.status === 402) return "账户余额不足";
  if (err.status === 404) return "接口地址或模型名不对";
  if (err.status === 429) return "请求太频繁或额度用完了";
  return String(err.message || err).slice(0, 160);
}

function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

/** 模型显示名：「Kimi · kimi-k3」 */
function labelOf(p, model) {
  if (!p) return "";
  return model && model !== p.model ? `${p.name}（${model}）` : p.name;
}

function createLLM({ config, log, fetch = globalThis.fetch }) {
  const stats = { ok: 0, fail: 0, lastError: "", lastOkAt: 0, lastMs: 0, lastModel: "", promptTokens: 0, cacheHitTokens: 0, completionTokens: 0 };
  /** 运行中学到的「这家不认某个参数」 */
  const quirks = new Map();

  function providerById(id) {
    return config.providers.find((p) => p.id === id) || null;
  }

  function usable(p) {
    if (!p || !p.baseUrl || !p.model) return false;
    const preset = presetOf(p.preset);
    return Boolean(p.apiKey || isLocalUrl(p.baseUrl) || (preset && preset.noKey));
  }

  /** 某个用途实际用哪个模型：{provider, model} */
  function resolve(use = "chat") {
    const l = config.llm;
    if (use === "vision") {
      const p = providerById(l.visionProvider) || providerById(l.active);
      if (!p) return null;
      const preset = presetOf(p.preset);
      const model = (l.visionProvider && l.visionModel) || (preset && preset.vision[0]) || p.model;
      return { provider: p, model };
    }
    if (use === "memory") {
      const p = (usable(providerById(l.memoryProvider)) && providerById(l.memoryProvider)) || providerById(l.active);
      return p ? { provider: p, model: p.model } : null;
    }
    const p = providerById(l.active);
    return p ? { provider: p, model: p.model } : null;
  }

  function enabled(use = "chat") {
    const r = resolve(use);
    return Boolean(r && usable(r.provider));
  }

  function current() {
    const r = resolve("chat");
    return r ? { id: r.provider.id, name: labelOf(r.provider, r.model), model: r.model } : null;
  }

  async function once(provider, model, messages, o) {
    const q = quirks.get(provider.id) || {};
    const body = { model, messages, stream: false };
    if (!provider.noTemperature && !q.noTemperature && o.temperature !== undefined) body.temperature = o.temperature;
    if (q.maxCompletion) body.max_completion_tokens = o.maxTokens;
    else body.max_tokens = o.maxTokens;
    if (o.json && !q.noJson) body.response_format = { type: "json_object" };
    const headers = { "Content-Type": "application/json" };
    if (provider.apiKey) headers.Authorization = "Bearer " + provider.apiKey;
    if (provider.preset === "openrouter") {
      headers["HTTP-Referer"] = "http://127.0.0.1";
      headers["X-Title"] = "AI Friend";
    }
    const res = await fetch(provider.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}：${raw.slice(0, 200)}`);
      err.status = res.status;
      err.body = raw;
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("大模型返回的不是 JSON");
    }
    const choice = data && data.choices && data.choices[0];
    let content = (choice && choice.message && choice.message.content) || (choice && choice.text) || "";
    if (Array.isArray(content)) content = content.map((c) => (typeof c === "string" ? c : c.text || "")).join("");
    content = stripThink(content);
    if (!content) throw new Error("大模型返回了空内容（推理模型可能把字数用在思考上了，可以调大「最长回复」）");
    const u = data.usage || {};
    stats.promptTokens += Number(u.prompt_tokens) || 0;
    stats.cacheHitTokens += Number(u.prompt_cache_hit_tokens) || Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
    stats.completionTokens += Number(u.completion_tokens) || 0;
    return content;
  }

  /** 根据报错调整参数：返回 true 表示值得用新参数再试一次 */
  function adapt(provider, err) {
    if (err.status !== 400 && err.status !== 422) return false;
    const text = String(err.body || err.message).toLowerCase();
    const q = { ...(quirks.get(provider.id) || {}) };
    let changed = false;
    if (/temperature/.test(text) && !q.noTemperature) {
      q.noTemperature = true;
      changed = true;
    }
    if (/max_tokens/.test(text) && /max_completion_tokens|not supported|unsupported/.test(text) && !q.maxCompletion) {
      q.maxCompletion = true;
      changed = true;
    }
    if (/response_format|json_object|json mode/.test(text) && !q.noJson) {
      q.noJson = true;
      changed = true;
    }
    if (changed) {
      quirks.set(provider.id, q);
      log.info(`「${provider.name}」不支持某些参数，已自动调整（${Object.keys(q).join("、")}）`);
    }
    return changed;
  }

  function transient(err) {
    return err.retryable || err.name === "TimeoutError" || err.name === "AbortError" || /fetch failed|ECONNRESET|socket/i.test(String(err.message));
  }

  async function attempt(provider, model, messages, o) {
    for (let i = 0; i < 3; i++) {
      try {
        return await once(provider, model, messages, o);
      } catch (err) {
        if (i < 2 && adapt(provider, err)) continue;
        if (i === 0 && transient(err)) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }
        throw err;
      }
    }
    throw new Error("重试次数用完");
  }

  /**
   * @param {{role:string, content:any}[]} messages
   * @param {{use?:"chat"|"memory"|"vision", provider?:object, model?:string, temperature?:number, maxTokens?:number, timeoutMs?:number, json?:boolean, noFallback?:boolean}} [o]
   */
  async function chat(messages, o = {}) {
    const use = o.use || "chat";
    let target = o.provider ? { provider: o.provider, model: o.model || o.provider.model } : resolve(use);
    if (target && o.model && !o.provider) target = { ...target, model: o.model };
    if (!target || !usable(target.provider)) throw Object.assign(new Error("还没有可用的大模型（去「模型」页添加一个并填 Key）"), { code: "NO_KEY", friendly: "还没有可用的大模型" });
    const opts = {
      temperature: o.temperature ?? config.llm.temperature,
      maxTokens: o.maxTokens ?? config.llm.maxTokens,
      timeoutMs: o.timeoutMs ?? config.llm.timeoutMs,
      json: Boolean(o.json),
    };
    const started = Date.now();
    try {
      const text = await attempt(target.provider, target.model, messages, opts);
      stats.ok++;
      stats.lastOkAt = Date.now();
      stats.lastMs = Date.now() - started;
      stats.lastError = "";
      stats.lastModel = labelOf(target.provider, target.model);
      return text;
    } catch (err) {
      // 聊天/整理记忆失败：换备用模型；整理记忆再不行就用聊天模型
      const backups = [];
      if (!o.noFallback && !o.provider && use !== "vision") {
        const fb = providerById(config.llm.fallback);
        if (fb && fb.id !== target.provider.id && usable(fb)) backups.push(fb);
        // 备用模型没设、或者和正在用的是同一个：随便找一个别的能用的顶上
        if (!backups.length) {
          const other = config.providers.find((p) => p.id !== target.provider.id && usable(p) && !(p.baseUrl === target.provider.baseUrl && p.model === target.model));
          if (other) backups.push(other);
        }
        const act = providerById(config.llm.active);
        if (use === "memory" && act && act.id !== target.provider.id && usable(act) && !backups.includes(act)) backups.push(act);
      }
      for (const b of backups) {
        log.warn(`「${labelOf(target.provider, target.model)}」失败（${friendlyError(err)}），改用「${b.name}」`);
        try {
          const text = await attempt(b, b.model, messages, opts);
          stats.ok++;
          stats.lastOkAt = Date.now();
          stats.lastModel = b.name;
          return text;
        } catch (err2) {
          err = err2;
        }
      }
      stats.fail++;
      stats.lastError = `${labelOf(target.provider, target.model)}：${friendlyError(err)}`;
      err.friendly = friendlyError(err);
      throw err;
    }
  }

  /** 问服务商有哪些模型（OpenAI 兼容的 GET /models） */
  async function listModels(provider) {
    const headers = {};
    if (provider.apiKey) headers.Authorization = "Bearer " + provider.apiKey;
    const res = await fetch(String(provider.baseUrl).replace(/\/+$/, "") + "/models", { headers, signal: AbortSignal.timeout(15000) });
    const raw = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}：${raw.slice(0, 160)}`), { status: res.status });
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("服务商返回的不是 JSON");
    }
    const list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return list
      .map((m) => (typeof m === "string" ? m : m.id || m.name || ""))
      .map((s) => String(s).replace(/^models\//, ""))
      .filter(Boolean)
      .sort();
  }

  return { chat, enabled, resolve, current, listModels, usable, stats: () => ({ ...stats }) };
}

/** 从模型输出里抠出第一个 JSON 对象（兼容外面包了 ```json 的情况） */
function parseJsonLoose(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { createLLM, friendlyError, stripThink, parseJsonLoose, labelOf };
