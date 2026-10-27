// 启动 NapCat（QQ 协议端）。被「一键启动QQ好友.bat」和开机自启脚本调用。
// 读取 config.json 的 qq.napcatLauncher（启动脚本路径）和 qq.botQQ（机器人小号，可空）。
import { existsSync, readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const quiet = process.argv.includes("--quiet");
const say = (...a) => { if (!quiet) console.log(...a); };
const root = fileURLToPath(new URL("..", import.meta.url));
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(root + "config.json", "utf8").replace(/^\uFEFF/, ""));
} catch {
  /* 没有配置 */
}
const qq = cfg.qq || {};

if (qq.enabled === false) {
  say("config 里关闭了 QQ（qq.enabled=false），不启动 NapCat。");
  process.exit(0);
}

// NapCat 是否已经在运行（3000 端口通不通）
const apiBase = String(qq.apiBase || "http://127.0.0.1:3000").replace(/\/+$/, "");
try {
  const headers = { "Content-Type": "application/json" };
  if (qq.token) headers.Authorization = "Bearer " + qq.token;
  const r = await fetch(apiBase + "/get_status", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(2500) });
  if (r.ok) {
    say("NapCat 已经在运行了，不重复启动。");
    process.exit(0);
  }
} catch {
  /* 没在运行 */
}

const candidates = [qq.napcatLauncher, "D:\\dsh\\ai-friend\\tools\\napcat\\launcher-user.bat", root + "tools\\napcat\\launcher-user.bat"].filter(Boolean);
const launcher = candidates.find((p) => existsSync(p));
if (!launcher) {
  say("没找到 NapCat 的启动脚本。");
  say("请在网页「设置 → QQ → NapCat 连接」里填写启动脚本路径（例如 D:\\napcat\\launcher-user.bat），");
  say("或者先手动打开 NapCat 并登录机器人小号，再启动本服务。");
  process.exit(0);
}

const args = qq.botQQ ? ["-q", String(qq.botQQ)] : [];
say(`正在启动 NapCat：${launcher}${qq.botQQ ? `（小号 ${qq.botQQ}）` : ""}`);
say("如果弹出二维码，请用机器人小号的手机 QQ 扫码登录。");
if (process.platform === "win32") {
  // 在新窗口里启动，关掉本服务不会连带关掉 NapCat
  const cmdline = `start "NapCat" /d "${dirname(launcher)}" "${basename(launcher)}" ${args.join(" ")}`;
  try {
    execSync(cmdline, { stdio: "ignore", shell: "cmd.exe" });
  } catch (e) {
    say("启动 NapCat 失败：" + e.message);
  }
} else {
  spawn(launcher, args, { cwd: dirname(launcher), detached: true, stdio: "ignore" }).unref();
}
