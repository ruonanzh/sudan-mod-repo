/**
 * editors/sudan_cards is an app editor tool: the app discovers it from `.editor.tool.json`, serves
 * the directory in a sandboxed iframe and lets it read and save the one file it matched. Nothing
 * in this repo runs the page, so these tests check the three things that go wrong silently:
 *
 *   1. the manifest the app reads is well formed, and its `match` points at the card table;
 *   2. the page talks over the bridge only — no `fetch`, no URL to reach;
 *   3. a save edits the original text at the values that changed, so comments, key order,
 *      trailing commas, a BOM and the keys the page does not edit all survive.
 *
 * The rules the page validates with are copies of `schema/fields.json` and `schema/tag-roles.json`
 * (the iframe may load files only from its own directory, so it cannot import the repo's copies at
 * run time). The last two tests are the promise that the copies do not drift, and that the parser
 * the page uses is byte for byte `tools/jsonc.mjs`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import { applyCardChanges, changesBetween, readCards } from "../editors/sudan_cards/cards-doc.js";
import { CARD_FIELDS, CARD_LEGACY, CARD_TYPES, RARE_MIN, RARE_MAX, TAG_STAT, TAG_MARKER, validateCard } from "../editors/sudan_cards/card-rules.js";

const DIR = path.join(REPO, "editors/sudan_cards");
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, ".editor.tool.json"), "utf8"));
const LAYOUT = JSON.parse(readFileSync(path.join(REPO, "schema/layout.json"), "utf8"));
const NODE_FIELDS = JSON.parse(readFileSync(path.join(REPO, "schema/fields.json"), "utf8"));
const TAG_ROLES = JSON.parse(readFileSync(path.join(REPO, "schema/tag-roles.json"), "utf8"));

/**
 * The app's `match` rule (`pi-desktop src/shared/editor-match.ts`): a pattern with `/` matches the
 * workspace-relative path, `*` stops at `/`, `**` crosses directories.
 */
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

test("the manifest is what the app discovers, and it matches the card table", () => {
  assert.equal(MANIFEST.apiVersion, 1, "the app skips a manifest whose apiVersion is not 1");
  assert.equal(MANIFEST.id, path.basename(DIR), "an id that differs from the directory only confuses a reader");
  assert.match(MANIFEST.id, /^[a-z][a-z0-9_]*$/, "the app drops an id outside this shape");
  assert.equal(MANIFEST.mode, "edit", "the page saves, so the app must open it writable");
  assert.ok(MANIFEST.name.trim().length > 0);
  assert.match(MANIFEST.name, /[\u4e00-\u9fff]/, "the name is what the player reads in the app; this repo's UI text is Chinese");
  assert.match(MANIFEST.description || "", /[\u4e00-\u9fff]/, "same for the description");

  const entry = path.join(DIR, MANIFEST.entry);
  assert.equal(MANIFEST.entry, "index.html");
  assert.ok(existsSync(entry), `${MANIFEST.entry} must exist, or the app refuses to serve the tool`);

  assert.ok(Array.isArray(MANIFEST.match) && MANIFEST.match.length > 0);
  const cardTable = LAYOUT.table.card.file;
  for (const pattern of MANIFEST.match) {
    assert.ok(pattern.startsWith("your_mods/"), `${pattern}: mods live under your_mods/`);
    const fixed = pattern.replace(/\*/g, "").replace(/\/+/g, "/");
    assert.ok(
      fixed.endsWith(`/${cardTable}`) || cardTable.endsWith(fixed.replace(/^your_mods\/?/, "/")),
      `${pattern} must name the card table the layout puts at ${cardTable}`
    );
    const re = globToRegExp(pattern);
    assert.ok(re.test(`your_mods/SomeMod/${cardTable}`), `${pattern} must match a mod's card table`);
    assert.ok(!re.test(`your_mods/SomeMod/nested/${cardTable}`), `${pattern}: one * is one path segment`);
    assert.ok(!re.test(cardTable), `${pattern} must not match the game's own file outside your_mods/`);
  }
});

test("the page reaches the host over the bridge only", () => {
  for (const name of readdirSync(DIR)) {
    const file = path.join(DIR, name);
    if (!name.endsWith(".js") && !name.endsWith(".html")) continue;
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${name}: the CSP has connect-src 'none', so a fetch fails silently`);
    assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|EventSource/, `${name}: no network call of any kind`);
    assert.doesNotMatch(text, /https?:\/\//, `${name}: the page must not reference a URL`);
  }

  const editor = readFileSync(path.join(DIR, "editor.js"), "utf8");
  assert.match(editor, /"editor:readFile"/, "reading goes through the bridge verb");
  assert.match(editor, /"editor:save"/, "saving too");
  assert.doesNotMatch(editor, /files\.(read|write)/, "the page never calls the backend itself");

  const html = readFileSync(path.join(DIR, "index.html"), "utf8");
  assert.equal((html.match(/<script/g) || []).length, 1, "one script tag");
  assert.match(html, /<script type="module" src="editor\.js"><\/script>/, "an external module: the CSP forbids inline scripts");
});

test("the page parses JSONC with the repo's own parser, not a second copy", () => {
  const copy = readFileSync(path.join(DIR, "jsonc.js"), "utf8");
  const source = readFileSync(path.join(REPO, "tools/jsonc.mjs"), "utf8");
  assert.equal(copy, source, "editors/sudan_cards/jsonc.js must stay a byte-for-byte copy of tools/jsonc.mjs");
});

test("the rules inlined in the page are the schema's rules", () => {
  assert.deepEqual(CARD_FIELDS, NODE_FIELDS.card.fields, "the card key set comes from schema/fields.json");
  assert.deepEqual(CARD_LEGACY, NODE_FIELDS.card.legacy);
  assert.deepEqual(CARD_TYPES, ["char", "item", "sudan"], "CARD_TYPE in tools/lint.mjs accepts exactly these");
  assert.deepEqual([RARE_MIN, RARE_MAX], [1, 4], "CARD_RARE in tools/lint.mjs");
  const stat = Object.fromEntries(Object.entries(TAG_ROLES.stat).map(([name, row]) => [name, { min: row.min, max: row.max }]));
  assert.deepEqual(TAG_STAT, stat, "schema/tag-roles.json stat ranges");
  assert.deepEqual([...TAG_MARKER].sort(), Object.keys(TAG_ROLES.marker).sort(), "schema/tag-roles.json marker names");
});

/** A cards.json with a BOM, comments, trailing commas, an unknown key and two cards. */
const SAMPLE =
  "\ufeff{\n" +
  "  // 卡表：一个 id 一张卡\n" +
  '  "_comment": "这不是一张卡",\n' +
  '  "9000001": {\n' +
  '    "id": 9000001,\n' +
  '    "name": "旧名字",\n' +
  '    "type": "item",\n' +
  '    "rare": 1,\n' +
  '    "tag": { "体魄": 1, "装备": 1 },\n' +
  '    "text": "说明",\n' +
  '    "future_key": true,\n' +
  "  },\n" +
  '  "9000002": { "id": 9000002, "name": "另一张", "type": "char", "rare": 2, "tag": { "战斗": 3 } }\n' +
  "}\n";

/** Write the sample to a throwaway directory, then hand back the text the app would read. */
function sampleOnDisk() {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-tool-"));
  const file = path.join(dir, "cards.json");
  writeFileSync(file, SAMPLE);
  return readFileSync(file, "utf8");
}

test("a save edits the values that changed and nothing else", () => {
  const original = sampleOnDisk();
  const next = applyCardChanges(original, [{ id: "9000001", fields: { name: "新名字", rare: 3, tag: { 体魄: 5 } } }]);

  assert.ok(next.startsWith("\ufeff"), "the BOM survives");
  assert.ok(next.includes("// 卡表：一个 id 一张卡"), "the comment survives");
  assert.ok(next.includes('"future_key": true,'), "an unknown key survives, trailing comma included");
  assert.ok(
    next.includes('"9000002": { "id": 9000002, "name": "另一张", "type": "char", "rare": 2, "tag": { "战斗": 3 } }'),
    "an untouched card is left exactly as written"
  );

  const parsed = parseDoc(next);
  const out = toPlain(parsed, parsed.root);
  assert.equal(out["9000001"].name, "新名字");
  assert.equal(out["9000001"].rare, 3);
  assert.deepEqual(out["9000001"].tag, { 体魄: 5, 装备: 1 }, "only the tag that changed moves");
  assert.equal(out["9000002"].name, "另一张");
  assert.deepEqual(Object.keys(out["9000001"]), ["id", "name", "type", "rare", "tag", "text", "future_key"], "key order is the file's");

  const reverted = next
    .replace('"name": "新名字"', '"name": "旧名字"')
    .replace('"rare": 3', '"rare": 1')
    .replace('"体魄": 5', '"体魄": 1');
  assert.equal(reverted, original, "every other byte is the byte the file already had");
});

test("a save with nothing changed rewrites nothing", () => {
  const original = sampleOnDisk();
  assert.equal(applyCardChanges(original, []), original);
  assert.equal(applyCardChanges(original, [{ id: "9000001", fields: { name: "旧名字", rare: 1, tag: { 体魄: 1 } } }]), original);
  assert.equal(
    applyCardChanges(original, [{ id: "9000099", fields: { name: "没有这张卡" } }]),
    original,
    "an id the file does not hold is not invented"
  );
});

test("the cards are read in file order, values decoded", () => {
  const original = sampleOnDisk();
  assert.deepEqual(
    readCards(original).map((card) => card.id),
    ["9000001", "9000002"],
    "a _-prefixed key is a comment, not a card"
  );
  assert.equal(readCards(original)[0].value.rare, 1);
  assert.deepEqual(readCards(original)[1].value.tag, { 战斗: 3 });
});

test("only a value the player changed becomes a change", () => {
  const original = sampleOnDisk();
  const loaded = readCards(original);
  assert.deepEqual(changesBetween(loaded, loaded), [], "opening a file is not an edit");
  assert.deepEqual(changesBetween(loaded, [{ id: "9000099", value: { name: "x" } }]), [], "an id the file does not hold is not a change");

  const stringy = [{ id: "9000001", value: { name: "旧名字", title: "", rare: "2", tag: { 体魄: "1" } } }];
  const shown = [{ id: "9000001", value: { name: "旧名字", title: "", rare: 2, tag: { 体魄: 1 } } }];
  assert.deepEqual(changesBetween(stringy, shown), [], "a rare written as text and shown as a number is the same card");

  const edited = loaded.map((card) =>
    card.id === "9000001" ? { id: card.id, value: { ...card.value, name: "新名字", tag: { ...card.value.tag, 体魄: 5 } } } : card
  );
  assert.deepEqual(changesBetween(loaded, edited), [{ id: "9000001", fields: { name: "新名字", tag: { 体魄: 5 } } }]);
});

test("validation is the card check the repo already applies", () => {
  const clean = { id: 9000001, name: "卡", type: "item", rare: 1, tag: { 体魄: 2, 装备: 1 }, text: "" };
  assert.deepEqual(validateCard("9000001", clean).errors, []);

  const unknown = validateCard("9000001", { ...clean, weird: 1 });
  assert.ok(unknown.errors.some((m) => m.includes("weird")), "an unknown key is a failure, as in lint's UNKNOWN_FIELD");

  const legacy = validateCard("9000001", { ...clean, tips: "" });
  assert.deepEqual(legacy.errors, [], "a legacy key is a warning in lint, so it does not block a save");
  assert.ok(legacy.warnings.some((m) => m.includes("tips")));

  for (const rare of [0, 5]) {
    assert.ok(validateCard("9000001", { ...clean, rare }).errors.length > 0, `rare ${rare} is outside 1..4`);
  }
  assert.ok(validateCard("9000001", { ...clean, type: "spell" }).errors.length > 0, "type is char, item or sudan");
  assert.ok(validateCard("9000001", { ...clean, tag: { 体魄: 100 } }).errors.length > 0, "99 is the top of 体魄's range");
  assert.deepEqual(validateCard("9000001", { ...clean, tag: { 体魄: -3 } }).errors, [], "-3 is inside 体魄's range");
  assert.ok(validateCard("9000001", { ...clean, tag: { 装备: 2 } }).errors.length > 0, "a marker tag is present or absent, so 1");
  assert.ok(validateCard("9000001", { ...clean, tag: { 没这个标签: 1 } }).warnings.length > 0, "an unknown tag name is TAG_UNKNOWN, a warning");
});

test("a file whose text does not parse is refused, with the parser's reason", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-tool-"));
  const file = path.join(dir, "cards.json");
  writeFileSync(file, '{ "9000001": { "name": "x" }');
  assert.throws(() => applyCardChanges(readFileSync(file, "utf8"), []), /expected|unexpected|unterminated/);
});
