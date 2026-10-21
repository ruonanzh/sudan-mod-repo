#!/usr/bin/env node
/**
 * op-words test — an action or a condition reads as words, not as syntax.
 *
 *   node --test script/op-words.test.mjs
 *
 * `counter+7100005` and `have.主角.苏丹` are what an author types into `result`, `action` and
 * `condition`. A page that prints them raw is a wall of code to the player the page exists for.
 * The fix is a first word in Chinese (计数器 加 7100005), so that table is an artifact like the
 * field labels: small, checked, and expected to cover every word that really appears.
 *
 * The coverage test is the important one. It reads the installed game, collects every first word
 * inside `result` / `action` / `condition`, and fails on any word nobody has named yet — so a new
 * operation in a future patch shows up as a failing test, not as a page full of code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";
import { DEFAULT_VANILLA } from "../tools/model.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import { opPhrase } from "../tools/page.mjs";

const WORDS = JSON.parse(readFileSync(path.join(REPO, "schema/op-words.json"), "utf8"));
const VANILLA = DEFAULT_VANILLA.replace(/^~/, homedir());

const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("O1 an action phrase names the thing before it shows the syntax", () => {
  const cases = [
    ["counter+7100005", "计数器", "7100005"],
    ["counter.7001069<", "计数器", "小于"],
    ["counter.7000447>=", "计数器", "大于等于"],
    ["clean.s1", "清空槽位", "s1"],
    ["s1+魅力", "槽位 1", "魅力"],
    ["have.主角.苏丹", "拥有的卡数", "主角.苏丹"],
    ["!have.妻子.宰相", "拥有的卡数", "妻子.宰相"],
    ["case:op1", "分支", "op1"],
    ["event_on.5", "打开幕后事件", "5"],
  ];
  for (const [key, ...expected] of cases) {
    const text = plain(opPhrase(key));
    for (const want of expected) assert.ok(text.includes(want), `${key} → "${text}" should mention "${want}"`);
    assert.ok(!text.includes(key), `${key} should not be printed as raw syntax`);
  }
});

test("O2 a tag name or a card id is shown as itself, not as syntax", () => {
  assert.equal(plain(opPhrase("金币")), "金币");
  assert.equal(plain(opPhrase("2000082")), "2000082");
});

test("O3 every action and condition word in the game has a Chinese name", (t) => {
  if (!existsSync(VANILLA)) return t.skip("the game is not installed on this machine");
  const bases = new Map();
  const add = (key) => {
    if (!/^[a-z_]/.test(key)) return; // tag names and ids are already readable
    const base = key.replace(/^[~!]/, "").split(/[.:+=<>!~-]/)[0];
    bases.set(base, (bases.get(base) || 0) + 1);
  };
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 14) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if ((k === "condition" || k === "result" || k === "action") && v && typeof v === "object" && !Array.isArray(v)) {
        for (const key of Object.keys(v)) add(key);
      }
      walk(v, depth + 1);
    }
  };
  const load = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) load(p);
      else if (entry.name.endsWith(".json")) {
        try {
          const doc = parseDoc(readFileSync(p, "utf8"));
          walk(toPlain(doc, doc.root));
        } catch {
          /* the game ships one or two malformed files; they are not our problem here */
        }
      }
    }
  };
  load(VANILLA);

  const known = { ...WORDS.operations, ...WORDS.conditions };
  const missing = [...bases.entries()]
    .filter(([base]) => !known[base] && !/^s\d+$/.test(base) && !/^r\d+$/.test(base) && !(WORDS._skip || {})[base])
    .sort((a, b) => b[1] - a[1])
    .map(([base, n]) => `${base} (${n}×)`);
  assert.deepEqual(missing, [], `no Chinese name for: ${missing.join(", ")} — add it to schema/op-words.json`);
});
