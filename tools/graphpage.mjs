#!/usr/bin/env node
/**
 * graphpage.mjs — render the story graph as one page: a list on the left, a canvas on the
 * right, a category switcher in the top right, and a node that opens its own editor.
 *
 *   node tools/graphpage.mjs --out .preview/graph/graph.html [--mod your_mods/x]
 *
 * Positions are computed here, in Node, not in the browser: the canvas only reads them.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph } from "./graph.mjs";
import { esc, pageHtml } from "./html.mjs";
import { DEFAULT_VANILLA } from "./model.mjs";

const ROW_H = 26;
const EDGE_CAP = 40;
const COL_W = 268;
const VIEW_H = 880; // one screenful: the plan's "column height = one screen"
const PER_COL = Math.floor(VIEW_H / ROW_H);

/** Assign a column and a y for every node, per category, in a stable order. */
export function layout(g) {
  const order = ["unused", "reputation", "ending", "guide", "achievement", "daily", "periodic", "other"];
  const groups = new Map();
  for (const n of g.nodes) {
    const cat = n.cat || (n.t === "card" ? "card" : "other");
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(n);
  }
  // deterministic grouping key inside a category, so the layout never jitters
  const groupKey = (n) => {
    if (n.t === "event") return String(n.id).slice(0, 5);
    if (n.t === "rite") return String(Math.floor(Number(n.id) / 1000));
    return n.t;
  };
  for (const [, list] of groups) {
    list.sort((a, b) => (groupKey(a) < groupKey(b) ? -1 : groupKey(a) > groupKey(b) ? 1 : Number(a.id) - Number(b.id)));
  }
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  let col = 0;
  for (const cat of cats) {
    const list = groups.get(cat);
    let i = 0;
    let currentKey = null;
    let used = PER_COL; // force a new column at the start of a category
    for (const n of list) {
      const key = groupKey(n);
      if (key !== currentKey || used >= PER_COL) {
        if (used >= PER_COL) {
          col += key === currentKey ? 0 : 1;
          used = 0;
        }
        currentKey = key;
      }
      n.col = col;
      n.y = used * ROW_H;
      used++;
    }
    col += 1; // a category always starts a fresh column
  }
  return g;
}

/** The payload the page needs: nodes and edges only, with labels in all four languages. */
export function payload(g) {
  const index = new Map(g.nodes.map((n, i) => [n.k, i]));
  return {
    builtAt: g.builtAt,
    nodes: g.nodes.map((n) => ({
      k: n.k,
      t: n.t,
      id: n.id,
      c: n.cat || "other",
      o: n.o,
      l: n.l,
      x: (n.col || 0) * COL_W,
      y: n.y || 0,
      ch: Boolean(n.chain),
      cs: n.compSize || 0,
      tr: n.tr || { en: false, ja: false, zhTW: false },
      nr: n.nr || null,
      nt: n.note || "",
      dl: n.dl || null,
      on: n.on || null,
      cond: n.cond || null,
      oc: n.oc || null,
      b: (() => {
        const levels = (n.badges || []).map((x) => x.level);
        return levels.includes("FAIL") ? "FAIL" : levels.includes("WARN") ? "WARN" : levels.includes("INFO") ? "INFO" : null;
      })(),
      bm: (n.badges || []).map((x) => x.code),
      d: 0,
    })),
    edges: g.edges.filter((e) => index.has(e.f) && index.has(e.t)).map((e) => [index.get(e.f), index.get(e.t), e.r]),
    counts: g.counts,
    categoryCounts: g.categoryCounts,
    components: { count: g.components.count, largest: g.components.largest },
  };
}



const SCRIPT = (payloadJson) => `
const DATA = ${payloadJson};
const ROW_H = ${ROW_H}, COL_W = ${COL_W}, EDGE_CAP = ${EDGE_CAP};
const cv = document.getElementById("cv"), ctx = cv.getContext("2d");
const listEl = document.getElementById("list"), qEl = document.getElementById("q");
const wrap = document.getElementById("cwrap"), spacer = document.getElementById("spacer");
let lang = "zh", cat = null, chainOnly = false, zoom = 1, selected = null, showEdges = false;
let nodes = [], cols = 0, per = 30;

const CAT_COLOR = {
  unused: "#6b6257", reputation: "#b07a4a", ending: "#c96f5a", guide: "#7f9e8a",
  achievement: "#8d84b8", daily: "#7d8fa8", periodic: "#6f7f96", other: "#8a7a60",
  card: "#b9a887",
};
const CAT_NAME = { unused: "废弃", reputation: "声望", ending: "结局", guide: "引导", achievement: "成就", daily: "日常", periodic: "周期", other: "其他", card: "卡牌" };
const KIND_NAME = { event: "事件", rite: "仪式", card: "卡牌", loot: "掉落表", over: "结局", quest: "任务", afterStory: "后日谈", riteTemplate: "棋盘布局" };
// A rule id is for the builder, not for the reader. These are the same relations in game words.
const REL_OUT = {
  "action.rite": "开启仪式", "action.event": "激活事件", "action.loot": "抽掉落表", "action.over": "进入结局",
  "condition.card": "条件涉及卡", "condition.rite": "条件涉及仪式", "rite.template": "棋盘布局", "loot.item": "掉落",
  "trigger.rite_end": "仪式结束时触发", "trigger.rite_start": "仪式开始时触发",
  "trigger.rite_cancel": "仪式取消时触发", "trigger.open_rite_end": "仪式界面关闭时触发",
  "trigger.card_clean": "卡被清理时触发", "trigger.card_born": "卡生成时触发",
  "trigger.card_dead": "卡死亡时触发", "trigger.game_end": "游戏结束时触发",
};
const REL_IN = {
  "action.rite": "由它开启", "action.event": "由它激活", "action.loot": "由它掉落", "action.over": "由它结束",
  "condition.card": "条件里提到", "condition.rite": "条件里提到", "rite.template": "布局来自", "loot.item": "由它掉落",
};

// Turn an event's on object into one line a player can read.
function timingText(on) {
  const one = (k, v) => {
    const anyId = v === 1 || (Array.isArray(v) && v.length === 1 && v[0] === 1);
    const ids = Array.isArray(v) ? v.join(", ") : String(v);
    if (k === "round_begin_ba" || k === "round_begin_fr" || k === "round_end") {
      const when = k === "round_begin_ba" ? "回合开始结算后" : k === "round_begin_fr" ? "回合开始结算前" : "回合结束时";
      if (Array.isArray(v) && v.length === 2) return when + "，每 " + v[0] + " 到 " + v[1] + " 回合";
      return when + "，每 " + v + " 回合";
    }
    if (k === "rite_end" || k === "rite_start" || k === "rite_cancel" || k === "open_rite_end") {
      const what = k === "rite_end" ? "结束时" : k === "rite_start" ? "开始时" : k === "rite_cancel" ? "被取消时" : "界面关闭时";
      return anyId ? "任意仪式" + what : "仪式 " + ids + " " + what;
    }
    if (k === "card_clean" || k === "card_born" || k === "card_dead") {
      const what = k === "card_clean" ? "被清理时" : k === "card_born" ? "生成时" : "死亡时";
      return anyId ? "任意卡" + what : "卡 " + ids + " " + what;
    }
    if (k === "counter" || k === "global_counter") return "计数器 " + ids + " 变化时";
    if (k === "game_end") return "游戏结束时（原因 " + ids + "）";
    return k + " " + ids;
  };
  return Object.entries(on || {}).map(([k, v]) => one(k, v)).join("；");
}


function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------- layout
// One column is one screenful. The page keeps a real scrollbar by sizing a spacer to the
// whole content and drawing only the visible slice onto a viewport-sized canvas: a 53 000 px
// wide canvas was the reason the first version crawled.
function visible() {
  return DATA.nodes.filter((n) => (!cat || n.c === cat) && (!chainOnly || n.ch));
}

function relayout() {
  nodes = visible();
  per = Math.max(6, Math.floor(wrap.clientHeight / ROW_H));
  nodes.forEach((n, i) => {
    n.vx = Math.floor(i / per) * COL_W;
    n.vy = (i % per) * ROW_H;
  });
  cols = Math.ceil(nodes.length / per) || 1;
  spacer.style.width = Math.round(cols * COL_W * zoom) + "px";
  spacer.style.height = Math.round(Math.max(per * ROW_H, 320) * zoom) + "px";
  draw();
}

const byKey = new Map(DATA.nodes.map((n) => [n.k, n]));
const OUT = new Map(), IN = new Map();
DATA.edges.forEach(([a, b, r]) => {
  const ka = DATA.nodes[a].k, kb = DATA.nodes[b].k;
  if (!OUT.has(ka)) OUT.set(ka, []);
  if (!IN.has(kb)) IN.set(kb, []);
  OUT.get(ka).push([kb, r]);
  IN.get(kb).push([ka, r]);
});

let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; draw(); });
}

function draw() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const sx = wrap.scrollLeft, sy = wrap.scrollTop;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(zoom, 0, 0, zoom, -sx, -sy);
  ctx.font = (zoom < 0.7 ? "11px" : "12px") + " ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";

  // The visible slice is a contiguous run: node i sits in column floor(i/per). Slicing beats
  // filtering 6601 nodes on every scroll frame.
  const firstCol = Math.max(0, Math.floor(sx / zoom / COL_W) - 1);
  const lastCol = Math.floor((sx + w) / zoom / COL_W) + 1;
  const from = Math.min(nodes.length, firstCol * per);
  const to = Math.min(nodes.length, (lastCol + 1) * per);
  const shown = nodes.slice(from, to);

  // Edges: the selected node's own lines, or every line when the reader asks for them.
  // Only both-ends-on-screen edges are drawn, and a hub is capped: 俺寻思 has 59 references
  // and drawing all of them turns the page into a cat's cradle.
  if (showEdges || selected) {
    const visible = new Set(shown);
    const curve = (from, to, colour) => {
      const ax = from.vx + COL_W - 24, ay = from.vy + ROW_H / 2;
      const bx = to.vx, by = to.vy + ROW_H / 2;
      const mid = (ax + bx) / 2;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.bezierCurveTo(mid, ay, mid, by, bx, by);
      ctx.stroke();
    };
    ctx.lineWidth = 1 / zoom;
    if (selected) {
      const self = byKey.get(selected);
      let n = 0;
      if (self && visible.has(self)) {
        for (const [to] of OUT.get(selected) || []) {
          const b = byKey.get(to);
          if (!b || !visible.has(b) || n >= EDGE_CAP) continue;
          curve(self, b, "rgba(201,162,39,0.5)"); n++;
        }
        for (const [from] of IN.get(selected) || []) {
          const a = byKey.get(from);
          if (!a || !visible.has(a) || n >= EDGE_CAP) continue;
          curve(a, self, "rgba(151,196,255,0.5)"); n++;
        }
      }
    } else if (showEdges) {
      for (const [from, list] of OUT) {
        const a = byKey.get(from);
        if (!a || !visible.has(a)) continue;
        for (const [to] of list) {
          const b = byKey.get(to);
          if (!b || !visible.has(b)) continue;
          curve(a, b, "rgba(201,162,39,0.18)");
        }
      }
    }
  }

  // column headers: the category every column belongs to
  let lastCat = null;
  for (const n of shown) {
    if (n.vx !== lastColOfCat(n) && n.vy > 0) continue;
    void n;
  }
  for (const n of shown) {
    if (n.vy !== 0) continue;
    ctx.fillStyle = "#8a7a60";
    ctx.fillText((CAT_NAME[n.c] || n.c) + " · " + n.id, n.vx, n.vy - 12);
  }

  const maxW = COL_W - 46;
  for (const n of shown) {
    const hot = selected === n.k;
    if (hot) {
      ctx.fillStyle = "rgba(201,162,39,0.16)";
      ctx.fillRect(n.vx, n.vy + 1, COL_W - 10, ROW_H - 2);
    }
    ctx.fillStyle = hot ? "#c9a227" : CAT_COLOR[n.c] || "#8a7a60";
    ctx.fillRect(n.vx, n.vy + 6, 3, ROW_H - 12);
    ctx.fillStyle = hot ? "#fff4d0" : n.o === "mod" ? "#ffd9a0" : "#d7c9ab";
    // Trim to the column, by measured width: a fixed character count still overflows
    // because a Chinese glyph is twice as wide as a digit.
    const text = dispLabel(n);
    let label = n.id + "  " + text;
    while (label.length > 4 && ctx.measureText(label).width > maxW) label = label.slice(0, -2);
    if (label !== n.id + "  " + text) label += "…";
    ctx.fillText(label, n.vx + 10, n.vy + ROW_H / 2);
    if (n.o === "mod") { ctx.fillStyle = "#c9a227"; ctx.fillText("mod", n.vx + 214, n.vy + ROW_H / 2); }
    if (n.b) {
      ctx.fillStyle = n.b === "FAIL" ? "#b4543f" : n.b === "WARN" ? "#c9a227" : "#7f9e8a";
      ctx.beginPath();
      ctx.arc(n.vx + 250, n.vy + ROW_H / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function lastColOfCat() { return -1; }

// What a node is called on the canvas, in the list and in a link. An event's designer note is
// the name the panel prints, so the same string is used here: a row must read like the page it
// opens. Every other kind has a real name, already in the language on screen.
function dispLabel(n) {
  if (n.t === "event" && n.nt) return n.nt;
  return n.l[lang] || n.l.zh || "";
}

// ---------------------------------------------------------------- list
function listRows() {
  const q = qEl.value.trim().toLowerCase();
  const rows = visible().filter((n) => {
    if (!q) return true;
    // The note is searched too: it is what the row shows, and it is Chinese only, so it would
    // otherwise vanish from search whenever another language is on screen.
    return ["zh", "en", "ja", "zhTW"].some((l) => (n.l[l] || "").toLowerCase().includes(q)) ||
      (n.nt || "").toLowerCase().includes(q) || n.id.includes(q);
  });
  listEl.innerHTML = rows.slice(0, 500).map((n) =>
    '<div class="row' + (selected === n.k ? " sel" : "") + '" data-k="' + n.k + '">' +
    '<span class="id">' + n.id + "</span>" +
    '<span class="nm">' + (n.b ? '<span class="badge ' + n.b + '">' + n.b + "</span> " : "") +
    escHtml(dispLabel(n).slice(0, 40)) +
    (n.t !== "event" && lang !== "zh" && n.tr && !n.tr[lang] ? ' <span class="toless">无' + lang + "</span>" : "") + "</span></div>"
  ).join("") || '<div class="note">没有匹配</div>';
  listEl.querySelectorAll(".row").forEach((el) => { el.onclick = () => focusNode(el.dataset.k); });
  document.getElementById("count").textContent = rows.length + " / " + DATA.nodes.length;
}

function focusNode(key) {
  selected = key;
  const n = byKey.get(key);
  if (n && nodes.includes(n)) {
    wrap.scrollTo({
      left: Math.max(0, n.vx * zoom - wrap.clientWidth / 2),
      top: Math.max(0, n.vy * zoom - wrap.clientHeight / 2),
      behavior: "smooth",
    });
  }
  window.__openNode(key);
  listRows();
  schedule();
}

function cats() {
  const box = document.getElementById("cats");
  const all = [["", "全部"]].concat(Object.keys(DATA.categoryCounts).map((c) => [c, CAT_NAME[c] || c]));
  box.innerHTML = all.map(([v, label]) =>
    '<button class="pill' + (v === cat ? " on" : "") + '" data-c="' + v + '">' + label +
    " <b>" + (v ? (DATA.categoryCounts[v] || 0) : DATA.nodes.length) + "</b></button>"
  ).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { cat = b.dataset.c || null; cats(); listRows(); relayout(); };
  });
}

// ---------------------------------------------------------------- node panel
function chip(key) {
  const n = byKey.get(key);
  if (!n) return escHtml(key);
  return '<a href="#" data-go="' + key + '">' + n.id + " " + escHtml(dispLabel(n).slice(0, 26)) + "</a>";
}

// What the node says, in the language on screen, and nothing else: the other languages are a
// click away in the switcher, and a four-row table buries the one the reader picked.
// An event's description is narration, delivered in lines; every other kind has one paragraph.
function descBlock(n) {
  const pick = (rec) => {
    if (!rec) return { rec: null, fellBack: false };
    const cur = rec[lang];
    return { rec: cur || rec.zh || null, fellBack: !cur && lang !== "zh" };
  };
  let body = "";
  let fellBack = false;
  if (n.t === "event") {
    const got = pick(n.nr);
    const rec = got.rec;
    fellBack = got.fellBack;
    if (!rec) return "";
    if ((rec.opt || []).length) {
      body += '<div class="note">开场</div>';
      for (const o of rec.opt) {
        body += '<div class="story">' + escHtml(o.text || "（无）") + "</div>";
        if (o.items.length) {
          body += '<div class="note">选项 ' + escHtml(o.n) + "：" + o.items.map((it) => escHtml(it.text)).join(" / ") + "</div>";
        }
      }
    }
    if ((rec.prompt || []).length) {
      body += '<div class="note">结算之后</div>';
      for (const p of rec.prompt) body += '<div class="story">' + escHtml(p.text) + "</div>";
    }
    if (!body) return "";
  } else {
    const got = pick(n.dl);
    fellBack = got.fellBack;
    if (!got.rec) return "";
    body = '<div class="story">' + escHtml(got.rec) + "</div>";
  }
  return '<h3>描述</h3>' + (fellBack ? '<div class="note">无' + escHtml(lang) + "，回退简中</div>" : "") + body;
}

// Conditions use game keys such as have.2000080.激情 or counter.7000025<. Read them
// as sentences, and keep the nesting: any means one of them, all means every one.
function condLeaf(k, v) {
  var neg = false;
  if (k.charAt(0) === "!") { neg = true; k = k.slice(1); }
  var op = "";
  var m = k.match(/^(.*?)(<=|>=|<|>|==|=)$/);
  if (m) { k = m[1]; op = m[2]; }
  var p = k.split(/[:.]/);
  var head = p[0], rest = p.slice(1);
  var what;
  if (head === "rite") what = "仪式 " + rest.join(" ");
  else if (head === "event") what = "事件 " + rest.join(" ");
  else if (head === "card") what = "卡 " + rest.join(" ");
  else if (head === "have") what = "拥有 " + (rest.length > 1 ? rest[1] : rest[0] || "") + (rest.length > 1 ? "（卡 " + rest[0] + "）" : "");
  else if (head === "table_have") what = "桌上放着 " + rest.join(" ");
  else if (head === "hand_have") what = "手上拿着 " + rest.join(" ");
  else if (head === "rite_have") what = "有仪式 " + rest.join(" ");
  else if (head === "sudan_pool_have") what = "苏丹池里有 " + rest.join(" ");
  else if (head === "counter") what = "计数器 " + rest.join(" ");
  else if (head === "global_counter") what = "全局计数器 " + rest.join(" ");
  else if (head === "round") what = "回合数";
  else if (head === "difficulty") what = "难度";
  else if (head === "type") what = "局类型";
  else what = k;
  var val = v && typeof v === "object" ? JSON.stringify(v) : String(v);
  what = what.replace(/\s+$/, "");
  if (neg) return "没有" + what + (rest.length ? "" : " " + val);
  var ops = { "<": " 小于 ", "<=": " 不大于 ", ">": " 大于 ", ">=": " 不小于 ", "=": " 等于 ", "==": " 等于 " };
  if (op) return what + ops[op] + val;
  if (head === "have" || head === "table_have" || head === "hand_have" || head === "rite_have") {
    return what + "，数量 " + val;
  }
  return what + "：" + val;
}

function condTree(obj, depth) {
  var out = [];
  if (!obj || typeof obj !== "object") return out;
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (k === "any" || k === "all") {
      out.push({ t: k === "any" ? "满足任一项" : "全部满足", d: depth });
      out = out.concat(condTree(v, depth + 1));
    } else if (v && typeof v === "object") {
      out.push({ t: condLeaf(k, "") + " " + JSON.stringify(v), d: depth });
    } else {
      out.push({ t: condLeaf(k, v), d: depth });
    }
  });
  return out;
}

function condHtml(obj) {
  return condTree(obj, 0).map(function (x) {
    return '<div class="cond" style="padding-left:' + x.d * 14 + 'px">' + escHtml(x.t) + "</div>";
  }).join("");
}

window.__openNode = (key) => {
  const n = byKey.get(key);
  if (!n) return;
  const out = (OUT.get(key) || []).slice(0, 30);
  const inc = (IN.get(key) || []).slice(0, 30);
  const box = document.getElementById("modal-body");
  const nb = descBlock(n);
  // The node's own name, in the language on screen. An event has no name in any table, so
  // its designer note is the name; what the panel then shows under it is the narration.
  const title = dispLabel(n);
  const sec = (title, body) => "<h3>" + escHtml(title) + "</h3>" + body;
  const hint = (text) => '<div class="cond muted">' + text + "</div>";
  const row = (k, r, dir) => {
    const label = (dir === "in" ? REL_IN[r] || REL_OUT[r] : REL_OUT[r]) || r;
    return '<div class="relrow"><div class="reltag">' + escHtml(label) + '</div><div class="relval">' + chip(k) + "</div></div>";
  };
  const conds = n.cond ? condHtml(n.cond) : "";
  const openTips = (n.oc || []).map((t) => '<div class="cond">' + escHtml(t) + "</div>").join("");
  // One line per node. A rite that both fires an event and opens it should not
  // print the same target twice; the trigger says more than the action.
  const rank = (r) => (r.indexOf("trigger.") === 0 ? 0 : r.indexOf("action.") === 0 ? 1 : r.indexOf("condition.") === 0 ? 2 : 3);
  const dedupe = (list) => {
    const best = new Map();
    for (const [k, r] of list) {
      const cur = best.get(k);
      if (!cur || rank(r) < rank(cur)) best.set(k, r);
    }
    return [...best.entries()];
  };
  const inRows = dedupe(inc).map(([k, r]) => row(k, r, "in")).join("");
  const outRows = dedupe(out).map(([k, r]) => row(k, r, "out")).join("");
  const chainText = n.ch ? "在一条 " + (n.cs || 0) + " 个节点的长剧情里" : "不在长剧情线上";
  const emptyIn = n.on ? "没有。它按上面的时间自己出现。" : "没有。别的节点不会让它出现。";
  box.innerHTML =
    '<h2 style="margin-top:0">' + escHtml(KIND_NAME[n.t] || n.t) + " " + escHtml(n.id) + "</h2>" +
    (title ? '<div class="node-title">' + escHtml(title) + "</div>" : "") +
    '<div class="sub">' + escHtml(CAT_NAME[n.c] || n.c) + " · " + (n.o === "mod" ? "mod 改的" : "原版") +
    " · " + chainText + (n.b ? " · " + n.b + "：" + escHtml((n.bm || []).join(", ")) : "") + "</div>" +
    (n.on ? sec("什么时候发生", '<div class="cond">' + escHtml(timingText(n.on)) + "</div>") : "") +
    (conds ? sec("需要满足的条件", conds) : "") +
    (openTips ? sec("开启条件", openTips) : "") +
    sec("什么会让它出现", inRows || hint(emptyIn)) +
    nb +
    sec("会发生什么", outRows || hint("没有。它不引发别的事。")) +
    '<div class="note" id="editbox" style="margin-top:18px">' +
    (location.protocol === "http:"
      ? '<button id="editbtn" class="pill">编辑这个节点</button>'
      : "这个页面只能看。要改，用 node tools/editor.mjs 打开。") + "</div>";
  const modal = document.getElementById("modal");
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
  box.querySelectorAll("[data-go]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); focusNode(a.dataset.go); };
  });
  const edit = document.getElementById("editbtn");
  if (edit) edit.onclick = () => openEditor(key);
};

async function openEditor(key) {
  const box = document.getElementById("modal-body");
  box.innerHTML = '<div class="note">读取中…</div>';
  const res = await fetch("/api/node/" + encodeURIComponent(key));
  const node = await res.json();
  if (!node.ok) { box.innerHTML = '<div class="note bad">' + escHtml(node.error) + "</div>"; return; }
  box.innerHTML =
    '<h2 style="margin-top:0">编辑 ' + escHtml(node.key) + "</h2>" +
    '<div class="note">' + escHtml(node.path) + "</div>" +
    '<textarea id="ed" style="min-height:420px;font-family:ui-monospace,Menlo,monospace">' + escHtml(node.source) + "</textarea>" +
    '<div class="note"><button id="save" class="pill">保存</button> <span id="saveMsg"></span></div>';
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("saveMsg");
    msg.textContent = "保存中…";
    const r = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, source: document.getElementById("ed").value }),
    });
    const out = await r.json();
    // "unchanged" is a result, not a failure: no mod copy was made, so the node stays vanilla.
    msg.textContent = !out.ok
      ? "失败：" + out.error
      : out.unchanged
        ? "没有改动，未写入（不会生成 mod 副本）"
        : out.backup
          ? "已保存（备份 " + out.backup + "）"
          : "已保存";
  };
}

// ---------------------------------------------------------------- wiring
document.onkeydown = (e) => { if (e.key === "Escape") document.getElementById("modal").hidden = true; };
qEl.oninput = listRows;
document.getElementById("chain").onchange = (e) => { chainOnly = e.target.checked; listRows(); relayout(); };
document.getElementById("lang").onchange = (e) => { lang = e.target.value; listRows(); draw(); };
document.getElementById("edges").onchange = (e) => { showEdges = e.target.checked; schedule(); };
wrap.onscroll = schedule;
window.onresize = relayout;
cv.onwheel = (e) => {
  e.preventDefault();
  const next = Math.min(2, Math.max(0.4, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
  if (next === zoom) return;
  zoom = next;
  document.getElementById("z").textContent = Math.round(zoom * 100) + "%";
  relayout();
};
cv.onclick = (e) => {
  const x = (e.offsetX + wrap.scrollLeft) / zoom, y = (e.offsetY + wrap.scrollTop) / zoom;
  const hit = nodes.find((n) => x >= n.vx && x < n.vx + COL_W && y >= n.vy && y < n.vy + ROW_H);
  if (hit) { selected = hit.k; listRows(); window.__openNode(hit.k); schedule(); }
};
cats(); listRows(); relayout();
window.__draw = draw;
`;

export function renderPage(g, { title = "苏丹的游戏 · 剧情图" } = {}) {
  const body = `
<div class="gwrap">
  <div class="gtop">
    <div class="grow-row">
      <span class="note" style="margin:0">节点 ${g.nodes.length} · 边 ${g.edges.length} · 剧情链 ${g.components.count} 条（最大 ${g.components.largest}）</span>
      <span class="ctl">
        <input id="q" type="text" placeholder="搜索 ID / 名字 / 任意语言">
        <label><input id="chain" type="checkbox"> 只看剧情链</label>
        <label><input id="edges" type="checkbox"> 显示全部连线</label>
        <select id="lang">
          <option value="zh">简中</option><option value="en">en</option><option value="ja">ja</option><option value="zhTW">zhTW</option>
        </select>
        <span id="z" class="note" style="margin:0">100%</span>
      </span>
    </div>
    <span id="cats" class="cats"></span>
  </div>
  <div class="gmain">
    <div class="glist" id="list"></div>
    <div class="gcanvas" id="cwrap"><div id="spacer"></div><canvas id="cv"></canvas></div>
  </div>
  <div class="note">滚轮缩放 40%–200%，点节点打开编辑页。<span id="count"></span></div>
</div>
<div id="modal" class="modal" hidden><div class="modal-body" id="modal-body"></div></div>
`;
  const css = `
.gwrap { display: flex; flex-direction: column; gap: 10px; }
.gtop { display: flex; flex-direction: column; gap: 8px; }
.grow-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.cats { display: flex; gap: 6px; flex-wrap: wrap; }
.ctl label, .ctl { white-space: nowrap; }
.ctl { display: flex; gap: 12px; align-items: center; margin-left: auto; }
.ctl input[type=text] { width: 240px; }
.gmain { display: grid; grid-template-columns: 340px 1fr; gap: 12px; height: 78vh; }
.glist { overflow: auto; border: 1px solid var(--rule); background: var(--panel); }
.glist .row { display: grid; grid-template-columns: 76px 1fr; gap: 8px; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #2f2a24; }
.glist .row:hover { background: #35291c; }
.glist .id { color: var(--dim); font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.glist .nm { font-size: 13px; }
.gcanvas { overflow: auto; border: 1px solid var(--rule); background: #17120c; position: relative; }
.gcanvas canvas { position: sticky; top: 0; left: 0; display: block; }
#spacer { position: absolute; top: 0; left: 0; }
.row.sel { background: #3a2f1e; }
.row.sel .id { color: var(--gold); }
.toless { color: #7a6f5e; font-size: 10px; border: 1px solid #4a4238; border-radius: 2px; padding: 0 3px; margin-left: 4px; }
.story { background: #1d1710; border-left: 2px solid #4a3c28; padding: 8px 10px; margin: 6px 0; line-height: 1.65; font-size: 13px; color: #cfc0a4; }
#modal-body h2 { margin: 0 0 4px; font-size: 19px; letter-spacing: .04em; }
#modal-body .node-title { font-size: 22px; color: #f2e5c8; line-height: 1.4; margin: 4px 0 2px; letter-spacing: .03em; }
#modal-body h3 { font-size: 13px; color: var(--gold); letter-spacing: .06em; margin: 20px 0 6px; }
#modal-body .sub { color: #8a8070; font-size: 12px; line-height: 1.6; }
#modal-body .note { color: #8a8070; font-size: 12px; margin: 6px 0; }
#modal-body .relrow { display: grid; grid-template-columns: 8.5em 1fr; gap: 2px 12px; align-items: baseline; padding: 6px 0; border-top: 1px solid #241d15; }
#modal-body .relrow:first-of-type { border-top: 0; }
#modal-body .reltag { color: #9a8d78; font-size: 12px; text-align: right; }
#modal-body .relval { min-width: 0; }
#modal-body .relval a { color: #d8b877; text-decoration: none; }
#modal-body .relval a:hover { text-decoration: underline; }
#modal-body .cond { color: #cfc0a4; font-size: 13px; line-height: 1.75; margin: 3px 0; }
#modal-body .cond.muted { color: #7a6f5e; }
.badge { font-size: 10px; padding: 0 4px; border-radius: 2px; }
.badge.FAIL { background: var(--bad); color: #fff; }
.badge.WARN { background: var(--gold); color: #1a1510; }
.badge.INFO { background: #4f5a52; color: var(--ink); }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal[hidden] { display: none; }
.modal-body { background: var(--panel); border: 1px solid var(--rule); width: min(880px, 92vw); max-height: 86vh; overflow: auto; padding: 18px 20px; }
`;
  // The script goes after the shell: it reads DOM ids that only exist once the body is parsed.
  return (
    pageHtml({
      title,
      sub: `构建于 ${g.builtAt?.slice(0, 19).replace("T", " ") || ""}`,
      body,
      wide: true,
      extraCss: css,
    }) + `<script>${SCRIPT(JSON.stringify(payload(g)))}</script>\n`
  );
}

function parseArgs(argv) {
  const out = { configDir: DEFAULT_VANILLA, modDir: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vanilla") out.configDir = argv[++i];
    else if (a === "--mod") out.modDir = argv[++i];
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    process.stderr.write("usage: node tools/graphpage.mjs --out <file> [--mod <dir>]\n");
    return 2;
  }
  const g = buildGraph({ configDir: String(args.configDir).replace(/^~/, os.homedir()), modDir: args.modDir });
  const html = renderPage(g);
  const file = path.resolve(String(args.out).replace(/^~/, os.homedir()));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, html);
  process.stdout.write(`PASS  wrote ${file}  (${(html.length / 1048576).toFixed(1)} MB, ${g.nodes.length} nodes)\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("graphpage.mjs")) process.exit(main());
