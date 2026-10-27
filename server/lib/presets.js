"use strict";
/*
 * 常见大模型服务商（都走 OpenAI 兼容的 /chat/completions 接口）。
 * 模型名更新很快：这里只是「推荐的起点」，网页上点「获取模型列表」会直接问服务商现在有哪些模型。
 * 资料整理于 2026-10-27（各家官方文档 / 公开资料）。
 */
const PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-v4-pro", "deepseek-flash", "deepseek-chat"],
    vision: ["deepseek-flash"],
    note: "国内直连，便宜。deepseek-flash 能看图；deepseek-v4-pro 更聪明一些",
  },
  {
    id: "moonshot",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    models: ["kimi-k3", "kimi-k3.1-pro"],
    vision: ["kimi-k3"],
    note: "国内直连，中文聊天和理解很强，能看图",
  },
  {
    id: "qwen",
    name: "通义千问（阿里云百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    models: ["qwen3.8-max", "qwen-plus", "qwen3.5-flash"],
    vision: ["qwen-vl-max", "qwen-vl-plus"],
    note: "国内直连；北京地域的 Key 配这个地址",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: ["glm-4.7-flash", "glm-4-flash"],
    vision: ["glm-4.6v-flash"],
    note: "国内直连；带 flash 的有免费额度",
  },
  {
    id: "doubao",
    name: "豆包（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    models: ["doubao-seed-1-8-251228"],
    vision: ["doubao-seed-1-8-251228"],
    note: "国内直连；模型要先在方舟控制台开通",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    models: [],
    vision: [],
    note: "国内直连，一个 Key 能用很多开源模型（DeepSeek、Qwen、GLM、Kimi……），点「获取模型列表」挑",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    models: [],
    vision: [],
    note: "一个 Key 用 GPT、Claude、Gemini 等国外模型；国内网络可能不稳定",
  },
  {
    id: "openai",
    name: "OpenAI（GPT）",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [],
    vision: [],
    note: "需要能访问国外网络；点「获取模型列表」挑最新的",
  },
  {
    id: "claude",
    name: "Claude（Anthropic）",
    baseUrl: "https://api.anthropic.com/v1",
    keyUrl: "https://platform.claude.com/settings/keys",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
    vision: ["claude-haiku-5-5"],
    note: "需要能访问国外网络；英文和幽默感很好。走的是它的 OpenAI 兼容接口",
    noTemperature: true,
  },
  {
    id: "gemini",
    name: "Gemini（Google）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    models: ["gemini-3.8-flash"],
    vision: ["gemini-3.8-flash"],
    note: "需要能访问国外网络；有免费额度",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    models: [],
    vision: [],
    note: "国内直连；点「获取模型列表」或按官网填模型名",
  },
  {
    id: "ollama",
    name: "Ollama（本机模型）",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyUrl: "",
    models: [],
    vision: [],
    note: "用你电脑上 Ollama 里下载的模型，不花钱、不需要 Key（要先打开 Ollama）；小模型聊天效果一般",
    noKey: true,
  },
  {
    id: "custom",
    name: "其他（自己填地址）",
    baseUrl: "",
    keyUrl: "",
    models: [],
    vision: [],
    note: "任何兼容 OpenAI /chat/completions 的服务都可以",
  },
];

function presetOf(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** 本机地址不需要 Key（Ollama、LM Studio 等） */
function isLocalUrl(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(String(url || "") + "/");
}

module.exports = { PRESETS, presetOf, isLocalUrl };
