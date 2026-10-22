/**
 * The page is one big script string, so the only honest way to test it is to run it. This
 * file runs the real script against a small DOM shim and reads what it puts in the nodes:
 * the read panel, the split editor, and the body a save posts. Nothing here re-implements
 * the view, so a change to the view is visible here or nowhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { buildGraph } from "./graph.mjs";
import { renderPage, payload, LANE_LAYOUT_JS, detailPayload, detailScript, detailName, writePage } from "./graphpage.mjs";
import { openMod, DEFAULT_VANILLA } from "./model.mjs";
import { readNodeSource } from "./editor.mjs";

const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, os.homedir());
const skip = existsSync(VANILLA) ? false : "the game's config is not installed on this machine";

const ctxStub = new Proxy(
  {},
  { get: (_t, k) => (k === "measureText" ? (s) => ({ width: String(s).length * 7 }) : () => ({ width: 10 })), set: () => true }
);

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function el(id, onHtml) {
  const store = { id, innerHTML: "", textContent: "", style: {}, hidden: true, value: "zh", checked: false, dataset: {}, clientWidth: 900, clientHeight: 700, scrollLeft: 0, scrollTop: 0, width: 0, height: 0 };
  const classList = { add: () => {}, remove: () => {}, contains: () => false };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "classList") return classList;
      if (k === "getContext") return () => ctxStub;
      if (k === "querySelectorAll") return () => [];
      return () => {};
    },
    set(t, k, v) {
      t[k] = v;
      if (k === "innerHTML" && onHtml) onHtml(v);
      return true;
    },
  });
}

/**
 * Run the page script and hand back the window plus the elements it wrote to.
 * `detail: "full"` hands the page the panel text up front, the way a browser that loaded
 * graph.detail.js has it; `detail: null` leaves it out, so the page has to ask for the file.
 * `protocol` is what the page sees in location: a page opened from disk has no server.
 */
function mount(g, { editable = true, detail = "full", protocol = "http:", page = {} } = {}) {
  const els = new Map();
  // A textarea read back through `.value` is how the save button gets its text, so the shim
  // turns the markup the page wrote into that value, the way a browser does.
  const syncText = (html) => {
    const m = html.match(/<textarea id="ed"[^>]*>([\s\S]*?)<\/textarea>/);
    if (!m) return;
    if (!els.has("ed")) els.set("ed", el("ed"));
    els.get("ed").value = decode(m[1]);
  };
  // The page asks for graph.detail.js by inserting a script tag; the shim keeps them so a
  // test can play the browser and fail the load.
  const scripts = [];
  const document = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, el(id, syncText));
      return els.get(id);
    },
    createElement: (tag) => {
      const s = { tag, src: "", onload: null, onerror: null };
      scripts.push(s);
      return s;
    },
    head: { appendChild: () => {} },
    onkeydown: null,
  };
  const win = {};
  const mod = openMod(mkdtempSync(path.join(tmpdir(), "page-")), { vanilla: VANILLA });
  const posts = [];
  // Every request the page makes, so a test can say the page made none.
  const fetched = [];
  const fetch = async (url, opts) => {
    fetched.push(url);
    if (url.startsWith("/api/node/")) {
      const key = decodeURIComponent(url.slice("/api/node/".length));
      const [kind, id] = key.split(":");
      const got = readNodeSource(mod, kind, id);
      return { json: async () => ({ ok: true, key, path: got.file, source: got.text, whole: got.whole }) };
    }
    if (url === "/api/save") {
      posts.push(JSON.parse(opts.body));
      return { json: async () => ({ ok: true, unchanged: true, path: "x", warnings: [] }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  // Three script blocks in the page; the page's own one is the tagged last block.
  const script = renderPage(g, { editable, ...page }).match(/<script id="pagejs">([\s\S]*?)<\/script>/)[1];
  new Function("document", "window", "location", "requestAnimationFrame", "fetch", script)(
    document,
    win,
    { protocol },
    (fn) => { if (fn) fn(); return 0; },
    fetch
  );
  if (detail === "full") win.__GRAPH_DETAIL__ = detailPayload(g);
  return { win, els, document, posts, scripts, fetched };
}

const graph = () => buildGraph({});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("the panel names a node, then says what it says, beside the file it lives in", { skip }, async () => {
  const { win, els } = mount(graph());
  win.__openNode("event:5300090");
  await tick();
  const html = els.get("modal-body").innerHTML;
  assert.match(html, /class="editsplit"/, "the panel is two columns from the start");
  assert.match(html, /<div class="node-title">浴场移除提示<\/div>/, "an event's name is its note");
  assert.match(html, /<h3>描述<\/h3>/, "the narration follows, under its own heading");
  assert.match(html, /浴场暂时关闭/, "and the narration itself is there");
  const right = els.get("srcpane").innerHTML;
  assert.match(right, /<pre id="srcpre" class="src">/, "the right column shows the file, read-only");
  assert.match(right, /&quot;id&quot;: 5300090/, "the file itself, not a re-typed copy");
  // The four-language table is gone: one language is on screen at a time.
  assert.doesNotMatch(html, /table class="names"/);
});

test("时机 is the timing, and everything else that gates a node is 条件", { skip }, async () => {
  const { win, els } = mount(graph());
  win.__openNode("event:5300090");
  await tick();
  const h = els.get("modal-body").innerHTML;
  assert.match(h, /<h3>时机<\/h3>/, "the `on` field is the timing");
  assert.match(h, /<h3>条件<\/h3>/);
  assert.doesNotMatch(h, /什么会让它出现|需要满足的条件/, "the three old headings are gone");
  const cond = h.split("<h3>条件</h3>")[1].split("<h3>")[0];
  assert.match(cond, /计数器 7000056 不小于 1/, "the node's own condition");
  assert.match(cond, /条件涉及仪式/, "a condition that names another node");

  win.__openNode("rite:5008014");
  await tick();
  const rite = els.get("modal-body").innerHTML.split("<h3>条件</h3>")[1].split("<h3>")[0];
  assert.match(rite, /由它开启/, "what triggers it is also part of 条件");
  assert.match(rite, /条件涉及卡/, "as is a condition that names a card");
  // The three logics are labelled: all-of, any-of, and a rite's unmet tips.
  assert.match(rite, /<div class="sublabel">全部满足<\/div>/);
  assert.match(rite, /<div class="sublabel">任一发生就会触发<\/div>/);

  win.__openNode("rite:5000812"); // two open_conditions, each with its own tip
  await tick();
  const oc = els.get("modal-body").innerHTML;
  assert.match(oc, /<div class="sublabel">开启条件：不满足时游戏会这样提示<\/div>/);
  assert.match(oc, /匪帮调动中，无法进行训练/, "the tip the game prints when unmet");
});

test("a switch reads as the sentence its value earns", { skip }, async () => {
  const { win, els, document } = mount(graph());
  win.__openNode("event:5300090");
  await tick();
  const zh = els.get("modal-body").innerHTML;
  assert.match(zh, /class="sw" title="is_replay">可以重复触发</, "true says so, and the field name is the tooltip");
  assert.match(zh, /本局开始时自动启用（只在开局 1）/, "a list value fills the slot");
  assert.match(zh, /等它的时机到了再检查条件/, "false picks the other sentence");

  // A false flag must not print the true sentence.
  win.__openNode("event:5300311");
  await tick();
  assert.match(els.get("modal-body").innerHTML, /不可重复触发/);

  document.getElementById("lang").onchange({ target: { value: "en" } });
  win.__openNode("event:5300090");
  await tick();
  const en = els.get("modal-body").innerHTML;
  assert.match(en, />repeatable</);
  assert.doesNotMatch(en, /可以重复触发/);

  document.getElementById("lang").onchange({ target: { value: "zh" } });
  win.__openNode("rite:5008014");
  await tick();
  const rite = els.get("modal-body").innerHTML;
  assert.match(rite, /要玩家点开始/);
  assert.match(rite, /立即结算/, "round_number 1 has its own wording");
  assert.match(rite, /没有等待期限/, "waiting_round 0 has its own wording");
});

test("every kind gets its own group, and the pills count what they show", { skip }, async () => {
  const p = payload(graph());
  const at = (k) => p.nodes.find((n) => n.k === k);
  assert.equal(at("event:5300090").c, "daily", "an event keeps its category");
  assert.equal(at("rite:5008014").c, "reputation", "a rite inherits the category of the events that open it");
  assert.equal(at("card:2000001").c, "card");
  assert.equal(at("loot:6000004").c, "loot", "a loot table is its own column, not 其他");
  assert.equal(at("quest:3300001").c, "quest");
  assert.equal(at("riteTemplate:8000009").c, "riteTemplate");
  // 其他 must mean the residual events only, or its badge lies about what clicking it shows.
  assert.equal(p.nodes.filter((n) => n.c === "other").length, p.nodes.filter((n) => n.c === "other" && n.t === "event").length + p.nodes.filter((n) => n.c === "other" && n.t === "rite").length);

  const { els } = mount(graph());
  const pills = els.get("cats").innerHTML;
  assert.match(pills, /仪式 <b>1498<\/b>/, "all rites, whatever category they landed in");
  assert.match(pills, /事件 <b>1867<\/b>/);
  const other = p.nodes.filter((n) => n.c === "other").length;
  assert.match(pills, new RegExp("其他 <b>" + other + "<\\/b>"), "the badge is the canvas count");
});

test("a have condition names the card and says which container counts it", { skip }, async () => {
  const { win, els } = mount(graph());
  const condOf = async (key) => {
    win.__openNode(key);
    await tick();
    return els.get("modal-body").innerHTML.split("<h3>条件</h3>")[1].split("<h3>")[0];
  };
  // table_have.2000366.目的地 — the id and the tag both narrow which cards count.
  assert.match(await condOf("event:5310411"), /桌上放着 目的地 · 2000366 中国/);
  // The five variants differ only in where they look, and the wording says where.
  const hand = await condOf("event:5320545");
  assert.match(hand, /桌上放着 2000061 阿迪莱/);
  assert.match(hand, /手牌里有 妻子，1 张/);
  // A negated rite carries its id in the value, not the key.
  assert.match(await condOf("event:5300090"), /没有仪式 5001501 浴场里的消息/);
});

test("a rite shows its place, its slots and its settlement branches", { skip }, async () => {
  const { win, els } = mount(graph());
  win.__openNode("rite:5000812");
  await tick();
  const p = els.get("modal-body").innerHTML;
  assert.match(p, /类型 宝藏/);
  assert.match(p, /地点 奇珍:11/);
  assert.match(p, /<h3>放什么卡<\/h3>/);
  assert.match(p, /s1 · 芮尔手下/, "the slot's own sentence names what it wants");
  assert.match(p, /是卡 2000965 烂泥众/, "and the condition names the card");
  assert.match(p, /<h3>结算分支<\/h3>/);
  assert.match(p, /先结算（按顺序，第一条条件成立的生效）/, "prior stops at the first match");
  assert.match(p, /正常结算|附加结算/, "the other two lists are labelled separately");
  assert.match(p, /槽位 s13 里没有卡/, "a slot condition reads as a sentence");
  assert.match(p, /<span class="mark">吸附槽<\/span>/, "a slot the game auto-pulls cards into says so");
  // once_new is an enum, not a flag: 1 = only the first appearance counts as new.
  assert.match(p, /只有第一次算新的|每次出现都算新的/);
});

test("a dead key is marked in the file, and not in the editor", { skip }, async () => {
  const { win, els } = mount(graph());
  win.__openNode("event:5300085"); // this event still carries "auto_start": false
  await tick();
  const pre = els.get("srcpane").innerHTML;
  assert.match(pre, /class="dead"/, "the line is marked");
  assert.match(pre, /← 当前版本不读它/);
  // The file is CRLF: a stray carriage return renders as a break and pushed the note onto
  // its own line. The display is normalised, so the note stays at the end of the line.
  assert.doesNotMatch(pre, /\r/);
  assert.match(pre, /false, <span class="dead"|<\/span>$/m);
  assert.match(pre, /auto_start/, "and the text itself is untouched");
  els.get("editbtn").onclick();
  const text = els.get("ed").value;
  assert.doesNotMatch(text, /当前版本不读它/, "the editor gets the file, not the annotation");
  assert.match(text, /"auto_start":\s*false/, "including the dead key, so a save keeps it");
});

test("编辑 turns the right column into an editor, 取消 turns it back", { skip }, async () => {
  const { win, els, posts } = mount(graph());
  win.__openNode("card:2000001");
  await tick();
  els.get("editbtn").onclick();
  const editing = els.get("srcpane").innerHTML;
  assert.match(editing, /<textarea id="ed"/, "the source becomes editable in place");
  assert.match(editing, /<button id="cancel"/, "and there is a way back");
  assert.match(els.get("modal-body").innerHTML, /<div class="node-title">阿尔图<\/div>/, "the left column stays");

  els.get("save").onclick();
  await tick();
  assert.equal(posts.length, 1, "one click, one save");
  assert.equal(posts[0].key, "card:2000001");
  assert.match(posts[0].source, /2000001/, "the save carries the textarea's text");
  assert.match(els.get("saveMsg").textContent, /没有改动/, "an unchanged save says so");

  els.get("cancel").onclick();
  await tick();
  assert.match(els.get("srcpane").innerHTML, /<pre id="srcpre"/, "取消 restores the read-only column");
});

test("a read-only page still shows the source, without 编辑", { skip }, async () => {
  const { win, els } = mount(graph(), { editable: false });
  win.__openNode("rite:5008014");
  await tick();
  const right = els.get("srcpane").innerHTML;
  assert.match(right, /<pre id="srcpre"/, "reading needs no mod");
  assert.doesNotMatch(right, /id="editbtn"/);
  assert.match(right, /只读：启动时没带 --mod/);
});

// ---------------------------------------------------------------- vendored renderer
// The page must open from file:// with no network, so both libraries are inlined as bytes.
// A floor per file, not one number: cytoscape's dist is 436 kB and the dagre extension 46 kB,
// dagre core included. A tiny file is an HTML error page saved under a .js name.
const VENDOR = [
  { file: "cytoscape.min.js", version: "3.34.4", marker: /cytoscape/, min: 400000 },
  { file: "cytoscape-dagre.min.js", version: "4.0.1", marker: /dagre/, min: 40000 },
];

test("the page inlines both vendored libraries, and nothing is fetched", { skip }, () => {
  const html = renderPage(graph());
  for (const v of VENDOR) {
    const text = readFileSync(new URL(`../editors/graph/vendor/${v.file}`, import.meta.url), "utf8");
    assert.ok(text.length > v.min, `${v.file} is a real build (${text.length} bytes), not an error page`);
    assert.match(text, v.marker, `${v.file} names its own library`);
    assert.ok(html.includes(text), `${v.file} is inlined byte for byte`);
    assert.match(html, new RegExp(`/\\* ${v.file.replace(".min.js", "")} ${v.version.replace(/\./g, "\\.")} \\(MIT\\)`), `${v.file} ${v.version} is named`);
  }
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/i, "no external script tag");
});

// ---------------------------------------------------------------- step 1: the renderer
const pageScript = (g, opts) => {
  const html = renderPage(g, opts);
  const m = html.match(/<script id="pagejs">([\s\S]*?)<\/script>/);
  assert.ok(m, "the page carries its own script block");
  return m[1];
};

test("the page's own script parses, because a broken string is a blank page", { skip }, () => {
  const script = pageScript(graph());
  assert.doesNotThrow(() => new Function(script), "the generated inline script must be valid JS");
  assert.match(script, /cytoscape\(/, "the renderer is cytoscape");
  // A hyphenated style key is written with quotes, so the pattern allows either spelling.
  assert.match(script, /"?curve-style"?\s*:\s*"taxi"/, "layered edges are drawn as taxi lines");
  assert.match(script, /"?text-overflow-wrap"?\s*:\s*"anywhere"/, "CJK labels wrap anywhere");
  assert.match(script, /text-background-opacity/, "labels sit on a pill");
  assert.match(script, /PingFang SC|Microsoft YaHei/, "the label font stack is CJK-friendly");
});

test("selecting a node draws one element per node, and none is lost", { skip }, () => {
  const { win } = mount(graph());
  win.__select("event:5300090");
  const state = win.__graphState();
  const els = win.__elements();
  assert.equal(state.selected, "event:5300090", "clicking a node sets the selection");
  const drawn = els.filter((e) => !e.data.source && !e.data.isLane).map((e) => e.data.k);
  assert.equal(drawn.length, state.nodes.length, "one element per drawn node");
  assert.deepEqual(drawn.slice().sort(), state.nodes.slice().sort(), "and the two agree on which");
  assert.equal(els.filter((e) => e.data.source).length, state.edges.length, "one element per drawn edge");
  const laneHeads = els.filter((e) => e.data.isLane);
  assert.ok(laneHeads.length >= 1, "every category on screen is named by a lane title");
});

// ---------------------------------------------------------------- step 2: one node at a time
test("the page draws nothing until a node is picked", { skip }, () => {
  const { win } = mount(graph());
  const state = win.__graphState();
  assert.equal(state.nodes.length, 0, "no graph on load");
  assert.equal(win.__elements().length, 0, "and no elements built");
  assert.match(state.caption, /点左边或图上的节点/, "the caption says what to do");
});

test("picking a node draws it with its neighbours", { skip }, () => {
  const { win } = mount(graph());
  win.__select("event:5300090");
  const state = win.__graphState();
  assert.ok(state.nodes.includes("event:5300090"), "the centre is drawn");
  assert.ok(state.nodes.length > 1, "and so is what it touches");
  assert.ok(state.nodes.length < 100, "but not the whole graph");
});

test("the depth control redraws a wider walk", { skip }, () => {
  const { win, document } = mount(graph());
  win.__select("event:5300090");
  const one = win.__graphState().nodes.length;
  document.getElementById("depth").onchange({ target: { value: "3" } });
  const three = win.__graphState();
  assert.equal(three.depth, 3, "the control sets the depth");
  assert.ok(three.nodes.length >= one, "three hops cannot be fewer nodes than one");
  document.getElementById("depth").onchange({ target: { value: "9" } });
  assert.equal(win.__graphState().depth, 5, "and the depth is clamped to what the page offers");
});

test("the caption states the centre, the depth and the count", { skip }, () => {
  const { win } = mount(graph());
  win.__select("event:5300090");
  const state = win.__graphState();
  assert.match(state.caption, /^以 5300090 浴场移除提示 为中心 · 1 层 · \d+ 个节点$/);
  const n = state.nodes.length;
  assert.equal(state.caption.endsWith(`· ${n} 个节点`), true, "the number is the drawn node count");
});

// ---------------------------------------------------------------- step 2b: the mod view
// A mod's records are not a lane of their own: each keeps the category its record classifies
// into, carries a flag, and one extra pill filters to the flagged ones. Built once — a full
// build is seconds, and every test below reads the same one.
let modGraphCache = null;
const modGraph = () =>
  (modGraphCache ??= (() => {
    const dir = mkdtempSync(path.join(tmpdir(), "page-mod-"));
    mkdirSync(path.join(dir, "config/event"), { recursive: true });
    writeFileSync(
      path.join(dir, "config/event/9000001.json"),
      JSON.stringify({ id: 9000001, text: "新事件", is_replay: 0, on: { rite_end: 5000002 }, condition: {}, settlement: [] })
    );
    return buildGraph({ modDir: dir });
  })());

test("only the mod's own records carry the mod flag", { skip }, () => {
  const p = payload(modGraph());
  assert.deepEqual(p.nodes.filter((n) => n.mod).map((n) => n.k), ["event:9000001"], "the record the mod carries is the one marked");
  assert.equal(p.nodes.find((n) => n.k === "event:5300090").mod, undefined, "a vanilla node carries no flag");
  assert.equal(payload(graph()).nodes.filter((n) => n.mod).length, 0, "a page built without --mod has no mod nodes");
});

test("the filter row gains one mod button, and it is the one selected on open", { skip }, () => {
  const { win, els } = mount(modGraph());
  const row = els.get("cats").innerHTML;
  assert.match(row, /data-c="mod"/, "the category row carries a mod button");
  assert.match(row, /class="pill on" data-c="mod"/, "and it is selected when the page opens");
  assert.equal(win.__graphState().cat, "mod", "so the list starts on the mod's records");
  assert.doesNotMatch(mount(graph()).els.get("cats").innerHTML, /data-c="mod"/, "a page with no mod records gets no empty filter");
});

test("--focus opens the page on that record, with its one-hop picture", { skip }, () => {
  const g = modGraph();
  const html = renderPage(g, { focus: "event:9000001" });
  assert.match(html, /"focus":"event:9000001"/, "the payload names the record the page was built for");
  const { win } = mount(g, { page: { focus: "event:9000001" } });
  const state = win.__graphState();
  assert.equal(state.selected, "event:9000001", "the page starts on it");
  assert.ok(state.nodes.includes("event:9000001") && state.nodes.includes("rite:5000002"), "and draws its neighbourhood");
  assert.match(state.caption, /^以 9000001 新事件 为中心 · 1 层 · \d+ 个节点$/, "the caption names it");
  assert.equal(payload(g).focus, null, "without --focus the payload names no record");
});

test("a mod node is drawn with a gold border and the same box", { skip }, () => {
  const script = renderPage(modGraph()).match(/<script id="pagejs">([\s\S]*?)<\/script>/)[1];
  const style = script.match(/selector: "node\.mod",\s*style: \{([^}]*)\}/)[1];
  assert.match(style, /"border-color": "#c9a227"/, "gold, the page's accent");
  assert.match(style, /"border-width": 2/);
  assert.doesNotMatch(style, /(^|[{,])\s*"?(width|height|shape|font-size)"?\s*:/, "the geometry is every other node's");
  const { win } = mount(modGraph(), { page: { focus: "event:9000001" } });
  assert.equal(win.__elements().find((e) => e.data.k === "event:9000001").classes, "mod", "and it carries the class the style selects");
  assert.equal(win.__elements().find((e) => e.data.k === "rite:5000002").classes, undefined, "a vanilla neighbour is not marked");
});

// ---------------------------------------------------------------- step 3: lanes
// The lane layout runs on a real cytoscape core with no browser: dagre is arithmetic, and the
// same source the page inlines is what these tests execute.
const require = createRequire(import.meta.url);
const cytoscape = require("../editors/graph/vendor/cytoscape.min.js");
require("../editors/graph/vendor/cytoscape-dagre.min.js")(cytoscape);
const laneLayout = new Function(LANE_LAYOUT_JS + "\nreturn laneLayout;")();

const LANES = [
  { cat: "other", keys: ["e1", "e2", "e3"] },
  { cat: "card", keys: ["c1", "c2"] },
];

/** Two lanes, joined by one cross-lane edge, the way a subgraph arrives. */
function laneCy() {
  const elements = [];
  for (const lane of LANES) {
    elements.push({ data: { id: `lane:${lane.cat}`, isLane: true, c: lane.cat, label: lane.cat } });
    for (const k of lane.keys) elements.push({ data: { id: k, k, c: lane.cat, label: k } });
  }
  elements.push({ data: { id: "e1e2", source: "e1", target: "e2" } });
  elements.push({ data: { id: "e2c1", source: "e2", target: "c1" } });
  return cytoscape({ headless: true, styleEnabled: false, elements });
}

const laneXs = (cy, lane) => lane.keys.map((k) => cy.getElementById(k).position("x"));

test("each lane is laid out on its own and keeps to one x band", () => {
  const cy = laneCy();
  laneLayout(cy, LANES, 60, 40);
  assert.ok(
    Math.max(...laneXs(cy, LANES[0])) < Math.min(...laneXs(cy, LANES[1])),
    "the first lane ends before the second begins, so a lane is a column"
  );
  const header = cy.getElementById("lane:other").position();
  const top = Math.min(...LANES[0].keys.map((k) => cy.getElementById(k).position("y")));
  assert.ok(header.y < top, "the lane title sits above its nodes");
});

test("two layouts of the same lanes put every node in the same place", () => {
  const snap = () => {
    const cy = laneCy();
    laneLayout(cy, LANES, 60, 40);
    return cy.nodes().map((n) => `${n.id()}:${n.position("x").toFixed(3)},${n.position("y").toFixed(3)}`).join(" ");
  };
  assert.equal(snap(), snap(), "a redraw must not move the picture under the reader");
});

// ---------------------------------------------------------------- step 4: two files
test("the panel's text travels in its own file, not in the page", { skip }, () => {
  const g = graph();
  const html = renderPage(g);
  // A rite's paragraph is panel text; its label ("荣耀回归") stays, because the list shows it.
  assert.ok(!html.includes("你已经拿到了盖斯家的世袭头衔"), "the panel text is not in the page");
  assert.match(html, /"graph\.detail\.js"/, "the page names the file it will ask for on demand");
  const detail = detailScript(g);
  assert.ok(detail.includes("你已经拿到了盖斯家的世袭头衔"), "the panel text is in the detail file");
  assert.match(detail, /^\/\/ graph\.detail\.js/, "the file says what it is");
  assert.match(detail, /window\.__GRAPH_DETAIL__ = \{/, "and one assignment is the whole interface");
  assert.equal(detailName("/a/b/graph.html"), "graph.detail.js", "the name is derived from the page's");
  assert.equal(detailName("preview.htm"), "preview.detail.js");
});

test("writePage puts both files in one directory and says where", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "graphpage-"));
  const written = writePage(graph(), path.join(dir, "graph.html"));
  assert.equal(written.detail, path.join(dir, "graph.detail.js"));
  assert.ok(written.bytes > 0 && written.detailBytes > written.bytes / 2, "the detail file is the bigger half");
  assert.match(readFileSync(written.file, "utf8"), /"graph\.detail\.js"/, "the page asks for the name it was given");
  assert.match(readFileSync(written.detail, "utf8"), /__GRAPH_DETAIL__/, "and the detail file defines it");
});

test("a page copied without its detail file still draws, and names what is missing", { skip }, async () => {
  const { win, els, scripts } = mount(graph(), { detail: null });
  win.__select("event:5300090");
  assert.ok(win.__graphState().nodes.length > 1, "the graph draws without the detail file");
  win.__openNode("event:5300090");
  assert.equal(scripts.length, 1, "the page asks for the detail file, once");
  assert.equal(scripts[0].src, "graph.detail.js", "with the name the page was given");
  scripts[0].onerror(); // the browser found no such file
  const html = els.get("modal-body").innerHTML;
  assert.match(html, /没有找到 graph\.detail\.js/, "the panel names the missing file");
  assert.doesNotMatch(html, /<h3>描述<\/h3>/, "and does not pretend to have the text");
  assert.match(html, /<h3>结果<\/h3>/, "the structure is still there");
  win.__openNode("event:5300090");
  assert.equal(scripts.length, 1, "a second open does not ask again");
  assert.match(els.get("modal-body").innerHTML, /没有找到 graph\.detail\.js/, "and still says so");
});

// ---------------------------------------------------------------- what a page may ask for
// The page is opened from disk as often as from the editor's server, and under file:// every
// fetch() is a CORS failure printed into the panel. So the detail file travels by script tag,
// and nothing on the panel path asks for anything else.
test("the detail file arrives as a script tag, never as a request", { skip }, () => {
  const html = renderPage(graph());
  const start = html.indexOf("function ensureDetail");
  const end = html.indexOf("document.head.appendChild");
  assert.ok(start > 0 && end > start, "the loader is in the page");
  const loader = html.slice(start, end);
  assert.doesNotMatch(loader, /fetch\(|XMLHttpRequest|import\(/, "no request is made for the detail file");
  assert.match(loader, /createElement\("script"\)/, "the page builds a script element");
  assert.match(loader, /tag\.src = DETAIL_URL/, "and points it at the detail file");
  assert.match(loader, /tag\.onerror/, "a file that is not there has its own path");
  assert.match(html, /const DETAIL_URL = "graph\.detail\.js"/, "the name is the file beside the page");
});

test("a page opened from disk fetches nothing, and says where the file can be read", { skip }, async () => {
  const { win, els, fetched } = mount(graph(), { protocol: "file:" });
  win.__openNode("event:5300090");
  await tick();
  assert.deepEqual(fetched, [], "a file:// page has no server to ask");
  const right = els.get("srcpane").innerHTML;
  assert.match(right, /node tools\/editor\.mjs/, "it names the thing that can read the file");
  assert.doesNotMatch(right, /Failed to fetch/, "and not the browser's CORS error");
  assert.match(els.get("modal-body").innerHTML, /<h3>描述<\/h3>/, "the panel's text still arrives, from graph.detail.js");
});
