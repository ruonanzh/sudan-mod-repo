#!/usr/bin/env node
/**
 * install_mod - copies a mod into the game's mod folder, and refuses the cases that destroy work.
 *
 *   node --test script/install-mod.test.mjs
 *
 * The install directory is read from `.gamer-agent.local.json`, never guessed, so each test
 * writes the state file it wants instead of relying on the machine's real install.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupAll, fakeModRoot, makeMod, tmpDir } from "./lib/fixture.mjs";
import { loadExtension } from "./lib/load-extension.mjs";

after(cleanupAll);

let tool;
const get = async () => (tool ??= await loadExtension("install-mod.ts"));
const run = (def, params, cwd) => def.execute("c", params, undefined, undefined, { cwd });
const textOf = (r) => r.content.map((c) => c.text).join("\n");

/** A mod install directory that passes the real sentinel (ModLog/__mod.log). */
const modRoot = () => fakeModRoot(tmpDir("install-base-"));

/** A workspace that has recorded one mod install directory. */
function workspace(root) {
  const cwd = tmpDir("install-ws-");
  if (root) writeFileSync(path.join(cwd, ".gamer-agent.local.json"), JSON.stringify({ modInstallDir: root }));
  return cwd;
}

test("install_mod copies the whole folder under the recorded directory", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": "{}\n", "preview.png": "x" });
  const result = await run(await get(), { modDir: mod }, cwd);
  const text = textOf(result);
  const target = path.join(root, path.basename(mod));

  assert.equal(result.details.status, "PASS", text);
  assert.ok(existsSync(path.join(target, "info.json")), text);
  assert.ok(existsSync(path.join(target, "config/cards.json")), text);
  assert.equal(result.details.files, 3, "info.json, config/cards.json and preview.png");
  assert.match(text, /^NEXT: .*enable the mod/m, "the player must be told to enable it");
});

test("install_mod replaces the previous copy instead of merging into it", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": "{}\n" });
  const target = path.join(root, path.basename(mod));
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "stale.json"), "{}");

  const result = await run(await get(), { modDir: mod }, cwd);
  assert.equal(result.details.replaced, true, textOf(result));
  assert.equal(existsSync(path.join(target, "stale.json")), false, "a dropped file must not survive an update");
  assert.equal(result.details.files, 2);
});

test("install_mod refuses a folder with no info.json", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const bare = tmpDir("install-bare-");
  writeFileSync(path.join(bare, "config.json"), "{}");
  await assert.rejects(run(await get(), { modDir: bare }, cwd), /INVALID_MOD/);
});

test("install_mod refuses malformed info.json", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({});
  writeFileSync(path.join(mod, "info.json"), "{ not json");
  await assert.rejects(run(await get(), { modDir: mod }, cwd), /INVALID_MOD/);
});

test("install_mod reports PARTIAL when no mod directory is recorded", async () => {
  const cwd = workspace(null);
  const mod = makeMod({});
  // An empty home keeps discovery from finding this machine's real install: the test must not
  // write into it.
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpDir("install-empty-home-");
  process.env.USERPROFILE = process.env.HOME;
  let result;
  try {
    result = await run(await get(), { modDir: mod }, cwd);
  } finally {
    process.env.HOME = before.HOME;
    if (before.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = before.USERPROFILE;
  }
  const text = textOf(result);
  assert.equal(result.details.status, "PARTIAL", text);
  assert.match(text, /start the game once/, "the fix is to start the game, not to create folders");
  assert.equal(result.details.installed, false);
});

test("install_mod refuses to copy a folder onto itself", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const inside = path.join(root, "MyMod");
  mkdirSync(inside, { recursive: true });
  writeFileSync(path.join(inside, "info.json"), JSON.stringify({ name: "MyMod" }));
  await assert.rejects(run(await get(), { modDir: inside }, cwd), /UNSAFE_TARGET/);
});

test("install_mod never edits the mod it installs", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": '{"a":1}\n' });
  const before = readFileSync(path.join(mod, "config/cards.json"), "utf8");
  await run(await get(), { modDir: mod }, cwd);
  assert.equal(readFileSync(path.join(mod, "config/cards.json"), "utf8"), before);
});

test("install_mod declares the parameter it reads, and mod-installer names it", async () => {
  const def = await get();
  const keys = Object.keys(def.parameters.properties || def.parameters.schema?.properties || {});
  assert.deepEqual(keys, ["modDir"]);
  assert.equal(def.name, "install_mod");
});
