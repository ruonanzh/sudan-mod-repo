/**
 * The two form pages: a loot table and a fate-shop entry. They look like the card page and send
 * their changed values to the agent, which writes them back.
 *
 *   node --test script/form-page.test.mjs
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupAll } from "./lib/fixture.mjs";

const PREVIEW = fileURLToPath(new URL("../tools/preview.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
after(cleanupAll);

/** A mod with the records given: relative path -> record object. */
function mod(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "formpage-"));
  writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "Form probe" }));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(body));
  }
  return dir;
}

const run = (args) => spawnSync(process.execPath, [PREVIEW, ...args], { encoding: "utf8" });
const read = (file) => readFileSync(file, "utf8");

const LOOT = {
  id: 6000777,
  name: "测试掉落",
  repeat: 3,
  type: 2,
  item: [
    { type: 2, id: 2000001, num: 1, weight: 10 },
    { type: 2, id: 2000002, num: 2, weight: 5 },
  ],
};

const UPGRADE = {
  id: 8000777,
  name: "测试命运商店",
  text: "用一次",
  cost: 30,
  icon: "cards/1_char_0",
  link_card: 9000001,
  condition: { all: { "have.2000001": 1 } },
  effect: { "counter+7000001": 1 },
};

test("a loot table gets a form page with every field, labelled", () => {
  const dir = mod({ "config/loot/6000777.json": LOOT });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const page = read(path.join(dir, ".preview", "6000777.loot.html"));
  for (const key of ["repeat", "type", "name"]) assert.match(page, new RegExp(`data-form="${key}"`), key);
  assert.match(page, /战利品表/, "the page names what it is");
  assert.match(page, /抽取次数|name/, "each row carries its Chinese label");
  assert.match(page, /data-item-row/, "the repeated items are rows");
  assert.equal((page.match(/data-item-row/g) || []).length, 2, "one row per item in the record");
  assert.match(page, /id="form-values"/, "the values live in one block the editor wrapper rewrites");
});

test("a fate-shop entry gets a form page with JSON boxes for the nested fields", () => {
  const dir = mod({ "config/upgrade.json": { 8000777: UPGRADE } });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const page = read(path.join(dir, ".preview", "8000777.upgrade.html"));
  for (const key of ["name", "text", "cost", "icon", "link_card"]) assert.match(page, new RegExp(`data-form="${key}"`), key);
  assert.match(page, /<textarea data-form="condition"/, "a condition is edited as JSON");
  assert.match(page, /<textarea data-form="effect"/, "so is an effect");
  assert.match(page, /命运商店/, "the page names the shop");
  assert.match(page, /<select data-form="icon">/, "the icon is a pick of the two names the game resolves");
  assert.match(page, /gain · 获得/, "the option shows the label the player sees beside the value to write");
  assert.match(page, /buff · 增益/, "so does the other one");
});

test("the form page carries its values in a block and opens in the editor", () => {
  const dir = mod({ "config/loot/6000777.json": LOOT });
  run(["--mod", dir]);
  const page = read(path.join(dir, ".preview", "6000777.loot.html"));
  assert.match(page, /id="form-values"/, "the wrapper reads and writes this block");
  assert.match(page, /"key": ?"loot:6000777"/, "the block names the record");
  assert.match(page, /"weight": ?10/, "the block carries the current values");
  assert.ok(existsSync(path.join(dir, ".preview", "6000777.loot.html")), "no separate script file: the editor wrapper supplies one");
});

test("the wrapper mounts into the host its stylesheet pads", () => {
  const html = read(path.join(REPO, "editors/form/index.html"));
  assert.match(html, /#card-host \{[^}]*padding: 20px/, "the stylesheet pads the host");
  assert.match(html, /<main id="card-host">/, "and the markup names the same element: a renamed host loses the padding");
  const bridge = read(path.join(REPO, "editors/form/form-bridge.js"));
  assert.match(bridge, /HOST_ID = "card-host"/, "the bridge mounts into that same host");
  assert.match(html, /id="card-hint"/, "the hint keeps the card page's id and text");
  assert.match(html, /改完点「发送给 Agent」：它会先保存这一页，再把改动发给 agent 写回配置。/, "the sentence is the card page's sentence");
});

test("the record id never travels as a change", () => {
  const bridge = read(path.join(REPO, "editors/form/form-bridge.js"));
  assert.match(bridge, /if \(key === "id"\) return;/, "the diff skips the read-only id");
});

test("every row is the card page's row: key on the left, control in the right column", () => {
  const dir = mod({ "config/loot/6000777.json": LOOT });
  run(["--mod", dir]);
  const page = read(path.join(dir, ".preview", "6000777.loot.html"));
  for (const key of ["id", "repeat", "type", "name"]) {
    const start = page.indexOf(`data-key="${key}"`);
    const next = page.indexOf("data-key=", start + 10);
    const row = page.slice(start, next === -1 ? undefined : next);
    assert.match(row, /class="lbl"><code>/, `${key} names the key in the left column`);
    assert.match(row, /class="key-zh"/, `${key} carries its Chinese name in the same column`);
    assert.match(row, /class="val"/, `${key} puts its value in the right column`);
  }
  const repeat = page.slice(page.indexOf('data-key="repeat"'), page.indexOf('data-key="type"'));
  assert.match(repeat, /class="val"><input data-form="repeat"/, "the control sits in the value column, as on a card page");
  assert.match(page, /class="panel"/, "the rows sit inside the same bordered box a card page uses");
  assert.match(page, /<div class="wrap" data-form-page="loot:6000777">/, "the wrapper mounts the whole page, title and subtitle included");
  assert.match(page, /<h1>战利品表 6000777<\/h1>/, "the mounted page keeps its title, as a card page does");
});
