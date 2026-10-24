/**
 * The pure part of the form wrapper: which stored condition belongs to which row after edits.
 * The wrapper itself runs only in the app's editor frame, so the logic lives in a plain script
 * that Node can require.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { mergeConditions } = require(fileURLToPath(new URL("../editors/form/form-values.js", import.meta.url)));

const saved = [
  { type: "card", id: 2000001, weight: 10, condition: { "have.2000009": 1 } },
  { type: "card", id: 2000002, weight: 5, condition: { "!have.2000001": 1 } },
];

test("deleting the first row keeps the second row's condition", () => {
  const rows = [{ type: "card", id: 2000002, weight: 5 }];
  assert.deepEqual(mergeConditions(rows, saved)[0].condition, saved[1].condition);
});

test("deleting a middle row does not shift the conditions", () => {
  const three = [...saved, { type: "card", id: 2000003, condition: { "counter.7000001>": 1 } }];
  const rows = [{ type: "card", id: 2000001 }, { type: "card", id: 2000003 }];
  const out = mergeConditions(rows, three);
  assert.deepEqual(out[0].condition, three[0].condition);
  assert.deepEqual(out[1].condition, three[2].condition);
});

test("deleting every row yields an empty list, not a missing one", () => {
  assert.deepEqual(mergeConditions([], saved), []);
});

test("a row that already has a condition keeps it, and each stored one is used once", () => {
  const rows = [{ type: "card", id: 2000001, condition: { "have.1": 1 } }, { type: "card", id: 2000001 }];
  const out = mergeConditions(rows, saved);
  assert.deepEqual(out[0].condition, { "have.1": 1 });
  assert.deepEqual(out[1].condition, saved[0].condition, "the stored one goes to the other row once");
});

const { changedValues } = require(fileURLToPath(new URL("../editors/form/form-values.js", import.meta.url)));

test("a number equal to the same number written as a string is not a change", () => {
  // Vanilla writes num/id/type/weight; the page reads type/id/num/weight — key order must not matter.
  const saved = { repeat: 3, item: [{ num: "1", id: "2000032", weight: "10", type: "card" }] };
  const page = { repeat: 3, item: [{ type: "card", id: 2000032, num: 1, weight: 10 }] };
  assert.deepEqual(changedValues(page, saved, [], undefined), {}, "vanilla strings, key order and page numbers agree");
});

test("only the key that changed travels, not the whole item array", () => {
  const saved = { repeat: 3, item: [{ type: "card", id: "2000032", num: "1", weight: "10" }] };
  const page = { repeat: 5, item: [{ type: "card", id: 2000032, num: 1, weight: 10 }] };
  const out = changedValues(page, saved, []);
  assert.deepEqual(Object.keys(out), ["repeat"]);
  assert.equal(out.repeat, 5);
});

test("a key the player describes in words is never sent, and a missing key is null", () => {
  const saved = { repeat: 3, type: 2, name: "x" };
  const page = { repeat: 3, type: 2 };
  assert.deepEqual(changedValues(page, saved, ["condition"]), { name: null });
});
