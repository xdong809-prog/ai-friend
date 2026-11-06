"use strict";
/*
 * 用量账本：每次调大模型记一笔（按天、按模型），存在 data/usage.json，重启不清零。
 *
 * 花费只是估算，单位美元：
 *   - 优先用「模型」页里手动填的价格；
 *   - 其次用 presets.js 里记的官方价格（含高峰时段加价），在调用时算好记下来；
 *   - 都没有就只记 token，并标成「没有价格」，不瞎估。
 * 最多 30 秒写一次文件，关闭时再写一次（flush）。
 */
const path = require("node:path");
const { readJson, writeJsonAtomic, ymd } = require("./util");
const { presetOf } = require("./presets");

const KEEP_DAYS = 400;
const FLUSH_MS = 30000;
const CHART_DAYS = 14;

/** 现在是不是高峰时段（peak.utc 是 UTC 的小时区间） */
function inPeak(peak, t) {
  if (!peak) return false;
  const d = new Date(t);
  if (peak.weekdaysOnly && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) return false;
  const h = d.getUTCHours();
  return peak.utc.some(([from, to]) => h >= from && h < to);
}

/** 这个模型此刻的价格（每百万 token，美元）；不知道就返回 null */
function priceOf(provider, model, t) {
  const own = provider.prices;
  if (own && [own.hit, own.miss, own.out].every(Number.isFinite)) return own;
  const pricing = (presetOf(provider.preset) || {}).pricing;
  const base = pricing && pricing.models[model];
  if (!base) return null;
  const mult = inPeak(pricing.peak, t) ? pricing.peak.mult : 1;
  return { hit: base.hit * mult, miss: base.miss * mult, out: base.out * mult };
}

function emptyTotals() {
  return { calls: 0, fails: 0, prompt: 0, hit: 0, completion: 0, cost: 0, unpriced: 0 };
}

const NUMBERS = Object.keys(emptyTotals());

function addTo(total, b) {
  for (const k of NUMBERS) total[k] += b[k] || 0;
  return total;
}

function createUsage({ dataDir, now = Date.now }) {
  const file = path.join(dataDir, "usage.json");
  const loaded = readJson(file, null);
  const days = loaded && loaded.days && typeof loaded.days === "object" ? loaded.days : {};
  let dirty = false;
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    const cutoff = ymd(now() - KEEP_DAYS * 86400000);
    for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
    writeJsonAtomic(file, { days });
  }

  function touch() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, FLUSH_MS);
    if (timer.unref) timer.unref();
  }

  function bucket(provider, model, t) {
    const day = (days[ymd(t)] = days[ymd(t)] || {});
    const key = `${provider.id}|${model}`;
    if (!day[key]) day[key] = { provider: provider.name || provider.id, model, ...emptyTotals() };
    return day[key];
  }

  /** 拿到一次回复（空回复也收费，也记） */
  function record(provider, model, { prompt = 0, hit = 0, completion = 0 } = {}) {
    const t = now();
    const b = bucket(provider, model, t);
    b.calls++;
    b.prompt += prompt;
    b.hit += hit;
    b.completion += completion;
    const price = priceOf(provider, model, t);
    if (price) b.cost += (hit * price.hit + Math.max(0, prompt - hit) * price.miss + completion * price.out) / 1e6;
    else b.unpriced += prompt + completion;
    touch();
  }

  /** 一次失败的调用（超时、接口报错、空回复） */
  function recordFail(provider, model) {
    bucket(provider, model, now()).fails++;
    touch();
  }

  /** 网页看板用：今天、近 7 天、本月、近 14 天每天、本月各模型 */
  function summary() {
    const t = now();
    const dayOf = (back) => {
      const d = new Date(t);
      d.setDate(d.getDate() - back);
      return ymd(d.getTime());
    };
    const totalOf = (names) => {
      const total = emptyTotals();
      for (const n of names) for (const b of Object.values(days[n] || {})) addTo(total, b);
      return total;
    };
    const today = dayOf(0);
    const week = Array.from({ length: 7 }, (_, i) => dayOf(i));
    const month = Object.keys(days).filter((n) => n.slice(0, 7) === today.slice(0, 7));
    const models = new Map();
    for (const n of month) {
      for (const [key, b] of Object.entries(days[n])) {
        if (!models.has(key)) models.set(key, { provider: b.provider, model: b.model, ...emptyTotals() });
        addTo(models.get(key), b);
      }
    }
    return {
      today: totalOf([today]),
      week: totalOf(week),
      month: totalOf(month),
      daily: Array.from({ length: CHART_DAYS }, (_, i) => {
        const day = dayOf(CHART_DAYS - 1 - i);
        const x = totalOf([day]);
        return { day, tokens: x.prompt + x.completion, cost: x.cost, calls: x.calls, fails: x.fails };
      }),
      models: [...models.values()].sort((a, b) => b.prompt + b.completion - (a.prompt + a.completion)),
    };
  }

  return { record, recordFail, summary, flush };
}

module.exports = { createUsage, priceOf, inPeak };
