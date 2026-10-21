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
import { REPO, cleanupAll, fakeLibrary, fakeModRoot, fakeVanilla, tmpDir } from "./lib/fixture.mjs";

const SETUP = path.join(REPO, "tools/setup.mjs");
after(cleanupAll);

const run = (args) => spawnSync(process.execPath, [SETUP, ...args], { cwd: REPO, encoding: "utf8", timeout: 180000 });

/** The printed row for one location, in the `OK   <name> <path>` shape this check has always used. */
const lineOf = (out, name) => out.split("\n").find((l) => new RegExp(`^(OK|MISS|\\s{4})\\s+${name}\\s`).test(l)) ?? "";

/** A world where the game, its config and the mod root all exist. */
function world() {
  const root = tmpDir("sudan-setup-");
  const lib = fakeLibrary(root);
  const cfg = fakeVanilla(path.join(lib, "steamapps", "common", "Sultan's Game"));
  const mods = fakeModRoot(root);
  const file = path.join(tmpDir("sudan-pathfile-"), "paths.json");
  writeFileSync(file, `${JSON.stringify({ steam: lib, vanilla: cfg, modRoot: mods }, null, 2)}\n`);
  return { root, lib, cfg, mods, file };
}

test("--check reports the locations paths.mjs verified, in the existing OK/MISS shape", () => {
  const w = world();
  const r = run(["--check", "--paths", w.file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "steam"), /^OK\s+steam\s/);
  assert.ok(lineOf(r.stdout, "steam").includes(w.lib), lineOf(r.stdout, "steam"));
  assert.match(lineOf(r.stdout, "vanilla"), /^OK\s+vanilla\s/);
  assert.ok(lineOf(r.stdout, "vanilla").includes(w.cfg), lineOf(r.stdout, "vanilla"));
  assert.match(r.stdout, /All required files present\./);
});

test("--check MISSes a config that is gone and says the game is what is missing", () => {
  const w = world();
  writeFileSync(w.file, `${JSON.stringify({ steam: w.lib, vanilla: path.join(w.root, "gone"), modRoot: w.mods }, null, 2)}\n`);
  const r = run(["--check", "--paths", w.file]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(lineOf(r.stdout, "vanilla"), /^MISS\s+vanilla\s/);
  assert.match(r.stdout, /the game/i);
});

test("the check names the same vanilla directory as tools/paths.mjs", () => {
  const w = world();
  const fromPaths = spawnSync(process.execPath, [path.join(REPO, "tools/paths.mjs"), "check", "--paths", w.file], {
    cwd: REPO,
    encoding: "utf8",
  });
  const fromSetup = run(["--check", "--paths", w.file]);
  const vanillaRow = fromPaths.stdout.split("\n").find((l) => l.startsWith("vanilla")) ?? "";
  assert.ok(vanillaRow.includes(w.cfg), fromPaths.stdout);
  assert.ok(lineOf(fromSetup.stdout, "vanilla").includes(w.cfg), fromSetup.stdout);
});
