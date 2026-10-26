#!/usr/bin/env node
/**
 * setup-check test — `tools/setup.mjs --check` judges the game the same way every other tool does.
 *
 *   node --test script/setup-check.test.mjs
 *
 * The check used to have its own candidate list, and the macOS branch of that list held one
 * hardcoded path, so a second Steam library was invisible. Now the check asks `tools/paths.mjs`,
 * and `--paths <file>` makes the answer fakeable, which is what lets these tests describe a
 * world without touching the real install.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, cleanupAll, fakeGame, fakeLibrary, fakeModRoot, fakeVanilla, tmpDir } from "./lib/fixture.mjs";
import { shorten } from "../tools/paths.mjs";

/** A path as the report prints it: `/` on every platform, and `~` under the home directory. */
const shown = (p) => shorten(p);

const SETUP = path.join(REPO, "tools/setup.mjs");
after(cleanupAll);

const run = (args) => spawnSync(process.execPath, [SETUP, ...args], { cwd: REPO, encoding: "utf8", timeout: 180000 });

/** The printed row for one location, in the `OK   <name> <path>` shape this check has always used. */
const lineOf = (out, name) => out.split("\n").find((l) => new RegExp(`^(OK|MISS|\\s{4})\\s+${name}\\s`).test(l)) ?? "";

/** A world where the game, its config and the mod install directory all exist, and a state file
 *  that names the two recorded keys. The vanilla config is derived, never recorded. */
function world({ config = true } = {}) {
  const root = tmpDir("sudan-setup-");
  const lib = fakeLibrary(root);
  const install = path.join(lib, "steamapps", "common", "Sultan's Game");
  fakeGame(install);
  const cfg = config ? fakeVanilla(install) : null;
  const mods = fakeModRoot(root);
  const file = path.join(tmpDir("sudan-state-"), ".gamer-agent.local.json");
  writeFileSync(file, `${JSON.stringify({ gameDir: install, modInstallDir: mods }, null, 2)}\n`);
  return { root, lib, install, cfg, mods, file };
}

test("--check reports the locations paths.mjs verified, in the existing OK/MISS shape", () => {
  const w = world();
  const r = run(["--check", "--paths", w.file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "gameDir"), /^OK\s+gameDir\s/);
  assert.ok(lineOf(r.stdout, "gameDir").includes(shown(w.install)), lineOf(r.stdout, "gameDir"));
  assert.match(lineOf(r.stdout, "vanilla"), /^OK\s+vanilla\s/);
  assert.ok(lineOf(r.stdout, "vanilla").includes(shown(w.cfg)), lineOf(r.stdout, "vanilla"));
  // The stand-ins install_mod and card-art copy are required files too: a missing one is silent
  // in the tool (it skips the placeholder), so the check must name it.
  assert.match(r.stdout, /^OK\s+reference\/placeholders\/preview\.png$/m);
  assert.match(r.stdout, /^OK\s+reference\/placeholders\/card\.png$/m);
  assert.match(r.stdout, /All required files present\./);
});

test("--check MISSes a game directory that is gone and names the game", () => {
  const w = world();
  writeFileSync(w.file, `${JSON.stringify({ gameDir: path.join(w.root, "gone", "Sultan's Game"), modInstallDir: w.mods }, null, 2)}\n`);
  const r = run(["--check", "--paths", w.file]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "gameDir"), /^MISS\s+gameDir\s/);
  assert.match(r.stdout, /The game was not found/);
});

test("--check MISSes a config the install does not have, and names the fix", () => {
  const w = world({ config: false });
  writeFileSync(w.file, `${JSON.stringify({ gameDir: w.install, modInstallDir: w.mods }, null, 2)}\n`);
  const r = run(["--check", "--paths", w.file]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "vanilla"), /^MISS\s+vanilla\s/);
  assert.match(r.stdout, /The game's config was not found/);
});

test("the check names the same vanilla directory as tools/paths.mjs", () => {
  const w = world();
  const fromPaths = spawnSync(process.execPath, [path.join(REPO, "tools/paths.mjs"), "check", "--paths", w.file], {
    cwd: REPO,
    encoding: "utf8",
  });
  const fromSetup = run(["--check", "--paths", w.file]);
  const vanillaRow = fromPaths.stdout.split("\n").find((l) => l.startsWith("vanilla")) ?? "";
  assert.ok(vanillaRow.includes(shown(w.cfg)), fromPaths.stdout);
  assert.ok(lineOf(fromSetup.stdout, "vanilla").includes(shown(w.cfg)), fromSetup.stdout);
});
