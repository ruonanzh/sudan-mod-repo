/**
 * The timing vocabulary must describe the argument the data actually carries.
 *
 * It used to say "1" for rite_start, rite_cancel and open_rite_end while vanilla writes
 * rite ids there (5005101 and friends), so anything that builds a graph from this table
 * got zero edges. These assertions pin the fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const vocab = JSON.parse(readFileSync(new URL("../schema/vocab.json", import.meta.url), "utf8"));
const KEYS = vocab.timings.keys;
const ARG = vocab.timings.arg;

test("every registered timing has an argument description", () => {
  const missing = KEYS.filter((k) => !ARG[k]);
  assert.deepEqual(missing, [], `timings without an arg entry: ${missing.join(", ")}`);
});

test("rite-valued timings say rite id, not 1", () => {
  for (const k of ["rite_start", "rite_cancel", "open_rite_end", "rite_end", "rite_begin", "rite_clean", "rite_settlement"]) {
    assert.match(ARG[k] || "", /rite id/, `${k} must describe a rite id, got ${JSON.stringify(ARG[k])}`);
  }
});

test("card-valued timings say card id, not 1", () => {
  for (const k of ["card_clean", "card_born", "card_dead"]) {
    assert.match(ARG[k] || "", /card id/, `${k} must describe a card id, got ${JSON.stringify(ARG[k])}`);
  }
});

test("game_end carries an ending id and names its sentinels", () => {
  assert.match(ARG.game_end || "", /over id/);
  assert.match(ARG.game_end || "", /sentinel/);
});

test("flag timings are the ones still described as 1", () => {
  const flags = KEYS.filter((k) => ARG[k] === "1");
  // Every remaining "1" must be a real no-argument hook, never an id carrier.
  const forbidden = ["rite_start", "rite_cancel", "open_rite_end", "card_born", "game_end"];
  for (const k of forbidden) assert.ok(!flags.includes(k), `${k} must not be described as 1`);
});
