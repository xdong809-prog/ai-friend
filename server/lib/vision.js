"use strict";
/*
 * 看图：把 QQ 里收到的图片 / 表情包交给多模态模型，得到一句话描述，写进聊天上下文。
 *   - 看图用哪个模型在「模型」页单独选（llm.visionProvider + visionModel），默认 DeepSeek 的 deepseek-flash；
 *   - 任何 OpenAI 兼容、支持 image_url（base64）的模型都行：Kimi、通义 VL、GLM-4V、Gemini、GPT、Claude……
 *   - 结果按图片内容的 sha1 缓存，同一张表情包只看一次；
 *   - 失败时返回 null，上层会如实告诉模型「这张图你看不到」，避免它装作看见了。
 */
const crypto = require("node:crypto");
const path = require("node:path");
const { readJson, writeJsonAtomic } = require("./util");
const { parseJsonLoose } = require("./llm");

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CACHE = 3000;
const MOODS = ["开心", "搞笑", "无语", "嫌弃", "生气", "委屈", "难过", "害羞", "喜欢", "安慰", "疑问", "惊讶", "得意", "困", "平静"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/** 按文件头判断图片类型；不是图片返回空串 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 4).toString("hex") === "89504e47") return "png";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return "gif";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  return "";
}

const MIME = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

/** 下载图片（QQ 的图片链接需要带浏览器 UA）；失败抛错 */
async function downloadImage(url, fetchImpl, timeoutMs = 10000) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("不是可下载的图片地址");
  const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("图片下载失败 HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error("图片太大或为空");
  const ext = sniffImage(buf);
  if (!ext) throw new Error("下载到的不是图片");
  return { buf, ext, sha1: sha1(buf) };
}


function createVision({ config, llm, dataDir, log, fetch = globalThis.fetch, now = Date.now }) {
  const cacheFile = path.join(dataDir, "vision-cache.json");
  let cache = readJson(cacheFile, {}) || {};
  let dirty = false;
  let saveTimer = null;
  const inflight = new Map();
  const stats = { ok: 0, fail: 0, lastError: "" };

  function enabled() {
    return Boolean(config.llm.visionEnabled && llm.enabled("vision"));
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function flush() {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE) {
      keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - MAX_CACHE).forEach((k) => delete cache[k]);
    }
    try {
      writeJsonAtomic(cacheFile, cache);
    } catch (e) {
      log.warn("保存看图缓存失败：" + e.message);
    }
  }

  function cached(hash) {
    return cache[hash] || null;
  }

  /**
   * 看一张图。
   * @param {Buffer} buf
   * @param {string} ext
   * @param {{hint?:string}} [o]  hint：QQ 给的摘要，比如「[动画表情]」
   * @returns {Promise<{desc:string, mood:string, sticker:boolean}|null>}
   */
  async function describe(buf, ext, o = {}) {
    const hash = sha1(buf);
    if (cache[hash]) return cache[hash];
    if (!enabled()) return null;
    if (inflight.has(hash)) return inflight.get(hash);
    const task = (async () => {
      const url = `data:${MIME[ext] || "image/png"};base64,${buf.toString("base64")}`;
      const prompt =
        "这是 QQ 聊天里收到的一张图片" + (o.hint ? `（QQ 标注为「${o.hint}」）` : "") + "。请看懂它，只输出一个 JSON：\n" +
        '{"desc":"一句话说清画面内容和图里的文字（不超过60字）","mood":"它表达的情绪","sticker":是否是表情包(true/false)}\n' +
        `mood 从这些里选一个：${MOODS.join("、")}。表情包要说清是什么角色/动作/配字，比如「熊猫头捂脸，配字：我真的会谢」。`;
      try {
        const raw = await llm.chat(
          [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url } }] }],
          { use: "vision", temperature: 0.1, maxTokens: 400, timeoutMs: 30000, noFallback: true }
        );
        const j = parseJsonLoose(raw) || { desc: String(raw).slice(0, 80) };
        const out = {
          desc: String(j.desc || "").replace(/\s+/g, " ").trim().slice(0, 80),
          mood: MOODS.includes(j.mood) ? j.mood : "平静",
          sticker: j.sticker === true || j.sticker === "true",
          at: now(),
        };
        if (!out.desc) throw new Error("看图模型没给出描述");
        cache[hash] = out;
        scheduleSave();
        stats.ok++;
        return out;
      } catch (e) {
        stats.fail++;
        stats.lastError = e.friendly || e.message;
        log.warn("看图失败：" + stats.lastError);
        return null;
      } finally {
        inflight.delete(hash);
      }
    })();
    inflight.set(hash, task);
    return task;
  }

  /** 下载 + 看图，一步到位；任何一步失败返回 {ok:false} */
  async function fromUrl(url, o = {}) {
    try {
      const img = await downloadImage(url, fetch);
      const d = await describe(img.buf, img.ext, o);
      return { ok: Boolean(d), image: img, desc: d };
    } catch (e) {
      log.debug("取图失败：" + e.message);
      return { ok: false, error: e.message };
    }
  }

  return { enabled, describe, fromUrl, cached, flush, stats: () => {
      const r = llm.resolve("vision");
      return { ...stats, model: r ? `${r.provider.name.split(" · ")[0]} · ${r.model}` : "", enabled: enabled() };
    }, };
}

module.exports = { createVision, downloadImage, sniffImage, sha1, MIME, MOODS };
