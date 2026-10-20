#!/usr/bin/env node
/**
 * Generate schema/SCHEMA.md from the three machine files. Never edit SCHEMA.md by hand.
 *
 *   node tools/gen-schema-doc.mjs
 *
 * The prose that cannot be derived — what each type is for, and the traps — lives in
 * the tables below, so the reference and the validator cannot drift apart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

//   node tools/gen-schema-doc.mjs                       rewrite schema/SCHEMA.md
//   node tools/gen-schema-doc.mjs --check                exit 1 if SCHEMA.md is stale
//   node tools/gen-schema-doc.mjs --fields <p> --out <p>  use another table, write elsewhere
//
// `--fields` and `--out` exist so the tests can prove the invariants on a throwaway table
// without touching the committed one.
const ARGV = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};
const CHECK = ARGV.includes("--check");
const FIELDS_PATH = argOf("--fields");
const OUT_PATH = argOf("--out");

const die = (msg) => {
  process.stderr.write(msg + "\n");
  process.exit(1);
};

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const FIELDS = FIELDS_PATH
  ? JSON.parse(readFileSync(resolve(FIELDS_PATH), "utf8"))
  : read("../schema/fields.json");
const VOCAB = read("../schema/vocab.json");
const SAVES = read("../schema/save-fields.json");
const EDGES = read("../schema/edges.json");
const CATEGORIES = read("../schema/categories.json");

/**
 * The table makes one claim per key, and this is what enforces it: every live key names the
 * reader that binds it and the offset it lands in, and no key sits in two buckets. A table that
 * fails here would generate a reference that looks authoritative and is not.
 */
function tableProblems(table) {
  const problems = [];
  for (const [kind, spec] of Object.entries(table)) {
    const fields = spec.fields || [];
    const meta = spec.meta || {};
    const legacy = spec.legacy || [];
    if (spec.handler) problems.push(`${kind}: the "handler" bucket was removed; use fields or legacy`);
    for (const key of fields) {
      const m = meta[key];
      if (!m) problems.push(`${kind}.${key}: live key with no meta entry (reader + offset)`);
      else if (!/^b__0_\d+$/.test(m.reader || "")) problems.push(`${kind}.${key}: reader ${JSON.stringify(m.reader)} is not b__0_N`);
      else if (!/^0x[0-9a-f]+$/.test(m.offset || "")) problems.push(`${kind}.${key}: offset ${JSON.stringify(m.offset)} is not hex`);
    }
    for (const key of Object.keys(meta)) if (!fields.includes(key)) problems.push(`${kind}.${key}: meta entry for a key that is not live`);
    for (const key of legacy) if (fields.includes(key)) problems.push(`${kind}.${key}: both live and legacy`);
    if (!fields.length) problems.push(`${kind}: no live keys`);
  }
  return problems;
}

const tableBad = tableProblems(FIELDS);
if (tableBad.length) die(`schema/fields.json is inconsistent:\n  ${tableBad.join("\n  ")}`);

/** kind -> [what it is, which file, what the key is] */
const ABOUT = {
  card: ["One card in the deck: a character, an item, or a Sultan card.", "config/cards.json", "dictionary key = id"],
  upgrade: ["One entry in the destiny shop: pay cost, run effect, gated by condition.", "config/upgrade.json", "dictionary key = id"],
  tag: ["One tag definition. Cards carry tags as name -> integer.", "config/tag.json", "dictionary key = code, NOT id"],
  event: ["A journal/story card whose outcome is a list of settlement branches.", "config/event/<id>.json", "filename = id"],
  rite: ["The multi-round board puzzle: slots, open conditions, waiting period, then three settlement lists.", "config/rite/<id>.json", "filename = id"],
  slot: ["One slot on a rite board.", "rite.cards_slot.<sN>", "key = s1..sN"],
  riteSlotPop: ["A conditional line shown when a card sits in a slot.", "rite.cards_slot.<sN>.pops[]", "-"],
  settlement: ["One outcome branch of a rite or event. Every branch of an event runs in order; a rite takes the first match.", "rite/event settlement arrays", "-"],
  riteTagTipsUp: ["Tag-driven tooltip override on a rite.", "rite.tag_tips_up", "-"],
  riteRandomTextUp: ["Copy for one dice check result.", "rite.random_text_up.<rN>", "-"],
  riteOpenCondition: ["One reason the rite cannot open yet.", "rite.open_conditions[]", "-"],
  riteFromPin: ["Map-pin geometry for reaching a rite.", "rite.from_pins[]", "-"],
  loot: ["A weighted random table yielding cards, events, rites or other tables.", "config/loot/<id>.json", "filename = id"],
  lootItem: ["One weighted entry in a loot table.", "loot.item[]", "-"],
  init: ["A starting scenario: what the run begins with.", "config/init/<id>.json", "filename = id"],
  quest: ["A destiny quest shown in the objective list.", "config/quest.json", "dictionary key = id"],
  questTargetItem: ["One completion target of a quest.", "quest.<id>.target[]", "-"],
  over: ["One ending screen.", "config/over.json", "dictionary key = id; the record has no id field"],
  afterStory: ["Epilogue text shown after an ending.", "config/after_story/<id>.json", "filename = id"],
  afterStoryExtra: ["One epilogue paragraph.", "after_story.prior/extra[]", "-"],
  wizard: ["The character-creation guide: prompts and options.", "config/wizard/<name>.json", "filename = name"],
  wizardOption: ["One choice in the creation guide.", "wizard.options[]", "-"],
  riteTemplate: ["Board layout: background, foreground, per-slot position/scale/rotation.", "config/rite_template/<id>.json", "filename = id"],
  riteMapping: ["Binds a mapping id to a template and lists which slots it exposes.", "config/rite_template_mappings.json", "dictionary key = id as a string"],
  dtRoot: ["A dialogue tree.", "config/dt/DT<n>.json", "dialog_tree_id, NOT the filename"],
  dtWord: ["One line in a dialogue tree.", "dt.Item[]", "-"],
  dtOption: ["One choice on a dialogue line.", "dt.Item[].Option[]", "-"],
  sfxTop: ["Loop-group music config.", "config/sfx_config.json", "-"],
  sfxLoop: ["One looping clip definition.", "sfx_config.<group>.<n>", "-"],
  game: ["Presentation overrides. Mod-only: vanilla ships no game.json.", "config/game.json", "-"],
  gameMap: ["World-map override.", "game.json.map", "-"],
  gameMapLocation: ["One pin on the map.", "game.json.map.locations.<name>", "-"],
  gameEquipIcon: ["Icons for one equipment slot.", "game.json.equip_icon.<name>", "-"],
  gamePoint: ["An x/y pair.", "various", "-"],
  gameCardMaterial: ["Unity material override for a card category.", "game.json.card_materials.<group>[]", "-"],
  gameCardMaterialGroup: ["Material arrays per card category.", "game.json.card_materials", "-"],
};

const out = [];
const w = (s = "") => out.push(s);

w("# Sultan's Game(苏丹的游戏) JSON schema");
w();
w("Generated by `node tools/gen-schema-doc.mjs` from `schema/fields.json`,");
w("`schema/vocab.json` and `schema/save-fields.json`. Do not edit this file: edit those,");
w("then regenerate. The validator reads the same three files, so this document and");
w("`node tools/lint.mjs` cannot disagree.");
w();
w("## Where this comes from");
w();
w("| evidence | what it proves | how it was obtained |");
w("|---|---|---|");
w("| `type` | the legal key set | the declared C# fields of the node class, read from the decompiled assembly |");
w("| `data` | the value domain, and how often a key is actually written | a walk of every shipped file, duplicate keys preserved |");
w("| `wiki` | the meaning, when the data cannot state it | community pages, recorded only when the data does not contradict them |");
w();
w("Every field table below was checked against every shipped file of its kind. A key in the");
w("Class column and absent from the data is a key the game reads and vanilla never writes.");
w();
w("## Kinds");
w();
w("| kind | fields | what it is | where | key |");
w("|---|---|---|---|---|");
for (const [kind, spec] of Object.entries(FIELDS)) {
  const [what, where, key] = ABOUT[kind] || ["-", "-", "-"];
  w(`| \`${kind}\` | ${spec.fields.length} | ${what} | \`${where}\` | ${key} |`);
}
w();

// Kind -> the kind it is nested in, so the reference can be read level by level.
const PARENT = {
  slot: "rite",
  riteSlotPop: "slot",
  riteOpenCondition: "rite",
  riteTagTipsUp: "rite",
  riteRandomTextUp: "rite",
  riteFromPin: "rite",
  settlement: "event, rite",
  lootItem: "loot",
  questTargetItem: "quest",
  afterStoryExtra: "afterStory",
  wizardOption: "wizard",
  dtWord: "dtRoot",
  dtOption: "dtRoot",
  sfxLoop: "sfxTop",
  gameMap: "game",
  gameMapLocation: "gameMap",
  gameEquipIcon: "game",
  gameCardMaterial: "game",
  gameCardMaterialGroup: "game",
  gamePoint: "game",
};

/** `keys` counts every key a row can carry: declared, handler-read, and legacy-only. */
const keysOf = (spec) => {
  const own = spec.fields.length;
  const handler = (spec.handler || []).length;
  const legacy = (spec.legacy || []).length;
  const marks = [];
  if (handler) marks.push(`+${handler} handler`);
  if (legacy) marks.push(`~${legacy} legacy`);
  return `${own + handler + legacy}${marks.length ? " (" + marks.join(", ") + ")" : ""}`;
};

w("## Fields by level");
w();
w("Level 2 is one entry of a shipped config file. Level 3 only exists inside such an entry. A");
w("row marked `handler` is read by a custom reader rather than a declared field; `legacy` is a key");
w("the current build no longer reads.");
w();
w("### Level 2 — one per config entry");
w();
w("| kind | keys | what it is | file |");
w("|---|---|---|---|");
for (const [kind, spec] of Object.entries(FIELDS)) {
  if (PARENT[kind]) continue;
  const [what, where] = ABOUT[kind] || ["-", "-"];
  w(`| \`${kind}\` | ${keysOf(spec)} | ${what} | \`${where}\` |`);
}
w();
w("### Level 3 — nested inside another entry");
w();
w("| kind | keys | lives in |");
w("|---|---|---|");
for (const [kind, spec] of Object.entries(FIELDS)) {
  if (!PARENT[kind]) continue;
  const [, where] = ABOUT[kind] || ["-", "-"];
  w(`| \`${kind}\` | ${keysOf(spec)} | \`${where}\` (inside ${PARENT[kind]}) |`);
}
w();
for (const [kind, spec] of Object.entries(FIELDS)) {
  const [what] = ABOUT[kind] || ["-"];
  w(`**\`${kind}\`** — ${what}`);
  w();
  w("Keys: " + spec.fields.map((f) => `\`${f}\``).join(", ") + ".");
  if ((spec.handler || []).length) w("Handler-read: " + spec.handler.map((f) => `\`${f}\``).join(", ") + ".");
  if ((spec.legacy || []).length) w("Legacy (no longer read): " + spec.legacy.map((f) => `\`${f}\``).join(", ") + ".");
  w();
}

w("## Field tables");
w();
for (const [kind, spec] of Object.entries(FIELDS)) {
  const [what, where] = ABOUT[kind] || ["-", "-"];
  w(`### ${kind}`);
  w();
  w(`${what}  `);
  w(`File: \`${where}\``);
  w();
  if (spec.fields.length) {
    w("| key |");
    w("|---|");
    for (const f of spec.fields) w(`| \`${f}\` |`);
  } else {
    w("No fixed keys.");
  }
  if (spec.handler?.length) {
    w();
    w(`Handler keys (read from the JSON without a property of their own): ${spec.handler.map((k) => `\`${k}\``).join(", ")}`);
  }
  if (spec.legacy?.length) {
    w();
    w(`Legacy or derived keys (read by nothing, or filled from another key): ${spec.legacy.map((k) => `\`${k}\``).join(", ")}`);
  }
  w();
}

w("## Timings");
w();
w("The value of `event.on` is an object. Duplicate timing keys are legal and each one fires.");
w("A key that is not in this table is never scheduled.");
w();
w("| timing | argument | used in vanilla |");
w("|---|---|---|");
const unusedT = new Set(VOCAB.timings.unused_in_vanilla);
for (const t of VOCAB.timings.keys) {
  w(`| \`${t}\` | ${VOCAB.timings.arg[t] || "-"} | ${unusedT.has(t) ? "no" : "yes"} |`);
}
w();

w("## Operations");
w();
w("The operation verb and its argument live in the JSON key, for example `counter+7000001`.");
w("Only these shapes are read.");
w();
for (const s of VOCAB.operations.observed_shapes) w(`- \`${s}\``);
w();
w("Registered but never used in vanilla — do not invent a syntax from the name:");
w();
w(VOCAB.operations.registered_but_unused.map((s) => `\`${s}\``).join(", "));
w();
w("Inside these objects the keys are that operation's parameters, not further operations:");
w();
for (const [op, keys] of Object.entries(VOCAB.operations.parameter_keys_not_operations)) {
  if (op.startsWith("_")) continue;
  w(`- \`${op}\`: ${keys.map((k) => `\`${k}\``).join(", ")}`);
}
w();
w("Sentinel values that look like ids:");
w();
for (const [k, v] of Object.entries(VOCAB.operations.sentinels || {})) {
  if (k.startsWith("_")) continue;
  w(`- \`${k}\`: ${v}`);
}
w();

w("## Conditions");
w();
w("Grammar: `[!|~]<name>[.<sub>...][<cmp>]` with cmp in `>= <= <> != = < >`.");
w("The modifier is generic, so a typo such as `!foo` parses into a condition that is never true");
w("instead of failing.");
w();
w("| shape |");
w("|---|");
for (const s of VOCAB.conditions.used_shapes) w(`| \`${s}\` |`);
w();
w(`Dice checks: \`${VOCAB.conditions.dice_checks.shape}\`. Value: ${VOCAB.conditions.dice_checks.value}.`);
w(`Observed: ${VOCAB.conditions.dice_checks.observed}.`);
w();

w("## Save files");
w();
w("A save is not part of a mod and cannot be shipped. These shapes matter for reading a run");
w("and for a save editor.");
w();
for (const [name, spec] of Object.entries(SAVES)) {
  if (name.startsWith("_")) continue;
  w(`### ${name}`);
  w();
  w(`Files: ${spec.files.map((f) => `\`${f}\``).join(", ")}  `);
  w(`Class: \`${spec.class}\`  `);
  w(`Samples used: ${spec.samples}`);
  w();
  w("| key |");
  w("|---|");
  for (const f of spec.fields) w(`| \`${f}\` |`);
  w();
}
w("An unknown save key is a warning, never a failure: these shapes were read off one machine,");
w("so a newer build may add keys. A missing key is also normal, because an older build writes");
w("fewer of them.");
w();

w("## How the story graph is derived");
w();
w("`schema/edges.json` declares the id spaces, the timings and the edge rules. `tools/graph.mjs`");
w("executes it; no edge rule lives in code. Counts are deliberately absent: they depend on");
w("whether you follow descendant keys (`case:opN`, `delay`) and whether duplicates count, so");
w("`node tools/graph.mjs --check` prints them instead.");
w();
w("### Id spaces");
w();
w("| kind | range |");
w("|---|---|");
for (const [kind, range] of Object.entries(EDGES.idSpaces)) {
  if (kind.startsWith("_")) continue;
  w(`| ${kind} | ${range[0]}–${range[1]} |`);
}
w();
w("A reference outside its kind's range is not an edge: it is a cross-type pointer, and");
w("`--check` lists those separately.");
w();
w("### Timings that carry an id");
w();
w("| timing | points at | route |");
w("|---|---|---|");
for (const [timing, spec] of Object.entries(EDGES.timings)) {
  if (timing.startsWith("_")) continue;
  const route = spec.route === "annotate" ? "annotation, no edge" : "trigger, edge runs into the event";
  w(`| \`${timing}\` | ${spec.kind} | ${route} |`);
}
w();
w("Everything else in `event.on` carries a round number, a period, or nothing at all.");
w();
w("The literal `1` on a rite, card or counter timing means **any**, and only when it is the sole");
w("element: `[1, 5004832]` is a normal set. `round_begin_ba: 1` is not a wildcard, it is one round.");
w("`game_end` accepts the sentinels `-1` and `-3`; neither becomes an edge.");
w();
w("### Edge rules");
w();
w("| id | from | match | to | note |");
w("|---|---|---|---|---|");
for (const r of EDGES.rules) {
  w(`| \`${r.id}\` | ${r.from.join(", ")} | ${r.match} | ${r.to} | ${(r.note || "").replace(/\|/g, "\\|")} |`);
}
w();
w("### Known data bugs the graph reports");
w();
w("| what | why it matters |");
w("|---|---|");
for (const b of EDGES.knownDataBugs) w(`| ${b.what} | ${b.why} |`);
w();
w("## How events are classified");
w();
w("Rules are ordered and mutually exclusive: the first match wins, and the last rule absorbs");
w("the rest. `node tools/graph.mjs --check` prints each bucket's size, and the sum must equal");
w("the number of events.");
w();
w("| # | id | name | predicate |");
w("|---|---|---|---|");
CATEGORIES.rules.forEach((r, i) => {
  const when = Object.entries(r.when)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  w(`| ${i + 1} | \`${r.id}\` | ${r.name} | ${when.replace(/\|/g, "\\|")} |`);
});
w();
w(CATEGORIES.limitation);
w();

w("## Known defects in the shipped data");
w();
w("`node tools/lint.mjs` reports these against vanilla itself. They are real, not false");
w("positives, and they are why a vanilla run is not expected to exit 0.");
w();
w("| where | what |");
w("|---|---|");
w("| `event/5320511.json` | fires `rite: 5320511`, which is its own event id; no such rite exists |");
w("| `rite/5008112.json` | fires `rite: 5321118` with the comment 合伙生意, an event id in the 532xxxx range |");
w("| `loot/6001103.json` | declares `id: 6001102`, so filename and id disagree |");
w("| `config/dt/DT3.json`, `DT4.json` | declare `dialog_tree_id: DT2` |");
w("| `config/dt/DT9.json` | declares `dialog_tree_id: DT7` |");
w("| `config/tag.json` | 15 tag ids are used twice, e.g. 3020142 |");
w();

w("## Traps worth reading before writing a mod");
w();
w("- Changing one record in `event/`, `rite/`, `loot/`, `init/`, `rite_template/`, `after_story/`,");
w("  `dt/` or `wizard/` means restating that whole file. Tables (`cards.json`, `upgrade.json`,");
w("  `tag.json`, `quest.json`, `over.json`, `rite_template_mappings.json`, `sfx_*`) merge by key.");
w("- A card's `tag` keys are tag **display names**, not `code` strings. Renaming a tag orphans");
w("  every card entry and every condition that used it.");
w("- A repeated JSON key is an append, not a mistake. Never round-trip a config file through a");
w("  JSON library.");
w("- `is_key` is 0 in all 5406 vanilla slots; `restore_fill_times` is written by nothing;");
w("  `method_settlement` is always `\"\"` and `random_effect` always `{}`. No example exists.");
w("- `is_empty`, `is_replay`, `auto_begin`, `auto_result`, `is_only` and the tag `can_*` flags");
w("  are written as integers 0/1, while `start_trigger` and `final_pin` are real booleans.");
w("- `loot.item[].id` and `.num` are declared int and written as strings.");
w("- The template key is `nomal_slot_bg`, one letter short of normal. It is the real key.");
w("- `rite.location` must be `\"<region>:[min,max]\"`.");

const text = out.join("\n") + "\n";
const target = OUT_PATH ? resolve(OUT_PATH) : new URL("../schema/SCHEMA.md", import.meta.url);
if (CHECK) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    die(`${String(target)} does not exist; run the generator`);
  }
  if (current !== text) die(`${String(target)} is stale: run node tools/gen-schema-doc.mjs`);
  process.stdout.write(`schema/SCHEMA.md is up to date (${out.length} lines)\n`);
} else {
  writeFileSync(target, text);
  process.stdout.write(`wrote ${OUT_PATH || "schema/SCHEMA.md"}: ${out.length} lines\n`);
}

