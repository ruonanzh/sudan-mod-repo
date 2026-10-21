/**
 * tools/preview.mjs is one command an agent runs inside a mod directory. These tests run it
 * the way the agent does: a throwaway mod in a temp directory, the real CLI, and the files it
 * leaves behind. The card page and the story graph are written by their own tools, so a green
 * run here also says those two CLIs still write what their own tests say they do.
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

test("a mod of only cards gets a card page, and the index links it and nothing else", { skip }, () => {
  const dir = mod({ "config/cards.json": { 9000001: CARD } });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = path.join(dir, ".preview");
  assert.equal(existsSync(path.join(out, "cards.html")), true, "the card page is where the index will look");
  assert.equal(existsSync(path.join(out, "graph.html")), false, "a mod with no story record gets no story graph");
  const index = read(path.join(out, "index.html"));
  assert.match(index, /cards\.html/, "the index links the card page");
  assert.doesNotMatch(index, /graph\.html/, "and not a page that was not written");
  assert.match(read(path.join(out, "cards.html")), /"defaultCat":"mod"/, "the card page opens on the mod's own records");
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
  assert.match(index, /cards\.html/, "card rows link the card page");
  assert.match(index, /graph\.html/, "story rows link the story graph");
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
