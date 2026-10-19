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
  const document = {
    getElementById: (id) => {
      // A textarea read back through `.value` is how the save button gets its text, so the
      // shim has to turn the markup the page wrote into that value, the way a browser does.
      if (!els.has(id)) {
        els.set(
          id,
          el(id, (html) => {
            const m = html.match(/<textarea id="ed"[^>]*>([\s\S]*?)<\/textarea>/);
            if (!m) return;
            if (!els.has("ed")) els.set("ed", el("ed"));
            els.get("ed").value = decode(m[1]);
          })
        );
      }
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

test("the panel names a node, then says what it says", { skip }, () => {
  const { win, els } = mount(graph());
  win.__openNode("event:5300090");
  const html = els.get("modal-body").innerHTML;
  assert.match(html, /<div class="node-title">浴场移除提示<\/div>/, "an event's name is its note");
  assert.match(html, /<h3>描述<\/h3>/, "the narration follows, under its own heading");
  assert.match(html, /浴场暂时关闭/, "and the narration itself is there");
  // The four-language table is gone: one language is on screen at a time.
  assert.doesNotMatch(html, /table class="names"/);
});

test("the editor splits: what it says now beside the file it says it in", { skip }, async () => {
  const { win, els, posts } = mount(graph());
  await win.__openEditor("card:2000001");
  const html = els.get("modal-body").innerHTML;
  assert.match(html, /class="editsplit"/, "two columns");
  assert.match(html, /<div class="node-title">阿尔图<\/div>/, "left is the read view");
  assert.match(html, /<h3>描述<\/h3>/, "including the description");
  assert.match(html, /<textarea id="ed"/, "right is the source");
  assert.match(html, /&quot;id&quot;: 2000001/, "the record itself, not a re-typed copy");
  els.get("save").onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1, "one click, one save");
  assert.equal(posts[0].key, "card:2000001");
  assert.match(posts[0].source, /2000001/, "the save carries the textarea's text");
});

test("a read-only page offers no edit button", { skip }, () => {
  const { win, els } = mount(graph(), { editable: false });
  win.__openNode("rite:5008014");
  const html = els.get("modal-body").innerHTML;
  assert.doesNotMatch(html, /id="editbtn"/);
  assert.match(html, /只读：启动时没带 --mod/);
});
