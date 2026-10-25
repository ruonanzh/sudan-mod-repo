/**
 * tools/preview.mjs is one command an agent runs inside a mod directory. These tests run it
 * the way the agent does: a throwaway mod in a temp directory, the real CLI, and the files it
 * leaves behind. Card pages carry their values in their own JSON block, so the collect/apply
 * tests edit that block the way the app save would and then run the real CLI against it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { modRecords } from "../tools/preview.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import { readPageValues, writePageValues } from "../editors/card/page.mjs";
import { tmpdir } from "node:os";
import { PREVIEW, VANILLA, skip, read, run, mod, CARD, eventAt, SAMPLE_CARDS, cardMod, cardPageFile, editPage } from "./lib/preview-fixture.mjs";

/** The fixture lives in script/lib/preview-fixture.mjs. */

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
  assert.equal(existsSync(path.join(out, "index.html")), false, "there is no list page to open as source");
  assert.match(r.stdout, /2 page\(s\)/, "the run says how many pages it wrote");
  assert.match(r.stdout, /9000001\.card\.html/, "and names each page, so the agent can pass the paths on");
  assert.match(r.stdout, /9000002\.card\.html/);
});
