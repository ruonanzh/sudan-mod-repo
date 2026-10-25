#!/usr/bin/env node
/**
 * model + card editor test.
 *
 *   node --test tools/model.test.mjs
 *
 * The properties that matter, in order of how expensive they would be to get wrong:
 *   1. a write never copies the vanilla table into the mod
 *   2. overriding one vanilla record ships exactly that record, byte for byte apart from
 *      the edited field
 *   3. a field the class does not declare is refused before anything is written
 *   4. --dry-run writes nothing
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMod, ModelError } from "./model.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

const freshMod = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sgmod-"));
  writeFileSync(path.join(dir, "info.json"), '{"name":"T","description":"d","tags":["Utilities"],"version":"1"}\n');
  return dir;
};

const run = (args) => {
  try {
    return { ok: true, out: execFileSync("node", [path.join(here, "card.mjs"), ...args], { encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

test("new card writes only that card, never the vanilla table", () => {
  const mod = freshMod();
  const r = run(["new", "--mod", mod, "--id", "2100900", "--name", "测试", "--type", "item", "--rare", "4"]);
  assert.ok(r.ok, r.out);
  const text = readFileSync(path.join(mod, "config/cards.json"), "utf8");
  assert.ok(text.length < 2000, `expected one record, got ${text.length} bytes`);
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ["2100900"]);
  assert.equal(parsed["2100900"].rare, 4);
});

test("overriding a vanilla record ships exactly that record", () => {
  const mod = freshMod();
  const r = run(["set", "--mod", mod, "--id", "2000001", "--field", "text", "改过的说明"]);
  assert.ok(r.ok, r.out);
  const parsed = JSON.parse(readFileSync(path.join(mod, "config/cards.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed), ["2000001"]);
  assert.equal(parsed["2000001"].text, "改过的说明");
  // Everything else came across from vanilla untouched.
  assert.equal(parsed["2000001"].name, "阿尔图");
  assert.equal(Object.keys(parsed["2000001"].tag).length, 10);
});

test("an undeclared field is refused and nothing is written", () => {
  const mod = freshMod();
  const r = run(["set", "--mod", mod, "--id", "2000001", "--field", "no_such_field", "x"]);
  assert.equal(r.ok, false);
  assert.match(r.out, /no such|has no/);
  assert.equal(existsSync(path.join(mod, "config/cards.json")), false, "nothing may be written on a refusal");
});

test("adding a tag keeps the existing tags and does not duplicate the key", () => {
  const mod = freshMod();
  run(["new", "--mod", mod, "--id", "2100901", "--name", "x", "--type", "item", "--rare", "1", "--tag", "体魄+2"]);
  const r = run(["tag", "--mod", mod, "--id", "2100901", "--add", "战斗+3"]);
  assert.ok(r.ok, r.out);
  const parsed = JSON.parse(readFileSync(path.join(mod, "config/cards.json"), "utf8"));
  assert.deepEqual(parsed["2100901"].tag, { 体魄: 2, 战斗: 3 });
});

test("an existing tag is updated in place, not appended twice", () => {
  const mod = freshMod();
  run(["new", "--mod", mod, "--id", "2100902", "--name", "x", "--type", "item", "--rare", "1", "--tag", "体魄+2"]);
  run(["tag", "--mod", mod, "--id", "2100902", "--add", "体魄+9"]);
  const text = readFileSync(path.join(mod, "config/cards.json"), "utf8");
  assert.equal((text.match(/"体魄"/g) || []).length, 1, "the key must appear once");
  assert.equal(JSON.parse(text)["2100902"].tag["体魄"], 9);
});

test("dry run writes nothing", () => {
  const mod = freshMod();
  run(["new", "--mod", mod, "--id", "2100903", "--name", "x", "--type", "item", "--rare", "1"]);
  const before = readFileSync(path.join(mod, "config/cards.json"), "utf8");
  const r = run(["set", "--mod", mod, "--id", "2100903", "--field", "title", "T", "--dry-run"]);
  assert.ok(r.ok, r.out);
  assert.equal(readFileSync(path.join(mod, "config/cards.json"), "utf8"), before);
});

test("a bad rare is refused by the model, not only by the CLI", () => {
  const mod = freshMod();
  const m = openMod(mod);
  assert.throws(() => m.add("card", { id: 2100904, name: "x", type: "item", rare: 9 }), ModelError);
  assert.throws(() => m.add("card", { id: 2100905, name: "x", type: "nope", rare: 1 }), ModelError);
});
