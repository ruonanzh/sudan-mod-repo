/**
 * tools/preview.mjs is one command an agent runs inside a mod directory. These tests run it
 * the way the agent does: a throwaway mod in a temp directory, the real CLI, and the files it
 * leaves behind. Card pages carry their values in their own JSON block, so the collect/apply
 * tests edit that block the way the app save would and then run the real CLI against it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_VANILLA } from "../tools/model.mjs";
import { modRecords } from "../tools/preview.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import { readPageValues, writePageValues } from "../tools/cardpage.mjs";

const PREVIEW = fileURLToPath(new URL("../tools/preview.mjs", import.meta.url));
const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, os.homedir());
const skip = existsSync(VANILLA) ? false : "the game's config is not installed on this machine";

/** A mod with an info.json and the files given: relative path -> record object or text. */
function mod(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-"));
  writeFileSync(
    path.join(dir, "info.json"),
    JSON.stringify({ name: "Preview probe", description: "", tags: [], version: "1.0.0" })
  );
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const run = (args) => spawnSync(process.execPath, [PREVIEW, ...args], { encoding: "utf8" });
const read = (file) => readFileSync(file, "utf8");
const CARD = { id: 9000001, name: "测试卡", is_reversed: 0, type: 1, rare: 1 };
const eventAt = (id, text) => ({ id, text, is_replay: 0, on: { rite_end: 5000002 }, condition: {}, settlement: [] });

test("what a mod carries is read from the layout the rest of the repo reads", () => {
  const dir = mod({
    "config/cards.json": { 9000001: CARD, _comment: "a comment key is not a record" },
    "config/event/9000002.json": eventAt(9000002, "事件"),
    "config/tag.json": { 9000003: { code: "probe" } },
    "config/game.json": { name: "probe" },
    "config/event/notes.txt": "not a record: the layout says .json",
  });
  assert.deepEqual(
    modRecords(dir).map((r) => `${r.kind}:${r.id}`).sort(),
    ["card:9000001", "event:9000002", "game:game", "tag:9000003"],
    "table keys, directory file names and single files, and nothing else"
  );
});

test("a mod with no records passes and writes no empty page", () => {
  const dir = mod();
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS {2}no records/, "it says there is nothing to preview");
  assert.equal(existsSync(path.join(dir, ".preview")), false, "and does not create a directory to hold nothing");
  assert.equal(r.stdout.includes("FAIL"), false);
});

test("a mod of only cards writes one page per card, and the index links them", () => {
  const dir = mod({ "config/cards.json": { 9000001: CARD, 9000002: { ...CARD, id: 9000002, name: "第二张" } } });
  // No usable --vanilla: a cards-only preview must not need the game's config, because a card
  // page is built from the mod's own table and nothing here draws the story.
  const r = run(["--mod", dir, "--vanilla", path.join(tmpdir(), "no-such-vanilla")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = path.join(dir, ".preview");
  assert.ok(existsSync(path.join(out, "9000001.card.html")), "one page per card, named by its id");
  assert.ok(existsSync(path.join(out, "9000002.card.html")));
  assert.equal(existsSync(path.join(out, "cards.html")), false, "no page for the whole table");
  assert.equal(existsSync(path.join(out, "graph.html")), false, "a mod with no story record gets no story graph");
  const index = read(path.join(out, "index.html"));
  assert.match(index, /href="9000001\.card\.html"/, "the index links the first card page");
  assert.match(index, /href="9000002\.card\.html"/);
  assert.match(index, /苏丹的卡牌编辑器/, "the whole-table editor is still named as an option");
  assert.match(index, /--apply/, "and the index says how values get back into cards.json");
  assert.match(r.stdout, /2 card page\(s\)/, "the run says how many pages it wrote");
});

test("a mod of only events gets one story graph that opens on the record named by --focus", { skip }, () => {
  const dir = mod({ "config/event/9000001.json": eventAt(9000001, "新事件") });
  const r = run(["--mod", dir, "--focus", "event:9000001"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = path.join(dir, ".preview");
  const page = read(path.join(out, "graph.html"));
  assert.match(page, /\["mod", "mod", modCount\]/, "the filter row carries the mod button");
  assert.match(page, /"defaultCat":"mod"/, "and it is the filter the page opens with");
  assert.match(page, /"focus":"event:9000001"/, "the page opens on the record preview was asked for");
  assert.match(page, /"mod":true/, "the mod's record is flagged in the payload");
  assert.equal(existsSync(path.join(out, "cards.html")), false, "no card page for a mod with no cards");
  assert.match(read(path.join(out, "index.html")), /graph\.html/, "the index links the story graph");
});

test("the index lists every record the mod carries, one row each", { skip }, () => {
  const dir = mod({
    "config/cards.json": { 9000001: CARD },
    "config/event/9000001.json": eventAt(9000001, "事件一"),
    "config/event/9000002.json": eventAt(9000002, "事件二"),
    "config/rite/9000003.json": { id: 9000003, name: "测试仪式", cards_slot: [] },
  });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const index = read(path.join(dir, ".preview", "index.html"));
  assert.equal((index.match(/data-record="[^"]+"/g) || []).length, 4, "one row per record, cards and story records alike");
  for (const key of ["card:9000001", "event:9000001", "event:9000002", "rite:9000003"]) {
    assert.ok(index.includes(`data-record="${key}"`), `the index names ${key}`);
  }
  assert.match(index, /graph\.html/, "story rows link the story graph");
  const cardRow = index.split("\n").find((line) => line.includes('data-record="card:9000001"'));
  assert.match(cardRow, /9000001\.card\.html/, "the card row links its own page");
  assert.doesNotMatch(index, /cards\.html/, "no record links a card page");
});

test("--out decides where the pages land, and the default directory is left alone", { skip }, () => {
  const dir = mod({ "config/event/9000001.json": eventAt(9000001, "新事件") });
  const out = path.join(mkdtempSync(path.join(tmpdir(), "preview-out-")), "pages");
  const r = run(["--mod", dir, "--out", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(path.join(out, "index.html")), true);
  assert.equal(existsSync(path.join(out, "graph.html")), true);
  assert.equal(existsSync(path.join(dir, ".preview")), false);
});

test("--focus must name a record the mod carries, and a typo writes nothing", { skip }, () => {
  const dir = mod({ "config/event/9000001.json": eventAt(9000001, "新事件") });
  const r = run(["--mod", dir, "--focus", "event:5300090"]);
  assert.equal(r.status, 1, "a focus the mod does not carry is caught before any page is written");
  assert.match(r.stdout, /^FAIL {2}focus event:5300090/, "and named");
  assert.equal(existsSync(path.join(dir, ".preview")), false);
});

/** A cards.json with a BOM, a comment, a trailing comma, an unknown key and two cards. */
const SAMPLE_CARDS =
  "\ufeff{\n" +
  "  // 卡表：一个 id 一张卡\n" +
  '  "9000001": {\n' +
  '    "id": 9000001,\n' +
  '    "name": "旧名字",\n' +
  '    "type": "char",\n' +
  '    "rare": 1,\n' +
  '    "tag": { "体魄": 1, "装备": 1 },\n' +
  '    "text": "说明",\n' +
  '    "future_key": true,\n' +
  "  },\n" +
  '  "9000002": { "id": 9000002, "name": "另一张", "type": "char", "rare": 2, "tag": { "战斗": 3 } }\n' +
  "}\n";

/** A mod whose two cards have pages; the pages are what collect and apply read. */
function cardMod() {
  const dir = mod({ "config/cards.json": SAMPLE_CARDS });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return dir;
}

const cardPageFile = (dir, id = "9000001") => path.join(dir, ".preview", `${id}.card.html`);

/** What the app save does: replace the page's own value block. */
function editPage(dir, change, remove = []) {
  const file = cardPageFile(dir);
  const html = read(file);
  const block = readPageValues(html);
  const values = { ...block.values, ...change };
  for (const key of remove) delete values[key];
  writeFileSync(file, writePageValues(html, block.id, values));
}

test("--collect prints only the values that differ from cards.json", () => {
  const dir = cardMod();
  editPage(dir, { name: "新名字", rare: 3 });
  const r = run(["--mod", dir, "--collect"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /9000001 {2}name {2}"旧名字" -> "新名字"/);
  assert.match(r.stdout, /9000001 {2}rare {2}1 -> 3/);
  assert.doesNotMatch(r.stdout, /9000002/, "a page with no edit is not listed");
  assert.match(r.stdout, /--apply/, "the report says how to write the values back");
});

test("--apply writes only the changed values; comments, order and trailing commas survive", () => {
  const dir = cardMod();
  const file = path.join(dir, "config/cards.json");
  const before = read(file);
  editPage(dir, { name: "新名字", rare: 3, tag: { 体魄: 5, 装备: 1 } });

  const r = run(["--mod", dir, "--apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = read(file);

  assert.ok(after.startsWith("\ufeff"), "the BOM survives");
  assert.ok(after.includes("// 卡表：一个 id 一张卡"), "the comment survives");
  assert.ok(after.includes('"future_key": true,'), "an unknown key survives, trailing comma included");
  assert.ok(
    after.includes(
      '"9000002": { "id": 9000002, "name": "另一张", "type": "char", "rare": 2, "tag": { "战斗": 3 } }',
    ),
    "the untouched card is left byte for byte",
  );

  const doc = parseDoc(after);
  const cards = toPlain(doc, doc.root);
  assert.equal(cards["9000001"].name, "新名字");
  assert.equal(cards["9000001"].rare, 3);
  assert.deepEqual(cards["9000001"].tag, { 体魄: 5, 装备: 1 }, "only the tag that changed moves");
  assert.deepEqual(
    Object.keys(cards["9000001"]),
    ["id", "name", "type", "rare", "tag", "text", "future_key"],
    "key order is the file's",
  );

  const reverted = after
    .replace('"name": "新名字"', '"name": "旧名字"')
    .replace('"rare": 3', '"rare": 1')
    .replace('"体魄": 5', '"体魄": 1');
  assert.equal(reverted, before, "every byte that did not change is the byte the file already had");
});

test("--apply warns when a changed page no longer carries a field the record has", () => {
  const dir = cardMod();
  editPage(dir, { name: "新名字" }, ["text"]);
  const r = run(["--mod", dir, "--apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WARN {2}9000001 {2}the page does not carry "text"/);
  assert.match(r.stdout, /whole-entry replace would drop it/);
  const doc = parseDoc(read(path.join(dir, "config/cards.json")));
  assert.equal(toPlain(doc, doc.root)["9000001"].text, "说明", "apply is per key, so the field stays");
});

test("regenerating a page keeps the values it already carries and says they are pending", () => {
  const dir = cardMod();
  editPage(dir, { name: "还没写回", rare: 4 });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const html = read(cardPageFile(dir));
  const block = readPageValues(html);
  assert.equal(block.values.name, "还没写回", "the pending name survived the layout refresh");
  assert.equal(block.values.rare, 4);
  assert.match(html, /id="card-pending"/);
  assert.match(html, /这些值还没写回/);
});

test("--apply with nothing pending leaves cards.json byte for byte", () => {
  const dir = cardMod();
  const file = path.join(dir, "config/cards.json");
  const before = read(file);
  const r = run(["--mod", dir, "--apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no card page carries a value different/);
  assert.equal(read(file), before);
});

test("--collect before any page exists says so and writes nothing", () => {
  const dir = mod({ "config/cards.json": SAMPLE_CARDS });
  const r = run(["--mod", dir, "--collect"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no card pages/);
  assert.equal(existsSync(path.join(dir, ".preview")), false);
});
