"use strict";
/*
 * 配置：默认值 → config.json → 环境变量（只在运行期生效，永不写回文件）。
 * 保存时只读磁盘上的原文件、合并本次改动、原子写回，避免把环境变量里的 Key 写进文件。
 */
const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJsonAtomic, clamp } = require("./util");
const { PRESETS, presetOf, isLocalUrl } = require("./presets");

const DEFAULTS = {
  port: 8787,
  friend: {
    name: "小满",
    style: "gentle",
    customPrompt: "",
    userName: "",
    relationship: "认识挺久、无话不谈的好朋友",
    language: "",
  },
  /** 已添加的模型；每一项 = 服务商地址 + Key + 模型名 */
  providers: [],
  llm: {
    active: "", // 聊天用哪个（providers 里的 id）
    fallback: "", // 聊天失败时换哪个
    memoryProvider: "", // 整理记忆、压缩摘要用哪个（空 = 跟聊天一样）
    visionProvider: "", // 看图用哪个（空 = 跟聊天一样）
    visionModel: "", // 看图用的模型名（空 = 用推荐的看图模型）
    visionEnabled: true,
    temperature: 0.85,
    maxTokens: 1000,
    timeoutMs: 45000,
  },
  stickers: {
    enabled: true,
    collect: true,
    importFrom: "",
  },
  search: {
    enabled: true,
    sources: ["weather", "wiki", "bing", "sogou"],
    timeoutMs: 8000,
  },
  chat: {
    historyMessages: 60,
    historyChars: 14000,
    summaryTrigger: 50,
    keepRecent: 24,
    relevantSnippets: 4,
    extractEvery: 4,
  },
  humanize: {
    enabled: true,
    typingDelay: true,
    maxBubbles: 4,
    maxReplyDelayMs: 6000,
  },
  qq: {
    enabled: true,
    apiBase: "http://127.0.0.1:3000",
    token: "",
    inboundAuth: "auto",
    selfId: 0,
    private: true,
    group: true,
    groupAtOnly: true,
    groupAllowList: [],
    mergeWindowMs: 3000,
    mergeMaxMs: 20000,
    typingStatus: true,
    pokeBack: true,
    napcatLauncher: "",
    botQQ: "",
  },
  owner: {
    qq: [],
    onlyOwner: true,
  },
  proactive: {
    enabled: false,
    followUp: true,
    quietHours: 20,
    from: 10,
    to: 22,
  },
  notify: {
    desktop: true,
    webhook: "",
  },
  // 群聊总结：默认关，主人在网页上自己打开、勾选要总结的群
  groupDigest: {
    enabled: false,
    groups: [],
    daily: true,
    time: "21:00",
    minMessages: 10,
    keepDays: 7,
  },
};

const STYLE_IDS = Object.keys(require("./persona").STYLES);
const SECTIONS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "object");
/** 密钥字段：网页提交空值表示「不改」，提交 "__clear__" 表示清空 */
const SECRET_FIELDS = { qq: ["token"], notify: ["webhook"] };

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : d;
};
const str = (v, d, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : d);
const bool = (v, d) => (typeof v === "boolean" ? v : d);
/** "9:5" → "09:05"；不是合法时间就用默认值 */
const hhmm = (v, d) => {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || "").trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}` : d;
};
const idList = (v) =>
  (Array.isArray(v) ? v : String(v || "").split(/[\s,，;；]+/))
    .map((x) => String(x).trim())
    .filter((x) => /^\d{5,12}$/.test(x));

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}

/** 旧配置（llm.baseUrl/apiKey/model/fallbackModel）→ 新的 providers 列表 */
function migrateLegacy(rawLlm) {
  const l = isPlainObject(rawLlm) ? rawLlm : {};
  if (!l.apiKey && !l.baseUrl && !l.model) return null;
  const baseUrl = String(l.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const preset = PRESETS.find((p) => p.baseUrl && hostOf(p.baseUrl) === hostOf(baseUrl)) || presetOf("custom");
  const model = String(l.model || (preset.models[0] || ""));
  const list = [{ id: preset.id === "custom" ? "main" : preset.id, preset: preset.id, baseUrl, apiKey: String(l.apiKey || ""), model }];
  if (l.fallbackModel && l.fallbackModel !== model) list.push({ id: list[0].id + "-2", preset: preset.id, baseUrl, apiKey: String(l.apiKey || ""), model: String(l.fallbackModel) });
  return { list, active: list[0].id, fallback: list[1] ? list[1].id : "", visionModel: String(l.visionModel || "") };
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

function normProviders(list) {
  const out = [];
  const used = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!isPlainObject(p)) continue;
    const preset = presetOf(p.preset) || presetOf("custom");
    const baseUrl = str(p.baseUrl, preset.baseUrl, 300).replace(/\/+$/, "") || preset.baseUrl;
    const model = str(p.model, "", 120);
    if (!baseUrl) continue;
    let id = slug(p.id) || slug(preset.id) || "model";
    for (let i = 2; used.has(id); i++) id = `${slug(p.id) || preset.id}-${i}`;
    used.add(id);
    out.push({
      id,
      name: str(p.name, "", 40) || `${preset.name.replace(/（.*）/, "")}${model ? " · " + model : ""}`,
      preset: preset.id,
      baseUrl,
      apiKey: str(p.apiKey, "", 400),
      model,
      noTemperature: typeof p.noTemperature === "boolean" ? p.noTemperature : Boolean(preset.noTemperature),
    });
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeConfig(raw) {
  const src = isPlainObject(raw) ? { ...raw } : {};
  // 自动迁移：只有旧式的单个大模型配置时，转成 providers 列表
  if (!Array.isArray(src.providers) || !src.providers.length) {
    const m = migrateLegacy(src.llm);
    if (m) {
      src.providers = m.list;
      // 看图沿用原来的服务商（DeepSeek 用 deepseek-flash），以后换聊天模型也不影响看图
      src.llm = { ...(isPlainObject(src.llm) ? src.llm : {}), active: m.active, fallback: (src.llm && src.llm.fallback) || m.fallback, visionProvider: m.active, visionModel: m.visionModel || (src.llm && src.llm.visionModel) || "" };
    }
  }
  const c = deepMerge(DEFAULTS, src);
  c.providers = Array.isArray(src.providers) ? src.providers : [];
  const D = DEFAULTS;
  const providers = normProviders(c.providers);
  const ids = new Set(providers.map((p) => p.id));
  const pickId = (v) => (ids.has(String(v || "")) ? String(v) : "");
  return {
    port: num(c.port, D.port, 1, 65535),
    friend: {
      name: str(c.friend.name, D.friend.name, 16) || D.friend.name,
      style: STYLE_IDS.includes(c.friend.style) ? c.friend.style : D.friend.style,
      customPrompt: str(c.friend.customPrompt, "", 1500),
      userName: str(c.friend.userName, "", 16),
      relationship: str(c.friend.relationship, D.friend.relationship, 60) || D.friend.relationship,
      language: ["", "zh", "mix", "en"].includes(c.friend.language) ? c.friend.language : "",
    },
    providers,
    llm: {
      active: pickId(c.llm.active) || (providers[0] && providers[0].id) || "",
      fallback: pickId(c.llm.fallback),
      memoryProvider: pickId(c.llm.memoryProvider),
      visionProvider: pickId(c.llm.visionProvider),
      visionModel: str(c.llm.visionModel, "", 120),
      visionEnabled: bool(c.llm.visionEnabled, true),
      temperature: num(c.llm.temperature, D.llm.temperature, 0, 1.5),
      maxTokens: num(c.llm.maxTokens, D.llm.maxTokens, 100, 8000),
      timeoutMs: num(c.llm.timeoutMs, D.llm.timeoutMs, 3000, 180000),
    },
    stickers: {
      enabled: bool(c.stickers.enabled, true),
      collect: bool(c.stickers.collect, true),
      importFrom: str(c.stickers.importFrom, "", 500),
    },
    search: {
      enabled: bool(c.search.enabled, true),
      sources: (Array.isArray(c.search.sources) ? c.search.sources : D.search.sources).filter((s) => D.search.sources.includes(s)),
      timeoutMs: num(c.search.timeoutMs, D.search.timeoutMs, 2000, 30000),
    },
    chat: {
      historyMessages: num(c.chat.historyMessages, D.chat.historyMessages, 6, 200),
      historyChars: num(c.chat.historyChars, D.chat.historyChars, 1000, 60000),
      summaryTrigger: num(c.chat.summaryTrigger, D.chat.summaryTrigger, 10, 400),
      keepRecent: num(c.chat.keepRecent, D.chat.keepRecent, 4, 200),
      relevantSnippets: num(c.chat.relevantSnippets, D.chat.relevantSnippets, 0, 10),
      extractEvery: num(c.chat.extractEvery, D.chat.extractEvery, 1, 50),
    },
    humanize: {
      enabled: bool(c.humanize.enabled, true),
      typingDelay: bool(c.humanize.typingDelay, true),
      maxBubbles: num(c.humanize.maxBubbles, D.humanize.maxBubbles, 1, 8),
      maxReplyDelayMs: num(c.humanize.maxReplyDelayMs, D.humanize.maxReplyDelayMs, 0, 20000),
    },
    qq: {
      enabled: bool(c.qq.enabled, true),
      apiBase: str(c.qq.apiBase, D.qq.apiBase, 300).replace(/\/+$/, "") || D.qq.apiBase,
      token: str(c.qq.token, "", 300),
      inboundAuth: ["off", "auto", "required"].includes(c.qq.inboundAuth) ? c.qq.inboundAuth : "auto",
      selfId: num(c.qq.selfId, 0, 0, 1e13),
      private: bool(c.qq.private, true),
      group: bool(c.qq.group, true),
      groupAtOnly: bool(c.qq.groupAtOnly, true),
      groupAllowList: idList(c.qq.groupAllowList),
      mergeWindowMs: num(c.qq.mergeWindowMs, D.qq.mergeWindowMs, 0, 15000),
      mergeMaxMs: num(c.qq.mergeMaxMs, D.qq.mergeMaxMs, 0, 60000),
      typingStatus: bool(c.qq.typingStatus, true),
      pokeBack: bool(c.qq.pokeBack, true),
      napcatLauncher: str(c.qq.napcatLauncher, "", 500),
      botQQ: (idList([c.qq.botQQ])[0]) || "",
    },
    owner: {
      qq: idList(c.owner.qq),
      onlyOwner: bool(c.owner.onlyOwner, true),
    },
    proactive: {
      enabled: bool(c.proactive.enabled, false),
      followUp: bool(c.proactive.followUp, true),
      quietHours: num(c.proactive.quietHours, 20, 2, 240),
      from: num(c.proactive.from, 10, 0, 23),
      to: num(c.proactive.to, 22, 1, 24),
    },
    notify: {
      desktop: bool(c.notify.desktop, true),
      webhook: str(c.notify.webhook, "", 500),
    },
    groupDigest: {
      enabled: bool(c.groupDigest.enabled, false),
      groups: idList(c.groupDigest.groups),
      daily: bool(c.groupDigest.daily, true),
      time: hhmm(c.groupDigest.time, D.groupDigest.time),
      minMessages: num(c.groupDigest.minMessages, D.groupDigest.minMessages, 1, 1000),
      keepDays: num(c.groupDigest.keepDays, D.groupDigest.keepDays, 1, 60),
    },
  };
}

/** 只在运行期覆盖的环境变量 */
function applyEnv(cfg, env = process.env) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (env.PORT) c.port = Number(env.PORT);
  if (env.LLM_API_KEY || env.LLM_BASE_URL || env.LLM_MODEL) {
    let p = c.providers.find((x) => x.id === c.llm.active);
    if (!p) {
      p = { id: "env", preset: "custom", baseUrl: env.LLM_BASE_URL || "https://api.deepseek.com/v1", apiKey: "", model: env.LLM_MODEL || "deepseek-chat" };
      c.providers.push(p);
      c.llm.active = "env";
    }
    if (env.LLM_API_KEY) p.apiKey = env.LLM_API_KEY;
    if (env.LLM_BASE_URL) p.baseUrl = env.LLM_BASE_URL;
    if (env.LLM_MODEL) p.model = env.LLM_MODEL;
  }
  if (env.ONEBOT_API_BASE) c.qq.apiBase = env.ONEBOT_API_BASE;
  if (env.ONEBOT_TOKEN) c.qq.token = env.ONEBOT_TOKEN;
  return c;
}

function configPath(root) {
  return path.join(root, "config.json");
}

function readRawConfig(root) {
  const raw = readJson(configPath(root), null);
  return isPlainObject(raw) ? raw : {};
}

function ensureConfigFile(root) {
  const file = configPath(root);
  if (fs.existsSync(file)) return false;
  const example = path.join(root, "config.example.json");
  const src = fs.existsSync(example) ? readJson(example, {}) : DEFAULTS;
  writeJsonAtomic(file, src);
  return true;
}

function loadConfig(root, env = process.env) {
  const raw = readRawConfig(root);
  return normalizeConfig(applyEnv(normalizeConfig(raw), env));
}

/**
 * 只改 patch 里出现的段落与字段；密钥字段为空时保留原值。
 * 返回新的运行期配置（已合并环境变量）。
 */
function savePatch(root, patch, env = process.env) {
  // 以「磁盘原文件（不含环境变量）归一化、旧格式已迁移」后的样子为底
  const base = normalizeConfig(readRawConfig(root));
  const next = { ...base };
  for (const sec of SECTIONS) {
    if (!isPlainObject(patch && patch[sec])) continue;
    const old = isPlainObject(base[sec]) ? base[sec] : {};
    const merged = { ...old, ...patch[sec] };
    for (const field of SECRET_FIELDS[sec] || []) {
      const v = patch[sec][field];
      if (v === "__clear__") merged[field] = "";
      else if (!v) merged[field] = old[field] || "";
    }
    next[sec] = merged;
  }
  if (patch && Array.isArray(patch.providers)) {
    // 网页提交的 Key 为空 = 不改，"__clear__" = 清空
    next.providers = patch.providers.map((p) => {
      const old = base.providers.find((o) => o.id === p.id) || {};
      const apiKey = p.apiKey === "__clear__" ? "" : p.apiKey ? String(p.apiKey) : old.apiKey || "";
      return { ...old, ...p, apiKey };
    });
  }
  if (patch && patch.port !== undefined) next.port = patch.port;
  const normalized = normalizeConfig(next);
  writeJsonAtomic(configPath(root), normalized);
  return normalizeConfig(applyEnv(normalized, env));
}

/** 给网页看的配置：去掉所有密钥，只告诉有没有配 */
function publicConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.providers = c.providers.map((p) => ({ ...p, hasKey: Boolean(p.apiKey), apiKey: "" }));
  const active = cfg.providers.find((p) => p.id === cfg.llm.active);
  c.llm.hasKey = Boolean(active && (active.apiKey || isLocalUrl(active.baseUrl)));
  c.qq.hasToken = Boolean(cfg.qq.token);
  c.qq.token = "";
  c.notify.hasWebhook = Boolean(cfg.notify.webhook);
  c.notify.webhook = "";
  return c;
}

/** 把运行期对象原地替换成新配置（各模块拿的是同一个引用） */
function replaceInPlace(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
  return target;
}

module.exports = {
  DEFAULTS,
  STYLE_IDS,
  SECTIONS,
  normalizeConfig,
  applyEnv,
  loadConfig,
  savePatch,
  ensureConfigFile,
  readRawConfig,
  publicConfig,
  replaceInPlace,
  configPath,
};
