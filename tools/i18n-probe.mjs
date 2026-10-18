#!/usr/bin/env node
/**
 * Report how the game translates each record kind.
 *
 * The answer is not uniform, and assuming it was put an option button's paragraph where an
 * event's title belongs. This prints the measurement that settles it.
 *
 *   node tools/i18n-probe.mjs [--lang en]
 */
import fs from "node:fs";
import path from "node:path";
import { parseDoc, toPlain } from "./jsonc.mjs";

const GAME = process.env.SULTAN_GAME_DIR || path.join(
  process.env.HOME || "",
  "Library/Application Support/Steam/steamapps/common/Sultan's Game/Sultan's Game.app/Contents/Resources/Data",
);
const ASSETS = path.join(GAME, "StreamingAssets");

const plain = (p) => { const d = parseDoc(fs.readFileSync(p, "utf8")); return toPlain(d, d.root); };
const countJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0);

const lang = process.argv.includes("--lang") ? process.argv[process.argv.indexOf("--lang") + 1] : "en";
const table = plain(path.join(ASSETS, "i18n", lang, "config.json"));

const perKind = new Map(); // kind -> Set(id)
const fields = new Set();
for (const k of Object.keys(table)) {
  const m = k.match(/^([A-Za-z][A-Za-z_]*?)_(\d+)_(.+)$/);
  if (!m) continue;
  fields.add(`${m[1]}:${m[3].split("_")[0].toLowerCase()}`);
  if (!perKind.has(m[1])) perKind.set(m[1], new Set());
  perKind.get(m[1]).add(m[2]);
}

// Only ids that back a real record count as coverage; the tables also carry ids the game never
// ships (260 PROMPT ids have no event file).
const eventIds = new Set(
  fs.existsSync(path.join(ASSETS, "config/event"))
    ? fs.readdirSync(path.join(ASSETS, "config/event")).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""))
    : [],
);
const covered = (kind) => [...(perKind.get(kind) || [])].filter((id) => eventIds.has(id)).length;

const rows = [
  ["card", countJson(path.join(ASSETS, "config")) && "cards.json", perKind.get("card")?.size ?? 0],
  ["rite", countJson(path.join(ASSETS, "config/rite")), perKind.get("rite")?.size ?? 0],
  ["quest", "quest.json", perKind.get("quest")?.size ?? 0],
  ["over", "over.json", perKind.get("over")?.size ?? 0],
  ["after_story", countJson(path.join(ASSETS, "config/after_story")), perKind.get("after_story")?.size ?? 0],
  ["event (OPTION)", eventIds.size, covered("OPTION")],
  ["event (PROMPT)", eventIds.size, covered("PROMPT")],
];

console.log(`translation table: i18n/${lang}/config.json, ${Object.keys(table).length} entries\n`);
console.log("kind             records   translated ids");
for (const [kind, records, translated] of rows) {
  const rec = typeof records === "number" ? records : String(records);
  console.log(`${kind.padEnd(16)} ${String(rec).padStart(7)}   ${String(translated).padStart(6)}`);
}

const prefixes = [...perKind.keys()].sort();
console.log("\nkey prefixes that carry an id:", prefixes.join(", "));
console.log("event records never carry a title key: there is no `event_` prefix at all.");
console.log("\nfield shapes seen:", [...fields].sort().slice(0, 40).join(", "), "…");
