"use strict";
/* 用量看板：每次调用都记账；DeepSeek 按官方价估算（高峰翻倍）；没价格的只记 token；重启不清零 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { start, fakeNet } = require("./_helpers");
const { createUsage, priceOf, inPeak } = require("../lib/usage");
const { normalizeConfig } = require("../lib/config");

const OFF_PEAK = Date.UTC(2026, 10, 6, 12, 0); // 周五 UTC 12 点：非高峰
const PEAK = Date.UTC(2026, 10, 6, 7, 0); // 周五 UTC 7 点：高峰
const SATURDAY_PEAK_HOUR = Date.UTC(2026, 10, 7, 7, 0); // 周六不算高峰
const usageOf = { prompt_tokens: 1000, prompt_cache_hit_tokens: 600, completion_tokens: 200 };
const PRO = { id: "ds", preset: "deepseek", apiKey: "sk-ds-1234567", model: "deepseek-v4-pro" };

test("价格：DeepSeek 内置官方价，高峰时段翻倍、周末不算；手动填的价格优先；不认识的模型没有价格", () => {
  assert.equal(inPeak({ utc: [[1, 4], [6, 10]], weekdaysOnly: true }, PEAK), true);
  assert.equal(inPeak({ utc: [[1, 4], [6, 10]], weekdaysOnly: true }, SATURDAY_PEAK_HOUR), false);
  assert.deepEqual(priceOf(PRO, "deepseek-v4-pro", OFF_PEAK), { hit: 0.022, miss: 0.66, out: 1.98 });
  assert.deepEqual(priceOf(PRO, "deepseek-v4-pro", PEAK), { hit: 0.044, miss: 1.32, out: 3.96 });
  assert.equal(priceOf(PRO, "deepseek-chat", OFF_PEAK), null);
  assert.deepEqual(priceOf({ ...PRO, prices: { hit: 1, miss: 2, out: 3 } }, "deepseek-v4-pro", PEAK), { hit: 1, miss: 2, out: 3 });
  // 设置里的价格：三个都填才算
  const c = normalizeConfig({ providers: [{ ...PRO, prices: { hit: "0.1", miss: "0.2", out: "0.3" } }, { id: "x", preset: "custom", baseUrl: "http://a/v1", model: "m", prices: { hit: "", miss: "1", out: "1" } }] });
  assert.deepEqual(c.providers[0].prices, { hit: 0.1, miss: 0.2, out: 0.3 });
  assert.equal(c.providers[1].prices, undefined);
});

test("聊天一次记一笔：token、花费、失败次数都对；网页接口能看到今天、近 7 天、本月和 14 天", async () => {
  let fail = false;
  const net = fakeNet({
    llm: (m) => {
      if (fail) return { __status: 500 };
      if (m[0].content.includes("记忆整理")) return { __raw: { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 0, completion_tokens: 0 } } };
      return { __raw: { choices: [{ message: { content: "〔想〕嗯\n〔心情〕平静\n好呀" } }], usage: usageOf } };
    },
  });
  const s = await start({ config: { providers: [PRO], llm: { active: "ds" } }, net, now: () => OFF_PEAK });
  await s.api("POST", "/api/chat", { text: "在吗" });
  fail = true;
  await s.api("POST", "/api/chat", { text: "还在吗" });
  const u = (await s.api("GET", "/api/usage")).json;
  assert.equal(u.today.calls, 1);
  assert.ok(u.today.fails >= 1);
  assert.equal(u.today.prompt, 1000);
  assert.equal(u.today.hit, 600);
  assert.equal(u.today.completion, 200);
  const expected = (600 * 0.022 + 400 * 0.66 + 200 * 1.98) / 1e6;
  assert.ok(Math.abs(u.today.cost - expected) < 1e-12);
  assert.equal(u.daily.length, 14);
  assert.equal(u.daily[13].tokens, 1200);
  assert.deepEqual(u.week.prompt, 1000);
  assert.equal(u.models[0].model, "deepseek-v4-pro");
  await s.close();
});

test("高峰时段按两倍算；没价格的模型只记 token，单独标出来", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-use-"));
  let t = PEAK;
  const u = createUsage({ dataDir, now: () => t });
  u.record(PRO, "deepseek-v4-pro", { prompt: 1000, hit: 600, completion: 200 });
  const peakCost = (600 * 0.044 + 400 * 1.32 + 200 * 3.96) / 1e6;
  assert.ok(Math.abs(u.summary().today.cost - peakCost) < 1e-12);
  u.record(PRO, "deepseek-chat", { prompt: 500, hit: 0, completion: 100 });
  const s = u.summary();
  assert.equal(s.month.unpriced, 600);
  assert.ok(Math.abs(s.month.cost - peakCost) < 1e-12);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("重启不清零：flush 写进文件，新开的能读回来；超过 400 天的旧账自动清掉", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-use-"));
  let t = OFF_PEAK - 500 * 86400000;
  const a = createUsage({ dataDir, now: () => t });
  a.record(PRO, "deepseek-v4-pro", { prompt: 10, hit: 0, completion: 5 });
  t = OFF_PEAK;
  a.record(PRO, "deepseek-v4-pro", { prompt: 100, hit: 0, completion: 50 });
  a.recordFail(PRO, "deepseek-v4-pro");
  a.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "usage.json"), "utf8"));
  assert.equal(Object.keys(saved.days).length, 1);
  const b = createUsage({ dataDir, now: () => t });
  assert.deepEqual([b.summary().today.prompt, b.summary().today.fails], [100, 1]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
