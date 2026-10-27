// 在桌面创建「AI好友 v4」快捷方式，指向本项目的「一键启动QQ好友.bat」。
// 路径通过环境变量传给 PowerShell，中文路径也不会乱码。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("只支持 Windows。");
  process.exit(0);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const ps =
  "$d=[Environment]::GetFolderPath('Desktop');" +
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d ($env:AIF_NAME + '.lnk')));" +
  "$s.TargetPath=$env:AIF_TARGET;$s.WorkingDirectory=$env:AIF_DIR;$s.Description='AI 好友 v4（QQ + 网页）';$s.Save();" +
  "Write-Output (Join-Path $d ($env:AIF_NAME + '.lnk'))";
const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
  env: { ...process.env, AIF_NAME: "AI好友 v4", AIF_TARGET: join(root, "一键启动QQ好友.bat"), AIF_DIR: root },
  encoding: "utf8",
});
if (r.status === 0) {
  console.log("已在桌面创建快捷方式「AI好友 v4」。以后双击它就能启动新版。");
  console.log("桌面上旧的那个快捷方式打开的是旧版，可以删掉，或者留着备用（新旧版不能同时开）。");
} else {
  console.log("创建失败：" + (r.stderr || r.error || "未知错误"));
}
