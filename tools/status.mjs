// 「检查状态.bat」：看服务、大模型、QQ 是否正常。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(root + "config.json", "utf8").replace(/^﻿/, ""));
} catch {
  /* 没有配置 */
}
const port = process.env.PORT || cfg.port || 8787;
const ok = (b) => (b ? "[√]" : "[×]");

try {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })).json();
  console.log(`${ok(true)} 服务在运行：v${h.version}，http://127.0.0.1:${port}/`);
  console.log(`${ok(h.llm.enabled && !h.llm.lastError)} 大模型：${h.llm.enabled ? h.llm.model : "没填 API Key"}${h.llm.lastError ? "，最近出错：" + h.llm.lastError : ""}`);
  if (h.qq.enabled) {
    const s = h.qq.online === true ? "在线" + (h.qq.nickname ? "（" + h.qq.nickname + "）" : "") : h.qq.online === false ? "离线：" + h.qq.lastError : "还在检查";
    console.log(`${ok(h.qq.online)} QQ：${s}`);
    console.log(`${ok(h.qq.owners > 0)} 主人 QQ：${h.qq.owners ? "已设置" : "未设置（去网页设置里填）"}`);
    console.log(`    收到 ${h.qq.received} 条，回复 ${h.qq.replied} 次`);
  } else {
    console.log("    QQ：未开启");
  }
} catch {
  console.log(`${ok(false)} 服务没在运行（http://127.0.0.1:${port}/ 打不开）。双击「启动.bat」或「一键启动QQ好友.bat」。`);
}
