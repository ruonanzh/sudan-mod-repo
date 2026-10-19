/**
 * The page is one big script string, so the only honest way to test it is to run it. This
 * file runs the real script against a small DOM shim and reads what it puts in the nodes:
 * the read panel, the split editor, and the body a save posts. Nothing here re-implements
 * the view, so a change to the view is visible here or nowhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import { buildGraph } from "./graph.mjs";
import { renderPage } from "./graphpage.mjs";
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

/** Run the page script and hand back the window plus the elements it wrote to. */
function mount(g, { editable = true } = {}) {
  const els = new Map();
  // A textarea read back through `.value` is how the save button gets its text, so the shim
  // turns the markup the page wrote into that value, the way a browser does.
  const syncText = (html) => {
    const m = html.match(/<textarea id="ed"[^>]*>([\s\S]*?)<\/textarea>/);
    if (!m) return;
    if (!els.has("ed")) els.set("ed", el("ed"));
    els.get("ed").value = decode(m[1]);
  };
  const document = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, el(id, syncText));
      return els.get(id);
    },
    onkeydown: null,
  };
  const win = {};
  const mod = openMod(mkdtempSync(path.join(tmpdir(), "page-")), { vanilla: VANILLA });
  const posts = [];
  const fetch = async (url, opts) => {
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
  const script = renderPage(g, { editable }).match(/<script>([\s\S]*)<\/script>/)[1];
  new Function("document", "window", "location", "requestAnimationFrame", "fetch", script)(
    document,
    win,
    { protocol: "http:" },
    (fn) => { if (fn) fn(); return 0; },
    fetch
  );
  return { win, els, document, posts };
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
