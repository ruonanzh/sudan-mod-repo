#!/usr/bin/env node
/**
 * extensions test - the path tools register, and what they report.
 *
 *   node --test script/extensions.test.mjs
 *
 * Each tool is loaded from its real file, through the same factory pi calls (`registerTool`),
 * and its `execute` is called with a fake workspace. Nothing touches the real install: the
 * fixtures build a Steam library, an install that holds the game's own files, and a mod install
 * directory under a throwaway home; the tests that need discovery to fail point HOME at an
 * empty directory.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, cleanupAll, fakeGame, fakeLibrary, fakeModRoot, fakeVanilla, makeMod, tmpDir } from "./lib/fixture.mjs";
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

/**
 * Run `body` with HOME pointing at a throwaway directory. `os.homedir()` reads it, and
 * discovery walks that home for a Steam library and the MyDocuments base.
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

/** A whole world in a throwaway home: a library, the install it names, the game's files, the config. */
function fakeWorld() {
  const home = tmpDir("sudan-ext-home-");
  const lib = fakeLibrary(home);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install);
  return { home, lib, install, vanilla: fakeVanilla(install), mods: fakeModRoot(home) };
}

/** The same world where discovery can walk to it: the macOS Steam root, plus the Documents base. */
function discoverableWorld() {
  const home = tmpDir("sudan-ext-home-");
  const lib = fakeLibrary(path.join(home, "Library", "Application Support"));
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install);
  return { home, lib, install, vanilla: fakeVanilla(install), mods: fakeModRoot(home) };
}

test("check_game_paths: a fake install passes and derives the vanilla config", async () => {
  const world = fakeWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const result = await run(await tool("check-game-paths.ts"), { gameDir: world.install, modInstallDir: world.mods }, cwd);
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.match(text, /^gameDir\s+OK/m, text);
  assert.match(text, /^vanilla\s+OK/m, text);
  assert.match(text, /^modInstallDir\s+OK/m, text);
  assert.match(text, /Contents\/Frameworks\/GameAssembly\.dylib/, text);
  assert.match(text, /^PASS: every required location is OK$/m, text);
  assert.equal(result.details.wroteState, false);
  assert.equal(existsSync(stateOf(cwd)), false);
});

test("check_game_paths: neither the app manifest nor the library makes a game directory", async () => {
  const root = tmpDir("sudan-ext-lib-");
  const lib = fakeLibrary(root); // the .acf names steamapps/common/Sultan's Game, which is empty
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  const cwd = tmpDir("sudan-ext-ws-");
  for (const candidate of [install, lib]) {
    const result = await run(await tool("check-game-paths.ts"), { gameDir: candidate }, cwd);
    const text = result.content[0].text;
    assert.equal(result.details.ok, false, text);
    assert.match(text, /^gameDir\s+FAIL/m, text);
    assert.match(text, /Contents\/Frameworks\/GameAssembly\.dylib/, text);
    assert.ok(result.details.failed.includes("gameDir"), text);
  }
  assert.equal(existsSync(stateOf(cwd)), false);
});

test("check_game_paths: nothing given and nothing recorded says so", async () => {
  const cwd = tmpDir("sudan-ext-ws-");
  const result = await run(await tool("check-game-paths.ts"), {}, cwd);
  const text = result.content[0].text;
  assert.equal(result.details.ok, false, text);
  assert.equal(result.details.reason, "NOTHING_TO_CHECK");
  assert.match(text, /^FAIL: nothing to check/m, text);
  assert.match(text, /^NEXT: /m, text);
  assert.equal(existsSync(stateOf(cwd)), false);
});

test("check_game_paths: the recorded paths are checked when nothing is passed", async () => {
  const world = fakeWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  writeFileSync(stateOf(cwd), `${JSON.stringify({ gameDir: world.install, modInstallDir: world.mods })}\n`);
  const result = await withHome(world.home, async () => run(await tool("check-game-paths.ts"), {}, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.equal(result.details.present, true, text);
  assert.match(text, /^gameDir\s+OK/m, text);
  assert.match(text, /^vanilla\s+OK/m, text);
  assert.match(text, /^modInstallDir\s+OK/m, text);
});

test("set_game_dir: a game directory is recorded with what it derives, and vanillaDir is not stored", async () => {
  const world = fakeWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const result = await withHome(world.home, async () => run(await tool("set-game-dir.ts"), { path: world.install }, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.match(text, /^PASS:/, text);
  assert.match(text, /^PASS: recorded gameDir /m, text);
  assert.equal(result.details.wroteState, true);
  const record = JSON.parse(readFileSync(stateOf(cwd), "utf8"));
  assert.equal(expandHome(record.gameDir, world.home), world.install);
  assert.equal(expandHome(record.modInstallDir, world.home), world.mods);
  assert.equal(expandHome(record.workshopDir, world.home), workshopOf(world.lib));
  assert.equal("vanillaDir" in record, false, `vanillaDir must be derived, never recorded: ${JSON.stringify(record)}`);
  assert.deepEqual(readdirSync(cwd), [".gamer-agent.local.json"], "one state file, and no hidden folder left behind");
});

test("set_game_dir: a path that is not the game falls back to discovery and says so", async () => {
  const world = discoverableWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const stray = tmpDir("sudan-ext-stray-");
  const result = await withHome(world.home, async () => run(await tool("set-game-dir.ts"), { path: stray }, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, true, text);
  assert.match(text, /^WARN:/, text);
  assert.match(text, /^WARN: the gameDir you passed .* did not pass validation/m, text);
  assert.match(text, /^Recorded .* instead\.$/m, text);
  assert.equal(result.details.wroteState, true);
  const record = JSON.parse(readFileSync(stateOf(cwd), "utf8"));
  assert.equal(expandHome(record.gameDir, world.home), world.install, "the discovered path is the one in use");
});

test("set_game_dir: nothing validates and nothing is discovered writes nothing", async () => {
  const home = tmpDir("sudan-ext-empty-home-");
  const cwd = tmpDir("sudan-ext-ws-");
  const stray = tmpDir("sudan-ext-stray-");
  const result = await withHome(home, async () => run(await tool("set-game-dir.ts"), { path: stray }, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, false, text);
  assert.match(text, /^FAIL:/, text);
  assert.match(text, /^FAIL: could not record gameDir\./m, text);
  assert.match(text, /^NEXT: /m, text);
  assert.equal(result.details.wroteState, false);
  assert.equal(existsSync(stateOf(cwd)), false);
});

test("try_set_game_dir: a failed discovery writes nothing", async () => {
  const home = tmpDir("sudan-ext-empty-home-");
  const cwd = tmpDir("sudan-ext-ws-");
  const before = readdirSync(cwd).sort();
  const result = await withHome(home, async () => run(await tool("try-set-game-dir.ts"), {}, cwd));
  const text = result.content[0].text;
  assert.equal(result.details.ok, false, text);
  assert.equal(result.details.reason, "GAME_DIRECTORY_NOT_FOUND");
  assert.match(text, /^FAIL: gameDir not found/m, text);
  assert.match(text, /^NEXT: /m, text);
  assert.equal(result.details.wroteState, false);
  assert.equal(existsSync(stateOf(cwd)), false);
  assert.deepEqual(readdirSync(cwd).sort(), before);
});

test("try_set_game_dir: discovery records the derived keys once, and a second call writes nothing", async () => {
  const world = discoverableWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  const first = await withHome(world.home, async () => run(await tool("try-set-game-dir.ts"), {}, cwd));
  assert.equal(first.details.ok, true, first.content[0].text);
  assert.match(first.content[0].text, /^PASS: gameDir discovered and recorded/, first.content[0].text);
  assert.equal(first.details.wroteState, true);
  assert.match(first.content[0].text, /^PASS: gameDir discovered and recorded/m, first.content[0].text);
  const record = JSON.parse(readFileSync(stateOf(cwd), "utf8"));
  assert.equal(expandHome(record.gameDir, world.home), world.install);
  assert.equal(expandHome(record.modInstallDir, world.home), world.mods);
  assert.equal(expandHome(record.workshopDir, world.home), workshopOf(world.lib));
  assert.equal("vanillaDir" in record, false, `vanillaDir must be derived, never recorded: ${JSON.stringify(record)}`);

  const before = readFileSync(stateOf(cwd), "utf8");
  const second = await withHome(world.home, async () => run(await tool("try-set-game-dir.ts"), {}, cwd));
  assert.equal(second.details.ok, true, second.content[0].text);
  assert.match(second.content[0].text, /^PASS: gameDir already correct/, second.content[0].text);
  assert.equal(second.details.wroteState, false);
  assert.equal(readFileSync(stateOf(cwd), "utf8"), before, "a second call must not rewrite the file");
});

test("try_set_game_dir: a stale record is replaced by the discovered game", async () => {
  const world = discoverableWorld();
  const cwd = tmpDir("sudan-ext-ws-");
  writeFileSync(stateOf(cwd), `${JSON.stringify({ gameDir: path.join(world.home, "gone", "Sultan's Game") })}\n`);
  const result = await withHome(world.home, async () => run(await tool("try-set-game-dir.ts"), {}, cwd));
  assert.equal(result.details.ok, true, result.content[0].text);
  assert.match(result.content[0].text, /^PASS: gameDir discovered and recorded/, result.content[0].text);
  const record = JSON.parse(readFileSync(stateOf(cwd), "utf8"));
  assert.equal(expandHome(record.gameDir, world.home), world.install);
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
  assert.equal(expandHome(record.modInstallDir, world.home), world.mods);
});

test("validate_mod: a missing vanilla config is PARTIAL with a next step", async () => {
  const mod = makeMod({});
  const missing = path.join(tmpDir("sudan-ext-no-vanilla-"), "config");
  const result = await run(await tool("mod-lint.ts"), { modDir: mod, vanilla: missing }, REPO);
  const text = result.content[0].text;
  assert.match(text, /^PARTIAL:/, text);
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
  assert.match(text, /^FAIL:/, text);
  assert.match(text, /^FAIL: \d+ fail, /, text);
  assert.match(text, /INFO_NAME/, text);
  assert.ok(result.details.results.some((r) => r.code === "INFO_NAME" && r.level === "FAIL"), text);
  assert.equal(result.details.counts.FAIL >= 1, true, text);
});

test("validate_mod: a missing mod folder throws instead of reporting FAIL", async () => {
  const missing = path.join(tmpDir("sudan-ext-ws-"), "nope");
  await assert.rejects(run(await tool("mod-lint.ts"), { modDir: missing }, REPO), /INVALID_MOD_DIR/);
});
