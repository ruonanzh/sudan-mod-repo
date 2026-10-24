/**
 * Prompt templates and page scripts are one contract: the button sends an argument, the template
 * reads it, and the command the template tells the agent to run has to exist. These tests read
 * the files exactly as an agent would and check that the three agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";
import { parseDoc, getDoc } from "../tools/jsonc.mjs";

const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");
const prompts = readdirSync(path.join(REPO, ".pi/prompts")).filter((n) => n.endsWith(".md"));

test("no prompt asks for a mod path the CLI cannot resolve", () => {
  const bad = prompts.filter((name) => /--mod <ModName>/.test(read(`.pi/prompts/${name}`)));
  assert.deepEqual(bad, [], "preview.mjs does not add your_mods/; the prompt must write it");
});

test("the card prompt names the card, so only that card is written", () => {
  const text = read(".pi/prompts/card-edited.md");
  assert.match(text, /--collect --id <卡 id>/);
  assert.match(text, /--apply --id <卡 id>/);
});

test("the loot prompt uses array methods that exist", () => {
  const text = read(".pi/prompts/loot-edited.md");
  const doc = parseDoc('{"item": []}');
  const arr = getDoc(doc, ["item"]);
  for (const name of ["set", "appendElement", "removeElement", "element"]) {
    assert.equal(typeof doc[name], "function", `${name} exists on the editor`);
    assert.ok(text.includes(`\`${name}(`), `the prompt mentions ${name}`);
  }
  assert.equal(typeof doc.setElement, "function", "setElement still exists for a whole-element write");
  assert.equal(typeof doc.append, "function", "object append still exists");
  assert.equal(typeof arr, "object");
  // The old advice named object-only helpers for an array.
  assert.doesNotMatch(text, /按索引增删用 `append`\/`remove`/);
});

test("the record page sends the record key the prompt reads", () => {
  const prompt = read(".pi/prompts/record-edited.md");
  assert.match(prompt, /<kind>:<id>/, "the template documents a kind:id argument");
  assert.doesNotMatch(prompt, /记录页路径/, "it does not ask for a page path");
  const bridge = read("editors/card/bridge.js");
  assert.match(bridge, /state\.recordKey/, "the page script reads data-record-page");
  const skill = read(".pi/skills/mod-page/SKILL.md");
  assert.match(skill, /\/record-edited event:9900102/, "the SKILL example uses the same shape");
  assert.doesNotMatch(skill, /\/record-edited <记录页路径>/);
});
