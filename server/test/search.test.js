"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, fakeNet } = require("./_helpers");
const { detectSearchIntent, parseBing, decodeBingUrl } = require("../lib/search");

const KEY = { llm: { apiKey: "sk-test-1234567890" } };

const BING_HTML = `<ol id="b_results">
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=1&u=a1${Buffer.from("https://news.example.com/a").toString("base64url")}&ntb=1">湖人 118:110 勇士 &amp; 詹姆斯</a></h2><div class="b_caption"><p>昨晚湖人主场击败勇士……</p></div></li>
<li class="b_algo"><h2><a href="https://sports.example.cn/b">NBA 常规赛战报</a></h2><p>比赛结果一览</p></li>
</ol>`;

test("搜索意图：明确让搜、问天气新闻才预先搜；闲聊不搜", () => {
  assert.deepEqual(detectSearchIntent("帮我搜一下湖人昨天比分"), { should: true, query: "湖人昨天比分" });
  assert.equal(detectSearchIntent("你能帮我搜一下吗").should, false);
  assert.equal(detectSearchIntent("杭州明天天气怎么样？").should, true);
  assert.equal(detectSearchIntent("你最近怎么样").should, false);
  assert.equal(detectSearchIntent("今天好累").should, false);
});

test("Bing 结果解析：跳转链接解码、实体解码", () => {
  const r = parseBing(BING_HTML);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, "https://news.example.com/a");
  assert.equal(r[0].title, "湖人 118:110 勇士 & 詹姆斯");
  assert.equal(r[0].snippet, "昨晚湖人主场击败勇士……");
  assert.equal(decodeBingUrl("https://example.org/x"), "https://example.org/x");
});

test("模型自己决定要搜：先输出〔搜索〕，查完带着资料再回复一次", async () => {
  const chats = [];
  const net = fakeNet({
    web: (url) => (url.includes("bing.com/search") ? BING_HTML : null),
    llm: (m) => {
      if (m[0].content.includes("记忆整理")) return "{}";
      chats.push(m);
      return chats.length === 1 ? "〔想〕得查一下\n〔心情〕平静\n〔搜索〕湖人 勇士 比分" : "〔想〕查到了\n〔心情〕开心\n湖人赢了，118比110";
    },
  });
  const s = await start({ config: KEY, net });
  const r = await s.api("POST", "/api/chat", { text: "昨晚那场球谁赢了" });
  assert.deepEqual(r.json.bubbles, ["湖人赢了，118比110"]);
  assert.equal(chats.length, 2);
  assert.match(chats[1][chats[1].length - 2].content, /刚联网查到的资料[\s\S]*湖人 118:110 勇士/);
  assert.equal(r.json.search.engine, "bing");
  await s.close();
});

test("明确说「帮我查」：先搜再回，只调用一次模型", async () => {
  const chats = [];
  const net = fakeNet({
    web: (url) => (url.includes("bing.com/search") ? BING_HTML : null),
    llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : (chats.push(m), "〔想〕嗯\n〔心情〕平静\n湖人赢了")),
  });
  const s = await start({ config: KEY, net });
  await s.api("POST", "/api/chat", { text: "帮我查一下湖人昨天比分" });
  assert.equal(chats.length, 1);
  assert.match(chats[0][chats[0].length - 2].content, /刚联网查到的资料/);
  assert.match(net.calls.web[0], /q=%E6%B9%96%E4%BA%BA/);
  await s.close();
});

test("搜不到：如实告诉模型没查到，不让它编", async () => {
  const chats = [];
  const net = fakeNet({
    web: () => null,
    llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : (chats.push(m), chats.length === 1 ? "〔想〕查查\n〔心情〕平静\n〔搜索〕某某新闻" : "〔想〕没查到\n〔心情〕平静\n没查到诶")),
  });
  const s = await start({ config: KEY, net });
  const r = await s.api("POST", "/api/chat", { text: "最近那个新闻你知道吗" });
  assert.deepEqual(r.json.bubbles, ["没查到诶"]);
  assert.match(chats[1][chats[1].length - 2].content, /没查到/);
  await s.close();
});

test("关闭联网搜索：提示词里不出现〔搜索〕用法", async () => {
  const chats = [];
  const net = fakeNet({ llm: (m) => (m[0].content.includes("记忆整理") ? "{}" : (chats.push(m), "〔想〕嗯\n〔心情〕平静\n好")) });
  const s = await start({ config: { ...KEY, search: { enabled: false } }, net });
  await s.api("POST", "/api/chat", { text: "帮我查一下天气" });
  assert.doesNotMatch(chats[0][0].content, /〔搜索〕关键词/);
  assert.equal(net.calls.web.length, 0);
  await s.close();
});
