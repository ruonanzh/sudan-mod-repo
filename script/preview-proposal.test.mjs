/**
 * tools/preview.mjs, the proposal half: a page built from a record the mod does not carry yet, and
 * the record page a quest, an ending or an epilogue gets. Split from preview.test.mjs because each
 * case spawns the CLI, and the runner starts one process per suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_VANILLA } from "../tools/model.mjs";
import { parseDoc, toPlain } from "../tools/jsonc.mjs";

const PREVIEW = fileURLToPath(new URL("../tools/preview.mjs", import.meta.url));
const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, os.homedir());
const skip = existsSync(VANILLA) ? false : "the game's config is not installed on this machine";
const read = (file) => readFileSync(file, "utf8");

/** A mod with an info.json and the files given: the same fixture preview.test.mjs uses. */
function mod(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-"));
  writeFileSync(
    path.join(dir, "info.json"),
    JSON.stringify({ name: "Preview probe", description: "", tags: [], version: "1.0.0" })
  );
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const run = (args, cwd) => spawnSync(process.execPath, [PREVIEW, ...args], { encoding: "utf8", cwd });

// ---------------------------------------------------------------- proposal pages

const PROPOSAL = {
  id: 9000401,
  name: "血滴子",
  title: "武器",
  text: "抛出铁罩，收绳。",
  pops: [],
  type: "item",
  rare: 4,
  resource: "cards/9000401",
  tag: { 武器: 1, 装备: 1, 战斗: 3, 隐匿: 6 },
  card_vanishing: 0,
  vanish: {},
  equips: [],
  is_only: 1,
};

test("--spec builds the same editable card page a written card gets, and writes nothing", () => {
  const dir = mod();
  const out = path.join(mkdtempSync(path.join(tmpdir(), "preview-spec-")), "proposal.card.html");
  const r = spawnSync(
    process.execPath,
    [PREVIEW, "--mod", dir, "--spec", "-", "--kind", "card", "--id", "9000401", "--out", out],
    { encoding: "utf8", input: JSON.stringify(PROPOSAL), cwd: dir }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const html = read(out);
  assert.match(html, /提案 · 尚未写入/, "the page says the record is not in the mod");
  assert.match(html, /data-proposal="1"/, "and marks itself, so apply can tell a proposal from a stale page");
  assert.ok(html.includes("<input"), "the card page keeps its controls: the player edits values, not prose");
  assert.equal(existsSync(path.join(dir, "config/cards.json")), false, "a proposal is not a decision");
});

test("a proposal page with no card table applies into a new record", () => {
  const dir = mod();
  const out = path.join(dir, ".preview", "9000401.card.html");
  const built = spawnSync(
    process.execPath,
    [PREVIEW, "--mod", dir, "--spec", "-", "--kind", "card", "--id", "9000401", "--out", out],
    { encoding: "utf8", input: JSON.stringify(PROPOSAL), cwd: dir }
  );
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const applied = run(["--mod", dir, "--apply", "--id", "9000401"], dir);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const table = parseDoc(read(path.join(dir, "config/cards.json")));
  const record = toPlain(table, table.root)["9000401"];
  assert.equal(record.name, "血滴子", "the record lands with the page's values");
  assert.equal(record.id, 9000401, "a new record carries the id the page is keyed by");
  assert.equal(record.tag["隐匿"], 6, "tags included");
  assert.equal(record.is_only, 1);
});

test("a quest gets a record page with its own key and the prompt box", { skip }, () => {
  const dir = mod({ "config/quest.json": { 7000001: { id: 7000001, name: "测试任务", text: "看看" } } });
  const r = run(["--mod", dir]);
  const page = path.join(dir, ".preview", "quest-7000001.record.html");
  assert.ok(existsSync(page), "a quest is a record with fields, so it gets a page");
  const html = read(page);
  assert.match(html, /data-record="quest:7000001"/, "the box knows which record it edits");
  assert.match(html, /<script src="record-prompt\.js"><\/script>/, "and carries the script that sends the sentence");
  // The story graph is a separate writer; a graph failure must not be read as this page's failure.
  if (r.status !== 0) assert.match(r.stdout + r.stderr, /graphpage\.mjs could not write/);
});
