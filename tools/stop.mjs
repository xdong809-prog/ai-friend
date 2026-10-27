// 「一键关闭.bat」：只关闭占用本服务端口（默认 8787）的进程。NapCat 窗口请自己关。
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(root + "config.json", "utf8").replace(/^﻿/, ""));
} catch {
  /* 没有配置 */
}
const port = Number(process.env.PORT || cfg.port || 8787);

if (process.platform !== "win32") {
  console.log("这个脚本只在 Windows 上用。其他系统请在运行服务的终端按 Ctrl+C。");
  process.exit(0);
}
let out = "";
try {
  out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
} catch {
  /* 忽略 */
}
const pids = new Set();
for (const line of out.split(/\r?\n/)) {
  const cols = line.trim().split(/\s+/);
  if (cols.length >= 5 && /LISTEN/i.test(cols[3]) && cols[1].endsWith(":" + port)) pids.add(cols[4]);
}
if (!pids.size) {
  console.log(`端口 ${port} 上没有在运行的服务。`);
} else {
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      console.log(`已关闭 AI 好友服务（进程 ${pid}）。`);
    } catch {
      console.log(`关闭进程 ${pid} 失败，可能需要管理员权限。`);
    }
  }
}
console.log("NapCat（QQ）的窗口如果还开着、也想关，直接关掉那个窗口即可。");
