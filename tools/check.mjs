// 提交前检查：全部 JS 语法检查 + 单元测试（零依赖，Node 18+）
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "data"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.has(name)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(?:c|m)?js$/.test(name)) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    bad++;
    console.error("✗ " + relative(root, f) + "\n" + r.stderr);
  }
}
console.log(`语法检查：${files.length - bad}/${files.length} 通过`);
if (bad) process.exit(1);

const testDir = join(root, "server", "test");
const tests = readdirSync(testDir).filter((n) => n.endsWith(".test.js")).map((n) => join(testDir, n));
const t = spawnSync(process.execPath, ["--test", ...tests], { cwd: root, stdio: "inherit" });
process.exit(t.status ?? 1);
