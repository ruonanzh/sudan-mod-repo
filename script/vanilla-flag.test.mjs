#!/usr/bin/env node
/**
 * vanilla-flag test — every tool that reads a record must be able to be pointed at a config.
 *
 *   node --test script/vanilla-flag.test.mjs
 *
 * `DEFAULT_VANILLA` used to be a macOS string, and five tools had no way to override it, so on
 * Windows and on a game installed elsewhere they read nothing and said nothing. Each test here
 * names one tool and proves the flag is honoured, by reading a card or event that exists only in
 * the fake config and nowhere else.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, cleanupAll, makeMod, record, tmpDir } from "./lib/fixture.mjs";
import { DEFAULT_VANILLA } from "../tools/model.mjs";
import { judge } from "../tools/paths.mjs";

const CARD_ID = 9000777;
const EVENT_ID = 5900777;
const CARD_NAME = "夹具卡";

after(cleanupAll);

/** A mod directory with only an `info.json`, so every record has to come from the config. */
function emptyMod() {
  const dir = tmpDir("sudan-mod-");
  writeFileSync(path.join(dir, "info.json"), '{"name":"T","description":"d","tags":["Utilities"],"version":"1"}\n');
  return dir;
}

/** A config that passes the vanilla sentinels and holds one card and one event. */
function fakeConfig() {
  const cfg = path.join(tmpDir("sudan-config-"), "config");
  mkdirSync(path.join(cfg, "rite"), { recursive: true });
  mkdirSync(path.join(cfg, "event"), { recursive: true });
  const card = {
    id: CARD_ID,
    name: CARD_NAME,
    title: "夹具的标题",
    text: "夹具的说明。",
    pops: [],
    type: "item",
    rare: 1,
    resource: [`cards/${CARD_ID}`],
    tag: { 体魄: 1 },
    card_vanishing: 0,
    vanish: {},
    equips: [],
    is_only: 0,
  };
  writeFileSync(path.join(cfg, "cards.json"), JSON.stringify({ [CARD_ID]: card }, null, 2));
  const event = {
    id: EVENT_ID,
    text: "夹具事件",
    is_replay: 1,
    start_trigger: true,
    on: { round_begin_ba: 1 },
    condition: {},
    // One settlement branch, so `event branch --action` has an `action` object to append to.
    settlement: [{ guid: "0", condition: {}, result_title: "", result_text: "", result: {}, action: {} }],
  };
  writeFileSync(path.join(cfg, "event", `${EVENT_ID}.json`), JSON.stringify(event, null, 4));
  return cfg;
}

const tool = (name, args, env) =>
  spawnSync(process.execPath, [path.join(REPO, "tools", name), ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: env ?? process.env,
    timeout: 180000,
  });

test("DEFAULT_VANILLA is the config paths.mjs verified, not a macOS literal", () => {
  const verified = judge().rows.find((r) => r.name === "vanilla");
  assert.ok(!String(DEFAULT_VANILLA).startsWith("~"), "--vanilla default must be expanded, not a tilde string");
  if (verified.status !== "OK") return; // a machine without the game: nothing to compare against
  assert.equal(DEFAULT_VANILLA, verified.path);
});

test("card.mjs reads a card from --vanilla and nowhere else", () => {
  const cfg = fakeConfig();
  const mod = emptyMod();
  const found = tool("card.mjs", ["show", "--mod", mod, "--id", String(CARD_ID), "--vanilla", cfg]);
  assert.equal(found.status, 0, found.stdout + found.stderr);
  assert.match(found.stdout, new RegExp(CARD_NAME));

  const blind = tool("card.mjs", ["show", "--mod", mod, "--id", String(CARD_ID)]);
  assert.equal(blind.status, 1, "without the flag this id exists in no config on this machine");
  assert.match(blind.stdout, /no card/);
});

test("story.mjs finds an event through --vanilla", () => {
  const cfg = fakeConfig();
  const mod = emptyMod();
  // The event exists only in the config, and `event branch` edits the mod's own copy of a
  // record, so nothing is written here. The observable is that the event was found at all:
  // exit 0, versus FAIL "no event" when the flag is absent.
  const found = tool("story.mjs", ["event", "branch", "--mod", mod, "--id", String(EVENT_ID), "--vanilla", cfg, "--action", "counter+7000163=1"]);
  assert.equal(found.status, 0, found.stdout + found.stderr);
  assert.doesNotMatch(found.stdout, /no event/);

  const blind = tool("story.mjs", ["event", "branch", "--mod", mod, "--id", String(EVENT_ID), "--action", "counter+7000163=1"]);
  assert.equal(blind.status, 1);
  assert.match(blind.stdout, /no event/);
});

test("save.mjs names cards from --vanilla", () => {
  const cfg = fakeConfig();
  const dir = tmpDir("sudan-save-");
  const file = path.join(dir, "auto_save.json");
  writeFileSync(
    file,
    JSON.stringify({ round: 1, card_uid_index: 5, cards: [{ uid: 1, id: CARD_ID, count: 1 }], counter: {} }, null, 2),
  );
  const found = tool("save.mjs", ["cards", "--save", file, "--vanilla", cfg]);
  assert.equal(found.status, 0, found.stdout + found.stderr);
  assert.match(found.stdout, new RegExp(CARD_NAME));
});

test("page.mjs renders a card that only --vanilla can supply", () => {
  const cfg = fakeConfig();
  const mod = emptyMod();
  const out = path.join(tmpDir("sudan-page-"), "card.html");
  const found = tool("page.mjs", ["card", "--mod", mod, "--id", String(CARD_ID), "--vanilla", cfg, "--out", out]);
  assert.equal(found.status, 0, found.stdout + found.stderr);
  assert.match(found.stdout, /PASS/);

  const blind = tool("page.mjs", ["card", "--mod", mod, "--id", String(CARD_ID), "--out", out]);
  assert.equal(blind.status, 1);
  assert.match(blind.stdout, /FAIL/);
});

// ------------------------------------------ the other half: a missing config is a refusal

/** A mod that carries one real card, so a FAIL can only be about the config. */
const modWithCard = () => makeMod({ "config/cards.json": { [CARD_ID]: record("card", { name: CARD_NAME, title: "夹具的标题" }) } });

test("page.mjs FAILs with a NEXT line when the config is missing, instead of an empty page", () => {
  const mod = modWithCard();
  const missing = path.join(tmpDir("sudan-gone-"), "config");
  const out = path.join(tmpDir("sudan-page-"), "card.html");
  const r = tool("page.mjs", ["card", "--mod", mod, "--id", String(CARD_ID), "--vanilla", missing, "--out", out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL\s/m);
  assert.match(r.stdout, /^NEXT\s/m);
  assert.equal(existsSync(out), false, "no page may be written from a config that does not exist");
});

test("save.mjs cards FAILs with a NEXT line when the config is missing", () => {
  const missing = path.join(tmpDir("sudan-gone-"), "config");
  const file = path.join(tmpDir("sudan-save-"), "auto_save.json");
  writeFileSync(
    file,
    JSON.stringify({ round: 1, card_uid_index: 5, cards: [{ uid: 1, id: CARD_ID, count: 1 }], counter: {} }, null, 2),
  );
  const r = tool("save.mjs", ["cards", "--save", file, "--vanilla", missing]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL\s/m);
  assert.match(r.stdout, /^NEXT\s/m);
});

test("graphpage.mjs FAILs with a NEXT line when the config is missing, instead of an empty graph", () => {
  const missing = path.join(tmpDir("sudan-gone-"), "config");
  const out = path.join(tmpDir("sudan-graph-"), "graph.html");
  const r = tool("graphpage.mjs", ["--vanilla", missing, "--out", out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL\s/m);
  assert.match(r.stdout, /^NEXT\s/m);
  assert.equal(existsSync(out), false, "no page may be written from a config that does not exist");
});
