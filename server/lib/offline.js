"use strict";
/*
 * 没有大模型（没填 Key 或接口挂了）时的兜底回复。
 * 只保证「不会已读不回」，不追求聪明；真正的聊天能力靠大模型。
 */
const RULES = [
  { re: /^(在吗|在不在|在么|hi|hello|哈喽|嗨|你好)[?？!！~～]*$/i, lines: ["在呢", "在的在的", "嗯？咋啦"] },
  { re: /(累|难过|伤心|烦|崩溃|想哭|压力|焦虑|失眠|emo)/, lines: ["抱抱，先歇会儿吧", "怎么了，跟我说说", "辛苦了…我在呢"] },
  { re: /(哈哈|笑死|hhh|233)/i, lines: ["哈哈哈哈", "笑死我了", "绷不住了"] },
  { re: /(谢谢|多谢|感谢|谢啦)/, lines: ["客气啥", "嘿嘿不用谢", "小事儿"] },
  { re: /(晚安|睡了|去睡)/, lines: ["晚安，早点睡", "好梦～"] },
  { re: /(早安|早上好|早啊)/, lines: ["早呀", "早，吃早饭没"] },
  { re: /[?？]$|吗$|什么|怎么|为什么|哪/, lines: ["这个我现在脑子有点转不动，等我缓缓再认真回你", "嗯…让我想想，一会儿回你"] },
];
const DEFAULT = ["嗯嗯", "然后呢", "哦哦这样", "我听着呢"];

function offlineReply(text, random = Math.random) {
  const t = String(text || "").trim();
  for (const r of RULES) {
    if (r.re.test(t)) return [r.lines[Math.floor(random() * r.lines.length)]];
  }
  return [DEFAULT[Math.floor(random() * DEFAULT.length)]];
}

module.exports = { offlineReply };
