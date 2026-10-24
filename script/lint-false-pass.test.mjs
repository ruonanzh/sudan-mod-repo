/**
 * The checks that used to answer PASS without looking: a table record the directory branch never
 * saw, a weight that can never be picked, a cross-mod clash outside cards, and a missing vanilla
 * config that exited 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, makeMod } from "./lib/fixture.mjs";
import { DEFAULT_VANILLA } from "../tools/model.mjs";

const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, process.env.HOME || "");
const skip = existsSync(path.join(VANILLA, "cards.json")) ? false : "the game's config is not installed on this machine";

const lint = (args, env = {}) =>
  spawnSync(process.execPath, [path.join(REPO, "tools/lint.mjs"), ...args, "--vanilla", VANILLA], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("a quest target written under the table is checked", { skip }, () => {
  const mod = makeMod({
    "config/quest.json": JSON.stringify({ 1: { id: 1, target: [{ type: "card", id: 2000001, nosuchkey: 1 }] } }),
  });
  const r = lint([mod]);
  assert.match(r.stdout, /UNKNOWN_FIELD/, "the unknown key inside target is reported");
});

test("a single-object config is checked field by field", { skip }, () => {
  const mod = makeMod({ "config/game.json": JSON.stringify({ nosuchkey: 1 }) });
  const r = lint([mod]);
  assert.match(r.stdout, /UNKNOWN_FIELD/, "unknown key in game.json is reported");
});

test("an explicit ---vanilla directory without the sentinels is refused", { skip }, () => {
  const empty = mkdtempSync(path.join(tmpdir(), "vanilla-empty-"));
  const mod = makeMod({ "config/cards.json": "{}\n" });
  const r = spawnSync(process.execPath, [path.join(REPO, "tools/lint.mjs"), mod, "--vanilla", empty], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /VANILLA_INCOMPLETE|VANILLA_MISSING/);
});

test("two mods that define the same dialogue tree id collide", { skip }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "modroot-dt-"));
  for (const name of ["a", "b"]) {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, "config/dt"), { recursive: true });
    writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name, version: "1.0.0" }));
    writeFileSync(path.join(dir, `config/dt/${name.toUpperCase()}1.json`), JSON.stringify({ dialog_tree_id: "DT9", Item: [] }));
  }
  const r = spawnSync(process.execPath, [path.join(REPO, "tools/lint.mjs"), "--mod-root", root, "--vanilla", VANILLA], { encoding: "utf8" });
  assert.match(r.stdout, /ID_CROSS_MOD/);
});

test("a loot weight of zero or less is a failure, not a silent no-op", { skip }, () => {
  const mod = makeMod({
    "config/loot/6000777.json": JSON.stringify({ id: 6000777, repeat: 1, type: 2, item: [{ type: "card", id: 2000001, num: 1, weight: 0 }] }),
  });
  const r = lint([mod]);
  assert.match(r.stdout, /LOOT_WEIGHT/, "LOOT_WEIGHT is reported");
  assert.equal(r.status, 1, "and the exit code says FAIL");
});

test("a rite id defined by two mods in one root is a cross-mod collision", { skip }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "modroot-"));
  for (const name of ["a", "b"]) {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, "config/rite"), { recursive: true });
    writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name, version: "1.0.0" }));
    writeFileSync(path.join(dir, `config/rite/${name === "a" ? "5000001" : "5000001"}.json`), JSON.stringify({ id: 5000001 }));
  }
  const r = spawnSync(process.execPath, [path.join(REPO, "tools/lint.mjs"), "--mod-root", root, "--vanilla", VANILLA], { encoding: "utf8" });
  assert.match(r.stdout, /ID_CROSS_MOD/, "the rite id appears in the report");
});

test("a missing vanilla config is a FAIL with a non-zero exit, not a warning", () => {
  const home = mkdtempSync(path.join(tmpdir(), "novanilla-"));
  const mod = makeMod({ "config/cards.json": "{}\n" });
  const r = spawnSync(process.execPath, [path.join(REPO, "tools/lint.mjs"), mod], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, GAMER_AGENT_NO_DISCOVERY: "1" },
  });
  assert.match(r.stdout, /VANILLA_MISSING/, "the reason is named");
  assert.equal(r.status, 1, "exit code is not 0");
});

test("every edit route asks for a real PASS, not merely no FAIL", () => {
  for (const name of ["record-edited", "loot-edited", "upgrade-edited", "card-edited", "card-art-edited"]) {
    const text = readFileSync(path.join(REPO, ".pi/prompts", `${name}.md`), "utf8");
    assert.match(text, /必须 \*\*PASS\*\*/, `${name} names the verdict it needs`);
    assert.match(text, /PARTIAL/, `${name} says PARTIAL does not count`);
  }
});
