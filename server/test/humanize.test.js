"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOutput, toBubbles, toSegments, plan, splitLong } = require("../lib/humanize");

test("解析〔想〕〔心情〕，消息行去掉序号、名字、引号", () => {
  const raw = "〔想〕他好像不开心\n【心情】：担心\n1. 小满：「怎么啦」\n- 跟我说说。";
  const r = parseOutput(raw, { selfName: "小满" });
  assert.equal(r.thought, "他好像不开心");
  assert.equal(r.mood, "担心");
  assert.deepEqual(r.lines, ["怎么啦", "跟我说说。"]);
});

test("没有标记时整段都当消息，心情默认平静", () => {
  const r = parseOutput("哈哈好的\n那就这么定了");
  assert.equal(r.mood, "平静");
  assert.deepEqual(r.lines, ["哈哈好的", "那就这么定了"]);
});

test("去 AI 腔：删掉客服句，保留正常内容", () => {
  const b = toBubbles(["作为一个AI，我没有情绪。不过听起来你今天挺累的", "希望对你有帮助！"]);
  assert.deepEqual(b, ["不过听起来你今天挺累的"]);
});

test("全是 AI 腔时不会变成空回复", () => {
  const b = toBubbles(["希望对你有帮助"]);
  assert.equal(b.length, 1);
});

test("句末句号去掉，长句按标点拆开", () => {
  assert.deepEqual(toBubbles(["好的。"]), ["好的"]);
  const parts = splitLong("今天去了趟超市买了好多东西。结果回家发现忘买最重要的酱油了！气死我了真的是，下次一定列清单。");
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 40));
});

test("超过条数上限时合并到最后一条", () => {
  const b = toBubbles(["一", "二", "三", "四", "五"], { maxBubbles: 3 });
  assert.equal(b.length, 3);
  assert.equal(b[2], "三 四 五");
});

test("QQ 表情：未知名字删掉，开心时不发负面表情，一轮最多一个", () => {
  assert.deepEqual(toBubbles(["好耶[QQ脸:吐]"], { mood: "开心" }), ["好耶"]);
  assert.deepEqual(toBubbles(["好耶[QQ脸:不存在]"]), ["好耶"]);
  assert.deepEqual(toBubbles(["哈哈[QQ脸:呲牙]", "好[QQ脸:微笑]"], { mood: "开心" }), ["哈哈[QQ脸:呲牙]", "好"]);
});

test("消息段：文字 + face", () => {
  assert.deepEqual(toSegments("哈哈[QQ脸:偷笑]"), [
    { type: "text", data: { text: "哈哈" } },
    { type: "face", data: { id: "20" } },
  ]);
});

test("发送节奏：生成越久，第一条等得越少；关闭时不等待", () => {
  const a = plan(["好的呀"], { inputLength: 10, elapsedMs: 0, random: () => 0.5 });
  const b = plan(["好的呀"], { inputLength: 10, elapsedMs: 3000, random: () => 0.5 });
  assert.ok(a.firstDelayMs > b.firstDelayMs);
  assert.equal(plan(["好"], { enabled: false }).firstDelayMs, 0);
});
