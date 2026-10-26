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
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

  assert.match(text, /^PASS:/, text);
  assert.ok(existsSync(path.join(target, "info.json")), text);
  assert.ok(existsSync(path.join(target, "config/cards.json")), text);
  assert.equal(result.details.files, 3, "info.json, config/cards.json and preview.png");
  assert.doesNotMatch(text, /^NEXT:/m, "PASS carries no NEXT; mod-installer SKILL says what to do next");
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
  assert.equal(result.details.files, 3, "info.json and config/cards.json, plus the placeholder preview");
});

test("install_mod leaves the asset manifest and previews behind", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": "{}\n", "asset_manifest.jsonl": '{"t":"x"}\n', ".preview/a.png": "png" });
  const result = await run(await get(), { modDir: mod }, cwd);
  const target = path.join(root, path.basename(mod));
  assert.equal(result.details.files, 3, "info.json and config/cards.json, plus the placeholder preview");
  assert.equal(existsSync(path.join(target, "asset_manifest.jsonl")), false, "the manifest is a work file, not a mod file");
  assert.equal(existsSync(path.join(target, ".preview")), false);
});

test("install_mod reads info.json the way lint does: comments, a BOM and a trailing comma are fine", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({});
  writeFileSync(path.join(mod, "info.json"), '\ufeff{\n  // 显示名\n  "name": "断剑卡面探针",\n  "version": "1.0.0",\n}\n');
  const result = await run(await get(), { modDir: mod }, cwd);
  assert.match(textOf(result), /^PASS:/, textOf(result));
});

test("install_mod refuses a folder with no info.json", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const bare = tmpDir("install-bare-");
  writeFileSync(path.join(bare, "config.json"), "{}");
  await assert.rejects(run(await get(), { modDir: bare }, cwd), /has no info\.json/);
});

test("install_mod says when info.json's name does not match the folder name", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({});
  writeFileSync(path.join(mod, "info.json"), JSON.stringify({ name: "显示名", version: "1.0.0" }));
  const result = await run(await get(), { modDir: mod }, cwd);
  assert.match(textOf(result), /^PASS:/, textOf(result));
  assert.match(textOf(result), /INFO: the folder is .*; the mod panel and ModLog use the name "\\u663e\\u793a\\u540d"/, "the display name is named, escaped");
});

test("install_mod refuses malformed info.json", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({});
  writeFileSync(path.join(mod, "info.json"), "{ not json");
  await assert.rejects(run(await get(), { modDir: mod }, cwd), /is not readable JSONC/);
});

test("install_mod reports FAIL when no mod directory is recorded", async () => {
  const cwd = workspace(null);
  const mod = makeMod({});
  // An empty home keeps discovery from finding this machine's real install: the test must not
  // write into it. Documents is pinned too, because the real one is read from the registry and
  // this machine therefore has a mod directory that a bare HOME does not hide.
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SUDAN_DOCUMENTS_DIR: process.env.SUDAN_DOCUMENTS_DIR };
  process.env.HOME = tmpDir("install-empty-home-");
  process.env.USERPROFILE = process.env.HOME;
  process.env.SUDAN_DOCUMENTS_DIR = process.env.HOME;
  let result;
  try {
    result = await run(await get(), { modDir: mod }, cwd);
  } finally {
    process.env.HOME = before.HOME;
    if (before.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = before.USERPROFILE;
    if (before.SUDAN_DOCUMENTS_DIR === undefined) delete process.env.SUDAN_DOCUMENTS_DIR;
    else process.env.SUDAN_DOCUMENTS_DIR = before.SUDAN_DOCUMENTS_DIR;
  }
  const text = textOf(result);
  assert.match(text, /^FAIL:/, text);
  assert.match(text, /ModList/, "the fix is the mod panel button, not a folder made by hand");
  assert.equal(result.details.installed, false);
});

test("install_mod refuses an install folder inside the workspace", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "ws-inside-"));
  const mod = path.join(cwd, "your_mods", "inside_probe");
  mkdirSync(mod, { recursive: true });
  writeFileSync(path.join(mod, "info.json"), JSON.stringify({ name: "inside_probe", version: "1.0.0" }));
  mkdirSync(path.join(cwd, "DoubleCross/SultansGame/Mod"), { recursive: true });
  mkdirSync(path.join(cwd, "DoubleCross/SultansGame/ModLog"), { recursive: true });
  writeFileSync(path.join(cwd, "DoubleCross/SultansGame/ModLog/__mod.log"), "");
  // The record is no longer consulted — the derivation is — so the machine's Documents folder has
  // to be the workspace for the guard to see an install landing inside it.
  const before = process.env.SUDAN_DOCUMENTS_DIR;
  process.env.SUDAN_DOCUMENTS_DIR = cwd;
  let out = null;
  try {
    out = await run(await get(), { modDir: mod }, cwd);
  } catch (e) {
    assert.match(String(e.message), /UNSAFE_TARGET: the install directory .* is inside the workspace/);
    return;
  } finally {
    if (before === undefined) delete process.env.SUDAN_DOCUMENTS_DIR;
    else process.env.SUDAN_DOCUMENTS_DIR = before;
  }
  assert.fail(`expected a refusal, got: ${textOf(out)}`);
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


test("install_mod aligns the file count with what actually lands", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": "{}\n" });
  mkdirSync(path.join(mod, ".preview"), { recursive: true });
  writeFileSync(path.join(mod, ".preview/card-1.modpage.html"), "<html></html>");
  writeFileSync(path.join(mod, ".DS_Store"), "x");
  writeFileSync(path.join(mod, "._junk"), "x");

  const result = await run(await get(), { modDir: mod }, cwd);
  const target = path.join(root, path.basename(mod));
  assert.equal(existsSync(path.join(target, ".preview")), false, "a mod page is not part of the mod");
  assert.equal(existsSync(path.join(target, ".DS_Store")), false);
  assert.equal(existsSync(path.join(target, "._junk")), false);
  assert.equal(result.details.files, 3, "info.json, config/cards.json and the placeholder preview");
});

// A mod with no thumbnail shows an empty card in the mod panel and on the Workshop page.
test("install_mod gives a mod without a preview the placeholder thumbnail", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": "{}\n" });
  const result = await run(await get(), { modDir: mod }, cwd);
  const text = textOf(result);
  const target = path.join(root, path.basename(mod));
  assert.equal(result.details.placeholderPreview, true, text);
  assert.match(text, /placeholder preview was added/, "the extra file is announced in the PASS line, not silently");
  const placed = path.join(target, "preview.png");
  assert.ok(existsSync(placed), text);
  assert.equal(result.details.files, 3, "the count includes the file that landed");
  assert.equal(existsSync(path.join(mod, "preview.png")), false, "the mod folder is left alone");
  assert.ok(readFileSync(placed).length > 1000, "the placeholder is a real image");
});

test("install_mod keeps a mod's own preview", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": "{}\n", "preview.jpg": "their own" });
  const result = await run(await get(), { modDir: mod }, cwd);
  const target = path.join(root, path.basename(mod));
  assert.equal(result.details.placeholderPreview, false);
  assert.equal(readFileSync(path.join(target, "preview.jpg"), "utf8"), "their own");
  assert.equal(existsSync(path.join(target, "preview.png")), false, "no placeholder beside their own thumbnail");
});

test("install_mod refuses a symlink that points at its own source", async (t) => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({});
  const link = path.join(root, path.basename(mod));
  try {
    symlinkSync(mod, link, "dir");
  } catch {
    t.skip("this platform does not allow directory symlinks without privileges");
    return;
  }
  await assert.rejects(run(await get(), { modDir: link }, cwd), /UNSAFE_TARGET/);
  assert.ok(existsSync(path.join(mod, "info.json")), "the source must survive the refusal");
});

test("install_mod refuses a folder that contains its own target", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  // <root>/MyMod/MyMod: the target is <root>/MyMod, which holds the source.
  const outer = path.join(root, "MyMod");
  const inner = path.join(outer, "MyMod");
  mkdirSync(inner, { recursive: true });
  writeFileSync(path.join(inner, "info.json"), JSON.stringify({ name: "MyMod" }));
  await assert.rejects(run(await get(), { modDir: inner }, cwd), /UNSAFE_TARGET/);
  assert.ok(existsSync(path.join(inner, "info.json")));
});

// A recorded path is a cache of what the machine derives. A player who moves Documents leaves a
// stale record behind, and the tool has to follow the derivation rather than the cache.
test("install_mod follows the derived mod folder, not a stale record", async () => {
  const root = modRoot();
  const cwd = workspace(tmpDir("install-wrong-root-"));
  const mod = makeMod({});
  const result = await run(await get(), { modDir: mod }, cwd);
  const text = textOf(result);
  assert.match(text, /^PASS:/, text);
  assert.ok(existsSync(path.join(root, path.basename(mod), "info.json")), `the mod landed under the derived root: ${text}`);
});

test("install_mod replaces the bytes, not just the file names", async () => {
  const root = modRoot();
  const cwd = workspace(root);
  const mod = makeMod({ "config/cards.json": '{"v":1}\n' });
  await run(await get(), { modDir: mod }, cwd);
  writeFileSync(path.join(mod, "config/cards.json"), '{"v":2}\n');
  const result = await run(await get(), { modDir: mod }, cwd);
  const landed = path.join(root, path.basename(mod), "config/cards.json");
  assert.match(textOf(result), /^PASS:/, textOf(result));
  assert.equal(readFileSync(landed, "utf8"), '{"v":2}\n', "a copy that is not refreshed must fail here");
  assert.doesNotMatch(textOf(result), /refresh the mod list/, "PASS carries no NEXT; the SKILL covers the refresh");
});
test("install_mod declares the parameter it reads, and mod-installer names it", async () => {
  const def = await get();
  const keys = Object.keys(def.parameters.properties || def.parameters.schema?.properties || {});
  assert.deepEqual(keys, ["modDir"]);
  assert.equal(def.name, "install_mod");
});
