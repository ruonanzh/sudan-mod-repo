#!/usr/bin/env node
/**
 * art-prompt test — three ways to ask for a card picture, in the order of preference.
 *
 *   node --test script/art-prompt.test.mjs
 *
 * The three functions the card page uses to show "画面 · 这张图画成什么".
 *
 * 1. **Nothing given.** `composePrompt(card)` builds head (tier + type), the card's own
 *    fields as the subject, and the style constant. This is the default and the one that
 *    keeps a mod looking like the game.
 * 2. **`--subject` / `--add`.** The player says what the picture shows. The head and the
 *    style tail stay, so the result is the player's content in the game's style. Content wins:
 *    `--subject` replaces the generated subject sentence outright.
 * 3. **`--prompt`.** The whole prompt is the caller's. Nothing of the game's style survives,
 *    which is why it is last: use it only when the player does not want the game's look.
 *
 * The property that matters is that mode 2 never silently drops the style tail, and that mode 3
 * never silently keeps it: a caller must be able to tell which one ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt, resolvePrompt, composeSubject, planRefs } from "../editors/lib/card-prompt.mjs";

const CARD = {
  id: 2100900,
  name: "断刃",
  title: "单手剑",
  text: "刃口卷了三处，仍能割开皮甲。",
  type: "item",
  rare: 3,
  tag: { 战斗: 1, 已拥有: 1, 武器: 2 },
};

const STYLE_TAIL = "game card art";
const head = (p) => p.slice(0, 24);

test("P1 the default composes head, the card's own fields, and the style tail", () => {
  const p = composePrompt(CARD);
  // The tier name carries both languages (银 silver), so assert on the shape.
  assert.match(p, /^A .+silver tier item card: a single object/, "head names tier and type");
  assert.ok(p.includes("断刃"), "the card name is the subject");
  assert.ok(p.includes(STYLE_TAIL), "the style tail is present");
  assert.ok(p.endsWith(STYLE_TAIL), "the tail comes last");
});

test("P2 the subject skips status tags but keeps mood tags", () => {
  const subject = composeSubject(CARD);
  assert.ok(subject.includes("战斗"), "a real tag is used as mood");
  assert.ok(subject.includes("武器"), "a second real tag is used");
  assert.ok(!subject.includes("已拥有"), "a status tag is not mood");
});

test("P3 --subject keeps the head and the tail, and drops the generated subject", () => {
  const p = composePrompt(CARD, { subject: "一把断成两截的长剑，插在雪里" });
  assert.match(p, /^A .+silver tier item card:/, "head survives");
  assert.ok(p.includes("一把断成两截的长剑，插在雪里"), "player content is present");
  assert.ok(!p.includes("断刃"), "the generated subject is replaced, not appended");
  assert.ok(p.endsWith(STYLE_TAIL), "style tail survives");
});

test("P4 --add keeps the generated subject and appends the player's words to it", () => {
  const p = composePrompt(CARD, { add: "剑身上缠着褪色的红布" });
  assert.ok(p.includes("断刃"), "generated subject survives");
  assert.ok(p.includes("剑身上缠着褪色的红布"), "the addition is present");
  assert.ok(p.endsWith(STYLE_TAIL), "style tail survives");
  assert.ok(
    p.indexOf("剑身上缠着褪色的红布") < p.indexOf(STYLE_TAIL),
    "the addition sits inside the subject, before the style tail",
  );
});

test("P5 subject and add together put the player's content first", () => {
  const p = composePrompt(CARD, { subject: "一把断剑", add: "背景是雪原" });
  assert.ok(p.includes("一把断剑"), "subject present");
  assert.ok(p.includes("背景是雪原"), "addition present");
  assert.ok(p.indexOf("一把断剑") < p.indexOf("背景是雪原"), "subject comes before the addition");
  assert.ok(p.endsWith(STYLE_TAIL), "style tail survives");
});

test("P6 resolvePrompt reports which of the three modes ran", () => {
  assert.deepEqual(resolvePrompt(CARD, {}).mode, "composed");
  assert.equal(resolvePrompt(CARD, { subject: "x" }).mode, "composed+subject");
  assert.equal(resolvePrompt(CARD, { add: "x" }).mode, "composed+add");
  assert.equal(resolvePrompt(CARD, { prompt: "x" }).mode, "verbatim");
});

test("P7 --prompt wins over --subject and keeps nothing of the style", () => {
  const { prompt, mode } = resolvePrompt(CARD, { prompt: "a photo of a real sword", subject: "ignored" });
  assert.equal(mode, "verbatim");
  assert.equal(prompt, "a photo of a real sword", "the caller's text is used as-is");
  assert.ok(!prompt.includes(STYLE_TAIL), "no style tail is appended in verbatim mode");
});

// ---------------------------------------------------------------- reference pictures

test("R1 no reference at all means text-to-image", () => {
  const plan = planRefs({});
  assert.deepEqual(plan.files, []);
  assert.equal(plan.style, "none");
  assert.equal(plan.promptSuffix, "", "nothing to append when there is no picture");
});

test("R2 the game reference alone is used for style", () => {
  const plan = planRefs({ gameRef: "reference/cards/item-3.png" });
  assert.deepEqual(plan.files, ["reference/cards/item-3.png"]);
  assert.equal(plan.style, "game");
  assert.match(plan.promptSuffix, /Match the reference drawing's style and palette/);
});

test("R3 --ref replaces the game reference", () => {
  const plan = planRefs({ gameRef: "reference/cards/item-3.png", ref: "player.png" });
  assert.deepEqual(plan.files, ["player.png"], "a player picture wins over the tier reference");
  assert.equal(plan.style, "player");
});

test("R4 --ref-add keeps the game reference as image[1] and adds the player's as image[2]", () => {
  // The API supports several reference pictures for chat_image and lets the prompt name them,
  // so content and style can come from different files.
  const plan = planRefs({ gameRef: "reference/cards/item-3.png", refAdd: "player.png" });
  assert.deepEqual(plan.files, ["reference/cards/item-3.png", "player.png"], "order is the [image N] numbering");
  assert.equal(plan.style, "game+player");
  assert.match(plan.promptSuffix, /image\[1\]/, "the suffix names the style picture");
  assert.match(plan.promptSuffix, /image\[2\]/, "the suffix names the content picture");
});

test("R5 --ref-add without a tier reference falls back to the player's picture alone", () => {
  const plan = planRefs({ refAdd: "player.png" });
  assert.deepEqual(plan.files, ["player.png"]);
  assert.equal(plan.style, "player");
});
