"use strict";
/*
 * QQ 接入：NapCat（OneBot v11 协议端）→ POST /onebot → 这里 → 对话大脑 → 调 NapCat 的 HTTP API 发回去。
 *
 * 让它更像真人的几个处理：
 *   - 连发合并：对方 2.5 秒内连发的几条当成一段话一起回（时间可配）；
 *   - 引用理解：对方「回复」某条消息时，把被引用的原文一起交给模型；
 *   - 打字节奏：先停顿「看消息」，再按字数一条条发；期间 QQ 上显示「对方正在输入…」；
 *   - 看图：图片和表情包交给看图模型，换成文字描述再给大模型；你发的表情包会被它收藏起来；
 *   - 发表情包：模型写 [表情包:关键词]，从表情包库挑一张以图片发出；
 *   - 戳一戳：私聊里戳它，它会回应，有时还会戳回去。
 * 安全：入站上报可校验签名（qq.inboundAuth），私聊只认主人（owner.onlyOwner）。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const { faceText } = require("./qqfaces");
const { toSegments } = require("./humanize");
const { sniffImage, sha1, readImageFile } = require("./vision");

const DEDUPE_MS = 10 * 60 * 1000;
const GROUP_CONTEXT = 40;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 校验 NapCat 的上报：X-Signature（HMAC-SHA1）或 Authorization: Bearer */
function verifyInbound(headers, rawBody, { token, mode }) {
  if (mode === "off" || !token) return { ok: true, via: "disabled" };
  const sig = String(headers["x-signature"] || "");
  if (sig) {
    const expect = "sha1=" + crypto.createHmac("sha1", token).update(rawBody, "utf8").digest("hex");
    return { ok: safeEqual(sig.toLowerCase(), expect), via: "x-signature" };
  }
  const auth = String(headers.authorization || "");
  if (auth) return { ok: safeEqual(auth.replace(/^(?:Bearer|Token)\s+/i, ""), token), via: "authorization" };
  return { ok: mode !== "required", via: "missing" };
}

/** 兼容「字符串格式」的消息：[CQ:face,id=14] 这种 */
function parseCQ(str) {
  const segs = [];
  const re = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gi;
  let last = 0;
  let m;
  const unesc = (s) => s.replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&#44;/g, ",").replace(/&amp;/g, "&");
  while ((m = re.exec(str))) {
    if (m.index > last) segs.push({ type: "text", data: { text: unesc(str.slice(last, m.index)) } });
    const data = {};
    for (const kv of m[2].split(",").filter(Boolean)) {
      const i = kv.indexOf("=");
      if (i > 0) data[kv.slice(0, i)] = unesc(kv.slice(i + 1));
    }
    segs.push({ type: m[1], data });
    last = re.lastIndex;
  }
  if (last < str.length) segs.push({ type: "text", data: { text: unesc(str.slice(last)) } });
  return segs;
}

function normalizeSegments(message, raw) {
  if (Array.isArray(message)) return message.filter((s) => s && s.type);
  if (typeof message === "string") return parseCQ(message);
  if (typeof raw === "string") return parseCQ(raw);
  return [];
}

function createOneBot({ config, brain, log, vision = null, stickers = null, commands = null, fetch = globalThis.fetch, now = Date.now, random = Math.random, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const seen = new Map();
  const buffers = new Map();
  const groups = new Map();
  let selfIdCache = 0;
  let warnedNoSig = false;
  let warnedNoOwner = false;
  const stats = { received: 0, replied: 0, lastEventAt: 0, sendError: "" };

  async function callApi(action, params) {
    const headers = { "Content-Type": "application/json" };
    if (config.qq.token) headers.Authorization = "Bearer " + config.qq.token;
    const res = await fetch(`${config.qq.apiBase}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (!res.ok || (data.status && data.status !== "ok" && data.retcode !== 0)) {
      throw new Error(`${action} 失败：HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    return data;
  }

  function selfId(event) {
    return Number(config.qq.selfId) || Number(event && event.self_id) || selfIdCache || 0;
  }

  function isDuplicate(id) {
    if (id === undefined || id === null) return false;
    const t = now();
    for (const [k, at] of seen) if (t - at > DEDUPE_MS) seen.delete(k);
    const key = String(id);
    if (seen.has(key)) return true;
    seen.set(key, t);
    return false;
  }

  /** 把消息段变成给模型看的文字；图片先放占位符，之后由 seeImages 换成「[图片：描述]」 */
  async function readContent(segs, self) {
    const parts = [];
    const images = [];
    let mentioned = false;
    let quoteId = null;
    for (const s of segs) {
      const d = s.data || {};
      switch (s.type) {
        case "text":
          parts.push(String(d.text || ""));
          break;
        case "face":
          parts.push(faceText(d.id));
          break;
        case "at":
          if (String(d.qq) === String(self)) mentioned = true;
          else if (d.qq === "all") parts.push("@全体成员 ");
          else parts.push(`@${d.name || d.qq} `);
          break;
        case "reply":
          quoteId = d.id;
          break;
        case "image":
        case "mface": {
          // NapCat：image 的 sub_type=1 是表情包；mface 是商城表情（summary 是它的名字，比如「[开心]」）
          const sticker = s.type === "mface" || Number(d.sub_type) === 1 || /表情/.test(String(d.summary || ""));
          const summary = String(d.summary || "").replace(/^\[|\]$/g, "").replace(/^(?:动画表情|图片)$/, "").trim();
          const token = `\u0000IMG${images.length}\u0000`;
          images.push({ token, url: String(d.url || (/^https?:/.test(String(d.file || "")) ? d.file : "") || ""), file: String(d.file || d.file_id || ""), sticker, summary });
          parts.push(token);
          break;
        }
        case "record":
          parts.push("[语音]");
          break;
        case "video":
          parts.push("[视频]");
          break;
        case "file":
          parts.push("[文件]");
          break;
        case "json":
        case "xml":
          parts.push("[分享卡片]");
          break;
        case "forward":
          parts.push("[聊天记录]");
          break;
        default:
          break;
      }
    }
    let quote = "";
    let quoteFromSelf = false;
    if (quoteId) {
      try {
        const r = await callApi("get_msg", { message_id: Number(quoteId) || quoteId });
        const msg = r.data || {};
        const qsegs = normalizeSegments(msg.message, msg.raw_message);
        quote = qsegs
          .map((x) => {
            if (x.type === "text") return x.data.text;
            if (x.type === "face") return faceText(x.data.id);
            if (x.type === "image" || x.type === "mface") return Number(x.data && x.data.sub_type) === 1 || x.type === "mface" ? "[表情包]" : "[图片]";
            return "";
          })
          .join("")
          .trim();
        quoteFromSelf = String(msg.sender && msg.sender.user_id) === String(self);
      } catch (e) {
        log.debug("取引用消息失败：" + e.message);
      }
    }
    return { text: parts.join("").replace(/\s+/g, " ").trim(), images, mentioned, quote, quoteFromSelf };
  }

  /**
   * 看图：把占位符换成「[表情包：熊猫头捂脸，配字…]」。看不了就写「[图片]」，提示词会让模型如实说看不到。
   * collect=true 时，把对方发来的表情包收进它自己的表情包库。
   */
  async function seeImages(content, { collect = false } = {}) {
    let text = content.text;
    for (const img of content.images) {
      let label = img.sticker ? "[表情包]" : "[图片]";
      if (img.summary && img.sticker) label = `[表情包：${img.summary}]`;
      if (vision && vision.enabled() && (img.url || img.file)) {
        const r = await vision.fromUrl(img.url, { hint: img.sticker ? "表情包" + (img.summary ? "：" + img.summary : "") : "", fallback: () => localImage(img.file) });
        if (r.ok && r.desc) {
          const isSticker = img.sticker || r.desc.sticker;
          label = `[${isSticker ? "表情包" : "图片"}：${r.desc.desc}]`;
          if (collect && isSticker && stickers) {
            const id = stickers.collect(r.image, { ...r.desc, sticker: true });
            if (id) log.info(`收下了你发的表情包：${r.desc.desc}`);
          }
        }
      }
      text = text.replace(img.token, label);
    }
    return text.replace(/\u0000IMG\d+\u0000/g, "[图片]").trim();
  }

  /** 图片链接下载失败时，向 NapCat 要它缓存在本机的那份文件（NapCat 和本服务在同一台电脑上） */
  async function localImage(file) {
    if (!file || /^https?:/i.test(file)) return null;
    if (/^base64:\/\//.test(file)) {
      const buf = Buffer.from(file.slice(9), "base64");
      const ext = sniffImage(buf);
      return ext ? { buf, ext, sha1: sha1(buf) } : null;
    }
    const r = await callApi("get_image", { file });
    const data = (r && r.data) || {};
    if (data.base64) {
      const buf = Buffer.from(String(data.base64), "base64");
      const ext = sniffImage(buf);
      if (ext) return { buf, ext, sha1: sha1(buf) };
    }
    const local = String(data.file || "").replace(/^file:\/\/\/?/, "");
    const img = local ? readImageFile(local) : null;
    if (!img) throw new Error("NapCat 没给出可用的本机图片");
    return img;
  }

  /** QQ 上显示「对方正在输入…」（NapCat 扩展接口；不支持也没关系） */
  function setTyping(target) {
    if (!config.qq.typingStatus || target.kind !== "private") return;
    callApi("set_input_status", { user_id: String(target.id), status: 1, event_type: 1 }).catch((e) => log.debug("显示正在输入失败：" + e.message));
  }

  function ownerList() {
    return config.owner.qq.map(String);
  }

  function privateSession(userId) {
    const owners = ownerList();
    if (owners.includes(String(userId))) return "main";
    return `qq_${userId}`;
  }

  // ---------- 发送 ----------

  function stickerSegment(part) {
    try {
      const buf = fs.readFileSync(part.path);
      return { type: "image", data: { file: "base64://" + buf.toString("base64"), sub_type: 1, summary: "[动画表情]" } };
    } catch (e) {
      log.warn("读取表情包失败：" + e.message);
      return null;
    }
  }

  async function sendBubbles(target, result, replyToId) {
    const parts = result.parts || result.bubbles.map((text) => ({ type: "text", text }));
    setTyping(target);
    if (result.firstDelayMs) await sleep(result.firstDelayMs);
    let sent = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0 && result.delays[i]) {
        setTyping(target);
        await sleep(result.delays[i]);
      }
      const part = parts[i];
      const one = part.type === "sticker" ? stickerSegment(part) : null;
      const segs = part.type === "sticker" ? (one ? [one] : []) : toSegments(part.text);
      if (!segs.length) continue;
      if (i === 0 && replyToId && target.kind === "group") segs.unshift({ type: "reply", data: { id: String(replyToId) } });
      try {
        if (target.kind === "group") await callApi("send_group_msg", { group_id: Number(target.id), message: segs });
        else await callApi("send_private_msg", { user_id: Number(target.id), message: segs });
        sent++;
      } catch (e) {
        stats.sendError = e.message;
        log.warn("QQ 发消息失败：" + e.message);
        break;
      }
    }
    stats.replied += sent ? 1 : 0;
    return sent;
  }

  // ---------- 连发合并 ----------

  function enqueue(key, item, run) {
    let b = buffers.get(key);
    if (!b) {
      b = { items: [], timer: null, busy: false, run };
      buffers.set(key, b);
    }
    b.run = run;
    b.items.push(item);
    schedule(key, b);
  }

  function schedule(key, b, wait = config.qq.mergeWindowMs) {
    clearTimeout(b.timer);
    b.timer = setTimeout(() => flush(key), wait);
    if (b.timer.unref) b.timer.unref();
  }

  async function flush(key) {
    const b = buffers.get(key);
    if (!b || !b.items.length) return;
    if (b.busy) return; // 正在回上一轮，回完会接着处理
    b.busy = true;
    const items = b.items.splice(0);
    try {
      await b.run(items);
    } catch (e) {
      stats.sendError = e.message;
      log.warn("处理 QQ 消息出错：" + e.message);
    } finally {
      b.busy = false;
      if (b.items.length) schedule(key, b, Math.min(1200, config.qq.mergeWindowMs));
      else buffers.delete(key);
    }
  }

  /** 等所有排队中的消息处理完（测试与优雅退出用） */
  async function idle(maxMs = 30000) {
    const end = now() + maxMs;
    while (buffers.size && now() < end) await sleep(20);
  }

  // ---------- 事件入口 ----------

  async function handleEvent(event) {
    if (!event || typeof event !== "object") return { handled: false, reason: "empty" };
    stats.lastEventAt = now();
    if (event.self_id && !selfIdCache) selfIdCache = Number(event.self_id);
    if (!config.qq.enabled) return { handled: false, reason: "qq-disabled" };

    if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke") {
      return handlePoke(event);
    }
    if (event.post_type !== "message" && event.post_type !== "message_sent") return { handled: false, reason: "not-message" };
    if (event.post_type === "message_sent") return { handled: false, reason: "self" };
    const self = selfId(event);
    if (String(event.user_id) === String(self)) return { handled: false, reason: "self" };
    if (isDuplicate(event.message_id)) return { handled: false, reason: "duplicate" };
    stats.received++;

    const segs = normalizeSegments(event.message, event.raw_message);
    if (event.message_type === "private") return handlePrivate(event, segs, self);
    if (event.message_type === "group") return handleGroup(event, segs, self);
    return { handled: false, reason: "unknown-type" };
  }

  async function handlePrivate(event, segs, self) {
    if (!config.qq.private) return { handled: false, reason: "private-off" };
    const uid = String(event.user_id);
    const owners = ownerList();
    if (config.owner.onlyOwner && owners.length && !owners.includes(uid)) {
      log.info(`非主人 ${uid} 发来私聊，已忽略`);
      return { handled: false, reason: "not-owner" };
    }
    if (!owners.length && !warnedNoOwner) {
      warnedNoOwner = true;
      log.warn("还没设置主人 QQ（owner.qq）：现在谁私聊它都会回，且记忆不会和网页共享。建议在网页「设置」里填上你的 QQ 号");
    }
    const c = await readContent(segs, self);
    if (!c.text && !c.quote) return { handled: false, reason: "empty" };
    // 主人的小指令（比如「/模型」），直接回，不进聊天记录
    if (commands && owners.includes(uid) && /^[\/／]/.test(c.text)) {
      const answer = commands.handle(c.text);
      if (answer) {
        await callApi("send_private_msg", { user_id: Number(uid), message: [{ type: "text", data: { text: answer } }] }).catch((e) => log.warn("发指令回复失败：" + e.message));
        return { handled: true, reason: "command" };
      }
    }
    enqueue(`p:${uid}`, { content: c, quote: c.quote }, privateRunner(uid));
    return { handled: true, sessionId: privateSession(uid) };
  }

  /** 私聊一轮：看图 →（被戳时可能戳回去）→ 大脑回复 → 按节奏发出 */
  function privateRunner(uid) {
    const target = { kind: "private", id: uid };
    const isOwner = ownerList().includes(uid);
    return async (items) => {
      setTyping(target);
      // 按顺序看图（并发下载，顺序不乱）
      const texts = await Promise.all(items.map((x) => (x.content ? seeImages(x.content, { collect: isOwner }) : Promise.resolve(x.text))));
      const extraNotes = [];
      if (items.some((x) => x.poke) && config.qq.pokeBack && random() < 0.5) {
        try {
          await callApi("friend_poke", { user_id: String(uid) });
          extraNotes.push("你已经顺手戳回去了。");
        } catch (e) {
          log.debug("戳回去失败：" + e.message);
        }
      }
      const result = await brain.reply({
        sessionId: privateSession(uid),
        channel: "qq",
        texts: texts.map((t) => t || "（回复了一条消息）"),
        quote: items.map((x) => x.quote).filter(Boolean).pop() || "",
        extraNotes,
      });
      if (result) await sendBubbles(target, result);
    };
  }

  /** 不看图，直接用「[图片]」「[表情包：名字]」占位（群里没 @ 它的消息用，省得每张图都花钱看） */
  function plainText(c) {
    let text = c.text;
    for (const img of c.images) text = text.replace(img.token, img.sticker ? (img.summary ? `[表情包：${img.summary}]` : "[表情包]") : "[图片]");
    return text.trim();
  }

  function groupBuffer(gid) {
    if (!groups.has(gid)) groups.set(gid, []);
    return groups.get(gid);
  }

  function pushGroup(gid, msg) {
    const list = groupBuffer(gid);
    list.push(msg);
    if (list.length > GROUP_CONTEXT) list.splice(0, list.length - GROUP_CONTEXT);
  }

  async function handleGroup(event, segs, self) {
    if (!config.qq.group) return { handled: false, reason: "group-off" };
    const gid = String(event.group_id);
    const allow = config.qq.groupAllowList;
    if (allow.length && !allow.includes(gid)) return { handled: false, reason: "group-not-allowed" };
    const c = await readContent(segs, self);
    const sender = event.sender || {};
    const name = sender.card || sender.nickname || String(event.user_id);
    const plain = plainText(c);

    const named = !config.qq.groupAtOnly && config.friend.name && plain.includes(config.friend.name);
    const triggered = c.mentioned || c.quoteFromSelf || named;
    if (!triggered) {
      if (plain) pushGroup(gid, { role: "user", text: plain, ts: now(), name });
      return { handled: false, reason: "group-not-triggered" };
    }

    const target = { kind: "group", id: gid };
    enqueue(`g:${gid}:${event.user_id}`, { content: c, quote: c.quote, msgId: event.message_id, name }, async (items) => {
      for (const x of items) {
        x.text = (await seeImages(x.content)) || "（@了你）";
        pushGroup(gid, { role: "user", text: x.text, ts: now(), name: x.name });
      }
      const result = await brain.reply({
        sessionId: `qqg_${gid}`,
        channel: "qq",
        isGroup: true,
        speaker: name,
        texts: items.map((x) => x.text),
        quote: items.map((x) => x.quote).filter(Boolean).pop() || "",
        groupContext: groupBuffer(gid).slice(),
      });
      if (!result) return;
      pushGroup(gid, { role: "assistant", text: result.text || result.bubbles.join("\n"), ts: now() });
      await sendBubbles(target, result, items[items.length - 1].msgId);
    });
    return { handled: true, sessionId: `qqg_${gid}` };
  }

  async function handlePoke(event) {
    const self = selfId(event);
    if (String(event.target_id) !== String(self) || event.group_id) return { handled: false, reason: "poke-ignored" };
    const uid = String(event.user_id);
    const owners = ownerList();
    if (config.owner.onlyOwner && owners.length && !owners.includes(uid)) return { handled: false, reason: "not-owner" };
    if (isDuplicate(`poke:${uid}:${Math.floor(now() / 3000)}`)) return { handled: false, reason: "duplicate" };
    enqueue(`p:${uid}`, { text: "（戳了戳你）", poke: true }, privateRunner(uid));
    return { handled: true };
  }

  /** 收到 /onebot 请求（app.js 调用）：校验签名 → 解析 → 立即返回，异步处理 */
  function accept(headers, rawBody) {
    const v = verifyInbound(headers, rawBody, { token: config.qq.token, mode: config.qq.inboundAuth });
    if (!v.ok) return { status: 401, error: "签名不对" };
    if (v.via === "missing" && !warnedNoSig) {
      warnedNoSig = true;
      log.warn("NapCat 的上报没带签名。确认 NapCat 的 HTTP 上报里填了和 config 一样的 token 后，可以把 qq.inboundAuth 改成 required 更安全");
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { status: 400, error: "不是合法 JSON" };
    }
    setImmediate(() => handleEvent(event).catch((e) => log.warn("处理 QQ 事件失败：" + e.message)));
    return { status: 204 };
  }

  /** 主动消息：给主人发（由定时器调用） */
  async function sendProactive(o = {}) {
    const owner = ownerList()[0];
    if (!owner) return false;
    const result = await brain.proactive("main", o);
    if (!result) return false;
    await sendBubbles({ kind: "private", id: owner }, result);
    log.info("主动给主人发了消息：" + result.bubbles.join(" / "));
    return true;
  }

  async function fetchSelfId() {
    try {
      const r = await callApi("get_login_info", {});
      if (r.data && r.data.user_id) selfIdCache = Number(r.data.user_id);
      return r.data || null;
    } catch {
      return null;
    }
  }

  return { accept, handleEvent, callApi, sendBubbles, sendProactive, fetchSelfId, idle, stats: () => ({ ...stats, selfId: selfIdCache || config.qq.selfId }), _groups: groups };
}

module.exports = { createOneBot, verifyInbound, parseCQ, normalizeSegments };
