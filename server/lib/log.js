"use strict";
/*
 * 控制台日志：带时间、中文、自动给密钥打码。
 * 有黑窗口时，同时写一份到 data/logs/server.log（出问题时把这个文件发出来就能排查）；
 * 后台无窗口运行时 stdout 本来就被重定向到这个文件，不重复写。
 */
const fs = require("node:fs");
const { pad } = require("./util");

function createRedactor(getSecrets) {
  return function redact(input) {
    let s = typeof input === "string" ? input : input instanceof Error ? input.stack || input.message : JSON.stringify(input);
    for (const v of getSecrets()) {
      const secret = String(v || "");
      if (secret.length >= 6) s = s.split(secret).join(secret.slice(0, 3) + "***");
    }
    return s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***").replace(/(Bearer\s+)[^\s"']+/gi, "$1***");
  };
}

function createLogger({ silent = false, debug = process.env.DEBUG === "1", getSecrets = () => [], file = "" } = {}) {
  const redact = createRedactor(getSecrets);
  const stamp = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const out = (level, args) => {
    if (silent) return;
    const text = args.map((a) => redact(a)).join(" ");
    const line = `[AI好友] ${stamp()} ${level}${text}`;
    if (level === "错误 ") console.error(line);
    else console.log(line);
    if (file) {
      try {
        const d = new Date();
        fs.appendFileSync(file, `${d.getMonth() + 1}-${pad(d.getDate())} ${line.slice(7)}\n`, "utf8");
      } catch {
        /* 写日志失败不影响运行 */
      }
    }
  };
  return {
    info: (...a) => out("", a),
    warn: (...a) => out("注意 ", a),
    error: (...a) => out("错误 ", a),
    debug: (...a) => (debug ? out("调试 ", a) : undefined),
    redact,
  };
}

module.exports = { createLogger, createRedactor };
