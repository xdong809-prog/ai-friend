"use strict";
/*
 * 表情包库：它自己能发的表情包。
 * 来源：
 *   1) 旧版收藏：首次启动时从旧项目（stickers.importFrom）导入群里收藏过、已打好情绪标签的表情包；
 *      没打过标签的，在后台慢慢用看图模型补标签（不是表情包的截图、二维码会被跳过）；
 *   2) 你发给它的表情包：看懂后收进库里（stickers.collect），它会学着用你的表情包回你。
 * 发送：模型在回复里写 [表情包:关键词]，这里按关键词 + 当前心情挑一张最合适、最近没用过的。
 * 存储：data/stickers/<sha1>.<ext> + data/stickers/index.json
 */
const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJsonAtomic, ensureDir } = require("./util");
const { sniffImage, sha1 } = require("./vision");

const NOT_REACTION_RE = /(截图|页面|界面|列表|通知|签到|座位|二维码|金币|公告|弹窗|聊天记录|表格|网页|文档|海报|头像|封面|证件|票据|游戏画面)/;
const LEGACY_MOOD = { happy: "开心", celebrate: "开心", shy: "害羞", comfort: "安慰", sad: "难过", angry: "生气", disgust: "嫌弃", neutral: "平静", question: "疑问" };
/** 它此刻的心情 → 适合的表情包情绪 */
const MOOD_MATCH = {
  开心: ["开心", "搞笑", "得意", "喜欢"],
  兴奋: ["开心", "搞笑", "惊讶", "得意"],
  平静: ["平静", "疑问", "无语", "搞笑"],
  低落: ["难过", "委屈"],
  委屈: ["委屈", "难过"],
  烦躁: ["无语", "生气", "嫌弃"],
  害羞: ["害羞", "喜欢"],
  担心: ["安慰", "疑问"],
};
/** 关键词里的常见说法 → 情绪 */
const WORD_MOOD = [
  [/抱|安慰|摸摸|贴贴|没事/, "安慰"],
  [/哈|笑|乐|逗|绷不住/, "搞笑"],
  [/无语|服了|呵呵|离谱|6/, "无语"],
  [/嫌弃|鄙视|切/, "嫌弃"],
  [/气|怒|打/, "生气"],
  [/哭|难过|伤心|emo/, "难过"],
  [/委屈|可怜|呜/, "委屈"],
  [/害羞|脸红|羞/, "害羞"],
  [/爱|喜欢|亲|心/, "喜欢"],
  [/问号|疑惑|啊？|什么/, "疑问"],
  [/惊|震惊|啊这/, "惊讶"],
  [/得意|骄傲|厉害|牛/, "得意"],
  [/困|睡|晚安/, "困"],
  [/开心|耶|好耶|高兴/, "开心"],
];
const RECENT_LIMIT = 8;

function grams(s) {
  const t = String(s || "").replace(/[\s，。,.!！?？：:、「」“”"'（）()\[\]]/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (t.length === 1) set.add(t);
  return set;
}

function createStickers({ config, dataDir, vision, log, random = Math.random, now = Date.now }) {
  const dir = path.join(dataDir, "stickers");
  const indexFile = path.join(dir, "index.json");
  ensureDir(dir);
  const index = { items: {}, legacySeen: {}, legacyImported: false, ...(readJson(indexFile, {}) || {}) };
  const recent = [];
  let legacyRunning = false;

  function save() {
    try {
      writeJsonAtomic(indexFile, index);
    } catch (e) {
      log.warn("保存表情包索引失败：" + e.message);
    }
  }

  function list() {
    return Object.entries(index.items)
      .filter(([, v]) => v.enabled !== false && fs.existsSync(path.join(dir, v.file)))
      .map(([id, v]) => ({ id, ...v }));
  }

  function count() {
    return list().length;
  }

  function add(buf, { desc, mood, source }) {
    const ext = sniffImage(buf);
    if (!ext) return null;
    const id = sha1(buf);
    if (index.items[id] && index.items[id].enabled !== false) return id;
    if (desc && NOT_REACTION_RE.test(desc)) return null;
    const file = `${id}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buf);
    index.items[id] = { file, desc: String(desc || "").slice(0, 80), mood: mood || "平静", source: source || "user", addedAt: now(), uses: 0, lastUsedAt: 0, enabled: true };
    save();
    return id;
  }

  function remove(id) {
    const it = index.items[id];
    if (!it) return false;
    try {
      fs.unlinkSync(path.join(dir, it.file));
    } catch {
      /* 已经不在了 */
    }
    it.enabled = false;
    save();
    return true;
  }

  function filePath(id) {
    const it = index.items[id];
    if (!it || it.enabled === false || !/^[a-f0-9]{40}$/.test(id)) return null;
    const p = path.join(dir, it.file);
    return fs.existsSync(p) ? p : null;
  }

  /** 按关键词 + 心情挑一张；没有合适的返回 null（宁可不发，也别乱发） */
  function pick(keyword, aiMood = "平静") {
    const all = list();
    if (!all.length) return null;
    const kw = String(keyword || "").trim();
    const wanted = new Set(MOOD_MATCH[aiMood] || []);
    for (const [re, m] of WORD_MOOD) if (re.test(kw)) wanted.add(m);
    const q = grams(kw);
    const score = (it) => {
      let s = 0;
      const g = grams(it.desc);
      for (const x of q) if (g.has(x)) s += 2;
      if (kw && it.mood === kw) s += 4;
      if (wanted.has(it.mood)) s += 3;
      return s;
    };
    // 先在最近没用过的里面挑；实在没有合适的，再允许重复用（真人也会反复用同一张）
    let scored = [];
    for (const pass of [false, true]) {
      for (const it of all) {
        if (!pass && recent.includes(it.id)) continue;
        const s = score(it);
        if (s > 0) scored.push({ it, s: s - (it.uses || 0) * 0.1 });
      }
      if (scored.length) break;
      scored = [];
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, 3);
    const chosen = top[Math.floor(random() * top.length)].it;
    recent.push(chosen.id);
    if (recent.length > RECENT_LIMIT) recent.shift();
    const rec = index.items[chosen.id];
    rec.uses = (rec.uses || 0) + 1;
    rec.lastUsedAt = now();
    save();
    return { id: chosen.id, desc: chosen.desc, path: path.join(dir, chosen.file) };
  }

  /** 收下对方发来的表情包（已经看过图的） */
  function collect(image, desc) {
    if (!config.stickers.collect || !image || !desc || !desc.sticker) return null;
    return add(image.buf, { desc: desc.desc, mood: desc.mood, source: "user" });
  }

  /** 从旧项目导入：先导入已打标签的，再在后台给没标签的补标签 */
  function importLegacy() {
    const root = config.stickers.importFrom;
    if (!root || legacyRunning) return { imported: 0 };
    const groupsDir = path.join(root, "output", "stickers", "groups");
    if (!fs.existsSync(groupsDir)) return { imported: 0 };
    const files = fs.readdirSync(groupsDir).filter((n) => /^[a-f0-9]{40}\.(?:jpg|jpeg|png|gif|webp)$/i.test(n));
    const byId = new Map(files.map((n) => [n.slice(0, 40), n]));
    let imported = 0;
    if (!index.legacyImported) {
      const brain = readJson(path.join(root, "data", "stickers", "brain.json"), {}) || {};
      for (const [id, e] of Object.entries(brain)) {
        index.legacySeen[id] = true;
        const name = byId.get(id);
        if (!name || !e || e.usable === false || !e.desc || NOT_REACTION_RE.test(e.desc)) continue;
        try {
          const buf = fs.readFileSync(path.join(groupsDir, name));
          if (add(buf, { desc: e.desc, mood: LEGACY_MOOD[e.mood] || "平静", source: "legacy" })) imported++;
        } catch {
          /* 读不了就跳过 */
        }
      }
      index.legacyImported = true;
      save();
      if (imported) log.info(`从旧版导入了 ${imported} 张已打标签的表情包`);
    }
    const pending = files.filter((n) => !index.legacySeen[n.slice(0, 40)]);
    if (pending.length && vision && vision.enabled()) tagLater(groupsDir, pending);
    return { imported, pending: pending.length };
  }

  /** 后台慢慢看图打标签：一张一张来，每张间隔一会儿，不抢聊天的资源 */
  function tagLater(groupsDir, names) {
    legacyRunning = true;
    let added = 0;
    log.info(`后台开始整理旧版剩下的 ${names.length} 张群图（看图挑出表情包），不影响聊天`);
    (async () => {
      for (const name of names) {
        const id = name.slice(0, 40);
        try {
          const buf = fs.readFileSync(path.join(groupsDir, name));
          const ext = sniffImage(buf);
          if (ext && buf.length <= 3 * 1024 * 1024) {
            const d = await vision.describe(buf, ext, { hint: "群聊图片" });
            if (!d) break; // 看图服务出问题就先停，下次启动再继续
            if (d.sticker && add(buf, { desc: d.desc, mood: d.mood, source: "legacy" })) added++;
          }
        } catch {
          /* 单张失败跳过 */
        }
        index.legacySeen[id] = true;
        save();
        await new Promise((r) => setTimeout(r, 1500));
      }
      legacyRunning = false;
      log.info(`旧版群图整理完了，新增 ${added} 张表情包，现在库里一共 ${count()} 张`);
    })();
  }

  return { add, remove, pick, collect, list, count, filePath, importLegacy, dir };
}

module.exports = { createStickers, NOT_REACTION_RE, MOOD_MATCH };
