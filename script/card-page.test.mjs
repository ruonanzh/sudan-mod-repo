#!/usr/bin/env node
/**
 * card-page test — the per-card page and the values it carries.
 *
 *   node --test script/card-page.test.mjs
 *
 * The page has three jobs, and each one fails silently when it breaks:
 *
 *   1. it is the card page editors/page/page.mjs renders, so it reuses `editors/lib/shell.mjs` CSS and
 *      the same wrapper and row classes instead of inventing a second look;
 *   2. its controls follow the field shape — an enum is a `<select>`, a marker tag is a
 *      checkbox, a stat tag a number input, and a new tag name is picked from a live matching
 *      list — and every row prints the raw key next to its Chinese label from
 *      schema/view/field-labels.json;
 *   3. its values round-trip through the JSON block the app save writes, without ever letting
 *      a value close the block or reach the network.
 *
 * `editors/card` is the app editor tool: the app discovers it from `.editor.tool.json`, serves
 * the directory in a sandboxed iframe, and the generated pages work inside it because they
 * carry the tool's own `bridge.js` verbatim. The manifest, the single external script and the
 * bridge messages are asserted here, so the promise survives the tree moving.
 *
 * The tag tables are what a player edits, so these tests run the real `bridge.js` over the
 * generated markup with a stand-in root instead of a browser: what the controls collect is what
 * the page saves.
 *
 * The two notify buttons are the page's only way to reach the agent, and each one is a message:
 * `/card-edited <page path>` for the values, `/card-art-edited <page path>` plus the prompt the
 * player typed for the picture. Both go out as `editor:sendPrompt`, so what the app receives is
 * asserted here, together with the gate that keeps them off when the page has no host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./lib/fixture.mjs";
import { composeSubject } from "../tools/art.mjs";
import { CSS, esc } from "../editors/lib/shell.mjs";
import { recordPageHtml } from "../editors/page/page.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import {
  applyCardValues,
  cardPageHtml,
  pendingValues,
  readPageValues,
  writePageValues,
} from "../editors/card/page.mjs";

const FIELDS = JSON.parse(readFileSync(path.join(REPO, "schema/fields.json"), "utf8"));
const LABELS = JSON.parse(readFileSync(path.join(REPO, "schema/view/field-labels.json"), "utf8"));
const TAG_ROLES = JSON.parse(readFileSync(path.join(REPO, "schema/view/tag-roles.json"), "utf8"));
const TOOL_DIR = path.join(REPO, "editors/card");

/** What the page says about a tag name `tag.json` does not carry yet. */
const UNKNOWN_TAG_NOTE = "这个标签还没有。agent 会为你在 `tag.json` 里新建一条。";

/** One record with every kind of card field: enums, text, numbers, lists, tags, objects. */
const CARD = {
  id: 9000001,
  name: "测试卡",
  title: "副标题",
  text: "说明文字",
  pops: [],
  type: "char",
  rare: 2,
  resource: ["cards/9000001"],
  tag: { 体魄: 3, 男性: 1, 不在原版标签: 2 },
  card_vanishing: 0,
  vanish: { over: 13 },
  equips: ["武器", "饰品"],
  is_only: 1,
  sfx: "cat",
  post_rite: [],
};

/** A throwaway mod root: the page only reads `image/cards/<id>.png` from it, and there is none. */
const MOD_DIR = mkdtempSync(path.join(tmpdir(), "card-page-"));
writeFileSync(
  path.join(MOD_DIR, "info.json"),
  JSON.stringify({ name: "card page probe", description: "d", tags: ["Utilities"], version: "1.0.0" }),
);

const page = (record = CARD, previous = null) =>
  cardPageHtml({ id: String(record.id), record, modDir: MOD_DIR, previous });

/**
 * Every `<div class="row" data-key="…">` on the page, with its own markup. The row nests two
 * divs, so the end is found by counting `<div` and `</div>` from the row's start.
 */
function rowsOf(html) {
  const out = [];
  const start = /<div class="row" data-key="([^"]+)">/g;
  let match;
  while ((match = start.exec(html))) {
    let depth = 0;
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = match.index;
    let tag;
    while ((tag = tags.exec(html))) {
      depth += tag[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        out.push({ key: match[1], html: html.slice(match.index, tag.index + 6) });
        break;
      }
    }
  }
  return out;
}

/** One tag table's markup: from its `id` to the `</table>` that closes it. */
function tableOf(html, id) {
  return html.slice(html.indexOf(`id="${id}"`), html.indexOf("</table>", html.indexOf(`id="${id}"`)));
}

/** The app's `match` rule: `*` stops at `/`, `**` crosses directories. */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// ---------------------------------------------------------------- the bridge, without a browser

/** `type="checkbox" checked` → the attributes the markup carries; a bare name reads as "". */
function attrsOf(text) {
  const attrs = new Map();
  for (const match of String(text).matchAll(/([A-Za-z][\w-]*)(?:="([^"]*)")?/g)) {
    attrs.set(match[1], match[2] === undefined ? "" : match[2]);
  }
  return attrs;
}

/**
 * One element as the bridge reads it: the attributes the generator wrote, the value a browser
 * would report, and the four methods the bridge calls. `type` and `checked` are plain
 * properties on purpose — the bridge assigns them when it builds a row.
 */
function elementOf(tagName, attrs, value) {
  const map = attrsOf(attrs);
  const element = {
    tagName: tagName.toUpperCase(),
    type: map.get("type") || (tagName === "select" ? "select-one" : "text"),
    value,
    checked: map.has("checked"),
    multiple: false,
    children: [],
    listeners: {},
    getAttribute: (name) => (map.has(name) ? map.get(name) : null),
    setAttribute: (name, shown) => map.set(name, String(shown)),
    addEventListener: (type, handler) => (element.listeners[type] ||= []).push(handler),
    appendChild: (child) => element.children.push(child),
  };
  return element;
}

/** Every input, select and textarea the page carries, in document order. */
function controlsOf(html) {
  const parts = [
    ...[...html.matchAll(/<input\b([^>]*)>/gi)].map((m) => ({ at: m.index, tag: "input", attrs: m[1], inner: "" })),
    ...[...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].map((m) => ({ at: m.index, tag: "select", attrs: m[1], inner: m[2] })),
    ...[...html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)].map((m) => ({ at: m.index, tag: "textarea", attrs: m[1], inner: m[2] })),
  ].sort((a, b) => a.at - b.at);

  return parts.map((part) => {
    if (part.tag === "textarea") return elementOf("textarea", part.attrs, part.inner);
    if (part.tag === "select") {
      const options = [...part.inner.matchAll(/<option\b([^>]*)>/g)].map((m) => attrsOf(m[1]));
      const chosen = options.find((option) => option.has("selected")) || options[0];
      return elementOf("select", part.attrs, chosen ? chosen.get("value") ?? "" : "");
    }
    const attrs = attrsOf(part.attrs);
    return elementOf("input", part.attrs, attrs.has("value") ? attrs.get("value") : "");
  });
}

/** A `<datalist>` as the bridge reads it: `options[i].value` and each option's attributes. */
function datalistOf(html, id) {
  const block = new RegExp(`<datalist id="${id}">([\\s\\S]*?)</datalist>`).exec(html);
  if (!block) return null;
  return {
    options: [...block[1].matchAll(/<option\b([^>]*)>/g)].map((m) => {
      const attrs = attrsOf(m[1]);
      return elementOf("option", m[1], attrs.get("value") ?? "");
    }),
  };
}

/**
 * Run the real `bridge.js` over the page's own markup. No browser: the root answers the
 * selectors the bridge walks, the two tables collect the rows it appends, and the document hands
 * out that root, the value block, the datalists, the two notify buttons and the status lines.
 * `posts` is what the bridge sent the app; `deliver` is the app answering.
 */
function bridgeOf(html) {
  const controls = controlsOf(html);
  /** A row the bridge builds joins the page, so the next collect reads it like a browser would. */
  const adopt = (node) => {
    if (node.getAttribute && node.getAttribute("data-tag-level") !== null) controls.push(node);
    for (const child of node.children || []) adopt(child);
  };

  const tables = new Map();
  for (const id of ["#tag-markers", "#tag-stats"]) {
    const body = {
      rows: [],
      querySelector: () => null,
      removeChild: () => {},
      appendChild: (row) => {
        body.rows.push(row);
        adopt(row);
      },
    };
    tables.set(id, { id, tBodies: [body] });
  }

  const find = (selector) => {
    if (tables.has(selector)) return [tables.get(selector)];
    const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    return name ? controls.filter((element) => element.getAttribute(name) !== null) : [];
  };
  const attrs = new Map();
  const root = {
    handlers: {},
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name, shown) => attrs.set(name, String(shown)),
    addEventListener: (type, handler) => (root.handlers[type] ||= []).push(handler),
    querySelectorAll: find,
    querySelector: (selector) => find(selector)[0] || null,
  };

  /** An element the bridge reaches by id: a button it disables and clicks, or a status line. */
  const byIdElement = () => ({
    disabled: false,
    textContent: "",
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
  });
  const buttons = { "card-notify-agent": byIdElement(), "card-art-notify": byIdElement() };
  const statuses = { "card-notify-status": byIdElement(), "card-art-status": byIdElement() };

  const status = { textContent: "", setAttribute: () => {} };
  const block = /<script type="application\/json" id="card-values">([\s\S]*?)<\/script>/.exec(html);
  const document = {
    readyState: "complete",
    getElementById(id) {
      if (id === "card-values") return block ? { textContent: block[1] } : null;
      if (id === "card-status") return status;
      if (id === "tag-name-options" || id === "tag-stat-options") return datalistOf(html, id);
      if (id in buttons) return buttons[id];
      if (id in statuses) return statuses[id];
      return null;
    },
    querySelector: (selector) => (selector === "[data-card-page]" || selector === "[data-record-page]" ? root : null),
    createElement: (tagName) => elementOf(tagName, "", ""),
    addEventListener: () => {},
  };
  /** What the frame posted to the app, in order. */
  const posts = [];
  const listeners = [];
  const window = {
    parent: { postMessage: (message) => posts.push({ ...message }) },
    addEventListener: (type, handler) => {
      if (type === "message") listeners.push(handler);
    },
  };
  vm.runInNewContext(readFileSync(path.join(TOOL_DIR, "bridge.js"), "utf8"), {
    window,
    document,
    setTimeout: () => {},
  });

  /** One message the app would post into the frame. */
  const deliver = (data) => listeners.forEach((handler) => handler({ data }));
  /** Answer the newest request that has no answer yet, the way the app answers it. */
  const answer = (data) => {
    const last = posts.at(-1);
    deliver({ ...data, requestId: last?.requestId });
  };
  /** Press one of the two notify buttons. */
  const click = (id) => (buttons[id].listeners.click || []).forEach((handler) => handler());
  /** What the player typed into 画面, as the bridge reads it. */
  const promptField = () => root.querySelector("[data-art-prompt]");

  /** The one control that edits this tag, found the way the page shows it. */
  const controlOf = (name) =>
    root.querySelectorAll("[data-tag-level]").find((element) => element.getAttribute("data-tag-level") === name);
  /** Type into an add box and fire the handler the page wires for it. */
  const pick = (kind, name) => {
    const input = root.querySelectorAll("[data-tag-add]").find((element) => element.getAttribute("data-tag-add") === kind);
    input.value = name;
    input.listeners.change.forEach((handler) => handler());
  };

  return {
    bridge: window.cardPageBridge,
    root,
    tables,
    status,
    controlOf,
    pick,
    posts,
    buttons,
    statuses,
    deliver,
    answer,
    click,
    promptField,
  };
}

/** Every file under a directory, recursively: the network check must cover the whole editor tree. */
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** Let the promise chains a request hands back run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the page is the shared page shell, not a second look", () => {
  const html = page();
  assert.ok(html.includes(CSS), "the page reuses editors/lib/shell.mjs CSS byte for byte");
  assert.match(html, /<div class="wrap" data-card-page="9000001">/, "the same .wrap, marked with its card");
  assert.match(html, /<h2>卡面<\/h2>/);
  assert.match(html, /class="panel"/);
  assert.match(html, /class="split"/);
  assert.match(html, /class="grow"/);
  assert.match(html, /<div class="cardface">/, "no art: the placeholder the card page already uses");
  assert.match(html, /472 × 1028/);
  assert.match(html, /id="card-no-host"/, "the page carries the read-only line");
  assert.match(html, /这些值只能在 app 里保存/);
});

test("an enum and a small range render a select", () => {
  const html = page();
  const type = /<select data-field="type"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(type, "type is a select");
  for (const value of ["char", "item", "sudan"]) assert.match(type[1], new RegExp(`value="${value}"`));

  const rare = /<select data-field="rare"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(rare, "rare is a select");
  for (const value of ["1", "2", "3", "4"]) assert.match(rare[1], new RegExp(`value="${value}"`));
  assert.match(rare[1], /4 · 金/);

  // A slot repeats (three 饰品 is three slots), so it is a list input and not a select.
  assert.match(html, /data-field="equips"[^>]*data-array="1"/);
});

test("a many-option field renders a text input with a live matching list", () => {
  const html = page();
  assert.match(html, /<input id="tag-add-marker" type="text" data-tag-add="marker" list="tag-name-options"/);
  const list = /<datalist id="tag-name-options">([\s\S]*?)<\/datalist>/.exec(html);
  assert.ok(list, "the datalist is what filters as the player types");
  const names = [...list[1].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(names.length >= 400, `the whole of tag.json is offered, got ${names.length}`);
  assert.ok(names.includes("体魄"), "a stat tag is there");
  assert.match(list[1], /data-kind="stat"/);
  assert.match(list[1], /data-kind="marker"/);

  // 加属性 offers the stat names only, so its list is short enough to read.
  assert.match(html, /<input id="tag-add-stat" type="text" data-tag-add="stat" list="tag-stat-options"/);
  const stats = /<datalist id="tag-stat-options">([\s\S]*?)<\/datalist>/.exec(html);
  assert.ok(stats, "the stat table has its own list");
  const statNames = [...stats[1].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(statNames, Object.keys(TAG_ROLES.stat), "every stat name, and nothing else");
  assert.match(stats[1], new RegExp(`value="体魄" data-kind="stat"`));
});

test("every visible row shows its raw key and its Chinese label", () => {
  const html = page();
  const rows = rowsOf(html);
  assert.ok(rows.length >= 10, `expected the record's rows, got ${rows.length}`);
  const live = FIELDS.card.fields.filter((key) => key in CARD && key !== "post_rite");
  for (const key of live) {
    const row = rows.find((item) => item.key === key);
    assert.ok(row, `${key} has a row`);
    assert.ok(row.html.includes(`<code>${key}</code>`), `${key}: the raw key is in code style`);
    const label = LABELS.card[key];
    assert.ok(label, `${key} has a label in schema/view/field-labels.json`);
    assert.ok(row.html.includes(esc(label.label)), `${key}: the Chinese label is next to the key`);
    assert.ok(row.html.includes(esc(label.note)), `${key}: the note is the dim text under the control`);
  }
  const tags = rows.find((item) => item.key === "tag");
  assert.doesNotMatch(tags.html, /<input|<select/, "the tag row is read-only: the tables below own the controls");
  assert.match(html, /id="tag-markers"/, "the marker table is on the page");
  assert.match(html, /id="tag-stats"/, "and so is the stat table");
});

test("a marker tag is a checkbox, and a stat tag a number input with its vanilla range", () => {
  const html = page();
  const marker = /<input[^>]*data-tag-level="男性"[^>]*>/.exec(html);
  assert.ok(marker, "男性 has a control");
  assert.match(marker[0], /type="checkbox"/, "a marker is present or absent, so it is a box");
  assert.match(marker[0], /\schecked/, "the row exists only while the card carries the tag, so it is checked");
  assert.match(marker[0], /value="1"/, "and its value is 1, the only level the game writes");

  const stat = /<input[^>]*data-tag-level="体魄"[^>]*>/.exec(html);
  assert.ok(stat, "体魄 has a control");
  assert.match(stat[0], /type="number"/);
  assert.match(stat[0], /value="3"/);
  // The vanilla range is advice: the input must not clamp a value outside it.
  assert.doesNotMatch(stat[0], /\bmin="/);
  assert.doesNotMatch(stat[0], /\bmax="/);
  assert.ok(html.includes("原版范围"), "the range column is still there as advice");
  assert.match(html, new RegExp(`${TAG_ROLES.stat.体魄.min} … ${TAG_ROLES.stat.体魄.max}`), "the range is printed too");

  assert.doesNotMatch(html, /data-tag-row="主角"/, "a tag the card does not carry has no row at all");
});

test("the tag row summarises the tags, so it cannot say 「no tags」 over a full table", () => {
  const tagged = { ...CARD, tag: { 体魄: 3, 魅力: 2, 男性: 1 } };
  const html = page(tagged);
  const summary = /id="tag-summary">([^<]*)</.exec(html);
  assert.ok(summary, "the tag row carries a summary");
  assert.equal(summary[1], "体魄 3、魅力 2、男性 1", "all three tags are named with their values");

  const rowsIn = (id) => [...tableOf(html, id).matchAll(/<tr data-tag-row="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rowsIn("tag-markers"), ["男性"], "the marker table carries the marker");
  assert.deepEqual(rowsIn("tag-stats"), ["体魄", "魅力"], "the stat table carries both stats");
  assert.match(tableOf(html, "tag-stats"), /data-tag-level="魅力"[^>]*value="2"/, "and the number the summary shows");

  // A card with no tags says so in both places, rather than an empty box beside two empty tables.
  const bare = page({ ...CARD, tag: {} });
  assert.match(bare, /id="tag-summary">没有标签</);
  assert.match(bare, /class="empty">没有标记/);
  assert.match(bare, /class="empty">没有属性/);
});

test("the controls compose the tag object the page saves", () => {
  const html = page();
  const { bridge, root, controlOf } = bridgeOf(html);
  /** The bridge runs in its own realm, so spread what it returns back into this one. */
  const tagsOf = () => ({ ...bridge.collect(root).tag });
  const savedTag = (values) => readPageValues(writePageValues(html, "9000001", values)).values.tag;

  assert.deepEqual(tagsOf(), { 体魄: 3, 男性: 1, 不在原版标签: 2 }, "the controls are what the page shows");

  controlOf("男性").checked = false;
  const withoutMarker = bridge.collect(root);
  assert.deepEqual({ ...withoutMarker.tag }, { 体魄: 3, 不在原版标签: 2 }, "an unchecked marker leaves the tag map");
  assert.deepEqual(savedTag(withoutMarker), { 体魄: 3, 不在原版标签: 2 }, "and the saved block drops the key");

  controlOf("体魄").value = "5";
  const edited = bridge.collect(root);
  assert.equal(edited.tag.体魄, 5, "a stat carries the number typed");
  assert.equal(savedTag(edited).体魄, 5, "the saved block carries it too");
  assert.equal(savedTag(edited).男性, undefined, "and the marker stays removed");
});

test("picking a name from a datalist adds a row to that table", () => {
  const html = page();
  const { bridge, root, tables, status, pick } = bridgeOf(html);
  const rowsIn = (id) => tables.get(id).tBodies[0].rows;

  pick("marker", "主角");
  assert.equal(rowsIn("#tag-markers").length, 1, "the row lands in the marker table");
  assert.equal(rowsIn("#tag-markers")[0].getAttribute("data-tag-row"), "主角");
  assert.equal(bridge.collect(root).tag.主角, 1, "a picked marker is present, so it is 1");

  pick("stat", "魅力");
  assert.equal(rowsIn("#tag-stats")[0].getAttribute("data-tag-row"), "魅力");
  const built = rowsIn("#tag-stats")[0].children[1].children[0];
  // The range advises, it does not clamp; the row must not carry min/max attributes.
  assert.equal(built.getAttribute("min"), null, "the new row must not clamp to the vanilla range");
  assert.equal(built.getAttribute("max"), null);

  // 加标记 offers every name in tag.json, so a stat typed there must not become a marker.
  pick("marker", "智慧");
  assert.equal(rowsIn("#tag-markers").length, 1, "a stat does not become a marker");
  assert.match(status.textContent, /加属性/, "the page says which table to use");

  // A name tag.json does carry needs no explanation: only an unknown one is marked.
  assert.equal(rowsIn("#tag-markers")[0].children[0].children.length, 1, "a known marker gets no warning");
  assert.equal(rowsIn("#tag-stats")[0].children[0].children.length, 1, "a known stat gets no warning");

  // The same rule the other way: a marker typed into 加属性 points at 加标记.
  pick("stat", "贵族");
  assert.equal(rowsIn("#tag-stats").length, 1, "a marker does not become a stat");
  assert.match(status.textContent, /加标记/, "the page says which table to use");
});

test("a name tag.json does not carry is a 标记 row that says to build the tag", () => {
  const UNKNOWN = "测试新标签";
  const html = page({ ...CARD, tag: { 体魄: 3, 男性: 1, 测试新标签: 1 } });

  const markers = tableOf(html, "tag-markers");
  const rowsIn = (table) => [...table.matchAll(/<tr data-tag-row="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rowsIn(markers), ["男性", "测试新标签"], "the unknown name is a row like any marker");
  assert.ok(
    markers.includes(`data-tag-warning="${UNKNOWN}">${UNKNOWN_TAG_NOTE}</div>`),
    "the row says what is missing, in the page's red note style",
  );
  assert.match(markers, /1 或不存在/, "a known marker keeps the range read off the vanilla uses");
  assert.match(markers, /待建标签后确定/, "the unknown name's range waits for the tag to be built");

  const box = /<input[^>]*data-tag-level="测试新标签"[^>]*>/.exec(html)[0];
  assert.match(box, /type="checkbox"/, "a name with no range is present or absent, so it is a box");
  assert.match(box, /\schecked/, "the row exists only while the card carries the tag, so it is checked");
  assert.match(box, /value="1"/, "and it carries the level the card stores");
  const two = /<input[^>]*data-tag-level="测试新标签"[^>]*>/.exec(page({ ...CARD, tag: { 测试新标签: 2 } }))[0];
  assert.match(two, /value="2"/, "a level the card wrote is what the box keeps");

  assert.doesNotMatch(tableOf(html, "tag-stats"), new RegExp(`data-tag-level="${UNKNOWN}"`), "it is not a stat row");
  assert.match(html, /id="tag-summary">体魄 3、男性 1、测试新标签 1</, "the summary still names it");

  const { bridge, root, controlOf } = bridgeOf(html);
  assert.equal(bridge.collect(root).tag.测试新标签, 1, "the box's state is what the page saves");
  controlOf(UNKNOWN).checked = false;
  assert.equal(bridge.collect(root).tag.测试新标签, undefined, "unchecking it removes the tag, like any marker");
});

test("adding a name tag.json does not carry saves it, applies it, and re-renders the same row", () => {
  const record = { ...CARD, tag: { 体魄: 3, 男性: 1 } };
  const html = page(record);
  const { bridge, root, tables, status, pick } = bridgeOf(html);
  const rowsIn = (id) => tables.get(id).tBodies[0].rows;

  pick("marker", "新标记甲");
  pick("stat", "新属性乙");
  assert.deepEqual(
    rowsIn("#tag-markers").map((row) => row.getAttribute("data-tag-row")),
    ["新标记甲", "新属性乙"],
    "a name tag.json does not carry goes to 标记, whichever box it was typed into",
  );
  assert.equal(rowsIn("#tag-stats").length, 0, "nothing lands in 数值");
  for (const row of rowsIn("#tag-markers")) {
    assert.equal(row.children[0].children[1].textContent, UNKNOWN_TAG_NOTE, "the row says the name has to be built");
    assert.equal(row.children[1].children[0].type, "checkbox", "there is no number to type for it yet");
    assert.equal(row.children[2].textContent, "待建标签后确定", "and no range to print");
  }
  assert.doesNotMatch(status.textContent, /没有这个标签名/, "an unknown name is never refused");
  assert.equal(bridge.collect(root).tag.新标记甲, 1, "a checked box is present, so it is 1");
  assert.equal(bridge.collect(root).tag.新属性乙, 1);

  const values = readPageValues(writePageValues(html, "9000001", bridge.collect(root))).values;
  assert.equal(values.tag.新标记甲, 1, "the saved block keeps the name instead of dropping it");
  assert.equal(values.tag.新属性乙, 1, "and the one typed into 加属性 with it");
  const diff = pendingValues(record, values);
  assert.deepEqual(diff.fields.tag, { 新标记甲: 1, 新属性乙: 1 }, "apply writes both, so lint can report them");
  assert.deepEqual(diff.removedTags, [], "and neither is read as a removal");

  // Regenerating the page from that block prints the same rows, so a reload loses nothing.
  const regenerated = page({ ...record, tag: values.tag });
  assert.match(regenerated, /<tr data-tag-row="新标记甲">/);
  assert.match(regenerated, /<tr data-tag-row="新属性乙">/);
  assert.ok(
    regenerated.includes(`data-tag-warning="新标记甲">${UNKNOWN_TAG_NOTE}</div>`),
    "the regenerated row says it too",
  );
  assert.doesNotMatch(tableOf(regenerated, "tag-stats"), /新属性乙|待建标签后确定/, "both rows are markers again");
});

test("the value block round-trips, and a value cannot close it", () => {
  const html = page();
  const block = readPageValues(html);
  assert.equal(block.id, "9000001");
  assert.equal(block.values.name, "测试卡");
  assert.deepEqual(block.values.tag, CARD.tag);
  assert.deepEqual(block.values.resource, CARD.resource);

  const edited = writePageValues(html, block.id, { ...block.values, name: "新名字" });
  assert.equal(readPageValues(edited).values.name, "新名字");
  assert.deepEqual(readPageValues(edited).values.tag, CARD.tag);

  const blockAt = edited.lastIndexOf('id="card-values"');
  assert.ok(blockAt > edited.lastIndexOf("window.cardPageBridge"), "the block follows the bridge script");
  assert.ok(edited.lastIndexOf("</body>") > blockAt, "and sits at the end of the body");

  const evil = writePageValues(html, block.id, { ...block.values, text: "</script><b>x</b>" });
  assert.ok(evil.includes("\\u003c/script>"), "a closing tag in a value is escaped");
  assert.equal(readPageValues(evil).values.text, "</script><b>x</b>");
});

test("a page that already carries values keeps them, and says they are pending", () => {
  const html = page(CARD, { id: "9000001", values: { name: "待写", tag: { 体魄: 9 } } });
  assert.match(html, /value="待写"/, "the pending name is what the control shows");
  assert.equal(readPageValues(html).values.name, "待写");
  assert.deepEqual(readPageValues(html).values.tag, { 体魄: 9 });
  assert.match(html, /id="card-pending"/);
  assert.match(html, /这些值还没写回/);
});

test("only the values that differ are pending, and strings compare as the page reads them", () => {
  const values = { name: "测试卡", rare: "2", tag: { 体魄: "3", 男性: 1, 不在原版标签: 2 } };
  assert.deepEqual(pendingValues(CARD, values), { fields: {}, removedTags: [] }, "no edit is not an edit");

  const diff = pendingValues(CARD, { ...values, rare: 3, tag: { 体魄: 5 } });
  assert.deepEqual(diff.fields, { rare: 3, tag: { 体魄: 5 } }, "only the moved values are named");
  assert.deepEqual(diff.removedTags, ["男性", "不在原版标签"], "a tag the page dropped is a removal");

  const text = '{\n  "9000001": { "id": 9000001, "tag": { "体魄": 1 } }\n}\n';
  const out = applyCardValues(text, [{ id: "9000001", fields: { tag: { 魅力: 2 } }, removedTags: ["体魄"] }]);
  assert.equal(out.written, 2);
  const doc = parseDoc(out.text);
  assert.deepEqual(toPlain(doc, doc.root), { 9000001: { id: 9000001, tag: { 魅力: 2 } } });
});

test("the page and the tool only reach the host over the message bridge", () => {
  const pageHtml = page();
  // Scanned: the card page, the shell and the record page it reuses, and the preview command.
  // Not scanned: `editors/graph/` (the graph page and its vendored builds) and `editors/editor/`
  // (the local server). Those are the other half — they talk to that server over
  // `fetch("/api/...")`, which this assertion would misread as a network call.
  const notCardPage = (file) =>
    file.includes(`${path.sep}.preview${path.sep}`) ||
    file.includes(`${path.sep}graph${path.sep}`) ||
    file.includes(`${path.sep}editor${path.sep}`);
  const files = [
    ...filesUnder(path.join(REPO, "editors")).filter((f) => !notCardPage(f)),
    path.join(REPO, "tools/preview.mjs"),
  ];
  assert.ok(files.length > 0, "the editor tree is not empty");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${path.relative(REPO, file)}: the editor frame has no network`);
    assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|EventSource/, `${path.relative(REPO, file)}: no network call`);
    assert.doesNotMatch(text, /https?:\/\//, `${path.relative(REPO, file)}: no URL`);
  }
  assert.doesNotMatch(pageHtml, /\bfetch\s*\(/);
  assert.doesNotMatch(pageHtml, /https?:\/\//);

  assert.match(pageHtml, /"editor:readFile"/);
  assert.match(pageHtml, /"editor:save"/);
  assert.match(pageHtml, /"editor:sendPrompt"/);
  assert.match(pageHtml, /noHost\.hidden = true/, "a host hides the read-only line");
});

// ---------------------------------------------------------------- the two agent buttons

const PROMPTS = path.join(REPO, ".pi/prompts");
const PAGE_PATH = "your_mods/card_demo/.preview/9000001.card.html";

/** The app opening this page for editing: the one init that turns the two buttons on. */
const hostInit = (writable = true) => ({
  type: "editor:init",
  mode: "edit",
  writable,
  file: { path: PAGE_PATH, name: "9000001.card.html" },
});

/** The prompt the app opened this page for: what a player typed is the art prompt of the record. */
const COMPOSED = composeSubject(CARD);

/** The `画面` section of the page: from its heading to the next one. */
function artSection(html) {
  const start = html.indexOf("画面 · 这张图画成什么");
  assert.ok(start > 0, "the page carries the 画面 section");
  return html.slice(start, html.indexOf("<h2>", start));
}

test("the page carries the art prompt and its button; sending the values lives in the wrapper", () => {
  const html = page();
  const section = artSection(html);
  assert.doesNotMatch(html, /card-notify-agent/, "values are sent from the wrapper's toolbar, not the page");
  assert.match(section, /<label class="art-lbl" for="card-art-prompt">卡面图的提示词<\/label>/, "the prompt is labelled");
  assert.match(section, /<button class="exp" id="card-art-notify" type="button" disabled>修改卡面图，通知 agent<\/button>/);
  const field = /<textarea id="card-art-prompt"[^>]*>([\s\S]*?)<\/textarea>/.exec(section);
  assert.ok(field, "the prompt is a textarea, so the player can rewrite it");
  assert.equal(field[1], esc(COMPOSED), "prefilled with the sentence this record composes");
});

test("the wrapper's send button saves the page and then asks the app for /card-edited", () => {
  const bridge = readFileSync(path.join(TOOL_DIR, "bridge.js"), "utf8");
  const body = bridge.slice(bridge.indexOf("function sendToAgent"), bridge.indexOf("/* ---------- the host ---------- */"));
  assert.match(body, /save\(\)\.then/, "the values go to disk first");
  assert.match(body, /notifyAgent\(\s*commandFor\("\/card-edited"\)/, "then the session is asked to apply them");
  assert.match(bridge, /byId\("card-send"\)/, "the wrapper's button is wired to it");
  assert.doesNotMatch(bridge, /ctrlKey \) && event\.key\.toLowerCase\(\) === "s"/, "no Ctrl+S shortcut");
});

test("「修改卡面图，通知 agent」 sends the prompt the player typed into 画面", async () => {
  const { posts, statuses, deliver, click, promptField } = bridgeOf(page());
  deliver(hostInit());

  promptField().value = "一把断成两截的长剑，插在雪里";
  click("card-art-notify");
  const sent = posts.filter((message) => message.type === "editor:sendPrompt").at(-1);
  assert.equal(
    sent.text,
    `/card-art-edited ${PAGE_PATH}\n卡面图的提示词：「一把断成两截的长剑，插在雪里」`,
    "the command names the page, and the line under it is what the player typed",
  );
  assert.equal(posts.some((message) => message.type === "editor:save"), false, "the button writes nothing");

  deliver({ type: "editor:sent", requestId: sent.requestId });
  await tick();
  assert.match(statuses["card-art-status"].textContent, /修改卡面图/);

  // Nothing typed is not a picture: say so instead of sending a command with no subject in it.
  promptField().value = "   ";
  click("card-art-notify");
  assert.equal(posts.filter((message) => message.type === "editor:sendPrompt").length, 1, "an empty prompt is not sent");
  assert.match(statuses["card-art-status"].textContent, /卡面图的提示词/);
});

test("the typed art prompt survives a save and a regeneration", async () => {
  const html = page();
  const block = readPageValues(html);
  assert.equal(block.artPrompt, COMPOSED, "the block starts from the composed sentence");

  // A save writes what the player typed, not the sentence the record composes.
  const { bridge, posts, deliver, promptField } = bridgeOf(html);
  deliver(hostInit());
  deliver({ type: "editor:fileContent", requestId: posts.filter((m) => m.type === "editor:readFile").at(-1).requestId, data: html, revision: "r1" });
  await tick();
  promptField().value = "一把断成两截的长剑，插在雪里";
  bridge.save();
  const saved = posts.filter((message) => message.type === "editor:save").at(-1);
  assert.ok(saved, "the page posted its own text");
  assert.equal(readPageValues(saved.data).artPrompt, "一把断成两截的长剑，插在雪里");
  assert.deepEqual(readPageValues(saved.data).values, block.values, "the prompt is stored beside the values, not inside them");

  // Regenerating from that block keeps the typed sentence, so a layout refresh loses nothing.
  const regenerated = page(CARD, readPageValues(saved.data));
  const field = /<textarea id="card-art-prompt"[^>]*>([\s\S]*?)<\/textarea>/.exec(artSection(regenerated));
  assert.equal(field[1], "一把断成两截的长剑，插在雪里", "the new page shows the typed prompt");

  // A page written before the prompt existed falls back to what the record composes.
  const older = cardPageHtml({
    id: "9000001",
    record: CARD,
    modDir: MOD_DIR,
    previous: { id: "9000001", values: block.values },
  });
  assert.equal(
    /<textarea id="card-art-prompt"[^>]*>([\s\S]*?)<\/textarea>/.exec(artSection(older))[1],
    esc(COMPOSED),
    "no stored prompt: the composed sentence is the default",
  );

  // Writing values without naming a prompt keeps the prompt the page already carries.
  assert.equal(readPageValues(writePageValues(html, block.id, block.values)).artPrompt, COMPOSED);
});

test("without a host both buttons are off, and the page says why", () => {
  const disk = bridgeOf(page());
  assert.equal(disk.buttons["card-art-notify"].disabled, true, "opened from disk: no app to send through");
  assert.match(page(), /两个按钮也用不了/, "the read-only line explains it");

  // The app refuses a message for a file it refuses to write, so the button must be off too.
  const outside = bridgeOf(page());
  outside.deliver(hostInit(false));
  assert.equal(outside.buttons["card-art-notify"].disabled, true);

  const inside = bridgeOf(page());
  inside.deliver(hostInit(true));
  assert.equal(inside.buttons["card-art-notify"].disabled, false, "a writable page in the app can notify");
});

/** A prompt template's frontmatter: the `key: value` lines between the first pair of `---`. */
function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "a prompt template starts with frontmatter");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    // A quoted value is YAML syntax, not part of the value.
    const value = line.slice(at + 1).trim().replace(/^"(.*)"$/, "$1");
    fields[line.slice(0, at).trim()] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

test("each button's command has a prompt template, and the template names the tools to run", () => {
  const bridge = readFileSync(path.join(TOOL_DIR, "bridge.js"), "utf8");
  const expected = [
    ["card-edited", ["tools/preview.mjs", "--collect", "--apply", "config/tag.json"]],
    ["card-art-edited", ["tools/art.mjs", "image/cards/"]],
  ];
  for (const [command, needles] of expected) {
    assert.ok(bridge.includes(`"/${command}"`), `${command}: the bridge sends it`);
    const file = path.join(PROMPTS, `${command}.md`);
    assert.ok(existsSync(file), `${command}: .pi/prompts/${command}.md answers it`);

    const { fields, body } = frontmatterOf(readFileSync(file, "utf8"));
    assert.match(fields.description || "", /[\u4e00-\u9fff]/, `${command}: the command list shows a Chinese description`);
    assert.equal(fields["argument-hint"], "[卡页路径]", `${command}: the argument is the card page path`);
    assert.ok(body.includes("${1:-"), `${command}: the page path arrives as the first argument`);
    assert.match(body, /[\u4e00-\u9fff]/, `${command}: written in Chinese, per script/prompt-standard.md`);
    for (const needle of needles) assert.ok(body.includes(needle), `${command}: names ${needle}`);
  }
});

test("the manifest is what the app discovers, and it matches a generated card page", () => {
  const manifest = JSON.parse(readFileSync(path.join(TOOL_DIR, ".editor.tool.json"), "utf8"));
  assert.equal(manifest.apiVersion, 1, "the app skips a manifest whose apiVersion is not 1");
  assert.equal(manifest.id, path.basename(TOOL_DIR));
  assert.equal(manifest.mode, "edit");
  assert.equal(manifest.entry, "index.html");
  assert.ok(existsSync(path.join(TOOL_DIR, manifest.entry)));
  assert.match(manifest.name, /[\u4e00-\u9fff]/, "the name is what the player reads in the app");
  assert.match(manifest.description || "", /[\u4e00-\u9fff]/);

  const re = globToRegExp(manifest.match[0]);
  assert.ok(re.test("your_mods/SomeMod/.preview/9000001.card.html"), "it matches a card page");
  assert.ok(!re.test("your_mods/SomeMod/config/cards.json"), "it does not match the card table");
  assert.ok(!re.test("your_mods/SomeMod/.preview/9000001.card.html.bak"), "it matches the page itself");
});

test("the wrapper loads one external script, and the page carries that same script", () => {
  const wrapper = readFileSync(path.join(TOOL_DIR, "index.html"), "utf8");
  assert.equal((wrapper.match(/<script/g) || []).length, 1, "one script tag");
  assert.match(wrapper, /<script src="bridge\.js"><\/script>/, "an external script: the CSP forbids inline ones");
  assert.match(wrapper, /id="card-host"/, "the wrapper has a place for the card page");
  assert.match(wrapper, /<header id="bar"><\/header>/, "the header is built by the one script");
  assert.doesNotMatch(wrapper, /id="card-save"/, "no separate save button");

  const bridge = readFileSync(path.join(TOOL_DIR, "bridge.js"), "utf8");
  assert.match(bridge, /"editor:readFile"/);
  assert.match(bridge, /"editor:save"/);
  assert.match(bridge, /DOMParser/, "the wrapper mounts the page it read");
  assert.match(bridge, /id="card-send"/, "the shared header carries the send action");
  assert.match(bridge, /id="card-reload"/, "and the reload action");
  assert.ok(page().includes(bridge.trimEnd()), "each generated page embeds the bridge verbatim");
});

test("the text a player reads carries no internal jargon", () => {
  // Scripts and styles stay in the file (the page needs them) but a player never reads them.
  const visible = page()
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const word of ["--apply", "--collect", "LEGACY_FIELD", "validate_mod", "install_mod", "create_mod_folder"]) {
    assert.equal(visible.includes(word), false, `the player's page must not mention ${word}`);
  }
});

test("a record page carries a plain-language box instead of fields", () => {
  const html = recordPageHtml({
    kind: "event",
    id: 9900102,
    record: { id: 9900102, text: "长刃回响", on: { round_begin_ba: 3 } },
    modDir: "/tmp/mod",
  });
  assert.match(html, /data-record-prompt/, "the box the player types into");
  assert.match(html, /id="record-notify"/, "and the button that sends it");
  assert.match(html, /用平时的话说就行/, "the page says plain words are enough");
});

test("a record page sends /record-edited with the sentence the player typed", () => {
  const bridge = readFileSync(path.join(TOOL_DIR, "bridge.js"), "utf8");
  assert.match(bridge, /byId\("record-notify"\)/, "the page's button is wired");
  assert.match(bridge, /commandFor\("\/record-edited"\)/, "the command names the record page");
  assert.match(bridge, /要改的地方：「/, "the sentence travels under a label the agent can find");
});
