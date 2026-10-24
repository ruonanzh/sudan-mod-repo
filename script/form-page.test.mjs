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

/**
 * One mod holding both records, generated once. Preview spawns a fresh Node process and reads the
 * vanilla config, so running it per test cost six seconds of the suite for nothing.
 */
let shared = null;
function pages() {
  if (shared) return shared;
  const dir = mod({ "config/loot/6000777.json": LOOT, "config/upgrade.json": { 8000777: UPGRADE } });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  shared = { dir, loot: read(path.join(dir, ".preview", "6000777.loot.html")), upgrade: read(path.join(dir, ".preview", "8000777.upgrade.html")) };
  return shared;
}

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
  icon: "gain",
  link_card: 9000001,
  incompatible: 8000776,
  condition: { all: { "have.2000001": 1 } },
  effect: { "counter+7000001": 1 },
};

test("a loot table gets a form page with every field, labelled", () => {
  const page = pages().loot;
  for (const key of ["repeat", "type", "name"]) assert.match(page, new RegExp(`data-form="${key}"`), key);
  assert.match(page, /战利品表/, "the page names what it is");
  assert.match(page, /抽取次数|name/, "each row carries its Chinese label");
  assert.match(page, /data-item-row/, "the repeated items are blocks");
  assert.equal((page.match(/data-item-index=/g) || []).length, 2, "one block per item in the record");
  assert.match(page, /<template id="item-template">/, "an empty table still has a row to start from");
  assert.match(page, /第 1 件/, "each block says which item it is");
  for (const text of ["普通权重：每一轮按权重抽一件", "必新：每一轮先去掉玩家已有的", "无放回：一次抽 m 件，不重复", "全部：表里所有符合条件的物品都给"]) {
    assert.ok(page.includes(text), `the algorithm pick explains ${text}`);
  }
  assert.match(page, /也可以直接写 JSON/, "the box says a written-out condition is welcome too");
  assert.doesNotMatch(page, /<input data-item="condition"/, "an item's condition is described, not typed as JSON");
  assert.match(page, /data-prose-item="condition"/, "each item carries its own sentence box");
  assert.match(page, /<input data-item="id" data-kind="number" type="number"/, "the card id gets a full cell");
  assert.match(page, /<h2>放什么<\/h2>\s*<div class="panel">/, "the heading sits outside the box, as on a card page");
  assert.match(page, /id="type-note"/, "the algorithm row keeps a line that explains the current choice");
  assert.match(page, /id="loot-type-notes"/, "the four explanations travel with the page");
  for (const [value, hint] of [["2", "玩家得到 repeat 件"], ["3", "最多得到 repeat 件"], ["4", "把 repeat 当成件数"], ["99", "repeat 乘表中物品数"]]) {
    assert.ok(page.includes(hint), `the note for ${value} explains repeat: ${hint}`);
  }
  assert.ok((page.match(/例如/g) || []).length >= 4, "each algorithm note carries a worked example");
  const bridge = read(path.join(REPO, "editors/form/form-bridge.js"));
  assert.match(bridge, /wireTypeNote/, "the wrapper swaps the line when the pick changes");
  assert.match(bridge, /"upgrade" \? "\/upgrade-edited" : "\/loot-edited"/, "each kind names its own template");
  assert.match(bridge, /id="loot-type-notes"/, "it reads the table out of the file text: mounting drops every script");
  assert.match(page, /id="form-values"/, "the values live in one block the editor wrapper rewrites");
});

test("a fate-shop entry gets a form page with JSON boxes for the nested fields", () => {
  const page = pages().upgrade;
  for (const key of ["name", "text", "cost", "icon", "link_card"]) assert.match(page, new RegExp(`data-form="${key}"`), key);
  for (const key of ["condition", "effect", "incompatible"]) {
    assert.match(page, new RegExp(`data-prose="${key}"`), `${key} is described in the player's words, not typed as JSON`);
    assert.doesNotMatch(page, new RegExp(`data-form="${key}"`), `${key} has no JSON box the player would have to write`);
  }

  assert.match(page, /<div class="readonly"><code>\{&quot;all&quot;/, "the current value is still shown, read-only");
  assert.match(page, /命运商店/, "the page names the shop");
  assert.match(page, /也可以直接写 JSON|也可以直接写条目编号/, "the shop boxes accept a written-out value too");
  assert.match(page, /<select data-form="icon">/, "the icon is a pick of the two names the game resolves");
  assert.match(page, /gain · 获得/, "the option shows the label the player sees beside the value to write");
  assert.match(page, /buff · 增益/, "so does the other one");
});

test("the form page carries its values in a block and opens in the editor", () => {
  const page = pages().loot;
  assert.match(page, /id="form-values"/, "the wrapper reads and writes this block");
  assert.match(page, /"key": ?"loot:6000777"/, "the block names the record");
  assert.match(page, /"weight": ?10/, "the block carries the current values");
  assert.ok(existsSync(path.join(pages().dir, ".preview", "6000777.loot.html")), "the page is a file the wrapper opens");
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

test("the three described fields travel as the player's sentences", () => {
  const bridge = read(path.join(REPO, "editors/form/form-bridge.js"));
  assert.match(bridge, /querySelectorAll\("\[data-prose\]"\)/, "the bridge reads the sentence boxes");
  assert.match(bridge, /lines.push\("说明："/, "the message carries them under 说明");
  assert.match(bridge, /改动：/, "and the changed values still travel under 改动");
});

test("the record id never travels as a change", () => {
  const bridge = read(path.join(REPO, "editors/form/form-bridge.js"));
  assert.match(bridge, /key === "id" \|\| described\.indexOf\(key\) !== -1/, "the diff skips the read-only id and every described field");
});

test("every row is the card page's row: key on the left, control in the right column", () => {
  const page = pages().loot;
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
