#!/usr/bin/env node
/**
 * card-page test — the per-card page and the values it carries.
 *
 *   node --test script/card-page.test.mjs
 *
 * The page has three jobs, and each one fails silently when it breaks:
 *
 *   1. it is the card page tools/page.mjs renders, so it reuses `tools/html.mjs` CSS and the
 *      same wrapper and row classes instead of inventing a second look;
 *   2. its controls follow the field shape — an enum is a `<select>`, a tag name is a text
 *      input with a live matching list — and every row prints the raw key next to its Chinese
 *      label from schema/field-labels.json;
 *   3. its values round-trip through the JSON block the app save writes, without ever letting
 *      a value close the block or reach the network.
 *
 * The wrapper and its manifest get the same checks `script/editor-tool.test.mjs` applies to
 * `editors/sudan_cards`: the app discovers it, it loads one external script, and the generated
 * pages work inside it because they carry that same script verbatim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";
import { CSS, esc } from "../tools/html.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import {
  applyCardValues,
  cardPageHtml,
  pendingValues,
  readPageValues,
  writePageValues,
} from "../tools/cardpage.mjs";

const FIELDS = JSON.parse(readFileSync(path.join(REPO, "schema/fields.json"), "utf8"));
const LABELS = JSON.parse(readFileSync(path.join(REPO, "schema/field-labels.json"), "utf8"));
const TOOL_DIR = path.join(REPO, "editors/sudan_card_page");

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

test("the page is the shared page shell, not a second look", () => {
  const html = page();
  assert.ok(html.includes(CSS), "the page reuses tools/html.mjs CSS byte for byte");
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
  assert.match(html, /<input type="text" data-tag-add list="tag-name-options"/);
  const list = /<datalist id="tag-name-options">([\s\S]*?)<\/datalist>/.exec(html);
  assert.ok(list, "the datalist is what filters as the player types");
  const names = [...list[1].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(names.length >= 400, `the whole of tag.json is offered, got ${names.length}`);
  assert.ok(names.includes("体魄"), "a stat tag is there");
  assert.match(list[1], /data-kind="stat"/);
  assert.match(list[1], /data-kind="marker"/);
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
    assert.ok(label, `${key} has a label in schema/field-labels.json`);
    assert.ok(row.html.includes(esc(label.label)), `${key}: the Chinese label is next to the key`);
    assert.ok(row.html.includes(esc(label.note)), `${key}: the note is the dim text under the control`);
  }
  const tags = rows.find((item) => item.key === "tag");
  assert.match(tags.html, /data-tag-add/, "the tag row carries the live matching input");
  assert.match(html, /id="tag-markers"/, "the marker table is on the page");
  assert.match(html, /id="tag-stats"/, "and so is the stat table");
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
  const files = [
    path.join(REPO, "tools/cardpage.mjs"),
    path.join(REPO, "tools/preview.mjs"),
    path.join(TOOL_DIR, "card-bridge.js"),
    path.join(TOOL_DIR, "index.html"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${path.basename(file)}: the editor frame has no network`);
    assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|EventSource/, `${path.basename(file)}: no network call`);
    assert.doesNotMatch(text, /https?:\/\//, `${path.basename(file)}: no URL`);
  }
  assert.doesNotMatch(pageHtml, /\bfetch\s*\(/);
  assert.doesNotMatch(pageHtml, /https?:\/\//);

  assert.match(pageHtml, /"editor:readFile"/);
  assert.match(pageHtml, /"editor:save"/);
  assert.match(pageHtml, /noHost\.hidden = true/, "a host hides the read-only line");
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
  assert.match(wrapper, /<script src="card-bridge\.js"><\/script>/, "an external script: the CSP forbids inline ones");
  assert.match(wrapper, /id="card-host"/, "the wrapper has a place for the card page");
  assert.match(wrapper, /id="card-save"/);

  const bridge = readFileSync(path.join(TOOL_DIR, "card-bridge.js"), "utf8");
  assert.match(bridge, /"editor:readFile"/);
  assert.match(bridge, /"editor:save"/);
  assert.match(bridge, /DOMParser/, "the wrapper mounts the page it read");
  assert.ok(page().includes(bridge.trimEnd()), "each generated page embeds the bridge verbatim");
});
