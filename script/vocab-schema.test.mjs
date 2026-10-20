#!/usr/bin/env node
/**
 * vocab-schema test — the repository must not keep two copies of the same fact.
 *
 *   node --test script/vocab-schema.test.mjs
 *
 * Two claims are checked here.
 *
 * **D. The timing keys have one home.** `schema/vocab.json` lists all 29 names the engine
 * registers, plus the 8 that vanilla never writes. `tools/lint.mjs` used to carry its own
 * hand-typed copy of the same 29 in a `Set`. Two copies drift: the one nobody runs stays
 * plausible for years. D5 is the test that keeps the copy from coming back.
 *
 * **E. `schema/SCHEMA.md` is derived, and says where each key comes from.** It is generated
 * from `schema/fields.json`; E1-E3 pin that down (idempotent, `--check` red on a hand edit),
 * E4-E5 require the generated table to carry the reader delegate and field offset so a reader
 * can jump to the line in the dump that proves the claim.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeMod, lint, fieldCodes, messagesOf, cleanupAll, REPO } from "./lib/fixture.mjs";

const VOCAB = JSON.parse(readFileSync(new URL("../schema/vocab.json", import.meta.url), "utf8"));
const FIELDS = JSON.parse(readFileSync(new URL("../schema/fields.json", import.meta.url), "utf8"));
const SCHEMA = new URL("../schema/SCHEMA.md", import.meta.url);
const GEN = path.join(REPO, "tools/gen-schema-doc.mjs");

after(() => cleanupAll());

/** Render a list for an assertion message without dumping the whole array. */
const some = (list) => (list.length ? list.join(", ") : "(none)");

/** The 29 names, copied from `19-timings.md` §"the 29 registered timings" — assert, not reference. */
const TIMINGS = [
  "round_begin_ba", "round_begin_fr", "round_end", "rite_end", "rite_begin", "rite_clean",
  "rite_settlement", "rite_start", "rite_cancel", "rite_can_start", "rite_can_fill", "rite_can_stop",
  "card_clean", "card_dead", "card_born", "counter", "global_counter", "game_end", "close_wizard",
  "close_begin_guide", "close_prompt", "open_rite", "open_rite_end", "open_card_info",
  "open_card_info_end", "show_wizard_option", "sudan_redraw_start", "back_to_prev_round_end",
  "back_to_round_begin",
];

const UNUSED = [
  "round_begin_fr", "round_end", "card_dead", "rite_begin", "rite_clean",
  "rite_settlement", "global_counter", "back_to_round_begin",
];

// ---------------------------------------------------------------- D: one home for the timings

test("D1 vocab lists exactly the 29 registered timings", () => {
  assert.deepEqual([...VOCAB.timings.keys].sort(), [...TIMINGS].sort(), "the census registers 29 timing names");
  assert.deepEqual([...VOCAB.timings.unused_in_vanilla].sort(), [...UNUSED].sort(), "8 of the 29 are never written by vanilla");
});

test("D2 every registered timing key is accepted in an event", () => {
  const bad = [];
  for (const key of TIMINGS) {
    const r = lint(makeMod({ "config/event/5910030.json": { id: 5910030, on: { [key]: 1 }, settlement: [] } }));
    const codes = fieldCodes(r).filter((c) => c !== "LEGACY_FIELD");
    if (codes.includes("UNKNOWN_TIMING")) bad.push(key);
  }
  assert.deepEqual(bad, [], "a key the engine registers must never be reported as unknown");
});

test("D3 the 8 unused timing keys are still legal", () => {
  // They are registered but never written by vanilla. That makes them undocumented, not invalid.
  for (const key of UNUSED) {
    const r = lint(makeMod({ "config/event/5910031.json": { id: 5910031, on: { [key]: 1 }, settlement: [] } }));
    assert.ok(!fieldCodes(r).includes("UNKNOWN_TIMING"), `${key} is registered, so lint must accept it`);
  }
});

test("D4 an unregistered timing key still fails", () => {
  const r = lint(makeMod({ "config/event/5910032.json": { id: 5910032, on: { bogus_timing: 1 }, settlement: [] } }));
  assert.ok(fieldCodes(r).includes("UNKNOWN_TIMING"));
  assert.match(messagesOf(r, "UNKNOWN_TIMING"), /bogus_timing/);
});

test("D5 lint carries no second copy of the timing list", () => {
  // The property is "one home", so assert on the source rather than on behaviour: a copy that is
  // currently identical is invisible to a behavioural test and becomes wrong silently.
  const src = readFileSync(path.join(REPO, "tools/lint.mjs"), "utf8");
  const literals = TIMINGS.filter((k) => src.includes(`"${k}"`));
  assert.deepEqual(literals, [], "timing names belong in schema/vocab.json, not in tools/lint.mjs");
  assert.match(src, /vocab\.json|VOCAB\b/, "lint must read the vocabulary instead of a literal list");
});

test("D6 conditions and operations are still not validated (regression guard)", () => {
  // They have no machine-readable registry in this repo yet; wiring them in would turn two new
  // kinds of warning on for every existing mod. That is a separate decision, so pin the status quo.
  const r = lint(
    makeMod({
      "config/event/5910033.json": {
        id: 5910033,
        on: { round_begin_ba: 1 },
        condition: { "definitely_not_a_condition": 1 },
        settlement: [{ action: { "definitely_not_an_operation": 1 } }],
      },
    }),
  );
  assert.ok(!fieldCodes(r).includes("UNKNOWN_FIELD"), "condition and operation keys are not field names");
  assert.ok(!fieldCodes(r).some((c) => /CONDITION|OPERATION/.test(c)), "no condition/operation rule exists yet");
});

test("D7 the vocabulary keeps its own metadata out of the key list", () => {
  assert.ok(!VOCAB.timings.keys.includes("_note"));
  assert.equal(typeof VOCAB.timings._note === "string" || VOCAB.timings._note === undefined, true);
});

// ------------------------------------------------------- E: SCHEMA.md is generated and traceable

function gen(args, opts = {}) {
  return spawnSync(process.execPath, [GEN, ...args], { cwd: REPO, encoding: "utf8", ...opts });
}

test("E1 generating twice produces identical bytes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sudan-schema-"));
  const a = path.join(dir, "a.md");
  const b = path.join(dir, "b.md");
  assert.equal(gen(["--out", a]).status, 0);
  assert.equal(gen(["--out", b]).status, 0);
  assert.equal(readFileSync(a, "utf8"), readFileSync(b, "utf8"), "the generator must be deterministic");
});

test("E2 --check passes when the committed file is current", () => {
  const run = gen(["--check"]);
  assert.equal(run.status, 0, `SCHEMA.md is stale: run node tools/gen-schema-doc.mjs\n${run.stderr}`);
});

test("E3 --check fails after a hand edit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sudan-schema-"));
  const copy = path.join(dir, "SCHEMA.md");
  copyFileSync(new URL(SCHEMA).pathname, copy);
  writeFileSync(copy, readFileSync(copy, "utf8") + "\nhand-written line\n");
  const run = gen(["--check", "--out", copy]);
  assert.notEqual(run.status, 0, "--check must notice a hand edit");
  assert.match(run.stderr, /stale/);
});

test("E4 the generated table carries the reader and the offset", () => {
  const text = readFileSync(SCHEMA, "utf8");
  const samples = [
    ["card", "name"],
    ["rite", "location"],
    ["event", "start_trigger"],
    ["settlement", "key"],
    ["lootItem", "num"],
  ];
  for (const [kind, key] of samples) {
    const meta = FIELDS[kind]?.meta?.[key];
    assert.ok(meta, `${kind}.${key} must have a meta entry`);
    // The row must exist in the document and carry both facts, somewhere on the same line.
    const line = text.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${key}\``) && l.includes(meta.reader) && l.includes(meta.offset));
    assert.ok(line, `SCHEMA.md must show ${kind}.${key} with ${meta.reader} at ${meta.offset}`);
  }
});

test("E5 table rows keep the order of the fields array", () => {
  const text = readFileSync(SCHEMA, "utf8");
  // Scope to the card section: the same key name also appears in the level-2 summary and in
  // other kinds, and a document-wide indexOf would compare the wrong rows.
  const start = text.indexOf("### card\n");
  const end = text.indexOf("\n### ", start + 1);
  assert.ok(start >= 0 && end > start, "SCHEMA.md must have a card section");
  const section = text.slice(start, end);
  const order = FIELDS.card.fields;
  const positions = order.map((k) => section.indexOf(`| \`${k}\` |`));
  assert.ok(positions.every((i) => i >= 0), `every card key needs a row: missing ${some(order.filter((_, i) => positions[i] < 0))}`);
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, "rows follow reader order, not alphabetical order");
});
