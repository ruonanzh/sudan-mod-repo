#!/usr/bin/env node
/**
 * rules test — one rule, on purpose: an event branch has no condition.
 *
 *   node --test script/rules.test.mjs
 *
 * `EventTrigger.DoSettlements` walks `event.settlement[]` and appends one thunk per branch to a
 * single sequence, then runs the sequence. No branch's condition is consulted: the field is not
 * even read on that path, and 0 of the 1869 vanilla branches carry one. So a mod author who
 * writes `condition: { "counter.7000001>=": 3 }` inside an event branch has written a comment,
 * not a gate — the branch fires regardless.
 *
 * The trap is that the same JSON shape means something else one file over: in `rite.settlement`
 * the branches are a cascade and the condition is the whole point. F3/F4 therefore pin the
 * *other* hosts: they must stay silent, or the rule has grown into a false-positive machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { makeMod, lint, fieldCodes, messagesOf } from "./lib/fixture.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import { DEFAULT_VANILLA } from "../tools/model.mjs";

const CODE = "EVENT_BRANCH_CONDITION";

const eventWith = (settlement) => ({ "config/event/5910040.json": { id: 5910040, on: { round_begin_ba: 1 }, settlement } });

test(`F1 an event branch with a condition warns ${CODE}`, () => {
  const r = lint(makeMod(eventWith([{ condition: { "counter.7000001>=": 3 }, action: { "counter+7000001": 1 } }])));
  assert.ok(fieldCodes(r).includes(CODE), "a condition in an event branch is never evaluated");
  const msg = messagesOf(r, CODE);
  assert.match(msg, /settlement\[0\]/, "the message must say which branch");
  assert.match(msg, /rite\.settlement/, "the message must point at where branch selection does work");
});

test(`F2 an empty condition warns ${CODE} too`, () => {
  // `{}` is the shape authors copy from a rite's catch-all branch. It is still unread here.
  const r = lint(makeMod(eventWith([{ condition: {}, action: {} }])));
  assert.ok(fieldCodes(r).includes(CODE));
});

test("F3 the four rite settlement arrays stay silent", () => {
  const branch = { condition: { s1: 1 }, result_text: "x", result: {}, action: {} };
  const rite = {
    id: 5910041,
    name: "n",
    text: "t",
    tips: "",
    type: 0,
    round_number: 1,
    waiting_round: 0,
    waiting_round_end_action: [branch],
    open_conditions: [],
    random_text: {},
    random_text_up: {},
    tag_tips_up: {},
    settlement_prior: [branch],
    settlement: [branch],
    settlement_extre: [branch],
    cards_slot: { s1: { condition: {}, open_adsorb: 1, is_key: 0, is_empty: 0, is_enemy: 0, text: "x", pops: [] } },
  };
  const r = lint(makeMod({ "config/rite/5910041.json": rite }));
  assert.ok(!fieldCodes(r).includes(CODE), "a rite branch condition is evaluated, so it must not warn");
  assert.deepEqual(fieldCodes(r).filter((c) => c !== "LEGACY_FIELD"), [], `unexpected: ${fieldCodes(r).join(", ")}`);
});

test("F4 the other Settlement hosts stay silent", () => {
  const branch = { condition: { "counter.7000001>=": 1 }, result_text: "x", result: {}, action: {} };
  const r = lint(
    makeMod({
      "config/cards.json": {
        "9000101": {
          id: 9000101, name: "n", title: "t", text: "x", pops: [], type: "item", rare: 1,
          resource: ["cards/2000001"], tag: {}, card_vanishing: 0, vanish: {}, equips: [], is_only: 0,
          post_rite: [branch],
        },
      },
      "config/over.json": { "101": { name: "n", success: 1, text_extra: [branch] } },
      "config/after_story/2000001.json": { id: 2000001, name: "n", pic: "", prior: [], extra: [{ ...branch, key: "2000001_extra_1" }] },
    }),
  );
  assert.ok(!fieldCodes(r).includes(CODE), "card / over / after_story branches do test their condition");
});

test("F5 no vanilla event branch carries a condition", () => {
  // The rule would be noise if the shipped data broke it. Walk the real corpus instead of trusting
  // a grep: `condition` also appears at level 2, which is legal and evaluated.
  // DEFAULT_VANILLA keeps the literal `~`; lint expands it, this test has to as well.
  const dir = path.join(DEFAULT_VANILLA.replace(/^~/, homedir()), "event");
  const offenders = [];
  const unreadable = [];
  let branches = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let value;
    try {
      const doc = parseDoc(readFileSync(path.join(dir, name), "utf8"));
      value = toPlain(doc, doc.root);
    } catch {
      // The shipped corpus is not clean on every install; a file that does not parse cannot be
      // checked here. lint names it, so this test counts branches from the files it can read.
      unreadable.push(name);
      continue;
    }
    if (!Array.isArray(value?.settlement)) continue;
    value.settlement.forEach((b, i) => {
      branches += 1;
      if (b && typeof b === "object" && "condition" in b) offenders.push(`${name} settlement[${i}]`);
    });
  }
  assert.ok(branches > 1800, `expected ~1869 event branches, counted ${branches}`);
  assert.deepEqual(offenders, [], "no shipped event branch carries a condition");
});
