/* AI 好友 网页端（原生 JS，无依赖） */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let CFG = null;
  let STYLES = [];
  let lastTs = 0;

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "请求失败（" + res.status + "）");
    return data;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return hm;
    return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hm;
  }

  // ---------- 标签页 ----------
  $$(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
      $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + b.dataset.tab));
      if (b.dataset.tab === "memory") loadMemory();
      if (b.dataset.tab === "status") loadStatus();
      if (b.dataset.tab === "models") renderModels();
    })
  );

  // ---------- 聊天 ----------
  const box = $("#messages");
  function maybeTime(ts) {
    if (!lastTs || ts - lastTs > 5 * 60 * 1000) box.appendChild(el("div", "time", fmtTime(ts)));
    lastTs = ts;
  }
  // QQ 小黄脸在网页上用相近的 emoji 显示
  const FACE_EMOJI = {
    微笑: "🙂", 呲牙: "😁", 偷笑: "🤭", 可爱: "🥰", 害羞: "☺️", 调皮: "😜", 坏笑: "😏", 斜眼笑: "😏", doge: "🐶",
    笑哭: "😂", 捂脸: "🤦", 吃瓜: "🍉", 托腮: "🤔", 白眼: "🙄", 疑问: "❓", 晕: "😵", 流汗: "😅", 无奈: "😮‍💨",
    委屈: "🥺", 难过: "😢", 大哭: "😭", 抓狂: "😫", 拥抱: "🤗", 爱心: "❤️", 赞: "👍", OK: "👌", 抱拳: "🙏", 再见: "👋", 哈欠: "🥱",
  };
  const withEmoji = (s) => String(s).replace(/\[([^\[\]]{1,4})\]/g, (all, n) => FACE_EMOJI[n] || all);

  function addMsg(role, text, ts) {
    maybeTime(ts || Date.now());
    const sticker = /^\[表情包:([^\]]+)\]$/.exec(String(text));
    const m = sticker ? el("div", "msg " + role + " sticker-tag", "【表情包：" + sticker[1] + "】") : el("div", "msg " + role, withEmoji(text));
    box.appendChild(m);
    box.scrollTop = box.scrollHeight;
    return m;
  }
  function addSticker(role, url, keyword) {
    maybeTime(Date.now());
    const wrap = el("div", "msg " + role + " sticker");
    const img = document.createElement("img");
    img.src = url;
    img.alt = keyword || "表情包";
    img.title = keyword || "";
    img.addEventListener("load", () => (box.scrollTop = box.scrollHeight));
    wrap.appendChild(img);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }
  function typing(on) {
    let t = $("#typing");
    if (on && !t) {
      t = el("div", "typing");
      t.id = "typing";
      t.innerHTML = "对方正在输入<span>.</span><span>.</span><span>.</span>";
      box.appendChild(t);
      box.scrollTop = box.scrollHeight;
    }
    if (!on && t) t.remove();
  }

  async function loadHistory() {
    try {
      const h = await api("GET", "/api/history?limit=200");
      box.innerHTML = "";
      lastTs = 0;
      if (!h.messages.length) {
        box.appendChild(el("div", "empty", "还没有聊天记录，打个招呼吧"));
        return;
      }
      for (const m of h.messages) {
        const parts = m.role === "assistant" ? m.text.split("\n") : [m.text];
        parts.forEach((p, i) => addMsg(m.role, p, i === 0 ? m.ts : m.ts + 1));
      }
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "empty", "连不上服务：" + e.message));
    }
  }

  // 像 QQ 一样：连着发的几句会等一小会儿再一起回
  let pending = [];
  let flushTimer = null;
  let busy = false;
  function queue(text) {
    const empty = box.querySelector(".empty");
    if (empty) empty.remove();
    addMsg("user", text, Date.now());
    pending.push(text);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1400);
  }
  async function flush() {
    if (busy || !pending.length) return;
    busy = true;
    const texts = pending.splice(0);
    typing(true);
    try {
      const r = await api("POST", "/api/chat", { texts });
      await sleep(Math.min(r.firstDelayMs || 0, 4000));
      const parts = r.parts && r.parts.length ? r.parts : r.bubbles.map((text) => ({ type: "text", text }));
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          typing(true);
          await sleep(Math.min(r.delays[i] || 0, 3000));
        }
        typing(false);
        if (parts[i].type === "sticker") addSticker("assistant", parts[i].url, parts[i].keyword);
        else addMsg("assistant", parts[i].text, Date.now());
      }
      if (r.search && r.search.results && r.search.results.length) {
        const src = el("div", "sources");
        src.append("查了：");
        r.search.results.slice(0, 3).forEach((x) => {
          const a = document.createElement("a");
          a.href = x.url;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = x.site || x.title;
          src.appendChild(a);
        });
        box.appendChild(src);
      }
      $("#friendSub").textContent = r.engine === "llm" ? "在线 · " + r.mood : "简单模式（没接大模型）";
    } catch (e) {
      typing(false);
      addMsg("assistant", "（发送失败：" + e.message + "）", Date.now());
    } finally {
      typing(false);
      busy = false;
      if (pending.length) flushTimer = setTimeout(flush, 600);
    }
  }

  const input = $("#input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = "";
    input.style.height = "auto";
    queue(t);
  });

  // ---------- 记忆 ----------
  function li(content, onDelete) {
    const item = el("li");
    const span = el("span");
    if (typeof content === "string") span.textContent = content;
    else span.appendChild(content);
    const x = el("button", "x", "×");
    x.type = "button";
    x.title = "删除";
    x.addEventListener("click", onDelete);
    item.append(span, x);
    return item;
  }
  async function memOp(body) {
    const r = await api("POST", "/api/memory", body);
    renderMemory(r.profile);
  }
  function renderMemory(p) {
    const basics = $("#basics");
    basics.innerHTML = "";
    const entries = Object.entries(p.basics || {});
    if (!entries.length) basics.appendChild(el("li", "muted", "还没有"));
    for (const [k, v] of entries) {
      const f = document.createDocumentFragment();
      f.append(el("b", "", k), document.createTextNode(v.value));
      basics.appendChild(li(f, () => memOp({ op: "removeBasic", key: k })));
    }
    const facts = $("#facts");
    facts.innerHTML = "";
    if (!p.facts.length) facts.appendChild(el("li", "muted", "还没有"));
    for (const f of p.facts.slice().reverse()) facts.appendChild(li(f.text, () => memOp({ op: "removeFact", text: f.text })));
    $("#factCount").textContent = p.facts.length ? p.facts.length + " 条" : "";
    const events = $("#events");
    events.innerHTML = "";
    const evs = (p.events || []).slice().sort((a, b) => String(a.date || "9").localeCompare(String(b.date || "9")));
    if (!evs.length) events.appendChild(el("li", "muted", "还没有"));
    for (const e of evs) {
      const f = document.createDocumentFragment();
      f.append(el("b", "", e.date ? e.date.slice(5).replace("-", "月") + "日" : "日期未定"), document.createTextNode(e.text));
      if (e.done) f.append(el("span", "tag", "已聊过"));
      events.appendChild(li(f, () => memOp({ op: "removeEvent", id: e.id })));
    }
    $("#summary").value = p.summary || "";
    $("#summaryInfo").textContent = p.summarizedUpTo ? "已压缩前 " + p.summarizedUpTo + " 条" : "";
  }
  async function loadMemory() {
    try {
      const r = await api("GET", "/api/memory");
      renderMemory(r.profile);
      const h = await api("GET", "/api/history?limit=1");
      $("#historyInfo").textContent = "共 " + h.total + " 条";
      loadStickers();
      loadCompress();
    } catch (e) {
      alert(e.message);
    }
  }

  async function loadStickers() {
    const grid = $("#stickerGrid");
    try {
      const r = await api("GET", "/api/stickers");
      $("#stickerCount").textContent = r.count + " 张";
      grid.innerHTML = "";
      if (!r.items.length) {
        grid.appendChild(el("p", "muted", "还没有。你在 QQ 上发给它的表情包、旧版收藏的群表情包，会自动收进来。"));
        return;
      }
      for (const s of r.items) {
        const cell = el("figure", "st");
        const img = document.createElement("img");
        img.src = s.url;
        img.loading = "lazy";
        img.alt = s.desc;
        img.title = s.desc + "（" + s.mood + "，用过 " + s.uses + " 次）";
        const x = el("button", "x", "×");
        x.type = "button";
        x.title = "不要这张";
        x.addEventListener("click", async () => {
          await api("POST", "/api/stickers/remove", { id: s.id });
          cell.remove();
        });
        cell.append(img, el("figcaption", "", s.mood), x);
        grid.appendChild(cell);
      }
    } catch (e) {
      grid.textContent = "读取失败：" + e.message;
    }
  }
  $("#basicForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const key = $("#basicKey").value.trim();
    const value = $("#basicVal").value.trim();
    if (!key || !value) return;
    memOp({ op: "setBasic", key, value }).then(() => {
      $("#basicKey").value = "";
      $("#basicVal").value = "";
    });
  });
  $("#factForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#factText").value.trim();
    if (!text) return;
    memOp({ op: "addFact", text }).then(() => ($("#factText").value = ""));
  });
  $("#eventForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#eventText").value.trim();
    if (!text) return;
    memOp({ op: "addEvent", text, date: $("#eventDate").value }).then(() => ($("#eventText").value = ""));
  });
  $("#summarySave").addEventListener("click", () => memOp({ op: "setSummary", text: $("#summary").value }));
  $("#organizeBtn").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "整理中…";
    try {
      await memOp({ op: "organize" });
      b.textContent = "整理好了";
    } catch (err) {
      b.textContent = "失败：" + err.message;
    }
    setTimeout(() => {
      b.disabled = false;
      b.textContent = "现在整理一次记忆";
    }, 2500);
  });
  // ---------- 压缩聊天记录 ----------
  function kb(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  }
  function renderCompress(r) {
    const s = r.stats || {};
    const box = $("#compressStats");
    box.innerHTML = "";
    const cell = (v, label) => {
      const d = el("div");
      d.append(el("b", "", v), el("span", "", label));
      box.appendChild(d);
    };
    cell((s.contextChars || 0) + " 字", "每轮发给模型的内容");
    cell((s.messages || 0) + " 条", "聊天原文（" + (s.unsummarized || 0) + " 条还没压缩）");
    cell(kb(s.fileBytes || 0), "聊天记录文件");
    cell((s.basics || 0) + (s.facts || 0) + " 项", "长期记忆");
    $("#restoreBtn").hidden = !s.archives || r.running;
    if (s.archives) $("#restoreBtn").textContent = "恢复归档的原文（" + s.archives + " 个，" + kb(s.archiveBytes) + "）";
    const btn = $("#compressBtn");
    const msg = $("#compressMsg");
    if (r.running) {
      btn.disabled = true;
      btn.textContent = "压缩中…";
      msg.textContent = "正在" + (r.progress || "压缩") + "……可以先去聊天，好了这里会显示结果";
    } else {
      btn.disabled = false;
      btn.textContent = "压缩";
      if (r.error) msg.textContent = "上次压缩没成功：" + r.error + "（聊天记录没有被改动）";
      else if (r.resultText) msg.textContent = "压缩好了 ✓\n" + r.resultText;
      else msg.textContent = s.unsummarized > 30 ? "现在有 " + s.unsummarized + " 条原文没压缩，压一下能省不少。" : "";
    }
  }
  let compressTimer = null;
  async function loadCompress() {
    clearTimeout(compressTimer);
    try {
      const r = await api("GET", "/api/compress");
      renderCompress(r);
      if (r.running) compressTimer = setTimeout(loadCompress, 1500);
      else if (r.finishedAt && Date.now() - r.finishedAt < 5000) {
        const m = await api("GET", "/api/memory");
        renderMemory(m.profile);
      }
    } catch (e) {
      $("#compressMsg").textContent = "读取失败：" + e.message;
    }
  }
  $("#compressBtn").addEventListener("click", async () => {
    const archive = $("#cmpArchive").checked;
    const ok = confirm(
      "开始压缩聊天记录？\n\n· 先把聊过的内容整理进长期记忆，再把旧原文压成摘要\n· 最近 " +
        ($("#cmpKeep").value || 10) + " 条原文保留不动\n" +
        (archive ? "· 旧原文会打包归档（可以随时恢复）\n" : "") +
        "· 记忆档案会先自动备份\n\n要用大模型跑一会儿，大概几十秒到一两分钟。"
    );
    if (!ok) return;
    try {
      const r = await api("POST", "/api/compress", { tidy: $("#cmpTidy").checked, archive, keepRecent: Number($("#cmpKeep").value) || 10 });
      renderCompress(r);
      compressTimer = setTimeout(loadCompress, 1000);
    } catch (e) {
      $("#compressMsg").textContent = e.message;
    }
  });
  $("#restoreBtn").addEventListener("click", async () => {
    if (!confirm("把归档的旧原文放回聊天记录吗？（摘要和记忆不变）")) return;
    try {
      const r = await api("POST", "/api/compress/restore");
      renderCompress(r);
      $("#compressMsg").textContent = "已经恢复了 " + r.restored + " 个归档";
      const h = await api("GET", "/api/history?limit=1");
      $("#historyInfo").textContent = "共 " + h.total + " 条";
    } catch (e) {
      $("#compressMsg").textContent = e.message;
    }
  });

  $("#clearBtn").addEventListener("click", async () => {
    if (!confirm("确定清空聊天记录吗？（会改名备份，不会真的删除）")) return;
    await api("DELETE", "/api/history");
    loadHistory();
    loadMemory();
  });

  // ---------- 设置 ----------
  const form = $("#settingsForm");
  function get(obj, path) {
    return path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
  }
  function fillSettings() {
    const sel = $("#styleSelect");
    sel.innerHTML = "";
    const groups = {};
    for (const s of STYLES) {
      const g = s.group || "其他";
      if (!groups[g]) {
        groups[g] = document.createElement("optgroup");
        groups[g].label = g;
        sel.appendChild(groups[g]);
      }
      const o = el("option", "", s.label + "（" + s.defaultName + "）");
      o.value = s.id;
      groups[g].appendChild(o);
    }
    for (const f of form.elements) {
      if (!f.name) continue;
      const v = get(CFG, f.name);
      if (f.type === "checkbox") f.checked = Boolean(v);
      else if (Array.isArray(v)) f.value = v.join(", ");
      else if (v !== undefined) f.value = v;
    }
    $("#tokenInput").value = "";
    $("#tokenInput").placeholder = CFG.qq.hasToken ? "已填写（留空表示不改）" : "可以不填";
    $("#webhookInput").value = "";
    if (CFG.notify.hasWebhook) $("#webhookInput").placeholder = "已填写（留空表示不改）";
    showStyle();
  }
  function showStyle() {
    const s = STYLES.find((x) => x.id === $("#styleSelect").value);
    $("#styleDesc").textContent = s ? s.persona : "";
  }
  $("#styleSelect").addEventListener("change", showStyle);

  function collect() {
    const out = {};
    for (const f of form.elements) {
      if (!f.name) continue;
      const [sec, key] = f.name.split(".");
      out[sec] = out[sec] || {};
      let v;
      if (f.type === "checkbox") v = f.checked;
      else if (f.type === "number" || f.type === "range") v = Number(f.value);
      else v = f.value.trim();
      if (["owner.qq", "qq.groupAllowList"].includes(f.name)) v = v.split(/[\s,，;；]+/).filter(Boolean);
      out[sec][key] = v;
    }
    return out;
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#saveMsg");
    msg.textContent = "保存中…";
    try {
      const r = await api("POST", "/api/config", collect());
      CFG = r.config;
      fillSettings();
      applyHeader();
      msg.textContent = "已保存，立即生效";
    } catch (err) {
      msg.textContent = "保存失败：" + err.message;
    }
  });
  // ---------- 模型 ----------
  let PRESETS = [];
  let editing = null; // 正在编辑的模型 id；null 表示新增

  function presetOf(id) {
    return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === "custom") || {};
  }
  function providerOptions(sel, value, emptyLabel) {
    sel.innerHTML = "";
    if (emptyLabel) {
      const o = el("option", "", emptyLabel);
      o.value = "";
      sel.appendChild(o);
    }
    for (const p of CFG.providers) {
      const o = el("option", "", p.name + (p.hasKey || p.preset === "ollama" ? "" : "（没填 Key）"));
      o.value = p.id;
      sel.appendChild(o);
    }
    sel.value = value || "";
  }
  function renderModels() {
    const ul = $("#modelList");
    ul.innerHTML = "";
    $("#modelCount").textContent = CFG.providers.length ? CFG.providers.length + " 个" : "";
    if (!CFG.providers.length) ul.appendChild(el("li", "muted", "还没有，点下面「添加模型」"));
    for (const p of CFG.providers) {
      const li = el("li", p.id === CFG.llm.active ? "active" : "");
      const info = el("div", "info");
      info.append(el("b", "", p.name), el("span", "muted", " " + presetOf(p.preset).name + " · " + (p.model || "未填模型") + (p.hasKey || p.preset === "ollama" ? "" : " · 没填 Key")));
      if (p.id === CFG.llm.active) info.append(el("span", "badge", "聊天中"));
      const btns = el("div", "btns");
      const mk = (label, fn, cls) => {
        const b = el("button", cls || "ghost small", label);
        b.type = "button";
        b.addEventListener("click", fn);
        btns.appendChild(b);
      };
      if (p.id !== CFG.llm.active) mk("用它聊天", () => setActive(p.id), "small");
      mk("测试", async (e) => {
        const b = e.currentTarget;
        b.textContent = "测试中…";
        const r = await api("POST", "/api/models/test", { id: p.id }).catch((err) => ({ ok: false, error: err.message }));
        b.textContent = r.ok ? "✓ " + (r.ms / 1000).toFixed(1) + "s" : "✗";
        b.title = r.ok ? r.sample : r.error;
        if (!r.ok) alert(p.name + " 测试失败：" + r.error);
      });
      mk("编辑", () => openEditor(p));
      mk("删除", async () => {
        if (!confirm("删除「" + p.name + "」？")) return;
        await saveProviders(CFG.providers.filter((x) => x.id !== p.id));
      });
      li.append(info, btns);
      ul.appendChild(li);
    }
    providerOptions($("#roleActive"), CFG.llm.active);
    providerOptions($("#roleFallback"), CFG.llm.fallback, "不换");
    providerOptions($("#roleMemory"), CFG.llm.memoryProvider, "跟聊天用同一个");
    providerOptions($("#roleVision"), CFG.llm.visionProvider, "跟聊天用同一个");
    $("#roleVisionModel").value = CFG.llm.visionModel || "";
    $("#roleTemp").value = CFG.llm.temperature;
    $("#tempVal").textContent = CFG.llm.temperature;
    $("#roleMaxTokens").value = CFG.llm.maxTokens;
    renderQuickModel();
  }
  function renderQuickModel() {
    const sel = $("#quickModel");
    sel.innerHTML = "";
    for (const p of CFG.providers) {
      const o = el("option", "", p.name);
      o.value = p.id;
      sel.appendChild(o);
    }
    sel.value = CFG.llm.active;
    $(".modelbar").hidden = CFG.providers.length < 2;
  }
  async function setActive(id) {
    const r = await api("POST", "/api/config", { llm: { active: id } });
    CFG = r.config;
    renderModels();
    applyHeader();
    const p = CFG.providers.find((x) => x.id === id);
    $("#quickModelMsg").textContent = p ? "已换成 " + p.name : "";
    setTimeout(() => ($("#quickModelMsg").textContent = ""), 3000);
  }
  $("#quickModel").addEventListener("change", (e) => setActive(e.target.value));

  async function saveProviders(list, llmPatch) {
    const body = { providers: list.map((p) => ({ ...p, apiKey: p.apiKey || "" })) };
    if (llmPatch) body.llm = llmPatch;
    const r = await api("POST", "/api/config", body);
    CFG = r.config;
    renderModels();
    applyHeader();
  }

  function fillPresetSelect() {
    const sel = $("#mPreset");
    sel.innerHTML = "";
    for (const p of PRESETS) {
      const o = el("option", "", p.name);
      o.value = p.id;
      sel.appendChild(o);
    }
  }
  function showPreset(changed) {
    const p = presetOf($("#mPreset").value);
    $("#mPresetNote").textContent = p.note || "";
    const link = $("#mKeyLink");
    link.hidden = !p.keyUrl;
    link.href = p.keyUrl || "#";
    if (changed) {
      $("#mBaseUrl").value = p.baseUrl || "";
      $("#mModel").value = (p.models && p.models[0]) || "";
    }
    const dl = $("#mModelList");
    dl.innerHTML = "";
    (p.models || []).forEach((m) => {
      const o = document.createElement("option");
      o.value = m;
      dl.appendChild(o);
    });
    $("#mKey").placeholder = p.noKey ? "不需要" : editing && (CFG.providers.find((x) => x.id === editing) || {}).hasKey ? "已填写（留空表示不改）" : "粘贴 API Key";
  }
  $("#mPreset").addEventListener("change", () => showPreset(true));
  function openEditor(p) {
    editing = p ? p.id : null;
    $("#editorTitle").textContent = p ? "编辑「" + p.name + "」" : "添加模型";
    $("#mPreset").value = p ? p.preset : "moonshot";
    showPreset(!p);
    if (p) {
      $("#mBaseUrl").value = p.baseUrl;
      $("#mModel").value = p.model;
      $("#mName").value = p.name;
    } else {
      $("#mName").value = "";
    }
    $("#mKey").value = "";
    $("#mFetchMsg").textContent = "";
    $("#mTestMsg").textContent = "";
    $("#modelEditor").hidden = false;
    $("#modelEditor").scrollIntoView({ behavior: "smooth" });
  }
  function draft() {
    return { preset: $("#mPreset").value, baseUrl: $("#mBaseUrl").value.trim(), apiKey: $("#mKey").value.trim(), model: $("#mModel").value.trim(), name: $("#mName").value.trim() };
  }
  $("#addModelBtn").addEventListener("click", () => openEditor(null));
  $("#mCancel").addEventListener("click", () => ($("#modelEditor").hidden = true));
  $("#mFetch").addEventListener("click", async () => {
    const msg = $("#mFetchMsg");
    msg.textContent = "获取中…";
    const r = await api("POST", "/api/models/list", { id: editing, draft: draft() }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) {
      msg.textContent = "✗ " + r.error;
      return;
    }
    const dl = $("#mModelList");
    dl.innerHTML = "";
    r.models.forEach((m) => {
      const o = document.createElement("option");
      o.value = m;
      dl.appendChild(o);
    });
    msg.textContent = "✓ 找到 " + r.models.length + " 个模型，点「模型名」输入框就能选（可以输入几个字筛选）";
    $("#mModel").focus();
  });
  $("#mTest").addEventListener("click", async () => {
    const msg = $("#mTestMsg");
    msg.textContent = "测试中…";
    msg.className = "muted";
    const r = await api("POST", "/api/models/test", { id: editing, draft: draft() }).catch((e) => ({ ok: false, error: e.message }));
    msg.textContent = r.ok ? "✓ 能用（" + (r.ms / 1000).toFixed(1) + " 秒）：" + r.sample : "✗ " + r.error;
    msg.className = r.ok ? "ok" : "bad";
  });
  $("#mSave").addEventListener("click", async () => {
    const d = draft();
    if (!d.baseUrl || !d.model) {
      $("#mTestMsg").textContent = "接口地址和模型名都要填";
      return;
    }
    const list = CFG.providers.map((p) => ({ ...p }));
    if (editing) {
      const i = list.findIndex((p) => p.id === editing);
      list[i] = { ...list[i], ...d, name: d.name || "", apiKey: d.apiKey };
    } else {
      list.push({ id: d.preset + "-" + Date.now().toString(36).slice(-4), ...d });
    }
    const first = !CFG.providers.length;
    try {
      await saveProviders(list, first ? { active: list[0].id } : null);
      $("#modelEditor").hidden = true;
    } catch (e) {
      $("#mTestMsg").textContent = "保存失败：" + e.message;
    }
  });
  $("#roleTemp").addEventListener("input", (e) => ($("#tempVal").textContent = e.target.value));
  $("#roleVision").addEventListener("change", () => ($("#roleVisionModel").value = ""));
  $("#roleSave").addEventListener("click", async () => {
    const msg = $("#roleMsg");
    try {
      const r = await api("POST", "/api/config", {
        llm: {
          active: $("#roleActive").value,
          fallback: $("#roleFallback").value,
          memoryProvider: $("#roleMemory").value,
          visionProvider: $("#roleVision").value,
          visionModel: $("#roleVisionModel").value.trim(),
          temperature: Number($("#roleTemp").value),
          maxTokens: Number($("#roleMaxTokens").value),
        },
      });
      CFG = r.config;
      renderModels();
      applyHeader();
      msg.textContent = "已保存";
    } catch (e) {
      msg.textContent = "保存失败：" + e.message;
    }
  });

  // ---------- 状态 ----------
  async function loadStatus() {
    const dl = $("#statusList");
    try {
      const h = await api("GET", "/health");
      dl.innerHTML = "";
      const row = (k, v, cls) => {
        dl.appendChild(el("dt", "", k));
        dl.appendChild(el("dd", cls || "", v));
      };
      row("版本", "v" + h.version);
      row("聊天模型", h.llm.enabled ? h.llm.model + (h.llm.lastError ? "（最近一次出错：" + h.llm.lastError + "）" : "") : "还没有可用的模型", h.llm.enabled && !h.llm.lastError ? "ok" : "bad");
      if (h.llm.lastModel && h.llm.lastModel !== h.llm.model) row("上一句是谁回的", h.llm.lastModel + "（聊天模型出错时自动换了备用）");
      if (!h.qq.enabled) row("QQ", "未开启");
      else {
        const s = h.qq.online === true ? "在线" + (h.qq.nickname ? "：" + h.qq.nickname : "") : h.qq.online === false ? "离线 · " + h.qq.lastError : "检查中…";
        row("QQ", s, h.qq.online ? "ok" : "bad");
        row("主人 QQ", h.qq.owners ? "已设置 " + h.qq.owners + " 个" : "未设置", h.qq.owners ? "" : "bad");
        row("收到 / 回复", h.qq.received + " / " + h.qq.replied);
      }
      row("看图", h.vision.enabled ? "开（" + h.vision.model + "）" + (h.vision.lastError ? " · 最近出错：" + h.vision.lastError : "") : "关", h.vision.enabled ? "ok" : "");
      row("表情包库", h.stickers.enabled ? h.stickers.count + " 张" : "关");
      row("联网搜索", h.search.enabled ? "开" + (h.search.count ? "（查过 " + h.search.count + " 次）" : "") : "关");
      if (h.llm.promptTokens) row("缓存命中", Math.round((h.llm.cacheHitTokens / h.llm.promptTokens) * 100) + "%（越高越快越省钱）");
      row("当前心情", h.friend.mood);
      row("已运行", Math.round(h.uptimeSec / 60) + " 分钟");
      $("#onebotUrl").textContent = location.origin + "/onebot";
    } catch (e) {
      dl.textContent = "读取失败：" + e.message;
    }
  }
  $("#refreshStatus").addEventListener("click", loadStatus);
  $("#testQq").addEventListener("click", async () => {
    await api("POST", "/api/test-qq").catch(() => {});
    loadStatus();
  });

  // ---------- 启动 ----------
  function applyHeader() {
    $("#friendName").textContent = CFG.friend.name;
    $("#avatar").textContent = CFG.friend.name.slice(-1);
    document.title = CFG.friend.name + " · AI 好友";
    const banner = $("#banner");
    if (!CFG.llm.hasKey) {
      banner.hidden = false;
      banner.textContent = "还没接上大模型，现在只能简单回复。去「模型」页添加一个并填 API Key。";
    } else banner.hidden = true;
  }
  (async function init() {
    try {
      const r = await api("GET", "/api/config");
      CFG = r.config;
      STYLES = r.styles;
      PRESETS = r.presets || [];
      fillPresetSelect();
      applyHeader();
      fillSettings();
      renderModels();
      $("#friendSub").textContent = CFG.llm.hasKey ? "在线" : "简单模式（没接大模型）";
    } catch (e) {
      $("#friendSub").textContent = "连不上服务";
    }
    loadHistory();
  })();
})();
