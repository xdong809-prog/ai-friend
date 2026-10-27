"use strict";
/*
 * QQ 掉线看门狗 + 通知。
 * 每分钟问一次 NapCat「QQ 还在线吗」（OneBot get_status），状态变化时：
 *   - 控制台打印；
 *   - Windows 桌面右下角弹气泡（notify.desktop）；
 *   - 可选：POST 到一个 webhook（如 Server酱、PushPlus 等手机推送服务，notify.webhook）。
 */
const { spawn } = require("node:child_process");

function createNotifier({ config, log, fetch = globalThis.fetch, platform = process.platform, spawnImpl = spawn }) {
  return async function notify(text) {
    log.warn("[通知] " + text);
    if (platform === "win32" && config.notify.desktop) {
      // 消息通过环境变量传给 PowerShell，避免拼命令行出问题
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;" +
        "$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;" +
        "$n.Visible=$true;$n.ShowBalloonTip(10000,'AI 好友',$env:AIF_MSG,'Warning');Start-Sleep -s 11;$n.Dispose()";
      try {
        spawnImpl("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
          env: { ...process.env, AIF_MSG: text },
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch (e) {
        log.warn("桌面通知失败：" + e.message);
      }
    }
    if (config.notify.webhook) {
      try {
        await fetch(config.notify.webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "AI 好友", desp: text, content: text, text }),
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) {
        log.warn("手机推送失败：" + e.message);
      }
    }
  };
}

function createWatchdog({ config, onebot, notify, log, now = Date.now }) {
  const startedAt = now();
  const state = { online: null, since: now(), lastCheck: 0, lastError: "", nickname: "", userId: 0, everOnline: false, alertedNeverOnline: false };
  let timer = null;

  async function check() {
    let online = false;
    try {
      const r = await onebot.callApi("get_status", {});
      online = Boolean(r && r.data && r.data.online);
      state.lastError = online ? "" : "NapCat 在运行，但 QQ 没有登录";
      if (online && !state.userId) {
        const info = await onebot.fetchSelfId();
        if (info) {
          state.userId = info.user_id;
          state.nickname = info.nickname || "";
        }
      }
    } catch (e) {
      state.lastError = "连不上 NapCat（" + String(e.message || e).slice(0, 80) + "）";
    }
    state.lastCheck = now();
    if (online !== state.online) {
      const wasOnline = state.online === true;
      state.online = online;
      state.since = now();
      if (online) {
        log.info(`QQ 在线${state.nickname ? "：" + state.nickname : ""}${state.userId ? `（${state.userId}）` : ""}`);
        if (state.everOnline || state.alertedNeverOnline) notify("QQ 已经重新在线，可以正常聊天了");
        state.everOnline = true;
      } else if (wasOnline) {
        notify(`QQ 掉线了：${state.lastError}。打开 NapCat 窗口或 http://127.0.0.1:6099/webui 扫码重新登录`);
      } else {
        log.info(`QQ 还没连上：${state.lastError}（刚启动时 NapCat 登录需要一点时间）`);
      }
    }
    // 刚启动时给 NapCat 3 分钟登录；一直连不上才提醒一次
    if (!online && !state.everOnline && !state.alertedNeverOnline && now() - startedAt > 3 * 60 * 1000) {
      state.alertedNeverOnline = true;
      notify(`QQ 一直没连上：${state.lastError}。确认 NapCat 已经打开并登录了机器人小号`);
    }
    return online;
  }

  return {
    start(intervalMs = 60000) {
      if (timer) return;
      check();
      timer = setInterval(check, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    check,
    status: () => ({ ...state }),
  };
}

module.exports = { createWatchdog, createNotifier };
