#!/usr/bin/env node
/**
 * page-spec test — preview a proposal without writing it into the mod.
 *
 *   node --test script/page-spec.test.mjs
 *
 * The page has two jobs, and the second one is easy to get wrong:
 *
 * 1. Render a record that already lives in `your_mods/<Mod>/config/`.
 * 2. Render a **proposal** that nobody has written yet, so the player can approve a shape
 *    before it becomes a record.
 *
 * The property that matters for (2) is the absence of a side effect: after building a proposal
 * page, the mod's config must be byte-for-byte what it was. A preview that quietly writes is
 * worse than no preview, because the draft then looks like a decision.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeMod, cleanupAll, REPO, record } from "./lib/fixture.mjs";

after(() => cleanupAll());

const PAGE = path.join(REPO, "tools/page.mjs");

const CARD = record("card", { id: 9000301, name: "断刃", title: "单手剑", text: "刃口卷了三处。" });

function runPage(args, stdin) {
  return spawnSync(process.execPath, [PAGE, ...args], {
    cwd: REPO,
    encoding: "utf8",
    input: stdin,
    timeout: 120000,
  });
}

test("S1 a card that is not in the mod yet can be previewed from stdin", () => {
  const dir = makeMod({ "config/cards.json": {} });
  const out = path.join(mkdtempSync(path.join(tmpdir(), "sudan-page-")), "proposal.html");
  const r = runPage(["card", "--mod", dir, "--id", String(CARD.id), "--spec", "-", "--out", out], JSON.stringify(CARD));
  assert.equal(r.status, 0, `page failed:\n${r.stdout}\n${r.stderr}`);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes(CARD.name), "the proposal's name is on the page");
  assert.ok(/提案/.test(html), "the page says this is a proposal, not a written record");
});

test("S2 building a proposal page does not write the record", () => {
  const cards = { "9000302": record("card", { id: 9000302, name: "旧卡" }) };
  const dir = makeMod({ "config/cards.json": cards });
  const before = readFileSync(path.join(dir, "config/cards.json"), "utf8");
  const out = path.join(mkdtempSync(path.join(tmpdir(), "sudan-page-")), "p.html");
  const proposal = record("card", { id: 9000303, name: "新卡" });
  const r = runPage(["card", "--mod", dir, "--id", "9000303", "--spec", "-", "--out", out], JSON.stringify(proposal));
  assert.equal(r.status, 0);
  assert.equal(readFileSync(path.join(dir, "config/cards.json"), "utf8"), before, "the mod's table is untouched");
  assert.ok(!existsSync(path.join(dir, "config/cards.json.bak")), "no backup file is left behind");
});

test("S3 a written record still renders without --spec", () => {
  const dir = makeMod({ "config/cards.json": { "9000304": record("card", { id: 9000304, name: "已写" }) } });
  const out = path.join(mkdtempSync(path.join(tmpdir(), "sudan-page-")), "p.html");
  const r = runPage(["card", "--mod", dir, "--id", "9000304", "--out", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(readFileSync(out, "utf8").includes("已写"));
});

test("S4 asking for a record that is neither written nor proposed fails cleanly", () => {
  const dir = makeMod({ "config/cards.json": {} });
  const r = runPage(["card", "--mod", dir, "--id", "9000399"]);
  assert.equal(r.status, 1, "a missing record is a business result, not a crash");
  assert.match(r.stdout, /FAIL/);
});
