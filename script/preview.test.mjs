/**
 * tools/preview.mjs is one command an agent runs inside a mod directory. These tests run it
 * the way the agent does: a throwaway mod in a temp directory, the real CLI, and the files it
 * leaves behind. The story graph is written by its own tool, and the card table gets no page at
 * all — the app's editor tool edits it — so a green run here also says the preview pointed the
 * player at that tool instead of writing a page that could only be read.
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

test("a mod of only cards writes no card page, and the index sends the player to the app editor", () => {
  const dir = mod({ "config/cards.json": { 9000001: CARD } });
  // No usable --vanilla: a cards-only preview must not need the game's config, because the app
  // opens the card file and nothing here draws the story.
  const r = run(["--mod", dir, "--vanilla", path.join(tmpdir(), "no-such-vanilla")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = path.join(dir, ".preview");
  assert.equal(existsSync(path.join(out, "cards.html")), false, "a read-only page could only be looked at");
  assert.equal(existsSync(path.join(out, "graph.html")), false, "a mod with no story record gets no story graph");
  const index = read(path.join(out, "index.html"));
  assert.match(index, /config\/cards\.json/, "the index names the file to open in the app");
  assert.match(index, /苏丹的卡牌编辑器/, "and the editor tool the app opens it with");
  assert.match(index, /data-record="card:9000001"/, "the card is still a row");
  assert.doesNotMatch(index, /cards\.html/, "nothing links a page that was not written");
  assert.match(r.stdout, /no page is written/, "the run says what it did instead of writing a page");
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
  assert.match(cardRow, /config\/cards\.json/, "the card row says where a card is edited");
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
