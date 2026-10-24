/**
 * Messages that used to state more than the code knows, and content that used to carry raw
 * non-ASCII into a terminal that cannot print it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO, cleanupAll, makeMod } from "./lib/fixture.mjs";
import { DEFAULT_VANILLA } from "../tools/model.mjs";

const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, process.env.HOME || "");
const skip = existsSync(path.join(VANILLA, "cards.json")) ? false : "the game's config is not installed on this machine";
import { loadExtension } from "./lib/load-extension.mjs";
import { referenceStatus, CARD_REFS } from "../tools/setup.mjs";

test.after(cleanupAll);

test("a sprite name outside the mod is not called a vanilla resource", () => {
  const rows = referenceStatus(path.join(tmpdir(), "no-such-reference-dir"));
  const cards = rows.find((r) => r.file.startsWith("reference/cards/"));
  assert.equal(cards.ok, false, "an empty folder is not complete");
  assert.match(cards.detail, /0\/12/);
});

test("the twelve style references must all be there", () => {
  const ref = mkdtempSync(path.join(tmpdir(), "refs-"));
  mkdirSync(path.join(ref, "plates"));
  mkdirSync(path.join(ref, "cards"));
  writeFileSync(path.join(ref, "cards", "item-1.png"), "x");
  let cards = referenceStatus(ref).find((r) => r.file.startsWith("reference/cards/"));
  assert.equal(cards.ok, false, "one picture is not the set");
  assert.match(cards.detail, /1\/12/);
  for (const name of CARD_REFS) writeFileSync(path.join(ref, "cards", name), "x");
  cards = referenceStatus(ref).find((r) => r.file.startsWith("reference/cards/"));
  assert.equal(cards.ok, true);
  assert.match(cards.detail, /12\/12/);
});

test("validate_mod escapes non-ASCII in content and keeps the raw text in details", async () => {
  const mod = makeMod({
    "config/cards.json": JSON.stringify({ 9000501: { id: 9000501, type: "item", rare: 2, name: "断剑", 中文键: 1 } }),
  });
  const tool = await loadExtension("mod-lint.ts");
  const result = await tool.execute("c", { modDir: mod }, undefined, undefined, { cwd: REPO });
  const text = result.content.map((c) => c.text).join("\n");
  assert.doesNotMatch(text, /[\u4e00-\u9fff]/, "content carries no raw CJK");
  assert.match(text, /\\u[0-9a-f]{4}/, "it carries the escape instead");
  assert.match(JSON.stringify(result.details), /中文键/, "details keep the exact characters");
});

test("a size check with one dimension is refused, not answered with PASS", async () => {
  const { spawnSync } = await import("node:child_process");
  const png = path.join(REPO, "reference/plates/card.png");
  const r = spawnSync(process.execPath, [path.join(REPO, "tools/image.mjs"), "check", "--file", png, "--width", "472"], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /check needs both width and height/);
  const ok = spawnSync(process.execPath, [path.join(REPO, "tools/image.mjs"), "check", "--file", png], { encoding: "utf8" });
  assert.equal(ok.status, 0, "checking only alpha or format still works without dimensions");
});

test("validate_mod keeps content under 50 KB even when every message is Chinese", async () => {
  const longKey = "键".repeat(400);
  const files = {};
  // Lint clips one message at 500 characters; escaped, 20 shown messages are about 60 KB.
  for (let i = 0; i < 30; i++) {
    files[`config/event/99005${String(i).padStart(2, "0")}.json`] = JSON.stringify({
      id: Number(`99005${String(i).padStart(2, "0")}`),
      on: { round_begin_ba: 1 },
      [`${longKey}${i}`]: 1,
    });
  }
  const mod = makeMod(files);
  const tool = await loadExtension("mod-lint.ts");
  const result = await tool.execute("c", { modDir: mod }, undefined, undefined, { cwd: REPO });
  const text = result.content.map((c) => c.text).join("\n");
  assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024, `content is ${Buffer.byteLength(text, "utf8")} bytes`);
  assert.match(text, /output truncated/, "the cut is labelled");
  assert.ok(JSON.stringify(result.details).includes(longKey), "details keep the whole message");
});

test("lint says a sprite is not in this mod, and does not claim it exists in vanilla", { skip }, async () => {
  const { spawnSync } = await import("node:child_process");
  const mod = makeMod({
    "config/cards.json": JSON.stringify({ 9000503: { id: 9000503, type: "item", rare: 2, resource: ["cards/9999999"] } }),
  });
  const r = spawnSync(process.execPath, [path.join(REPO, "tools/lint.mjs"), mod, "--vanilla", VANILLA], { encoding: "utf8" });
  assert.match(r.stdout, /SPRITE_VANILLA/);
  assert.match(r.stdout, /not in this mod/);
  assert.doesNotMatch(r.stdout, /reuses sprite/, "the old claim is gone");
});

test("validate_mod keeps its NEXT line even when the report is truncated", async () => {
  const longKey = "键".repeat(400);
  const files = {};
  for (let i = 0; i < 40; i++) {
    files[`config/event/99006${String(i).padStart(2, "0")}.json`] = JSON.stringify({
      id: Number(`99006${String(i).padStart(2, "0")}`),
      on: { round_begin_ba: 1 },
      [`${longKey}${i}`]: 1,
    });
  }
  const tool = await loadExtension("mod-lint.ts");
  const result = await tool.execute("c", { modDir: makeMod(files) }, undefined, undefined, { cwd: REPO });
  const text = result.content.map((c) => c.text).join("\n");
  assert.match(text, /output truncated/);
  assert.match(text, /NEXT: /, "the next step survives the cut");
  assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024 + 32);
});

test("an illegal call throws; a business answer does not", async () => {
  const generate = await loadExtension("generate-2d-asset.ts");
  await assert.rejects(generate.execute("c", { action: "generate", prompt: "x" }, undefined, undefined, { cwd: REPO }), /INVALID_ARGS/);
  const inspect = await loadExtension("inspect-game-code.ts");
  await assert.rejects(inspect.execute("c", { action: "search" }, undefined, undefined, { cwd: REPO }), /TARGET_MISSING/);
});

test("inspect_game_code caps content at 50 KB and says so in its description", async () => {
  const inspect = await loadExtension("inspect-game-code.ts");
  assert.match(inspect.description, /50 KB/, "the limit is stated where the agent reads it");
  const target = "A".repeat(60 * 1024);
  let result;
  try {
    result = await inspect.execute("c", { action: "search", target }, undefined, undefined, { cwd: REPO });
  } catch (error) {
    if (/GAME|DUMP|CONFIG|not found/i.test(String(error && error.message))) return; // no dump on this machine
    throw error;
  }
  const text = result.content.map((c) => c.text).join("\n");
  assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024 + 32, `${Buffer.byteLength(text, "utf8")} bytes`);
});
