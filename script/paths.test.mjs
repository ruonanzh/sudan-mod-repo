#!/usr/bin/env node
/**
 * paths test — the single file that answers "where is the game", and the answers it refuses.
 *
 *   node --test script/paths.test.mjs
 *
 * Every fixture is a throwaway directory that imitates a Steam library, a game install, the
 * game's own files, a mod install directory or a workshop folder. The real install is never
 * touched: a sentinel is only worth having if a test can make it fail.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO, cleanupAll, fakeGame, fakeLibrary, fakeModRoot, fakeVanilla, gameInstall, tmpDir } from "./lib/fixture.mjs";
import { GAME_MARKERS, REQUIRED, judge } from "../tools/paths.mjs";

const PATHS = path.join(REPO, "tools/paths.mjs");
after(cleanupAll);

/** A state file in a throwaway directory. `.gamer-agent.local.json` is what the tools write. */
const stateFile = () => path.join(tmpDir("sudan-state-"), ".gamer-agent.local.json");

/**
 * The CLI, with HOME pointed at a throwaway home when one is given: `os.homedir()` reads it, and
 * both discovery and the MyDocuments base follow it, so nothing here can see the real install.
 */
const run = (args, home) =>
  spawnSync(process.execPath, [PATHS, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: home ? { ...process.env, HOME: home, USERPROFILE: home } : process.env,
  });

/** The printed line for one location, whatever the alignment. */
const lineOf = (out, name) => out.split("\n").find((l) => new RegExp(`^${name}\\s`).test(l)) ?? "";

/** A path the way the report prints it: under the fake home it is shortened to `~/...`, and the
 *  report prints `/` on every platform because the agent copies these lines into chat. */
const shown = (p, home) => String(p).replace(home, "~").split(path.sep).join("/");

/** The inverse, for a value read back from the state file: the file holds native paths. */
const expandHome = (p, home) => String(p).replace(/^~/, home).split("/").join(path.sep);

const MODULE = pathToFileURL(PATHS).href;

/** The fixture is a macOS install and the CLI judges the host, so this belongs to macOS. */
const MAC_ONLY =
  process.platform === "win32" ? "the fixture is a macOS install, and the CLI judges the host" : false;
/** Windows discovery walks real drive letters, so a fake home cannot isolate a fallback to it. */
const HOST_DISCOVERY =
  process.platform === "win32" ? "Windows discovery walks the real drives, so a fake home cannot isolate it" : false;

/**
 * A child process is the only honest place to put a fake home: `os.homedir()` is read inside
 * the module, and discovery walks that home for a Steam library.
 */
const SCRIPT_JUDGE = `
import { judge } from ${JSON.stringify(MODULE)};
const { rows } = judge({ platform: "darwin", home: process.env.SUDAN_TEST_HOME, env: {}, file: null });
const game = rows.find((r) => r.name === "gameDir");
const vanilla = rows.find((r) => r.name === "vanilla");
process.stdout.write(JSON.stringify({ game: { status: game.status, path: game.path }, vanilla: { status: vanilla.status, path: vanilla.path } }));
`;

/** The Windows branch, driven with a Windows-shaped home and ProgramFiles and no HOME at all. */
const SCRIPT_WIN = `
import { GAME_MARKERS, judge, modInstallDirFor, steamCandidates } from ${JSON.stringify(MODULE)};
const home = ${JSON.stringify("C:\\Users\\tester")};
const env = {
  ProgramFiles: process.env.SUDAN_TEST_PROGRAMFILES,
  "ProgramFiles(x86)": process.env.SUDAN_TEST_PROGRAMFILES_X86,
};
const candidates = steamCandidates({ platform: "win32", home, env });
const judged = judge({ platform: "win32", home, env, file: null });
process.stdout.write(
  JSON.stringify({
    home,
    modInstallDir: modInstallDirFor({ platform: "win32", home }),
    candidates,
    modInstallStatus: judged.rows.find((r) => r.name === "modInstallDir").status,
    windowsMarkers: GAME_MARKERS.windows,
  }),
);
`;

/**
 * A world under a throwaway home that discovery can walk to: the macOS Steam root with a
 * library, the install it names, the game's own files, the vanilla config and the mod
 * install directory beside the game's log.
 */
function homeWorld({ manifest = true, game = true, config = true, platform = process.platform } = {}) {
  const home = tmpDir("sudan-home-");
  // The CLI judges the host platform, so the discovery root and the install shape follow it.
  // fakeLibrary appends "Steam" itself; Windows discovery looks for <home>/Steam on its drive walk.
  const steamRoot = platform === "win32" ? home : path.join(home, "Library", "Application Support");
  const lib = fakeLibrary(steamRoot, { manifest });
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  if (game) fakeGame(install, { platform });
  const vanilla = config ? fakeVanilla(install, { platform }) : null;
  const mods = fakeModRoot(home);
  return { home, lib, install, vanilla, mods };
}

// ------------------------------------------------- the game sentinel is a file inside the game

test("a folder holding the game's own files is OK, and the vanilla config is derived", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install);
  const config = fakeVanilla(install);
  fakeModRoot(root);
  const r = run(["check", "--game-dir", install, "--paths", stateFile()], root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const game = lineOf(r.stdout, "gameDir");
  assert.match(game, /^gameDir\s+OK\b/, r.stdout);
  assert.ok(game.includes(gameInstall(install).dllLabel), `the sentinel that decided it must be named: ${game}`);
  assert.match(lineOf(r.stdout, "vanilla"), /^vanilla\s+OK\b/);
  assert.ok(lineOf(r.stdout, "vanilla").includes(shown(config, root)), r.stdout);
  assert.match(lineOf(r.stdout, "modInstallDir"), /^modInstallDir\s+OK\b/);
});

test("an app manifest alone is not the game: the install and the library both FAIL", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root); // the .acf names steamapps/common/Sultan's Game, which is empty
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeModRoot(root);
  for (const candidate of [install, lib]) {
    const r = run(["check", "--game-dir", candidate, "--paths", stateFile()], root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const game = lineOf(r.stdout, "gameDir");
    assert.match(game, /^gameDir\s+FAIL\b/, r.stdout);
    assert.ok(game.includes(gameInstall(install).dllLabel), `the sentinel must be named: ${game}`);
  }
});

test("either macOS marker passes, and the one that exists is the reason reported", { skip: MAC_ONLY }, () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install, { dylib: false });
  fakeVanilla(install);
  fakeModRoot(root);
  const ok = run(["check", "--game-dir", install, "--paths", stateFile()], root);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(lineOf(ok.stdout, "gameDir").includes("il2cpp_data"), ok.stdout);

  const bare = path.join(fakeLibrary(tmpDir()), "steamapps", "common", "Sultan's Game");
  fakeVanilla(bare);
  const failed = run(["check", "--game-dir", bare, "--paths", stateFile()], root);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(lineOf(failed.stdout, "gameDir"), /^gameDir\s+FAIL\b/);
});

test("the install is accepted through the app bundle or a folder inside it", { skip: MAC_ONLY }, () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install);
  fakeVanilla(install);
  fakeModRoot(root);
  for (const candidate of [path.join(install, "Sultan's Game.app"), path.join(install, "Sultan's Game.app/Contents")]) {
    const r = run(["check", "--game-dir", candidate, "--paths", stateFile()], root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(
      lineOf(r.stdout, "gameDir").includes(shown(install, root)),
      `the folder that holds the bundle is the game directory: ${lineOf(r.stdout, "gameDir")}`,
    );
  }
});

test("the Windows sentinel is judged by walking a fake install, not by reading the constant", async () => {
  // The shape used to be asserted against the constant, which proves nothing: the constant was
  // wrong (GameAssembly.dll lives in the install root, not under _Data) and the test agreed with
  // it. Judge real directories instead.
  const { judgeGameDir } = await import(pathToFileURL(PATHS).href);

  const right = tmpDir("sudan-win-ok-");
  writeFileSync(path.join(right, "GameAssembly.dll"), "x");
  mkdirSync(path.join(right, "Sultan's Game_Data", "il2cpp_data"), { recursive: true });
  assert.equal(judgeGameDir(right, "win32").status, "OK", "install root with both files must pass");

  const wrong = tmpDir("sudan-win-bad-");
  mkdirSync(path.join(wrong, "Sultan's Game_Data"), { recursive: true });
  writeFileSync(path.join(wrong, "Sultan's Game_Data", "GameAssembly.dll"), "x");
  mkdirSync(path.join(wrong, "Sultan's Game_Data", "il2cpp_data"), { recursive: true });
  assert.notEqual(judgeGameDir(wrong, "win32").status, "OK", "GameAssembly.dll under _Data is not the sentinel");

  const source = readFileSync(PATHS, "utf8");
  assert.match(source, /Windows UNVERIFIED/, "the Windows branch must say it was not measured");
});

// ------------------------------------------------ the vanilla config is derived, never recorded

test("the vanilla row is derived from the game, and a recorded vanillaDir is ignored", () => {
  const world = homeWorld();
  const file = stateFile();
  writeFileSync(file, JSON.stringify({ gameDir: world.install, vanillaDir: path.join(world.home, "gone", "config") }));
  const r = run(["check", "--paths", file], world.home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(lineOf(r.stdout, "vanilla").includes(shown(world.vanilla, world.home)), `the derived config must win: ${r.stdout}`);
  assert.ok(!r.stdout.includes("gone"), "a retired key must not be read");
});

test("a vanilla config without cards.json FAILs and names the missing file", () => {
  const world = homeWorld({ config: false });
  fakeVanilla(world.install, { cards: false });
  const r = run(["check", "--game-dir", world.install, "--paths", stateFile()], world.home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "vanilla"), /^vanilla\s+FAIL\b/);
  assert.match(lineOf(r.stdout, "vanilla"), /cards\.json/);
});

test("a vanilla config without rite/ is refused too, and NEXT points at the setter", () => {
  const world = homeWorld({ config: false });
  fakeVanilla(world.install, { rite: false });
  const r = run(["check", "--game-dir", world.install, "--paths", stateFile()], world.home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "vanilla"), /rite/);
  assert.match(r.stdout, /^NEXT:?\s+\S/m);
});

// ------------------------------------------------------------- what the report is allowed to say

test("the report has four rows with the new names, and the workshop is not required", () => {
  const { rows } = judge({ platform: "darwin", home: tmpDir(), env: {}, file: null });
  assert.deepEqual(
    rows.map((r) => r.name),
    ["gameDir", "vanilla", "modInstallDir", "workshopDir"],
  );
  assert.deepEqual(REQUIRED, ["gameDir", "vanilla", "modInstallDir"]);
  const world = homeWorld();
  const r = run(["check", "--game-dir", world.install, "--paths", stateFile()], world.home);
  // The retired row names, assembled so the state-file scan does not match this line.
  for (const name of [`ste${"am"}`, `mod${"Root"}`, `du${"mp"}`, `ve${"nv"}`]) {
    assert.equal(lineOf(r.stdout, name), "", `the report must not carry a ${name} row:\n${r.stdout}`);
  }
});

// ------------------------------------------------------------------- what set records, and what not

test("set records the derived keys, and never stores vanillaDir", () => {
  const world = homeWorld();
  const file = stateFile();
  const set = run(["set", "--game-dir", world.install, "--paths", file], world.home);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(expandHome(saved.gameDir, world.home), world.install, JSON.stringify(saved));
  assert.equal(expandHome(saved.modInstallDir, world.home), world.mods);
  assert.equal(
    expandHome(saved.workshopDir, world.home),
    path.join(world.lib, "steamapps", "workshop", "content", "3117820"),
  );
  assert.equal("vanillaDir" in saved, false, `vanillaDir is derived on every read: ${JSON.stringify(saved)}`);

  // No flags at all: everything comes from the recorded file.
  const check = run(["check", "--paths", file], world.home);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(lineOf(check.stdout, "vanilla"), /^vanilla\s+OK\b/);
});

test("set drops a retired vanillaDir the file still carries", () => {
  const world = homeWorld();
  const file = stateFile();
  writeFileSync(file, JSON.stringify({ gameDir: world.install, vanillaDir: "/nowhere/config" }, null, 2));
  const r = run(["set", "--game-dir", world.install, "--paths", file], world.home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal("vanillaDir" in JSON.parse(readFileSync(file, "utf8")), false);
});

test("set refuses a location that is not the game and writes nothing", { skip: HOST_DISCOVERY }, () => {
  const root = tmpDir();
  const file = stateFile();
  const r = run(["set", "--game-dir", path.join(tmpDir("sudan-stray-"), "not-the-game"), "--paths", file], root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(existsSync(file), false, "set must not record a directory it could not verify");
  assert.match(r.stdout, /^FAIL\s/m);
  assert.match(r.stdout, /^NEXT:?\s/m);
});

test("set finds the game when the given path does not validate, and says so", { skip: HOST_DISCOVERY }, () => {
  const world = homeWorld();
  const file = stateFile();
  const stray = tmpDir("sudan-stray-");
  const r = run(["set", "--game-dir", stray, "--paths", file], world.home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^WARN\s/m);
  assert.equal(expandHome(JSON.parse(readFileSync(file, "utf8")).gameDir, world.home), world.install);
});

// ---------------------------------------------------------------- the mod install directory

test("a mod install directory the game has not created yet is MISS, and says who creates it", () => {
  const root = tmpDir();
  const base = path.join(root, "home");
  mkdirSync(path.join(base, "DoubleCross", "SultansGame"), { recursive: true });
  const mods = path.join(base, "DoubleCross", "SultansGame", "Mod");
  const r = run(["check", "--mod-install", mods, "--paths", stateFile()], base);
  assert.match(lineOf(r.stdout, "modInstallDir"), /^modInstallDir\s+MISS\b/);
  assert.match(lineOf(r.stdout, "modInstallDir"), /first launch/);
});

test("a mod install directory nothing confirms is FAIL, not a guess", () => {
  const root = tmpDir();
  const mods = path.join(root, "elsewhere", "Mod");
  mkdirSync(mods, { recursive: true });
  const r = run(["check", "--mod-install", mods, "--paths", stateFile()], root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "modInstallDir"), /^modInstallDir\s+FAIL\b/);
  assert.match(lineOf(r.stdout, "modInstallDir"), /ModLog/);
});

// ----------------------------------------------------------------------------- discovery

test("a library without the app manifest is still walked, because the manifest is only a hint", { skip: HOST_DISCOVERY }, () => {
  const world = homeWorld({ manifest: false });
  const r = spawnSync(process.execPath, ["-e", SCRIPT_JUDGE], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, SUDAN_TEST_HOME: world.home },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.game.status, "OK", JSON.stringify(got));
  assert.equal(got.game.path, world.install);
  assert.equal(got.vanilla.path, world.vanilla);
});

test("a library on a second volume is found through libraryfolders.vdf", () => {
  const home = tmpDir("sudan-home-");
  const steam = path.join(home, "Library", "Application Support", "Steam");
  mkdirSync(path.join(steam, "config"), { recursive: true });

  // The second volume is where the game actually is; the default library only holds the Steam
  // client. Before this file was parsed, the macOS branch could not see it at all.
  const second = fakeLibrary(tmpDir("sudan-volume-"));
  const install = path.join(second, "steamapps", "common", "Sultan's Game");
  fakeGame(install, { platform: "darwin" });
  writeFileSync(
    path.join(steam, "config", "libraryfolders.vdf"),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${second}"\n\t}\n}\n`,
  );

  const r = spawnSync(process.execPath, ["-e", SCRIPT_JUDGE], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, SUDAN_TEST_HOME: home },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.game.status, "OK", JSON.stringify(got));
  assert.equal(got.game.path, install);
});

test("the legacy steamapps/libraryfolders.vdf is read as well as config/", () => {
  const home = tmpDir("sudan-home-");
  const steam = path.join(home, "Library", "Application Support", "Steam");
  mkdirSync(path.join(steam, "steamapps"), { recursive: true });
  const second = fakeLibrary(tmpDir("sudan-volume-"));
  const install = path.join(second, "steamapps", "common", "Sultan's Game");
  fakeGame(install, { platform: "darwin" });
  // Pre-2021 Steam kept the list here; both copies must be read, not just the new one.
  writeFileSync(
    path.join(steam, "steamapps", "libraryfolders.vdf"),
    `"LibraryFolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${second}"\n\t}\n}\n`,
  );
  const got = judge({ platform: "darwin", home, env: {}, file: null });
  const game = got.rows.find((r) => r.name === "gameDir");
  assert.equal(game.status, "OK", JSON.stringify(game));
  assert.equal(game.path, install);
});

test("the state file beats discovery, and an explicit argument beats the state file", () => {
  const world = homeWorld({ platform: "darwin" });
  const recorded = fakeLibrary(tmpDir("sudan-recorded-"));
  const recordedInstall = path.join(recorded, "steamapps", "common", "Sultan's Game");
  fakeGame(recordedInstall, { platform: "darwin" });
  const pinned = fakeLibrary(tmpDir("sudan-pinned-"));
  const pinnedInstall = path.join(pinned, "steamapps", "common", "Sultan's Game");
  fakeGame(pinnedInstall, { platform: "darwin" });
  const file = stateFile();
  writeFileSync(file, `${JSON.stringify({ gameDir: recordedInstall }, null, 2)}\n`);

  const gameOf = (opts) => judge({ platform: "darwin", home: world.home, env: {}, file, ...opts }).rows.find((r) => r.name === "gameDir");

  assert.equal(gameOf({ file: null }).path, world.install, "without a file, discovery finds the library under the home");
  assert.equal(gameOf({}).path, recordedInstall, "the recorded install wins over discovery");
  assert.equal(gameOf({ gameDir: pinnedInstall }).path, pinnedInstall, "an explicit game directory wins over the record");
});

test("a stale recorded game directory is reported, not skipped for discovery", { skip: HOST_DISCOVERY }, () => {
  const world = homeWorld();
  const stale = path.join(world.home, "gone", "Sultan's Game");
  const file = stateFile();
  writeFileSync(file, JSON.stringify({ gameDir: stale }, null, 2));
  const r = run(["check", "--paths", file], world.home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "gameDir"), /^gameDir\s+MISS\b/);
  assert.ok(
    lineOf(r.stdout, "gameDir").includes(shown(stale, world.home)),
    "a recorded path that no longer exists must be named",
  );
});

test("a state file that is absent is tolerated, and one that is broken is reported", () => {
  const missing = path.join(tmpDir("sudan-state-"), "nothing.json");
  const home = homeWorld().home;
  const clean = run(["check", "--paths", missing], home);
  assert.ok(!/WARN/.test(clean.stdout), clean.stdout);
  assert.equal(judge({ platform: "darwin", home, env: {}, file: missing }).present, false);

  const broken = stateFile();
  writeFileSync(broken, "{ not json ");
  const r = run(["check", "--paths", broken], home);
  assert.match(r.stdout, /^WARN\s+.*not valid JSON/m);
  assert.equal(judge({ platform: "darwin", home, env: {}, file: broken }).present, true);
});

test("an empty workshop directory is EMPTY, and check still exits 0", () => {
  const world = homeWorld();
  mkdirSync(path.join(world.lib, "steamapps", "workshop", "content", "3117820"), { recursive: true });
  const r = run(["check", "--game-dir", world.install, "--paths", stateFile()], world.home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "workshopDir"), /^workshopDir\s+EMPTY\b/);
});

test("the Windows shape joins with a backslash and needs no HOME", () => {
  const r = spawnSync(process.execPath, ["-e", SCRIPT_WIN], {
    cwd: REPO,
    encoding: "utf8",
    env: { SUDAN_TEST_PROGRAMFILES: "C:\\Program Files", SUDAN_TEST_PROGRAMFILES_X86: "C:\\Program Files (x86)" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.modInstallDir, "C:\\Users\\tester\\Documents\\DoubleCross\\SultansGame\\Mod");
  assert.ok(
    got.candidates.includes("C:\\Program Files (x86)\\Steam"),
    `ProgramFiles-derived root missing: ${JSON.stringify(got.candidates)}`,
  );
  assert.ok(got.candidates.includes("D:\\SteamLibrary"), JSON.stringify(got.candidates));
  assert.ok(
    got.candidates.every((c) => !c.includes("/")),
    `a Windows candidate must not be a POSIX path: ${JSON.stringify(got.candidates)}`,
  );
});
