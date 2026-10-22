#!/usr/bin/env node
/**
 * extensions test - the four path/validation tools register, and what they report.
 *
 *   node --test script/extensions.test.mjs
 *
 * Each tool is loaded from its real file, through the same factory pi calls (`registerTool`),
 * and its `execute` is called with a fake workspace. Nothing touches the real install: the
 * fixtures build a Steam library, an install and a mod root under a throwaway home, and the
 * one discovery test points HOME at an empty directory.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, cleanupAll, fakeLibrary, fakeModRoot, fakeVanilla, makeMod, tmpDir } from "./lib/fixture.mjs";
import { loadExtension } from "./lib/load-extension.mjs";

after(cleanupAll);

const loaded = new Map();
async function tool(file) {
  if (!loaded.has(file)) loaded.set(file, await loadExtension(file));
  return loaded.get(file);
}

/** What pi does with a tool call: `execute(id, params, signal, onUpdate, ctx)`. */
const run = (definition, params, cwd) =>
  definition.execute("test-call", params, undefined, undefined, { cwd });

/** The state file the path tools write in a workspace under test. */
const stateOf = (cwd) => path.join(cwd, ".gamer-agent.local.json");

/** The workshop content folder of a library: derived from the game, never passed in. */
const workshopOf = (lib) => path.join(lib, "steamapps", "workshop", "content", "3117820");

/** A recorded path under the home directory is written as `~/...`; expand it for comparison. */
const expandHome = (p, home) => String(p).replace(/^~/, home);

/** A whole world in a throwaway home: a Steam library, the install it names, the mod root. */
function fakeWorld() {
  const home = tmpDir("sudan-ext-home-");
  const lib = fakeLibrary(home);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  return { home, lib, install, vanilla: fakeVanilla(install), modRoot: fakeModRoot(home) };
}

/** A home discovery can walk: the Steam root where macOS keeps it, plus the Documents base. */
function discoverableWorld() {
  const home = tmpDir("sudan-ext-home-");
  const lib = fakeLibrary(path.join(home, "Library", "Application Support"));
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  return { home, lib, install, vanilla: fakeVanilla(install), modRoot: fakeModRoot(home) };
}

/**
 * Run `body` with HOME pointing at a throwaway directory. `os.homedir()` reads it, and
 * discovery walks that home for a Steam library and the Documents base.
 */
async function withHome(home, body) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("check_game_paths: a fake Steam library passes and derives the vanilla config", async () => {
  const world = fakeWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const result = await run(await tool("check-game-paths.ts"), { steam: world.lib, modRoot: world.modRoot }, cwd);
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.match(text, /^steam\s+OK/m, text);
  assert.match(text, /^vanilla\s+OK/m, text);
  assert.match(text, /^modRoot\s+OK/m, text);
  assert.match(text, /appmanifest_3117820\.acf/, text);
  assert.match(text, /^PASS: every required location is OK$/m, text);
  assert.equal(result.details.wroteState, false);
  assert.equal(existsSync(stateOf(cwd)), false);
});

test("check_game_paths: a library without the app manifest fails and names the sentinel", async () => {
  const cwd = tmpDir("sudan-ext-ws-");
  const empty = tmpDir("sudan-ext-empty-lib-");
  const result = await run(await tool("check-game-paths.ts"), { steam: empty }, cwd);
  const text = result.content[0].text;
  assert.equal(result.details.ok, false, text);
  assert.match(text, /^steam\s+FAIL/m, text);
  assert.match(text, /appmanifest_3117820\.acf/, text);
  assert.match(text, /^NEXT: /m, text);
  assert.ok(result.details.failed.includes("steam"), text);
  // A failed check is a business result: it changed nothing.
  assert.equal(existsSync(stateOf(cwd)), false);
});

test("set_game_dir: a directory that is none of the three is refused and nothing is written", async () => {
  const cwd = tmpDir("sudan-ext-ws-");
  const stray = tmpDir("sudan-ext-stray-");
  await assert.rejects(run(await tool("set-game-dir.ts"), { path: stray }, cwd), (error) => {
    assert.match(error.message, /INVALID_GAME_PATH/);
    assert.match(error.message, /appmanifest_3117820\.acf/);
    assert.match(error.message, /cards\.json/);
    assert.match(error.message, /ModLog/);
    assert.match(error.message, /NEXT:/);
    return true;
  });
  assert.equal(existsSync(stateOf(cwd)), false);
});

test("set_game_dir: a fake Steam library is recorded with the derived locations", async () => {
  const world = fakeWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const result = await withHome(world.home, async () => run(await tool("set-game-dir.ts"), { path: world.lib }, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.match(text, /^PASS: recorded /m, text);
  assert.equal(result.details.wroteState, true);
  const record = JSON.parse(readFileSync(stateOf(cwd), "utf8"));
  assert.equal(expandHome(record.gameDir, world.home), world.install);
  assert.equal(expandHome(record.vanillaDir, world.home), world.vanilla);
  assert.equal(expandHome(record.modInstallDir, world.home), world.modRoot);
  assert.equal(expandHome(record.workshopDir, world.home), workshopOf(world.lib));
  assert.deepEqual(readdirSync(cwd), [".gamer-agent.local.json"], "one state file, and no hidden folder left behind");
});

test("set_game_dir: a vanilla config and a mod root are classified, not guessed", async () => {
  const world = fakeWorld();
  for (const [key, target] of [
    ["vanillaDir", world.vanilla],
    ["modInstallDir", world.modRoot],
  ]) {
    const cwd = tmpDir("sudan-ext-ws-");
    const file = stateOf(cwd);
    writeFileSync(file, `${JSON.stringify({ gameDir: world.install, modInstallDir: world.modRoot })}\n`);

    const result = await run(await tool("set-game-dir.ts"), { path: target }, cwd);
    const text = result.content[0].text;
    assert.equal(result.details.ok, true, `${key}: ${text}`);
    assert.match(text, new RegExp(`classified as ${key}`), text);
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(path.basename(record[key]), key === "vanillaDir" ? "config" : "Mod", text);
  }
});

test("try_set_game_dir: a failed discovery writes nothing", async () => {
  const home = tmpDir("sudan-ext-empty-home-");
  const cwd = tmpDir("sudan-ext-ws-");
  const before = readdirSync(cwd).sort();
  const result = await withHome(home, async () => run(await tool("try-set-game-dir.ts"), {}, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, false, text);
  assert.match(text, /^FAIL: /m, text);
  assert.match(text, /^NEXT: /m, text);
  assert.equal(result.details.wroteState, false);
  assert.equal(existsSync(stateOf(cwd)), false);
  assert.deepEqual(readdirSync(cwd).sort(), before);
});

test("try_set_game_dir: an already correct record is left untouched", async () => {
  const world = fakeWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const file = stateOf(cwd);
  const body = {
    gameDir: world.install,
    vanillaDir: world.vanilla,
    modInstallDir: world.modRoot,
    workshopDir: workshopOf(world.lib),
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  const before = readFileSync(file, "utf8");

  const result = await run(await tool("try-set-game-dir.ts"), {}, cwd);
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.equal(result.details.status, "already", text);
  assert.match(text, /nothing written/, text);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("try_set_game_dir: discovery writes every derived key", async () => {
  const world = discoverableWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const result = await withHome(world.home, async () => run(await tool("try-set-game-dir.ts"), {}, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.equal(result.details.status, "recorded", text);
  const record = JSON.parse(readFileSync(stateOf(cwd), "utf8"));
  assert.equal(expandHome(record.gameDir, world.home), world.install);
  assert.equal(expandHome(record.vanillaDir, world.home), world.vanilla);
  assert.equal(expandHome(record.modInstallDir, world.home), world.modRoot);
  assert.equal(expandHome(record.workshopDir, world.home), workshopOf(world.lib));
});

test("try_set_game_dir: a rewrite keeps runtime and any key it does not own", async () => {
  const world = discoverableWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const file = stateOf(cwd);
  const runtime = { dotnet: "/usr/local/share/dotnet/dotnet", dotnetVersion: "8.0.1" };
  writeFileSync(file, `${JSON.stringify({ runtime, "some-other-tool": { keep: true } }, null, 2)}\n`);

  const result = await withHome(world.home, async () => run(await tool("try-set-game-dir.ts"), {}, cwd));
  assert.equal(result.details.ok, true, result.content[0].text);
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(record.runtime, runtime, "check_runtime owns this key");
  assert.deepEqual(record["some-other-tool"], { keep: true });
  assert.equal(expandHome(record.gameDir, world.home), world.install);
  assert.equal(expandHome(record.modInstallDir, world.home), world.modRoot);
});

test("check_game_paths: a missing state file is said plainly, not reported as a failure", async () => {
  const world = discoverableWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const result = await withHome(world.home, async () => run(await tool("check-game-paths.ts"), {}, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.equal(result.details.present, false, text);
  assert.match(text, /does not exist yet/, text);
  assert.equal(existsSync(stateOf(cwd)), false, "a check must not create the state file");
});

test("validate_mod: a missing vanilla config is PARTIAL with a next step", async () => {
  const mod = makeMod({});
  const missing = path.join(tmpDir("sudan-ext-no-vanilla-"), "config");
  const result = await run(await tool("mod-lint.ts"), { modDir: mod, vanilla: missing }, REPO);
  const text = result.content[0].text;
  assert.equal(result.details.status, "PARTIAL", text);
  assert.match(text, /^PARTIAL: 0 fail, /, text);
  assert.match(text, /vanilla config missing:/, text);
  assert.match(text, /^NEXT: /m, text);
  assert.equal(result.details.ok, false);
});

test("validate_mod: a lint error is FAIL and keeps the whole list in details", async () => {
  const world = fakeWorld();
  const mod = makeMod({}, { info: { name: "" } });
  const result = await run(await tool("mod-lint.ts"), { modDir: mod, vanilla: world.vanilla }, REPO);
  const text = result.content[0].text;
  assert.equal(result.details.status, "FAIL", text);
  assert.match(text, /^FAIL: \d+ fail, /, text);
  assert.match(text, /INFO_NAME/, text);
  assert.ok(result.details.results.some((r) => r.code === "INFO_NAME" && r.level === "FAIL"), text);
  assert.equal(result.details.counts.FAIL >= 1, true, text);
});

test("validate_mod: a missing mod folder throws instead of reporting FAIL", async () => {
  const missing = path.join(tmpDir("sudan-ext-ws-"), "nope");
  await assert.rejects(run(await tool("mod-lint.ts"), { modDir: missing }, REPO), /INVALID_MOD_DIR/);
});
