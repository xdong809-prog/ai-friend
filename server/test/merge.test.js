"use strict";
/*
 * 连发合并：等对方说完再一起回（话没说完多等、正在输入接着等、想的时候又来消息就重新想）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, fakeNet } = require("./_helpers");
const { looksUnfinished, mergeWait } = require("../lib/humanize");

const BOT = 10001;
const OWNER = 123456;
const txt = (t) => ({ type: "text", data: { text: t } });
const priv = (id, text) => ({ post_type: "message", message_type: "private", self_id: BOT, user_id: OWNER, message_id: id, message: [txt(text)] });
const inputStatus = (statusText) => ({ post_type: "notice", notice_type: "notify", sub_type: "input_status", self_id: BOT, user_id: OWNER, group_id: 0, event_type: 1, status_text: statusText });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(mergeWindowMs, { slowFirstMs = 0 } = {}) {
  const chats = [];
  const net = fakeNet({
    llm: async (m) => {
      if (m[0].content.includes("记忆整理")) return "{}";
      chats.push(m);
      if (chats.length === 1 && slowFirstMs) await wait(slowFirstMs);
      return "〔想〕嗯\n〔心情〕开心\n哈哈好啊\n走起";
    },
    onebot: () => ({ message_id: 1 }),
  });
  const config = { llm: { apiKey: "sk-test-1234567890" }, owner: { qq: [String(OWNER)], onlyOwner: true }, qq: { mergeWindowMs, selfId: BOT } };
  return { chats, net, config };
}

const lastUser = (m) => m[m.length - 1].content;
const sent = (net) => net.calls.onebot.filter((c) => c.action === "send_private_msg");

test("看起来没说完：逗号、「然后」、开场白；说完了的不算", () => {
  for (const t of ["我跟你说", "对了！", "今天去面试，", "然后", "我本来想去的但是", "就是说[捂脸]", "嗯那个"]) assert.equal(looksUnfinished(t), true, t);
  for (const t of ["好呀", "就是", "你吃了吗？", "我升职了！", "", "哈哈哈[呲牙]"]) assert.equal(looksUnfinished(t), false, t);
  assert.equal(mergeWait({ text: "我跟你说" }, 3000), 6000);
  assert.equal(mergeWait({ text: "", imageOnly: true }, 3000), 4500);
  assert.equal(mergeWait({ text: "好呀" }, 3000), 3000);
});

test("话没说完（「我跟你说」）会多等一会儿，不会抢答", async () => {
  const { net, config, chats } = setup(300);
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, "我跟你说"));
  await wait(450); // 超过平时的 300ms，但没超过「没说完」的 600ms
  assert.equal(chats.length, 0);
  await s.api("POST", "/onebot", priv(2, "我升职了！"));
  await wait(500);
  await s.onebot.idle();
  assert.equal(chats.length, 1);
  assert.equal(lastUser(chats[0]), "我跟你说\n我升职了！");
  await s.close();
});

test("QQ 显示对方正在输入：接着等；停止输入后很快就回", async () => {
  const { net, config, chats } = setup(200);
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, "今天好累"));
  await s.api("POST", "/onebot", inputStatus("对方正在输入..."));
  await wait(500);
  assert.equal(chats.length, 0);
  await s.api("POST", "/onebot", priv(2, "加班到十点"));
  await wait(400);
  await s.onebot.idle();
  assert.equal(chats.length, 1);
  assert.equal(lastUser(chats[0]), "今天好累\n加班到十点");

  await s.api("POST", "/onebot", priv(3, "算了"));
  await s.api("POST", "/onebot", inputStatus("对方正在输入..."));
  await wait(100);
  await s.api("POST", "/onebot", inputStatus(""));
  await wait(400);
  await s.onebot.idle();
  assert.equal(chats.length, 2);
  await s.close();
});

test("它正在想的时候又来了消息：这版不发，连同新消息一起重新想，聊天记录不重复", async () => {
  const { net, config, chats } = setup(100, { slowFirstMs: 500 });
  const s = await start({ config, net });
  await s.api("POST", "/onebot", priv(1, "周末去爬山吗"));
  await wait(250); // 模型正在想第一版
  await s.api("POST", "/onebot", priv(2, "还是去看电影"));
  await wait(700);
  await s.onebot.idle();
  assert.equal(chats.length, 2);
  assert.equal(lastUser(chats[1]), "周末去爬山吗\n还是去看电影");
  assert.match(chats[1][chats[1].length - 2].content, /连着发了 2 条/);
  assert.equal(sent(net).length, 2); // 只发出了一版（两条气泡）
  const h = s.memory.history("main", 20).messages;
  assert.deepEqual(h.filter((m) => m.role === "user").map((m) => m.text), ["周末去爬山吗", "还是去看电影"]);
  assert.equal(h.filter((m) => m.role === "assistant").length, 1);
  await s.close();
});
