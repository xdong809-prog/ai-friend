// 发布到 GitHub Release：打包 → 打标签 → 建 Release → 上传压缩包（零依赖，Node 18+）
// 用法：node tools/release.mjs [--check] [v4.5.0]
//   不写版本号就用 server/lib/app.js 里的 VERSION；--check 只看要不要发布，不做任何改动
// 更新说明放在「更新说明/v版本号.md」，没有就用上个版本以来的提交记录
// 登录凭据直接借用 git 上传时存下的那份（git credential），不用另装 gh
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

function git(argv, input) {
  const r = spawnSync("git", argv, { cwd: root, encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`git ${argv[0]} 失败：${(r.stderr || "").trim()}`);
  return r.stdout.trim();
}

// 出错就抛出，最后统一打印；不用 process.exit()：Windows 上的 Node 在 fetch 之后直接退出会崩
function fail(msg) {
  throw new Error(msg);
}

async function main() {
  const version = (args.find((a) => /^v?\d+\.\d+\.\d+$/.test(a)) || "").replace(/^v/, "")
    || (readFileSync(join(root, "server", "lib", "app.js"), "utf8").match(/const VERSION = "([^"]+)"/) || [])[1];
  if (!version) fail("在 server/lib/app.js 里找不到 VERSION");
  const tag = "v" + version;

  const remote = git(["remote", "get-url", "origin"]);
  const m = remote.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) fail("origin 不是 GitHub 仓库：" + remote);
  const [, owner, repo] = m;

  // 借用 git 存下的 GitHub 凭据（Git Credential Manager 登录时拿到的令牌）
  function getToken() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    const r = spawnSync("git", ["credential", "fill"], {
      cwd: root, encoding: "utf8", input: "protocol=https\nhost=github.com\n\n",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const pw = (r.stdout || "").match(/^password=(.+)$/m);
    if (r.status !== 0 || !pw) fail("拿不到 GitHub 登录凭据。先用上传脚本成功上传一次（会弹浏览器登录），再来发布。");
    return pw[1].trim();
  }

  let token;
  async function api(method, url, body, headers = {}) {
    token ??= getToken();
    const res = await fetch(url.startsWith("http") ? url : `https://api.github.com/repos/${owner}/${repo}${url}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-friend-release",
        ...(body && !headers["Content-Type"] ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
    });
    if (res.status === 404 && method === "GET") return null;
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? "（登录凭据没有发布权限或已过期，重新登录 GitHub 再试）" : "";
      throw new Error(`GitHub 接口返回 ${res.status}${hint}：${data?.message || ""}`);
    }
    return data;
  }

  // 发布前先看：标签和 Release 是不是已经有了
  const remoteTag = git(["ls-remote", "--tags", "origin", "refs/tags/" + tag]);
  let release = await api("GET", "/releases/tags/" + tag);
  const zipName = `ai-friend-${tag}.zip`;
  if (release?.assets?.some((a) => a.name === zipName)) {
    console.log(`${tag} 已经发布过了：${release.html_url}`);
    return checkOnly ? 2 : 0;
  }
  if (checkOnly) {
    console.log(`${tag} 还没发布`);
    return 0;
  }

  // 1. 标签：本地没有就打在当前提交上，再推到 GitHub
  const hasLocalTag = spawnSync("git", ["rev-parse", "-q", "--verify", "refs/tags/" + tag], { cwd: root }).status === 0;
  if (!hasLocalTag) {
    if (remoteTag) git(["fetch", "-q", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    else git(["tag", "-a", tag, "-m", "AI 好友 " + tag]);
  }
  if (!remoteTag) {
    git(["push", "-q", "origin", "refs/tags/" + tag]);
    console.log(`已推送标签 ${tag}`);
  }

  // 2. 打包：和标签里的文件一模一样（config.json、data/ 本来就不在版本库里）
  const distDir = join(root, "dist");
  mkdirSync(distDir, { recursive: true });
  const zipPath = join(distDir, zipName);
  git(["archive", "--format=zip", "--prefix=ai-friend/", "-o", zipPath, tag]);
  const zip = readFileSync(zipPath);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  console.log(`已打包 dist/${zipName}（${(statSync(zipPath).size / 1024).toFixed(0)} KB）`);

  // 3. 更新说明
  function notes() {
    const file = join(root, "更新说明", tag + ".md");
    let text;
    if (existsSync(file)) {
      text = readFileSync(file, "utf8").trim();
    } else {
      const prev = spawnSync("git", ["describe", "--tags", "--abbrev=0", tag + "^"], { cwd: root, encoding: "utf8" });
      const range = prev.status === 0 ? `${prev.stdout.trim()}..${tag}` : tag;
      const log = git(["log", "--format=- %s", range]);
      text = `## AI 好友 ${tag}\n\n### 改动\n\n${log || "- 见提交记录"}`;
      console.log(`没找到 更新说明/${tag}.md，改用提交记录当更新说明`);
    }
    if (!text.includes("SHA-256")) {
      text += `\n\n### 📦 下载\n\n| 文件 | 说明 |\n| --- | --- |\n| \`${zipName}\` | 完整程序，解压即用（不含任何个人数据和密钥） |\n\nSHA-256：\`${sha256}\``;
    }
    return text;
  }

  // 4. 建 Release（已有就沿用）并上传压缩包
  release ??= await api("POST", "/releases", { tag_name: tag, name: "AI 好友 " + tag, body: notes() });
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, "") + "?name=" + encodeURIComponent(zipName);
  await api("POST", uploadUrl, zip, { "Content-Type": "application/zip" });
  console.log(`已发布：${release.html_url}`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => { console.error("出错：" + e.message); process.exitCode = 1; },
);
