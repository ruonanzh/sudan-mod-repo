#!/usr/bin/env node
/**
 * contracts test - the sentences and wiring the path/lint tools promise, not just their verdicts.
 *
 *   node --test script/contracts.test.mjs
 *
 * Why a second file: `extensions.test.mjs` proves the judgments (OK / MISS / FAIL). Mutation runs
 * showed that deleting a whole `NEXT:` branch, swapping a PARTIAL message, or dropping the
 * `--vanilla` argument all left the suite green. A tool whose advice is wrong is worse than one
 * that fails: the agent follows the sentence. So every promise here is asserted literally.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, cleanupAll, fakeGame, fakeLibrary, fakeModRoot, fakeVanilla, makeMod, tmpDir } from "./lib/fixture.mjs";
import { loadExtension } from "./lib/load-extension.mjs";

after(cleanupAll);

const loaded = new Map();
async function tool(file) {
  if (!loaded.has(file)) loaded.set(file, await loadExtension(file));
  return loaded.get(file);
}
const run = (definition, params, cwd) => definition.execute("c", params, undefined, undefined, { cwd });
const textOf = (result) => (result.content || []).map((c) => c.text || "").join("\n");
const stateOf = (cwd) => path.join(cwd, ".gamer-agent.local.json");

async function withHome(home, body) {
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A library whose game is complete: the bundle, the game's files and the vanilla config. */
function world() {
  const home = tmpDir("contract-home-");
  const lib = fakeLibrary(path.join(home, "Library", "Application Support"));
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install);
  fakeVanilla(install);
  fakeModRoot(home);
  return { home, lib, install };
}

// ---------------------------------------------- check_game_paths: the advice, not just the verdict

test("a failed check tells the agent to find the game, not to start it", async () => {
  const { home } = world();
  const def = await tool("check-game-paths.ts");
  const cwd = tmpDir("contract-ws-");
  const result = await withHome(home, () =>
    run(def, { gameDir: path.join(home, "nowhere") }, cwd),
  );
  const text = textOf(result);
  assert.match(text, /FAIL: gameDir/, text);
  assert.equal((text.match(/^NEXT:/gm) || []).length, 1, "exactly one next step, or the agent has to choose");
  assert.match(text, /NEXT: run try_set_game_dir/, "the path failure must name the discovery tool");
  assert.equal(result.details.wroteState, false);
});

test("a missing mod root tells the agent to launch the game once, not to search", async () => {
  // The game is fine; only the mod root is absent, which is what a fresh home looks like.
  const home = tmpDir("contract-nomod-");
  const lib = fakeLibrary(path.join(home, "Library", "Application Support"));
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install);
  fakeVanilla(install);
  const def = await tool("check-game-paths.ts");
  const cwd = tmpDir("contract-ws-");
  const result = await withHome(home, () => run(def, { gameDir: install }, cwd));
  const text = textOf(result);
  assert.match(text, /modInstallDir/, text);
  assert.match(text, /Start the game once/, "a missing mod root must not send the agent hunting the game");
});

// ---------------------------------------------- validate_mod: PASS, PARTIAL, and the vanilla flag

const vanillaOf = (install) =>
  path.join(install, "Sultan's Game.app/Contents/Resources/Data/StreamingAssets/config");

test("validate_mod reports PASS on a clean mod when the vanilla config is given", async () => {
  const { install } = world();
  const cwd = REPO;
  const def = await tool("mod-lint.ts");
  const result = await run(def, { modDir: makeMod({}), vanilla: vanillaOf(install) }, cwd);
  const text = textOf(result);
  assert.match(text, /^PASS: 0 fail/, text);
  assert.equal(result.details.errors ?? result.details.counts.FAIL, 0, text);
});

test("validate_mod with a missing vanilla config is PARTIAL and names the checks it skipped", async () => {
  const cwd = REPO;
  const def = await tool("mod-lint.ts");
  const result = await run(
    def,
    { modDir: makeMod({}), vanilla: path.join(cwd, "no-config") },
    cwd,
  );
  const text = textOf(result);
  assert.match(text, /^PARTIAL: 0 fail/, text);
  assert.match(text, /id-collision and tag checks did not run/, "the skipped checks must be named");
  assert.match(text, /vanilla=/, "NEXT must name the parameter that fixes it");
});

test("validate_mod really passes --vanilla: a colliding id fails only when the config is given", async () => {
  const { install } = world();
  const vanilla = vanillaOf(install);
  writeFileSync(path.join(vanilla, "cards.json"), JSON.stringify({ 9876543: { id: 9876543, name: "原版卡" } }));
  const mod = makeMod({
    "config/cards.json": JSON.stringify({ 9876543: { id: 9876543, name: "我的卡" } }),
  });
  const cwd = REPO;
  const def = await tool("mod-lint.ts");

  const given = await run(def, { modDir: mod, vanilla }, cwd);
  const missing = await run(def, { modDir: mod, vanilla: path.join(cwd, "no-config") }, cwd);

  const codes = (r) => (r.details.results || []).map((x) => x.code);
  assert.ok(
    codes(given).includes("ID_OVERRIDES_VANILLA"),
    "the collision is reported only if --vanilla reaches the linter",
  );
  assert.equal(missing.details.status, "PARTIAL", textOf(missing));
  assert.ok(!codes(missing).includes("ID_OVERRIDES_VANILLA"), "skipped checks must not claim to have run");
});

// ---------------------------------------------- the schema is the contract the agent reads

test("each tool registers the name the skill tells the agent to use", async () => {
  const skill = readFileSync(path.join(REPO, ".pi/skills/setup-workspace/SKILL.md"), "utf8");
  for (const [file, name] of [
    ["check-game-paths.ts", "check_game_paths"],
    ["set-game-dir.ts", "set_game_dir"],
    ["try-set-game-dir.ts", "try_set_game_dir"],
  ]) {
    const def = await tool(file);
    assert.equal(def.name, name, file);
    assert.ok(skill.includes(name), `the skill must name ${name}`);
  }
  // validate_mod is a mandatory step in mod-creator; a tool no skill names is a tool no agent calls.
  const creator = readFileSync(path.join(REPO, ".pi/skills/mod-creator/SKILL.md"), "utf8");
  assert.equal((await tool("mod-lint.ts")).name, "validate_mod");
  assert.ok(creator.includes("validate_mod"), "mod-creator must name validate_mod");
  const installer = readFileSync(path.join(REPO, ".pi/skills/mod-installer/SKILL.md"), "utf8");
  assert.equal((await tool("install-mod.ts")).name, "install_mod");
  assert.ok(installer.includes("install_mod"), "mod-installer must name install_mod");
});

test("the declared parameters are the ones execute reads", async () => {
  // A rename on one side only is invisible to a test that passes the same string to both.
  const check = await tool("check-game-paths.ts");
  const keys = Object.keys(check.parameters.properties || check.parameters.schema?.properties || {});
  assert.deepEqual(keys.sort(), ["gameDir", "modInstallDir", "workshopDir"], "check_game_paths params");

  const lint = await tool("mod-lint.ts");
  const lintKeys = Object.keys(lint.parameters.properties || lint.parameters.schema?.properties || {});
  assert.deepEqual(lintKeys.sort(), ["modDir", "vanilla"], "validate_mod params");
});

// ---------------------------------------------- workshops are references, never failures

test("a missing workshop is reported but never fails the run", async () => {
  const { home, install } = world();
  const cwd = tmpDir("contract-ws-");
  const def = await tool("check-game-paths.ts");
  const result = await withHome(home, () =>
    run(def, { gameDir: install, workshopDir: path.join(home, "no-workshop") }, cwd),
  );
  const row = (result.details.rows || []).find((r) => r.name === "workshopDir");
  assert.ok(row, "the workshop row is always reported");
  assert.notEqual(row.status, "FAIL", "a reference never fails the check");
  assert.equal(result.details.ok, true, "nothing required was wrong");
});

// ---------------------------------------------- the derived lines say where each path comes from

test("derived lines name the real source of each path", async () => {
  const { home, install } = world();
  const cwd = tmpDir("contract-ws-");
  const def = await tool("set-game-dir.ts");
  const result = await withHome(home, () => run(def, { path: install }, cwd));
  const text = textOf(result);
  assert.match(text, /vanilla \(derived from gameDir\)/, text);
  assert.match(text, /modInstallDir \(from MyDocuments, not from gameDir\)/, text);
  assert.match(text, /workshopDir \(derived from gameDir\)/, text);
  assert.equal(result.details.wroteState, true, "recording is a write, and it must say so");
});

test("a check never claims to have written anything", async () => {
  const { home, install } = world();
  const cwd = tmpDir("contract-ws-");
  const def = await tool("check-game-paths.ts");
  const result = await withHome(home, () => run(def, { gameDir: install }, cwd));
  assert.equal(result.details.wroteState, false);
  assert.equal(existsSync(stateOf(cwd)), false, "check must not create the state file");
});
