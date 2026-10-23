#!/usr/bin/env node
/**
 * page-render test — every page kind renders a real record, in Chinese, and fails loudly.
 *
 *   node --test script/page-render.test.mjs
 *
 * Two directions, both needed:
 *
 * **Forward, on the game's own data.** Each of the ten kinds is rendered from a record copied
 * out of the installed game, not from a fixture we wrote. If the research and the page disagree,
 * vanilla is right and the page is wrong, so vanilla is what the test uses.
 *
 * **Backward, on broken input.** A page that quietly prints an English key, or quietly drops a
 * field it has no label for, looks fine and teaches the player nothing. So:
 *   - a record carrying a key the game does not read must be shown as such;
 *   - a label table missing one key must stop the page and name the key;
 *   - a `--spec` that is not JSON must fail before anything is written.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO } from "./lib/fixture.mjs";
import { DEFAULT_VANILLA } from "../tools/model.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";

const PAGE = path.join(REPO, "tools/page.mjs");
const VANILLA = DEFAULT_VANILLA.replace(/^~/, homedir());
const FIELDS = JSON.parse(readFileSync(path.join(REPO, "schema/fields.json"), "utf8"));
const LABELS = JSON.parse(readFileSync(path.join(REPO, "schema/view/field-labels.json"), "utf8"));

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A throwaway mod that carries one real record of the given kind, copied from the game. */
function modWithVanilla(kind, id) {
  const dir = mkdtempSync(path.join(tmpdir(), "sudan-render-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "vanilla", description: "d", tags: ["Utilities"], version: "1.0.0" }));
  const cfg = path.join(dir, "config");
  mkdirSync(cfg, { recursive: true });
  const tableFile = { card: "cards.json", quest: "quest.json", over: "over.json", upgrade: "upgrade.json", tag: "tag.json" }[kind];
  if (tableFile) {
    cpSync(path.join(VANILLA, tableFile), path.join(cfg, tableFile));
  } else {
    const sub = { event: "event", rite: "rite", loot: "loot", init: "init", afterStory: "after_story" }[kind];
    mkdirSync(path.join(cfg, sub), { recursive: true });
    cpSync(path.join(VANILLA, sub, `${id}.json`), path.join(cfg, sub, `${id}.json`));
  }
  return dir;
}

function page(args, stdin) {
  return spawnSync(process.execPath, [PAGE, ...args], { cwd: REPO, encoding: "utf8", input: stdin, timeout: 180000 });
}

/** Every `<div class="lbl">…</div>` in the page, i.e. the visible row labels. */
function rowLabels(html) {
  return [...html.matchAll(/class="lbl">([^<]*)</g)].map((m) => m[1].trim());
}

/** One real record per kind, read from the installed game. */
const CASES = [
  ["card", "2000001"],
  ["rite", "5008014"],
  ["event", "5300000"],
  ["loot", "6000004"],
  ["quest", "3300001"],
  ["over", "0"],
  ["afterStory", "2000001"],
  ["upgrade", "3300042"],
  ["tag", "physique"],
  ["init", "0"],
];

for (const [kind, id] of CASES) {
  test(`P-${kind}: a real vanilla record renders with Chinese labels`, (t) => {
    if (!existsSync(VANILLA)) return t.skip("the game is not installed on this machine");
    const dir = modWithVanilla(kind, id);
    const out = path.join(dir, "page.html");
    const r = page([kind, "--mod", dir, "--id", id, "--out", out]);
    assert.equal(r.status, 0, `page failed for ${kind}:\n${r.stdout}\n${r.stderr}`);
    const html = readFileSync(out, "utf8");
    const labels = rowLabels(html);
    assert.ok(labels.length >= 2, `${kind}: expected labelled rows, got ${labels.length}`);
    // The property: no row may be headed by a raw ASCII key. That is what a missing label looks like.
    const ascii = labels.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));
    assert.deepEqual(ascii, [], `${kind}: these rows still show the raw key: ${ascii.join(", ")}`);
  });
}

test("P-unknown: a key the game does not read is shown as such, not dropped", (t) => {
  if (!existsSync(VANILLA)) return t.skip("the game is not installed on this machine");
  const dir = modWithVanilla("event", "5300000");
  // The vanilla files are JSONC, so read them the way the tools do.
  const doc = parseDoc(readFileSync(path.join(dir, "config/event/5300000.json"), "utf8"));
  const record = toPlain(doc, doc.root);
  const proposal = { ...record, totally_made_up_key: 1 };
  const out = path.join(dir, "unknown.html");
  const r = page(["event", "--mod", dir, "--id", String(record.id), "--spec", "-", "--out", out], JSON.stringify(proposal));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const html = readFileSync(out, "utf8");
  assert.match(html, /游戏不读这些键/, "the page must have a section for keys the game ignores");
  assert.ok(html.includes("totally_made_up_key"), "the ignored key must be named");
});

test("P-nolabel: a live key with no label stops the page and names the key", (t) => {
  if (!existsSync(VANILLA)) return t.skip("the game is not installed on this machine");
  const dir = modWithVanilla("event", "5300000");
  const labels = JSON.parse(JSON.stringify(LABELS));
  delete labels.event.on;
  const labelsPath = path.join(dir, "labels.json");
  writeFileSync(labelsPath, JSON.stringify(labels));
  const out = path.join(dir, "nolabel.html");
  const r = page(["event", "--mod", dir, "--id", "5300000", "--labels", labelsPath, "--out", out]);
  assert.equal(r.status, 1, "a missing label is a real failure, not a silent raw key");
  assert.match(r.stdout, /FAIL/);
  assert.match(r.stdout, /"on"/, "the failure must name the key");
  assert.match(r.stdout, /field-labels\.json/, "and say where to add it");
});

test("P-badspec: a --spec that is not JSON fails before writing anything", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sudan-render-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "x", description: "d", tags: ["Utilities"], version: "1" }));
  const out = path.join(dir, "bad.html");
  const r = page(["card", "--mod", dir, "--id", "9000001", "--spec", "-", "--out", out], "{not json");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not valid JSON/);
  assert.ok(!existsSync(out), "no page is written for input that cannot be parsed");
});

test("P-coverage: every labelled key of a card record reaches the page", (t) => {
  if (!existsSync(VANILLA)) return t.skip("the game is not installed on this machine");
  const dir = modWithVanilla("card", "2000001");
  const out = path.join(dir, "card.html");
  assert.equal(page(["card", "--mod", dir, "--id", "2000001", "--out", out]).status, 0);
  const html = readFileSync(out, "utf8");
  const labels = rowLabels(html);
  const cardsDoc = parseDoc(readFileSync(path.join(dir, "config/cards.json"), "utf8"));
  const record = toPlain(cardsDoc, cardsDoc.root)["2000001"];
  const nested = new Set(Object.keys({ post_rite: 1, tag: 1 }));
  const missing = (FIELDS.card.fields || [])
    .filter((k) => k in record && !nested.has(k))
    .filter((k) => {
      const label = LABELS.card[k]?.label;
      return label && !labels.includes(label);
    });
  assert.deepEqual(missing, [], `keys on the record but not on the page: ${missing.join(", ")}`);
});
