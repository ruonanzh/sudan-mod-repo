#!/usr/bin/env node
/**
 * story editor test.
 *
 *   node --test tools/story.test.mjs
 *
 * The properties worth pinning here, because each one is a way to silently break a
 * mod rather than fail loudly:
 *   1. two operations with the same key must produce two keys, not one overwritten
 *   2. adding a branch must not rewrite the branches that were already there
 *   3. adding an operation must not rewrite the sibling fields
 *   4. a bad path or bad JSON fails with nothing written
 *   5. a created record passes lint
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const freshMod = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sgstory-"));
  writeFileSync(path.join(dir, "info.json"), '{"name":"S","description":"d","tags":["Utilities"],"version":"1"}\n');
  return dir;
};

const run = (args) => {
  try {
    return { ok: true, out: execFileSync("node", [path.join(here, "story.mjs"), ...args], { encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

const lint = (mod) => {
  try {
    execFileSync("node", [path.join(here, "lint.mjs"), mod], { encoding: "utf8" });
    return 0;
  } catch (e) {
    return 1;
  }
};

function seedRite(mod) {
  assert.ok(run(["rite", "new", "--mod", mod, "--id", "5010901", "--name", "语义探针"]).ok);
  assert.ok(run(["rite", "branch", "--mod", mod, "--id", "5010901", "--result-text", "第一分支"]).ok);
}

test("a created event passes lint and carries no dead legacy field", () => {
  const mod = freshMod();
  const r = run(["event", "new", "--mod", mod, "--id", "5901000", "--text", "书店营业"]);
  assert.ok(r.ok, r.out);
  assert.equal(lint(mod), 0);
  const text = readFileSync(path.join(mod, "config/event/5901000.json"), "utf8");
  assert.ok(!text.includes('"auto_start"'), "auto_start is a legacy field the engine never reads");
  assert.ok(text.includes('"auto_start_init"'), "an event nothing names never runs");
});

test("the same operation twice makes two keys, which is how the game appends", () => {
  const mod = freshMod();
  seedRite(mod);
  run(["rite", "op", "--mod", mod, "--id", "5010901", "--at", "settlement.0.result", "--op", "counter+7000163=1"]);
  run(["rite", "op", "--mod", mod, "--id", "5010901", "--at", "settlement.0.result", "--op", "counter+7000163=5"]);
  const text = readFileSync(path.join(mod, "config/rite/5010901.json"), "utf8");
  const keys = [...text.matchAll(/"counter\+7000163"/g)];
  assert.equal(keys.length, 2, "the key must appear twice");
  assert.equal(lint(mod), 0);
});

test("adding a branch leaves the earlier branch's text untouched", () => {
  const mod = freshMod();
  seedRite(mod);
  const file = path.join(mod, "config/rite/5010901.json");
  const before = readFileSync(file, "utf8");
  const firstBranch = before.slice(before.indexOf('"guid"'), before.indexOf('"result_text"'));
  run(["rite", "branch", "--mod", mod, "--id", "5010901", "--result-text", "第二分支"]);
  const after = readFileSync(file, "utf8");
  assert.ok(after.includes(firstBranch), "the first branch must keep its original bytes, guid included");
  assert.ok(after.includes("第二分支"));
});

test("adding an operation leaves sibling operations untouched", () => {
  const mod = freshMod();
  seedRite(mod);
  run(["rite", "op", "--mod", mod, "--id", "5010901", "--at", "settlement.0.result", "--op", "counter+7000999=7"]);
  run(["rite", "op", "--mod", mod, "--id", "5010901", "--at", "settlement.0.result", "--op", "counter+7000163=1"]);
  const text = readFileSync(path.join(mod, "config/rite/5010901.json"), "utf8");
  assert.ok(text.includes('"counter+7000999": 7'), "the first operation must survive");
});

test("a missing path fails and writes nothing", () => {
  const mod = freshMod();
  seedRite(mod);
  const file = path.join(mod, "config/rite/5010901.json");
  const before = readFileSync(file, "utf8");
  const r = run(["rite", "op", "--mod", mod, "--id", "5010901", "--at", "nosuch.0.result", "--op", "x=1"]);
  assert.equal(r.ok, false);
  assert.match(r.out, /no /);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("invalid JSON in a condition fails and writes nothing", () => {
  const mod = freshMod();
  seedRite(mod);
  const file = path.join(mod, "config/rite/5010901.json");
  const before = readFileSync(file, "utf8");
  const r = run(["rite", "branch", "--mod", mod, "--id", "5010901", "--condition", "not json"]);
  assert.equal(r.ok, false);
  assert.match(r.out, /not valid/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a slot name that is not sN is refused", () => {
  const mod = freshMod();
  seedRite(mod);
  const r = run(["rite", "slot", "--mod", mod, "--id", "5010901", "--slot", "bad"]);
  assert.equal(r.ok, false);
  assert.match(r.out, /s1\.\.sN/);
});

test("is_empty 0 and 1 both round trip", () => {
  const mod = freshMod();
  seedRite(mod);
  run(["rite", "slot", "--mod", mod, "--id", "5010901", "--slot", "s1", "--is-empty", "0"]);
  run(["rite", "slot", "--mod", mod, "--id", "5010901", "--slot", "s2", "--is-empty", "1"]);
  const parsed = JSON.parse(readFileSync(path.join(mod, "config/rite/5010901.json"), "utf8"));
  assert.equal(parsed.cards_slot.s1.is_empty, 0);
  assert.equal(parsed.cards_slot.s2.is_empty, 1);
  assert.equal(lint(mod), 0);
});
