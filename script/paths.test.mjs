#!/usr/bin/env node
/**
 * paths test — the single file that answers "where is the game", and the answers it refuses.
 *
 *   node --test script/paths.test.mjs
 *
 * Every fixture is a throwaway directory that imitates a Steam library, a game install, an
 * `.acf`, a mod root or a workshop folder. The real install is never touched: a sentinel is
 * only worth having if a test can make it fail.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO, cleanupAll, fakeLibrary, fakeModRoot, fakeVanilla, tmpDir } from "./lib/fixture.mjs";
import { classify, judge } from "../tools/paths.mjs";

const PATHS = path.join(REPO, "tools/paths.mjs");
after(cleanupAll);

/** A state file in a throwaway directory. `.gamer-agent.local.json` is what the tools write. */
const stateFile = () => path.join(tmpDir("sudan-state-"), ".gamer-agent.local.json");

const run = (args, env) =>
  spawnSync(process.execPath, [PATHS, ...args], { cwd: REPO, encoding: "utf8", env: env ?? process.env });

/** The printed line for one location, whatever the alignment. */
const lineOf = (out, name) => out.split("\n").find((l) => new RegExp(`^${name}\\s`).test(l)) ?? "";

const MODULE = pathToFileURL(PATHS).href;

/**
 * A child process is the only honest place to put a fake home: `os.homedir()` is read inside
 * the module, and discovery walks that home for a Steam library.
 */
const SCRIPT_JUDGE = `
import { judge } from ${JSON.stringify(MODULE)};
const { rows } = judge({ platform: "darwin", home: process.env.SUDAN_TEST_HOME, env: {}, file: null });
const steam = rows.find((r) => r.name === "steam");
process.stdout.write(JSON.stringify({ steam: { status: steam.status, path: steam.path } }));
`;

/** The Windows branch, driven with a Windows-shaped home and ProgramFiles and no HOME at all. */
const SCRIPT_WIN = `
import { judge, modRootFor, steamCandidates } from ${JSON.stringify(MODULE)};
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
    modRoot: modRootFor({ platform: "win32", home }),
    candidates,
    modRootStatus: judged.rows.find((r) => r.name === "modRoot").status,
  }),
);
`;

// ---------------------------------------------------------------- step 1: one judgment

test("a fake library with the app manifest is OK and reports the fake location", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const cfg = fakeVanilla(path.join(lib, "steamapps", "common", "Sultan's Game"));
  const mods = fakeModRoot(root);
  const r = run(["check", "--steam", lib, "--vanilla", cfg, "--mod-root", mods, "--paths", stateFile()]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "steam"), /^steam\s+OK\b/);
  assert.ok(lineOf(r.stdout, "steam").includes(lib), lineOf(r.stdout, "steam"));
  assert.match(lineOf(r.stdout, "vanilla"), /^vanilla\s+OK\b/);
  assert.ok(lineOf(r.stdout, "vanilla").includes(cfg));
  assert.match(lineOf(r.stdout, "modRoot"), /^modRoot\s+OK\b/);
});

test("an app manifest whose installdir does not exist FAILs and names installdir", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root, { install: false });
  const r = run(["check", "--steam", lib, "--paths", stateFile()]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "steam"), /^steam\s+FAIL\b/);
  assert.match(lineOf(r.stdout, "steam"), /installdir/);
});

test("a library with no app manifest is not a game install", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root, { manifest: false });
  const r = run(["check", "--steam", lib, "--paths", stateFile()]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "steam"), /^steam\s+FAIL\b/);
  assert.match(lineOf(r.stdout, "steam"), /appmanifest_3117820\.acf/);
});

test("a vanilla config without cards.json FAILs and names the missing file", () => {
  const root = tmpDir();
  const cfg = fakeVanilla(root, { cards: false });
  const r = run(["check", "--vanilla", cfg, "--paths", stateFile()]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "vanilla"), /^vanilla\s+FAIL\b/);
  assert.match(lineOf(r.stdout, "vanilla"), /cards\.json/);
});

test("a vanilla config without rite/ is refused too, and the NEXT line points at the checker", () => {
  const root = tmpDir();
  const cfg = fakeVanilla(root, { rite: false });
  const r = run(["check", "--vanilla", cfg, "--paths", stateFile()]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "vanilla"), /rite/);
  assert.match(r.stdout, /^NEXT\s+\S/m);
});

test("a mod root nothing confirms is FAIL, not a guess", () => {
  const root = tmpDir();
  const mods = path.join(root, "elsewhere", "Mod");
  mkdirSync(mods, { recursive: true });
  const r = run(["check", "--mod-root", mods, "--paths", stateFile()]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "modRoot"), /^modRoot\s+FAIL\b/);
  assert.match(lineOf(r.stdout, "modRoot"), /ModLog/);
});

test("a mod root the game has not created yet is MISS, and says who creates it", () => {
  const root = tmpDir();
  const base = path.join(root, "home");
  mkdirSync(path.join(base, "DoubleCross", "SultansGame"), { recursive: true });
  const r = run(["check", "--mod-root", path.join(base, "DoubleCross", "SultansGame", "Mod"), "--paths", stateFile()]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "modRoot"), /^modRoot\s+MISS\b/);
  assert.match(lineOf(r.stdout, "modRoot"), /first launch/);
});

test("set refuses a location whose sentinel fails and writes nothing", () => {
  const root = tmpDir();
  const file = stateFile();
  const r = run(["set", "--vanilla", path.join(root, "not-a-config"), "--paths", file]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(existsSync(file), false, "set must not record a directory it could not verify");
  assert.match(r.stdout, /^FAIL\s/m);
});

test("set records the locations that pass, and check then reads them back", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const cfg = fakeVanilla(path.join(lib, "steamapps", "common", "Sultan's Game"));
  const mods = fakeModRoot(root);
  const file = stateFile();
  const set = run(["set", "--steam", lib, "--vanilla", cfg, "--mod-root", mods, "--paths", file]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.gameDir, path.join(lib, "steamapps", "common", "Sultan's Game"), JSON.stringify(saved));
  assert.equal(saved.vanillaDir, cfg);
  assert.equal(saved.modInstallDir, mods);
  assert.equal(saved.workshopDir, path.join(lib, "steamapps", "workshop", "content", "3117820"));

  // No flags at all: everything comes from the recorded file.
  const check = run(["check", "--paths", file]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(lineOf(check.stdout, "vanilla"), /^vanilla\s+OK\b/);
});

// ------------------------------------------------- step 2: the rest of the test table

test("a library on a second volume is found through libraryfolders.vdf", () => {
  const home = tmpDir("sudan-home-");
  const steam = path.join(home, "Library", "Application Support", "Steam");
  mkdirSync(path.join(steam, "config"), { recursive: true });

  // The second volume is where the game actually is; the default library only holds the Steam
  // client. Before this file was parsed, the macOS branch could not see it at all.
  const second = fakeLibrary(tmpDir("sudan-volume-"));
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
  assert.equal(got.steam.status, "OK", JSON.stringify(got.steam));
  assert.equal(got.steam.path, second);
});

test("an app manifest with no installdir key is FAIL and names installdir", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root, { installdir: null, install: false });
  const r = run(["check", "--steam", lib, "--paths", stateFile()]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "steam"), /^steam\s+FAIL\b/);
  assert.match(lineOf(r.stdout, "steam"), /installdir/);
});

test("an empty workshop directory is EMPTY, and check still exits 0", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const cfg = fakeVanilla(path.join(lib, "steamapps", "common", "Sultan's Game"));
  mkdirSync(path.join(lib, "steamapps", "workshop", "content", "3117820"), { recursive: true });
  const r = run(["check", "--steam", lib, "--vanilla", cfg, "--mod-root", fakeModRoot(root), "--paths", stateFile()]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "workshop"), /^workshop\s+EMPTY\b/);
});

test("--vanilla beats the recorded vanillaDir", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const recorded = fakeVanilla(path.join(lib, "steamapps", "common", "Sultan's Game"));
  const file = stateFile();
  writeFileSync(file, JSON.stringify({ vanillaDir: recorded }, null, 2));

  const explicit = fakeVanilla(tmpDir("sudan-other-"));
  const r = run(["check", "--vanilla", explicit, "--paths", file]);
  assert.match(lineOf(r.stdout, "vanilla"), /^vanilla\s+OK\b/);
  assert.ok(lineOf(r.stdout, "vanilla").includes(explicit), lineOf(r.stdout, "vanilla"));
  assert.ok(!lineOf(r.stdout, "vanilla").includes(recorded), "the explicit argument must win");
});

test("a stale recorded location is reported, not skipped for discovery", () => {
  const root = tmpDir();
  const stale = path.join(root, "gone", "config");
  const file = stateFile();
  writeFileSync(file, JSON.stringify({ vanillaDir: stale }, null, 2));
  const r = run(["check", "--paths", file]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "vanilla"), /^vanilla\s+MISS\b/);
  assert.ok(lineOf(r.stdout, "vanilla").includes(stale), "a recorded path that no longer exists must be named");
});

test("a state file that is absent is tolerated, and one that is broken is reported", () => {
  const missing = path.join(tmpDir("sudan-state-"), "nothing.json");
  const clean = run(["check", "--paths", missing]);
  assert.ok(!/WARN/.test(clean.stdout), clean.stdout);
  assert.equal(judge({ platform: "darwin", home: tmpDir(), env: {}, file: missing }).present, false);

  const broken = stateFile();
  writeFileSync(broken, "{ not json ");
  const r = run(["check", "--paths", broken]);
  assert.match(r.stdout, /^WARN\s+.*not valid JSON/m);
  assert.equal(judge({ platform: "darwin", home: tmpDir(), env: {}, file: broken }).present, true);
});

test("the Windows shape joins with a backslash and needs no HOME", () => {
  const r = spawnSync(process.execPath, ["-e", SCRIPT_WIN], {
    cwd: REPO,
    encoding: "utf8",
    env: { SUDAN_TEST_PROGRAMFILES: "C:\\Program Files", SUDAN_TEST_PROGRAMFILES_X86: "C:\\Program Files (x86)" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.modRoot, "C:\\Users\\tester\\Documents\\DoubleCross\\SultansGame\\Mod");
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

test("the legacy steamapps/libraryfolders.vdf is read as well as config/", () => {
  const home = tmpDir("sudan-home-");
  const steam = path.join(home, "Library", "Application Support", "Steam");
  mkdirSync(path.join(steam, "steamapps"), { recursive: true });
  const second = fakeLibrary(tmpDir("sudan-volume-"));
  // Pre-2021 Steam kept the list here; both copies must be read, not just the new one.
  writeFileSync(
    path.join(steam, "steamapps", "libraryfolders.vdf"),
    `"LibraryFolders"
{\n\t"1"\n\t{\n\t\t"path"\t\t"${second}"\n\t}\n}\n`,
  );
  const got = judge({ platform: "darwin", home, env: {}, file: null });
  const steamRow = got.rows.find((r) => r.name === "steam");
  assert.equal(steamRow.status, "OK", JSON.stringify(steamRow));
  assert.equal(steamRow.path, second);
});

test("the state file beats discovery, and an explicit argument beats the state file", () => {
  const home = tmpDir("sudan-home-");
  const discoverable = fakeLibrary(path.join(home, "Library", "Application Support"));
  const recordedLib = fakeLibrary(tmpDir("sudan-recorded-"));
  const recorded = path.join(recordedLib, "steamapps", "common", "Sultan's Game");
  const pinned = fakeLibrary(tmpDir("sudan-pinned-"));
  const file = stateFile();
  writeFileSync(file, `${JSON.stringify({ gameDir: pinned }, null, 2)}\n`);

  // Without a file, discovery finds the library under the fake home.
  const discovered = judge({ platform: "darwin", home, env: {}, file: null });
  assert.equal(discovered.rows.find((r) => r.name === "steam").path, discoverable);

  // The recorded install wins over that discovery.
  const fromFile = judge({ platform: "darwin", home, env: {}, file });
  assert.equal(fromFile.rows.find((r) => r.name === "steam").path, pinned);

  // An explicit game directory wins over the record, and the install it names is the
  // gameDir that would be written.
  const fromArgument = judge({ platform: "darwin", home, env: {}, file, steam: recorded });
  const steamRow = fromArgument.rows.find((r) => r.name === "steam");
  assert.equal(steamRow.path, recordedLib);
  assert.equal(steamRow.install, recorded);
});

test("set writes every derived key and keeps the keys it does not own", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const cfg = fakeVanilla(path.join(lib, "steamapps", "common", "Sultan's Game"));
  const mods = fakeModRoot(root);
  const file = stateFile();
  writeFileSync(file, `${JSON.stringify({ runtime: { dotnet: "/usr/local/bin/dotnet" }, note: "another tool" }, null, 2)}\n`);

  const r = run(["set", "--steam", lib, "--vanilla", cfg, "--mod-root", mods, "--paths", file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.gameDir, path.join(lib, "steamapps", "common", "Sultan's Game"));
  assert.equal(saved.vanillaDir, cfg);
  assert.equal(saved.modInstallDir, mods);
  assert.equal(saved.workshopDir, path.join(lib, "steamapps", "workshop", "content", "3117820"));
  assert.deepEqual(saved.runtime, { dotnet: "/usr/local/bin/dotnet" }, "a write must not drop a key it does not own");
  assert.equal(saved.note, "another tool");
});

test("--steam accepts the install folder, and the recorded gameDir is that install", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeVanilla(install);
  const file = stateFile();
  const r = run(["set", "--steam", install, "--mod-root", fakeModRoot(root), "--paths", file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).gameDir, install);
});

test("classify names the state-file key each sentinel belongs to", () => {
  const root = tmpDir();
  const lib = fakeLibrary(root);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  const cfg = fakeVanilla(install);
  const mods = fakeModRoot(root);
  assert.equal(classify(lib).key, "gameDir");
  assert.equal(classify(install).key, "gameDir");
  assert.equal(classify(cfg).key, "vanillaDir", "an exact vanilla config is not the game");
  assert.equal(classify(mods).key, "modInstallDir");
  assert.equal(classify(tmpDir()).key, null);
});
