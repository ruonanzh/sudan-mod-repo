/**
 * Claims in the docs that the code or the shipped data contradicts. Each assertion names the
 * fact, not the wording, so the sentence can be rewritten without breaking the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";

const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");

test("the schema generator does not claim location is interval-only", () => {
  const gen = read("tools/gen-schema-doc.mjs");
  assert.doesNotMatch(gen, /must be `"<region>:\[min,max\]"`/, "the slot form exists in vanilla and in docs/rite.md");
  assert.match(gen, /slot/, "the generator mentions the slot form");
});

test("the loot doc says the entry condition is a gate, not decoration", () => {
  const doc = read("docs/loot-quest-over.md");
  assert.doesNotMatch(doc, /从不求值/, "IsilDump shows Where(i => i.condition == null || i.condition.Check(ctx))");
  assert.match(doc, /condition/, "the doc still explains condition");
});

test("the directory-entry rule names the exceptions", () => {
  const skill = read(".pi/skills/mod-creator/SKILL.md");
  assert.doesNotMatch(skill, /这条规则对所有目录都成立/, "dt and wizard are addressed differently");
  assert.match(skill, /wizard/, "wizard is explained");
  assert.match(skill, /dialog_tree_id/, "dt is explained");
});

test("reference/ is described as shipped, not empty", () => {
  const agents = read("AGENTS.md");
  assert.doesNotMatch(agents, /`reference\/` —— 预留。这个版本里没有内容。/, "the folder ships plates and style cards");
  const cardArt = read(".pi/skills/card-art/SKILL.md");
  assert.doesNotMatch(cardArt, /参考美术不在本仓/, "reference/cards ships with the repository");
});

test("docs/rite.md does not promise a list it does not carry", () => {
  const rite = read("docs/rite.md");
  assert.doesNotMatch(rite, /这份清单是完整的/, "the section has no list; it points at the mod-creator list");
});
