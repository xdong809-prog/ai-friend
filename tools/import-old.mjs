// 从旧版 AI 好友（v3.x，默认 D:\dsh\ai-friend）导入数据。对旧项目【只读】，不会修改它。
// 导入：大模型设置与 Key、主人 QQ、NapCat 连接、好友设定；和主人的聊天记录（会话 main）与记忆。
// 用法：node tools/import-old.mjs [旧项目路径] [--force]
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const force = args.includes("--force");
const oldRoot = args.find((a) => !a.startsWith("--")) || "D:\\dsh\\ai-friend";
const root = fileURLToPath(new URL("..", import.meta.url));

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
};
const writeJson = (f, o) => {
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(o, null, 2), "utf8");
};

if (!existsSync(oldRoot)) {
  console.log(`找不到旧项目：${oldRoot}`);
  process.exit(1);
}
console.log(`从 ${oldRoot} 导入（只读）……\n`);

// ---------- 配置 ----------
const oldCfg = readJson(join(oldRoot, "config.json"));
const newCfgFile = join(root, "config.json");
const cfg = readJson(newCfgFile) || readJson(join(root, "config.example.json")) || {};
for (const k of ["friend", "llm", "qq", "owner"]) cfg[k] = cfg[k] || {};
if (oldCfg && existsSync(newCfgFile) && !force) {
  console.log("✓ 新版已经有 config.json 了，保留现在的设置不覆盖（要用旧设置覆盖就加 --force）");
} else if (oldCfg) {
  const f = oldCfg.friend || {};
  if (f.name) cfg.friend.name = f.name;
  if (f.style) cfg.friend.style = f.style;
  if (f.customPrompt) cfg.friend.customPrompt = f.customPrompt;
  if (f.userName && f.userName !== "你") cfg.friend.userName = f.userName;

  const l = oldCfg.llm || {};
  if (l.apiKey) cfg.llm.apiKey = l.apiKey;
  if (l.baseUrl) cfg.llm.baseUrl = l.baseUrl;
  if (l.model) cfg.llm.model = l.model;
  if (l.fallbackModel) cfg.llm.fallbackModel = l.fallbackModel;

  const o = oldCfg.owner || {};
  if (Array.isArray(o.qq) && o.qq.length) cfg.owner.qq = o.qq.map(String);
  if (typeof o.onlyOwner === "boolean") cfg.owner.onlyOwner = o.onlyOwner;

  const ob = oldCfg.onebot || {};
  if (ob.apiBase) cfg.qq.apiBase = ob.apiBase;
  if (ob.token) cfg.qq.token = ob.token;
  if (ob.selfId) {
    cfg.qq.selfId = Number(ob.selfId) || 0;
    cfg.qq.botQQ = String(ob.selfId);
  }
  const q = oldCfg.qq || {};
  if (typeof q.private === "boolean") cfg.qq.private = q.private;
  if (typeof q.atOnly === "boolean") cfg.qq.groupAtOnly = q.atOnly;
  // 旧版群里默认「潜水不回复」，保持同样的行为
  if (q.groupLurk && q.groupLurk.enabled && q.groupLurk.silent !== false) cfg.qq.group = false;
  else if (typeof q.group === "boolean") cfg.qq.group = q.group;
  if (q.groupLurk && Array.isArray(q.groupLurk.groups) && q.groupLurk.groups.length) cfg.qq.groupAllowList = q.groupLurk.groups.map(String);

  const launcher = join(oldRoot, "tools", "napcat", "launcher-user.bat");
  if (existsSync(launcher) && !cfg.qq.napcatLauncher) cfg.qq.napcatLauncher = launcher;

  if (existsSync(newCfgFile)) renameSync(newCfgFile, newCfgFile + ".bak-" + Date.now());
  writeJson(newCfgFile, cfg);
  console.log("✓ 设置已导入：");
  console.log(`   好友：${cfg.friend.name}（${cfg.friend.style}）`);
  console.log(`   大模型：${cfg.llm.model}，Key ${cfg.llm.apiKey ? "已导入" : "旧项目里没有"}`);
  console.log(`   主人 QQ：${(cfg.owner.qq || []).length ? "已导入" : "旧项目里没有，记得去网页设置里填"}`);
  console.log(`   机器人小号：${cfg.qq.botQQ || "未知"}；NapCat 启动脚本：${cfg.qq.napcatLauncher || "未找到"}`);
  console.log(`   群聊回复：${cfg.qq.group ? "被 @ 时回复" : "关闭（和旧版一样只潜水；想开就去设置里勾上）"}`);
} else {
  console.log("× 旧项目里没有 config.json，跳过设置导入");
}

// ---------- 聊天记录 ----------
const oldSess = join(oldRoot, "data", "memory", "sessions", "main.jsonl");
const newSess = join(root, "data", "sessions", "main.jsonl");
let count = 0;
if (existsSync(oldSess)) {
  if (existsSync(newSess) && readFileSync(newSess, "utf8").trim() && !force) {
    console.log("\n× 新项目里已经有聊天记录了，为了不覆盖，跳过聊天记录和记忆的导入。");
    console.log("  确定要覆盖就运行：node tools/import-old.mjs \"" + oldRoot + "\" --force");
    process.exit(0);
  }
  const lines = readFileSync(oldSess, "utf8").split("\n");
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const text = String(o.text || o.content || "").trim();
      if (!text) continue;
      out.push(JSON.stringify({ seq: out.length + 1, role: o.role === "assistant" ? "assistant" : "user", text, ts: Number(o.ts) || 0 }));
    } catch {
      /* 跳过坏行 */
    }
  }
  count = out.length;
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  if (existsSync(newSess)) renameSync(newSess, newSess + ".bak-" + Date.now());
  writeFileSync(newSess, out.join("\n") + (out.length ? "\n" : ""), "utf8");
  console.log(`\n✓ 聊天记录已导入：${count} 条`);
} else {
  console.log("\n× 旧项目里没有找到和主人的聊天记录（data/memory/sessions/main.jsonl）");
}

// ---------- 记忆 ----------
const oldProf = readJson(join(oldRoot, "data", "memory", "profiles", "main.json"));
const keepRecent = 24;
const prof = {
  version: 2,
  basics: {},
  facts: [],
  events: [],
  summary: "",
  summarizedUpTo: Math.max(0, count - keepRecent),
  extractedUpTo: count,
  updatedAt: Date.now(),
};
if (oldProf) {
  const at = Number(oldProf.updatedAt) || Date.now();
  prof.facts = (Array.isArray(oldProf.facts) ? oldProf.facts : [])
    .map((f) => String(typeof f === "string" ? f : f && f.text ? f.text : "").trim())
    .filter((t) => t.length >= 2)
    .map((text) => ({ text, at }));
  prof.summary = String(oldProf.summary || "").trim();
}
writeJson(join(root, "data", "profiles", "main.json"), prof);
console.log(`✓ 记忆已导入：${prof.facts.length} 条事实${prof.summary ? "，含旧摘要" : ""}`);
if (prof.facts.length) console.log("  旧版的记忆是靠规则抽的，可能有错的（比如半截词）。启动后到网页「记忆」页看一眼，删掉不对的。");
console.log("\n完成。现在可以双击「一键启动QQ好友.bat」了。");
console.log("注意：旧版和新版用同一个端口 8787，启动新版前请先关掉旧版的窗口。");
