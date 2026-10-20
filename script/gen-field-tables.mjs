#!/usr/bin/env node
/**
 * script/gen-field-tables.mjs — rebuild `schema/fields.json` from the field census.
 *
 *   node script/gen-field-tables.mjs --write     rewrite schema/fields.json
 *   node script/gen-field-tables.mjs --check     exit 1 if the file on disk differs
 *   node script/gen-field-tables.mjs --census <path> --write
 *
 * The census is `docs/sudan-game/fields/21-handler-keys.md` in the planning repo: one
 * `### N. ClassName` section per handler, each with a "Counts: readers R / ..." line, a
 * `| key | reader index | field | offset |` table, and two labelled lists:
 *
 *   **corpus-only** (authored, never registered): `a`, `b`.
 *   **declared but unregistered**: `c` (0x10).
 *
 * Those three pieces map one-to-one onto the shape this file emits:
 *
 *   fields  the registered key, in reader order      (what the loader reads into a field)
 *   meta    { reader: "b__0_N", offset: "0x1c" }     (the evidence for that claim)
 *   legacy  corpus-only + declared-but-unregistered  (written by someone, read by nobody)
 *
 * A key is in exactly one of `fields` / `legacy`. There is no third bucket: an earlier
 * version had `handler` for "registered, but reached another way", and it silently mixed
 * live keys (`wizard.name`) with dead ones (`card.tips`), so the validator accepted both.
 *
 * The generator is the only writer. `--check` is what CI and the tests use.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "schema/fields.json");

/** Census section number → the kind name this repo uses. Order is the census order. */
export const SECTION_KIND = {
  1: "card",
  2: "event",
  3: "rite",
  4: "slot",
  5: "riteSlotPop",
  6: "riteOpenCondition",
  7: "riteTagTipsUp",
  8: "riteRandomTextUp",
  9: "riteFromPin",
  10: "settlement",
  11: "loot",
  12: "lootItem",
  13: "upgrade",
  14: "tag",
  15: "init",
  16: "initDifficulty",
  17: "quest",
  18: "questTargetItem",
  19: "over",
  20: "afterStory",
  21: "wizard",
  22: "wizardOption",
  23: "riteTemplate",
  24: "slotPosition",
  25: "pos",
  26: "riteMapping",
  27: "dtRoot",
  28: "dtWord",
  29: "dtOption",
  30: "sfxTop",
  31: "sfxLoop",
  32: "sfxArmageddonLoop",
  33: "game",
  34: "gameMap",
  35: "gamePoint",
  36: "gameMapLocation",
  37: "gameEquipIcon",
  38: "gameCardMaterial",
  39: "gameCardMaterialGroup",
};

/** Kinds this repo needs that the census has no section of its own for. */
const ALIASES = {
  // after_story.prior[] / extra[] entries are RiteNode.Settlement objects, so the key set
  // is the settlement key set. The old table listed 5 of the 12, which made `action` and
  // `result` FAIL even though OverNewStep2StoryController runs both.
  afterStoryExtra: "settlement",
};

/** Parse one census document into { sectionNumber: { cls, readers, fields, legacy } }. */
export function parseCensus(markdown) {
  const lines = markdown.split("\n");
  const out = new Map();
  let cur = null;
  let inTable = false;
  let expectCounts = false;

  const strip = (s) => s.replace(/`/g, "").trim();
  const listAfter = (line, label) => {
    const idx = line.indexOf(label);
    if (idx < 0) return null;
    return (line.slice(idx + label.length).match(/`[^`]+`/g) || []).map(strip);
  };

  for (const line of lines) {
    const head = line.match(/^### (\d+)\. `([^`]+)`/);
    if (head) {
      cur = { num: Number(head[1]), cls: head[2], readers: null, fields: [], corpusOnly: [], unregistered: [] };
      out.set(cur.num, cur);
      inTable = false;
      expectCounts = true;
      continue;
    }
    if (!cur) continue;

    if (expectCounts) {
      const counts = line.match(/\*\*Counts: readers (\d+) \/ declared fields (\d+) \//);
      if (counts) {
        cur.readers = Number(counts[1]);
        cur.declared = Number(counts[2]);
        expectCounts = false;
        continue;
      }
    }

    if (/^\| key \| reader index \|/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (/^\|---/.test(line)) continue;
      if (!line.startsWith("|")) {
        inTable = false;
      } else {
        const cells = line.split("|").slice(1, -1).map(strip);
        if (cells.length >= 4) cur.fields.push({ key: cells[0], reader: cells[1], field: cells[2], offset: cells[3] });
        continue;
      }
    }

    const corpusOnly = listAfter(line, "**corpus-only**");
    if (corpusOnly) cur.corpusOnly.push(...corpusOnly);
    const declaredOnly = listAfter(line, "**declared but unregistered**:");
    if (declaredOnly) cur.unregistered.push(...declaredOnly);
  }

  for (const sec of out.values()) {
    const keys = new Set(sec.fields.map((f) => f.key));
    const clean = (list) => [...new Set(list)].filter((k) => !keys.has(k)).sort();
    sec.corpusOnly = clean(sec.corpusOnly);
    sec.unregistered = clean(sec.unregistered);
    sec.legacy = [...new Set([...sec.corpusOnly, ...sec.unregistered])].sort();
  }
  return out;
}

/** Turn a parsed census into the fields.json shape. */
export function build(census) {
  const out = {};
  for (const [num, kind] of Object.entries(SECTION_KIND).sort((a, b) => a[0] - b[0])) {
    const sec = census.get(Number(num));
    if (!sec) throw new Error(`census has no section ${num} (expected for kind "${kind}")`);
    const seen = new Set();
    const fields = [];
    const meta = {};
    for (const row of sec.fields) {
      if (seen.has(row.key)) continue; // the table repeats a key when two readers bind it
      seen.add(row.key);
      fields.push(row.key);
      meta[row.key] = { reader: row.reader, offset: row.offset };
    }
    out[kind] = { fields, meta, legacy: sec.legacy };
  }
  for (const [kind, from] of Object.entries(ALIASES)) {
    out[kind] = JSON.parse(JSON.stringify(out[from]));
  }
  return out;
}

/** Sanity checks that make a silent census edit loud. */
export function verify(census, built) {
  const problems = [];
  for (const [num, kind] of Object.entries(SECTION_KIND)) {
    const sec = census.get(Number(num));
    if (!sec) {
      problems.push(`section ${num} (${kind}) missing`);
      continue;
    }
    const spec = built[kind];
    if (sec.readers != null && sec.fields.length !== sec.readers)
      problems.push(`section ${num} (${kind}): table lists ${sec.fields.length} rows, header says ${sec.readers} readers`);
    if (sec.readers != null && spec.fields.length !== sec.readers)
      problems.push(`kind ${kind}: emitted ${spec.fields.length} fields, census says ${sec.readers} readers`);
    // A declared field is either registered (has a reader) or declared-but-unregistered.
    // corpus-only keys are not declared at all, so they must not enter this sum.
    if (sec.declared != null && sec.fields.length + sec.unregistered.length !== sec.declared)
      problems.push(
        `kind ${kind}: ${sec.fields.length} readers + ${sec.unregistered.length} unregistered != ${sec.declared} declared fields`,
      );
    const overlap = spec.legacy.filter((k) => spec.fields.includes(k));
    if (overlap.length) problems.push(`kind ${kind}: ${overlap.join(", ")} is in both fields and legacy`);
    const noMeta = spec.fields.filter((k) => !spec.meta[k]);
    if (noMeta.length) problems.push(`kind ${kind}: ${noMeta.join(", ")} has no meta entry`);
  }
  for (const kind of Object.keys(ALIASES)) {
    if (!built[kind]) problems.push(`alias kind ${kind} was not emitted`);
  }
  return problems;
}

function censusPath(argv) {
  const i = argv.indexOf("--census");
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (process.env.SUDAN_CENSUS) return path.resolve(process.env.SUDAN_CENSUS);
  return path.resolve(
    REPO,
    "../desktop-gamer-agent-pi/docs/sudan-game/fields/21-handler-keys.md",
  );
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  const src = censusPath(argv);
  let md;
  try {
    md = readFileSync(src, "utf8");
  } catch {
    process.stderr.write(
      `census not found: ${src}\nPass --census <path> or set SUDAN_CENSUS.\n` +
        "The census lives in the planning repo: docs/sudan-game/fields/21-handler-keys.md\n",
    );
    process.exit(2);
  }
  const census = parseCensus(md);
  const built = build(census);
  const problems = verify(census, built);
  if (problems.length) {
    process.stderr.write(`census and table disagree:\n  ${problems.join("\n  ")}\n`);
    process.exit(1);
  }
  const text = JSON.stringify(built, null, 2) + "\n";
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* first run */
  }
  if (check) {
    if (current === text) {
      process.stdout.write(`schema/fields.json matches the census (${Object.keys(built).length} kinds)\n`);
      process.exit(0);
    }
    process.stderr.write("schema/fields.json differs from the census; run --write\n");
    process.exit(1);
  }
  if (write) {
    writeFileSync(OUT, text);
    process.stdout.write(`wrote schema/fields.json: ${Object.keys(built).length} kinds\n`);
    return;
  }
  process.stdout.write(`${Object.keys(built).length} kinds, ${check ? "" : "--write to apply\n"}`);
}

if (process.argv[1]?.endsWith("gen-field-tables.mjs")) main();
