/**
 * The editor writes into the mod, never into the game. These tests drive the two functions
 * the HTTP layer calls, so a failure here is a failure of the save path itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openMod } from "./model.mjs";
import { parseJsonc } from "./lint.mjs";
import { saveNode, readNodeSource, openModDir } from "./editor.mjs";
import { DEFAULT_VANILLA } from "./model.mjs";
import os from "node:os";

const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, os.homedir());
const hasGame = existsSync(VANILLA);
const skip = hasGame ? false : "the game's config is not installed on this machine";

const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-"));
  return openMod(dir, { vanilla: VANILLA });
};

const RECORD = (extra = {}) =>
  JSON.stringify({ id: 9000001, text: "新事件", is_replay: 0, start_trigger: true, on: { rite_end: 5000002 }, condition: {}, settlement: [], ...extra }, null, 1);

test("a directory without info.json is not a mod", () => {
  // The rest of the repo takes `--mod <dir>` and never guesses. `your_mods` is the parent of
  // mods: writing there produces files the game never loads, and the page calls it read-only.
  const dir = mkdtempSync(path.join(tmpdir(), "notamod-"));
  assert.throws(() => openModDir(dir, { vanilla: VANILLA }), /info\.json/, "a bare directory is refused");
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  assert.equal(openModDir(dir, { vanilla: VANILLA }).dir, dir, "info.json is what makes it a mod");
});

test("a new record lands in the mod and the second save keeps a backup", () => {
  const mod = fresh();
  const first = saveNode(mod, "event", 9000001, RECORD());
  assert.equal(first.ok, true);
  assert.equal(first.backup, null, "nothing existed before, so there is nothing to back up");
  assert.ok(existsSync(path.join(mod.dir, "config/event/9000001.json")));

  const second = saveNode(mod, "event", 9000001, RECORD({ text: "改过的" }));
  assert.equal(second.ok, true);
  assert.ok(second.backup && existsSync(second.backup));
  assert.match(readFileSync(path.join(mod.dir, "config/event/9000001.json"), "utf8"), /改过的/);
});

test("an unknown field is refused and nothing is written", () => {
  const mod = fresh();
  const out = saveNode(mod, "event", 9000002, JSON.stringify({ id: 9000002, bogus: 1 }));
  assert.equal(out.ok, false);
  assert.match(out.error, /bogus/);
  assert.equal(existsSync(path.join(mod.dir, "config/event/9000002.json")), false);
});

test("a broken document is refused", () => {
  const mod = fresh();
  const out = saveNode(mod, "event", 9000003, "{ this is not json");
  assert.equal(out.ok, false);
  assert.match(out.error, /解析失败/);
});

test("comments and formatting survive a real edit", { skip }, () => {
  const mod = fresh();
  const source = readFileSync(path.join(VANILLA, "event/5320301.json"), "utf8");
  const before = (source.match(/\/\//g) || []).length;
  const edited = source.replace(/"text"(\s*):(\s*)"([^"]*)"/, '"text"$1:$2"$3 改"');
  assert.notEqual(edited, source, "the fixture needs a field to change");
  const out = saveNode(mod, "event", 5320301, edited);
  assert.equal(out.ok, true);
  assert.equal(out.unchanged, undefined, "a real edit is a real write");
  const after = readFileSync(path.join(mod.dir, "config/event/5320301.json"), "utf8");
  assert.equal((after.match(/\/\//g) || []).length, before, "文件里的注释不能少");
  assert.match(after, /改/, "the edit is in the file");
});

test("a save that changes nothing leaves the node vanilla", { skip }, () => {
  const mod = fresh();
  const source = readFileSync(path.join(VANILLA, "event/5300010.json"), "utf8");
  const out = saveNode(mod, "event", 5300010, source);
  assert.equal(out.ok, true);
  assert.equal(out.unchanged, true, "opening and saving without an edit must not create an override");
  assert.equal(out.path, path.join(VANILLA, "event/5300010.json"), "the save reports the file it read");
  assert.equal(existsSync(path.join(mod.dir, "config/event/5300010.json")), false, "no mod copy is written");
  assert.equal(existsSync(path.join(mod.dir, "config/event/5300010.json.bak")), false);
});

test("duplicate keys are allowed and reported", { skip }, () => {
  const mod = fresh();
  const out = saveNode(mod, "event", 5300000, readFileSync(path.join(VANILLA, "event/5300000.json"), "utf8"));
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.warnings));
});

test("reading a node prefers the mod copy", () => {
  const mod = fresh();
  saveNode(mod, "event", 9000004, RECORD({ id: 9000004, text: "只在 mod 里" }));
  const got = readNodeSource(mod, "event", "9000004");
  assert.match(got.text, /只在 mod 里/);
  assert.match(got.file, /config\/event\/9000004\.json$/);
});

test("a table save keeps comments, trailing commas and other records' text", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-table-"));
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "table probe", version: "1.0.0" }));
  mkdirSync(path.join(dir, "config"), { recursive: true });
  const before = `{
  // 这张卡的名字别动
  "9000001": {
    "id": 9000001,
    "name": "原来的名字",
  },
  "9000002": {
    "id": 9000002,
    "name": "第二张",
  }, // 尾逗号也是原版风格
}
`;
  writeFileSync(path.join(dir, "config/cards.json"), before);
  const mod = openMod(dir, { vanilla: VANILLA });
  const out = saveNode(mod, "card", 9000001, JSON.stringify({ id: 9000001, name: "改过的名字", type: "item", rare: 2 }));
  assert.equal(out.ok, true, out.error);
  const after = readFileSync(path.join(dir, "config/cards.json"), "utf8");
  assert.ok(after.includes("// 这张卡的名字别动"), "the comment above the record survives");
  assert.ok(after.includes("// 尾逗号也是原版风格"), "the comment beside another record survives");
  assert.match(after, /"name"\s*:\s*"改过的名字"/, "the record itself changed");
  assert.ok(after.includes('"9000002"'), "the other record is still there");
  assert.match(after, /\},\s*\/\/ 尾逗号也是原版风格/, "the trailing comma of the last entry is untouched");
});

test("two saves of the same table cannot interleave: the second waits or refuses", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-lock-"));
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "lock probe", version: "1.0.0" }));
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(path.join(dir, "config/cards.json"), `{\n  "9000001": {"id": 9000001, "name": "甲", "type": "item", "rare": 2}\n}\n`);
  const mod = openMod(dir, { vanilla: VANILLA });
  const target = path.join(dir, "config/cards.json");
  writeFileSync(`${target}.lock`, "held"); // pretend another process is mid-save
  const started = Date.now();
  const out = saveNode(mod, "card", 9000001, JSON.stringify({ id: 9000001, name: "乙", type: "item", rare: 2 }), { lockWaitMs: 40 });
  assert.equal(out.ok, false, "the save does not run while the lock is held");
  assert.match(out.error, /另一次保存/, "and says why");
  assert.ok(Date.now() - started >= 30, "it waits before giving up");
  const after = readFileSync(target, "utf8");
  assert.ok(after.includes("甲"), "the file was not touched");
});

test("a second save keeps every backup instead of overwriting the first", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-bak-"));
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "bak probe", version: "1.0.0" }));
  mkdirSync(path.join(dir, "config"), { recursive: true });
  const file = path.join(dir, "config/cards.json");
  writeFileSync(file, `{\n  "9000001": {"id": 9000001, "name": "一", "type": "item", "rare": 2}\n}\n`);
  const mod = openMod(dir, { vanilla: VANILLA });
  const a = saveNode(mod, "card", 9000001, JSON.stringify({ id: 9000001, name: "二", type: "item", rare: 2 }));
  const b = saveNode(mod, "card", 9000001, JSON.stringify({ id: 9000001, name: "三", type: "item", rare: 2 }));
  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);
  assert.ok(a.backup && b.backup && a.backup !== b.backup, "each save has its own backup file");
  assert.ok(existsSync(a.backup) && existsSync(b.backup), "both backups are on disk");
});

test("a table save keeps the comments inside the record it edits", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-inner-"));
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "inner probe", version: "1.0.0" }));
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(
    path.join(dir, "config/cards.json"),
    `{\n  "9000001": {\n    "id": 9000001, // 编号\n    "name": "旧名字", // 显示名\n    "type": "item",\n    "rare": 2\n  }\n}\n`,
  );
  const mod = openMod(dir, { vanilla: VANILLA });
  const view = readNodeSource(mod, "card", 9000001);
  assert.ok(view.text.includes("// 编号"), "the editor shows the record with its comments");
  const edited = view.text.replace('"旧名字"', '"新名字"');
  const out = saveNode(mod, "card", 9000001, edited);
  assert.equal(out.ok, true, out.error);
  const after = readFileSync(path.join(dir, "config/cards.json"), "utf8");
  assert.ok(after.includes("// 编号"), "the inner comment survives");
  assert.ok(after.includes("// 显示名"), "and so does the one beside the edited value");
  assert.match(after, /"name": "新名字"/);
});

test("a record that ends with a line comment can still be saved", { skip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "editor-tail-"));
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "tail probe", version: "1.0.0" }));
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(path.join(dir, "config/cards.json"), `{\n  "9000001": {\n    "id": 9000001,\n    "type": "item",\n    "rare": 2,\n    "name": "名字" // 结尾注释\n  }\n}\n`);
  const mod = openMod(dir, { vanilla: VANILLA });
  const view = readNodeSource(mod, "card", 9000001);
  // A real edit, so the save does not take the "unchanged" early return and the file is rewritten.
  const out = saveNode(mod, "card", 9000001, view.text.replace('"名字"', '"新名字"'));
  assert.equal(out.ok, true, out.error);
  const after = readFileSync(path.join(dir, "config/cards.json"), "utf8");
  assert.ok(after.includes('"新名字"'), "the edit landed");
  assert.ok(after.includes("// 结尾注释"), "the comment survives");
  parseJsonc(after); // still parses
});
