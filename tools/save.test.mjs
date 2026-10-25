#!/usr/bin/env node
/**
 * save editor test.
 *
 *   node --test tools/save.test.mjs
 *
 * A save is the most dangerous thing here: the game rewrites it constantly and a bad
 * one costs the player a run. So the tests focus on refusal and on never writing by
 * accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const run = (args) => {
  try {
    return { ok: true, out: execFileSync("node", [path.join(here, "save.mjs"), ...args], { encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

/** A tiny but realistic run save. */
const fakeSave = (over = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sgsave-"));
  const file = path.join(dir, "auto_save.json");
  const body = {
    configId: 1,
    configVersion: 20260306160333,
    name: "测试",
    difficulty: 1,
    round: 4,
    card_uid_index: 10,
    cards: [
      { uid: 3, id: 2000001, count: 1 },
      { uid: 7, id: 2000005, count: 2 },
    ],
    rites: [],
    counter: { 7100001: 5 },
    event_status: { 5300000: false },
    ...over,
  };
  writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
};

test("show reports the round and the card count", () => {
  const r = run(["show", "--save", fakeSave()]);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /round\s+4/);
  assert.match(r.out, /2 in hand/);
});

test("get reads a nested counter", () => {
  const r = run(["get", "--save", fakeSave(), "--path", "counter.7100001"]);
  assert.ok(r.ok, r.out);
  assert.equal(r.out.trim(), "5");
});

test("set without --write leaves the file untouched", () => {
  const file = fakeSave();
  const before = readFileSync(file, "utf8");
  const r = run(["set", "--save", file, "--path", "round=99"]);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /preview only/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("set with --write applies the change and leaves a backup", () => {
  const file = fakeSave();
  const r = run(["set", "--save", file, "--path", "round=99", "--write"]);
  assert.ok(r.ok, r.out);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).round, 99);
  assert.ok(existsSync(`${file}.bak`), "a backup must be written");
  assert.equal(JSON.parse(readFileSync(`${file}.bak`, "utf8")).round, 4);
});

test("an unknown path is refused, not created", () => {
  const file = fakeSave();
  const before = readFileSync(file, "utf8");
  const r = run(["set", "--save", file, "--path", "bogus=1", "--write"]);
  assert.equal(r.ok, false);
  assert.match(r.out, /no bogus/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a uid index below an existing uid is refused", () => {
  const file = fakeSave();
  const r = run(["set", "--save", file, "--path", "card_uid_index=5", "--write"]);
  assert.equal(r.ok, false);
  assert.match(r.out, /bag index/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).card_uid_index, 10);
});

test("cards reports a uid at or above the index", () => {
  const file = fakeSave({ card_uid_index: 5 });
  const r = run(["cards", "--save", file]);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /WARN/);
  assert.match(r.out, /uid>=index/);
});

test("a missing file fails cleanly", () => {
  const r = run(["show", "--save", "/nonexistent/auto_save.json"]);
  assert.equal(r.ok, false);
  assert.match(r.out, /no such save file/);
});
