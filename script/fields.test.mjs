#!/usr/bin/env node
/**
 * fields test — the property that matters is that `schema/fields.json` is a claim about the
 * game's loader that a command can check, not a list nobody verifies.
 *
 *   node --test script/fields.test.mjs
 *
 * Today the file says `{ kind: { fields, handler, legacy } }`. `handler` is a bucket with no
 * definition: it mixes keys the loader really registers (`wizard.name`) with keys it has never
 * heard of (`card.tips`). A reader of the file cannot tell the two apart, and the validator
 * cannot either, so a dead key and a live key both pass. The target shape is one claim per key:
 *
 *   fields  the registered reader set — exactly the keys `21-handler-keys.md` counts as "readers"
 *   meta    per key: the reader delegate (`b__0_N`) and the field offset, so the claim is traceable
 *   legacy  every key that is authored in vanilla but that no reader backs
 *
 * The tests below split in two groups. A1-A7 check the table against itself (pure data, no
 * fixtures). B1-B9 check that `tools/lint.mjs` classifies a key the way the table says, using a
 * throwaway mod per case, and assert on the rule CODE and the key name, never on the sentence.
 *
 * `21-handler-keys.md` is the authority for the numbers, not this file: every count in
 * CENSUS_READERS is copied from a "Counts: readers N / ..." header and cites its section.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeMod, lint, fieldCodes, messagesOf, record, oneRecord, cleanupAll, REPO } from "./lib/fixture.mjs";

const FIELDS = JSON.parse(readFileSync(new URL("../schema/fields.json", import.meta.url), "utf8"));
const KINDS = Object.keys(FIELDS);

after(() => cleanupAll());

/** Keep an aggregate failure readable: the first few offenders plus a count. */
const some = (list, n = 6) => `${list.slice(0, n).join("; ")}${list.length > n ? `; +${list.length - n} more` : ""}`;

// ---------------------------------------------------------------------------
// A. the table against itself
// ---------------------------------------------------------------------------

test("A1 no kind lists a key twice in fields + legacy", () => {
  const twice = [];
  for (const kind of KINDS) {
    const { fields = [], legacy = [] } = FIELDS[kind];
    const seen = new Set();
    for (const key of [...fields, ...legacy]) {
      if (seen.has(key)) twice.push(`${kind}.${key}`);
      seen.add(key);
    }
  }
  assert.deepEqual(twice, [], `a key counted in two buckets makes the table unable to say what the key is: ${some(twice)}`);
});

test("A2 every kind's meta names exactly its fields, both directions", () => {
  const noMeta = [];
  const drift = [];
  for (const kind of KINDS) {
    const { fields = [], meta } = FIELDS[kind];
    if (meta === undefined || meta === null) {
      noMeta.push(kind);
      continue;
    }
    for (const key of fields) if (!(key in meta)) drift.push(`${kind}.${key} is a field with no meta entry`);
    for (const key of Object.keys(meta)) if (!fields.includes(key)) drift.push(`${kind}.${key} is a meta entry with no field`);
  }
  assert.deepEqual(noMeta, [], `a kind with no meta says which keys are legal but not which reader binds them: ${some(noMeta)}`);
  assert.deepEqual(drift, [], `fields and meta disagree about the key set: ${some(drift)}`);
});

test("A3 every meta entry carries a b__0_N reader and a hex offset", () => {
  const bad = [];
  for (const kind of KINDS) {
    const meta = FIELDS[kind].meta;
    if (!meta) {
      bad.push(`${kind} has no meta`);
      continue;
    }
    for (const [key, entry] of Object.entries(meta)) {
      const reader = String(entry?.reader);
      const offset = String(entry?.offset);
      // The census prints reader delegates as `b__0_1`.. and offsets as `0x10`, `0x1c`.
      if (!/^b__0_\d+$/.test(reader)) bad.push(`${kind}.${key} reader ${JSON.stringify(entry?.reader)}`);
      if (!/^0x[0-9a-f]+$/.test(offset)) bad.push(`${kind}.${key} offset ${JSON.stringify(entry?.offset)}`);
    }
  }
  assert.deepEqual(bad, [], `without a reader and an offset the entry is a name, not evidence: ${some(bad)}`);
});

test("A4 handler is gone from every kind", () => {
  const still = KINDS.filter((kind) => FIELDS[kind].handler !== undefined).map((kind) => {
    const n = Array.isArray(FIELDS[kind].handler) ? FIELDS[kind].handler.length : "?";
    return `${kind} (${n} keys)`;
  });
  assert.deepEqual(
    still,
    [],
    `handler mixes registered keys with dead ones, so the validator accepts a key nothing reads. ` +
      `Every key in it belongs in fields (a reader backs it) or legacy (nothing does): ${some(still)}`,
  );
});

/**
 * Reader count per kind, copied from the "Counts: readers N / declared fields D / corpus keys C"
 * header of the matching section in docs/sudan-game/fields/21-handler-keys.md.
 */
const CENSUS_READERS = {
  card: 16, // §5.1 CardNode — "readers 16 / declared fields 16 / corpus keys 18"
  event: 7, // §5.2 EventNode — "readers 7 / declared fields 8 / corpus keys 9"
  rite: 26, // §5.3 RiteNode — "readers 26 / declared fields 26 / corpus keys 29"
  slot: 9, // §5.4 RiteNode.Slot — "readers 9 / declared fields 9 / corpus keys 8"
  riteSlotPop: 2, // §5.5 RiteNode.SlotPop — "readers 2 / declared fields 2 / corpus keys 2"
  riteOpenCondition: 2, // §5.6 RiteNode.OpenCondition — "readers 2 / declared fields 2 / corpus keys 2"
  riteTagTipsUp: 2, // §5.7 RiteNode.TagTipsUp — "readers 2 / declared fields 2 / corpus keys 2"
  riteRandomTextUp: 5, // §5.8 RiteNode.RandomTextUp — "readers 5 / declared fields 5 / corpus keys 5"
  riteFromPin: 10, // §5.9 RiteNode.FromPin — "readers 10 / declared fields 10 / corpus keys 9"
  settlement: 12, // §5.10 RiteNode.Settlement — "readers 12 / declared fields 12 / corpus keys 11"
  loot: 5, // §5.11 LootNode — "readers 5 / declared fields 5 / corpus keys 5"
  lootItem: 5, // §5.12 LootNode.Item — "readers 5 / declared fields 6 / corpus keys 5"
  upgrade: 9, // §5.13 UpgradeNode — "readers 9 / declared fields 10 / corpus keys 9"
  tag: 13, // §5.14 TagNode — "readers 13 / declared fields 14 / corpus keys 16"
  init: 28, // §5.15 InitNode — "readers 28 / declared fields 28 / corpus keys 27"
  initDifficulty: 9, // §5.16 InitNode.Difficulty — "readers 9 / declared fields 9 / corpus keys 8"
  quest: 7, // §5.17 QuestNode — "readers 7 / declared fields 9 / corpus keys 8"
  questTargetItem: 3, // §5.18 QuestNode.Target — "readers 3 / declared fields 5 / corpus keys 3"
  over: 12, // §5.19 OverNode — "readers 12 / declared fields 12 / corpus keys 10"
  afterStory: 6, // §5.20 AfterStoryNode — "readers 6 / declared fields 6 / corpus keys 4"
  wizard: 13, // §5.21 WizardNode — "readers 13 / declared fields 13 / corpus keys 8"
  wizardOption: 7, // §5.22 WizardOptionNode — "readers 7 / declared fields 8 / corpus keys 4"
  riteTemplate: 14, // §5.23 RiteTemplateNode — "readers 14 / declared fields 14 / corpus keys 14"
  slotPosition: 9, // §5.24 RiteTemplateNode.SlotPosition — "readers 9 / declared fields 9 / corpus keys 9"
  pos: 2, // §5.25 RiteTemplateNode.Pos — "readers 2 / declared fields 2 / corpus keys 2"
  riteMapping: 4, // §5.26 RiteMappingNode — "readers 4 / declared fields 4 / corpus keys 4"
  dtRoot: 4, // §5.27 DialogTreeNode — "readers 4 / declared fields 5 / corpus keys 4"
  dtWord: 6, // §5.28 DialogTreeNode.Word — "readers 6 / declared fields 6 / corpus keys 6"
  dtOption: 4, // §5.29 DialogTreeNode.OptionItem — "readers 4 / declared fields 4 / corpus keys 4"
  sfxTop: 5, // §5.30 SfxConfigNode — "readers 5 / declared fields 6 / corpus keys 5"
  sfxLoop: 4, // §5.31 SfxConfigNode.ClipLoopNode — "readers 4 / declared fields 4 / corpus keys 4"
  sfxArmageddonLoop: 6, // §5.32 SfxConfigNode.ArmageddonClipLoopNode — "readers 6 / declared fields 6 / corpus keys 6"
  game: 6, // §5.33 ModGameNode — "readers 6 / declared fields 7 / corpus keys n/a"
  gameMap: 4, // §5.34 ModGameNode.Map — "readers 4 / declared fields 4 / corpus keys n/a"
  gamePoint: 2, // §5.35 ModGameNode.Point — "readers 2 / declared fields 2 / corpus keys n/a"
  gameMapLocation: 5, // §5.36 ModGameNode.MapLocation — "readers 5 / declared fields 5 / corpus keys n/a"
  gameEquipIcon: 3, // §5.37 ModGameNode.EquipIcon — "readers 3 / declared fields 3 / corpus keys n/a"
  gameCardMaterial: 8, // §5.38 ModGameNode.CardMaterial — "readers 8 / declared fields 8 / corpus keys n/a"
  gameCardMaterialGroup: 4, // §5.39 ModGameNode.CardMaterialGroup — "readers 4 / declared fields 4 / corpus keys n/a"
  // Not a handler of its own: one `after_story.prior/extra[]` paragraph is a RiteNode.Settlement,
  // so its key set is §5.10's twelve readers. The table used to list five of them, which made
  // `action` and `result` FAIL even though OverNewStep2StoryController runs both.
  afterStoryExtra: 12, // §5.10 RiteNode.Settlement
};

/**
 * Kinds the census cannot count, so A5 predicts nothing for them. Kept as an explicit list
 * rather than an omission: a kind may be uncensused by name, never by silence. Empty today —
 * every kind maps to a section of `21-handler-keys.md`.
 */
const UNCENSUSED = new Set([]);

test("A5 fields.length equals the census reader count", () => {
  assert.deepEqual(
    [...UNCENSUSED].sort(),
    [],
    "UNCENSUSED is a documented exception list, so changing it must be a deliberate edit here",
  );
  const uncovered = KINDS.filter((kind) => !(kind in CENSUS_READERS) && !UNCENSUSED.has(kind));
  assert.deepEqual(uncovered, [], `every kind needs a census line or an UNCENSUSED entry: ${some(uncovered)}`);

  const wrong = [];
  for (const kind of KINDS) {
    if (!(kind in CENSUS_READERS)) continue;
    const got = FIELDS[kind].fields.length;
    if (got !== CENSUS_READERS[kind]) wrong.push(`${kind} has ${got} keys, the census counts ${CENSUS_READERS[kind]} readers`);
  }
  assert.deepEqual(
    wrong,
    [],
    `fields is the registered reader set, so its length is the reader count. A key the class declares ` +
      `but never registers (is_composite, refLoot) has no reader and does not belong here: ${some(wrong)}`,
  );
});

test("A6 every kind has at least one key", () => {
  const empty = KINDS.filter((kind) => !(FIELDS[kind].fields || []).length);
  assert.deepEqual(empty, [], `an empty kind makes the validator accept nothing and reject everything: ${some(empty)}`);
});

test("A7 no key is both a live field and legacy", () => {
  const both = [];
  for (const kind of KINDS) {
    const fields = new Set(FIELDS[kind].fields || []);
    for (const key of FIELDS[kind].legacy || []) if (fields.has(key)) both.push(`${kind}.${key}`);
  }
  assert.deepEqual(both, [], `a key cannot be read and dead at once: ${some(both)}`);
});

// ---------------------------------------------------------------------------
// B. what the validator says about one key
//
// Every case writes one throwaway mod and asserts on codes + the key name. INFO results
// (SPRITE_VANILLA, PREVIEW_MISSING) are dropped by the fixture: they say nothing about keys.
// ---------------------------------------------------------------------------

const cardFile = (over) => ({ "config/cards.json": { 9000001: record("card", over) } });
const eventFile = (over) => oneRecord("event", { id: 5910001, on: {}, settlement: [], ...over });
const riteFile = (over) => oneRecord("rite", { id: 5920001, name: "n", cards_slot: {}, ...over });
const tagFile = (over) => ({ "config/tag.json": { fixture_tag: record("tag", over) } });
const questFile = (over) => ({ "config/quest.json": { 3309901: record("quest", over) } });

test("B1 registered keys raise no FAIL and no WARN", () => {
  const card = lint(makeMod(cardFile({})));
  assert.deepEqual(fieldCodes(card), [], "card.id is a declared field; a minimal card must lint clean");

  // A rite is the only host that carries `location` and a settlement array at once, so one
  // record covers a plain field and a nested branch.
  const rite = lint(
    makeMod(
      riteFile({ location: "王城:[1,2]", cards_slot: { s1: { guid: 1 } }, settlement: [{ key: "k" }] }),
    ),
  );
  assert.deepEqual(fieldCodes(rite), [], "rite.location and settlement.key are registered keys; the record must lint clean");
});

test("B2 an unknown card key fails with UNKNOWN_FIELD and names the key", () => {
  const r = lint(makeMod(cardFile({ bogus: 1 })));
  assert.deepEqual(fieldCodes(r), ["UNKNOWN_FIELD"]);
  const msg = messagesOf(r, "UNKNOWN_FIELD");
  assert.ok(msg.includes('"bogus"'), `the failure must name the offending key: ${msg}`);
  assert.ok(msg.includes("Known keys:"), `the failure must list what the loader does read: ${msg}`);
});

/**
 * Keys the current file puts in `handler` although no reader backs them: they are authored in
 * vanilla (§4 "corpus-only" and §5 declared-but-unregistered), they do nothing, and the table
 * must say so with `legacy`. `file` is the config path the key is written to, so a failure says
 * where the author meets it.
 */
const MOVES_TO_LEGACY = [
  { kind: "card", file: "config/cards.json", key: "tips", mod: () => cardFile({ tips: "pops text" }) },
  { kind: "card", file: "config/cards.json", key: "card_favour", mod: () => cardFile({ card_favour: 1 }) },
  { kind: "event", file: "config/event", key: "text", mod: () => eventFile({ text: "card text" }) },
  { kind: "event", file: "config/event", key: "cached_settlement", mod: () => eventFile({ cached_settlement: [] }) },
  { kind: "rite", file: "config/rite", key: "tag_tips", mod: () => riteFile({ tag_tips: {} }) },
  { kind: "rite", file: "config/rite", key: "method_settlement", mod: () => riteFile({ method_settlement: "" }) },
  { kind: "rite", file: "config/rite", key: "random_effect", mod: () => riteFile({ random_effect: {} }) },
  {
    kind: "settlement",
    file: "config/event",
    key: "tips_resource",
    mod: () => eventFile({ settlement: [{ tips_resource: "" }] }),
  },
  {
    kind: "settlement",
    file: "config/event",
    key: "tips_text",
    mod: () => eventFile({ settlement: [{ tips_text: "tip" }] }),
  },
  { kind: "tag", file: "config/tag.json", key: "tips", mod: () => tagFile({ tips: "tag tip" }) },
  { kind: "tag", file: "config/tag.json", key: "fail_tag", mod: () => tagFile({ fail_tag: [] }) },
  { kind: "tag", file: "config/tag.json", key: "tag_vanishing", mod: () => tagFile({ tag_vanishing: [] }) },
  { kind: "init", file: "config/init", key: "cards", mod: () => oneRecord("init", { id: 7000001, name: "n", cards: [] }) },
  { kind: "quest", file: "config/quest.json", key: "pre", mod: () => questFile({ pre: [] }) },
];

for (const { kind, file, key, mod } of MOVES_TO_LEGACY) {
  test(`B3 ${kind}.${key} in ${file} warns LEGACY_FIELD`, () => {
    const r = lint(makeMod(mod()));
    assert.deepEqual(
      fieldCodes(r),
      ["LEGACY_FIELD"],
      `${kind}.${key} is authored in vanilla and no reader backs it, so it must WARN and nothing else`,
    );
    const msg = messagesOf(r, "LEGACY_FIELD");
    assert.ok(msg.includes(`"${key}"`), `the warning must name ${key}: ${msg}`);
  });
}

test("B4 wizard name, text and options are registered keys", () => {
  // WizardNode registers all seven inherited keys plus its own six (§5.21), so the three the
  // file currently calls `handler` are plain fields and must lint clean.
  const r = lint(makeMod({ "config/wizard/w1.json": { name: "n", text: "t", options: [{ name: "a", op: {}, options: [] }] } }));
  assert.deepEqual(fieldCodes(r), [], "wizard.name/text/options have readers; a wizard file using them must lint clean");
});

test("B5 rite.tips_text is legal while the same key in an event settlement warns", () => {
  const rite = lint(makeMod(riteFile({ tips_text: "tip" })));
  assert.deepEqual(fieldCodes(rite), [], "rite.tips_text is a registered RiteNode key (§5.3, b__0_19)");

  // The other half of the same name: RiteNode.Settlement never registers tips_text (§5.10), so
  // inside an event branch the key is the classic trap — it looks read and is not.
  const event = lint(makeMod(eventFile({ settlement: [{ tips_text: "tip" }] })));
  assert.deepEqual(fieldCodes(event), ["LEGACY_FIELD"], "settlement.tips_text has no reader in RiteNode.Settlement");
  assert.ok(messagesOf(event, "LEGACY_FIELD").includes('"tips_text"'), "the warning must name the key");
});

test("B6 dt keys are case sensitive: Item is legal, item is not", () => {
  // §5.27: the container keys keep their mid-word capital, and the loader looks them up exactly.
  const ok = lint(makeMod({ "config/dt/DT9001.json": { dialog_tree_id: "DT9001", first_word_id: 1, Item: [] } }));
  assert.deepEqual(fieldCodes(ok), [], "dtRoot.Item is registered as written");

  const bad = lint(
    makeMod({ "config/dt/DT9002.json": { dialog_tree_id: "DT9002", first_word_id: 1, Item: [], item: [] } }),
  );
  assert.deepEqual(fieldCodes(bad), ["UNKNOWN_FIELD"]);
  assert.ok(messagesOf(bad, "UNKNOWN_FIELD").includes('"item"'), "the failure must name the lower-case key");
});

test("B7 restating a whole vanilla event does not silence a legacy key", () => {
  // Restating a directory-style file is how a mod changes one vanilla record: the shipped record
  // carries every required key, and `text` comes along. That must not turn the warning off.
  const body = {
    id: 5910020,
    on: { round_begin_ba: 1 },
    settlement: [{ condition: {}, action: { "counter+7000001": 1 }, result: ["x"] }],
    text: "the card text vanilla writes and no reader backs",
  };
  const r = lint(makeMod(oneRecord("event", body)));
  assert.deepEqual(fieldCodes(r), ["LEGACY_FIELD"], "event.text is corpus-only (§5.2), whatever the record restates");
  assert.ok(messagesOf(r, "LEGACY_FIELD").includes('"text"'), "the warning must name the key");
});

// The generator is the only writer of SCHEMA.md, so it is also where a table that contradicts
// itself has to stop. These two run it against a doctored copy (`--fields`/`--out`), which is why
// those flags exist: a document generated from a broken table is worse than no document.
function runGenerator(table, outDir) {
  const fieldsPath = path.join(outDir, "fields.json");
  writeFileSync(fieldsPath, JSON.stringify(table, null, 2));
  return spawnSync(
    process.execPath,
    [path.join(REPO, "tools/gen-schema-doc.mjs"), "--fields", fieldsPath, "--out", path.join(outDir, "SCHEMA.md")],
    { cwd: REPO, encoding: "utf8" },
  );
}

test("B8 gen-schema-doc exits non-zero when fields has a key meta lacks", () => {
  const table = JSON.parse(JSON.stringify(FIELDS));
  delete table.card.meta.name;
  const outDir = mkdtempSync(path.join(tmpdir(), "sudan-gen-"));
  const run = runGenerator(table, outDir);
  assert.notEqual(run.status, 0, "a live key with no reader must stop the generator");
  assert.match(run.stderr, /no meta entry/, "the message must say what is missing");
  assert.match(run.stderr, /card\.name/, "the message must name the key");
});

test("B9 gen-schema-doc exits non-zero when meta has a key fields lacks", () => {
  const table = JSON.parse(JSON.stringify(FIELDS));
  table.card.meta.ghost = { reader: "b__0_99", offset: "0xff" };
  const outDir = mkdtempSync(path.join(tmpdir(), "sudan-gen-"));
  const run = runGenerator(table, outDir);
  assert.notEqual(run.status, 0, "a reader with no live key must stop the generator");
  assert.match(run.stderr, /not live/, "the message must say the meta entry has no key");
  assert.match(run.stderr, /card\.ghost/, "the message must name the key");
});
