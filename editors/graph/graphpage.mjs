#!/usr/bin/env node
/**
 * graphpage.mjs — render the story graph as one page: a list on the left, the selected
 * node's neighbourhood on the right, a category switcher in the top right, and the node the
 * reader picked in a column of its own beside them, so the picture is never covered.
 *
 *   node tools/graphpage.mjs --out editors/.preview/graph/graph.html [--mod your_mods/x] [--focus rite:5010901]
 *
 * `--mod` merges the mod's records into the picture and adds one more filter pill, `mod`, which
 * is selected on open: the page starts on what the mod touched, with everything else faded.
 * Mod records keep their own category, so `mod` is a filter across the lanes, not a lane.
 * `--focus kind:id` opens the page on that record instead of on an empty canvas.
 *
 * The page draws with Cytoscape.js + dagre, inlined from editors/graph/vendor/ so that it opens from
 * `file://` with no network. Nothing is positioned here: the browser lays out the subgraph.
 *
 * Size and time, measured on the vanilla corpus (5490 nodes, 12148 edges, macOS, node 24):
 *
 *   graph.html         2 826 476 bytes = 2.70 MiB   (482 kB of it the two inlined libraries)
 *   graph.detail.js   10 648 321 bytes = 10.16 MiB  (the panel's text, loaded on demand)
 *   before the split    8 130 000 bytes = 7.76 MiB  one file, everything inline
 *   build + write      ~1.77 s (buildGraph 1.72 s of it), page script compiles in 16 ms
 *
 * A depth-1 view draws ~60 nodes, so the picture is no longer what makes the file big: the
 * panel's narration and rite branches are. They are 10.2 MiB and only ever read for one node,
 * so they move to graph.detail.js next to the page, pulled in with a script tag when a panel
 * first opens. A page copied without that file still draws and still opens panels; it says
 * which file is missing. A script tag, not fetch(): fetch() is a CORS error under file://.
 * Open time in a browser cannot be measured from here; the 16 ms compile and the 23 ms it
 * takes to read both files are the only numbers this side of the DOM can give.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../../tools/graph.mjs";
import { cardNames } from "../../tools/card-names.mjs";
import { setCardNames } from "../page/page.mjs";
import { esc, pageHtml } from "../lib/shell.mjs";
import { DEFAULT_VANILLA } from "../../tools/model.mjs";
import { vanillaRequirement } from "../../tools/paths.mjs";
import { expandHome } from "../../tools/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The two UMD builds the page draws with. See editors/graph/vendor/README.md for provenance. */
const VENDOR = [
  { file: "cytoscape.min.js", version: "3.34.4" },
  { file: "cytoscape-dagre.min.js", version: "4.0.1" },
];

/**
 * The vendored scripts, as text, to be inlined before the page's own script. A missing file is
 * an installation error, not an empty graph: say which file and what to do about it.
 */
export function vendorScripts() {
  return VENDOR.map((v) => {
    const file = path.join(HERE, "vendor", v.file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Error(`missing editors/graph/vendor/${v.file} (${v.version}). NEXT: restore it from editors/graph/vendor/README.md, then re-run this tool.`);
    }
    // The whole point is inlining: a `</script>` inside the text would end the tag early.
    if (/<\/script|<!--/i.test(text)) {
      throw new Error(`editors/graph/vendor/${v.file} contains a sequence that cannot be inlined. NEXT: re-download the file and check it is the dist build.`);
    }
    return { ...v, text };
  });
}

/** The three script blocks a page needs, in load order: cytoscape, dagre, the page itself. */
function scriptBlocks(pageScript) {
  const libs = vendorScripts().map(
    (v) => `<script>/* ${v.file.replace(".min.js", "")} ${v.version} (MIT) - editors/graph/vendor/${v.file} */\n${v.text}\n</script>`
  );
  // A browser needs no id; the tests use it to pick the page's own script out of the three.
  return libs.join("\n") + `\n<script id="pagejs">${pageScript}</script>\n`;
}

const EDGE_CAP = 40;

/**
 * The group a node falls into on the canvas. Categories are for events (and, by majority vote,
 * the rites they open); every other kind is grouped by what it is, so a column of 掉落表 is not
 * mixed into 其他 — otherwise the 其他 pill would show far more than its own count.
 */
const groupOf = (n) => (n.t === "card" ? "card" : n.t === "rite" ? "rite" : n.t === "event" ? "other" : n.t);

/**
 * The fields the panel needs and the drawing does not: narration, rite branches, the paragraph,
 * the switches, the conditions. They are 10 MB of the corpus as JSON and are only ever read
 * for the one node a reader opened, so they travel in their own file (graph.detail.js) and the page
 * pulls that file in when a panel first opens. Splitting the difference here, in one place,
 * is what keeps the two halves from drifiting.
 */
const DETAIL_FIELDS = ["nr", "dl", "ri", "ev", "fl", "on", "cond", "oc"];

/** One node's detail, in the shape the panel reads. */
function detailOf(n) {
  return {
    nr: n.nr || null,
    dl: n.dl || null,
    ri: n.ri || null,
    fl: n.fl || null,
    on: n.on || null,
    cond: n.cond || null,
    oc: n.oc || null,
    ev: n.ev || null,
  };
}

/**
 * The payload the page carries: structure for every node (ids, labels in four languages,
 * categories, badges) and every edge. No panel text: see DETAIL_FIELDS.
 *
 * `mod` marks the records this page's mod carries or overrides. It is a flag on the node, not
 * a category: the node keeps the lane its record classifies into.
 *
 * `focus` is the record the page opens on, and `defaultCat` the filter it opens with — `mod`
 * when the page has any mod record, so a preview opens on what the mod changed.
 */
export function payload(g, { focus = null } = {}) {
  const index = new Map(g.nodes.map((n, i) => [n.k, i]));
  const modNodes = g.nodes.filter((n) => n.o === "mod").length;
  return {
    builtAt: g.builtAt,
    focus,
    defaultCat: modNodes ? "mod" : null,
    nodes: g.nodes.map((n) => ({
      k: n.k,
      t: n.t,
      id: n.id,
      c: n.cat || groupOf(n),
      o: n.o,
      ...(n.o === "mod" ? { mod: true } : {}),
      l: n.l,
      ch: Boolean(n.chain),
      cs: n.compSize || 0,
      tr: n.tr || { en: false, ja: false, zhTW: false },
      nt: n.note || "",
      b: (() => {
        const levels = (n.badges || []).map((x) => x.level);
        return levels.includes("FAIL") ? "FAIL" : levels.includes("WARN") ? "WARN" : levels.includes("INFO") ? "INFO" : null;
      })(),
      bm: [...new Set((n.badges || []).map((x) => x.code))],
    })),
    edges: g.edges.filter((e) => index.has(e.f) && index.has(e.t)).map((e) => [index.get(e.f), index.get(e.t), e.r]),
    counts: g.counts,
    categoryCounts: g.categoryCounts,
    fieldSwitches: g.fieldSwitches || null,
    components: { count: g.components.count, largest: g.components.largest },
  };
}

/** The panel's half of the graph, keyed by the node's index in payload().nodes. */
export function detailPayload(g) {
  const out = {};
  g.nodes.forEach((n, i) => {
    out[i] = detailOf(n);
  });
  return out;
}

/** graph.detail.js: one assignment, so the page can pull it in with a <script> tag. */
export function detailScript(g) {
  return (
    "// graph.detail.js - the node panel's text for the story graph page. Generated by tools/graphpage.mjs.\n" +
    "// Copy it beside graph.html; without it the page still draws, and panels say the file is missing.\n" +
    `window.__GRAPH_DETAIL__ = ${JSON.stringify(detailPayload(g))};\n`
  );
}

/** graph.html -> graph.data.js (the graph itself, loaded before the page script). */
export function dataName(pageFile) {
  return `${path.basename(pageFile).replace(/\.html?$/i, "")}.data.js`;
}

/** The name the detail file gets, derived from the page's own name: graph.html -> graph.detail.js */
export function detailName(htmlPath) {
  return path.basename(String(htmlPath)).replace(/\.html?$/i, "") + ".detail.js";
}



/**
 * Lane layout, kept as source: the page is a string, so its layout has to be one too. Each
 * lane runs its own dagre pass (top to bottom, the way the old columns read), then the whole
 * lane slides along x. Lane titles ride above their band.
 *
 * Exported so the tests can run this exact source against a headless cytoscape: two
 * implementations of "where does a node go" would drift apart, and the picture is the point.
 */
export const LANE_LAYOUT_JS = `
function laneLayout(cy, lanes, gap, headerH) {
  var x = 0;
  lanes.forEach(function (lane) {
    var nodes = cy.collection();
    lane.keys.forEach(function (k) { nodes = nodes.union(cy.getElementById(k)); });
    // dagre needs the lane's own edges: a collection of bare nodes has no ranks to assign.
    var eles = nodes.union(nodes.edgesWith(nodes));
    eles.layout({ name: "dagre", rankDir: "TB", nodeSep: 26, rankSep: 84, animate: false, fit: false, padding: 0 }).run();
    var bb = eles.boundingBox();
    var dx = x - bb.x1, dy = headerH - bb.y1;
    nodes.forEach(function (n) { var p = n.position(); n.position({ x: p.x + dx, y: p.y + dy }); });
    var head = cy.getElementById("lane:" + lane.cat);
    if (head.length) head.position({ x: x + bb.w / 2, y: headerH - 26 });
    x += bb.w + gap;
  });
  return x;
}
`;

export const pageScript = (dataUrl, editable, detailUrl) => `
// The graph itself (nodes, edges, switches) is too big for the file: a page is opened by the
// app's HTML preview, which refuses anything over 1 MB. It arrives as a sibling script.
const DATA_URL = ${JSON.stringify(dataUrl)};
const DATA = window.__GRAPH_DATA__ || { nodes: [], edges: [], counts: {}, categoryCounts: {}, components: { count: 0, largest: 0 } };
// A record page carries its own focus in a two-line file; the full page still uses the payload's.
const FOCUS = window.__GRAPH_FOCUS__ || DATA.focus || null;
// The panel's text (narration, branches, switches) lives in this file and is pulled in the
// first time a node is opened: 10 MB on disk that a page drawing a neighbourhood never needs.
const DETAIL_URL = ${JSON.stringify(detailUrl)};
// A save must land in a mod, so the page needs to know whether one was named at startup.
const EDITABLE = ${editable ? "true" : "false"};
const EDGE_CAP = ${EDGE_CAP};
const cyEl = document.getElementById("cy");
const listEl = document.getElementById("list"), qEl = document.getElementById("q");
const capEl = document.getElementById("cap");
let lang = "zh", cat = DATA.defaultCat || null, chainOnly = false, selected = null, depth = 1;
// A lane is a column: gap between columns, headroom for the lane title above them.
const LANE_GAP = 44, LANE_HEAD = 44;
// The libraries are inlined ahead of this script and land on the window object. Without them
// the list and the panel still work; only the drawing is missing, and the caption says so.
const cytoscape = typeof window.cytoscape === "function" ? window.cytoscape : null;

const CAT_COLOR = {
  unused: "#6b6257", reputation: "#b07a4a", ending: "#c96f5a", guide: "#7f9e8a",
  achievement: "#8d84b8", daily: "#7d8fa8", periodic: "#6f7f96", other: "#8a7a60",
  card: "#b9a887",
};
const CAT_NAME = { unused: "废弃", reputation: "声望", ending: "结局", guide: "引导", achievement: "成就", daily: "日常", periodic: "周期", other: "其他", card: "卡牌", rite: "仪式" };
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

// ---------------------------------------------------------------- graph model
// 仪式 and 事件 are not event categories: they cut the graph by node type, so a reader can
// take all of one kind. Everything else compares against the category the layout used.
function inCat(n) {
  if (!cat) return true;
  if (cat === "mod") return Boolean(n.mod);
  if (cat === "事件") return n.t === "event";
  if (cat === "仪式") return n.t === "rite";
  return n.c === cat;
}

function visible() {
  return DATA.nodes.filter((n) => inCat(n) && (!chainOnly || n.ch));
}

// The page walks the graph itself: an inline script cannot import tools/graph.mjs, and the
// depth control recomputes the walk on every move. tools/graph.mjs carries the same rules
// (neighbours / subgraph) for Node — change one and change the other.
const byKey = new Map(DATA.nodes.map((n) => [n.k, n]));
const idxOf = new Map(DATA.nodes.map((n, i) => [n.k, i]));

// ---------------------------------------------------------------- panel text on demand
// The page is one file plus graph.detail.js. A page copied without it still draws and still
// opens a panel; the panel then says which file is missing instead of going blank.
let detailState = "idle"; // idle | loading | ready | missing
const detailWaiters = [];

function graphDetail() {
  const d = window.__GRAPH_DETAIL__;
  return d && typeof d === "object" ? d : null;
}

function detailOf(key) {
  const d = graphDetail();
  const i = idxOf.get(key);
  return d && i != null && d[i] ? d[i] : {};
}

// The node as the panel wants it: what the page carries, plus what the detail file has.
function nodeOf(key) {
  const core = byKey.get(key);
  return core ? Object.assign({}, core, detailOf(key)) : null;
}

function missingDetailText() {
  return "没有找到 " + DETAIL_URL + "，这一页只画了结构和连线。把 " + DETAIL_URL + " 和页面放在同一个目录，描述、结算分支和开关就会出现。";
}

function ensureDetail(done) {
  if (graphDetail()) {
    detailState = "ready";
    return done(true);
  }
  if (detailState === "missing") return done(false);
  detailWaiters.push(done);
  if (detailState === "loading") return;
  detailState = "loading";
  const tag = document.createElement("script");
  tag.src = DETAIL_URL;
  tag.onload = () => {
    const ok = Boolean(graphDetail());
    detailState = ok ? "ready" : "missing";
    if (!ok && window.console) console.warn(DETAIL_URL + " loaded but defines no window.__GRAPH_DETAIL__; panels show structure only.");
    detailWaiters.splice(0).forEach((fn) => fn(ok));
  };
  tag.onerror = () => {
    detailState = "missing";
    if (window.console) console.warn(DETAIL_URL + " is not next to the page; panels show structure only. Copy it beside the page.");
    detailWaiters.splice(0).forEach((fn) => fn(false));
  };
  document.head.appendChild(tag);
}

// Adjacency is built at the first draw, not at load: 12 000 edges are the price of a picture
// nobody has asked for yet.
let adjCache = null;
function adj() {
  if (adjCache) return adjCache;
  const out = new Map(), inc = new Map();
  DATA.edges.forEach(([a, b, r]) => {
    if (!out.has(a)) out.set(a, []);
    if (!inc.has(b)) inc.set(b, []);
    out.get(a).push([b, r]);
    inc.get(b).push([a, r]);
  });
  adjCache = { out: out, inc: inc };
  return adjCache;
}

const DEPTH_MIN = 1, DEPTH_MAX = 5;
function clampDepth(d) {
  const n = Math.round(Number(d));
  return Number.isFinite(n) ? Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, n)) : DEPTH_MIN;
}

// The walk behind one selection: breadth first, both directions, depth hops out. A page
// cannot import, so this is the browser half of tools/graph.mjs subgraph(); the two must
// clamp, walk and sort the same way.
/** Cards are leaves in this picture; every other judgement about them follows from that. */
// Leaves are drawn but never walked out of: a card is mentioned by dozens of nodes, and a 星盘
// layout template is referenced the same way. The arrow points at them, one layer deep, and the
// walk continues through everything else.
const LEAF_KINDS = new Set(["card", "riteTemplate"]);
const isLeafIdx = (i) => {
  const n = DATA.nodes[i];
  return !!n && (LEAF_KINDS.has(n.t) || LEAF_KINDS.has(n.c));
};

function walkFrom(key, d) {
  const start = idxOf.get(key);
  const dep = clampDepth(d);
  const hops = new Map();
  if (start == null) return { centre: -1, depth: dep, hops: hops };
  hops.set(start, 0);
  // A card is a leaf: everything references cards, so a walk that passed through one would show
  // its whole fan-in. Cards are reached, never walked out of, and a card root never expands.
  if (isLeafIdx(start)) return { centre: start, depth: dep, hops: hops };
  let frontier = [start];
  const a = adj();
  for (let step = 1; step <= dep && frontier.length; step++) {
    const next = [];
    for (const i of frontier) {
      for (const [to] of (a.out.get(i) || []).concat(a.inc.get(i) || [])) {
        if (hops.has(to)) continue;
        hops.set(to, step);
        if (!isLeafIdx(to)) next.push(to);
      }
    }
    frontier = next;
  }
  return { centre: start, depth: dep, hops: hops };
}

// A lane is a category. The order is fixed, so the same node lands in the same column on
// every redraw and a reader can learn where to look.
const LANE_ORDER = ["unused", "reputation", "ending", "guide", "achievement", "daily", "periodic", "other", "rite", "card", "loot", "quest", "over", "afterStory", "riteTemplate"];
const laneName = (c) => CAT_NAME[c] || KIND_NAME[c] || c;

// When a hub has more edges than the cap, the strongest relations are the ones worth ink.
const REL_WEIGHT = (r) => (String(r).indexOf("trigger.") === 0 ? 3 : String(r).indexOf("action.") === 0 ? 2 : String(r).indexOf("condition.") === 0 ? 1 : 0);

// EDGE_CAP is per node, not per graph: 俺寻思 has 59 references and drawing all of them turns
// the picture into a cat's cradle. What did not fit is counted on the node as +N.
function clampEdges(list) {
  const degree = new Map(), over = new Map(), kept = [];
  list
    .slice()
    .sort((x, y) => REL_WEIGHT(y[2]) - REL_WEIGHT(x[2]) || x[0] - y[0] || x[1] - y[1])
    .forEach((e) => {
      const a = e[0], b = e[1];
      if ((degree.get(a) || 0) >= EDGE_CAP || (degree.get(b) || 0) >= EDGE_CAP) {
        over.set(a, (over.get(a) || 0) + 1);
        over.set(b, (over.get(b) || 0) + 1);
        return;
      }
      degree.set(a, (degree.get(a) || 0) + 1);
      degree.set(b, (degree.get(b) || 0) + 1);
      kept.push(e);
    });
  return { kept: kept, over: over };
}

function nodeLabel(n, over) {
  // Two lines: the id on top, the name under it. The box is 44 px tall for exactly this, and a
  // single run of "id  name" wraps at whatever character the width cuts, which reads badly.
  const name = dispLabel(n) + (over ? "  +" + over : "");
  return n.id + "\\n" + name;
}

// Every relation as the node's own neighbour list, in the shape the panel reads.
function outOf(key) {
  const i = idxOf.get(key);
  return (adj().out.get(i) || []).map(([j, r]) => [DATA.nodes[j].k, r]);
}
function inOf(key) {
  const i = idxOf.get(key);
  return (adj().inc.get(i) || []).map(([j, r]) => [DATA.nodes[j].k, r]);
}

// ---------------------------------------------------------------- renderer
// curve-style: taxi is the point of the library choice: a layered graph draws its edges as
// right-angled runs instead of a pile of bezier curves.
const CY_STYLE = [
  {
    selector: "node",
    style: {
      "background-color": "data(fill)",
      "border-width": 1,
      "border-color": "#57452c",
      shape: "round-rectangle",
      width: 168,
      // Two lines of label by default: most node names carry an id and a title on separate runs,
      // and a one-line box cuts them off mid-word.
      height: 52,
      label: "data(label)",
      "font-family": 'ui-monospace, Menlo, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", monospace',
      "font-size": 11,
      color: "#d7c9ab",
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "wrap",
      "text-max-width": 152,
      // Cytoscape centres a two-line label a little low inside the box; pull it back.
      "text-margin-y": 0,
      "text-overflow-wrap": "anywhere",
      "text-background-color": "#1d1710",
      "text-background-opacity": 0.9,
      "text-background-padding": 2,
      "text-background-shape": "roundrectangle",
      "overlay-opacity": 0,
    },
  },
  // A record the mod carries keeps its lane and its box: the gold border is the whole mark.
  // It sits before the state rules, so the centre and the selected node still read as themselves.
  { selector: "node.mod", style: { "border-width": 2, "border-color": "#c9a227" } },
  { selector: "node.centre", style: { "border-width": 3, "border-color": "#c9a227", "background-color": "#3a2f1e", color: "#fff4d0", "font-size": 13, width: 180, "z-index": 20 } },
  { selector: "node.hot", style: { "border-width": 2, "border-color": "#e0c46a", color: "#fff4d0" } },
  { selector: "node.dim", style: { opacity: 0.3 } },
  {
    selector: "node.lane",
    style: {
      "background-opacity": 0,
      "border-width": 0,
      shape: "round-rectangle",
      width: 170,
      height: 18,
      "font-size": 12,
      color: "#c9a227",
      "text-halign": "center",
      "text-valign": "center",
      "text-wrap": "none",
      "text-background-opacity": 0,
      "overlay-opacity": 0,
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "taxi",
      "taxi-direction": "vertical",
      "taxi-turn": "data(turn)",
      "taxi-radius": 10,
      "taxi-turn-min-distance": 8,
      "line-color": "#5a4a33",
      width: 1.2,
      "target-arrow-shape": "triangle",
      "target-arrow-color": "#8a7a60",
      "arrow-scale": 0.8,
      label: "data(rel)",
      "font-size": 9,
      color: "#9a8d78",
      "text-rotation": "autorotate",
      "text-background-color": "#17120c",
      "text-background-opacity": 0.85,
      "text-background-padding": 1,
      "text-margin-y": -3,
      "overlay-opacity": 0,
    },
  },
  { selector: "edge.hotedge", style: { "line-color": "#c9a227", "target-arrow-color": "#c9a227", width: 2.2, "z-index": 10 } },
  { selector: "node:selected", style: { "border-width": 3, "border-color": "#c9a227" } },
];

let cy = null;
function renderer() {
  if (cy || !cytoscape) return cy;
  cy = cytoscape({
    container: cyEl,
    style: CY_STYLE,
    elements: [],
    minZoom: 0.1,
    maxZoom: 2.5,
    boxSelectionEnabled: false,
    selectionType: "single",
  });
  // A click on a node is the same gesture as a row in the list: select, draw, open the panel.
  cy.on("tap", "node", (e) => {
    const k = e.target.data("k");
    if (k) selectOnly(k);
  });
  cy.on("dbltap", "node", (e) => {
    const k = e.target.data("k");
    if (k) focusNode(k);
  });
  // Hover says which lines belong to the node under the pointer; a hub owns dozens.
  cy.on("mouseover", "node", (e) => {
    const n = e.target;
    if (n.data("isLane")) return;
    n.addClass("hot");
    n.connectedEdges().addClass("hotedge");
  });
  cy.on("mouseout", "node", (e) => {
    e.target.removeClass("hot");
    e.target.connectedEdges().removeClass("hotedge");
  });
  return cy;
}

// What one selection draws: the elements, and the node and edge sets they came from.
function graphElements(key, d) {
  const walk = walkFrom(key, d);
  // Both ends inside the walk: an edge to a node that is not drawn hangs in the air.
  // Only one direction of card edge is drawn: the non-card that mentions the card points at it.
  // A card's own outgoing edges are noise, and they would double every reference.
  const within = DATA.edges.filter(([a, b]) => walk.hops.has(a) && walk.hops.has(b) && !isLeafIdx(a));
  const capped = clampEdges(within);
  // Cards are not drawn: a card is a thing a condition mentions, not a step in the story, and a
  // 卡牌 lane full of leaves is what made the picture unreadable. The panel still names them.
  const idxs = [...walk.hops.keys()].sort((x, y) => x - y);
  const lanes = lanesOf(idxs);
  const elements = [];
  // 结局 is both an event category and the over table's own name, so a title that repeats
  // carries the raw key: a reader must be able to tell the two columns apart.
  const titles = lanes.map((l) => laneName(l.cat));
  for (const lane of lanes) {
    const title = laneName(lane.cat);
    const named = titles.filter((t) => t === title).length > 1 ? title + " (" + lane.cat + ")" : title;
    elements.push({ classes: "lane", data: { id: "lane:" + lane.cat, isLane: true, c: lane.cat, fill: "#2c241c", label: named + " · " + lane.idxs.length } });
  }
  for (const lane of lanes) {
    for (const i of lane.idxs) {
      const n = DATA.nodes[i];
      const over = capped.over.get(i) || 0;
      const data = { id: n.k, k: n.k, c: lane.cat, fill: CAT_COLOR[lane.cat] || "#8a7a60", label: nodeLabel(n, over), over: over };
      elements.push(n.mod ? { classes: "mod", data: data } : { data: data });
    }
  }
  // An edge label per line is readable on a neighbourhood and noise on a crowd.
  const labelEdges = capped.kept.length <= 60;
  // Parallel edges between the same two columns would run down one vertical line. Each edge gets
  // a fixed turn point instead, spread across 34%..66% of its length, so a bundle reads as a
  // bundle instead of a single thick stroke. Deterministic: the same edge lands in the same place
  // every time the page is rebuilt.
  const turnOf = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
    return 34 + (h % 5) * 8 + "%";
  };
  for (const [a, b, r] of capped.kept) {
    const id = "edge:" + a + ">" + b + ">" + r;
    elements.push({ data: { id: id, turn: turnOf(id), source: DATA.nodes[a].k, target: DATA.nodes[b].k, rule: r, rel: labelEdges ? REL_OUT[r] || r : "" } });
  }
  return {
    walk: walk,
    nodes: idxs.map((i) => DATA.nodes[i].k),
    edges: capped.kept,
    lanes: lanes.map((l) => ({ cat: l.cat, keys: l.idxs.map((i) => DATA.nodes[i].k) })),
    elements: elements,
  };
}

/** The lanes of one walk: one per category, in the fixed order, each a column of nodes. */
function lanesOf(idxs) {
  const by = new Map();
  for (const i of idxs) {
    const c = DATA.nodes[i].c || "other";
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(i);
  }
  return [...by.keys()]
    .sort((a, b) => {
      const ia = LANE_ORDER.indexOf(a), ib = LANE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(String(b));
    })
    .map((c) => ({ cat: c, idxs: by.get(c) }));
}

// How a node is named in a caption. Same spelling as the list row: id, then the label.
function labelOf(key) {
  const n = byKey.get(key);
  return n ? n.id + " " + dispLabel(n) : key;
}

let lastGen = null;

// The one entry point: take the selection's subgraph, and hand it to the renderer.
function draw() {
  const gen = selected ? graphElements(selected, depth) : null;
  lastGen = gen;
  // The caption is the page's own record of what is on screen, so it is written even when
  // the renderer is missing: then the numbers still say what would have been drawn.
  capEl.textContent = gen
    ? "以 " + labelOf(selected) + " 为中心 · " + gen.walk.depth + " 层 · " + gen.nodes.length + " 个节点"
    : "点左边或图上的节点，从这里开始画";
  const live = renderer();
  if (!live) return gen;
  live.elements().remove();
  if (!gen) return gen;
  live.add(gen.elements);
  laneLayout(live, gen.lanes, LANE_GAP, LANE_HEAD);
  live.getElementById(selected).addClass("centre");
  markFilter();
  // fit() alone: it already shows every drawn node, and centering on the selected one
  // afterwards would push the last lane out of a canvas that is now only part of the width.
  live.fit(undefined, 40);
  return gen;
}

// The pill and the checkboxes narrow what the reader is looking for; they fade the other
// lanes instead of removing them, because an edge to a node that is not drawn hangs in the air.
function markFilter() {
  if (!cy) return;
  cy.nodes().forEach((n) => {
    const rec = byKey.get(n.data("k"));
    if (rec) n.toggleClass("dim", !inCat(rec));
  });
}

// The panel is a column beside the canvas, not an overlay: opening it narrows the drawing area,
// so the renderer has to be told its container changed or it keeps drawing at the old width.
function refitCanvas() {
  if (!cy) return;
  cy.resize();
  if (selected) cy.fit(undefined, 40);
}

function openPanel() {
  const modal = document.getElementById("modal");
  const wasHidden = modal.hidden;
  modal.hidden = false;
  // Every open re-renders the panel's text but only the first one moves the canvas.
  if (wasHidden) refitCanvas();
}

function closePanel() {
  const modal = document.getElementById("modal");
  if (modal.hidden) return;
  modal.hidden = true;
  refitCanvas();
}

// What a node is called on the canvas, in the list and in a link. An event's designer note is
// the name the panel prints, so the same string is used here: a row must read like the page it
// opens. Every other kind has a real name, already in the language on screen.
function dispLabel(n) {
  if (n.t === "event" && n.nt) return n.nt;
  return n.l[lang] || n.l.zh || "";
}

// ---------------------------------------------------------------- list
/** The word a player uses for a node kind, for the list's type column. */
function kindWord(kind) {
  var words = { event: "事件", rite: "仪式", card: "卡牌", loot: "战利品", quest: "任务", over: "结局", afterStory: "后日谈", riteTemplate: "星盘", counter: "计数器", game: "游戏", upgrade: "命运商店", tag: "标签", init: "开局" };
  return words[kind] || kind;
}

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
    '<span class="ty">' + escHtml(kindWord(n.t)) + "</span>" +
    '<span class="nm">' + (n.b ? '<span class="badge ' + n.b + '">' + n.b + "</span> " : "") +
    escHtml(dispLabel(n).slice(0, 40)) +
    (n.t !== "event" && lang !== "zh" && n.tr && !n.tr[lang] ? ' <span class="toless">无' + lang + "</span>" : "") + "</span></div>"
  ).join("") || '<div class="note">没有匹配</div>';
  // The list is the navigator: one click there means "show me this", so it redraws. A node on
  // the canvas is the thing you are already looking at, so it needs a second click to replace
  // the picture, and a single click only moves the selection and opens its text.
  listEl.onclick = (e) => {
    const row = e.target.closest(".row");
    if (row) focusNode(row.dataset.k);
  };
  document.getElementById("count").textContent = rows.length + " / " + DATA.nodes.length;
}

// One gesture, one place: a row, a drawn node and a link in the panel all land here.
function focusNode(key) {
  if (!byKey.has(key)) return;
  selected = key;
  draw();
  listRows();
  window.__openNode(key);
}

// A single click says which node you are reading; a double click changes what is drawn. The
// panel follows the single click, because reading a node is the common move and throwing the
// current picture away is not.
function selectOnly(key) {
  if (!byKey.has(key)) return;
  selected = key;
  if (cy) {
    cy.nodes().unselect();
    const n = cy.getElementById(key);
    if (n && n.length) n.select();
  }
  // Only the highlight, never a re-render: rebuilding the list between the two clicks of a
  // double click replaces the element under the pointer, and the second click lands nowhere.
  listEl.querySelectorAll(".row.sel").forEach((el) => el.classList.remove("sel"));
  const row = listEl.querySelector('.row[data-k="' + key + '"]');
  if (row) row.classList.add("sel");
  // Nothing on the canvas yet: a reader who clicks a row expects to see that node's picture, not
  // an empty frame with a text panel beside it. Only the first click draws; later clicks keep the
  // picture and just move the selection.
  if (!lastGen) draw();
  window.__openNode(key);
}

function cats() {
  const box = document.getElementById("cats");
  // A pill's number is what clicking it shows, so it counts nodes on the canvas — a category
  // holds the events that classify into it plus the rites those events open. The event-only
  // counts that graph.mjs --check prints are a different question and stay there.
  const countOf = (fn) => DATA.nodes.filter(fn).length;
  // mod is a cross-cut, so it sits right after 全部: it is the view a preview opens on, and
  // the two type pills stay the coarse cut of the whole corpus. A page with no mod record gets
  // no button — an always-empty filter is noise.
  const modCount = countOf((n) => n.mod);
  const all = [["", "全部", DATA.nodes.length]]
    .concat(modCount ? [["mod", "mod", modCount]] : [])
    .concat([["仪式", "仪式", countOf((n) => n.t === "rite")], ["事件", "事件", countOf((n) => n.t === "event")]])
    .concat(Object.keys(DATA.categoryCounts).map((c) => [c, CAT_NAME[c] || c, countOf((n) => n.c === c)]));
  box.innerHTML = all.map(([v, label, n]) =>
    '<button class="pill' + ((v || null) === (cat || null) ? " on" : "") + '" data-c="' + v + '">' + label +
    " <b>" + n + "</b></button>"
  ).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { cat = b.dataset.c || null; cats(); listRows(); markFilter(); };
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
// A key carries ids; a reader wants names. Every card, rite and event is already a node.
function idWithName(kind, id) {
  const n = byKey.get(kind + ":" + id);
  return n ? id + " " + dispLabel(n) : id;
}

// The have family counts cards. "have" = on the desk plus inside rites, "table_have" = on the
// desk, "hand_have" = only hand cards (a tag test in the game), "rite_have" = inside a rite,
// "sudan_pool_have" = the Sudan card pool. In the key, the id and the tag both narrow which
// cards count, and either may be missing.
const HAVE_VERB = { have: "拥有", table_have: "桌上放着", hand_have: "手牌里有", rite_have: "仪式里有", sudan_pool_have: "苏丹卡池里有" };
const HAVE_NOT = { have: "没有", table_have: "桌上没有", hand_have: "手牌里没有", rite_have: "仪式里没有", sudan_pool_have: "苏丹卡池里没有" };
const OPS = { "<": " 小于 ", "<=": " 不大于 ", ">": " 大于 ", ">=": " 不小于 ", "=": " 等于 ", "==": " 等于 " };

function haveLeaf(head, rest, neg, op, val) {
  const id = rest[0] && /^\\d+$/.test(rest[0]) ? rest[0] : "";
  const tag = rest.filter((x) => x && !/^\\d+$/.test(x)).join(" ");
  const bits = [];
  if (tag) bits.push(tag === "sudan" ? "苏丹卡" : tag);
  if (id) bits.push(idWithName(head === "rite_have" ? "rite" : "card", id));
  const phrase = (neg ? HAVE_NOT : HAVE_VERB)[head] + (bits.length ? " " + bits.join(" · ") : "");
  return op ? phrase + OPS[op] + val : phrase + "，" + val + " 张";
}

function condLeaf(k, v, ctx) {
  var neg = false;
  if (k.charAt(0) === "!") { neg = true; k = k.slice(1); }
  var op = "";
  var m = k.match(/^(.*?)(<=|>=|<|>|==|=)$/);
  if (m) { k = m[1]; op = m[2]; }
  var p = k.split(/[:.]/);
  var head = p[0], rest = p.slice(1);
  var val = v && typeof v === "object" ? JSON.stringify(v) : String(v);
  if (HAVE_VERB[head]) return haveLeaf(head, rest, neg, op, val);
  // is: 2000056 names the card itself, so the value is not a number to print.
  if (head === "is") return (neg ? "不是" : "是") + "卡 " + idWithName("card", rest[0] || val);
  // A slot index: s2: 1 means slot s2 holds a card, !s13 that it is empty, s2.is which card.
  if (/^s\\d+$/.test(head)) {
    if (rest[0] === "is") return (neg ? "槽位 " + head + " 里不是卡 " : "槽位 " + head + " 里是卡 ") + idWithName("card", val);
    if (rest.length) return "槽位 " + head + " 的 " + rest.join(" ") + (op ? OPS[op] + val : "：" + val);
    if (neg) return "槽位 " + head + " 里没有卡";
    if (val === "1" && !op) return "槽位 " + head + " 里有卡";
    return "槽位 " + head + " 里的卡数" + (op ? OPS[op] : "：") + val;
  }
  var what;
  if (head === "rite") what = "仪式 " + (rest.length === 1 && /^\\d+$/.test(rest[0]) ? idWithName("rite", rest[0]) : rest.join(" "));
  else if (head === "event") what = "事件 " + (rest.length === 1 && /^\\d+$/.test(rest[0]) ? idWithName("event", rest[0]) : rest.join(" "));
  else if (head === "card") what = "卡 " + (rest.length === 1 && /^\\d+$/.test(rest[0]) ? idWithName("card", rest[0]) : rest.join(" "));
  else if (head === "rite_end") what = "仪式 " + idWithName("rite", rest.join("")) + " 结束时";
  else if (head === "counter") what = "计数器 " + rest.join(" ");
  else if (head === "global_counter") what = "全局计数器 " + rest.join(" ");
  else if (head === "round") what = "回合数";
  else if (head === "difficulty") what = "难度";
  else if (head === "type") what = ctx === "slot" ? "卡的类型" : "局类型";
  else what = k;
  // A negated rite such as !rite: 5001501 carries the id in the value, not in the key.
  const idFromValue = !rest.length && /^\\d+$/.test(val) && (head === "rite" || head === "event" || head === "card");
  if (idFromValue) what = what.replace(/\\s+$/, "") + " " + idWithName(head, val);
  what = what.replace(/\\s+$/, "");
  if (neg) return "没有" + what + (rest.length || idFromValue ? "" : " " + val);
  if (op) return what + OPS[op] + val;
  return what + "：" + val;
}

function condTree(obj, depth, ctx) {
  var out = [];
  if (!obj || typeof obj !== "object") return out;
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (k === "any" || k === "all") {
      out.push({ t: k === "any" ? "满足任一项" : "全部满足", d: depth });
      out = out.concat(condTree(v, depth + 1, ctx));
    } else if (v && typeof v === "object") {
      out.push({ t: condLeaf(k, "", ctx) + " " + JSON.stringify(v), d: depth });
    } else {
      out.push({ t: condLeaf(k, v, ctx), d: depth });
    }
  });
  return out;
}

function condHtml(obj, ctx) {
  return condTree(obj, 0, ctx).map(function (x) {
    return '<div class="cond" style="padding-left:' + x.d * 14 + 'px">' + escHtml(x.t) + "</div>";
  }).join("");
}

// Everything the panel says about a node, without the buttons. The read view and the left half
// of the editor show the same text, so it is built once, here.
// The switches a node sets, each said as one short sentence picked by its value: a flag reads
// as yes/no, a number or a list fills {v}. The sentence is what the reader wants; the field
// name stays in the tooltip for whoever has to go and edit it.
function switchText(kind, key, value) {
  const spec = ((DATA.fieldSwitches || {})[kind] || {})[key];
  if (!spec) return "";
  const pick = (slot) => (slot ? slot[lang] || slot.zh || "" : "");
  if (spec.yes) return pick(value ? spec.yes : spec.no);
  const v = Array.isArray(value) ? value.join(", ") : String(value);
  // A switch whose values are a small enum says one sentence per value instead of a yes/no.
  if (spec.values) return pick(spec.values[v]);
  const slot = v === "1" && spec.one ? spec.one : v === "0" && spec.zero ? spec.zero : spec.num;
  return pick(slot).replace("{v}", v);
}

function flagBlock(n) {
  if (!n.fl) return "";
  const chips = Object.keys(n.fl)
    .map((k) => {
      const text = switchText(n.t, k, n.fl[k]);
      return text ? '<span class="sw" title="' + escHtml(k) + '">' + escHtml(text) + "</span>" : "";
    })
    .filter(Boolean)
    .join("");
  return chips ? '<div class="swrow">' + chips + "</div>" : "";
}

function sublabel(text) {
  return '<div class="sublabel">' + escHtml(text) + "</div>";
}

// What a rite asks for, and what it can turn into. Every line comes from the record: the slots
// name the cards the board wants, and the three settlement lists are separate lists. Prior and
// normal stop at the first branch whose condition holds, so they are alternatives, not steps.
const RITE_TYPE = { NORMAL: "普通", END: "结局", ENEMY: "敌人", TREASURE: "宝藏" };

function slotBlock(ri) {
  if (!ri.slots || !ri.slots.length) return "";
  const rows = ri.slots
    .map((sl) => {
      const cond = sl.cond ? condHtml(sl.cond, "slot") : "";
      const marks = (sl.adsorb ? '<span class="mark">吸附槽</span>' : "") + (sl.enemy ? '<span class="mark">敌方槽</span>' : "");
      return '<div class="slot"><div class="slotname">' + escHtml(sl.k) + (sl.text ? " · " + escHtml(sl.text) : "") + marks + "</div>" + cond + "</div>";
    })
    .join("");
  return "<h3>放什么卡</h3>" + sublabel(ri.slots.length + " 个槽位") + rows;
}

function branchGroup(name, list, note) {
  if (!list || !list.length) return "";
  const rows = list
    .map((b, i) => {
      const cond = b.cond && Object.keys(b.cond).length ? condHtml(b.cond) : '<div class="cond muted">没有条件</div>';
      const out = [b.title, b.text].filter(Boolean).map((t) => '<div class="story">' + escHtml(t) + "</div>").join("");
      // A branch that gives a card without saying so reads as pure story: name every effect.
      const res = (b.res || []).length
        ? sublabel("效果") + b.res.map((t) => '<div class="cond">' + escHtml(t) + "</div>").join("")
        : "";
      return '<div class="branch"><div class="branchhead">第 ' + (i + 1) + " 条</div>" + cond + out + res + "</div>";
    })
    .join("");
  return sublabel(name + "（" + note + "）") + rows;
}

// An event settles into stages, not into branches: every stage runs, and each stage's action
// names the outcomes (确认 / 成功 / 失败) that carry what actually happens.
const OUTCOME_NAME = { confirm: "确认", success: "成功", failed: "失败" };

function eventBlock(n) {
  const ev = n.ev;
  if (!ev) return "";
  const body = ev.stages
    .map((st, i) => {
      const head = ev.stages.length > 1 ? '<div class="branchhead">第 ' + (i + 1) + " 段</div>" : "";
      const tips = st.tips ? '<div class="cond">' + escHtml(st.tips) + "</div>" : "";
      const steps = st.steps
        .map((step) => {
          const text = step.text ? '<div class="story">' + escHtml(step.text) + "</div>" : "";
          const res = (step.res || []).length
            ? sublabel("效果") + step.res.map((t) => '<div class="cond">' + escHtml(t) + "</div>").join("")
            : "";
          return '<div class="branch"><div class="branchhead">' + escHtml(OUTCOME_NAME[step.k] || step.k) + "</div>" + text + res + "</div>";
        })
        .join("");
      return head + tips + steps;
    })
    .join("");
  return "<h3>结算</h3>" + sublabel("每一段各自执行；段内的结果分支当事件走到才会发生") + body;
}

function riteBlock(n) {
  const ri = n.ri;
  if (!ri) return "";
  const groups =
    branchGroup("先结算", ri.prior, "按顺序，第一条条件成立的生效") +
    branchGroup("正常结算", ri.normal, "按顺序，第一条条件成立的生效") +
    branchGroup("附加结算", ri.extre, "逐条各自判断");
  const tips = (ri.tips || []).map((t) => '<div class="cond">' + escHtml(t) + "</div>").join("");
  return (
    slotBlock(ri) +
    (groups ? "<h3>结算分支</h3>" + groups : "") +
    (tips ? "<h3>规则提示</h3>" + tips : "")
  );
}

// Type and place, when the record says them. Most rites are NORMAL and carry no type at all.
function riteFacts(n) {
  const ri = n.ri;
  if (!ri) return "";
  const bits = [];
  if (ri.type && ri.type !== "NORMAL") bits.push("类型 " + (RITE_TYPE[ri.type] || ri.type));
  if (ri.location) bits.push("地点 " + ri.location);
  return bits.map((t) => " · " + escHtml(t)).join("");
}

let expandAll = false;
function panelHtml(n, all = expandAll) {
  const lim = all ? Infinity : 30;
  const out = outOf(n.k).slice(0, lim);
  const inc = inOf(n.k).slice(0, lim);
  const nb = descBlock(n);
  const title = dispLabel(n);
  const sec = (t, body) => "<h3>" + escHtml(t) + "</h3>" + body;
  const hint = (text) => '<div class="cond muted">' + text + "</div>";
  // Three different logics used to read as one flat list. Say which is which: a condition is
  // all-of, a trigger is any-of, and a rite's open tips are what the game says when unmet.
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
  // A condition that names another node is still a condition: it belongs beside the node's own
  // condition lines, not under "what it causes".
  const outEdges = dedupe(out);
  const inRows = dedupe(inc).map(([k, r]) => row(k, r, "in")).join("");
  const condOutRows = outEdges.filter(([, r]) => r.indexOf("condition.") === 0).map(([k, r]) => row(k, r, "out")).join("");
  const outRows = outEdges.filter(([, r]) => r.indexOf("condition.") !== 0).map(([k, r]) => row(k, r, "out")).join("");
  const chainText = n.ch ? "在一条 " + (n.cs || 0) + " 个节点的长剧情里" : "不在长剧情线上";
  const emptyIn = n.on ? "没有条件。它按上面的时机自己出现。" : "没有条件，也没有别的节点触发它。";
  return (
    '<h2 style="margin-top:0">' + escHtml(KIND_NAME[n.t] || n.t) + " " + escHtml(n.id) + "</h2>" +
    (title ? '<div class="node-title">' + escHtml(title) + "</div>" : "") +
    '<div class="sub">' + escHtml(CAT_NAME[n.c] || n.c) + " · " + (n.o === "mod" ? "mod 改的" : "原版") +
    " · " + chainText +
    (n.b ? " · " + n.b + "：" + escHtml((n.bm || []).join(", ")) : "") +
    riteFacts(n) + "</div>" +
    flagBlock(n) +
    (n.on ? sec("时机", '<div class="cond">' + escHtml(timingText(n.on)) + "</div>") : "") +
    // Everything that has to hold for this node to show up, in one place: its own condition,
    // the tips on a rite's open conditions, and the nodes that trigger it. A reader asking
    // "when does this happen" does not care which of the three it came from.
    sec(
      "条件",
      (conds || condOutRows ? sublabel("全部满足") + conds + condOutRows : "") +
        (inRows ? sublabel("任一发生就会触发") + inRows : "") +
        (openTips ? sublabel("开启条件：不满足时游戏会这样提示") + openTips : "") ||
        hint(emptyIn)
    ) +
    nb +
    (n.t === "rite" ? riteBlock(n) : "") +
    (n.t === "event" ? eventBlock(n) : "") +
    sec("结果", outRows || hint("没有结果。它不引发别的事。"))
  );
}

// A page opened from disk has no editor server behind it, and fetch() there is a CORS failure:
// the panel printed "Failed to fetch" where the file should be. The page already hides 编辑 off
// the server, so it says where the file can be read instead of asking for it.


// The file that holds a node, as the server reads it. Reading is allowed on a read-only
// page: only a write needs a mod to land in.
async function nodeSource(key) {
  if (location.protocol !== "http:") return { ok: false, noServer: true };
  try {
    const res = await fetch("/api/node/" + encodeURIComponent(key));
    return await res.json();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function whyNotEditable() {
  if (location.protocol !== "http:") return "这个页面只能看。要改，用 node tools/editor.mjs 打开。";
  return "只读：启动时没带 --mod。要改，先建 your_mods/&lt;ModName&gt;/，再用 node tools/editor.mjs --mod your_mods/&lt;ModName&gt; 打开。";
}

async function saveSource(key, text, msg) {
  msg.textContent = "保存中…";
  let out;
  try {
    const r = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, source: text }),
    });
    out = await r.json();
  } catch (e) {
    msg.textContent = "失败：" + String((e && e.message) || e);
    return false;
  }
  // "unchanged" is a result, not a failure: no mod copy was made, so the node stays vanilla.
  msg.textContent = !out.ok
    ? "失败：" + out.error
    : out.unchanged
      ? "没有改动，未写入（不会生成 mod 副本）"
      : (out.backup ? "已保存（备份 " + out.backup + "）" : "已保存") + " · 左边和图上还是旧值，刷新页面后才更新";
  return Boolean(out.ok);
}

// A key the current build does not read is worth marking in the file itself: 1520 vanilla
// events still carry auto_start, every one of them false, and a copy of one inherits it.
const DEAD_KEY = new RegExp('(^|[^_"])"auto_start"\\s*:');

// The vanilla files are CRLF, and a stray carriage return in front of the note is a line
// break to the browser, so the note dropped onto its own line. Only the display is
// normalised; the file and the editor keep their bytes.
function annotate(source) {
  return source
    .split(/\\r\\n|\\n|\\r/)
    .map((line) =>
      DEAD_KEY.test(line)
        ? '<span class="dead" title="当前版本不读这个键，写了也不生效">' + escHtml(line) + ' <i>← 当前版本不读它</i></span>'
        : escHtml(line)
    )
    .join("\\n");
}

/** The right half: the file the node lives in. Read-only until 编辑 is pressed. */
async function fillSource(key) {
  const pane = document.getElementById("srcpane");
  if (!pane) return;
  pane.innerHTML = '<div class="note" style="margin-top:0">读取中…</div>';
  const node = await nodeSource(key);
  if (!document.getElementById("srcpane")) return; // the reader moved on while this was in flight
  if (node.noServer) {
    // No local server: the panel's own text is the whole page. Nothing to explain here.
    pane.innerHTML = "";
    return;
  }
  if (!node.ok) {
    pane.innerHTML = '<div class="note bad">' + escHtml(node.error) + "</div>";
    return;
  }
  const source = node.source;
  pane.innerHTML =
    '<div class="note" style="margin-top:0">' + escHtml(node.path) + "</div>" +
    '<pre id="srcpre" class="src">' + annotate(source) + "</pre>" +
    '<div class="note" id="srcbar">' +
    (EDITABLE && location.protocol === "http:" ? '<button id="editbtn" class="pill">编辑</button>' : whyNotEditable()) +
    "</div>";
  const btn = document.getElementById("editbtn");
  if (!btn) return;
  btn.onclick = () => {
    pane.innerHTML =
      '<div class="note" style="margin-top:0">' + escHtml(node.path) + "</div>" +
      '<textarea id="ed" spellcheck="false">' + escHtml(source) + "</textarea>" +
      '<div class="note" id="srcbar"><button id="save" class="pill">保存</button> ' +
      '<button id="cancel" class="pill">取消</button> <span id="saveMsg"></span></div>';
    const ed = document.getElementById("ed");
    ed.dataset.original = source;
    document.getElementById("save").onclick = () => saveSource(key, ed.value, document.getElementById("saveMsg"));
    document.getElementById("cancel").onclick = () => fillSource(key);
  };
}

window.__openNode = (key) => {
  if (!byKey.has(key)) return;
  ensureDetail((ok) => {
  const box = document.getElementById("modal-body");
  // The node's own reading first, then the file it lives in: one column, so the panel stays a
  // column beside the canvas instead of a sheet over it.
  box.innerHTML =
    '<div class="drawerbar"><button id="panelexpand" class="pill">展开</button>' +
    '<button id="panelshink" class="pill">缩小</button>' +
    '<button id="panelclose" class="pill">关闭</button></div>' +
    '<div class="editsplit">' +
    '<div class="editview" id="panelview">' +
    (ok ? "" : '<div class="note bad">' + escHtml(missingDetailText()) + "</div>") +
    panelHtml(nodeOf(key), expandAll) + "</div>" +
    '<div class="editsrc" id="srcpane"></div>' +
    "</div>";
(function () {
  var btn = document.getElementById("listtoggle");
  var main = typeof document.querySelector === "function" ? document.querySelector(".gmain") : null;
  if (!btn || !main) return;
  btn.onclick = function () {
    var hidden = main.classList.toggle("nolist");
    btn.textContent = hidden ? "显示列表" : "隐藏列表";
    if (cy) setTimeout(function () { cy.resize(); cy.fit(undefined, 40); }, 30);
  };
})();
document.getElementById("panelexpand").onclick = () => {
  expandAll = true;
  document.getElementById("modal").classList.add("expanded");
  // Redraw the panel in place: every relation the node has, not the first 30.
  var view = document.getElementById("panelview");
  if (view && selected) view.innerHTML = panelHtml(nodeOf(selected), true);
};
document.getElementById("panelshink").onclick = () => {
  expandAll = false;
  document.getElementById("modal").classList.remove("expanded");
  var view = document.getElementById("panelview");
  if (view && selected) view.innerHTML = panelHtml(nodeOf(selected), false);
};
document.getElementById("panelclose").onclick = closePanel;
  openPanel();
  box.querySelectorAll("[data-go]").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      // Leaving the node throws away an unsaved edit, so ask first.
      const ed = document.getElementById("ed");
      if (ed && ed.value !== ed.dataset.original && !confirm("右边有没保存的改动，仍要离开？")) return;
      focusNode(a.dataset.go);
    };
  });
  fillSource(key);
  });
};

// ---------------------------------------------------------------- wiring
document.onkeydown = (e) => { if (e.key === "Escape") closePanel(); };
qEl.oninput = listRows;
document.getElementById("chain").onchange = (e) => { chainOnly = e.target.checked; listRows(); };
// Same selection, wider walk: the depth control never changes what is centred.
document.getElementById("depth").onchange = (e) => { depth = clampDepth(e.target.value); draw(); };
// The label is data in cytoscape, so a language switch rewrites it instead of relaying out.
document.getElementById("lang").onchange = (e) => {
  lang = e.target.value;
  if (cy) cy.nodes().forEach((n) => { const i = idxOf.get(n.data("k")); if (i != null) n.data("label", nodeLabel(DATA.nodes[i], n.data("over") || 0)); });
  listRows();
};
// The record the page was built to show: --focus, when this page carries it.
if (FOCUS && byKey.has(FOCUS)) selected = FOCUS;
cats(); listRows(); draw();

// A link can name the record to open on: graph.html#rite:5010901. It wins over --focus,
// because the hash is the more specific request (one page, many records).
function focusFromHash() {
  var key = "";
  try { key = decodeURIComponent(String((window.location && window.location.hash) || "").replace(/^#/, "")); } catch (e) { key = ""; }
  if (key && byKey.has(key)) focusNode(key);
}
focusFromHash();
// The page exists to explain one record: open its detail before the reader asks.
if (selected && byKey.has(selected)) window.__openNode(selected);
if (typeof window.addEventListener === "function") window.addEventListener("hashchange", focusFromHash);

// The lane layout is shared source: the page and the tests run the same text.
${LANE_LAYOUT_JS}

// The page's script is one string, so a test can only meet it here: the state a click leaves
// behind, and the elements that click built. Both are read-only views of the same draw().
window.__graphState = () => ({
  selected: selected,
  cat: cat,
  depth: depth,
  caption: capEl.textContent,
  nodes: lastGen ? lastGen.nodes : [],
  edges: lastGen ? lastGen.edges : [],
});
window.__elements = () => (lastGen ? lastGen.elements : []);
window.__select = (key) => focusNode(key);
window.__draw = draw;
`;

export function renderPage(g, { title = "苏丹的游戏 · 剧情图", editable = true, modNote = "", detailUrl = "graph.detail.js", dataUrl = "graph.data.js", focus = null, prompt = false, promptScript = null,
    scripts = { vendor: "graph.vendor.js", page: "graph.page.js", focus: "graph.focus.js" } } = {}) {
  const body = `
<div class="gshell">
  <div class="gwrap">
    <div class="gtop">
      <div class="grow-row">
        <span class="note" style="margin:0">节点 ${g.nodes.length} · 边 ${g.edges.length} · 剧情链 ${g.components.count} 条（最大 ${g.components.largest}）${modNote ? ` · ${esc(modNote)}` : ""}</span>
        <span class="ctl">
          <input id="q" type="text" placeholder="搜索 ID / 名字 / 任意语言">
          <label><input id="chain" type="checkbox"> 只看剧情链</label>
          <label>层数 <select id="depth"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></label>
          <select id="lang">
            <option value="zh">简中</option><option value="en">en</option><option value="ja">ja</option><option value="zhTW">zhTW</option>
          </select>
        </span>
      </div>
      <span id="cats" class="cats"></span>
      <button class="pill" id="listtoggle" type="button">隐藏列表</button>
    </div>
    <div class="gmain">
      <div class="glistwrap" id="listwrap">
        <div class="glist" id="list"></div>
      </div>
      <div class="gcanvas"><div id="cy"></div></div>
    </div>
    <div class="note" id="cap">点左边或图上的节点，从这里开始画</div>
    <div class="note">滚轮缩放、拖动平移。单击选中节点，双击或点列表打开详情。<span id="count"></span></div>
  </div>
  <div id="modal" class="modal" hidden><div class="modal-body" id="modal-body"></div></div>
</div>
`;
  const css = `
.gshell { display: flex; align-items: flex-start; gap: 12px; flex-wrap: nowrap; }
@media (max-width: 1240px) {
  .gshell { flex-direction: column; }
  .modal { flex: 1 1 auto; position: static; width: 100%; max-height: none; }
  .gshell:has(#modal:not([hidden])) .gmain { height: 62vh; }
}
.gwrap { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-width: 0; }
.gtop { display: flex; flex-direction: column; gap: 8px; }
.grow-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.cats { display: flex; gap: 6px; flex-wrap: wrap; }
.ctl label, .ctl { white-space: nowrap; }
.ctl { display: flex; gap: 12px; align-items: center; margin-left: auto; }
.ctl input[type=text] { width: 240px; }
.gmain { display: grid; grid-template-columns: clamp(270px, 28%, 340px) 1fr; grid-template-rows: minmax(0, 1fr); gap: 12px; height: 78vh; }
/* With the panel open the controls wrap onto a second row, so the drawing area gives up that
   much height: the list and the canvas stay inside the window instead of running past it. */
.gshell:has(#modal:not([hidden])) .gmain { height: calc(100vh - 285px); }
.glist { flex: 1 1 auto; overflow: auto; min-height: 0; border: 1px solid var(--rule); background: var(--panel); }
.glistwrap[hidden] { display: none; }
.glistwrap { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.gmain { min-height: 0; }
.gmain.nolist { grid-template-columns: 1fr; }
.gmain.nolist .glistwrap { display: none; }
.glist .row { display: grid; grid-template-columns: 68px 46px 1fr; gap: 8px; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #2f2a24; }
.glist .row:hover { background: #35291c; }
#glist-ty, .glist .ty { color: var(--dim); font-size: 12px; white-space: nowrap; }
.glist .id { color: var(--dim); font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.glist .nm { font-size: 13px; }
.gcanvas { border: 1px solid var(--rule); background: #17120c; position: relative; min-height: 0; }
#cy { position: absolute; inset: 0; }
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
#modal-body .sublabel { color: #9a8d78; font-size: 12px; letter-spacing: .04em; margin: 12px 0 2px; }
#modal-body .slot { margin: 8px 0; padding: 6px 0 4px; border-top: 1px solid #241d15; }
#modal-body .slotname { color: #d8b877; font-size: 13px; margin-bottom: 2px; }
#modal-body .branch { margin: 8px 0; padding: 6px 0 4px; border-top: 1px solid #241d15; }
#modal-body .branchhead { color: #9a8d78; font-size: 12px; }
#modal-body .mark { margin-left: 8px; color: #8a8070; font-size: 11px; border: 1px solid #3a3128; border-radius: 3px; padding: 0 5px; }
#modal-body .swrow { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 2px; }
#modal-body .sw { font-size: 12px; color: #d8c9ab; background: #241d15; border: 1px solid #3a3128; border-radius: 3px; padding: 2px 8px; }
.badge { font-size: 10px; padding: 0 4px; border-radius: 2px; }
.badge.FAIL { background: var(--bad); color: #fff; }
.badge.WARN { background: var(--gold); color: #1a1510; }
.badge.INFO { background: #4f5a52; color: var(--ink); }
.modal { flex: 0 1 min(620px, 44vw); position: sticky; top: 12px; max-height: 92vh; overflow-y: auto; background: var(--panel); border: 1px solid var(--rule); }
.modal[hidden] { display: none; }
.modal-body { padding: 14px 16px; }
.modal:not(.expanded) .story { max-height: 6.5em; overflow: hidden; }
.modal.expanded .story { max-height: none; }
.modal.expanded { flex: 0 1 min(900px, 56vw); max-height: none; overflow: visible; }
@media (max-width: 1240px) { .modal.expanded { width: 100%; } }
.drawerbar { display: flex; justify-content: flex-end; margin: 0 0 6px; }
.editsplit { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
.editview { padding-bottom: 10px; border-bottom: 1px solid #2f2a24; }
.editsrc { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.editsrc textarea { min-height: 40vh; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.55; tab-size: 4; }
.editsrc .src { background: #1d1710; border-left: 2px solid #4a3c28; margin: 6px 0; padding: 8px 10px; max-height: 40vh; overflow: auto; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.55; white-space: pre; color: #cfc0a4; }
.editsrc .src .dead { color: #7a6f5e; }
.editsrc .src .dead i { color: #b4543f; font-style: normal; }
`;
  const promptBlock = prompt
    ? `<div class="wrap" style="padding-bottom:32px">
<h2>要改什么</h2>
<p class="note" style="margin-top:0">用平时的话说就行，例如「第二个结算改成给一张卡」。Agent 会按这句话改记录，再重新生成这一页。</p>
<textarea id="record-prompt" data-record="${esc(focus || "")}" rows="4" placeholder="例如：这句台词再狠一点；每 3 回合改成每 5 回合"></textarea>
<div class="savebar" style="margin-top:8px;display:flex;align-items:center;gap:10px">
<button class="pill" id="record-notify" type="button">发送给 Agent</button>
<span class="note" id="record-status"></span>
</div>
</div>`
    : "";
  // The scripts go after the shell: they read DOM ids that only exist once the body is parsed.
  return (
    pageHtml({
      title,
      sub: `构建于 ${g.builtAt?.slice(0, 19).replace("T", " ") || ""}`,
      body: body + promptBlock,
      wide: true,
      extraCss: css,
    }) +
    `<script src="${esc(scripts.vendor)}"></script>\n` +
    `<script src="${esc(dataUrl)}"></script>\n` +
    (focus ? `<script src="${esc(scripts.focus)}"></script>\n` : "") +
    (promptScript ? `<script src="${esc(promptScript)}"></script>\n` : "") +
    `<script src="${esc(scripts.page)}"></script>\n`
  );
}

function parseArgs(argv) {
  const out = { configDir: DEFAULT_VANILLA, modDir: null, out: null, focus: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vanilla") out.configDir = argv[++i];
    else if (a === "--mod") out.modDir = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--focus") out.focus = argv[++i];
  }
  return out;
}

/**
 * Write the page and the panel's detail file beside it. Both are needed for a complete page;
 * the page alone still draws and still opens panels, and says which file is missing.
 */
export function writePage(g, outPath, opts = {}) {
  const file = path.resolve(expandHome(outPath));
  const detail = path.join(path.dirname(file), detailName(file));
  mkdirSync(path.dirname(file), { recursive: true });
  const data = path.join(path.dirname(file), opts.dataUrl || dataName(file));
  const scripts = {
    vendor: opts.vendorUrl || "graph.vendor.js",
    page: opts.pageUrl || "graph.page.js",
    focus: opts.focusUrl || "graph.focus.js",
  };
  const html = renderPage(g, {
    ...opts,
    detailUrl: opts.detailUrl || detailName(file),
    dataUrl: opts.dataUrl || dataName(file),
    scripts,
  });
  const script = detailScript(g);
  const payloadJson = JSON.stringify(payload(g, { focus: opts.focus ?? null }));
  writeFileSync(file, html);
  // The app's HTML preview refuses inline scripts, so the renderer travels in files of its own.
  const dir = path.dirname(file);
  writeFileSync(path.join(dir, scripts.vendor), vendorScripts().map((v) => `/* ${v.file.replace(".min.js", "")} ${v.version} (MIT) - editors/graph/vendor/${v.file} */\n/* Local copy of the library the story graph ships with; never fetched from the network. */\n${v.text}`).join("\n"));
  writeFileSync(path.join(dir, scripts.page), `${pageScript(scripts.vendor, opts.editable !== false, opts.detailUrl || detailName(file))}\n`);
  if (opts.focus) writeFileSync(path.join(dir, scripts.focus), `window.__GRAPH_FOCUS__ = ${JSON.stringify(String(opts.focus))};\n`);
  if (opts.dataUrl) return { file, bytes: Buffer.byteLength(html), data: null, dataBytes: 0, detail: null, detailBytes: 0 };
  writeFileSync(data, `// graph.data.js - nodes, edges and switches. Loaded by ${path.basename(file)}. Generated by tools/graphpage.mjs.\nwindow.__GRAPH_DATA__ = ${payloadJson};\n`);
  writeFileSync(detail, script);
  // Bytes, not characters: the page is full of CJK, where the two differ by a factor of three.
  return { file, bytes: Buffer.byteLength(html), data, dataBytes: Buffer.byteLength(`window.__GRAPH_DATA__ = ${payloadJson};`), detail, detailBytes: Buffer.byteLength(script) };
}

const megabytes = (n) => (n / 1048576).toFixed(2) + " MB";

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.out) {
    process.stderr.write("usage: node tools/graphpage.mjs --out <file> [--mod <dir>] [--focus kind:id] [--vanilla <config dir>]\n");
    return 2;
  }
  // A graph built from a directory that does not exist has 0 nodes and renders as a clean,
  // empty page. The player cannot tell that from "this mod has no events", so refuse.
  const requirement = vanillaRequirement(args.configDir);
  if (!requirement.dir) {
    process.stdout.write(`FAIL  ${requirement.message}\n`);
    process.stdout.write(`NEXT  ${requirement.next}\n`);
    return 1;
  }
  // This runs as its own process, so the card names it prints come from here: an effect reads
  // 生成卡牌 血滴子, not an id nobody can resolve.
  setCardNames(cardNames([args.modDir && path.join(path.resolve(expandHome(args.modDir)), "config"), requirement.dir]));
  const g = buildGraph({ configDir: requirement.dir, modDir: args.modDir });
  const written = writePage(g, args.out, { focus: args.focus });
  // Two files, and the second one is named: a page copied on its own still draws, but its
  // panels have no text, so whoever hands the preview over has to hand over both.
  process.stdout.write(`PASS  wrote ${written.file}  (${megabytes(written.bytes)}, ${g.nodes.length} nodes)\n`);
  process.stdout.write(`PASS  wrote ${written.detail}  (${megabytes(written.detailBytes)}, the node panel's text; copy it beside the page)\n`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
