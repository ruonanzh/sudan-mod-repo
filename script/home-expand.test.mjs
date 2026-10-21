#!/usr/bin/env node
/**
 * home-expand test — `~` is expanded with os.homedir(), never with process.env.HOME.
 *
 *   node --test script/home-expand.test.mjs
 *
 * Windows has no HOME variable. A tool that reads it there silently gets "" and then either
 * reads `/something` or throws on a relative path. So every test here deletes HOME from the
 * child process and asks the tool to say where it looked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO } from "./lib/fixture.mjs";
import { gameDir } from "../tools/i18n-probe.mjs";

const HOME = os.homedir();
const SAVE = path.join(REPO, "tools/save.mjs");
const I18N = path.join(REPO, "tools/i18n-probe.mjs");
const GAME = path.join(HOME, "Library/Application Support/Steam/steamapps/common/Sultan's Game");
const I18N_TABLE = path.join(GAME, "Sultan's Game.app/Contents/Resources/Data/StreamingAssets/i18n");

/** A child process that looks like Windows: no HOME, no SULTAN_GAME_DIR. */
const envWithoutHome = () => {
  const env = { ...process.env };
  delete env.HOME;
  delete env.SULTAN_GAME_DIR;
  return env;
};

test("save.mjs expands ~ with os.homedir() when HOME is unset", () => {
  const r = spawnSync(process.execPath, [SAVE, "get", "--save", "~/.sudan-no-such-save.json", "--path", "round"], {
    cwd: REPO,
    encoding: "utf8",
    env: envWithoutHome(),
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(
    r.stdout.includes(path.join(HOME, ".sudan-no-such-save.json")),
    `the message must name the expanded path, got: ${r.stdout}`,
  );
  assert.ok(!r.stdout.includes(": /.sudan"), `a ~ path became a root path: ${r.stdout}`);
});

test("i18n-probe.mjs reads its default game directory from os.homedir()", () => {
  assert.equal(
    gameDir({}),
    path.join(
      HOME,
      "Library/Application Support/Steam/steamapps/common/Sultan's Game/Sultan's Game.app/Contents/Resources/Data",
    ),
  );
  assert.equal(gameDir({ SULTAN_GAME_DIR: "/tmp/game" }), "/tmp/game");
  assert.ok(!gameDir({}).startsWith("Library"), "the default must be absolute");
});

test("i18n-probe.mjs runs on a machine with no HOME", () => {
  const r = spawnSync(process.execPath, [I18N], { cwd: REPO, encoding: "utf8", env: envWithoutHome() });
  if (existsSync(I18N_TABLE)) {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /translation table/);
  } else {
    assert.notEqual(r.status, 0);
    assert.ok(
      r.stderr.includes(path.join(HOME, "Library/Application Support/Steam")) || r.stdout.includes(HOME),
      `the failure must name an absolute path under the home directory: ${r.stderr || r.stdout}`,
    );
  }
});
