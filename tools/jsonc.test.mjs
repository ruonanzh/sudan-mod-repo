#!/usr/bin/env node
/**
 * jsonc test — the property that matters is that an editor cannot damage a file it
 * did not mean to touch.
 *
 *   node --test tools/jsonc.test.mjs
 *
 * Checks, in order of how much they would hurt to get wrong:
 *   1. parse + render with no edits returns the original bytes, on every shipped file
 *   2. a single value edit changes only that value's characters
 *   3. appending an existing key creates a real duplicate, which the game reads as append
 *   4. comments, trailing commas and a BOM survive an edit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseDoc, getDoc, findEntries, valueOf, sourceOf, literal } from "./jsonc.mjs";

const VANILLA = path.join(
  os.homedir(),
  "Library/Application Support/Steam/steamapps/common/Sultan's Game/Sultan's Game.app/Contents/Resources/Data/StreamingAssets/config",
);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".json")) out.push(full);
  }
  return out;
};

test("round trip is byte-identical on every shipped config file", () => {
  if (!existsSync(VANILLA)) return;
  const files = walk(VANILLA);
  assert.ok(files.length > 3000, `expected the full corpus, got ${files.length} files`);
  let bad = 0;
  const failures = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    try {
      const out = parseDoc(text).render();
      if (out !== text) {
        bad++;
        if (failures.length < 5) failures.push(`${path.relative(VANILLA, file)}: ${out.length} vs ${text.length} bytes`);
      }
    } catch (e) {
      bad++;
      if (failures.length < 5) failures.push(`${path.relative(VANILLA, file)}: ${e.message}`);
    }
  }
  assert.equal(bad, 0, `${bad} of ${files.length} files did not round trip\n${failures.join("\n")}`);
});

test("a value edit touches only that value", () => {
  const text = `{\n  "a": 1, // keep me\n  "b": "two"\n}\n`;
  const doc = parseDoc(text);
  const node = getDoc(doc, ["b"]);
  assert.equal(valueOf(doc, node), "two");
  doc.set(node, literal("changed"));
  const out = doc.render();
  assert.ok(out.includes("// keep me"), "comment must survive");
  assert.ok(out.includes(`"a": 1`), "untouched value must survive");
  assert.ok(out.includes(`"b": "changed"`), "edited value must be written");
  assert.equal(out.length, text.length - "two".length + "changed".length);
});

test("appending an existing key creates a duplicate, which means append", () => {
  const text = `{\n    "action": {\n        "event_on": 5300123\n    }\n}\n`;
  const doc = parseDoc(text);
  doc.append(getDoc(doc, ["action"]), "event_on", "5300124");
  const out = doc.render();
  const entries = findEntries(parseDoc(out).root, "action");
  assert.equal(entries.length, 1);
  const inner = findEntries(entries[0].value, "event_on");
  assert.equal(inner.length, 2, "the key must appear twice, not be merged into an array");
  assert.deepEqual(inner.map((e) => valueOf(parseDoc(out), e.value)), [5300123, 5300124]);
});

test("appending to an empty object writes valid JSONC", () => {
  const doc = parseDoc(`{\n  "action": {}\n}\n`);
  doc.append(getDoc(doc, ["action"]), "rite", "5002006");
  const out = doc.render();
  assert.equal(out, `{\n  "action": {"rite": 5002006}\n}\n`);
});

test("indentation follows the file, not a constant", () => {
  const doc = parseDoc(`{\n\t"a": 1\n}\n`);
  doc.append(doc.root, "b", "2");
  assert.ok(doc.render().includes(`\n\t"b": 2`), "must use a tab because the file does");
});

test("removing the last entry also removes the leading comma", () => {
  const doc = parseDoc(`{\n  "a": 1,\n  "b": 2\n}\n`);
  doc.remove(doc.root, "b");
  assert.equal(doc.render(), `{\n  "a": 1\n}\n`);
});

test("removing a middle entry also removes the trailing comma", () => {
  const doc = parseDoc(`{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n`);
  doc.remove(doc.root, "b");
  assert.equal(doc.render(), `{\n  "a": 1,\n  "c": 3\n}\n`);
});

test("a BOM survives", () => {
  const text = `\ufeff{\n  "a": 1\n}\n`;
  const doc = parseDoc(text);
  doc.set(getDoc(doc, ["a"]), "2");
  const out = doc.render();
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.ok(out.includes(`"a": 2`));
});

test("an edit inside a real rite keeps the rest of the file identical", () => {
  const file = path.join(VANILLA, "rite/5006558.json");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const doc = parseDoc(text);
  doc.append(getDoc(doc, ["settlement", 0, "result"]), "counter+7999001", "1");
  const out = doc.render();
  // The only permitted difference is a comma added before the trailing comment, plus
  // the new line itself. The comma must not land inside the comment.
  const expected = text.replace(/(0)(\s*\/\/苏丹卡时间重置)/, "$1,$2");
  const filtered = out
    .split("\n")
    .filter((line) => !line.includes('"counter+7999001"'))
    .join("\n");
  assert.equal(filtered, expected, "only the comma and the appended line may differ");
  assert.ok(out.includes('"counter+7999001": 1'));
});
