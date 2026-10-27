"use strict";
/*
 * 联网搜索：只在需要实时信息时用（天气、新闻、价格、比赛、版本、人物近况……）。
 * 解析代码沿用旧项目实测可用的 Bing / 搜狗 / wttr.in 天气 / 维基百科摘要。
 * 只取搜索结果的标题和摘要，不去抓任意网页正文（避免访问到内网地址之类的安全问题）。
 * search() 永不抛异常：失败返回空结果，聊天照常进行。
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_TEXT = 200;

function decodeEntities(text) {
  return String(text == null ? "" : text)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#([0-9]+);/g, (m, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; }
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function cleanText(html, max = MAX_TEXT) {
  const t = decodeEntities(String(html || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max) : t;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function validUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return /^https?:$/.test(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
}

function decodeHtml(buf, contentType) {
  const dec = (enc) => {
    try { return new TextDecoder(enc).decode(buf); } catch { return ""; }
  };
  const m = /charset=["']?([a-z0-9_-]+)/i.exec(String(contentType || "")) || /charset=["']?([a-z0-9_-]+)/i.exec(buf.slice(0, 4096).toString("latin1"));
  if (m && /gbk|gb2312|gb18030/i.test(m[1])) return dec("gbk") || dec("utf-8");
  const utf = dec("utf-8");
  if (utf.includes("�")) {
    const gbk = dec("gbk");
    if (gbk && !gbk.includes("�")) return gbk;
  }
  return utf;
}

function decodeBingUrl(raw) {
  const href = decodeEntities(String(raw || "").trim());
  if (/^https?:\/\//i.test(href) && !href.includes("bing.com/ck/a")) return validUrl(href);
  try {
    const u = new URL(href, "https://www.bing.com");
    let real = u.searchParams.get("u") || "";
    if (/^a1/i.test(real)) {
      const s = real.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      real = Buffer.from(s + "===".slice((s.length + 3) % 4), "base64").toString("utf8");
    }
    return validUrl(real);
  } catch {
    return "";
  }
}

function parseBing(html) {
  const out = [];
  const re = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    const block = m[1];
    const a = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = decodeBingUrl(a[1]);
    const title = cleanText(a[2]);
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) || /<div[^>]*class="[^"]*(?:b_caption|b_snippet)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    if (url && title) out.push({ title, url, snippet: p ? cleanText(p[1]) : "", site: hostOf(url) });
  }
  return out;
}

function parseSogou(html) {
  const out = [];
  const re = /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    let url = "";
    try { url = validUrl(new URL(decodeEntities(m[1]), "https://www.sogou.com").toString()); } catch { url = ""; }
    const title = cleanText(m[2]);
    const tail = html.slice(m.index, m.index + 2500);
    const sn = /<div[^>]*class="[^"]*(?:text-layout|star-wiki|fz-mid|str_info)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(tail) || /<p[^>]*class="[^"]*(?:star-wiki|str_info)[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(tail);
    if (url && title) out.push({ title, url, snippet: sn ? cleanText(sn[1]) : "", site: url.includes("sogou.com/link") ? "搜狗" : hostOf(url) });
  }
  return out;
}

/** 明显需要联网的说法（其余交给模型自己判断要不要搜） */
const EXPLICIT_RE = /(帮我搜|帮我查|搜一下|搜一搜|查一下|查查|百度一下|网上查|上网查)/;
const REALTIME_RE = /(天气|气温|下雨吗|几度|新闻|热搜|汇率|股价|油价|金价|比分|赛程|今天几号|今天星期)/;

function detectSearchIntent(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length > 80) return { should: false, query: "" };
  if (EXPLICIT_RE.test(raw)) {
    let q = raw
      .replace(/(帮我搜一下|帮我搜|帮我查一下|帮我查|搜一下|搜一搜|查一下|查查|百度一下|网上查|上网查)(一下|看看)?/g, " ")
      .replace(/^(你|你能|能不能|可以|麻烦|请|给我)+/g, "")
      .replace(/[吗呢吧啊呀嘛哈哦]+[?？!！。.~～]*$/g, "")
      .replace(/^[，,。！!？?\s]+|[，,。！!？?\s]+$/g, "")
      .trim();
    if (q.length < 2) return { should: false, query: "" };
    return { should: true, query: q.slice(0, 60) };
  }
  if (REALTIME_RE.test(raw) && /[?？吗呢]|怎么样|多少|如何|啥|什么/.test(raw)) return { should: true, query: raw.replace(/[?？]+$/, "").slice(0, 60) };
  return { should: false, query: "" };
}

function createSearch({ config, log, fetch = globalThis.fetch, now = Date.now }) {
  const cache = new Map();
  const stats = { count: 0, lastQuery: "", lastEngine: "", lastError: "" };

  async function getText(url, timeoutMs, headers = {}) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "zh-CN,zh;q=0.9", ...headers },
      signal: AbortSignal.timeout(Math.max(800, timeoutMs)),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return decodeHtml(Buffer.from(await res.arrayBuffer()), res.headers.get("content-type"));
  }

  async function weather(query, timeoutMs) {
    const city = query.replace(/(今天|明天|后天|现在|这两天|一下|帮我|查查|查一下|搜一下|的|天气|气温|温度|下雨吗|下雨|怎么样|如何|多少度|几度|会不会|[?？，,。！!\s])/g, "").slice(0, 10);
    const text = (await getText(`https://wttr.in/${encodeURIComponent(city)}?format=%l:+%c+%t+体感%f+湿度%h+%w&lang=zh&m`, timeoutMs, { "User-Agent": "curl/8.5.0", Accept: "text/plain" })).replace(/\s+/g, " ").trim();
    if (!text || /unknown location|<html/i.test(text)) throw new Error("天气源没结果");
    return [{ title: `${city || "当前位置"}天气`, url: "https://wttr.in/" + encodeURIComponent(city), snippet: text.slice(0, MAX_TEXT), site: "wttr.in" }];
  }

  async function wiki(query, timeoutMs) {
    const kw = query.replace(/(是什么|是谁|介绍一下|介绍|百科|的意思|什么意思)/g, "").trim().slice(0, 40);
    if (!kw) throw new Error("没有关键词");
    const data = JSON.parse(await getText(`https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(kw)}`, timeoutMs, { Accept: "application/json" }));
    if (!data || !data.extract) throw new Error("百科没有摘要");
    return [{ title: data.title || kw, url: (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page) || "", snippet: String(data.extract).slice(0, 300), site: "维基百科" }];
  }

  async function web(source, query, timeoutMs) {
    if (source === "bing") return parseBing(await getText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-CN`, timeoutMs, { Referer: "https://www.bing.com/" }));
    if (source === "sogou") return parseSogou(await getText(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, timeoutMs, { Referer: "https://www.sogou.com/" }));
    throw new Error("未知搜索源 " + source);
  }

  /** @returns {Promise<{query:string, engine:string, results:{title,url,snippet,site}[]}>} */
  async function search(rawQuery) {
    const query = String(rawQuery || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const empty = { query, engine: "", results: [] };
    if (!query || !config.search.enabled) return empty;
    const hit = cache.get(query);
    if (hit && now() - hit.at < (hit.value.results.length ? 5 * 60000 : 30000)) return JSON.parse(JSON.stringify(hit.value));
    const deadline = now() + config.search.timeoutMs;
    const left = () => deadline - now();
    let engine = "";
    let results = [];
    const sources = config.search.sources;
    const tryOne = async (name, fn) => {
      if (results.length || left() < 500 || !sources.includes(name)) return;
      try {
        const r = (await fn()).filter((x) => x && x.title);
        if (r.length) {
          results = r;
          engine = name;
        }
      } catch (e) {
        log.debug(`搜索源 ${name} 失败：${e.message}`);
      }
    };
    if (/(天气|气温|温度|下雨|几度)/.test(query)) await tryOne("weather", () => weather(query, left()));
    if (/(是什么|是谁|介绍|百科)/.test(query) && query.length < 20) await tryOne("wiki", () => wiki(query, left()));
    for (const s of ["bing", "sogou"]) await tryOne(s, () => web(s, query, left()));
    const out = { query, engine, results: results.slice(0, 5) };
    cache.set(query, { at: now(), value: out });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    stats.count++;
    stats.lastQuery = query;
    stats.lastEngine = engine;
    stats.lastError = results.length ? "" : "没搜到结果";
    if (!results.length) log.warn(`联网搜索「${query}」没有结果（可能网络不通或搜索页改版）`);
    return JSON.parse(JSON.stringify(out));
  }

  /** 给模型看的搜索结果 */
  function toNote(r) {
    if (!r || !r.results.length) return `你刚才想联网查「${r ? r.query : ""}」，但是没查到（网络问题）。如实说没查到，别编。`;
    const rows = r.results.map((x, i) => `${i + 1}. ${x.title}${x.snippet ? "：" + x.snippet : ""}（${x.site}）`);
    return `【刚联网查到的资料】（搜索词：${r.query}）\n${rows.join("\n")}\n用你自己的话、像朋友聊天那样把有用的信息说出来，挑重点，别念清单；资料里没有的别编；需要的话顺口提一句来源网站。`;
  }

  return { search, toNote, detectSearchIntent, stats: () => ({ ...stats }) };
}

module.exports = { createSearch, detectSearchIntent, parseBing, parseSogou, decodeBingUrl, cleanText };
