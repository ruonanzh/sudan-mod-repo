/**
 * tools/preview.mjs, the value half: what a card page carries, and what --collect and --apply do
 * with it. Split from preview.test.mjs because each case spawns the CLI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PREVIEW, run, read, skip, mod, cardMod, cardPageFile, editPage, SAMPLE_CARDS } from "./lib/preview-fixture.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";
import { readPageValues, writePageValues } from "../editors/card/page.mjs";

test("--collect prints only the values that differ from cards.json", () => {
  const dir = cardMod();
  editPage(dir, { name: "新名字", rare: 3 });
  const r = run(["--mod", dir, "--collect"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /9000001 {2}name {2}"旧名字" -> "新名字"/);
  assert.match(r.stdout, /9000001 {2}rare {2}1 -> 3/);
  assert.doesNotMatch(r.stdout, /9000002/, "a page with no edit is not listed");
  assert.match(r.stdout, /--apply/, "the report says how to write the values back");
});

test("--apply writes only the changed values; comments, order and trailing commas survive", () => {
  const dir = cardMod();
  const file = path.join(dir, "config/cards.json");
  const before = read(file);
  editPage(dir, { name: "新名字", rare: 3, tag: { 体魄: 5, 装备: 1 } });

  const r = run(["--mod", dir, "--apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = read(file);

  assert.ok(after.startsWith("\ufeff"), "the BOM survives");
  assert.ok(after.includes("// 卡表：一个 id 一张卡"), "the comment survives");
  assert.ok(after.includes('"future_key": true,'), "an unknown key survives, trailing comma included");
  assert.ok(
    after.includes(
      '"9000002": { "id": 9000002, "name": "另一张", "type": "char", "rare": 2, "tag": { "战斗": 3 } }',
    ),
    "the untouched card is left byte for byte",
  );

  const doc = parseDoc(after);
  const cards = toPlain(doc, doc.root);
  assert.equal(cards["9000001"].name, "新名字");
  assert.equal(cards["9000001"].rare, 3);
  assert.deepEqual(cards["9000001"].tag, { 体魄: 5, 装备: 1 }, "only the tag that changed moves");
  assert.deepEqual(
    Object.keys(cards["9000001"]),
    ["id", "name", "type", "rare", "tag", "text", "future_key"],
    "key order is the file's",
  );

  const reverted = after
    .replace('"name": "新名字"', '"name": "旧名字"')
    .replace('"rare": 3', '"rare": 1')
    .replace('"体魄": 5', '"体魄": 1');
  assert.equal(reverted, before, "every byte that did not change is the byte the file already had");
});

test("--apply with --id writes only that card, not every pending page", () => {
  const dir = cardMod();
  editPage(dir, { name: "只改第一张" });
  editPage(dir, { name: "第二张也被点过" }, [], "9000002");
  const r = run(["--mod", dir, "--apply", "--id", "9000001"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const table = read(path.join(dir, "config/cards.json"));
  assert.match(table, /只改第一张/, "the named card was written");
  assert.doesNotMatch(table, /第二张也被点过/, "the other page was left alone");
  assert.doesNotMatch(r.stdout, /9000002/, "and the report does not claim it");
});

test("a page whose value block names another card is refused, not written under either id", () => {
  const dir = cardMod();
  const file = cardPageFile(dir, "9000002");
  const html = read(file);
  const block = readPageValues(html);
  // What a copy-paste or a stale page looks like: the file says 9000002, the block says 9000001.
  writeFileSync(file, writePageValues(html, "9000001", { ...block.values, name: "错位的值" }));
  const r = run(["--mod", dir, "--apply", "--id", "9000002"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /9000002/);
  assert.match(r.stdout, /9000001/);
  const table = read(path.join(dir, "config/cards.json"));
  assert.doesNotMatch(table, /错位的值/, "nothing was written");
});

test("--apply --id for a page that does not exist fails and says which id", () => {
  const dir = cardMod();
  const r = run(["--mod", dir, "--apply", "--id", "9999999"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /9999999/);
  assert.match(r.stdout, /NEXT/);
});

test("--apply warns when a changed page no longer carries a field the record has", () => {
  const dir = cardMod();
  editPage(dir, { name: "新名字" }, ["text"]);
  const r = run(["--mod", dir, "--apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WARN {2}9000001 {2}the page does not carry "text"/);
  assert.match(r.stdout, /whole-entry replace would drop it/);
  const doc = parseDoc(read(path.join(dir, "config/cards.json")));
  assert.equal(toPlain(doc, doc.root)["9000001"].text, "说明", "apply is per key, so the field stays");
});

test("regenerating a page keeps the values it already carries and says they are pending", () => {
  const dir = cardMod();
  editPage(dir, { name: "还没写回", rare: 4 });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const html = read(cardPageFile(dir));
  const block = readPageValues(html);
  assert.equal(block.values.name, "还没写回", "the pending name survived the layout refresh");
  assert.equal(block.values.rare, 4);
  assert.match(html, /id="card-pending"/);
  assert.match(html, /这些值还没写回/);
});

test("--apply with nothing pending leaves cards.json byte for byte", () => {
  const dir = cardMod();
  const file = path.join(dir, "config/cards.json");
  const before = read(file);
  const r = run(["--mod", dir, "--apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no card page carries a value different/);
  assert.equal(read(file), before);
});

test("--collect before any page exists says so and writes nothing", () => {
  const dir = mod({ "config/cards.json": SAMPLE_CARDS });
  const r = run(["--mod", dir, "--collect"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no card pages/);
  assert.equal(existsSync(path.join(dir, ".preview")), false);
});

test("the paths it prints are workspace-relative, so a chat link can open", () => {
  const root = mkdtempSync(path.join(tmpdir(), "preview-root-"));
  const dir = path.join(root, "mods", "probe");
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "probe" }));
  writeFileSync(path.join(dir, "config/cards.json"), JSON.stringify({ 9000777: { id: 9000777, name: "x", type: "item", rare: 1 } }));
  const out = run(["--mod", "mods/probe"], root);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /mods\/probe\/\.preview/, out.stdout);
  assert.doesNotMatch(out.stdout, /~\//, "a leading ~/ is resolved as a workspace path by the app");
});
