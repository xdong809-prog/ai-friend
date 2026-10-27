// 一键配置：导入旧版数据 → 把桌面上指向旧版的快捷方式移到回收站 → 在桌面创建新版快捷方式。
// 用法：node tools/setup-all.mjs [旧项目路径]（默认 D:\dsh\ai-friend）
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const onlyShortcuts = process.argv.includes("--shortcuts-only");
const oldRoot = process.argv.slice(2).find((a) => !a.startsWith("--")) || "D:\\dsh\\ai-friend";

if (!onlyShortcuts) {
  console.log("【1/3】导入旧版数据（只读，旧项目不会被修改）\n");
  spawnSync(process.execPath, [join(root, "tools", "import-old.mjs"), oldRoot], { stdio: "inherit" });
}

if (process.platform !== "win32") process.exit(0);

console.log("\n【2/3】处理桌面上旧版的快捷方式");
// 只处理「目标在旧项目文件夹里」的快捷方式；移到回收站，后悔了可以还原
const ps =
  "Add-Type -AssemblyName Microsoft.VisualBasic;" +
  "$sh=New-Object -ComObject WScript.Shell;$old=$env:AIF_OLD.TrimEnd('\\').ToLower();$n=0;" +
  "foreach($d in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'))){" +
  " if(-not $d -or -not (Test-Path $d)){continue};" +
  " Get-ChildItem -LiteralPath $d -Filter *.lnk | ForEach-Object {" +
  "  $t=$sh.CreateShortcut($_.FullName);$tp=(''+$t.TargetPath+' '+$t.Arguments+' '+$t.WorkingDirectory).ToLower();" +
  "  if($tp.Contains($old)){" +
  "   try{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName,'OnlyErrorDialogs','SendToRecycleBin');Write-Output ('  已移到回收站：'+$_.Name);$n++}" +
  "   catch{Write-Output ('  删不掉（可能需要管理员权限，请手动删除）：'+$_.FullName)}" +
  "  }}};" +
  "if($n -eq 0){Write-Output '  没找到指向旧版的快捷方式（可能已经删过了）'}";
const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { env: { ...process.env, AIF_OLD: oldRoot }, encoding: "utf8" });
process.stdout.write(r.stdout || "");
if (r.status !== 0) console.log("  处理旧快捷方式时出错：" + (r.stderr || "").slice(0, 200));

console.log("\n【3/3】创建新版快捷方式");
spawnSync(process.execPath, [join(root, "tools", "make-shortcut.mjs")], { stdio: "inherit" });

console.log("\n全部完成。旧版的黑窗口如果还开着，先关掉，再双击桌面上的「AI好友 v4」。");
