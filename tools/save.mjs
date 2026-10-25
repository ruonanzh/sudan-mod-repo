#!/usr/bin/env node
/**
 * save.mjs — read a run, and change it only when asked twice.
 *
 *   node tools/save.mjs show  --save <auto_save.json>
 *   node tools/save.mjs get   --save <file> --path counter.7100001
 *   node tools/save.mjs set   --save <file> --path round=12          # prints the change only
 *   node tools/save.mjs set   --save <file> --path round=12 --write   # writes, after a .bak
 *   node tools/save.mjs cards --save <file>
 *
 * A save is rewritten by the game constantly, so a write here is always a deliberate
 * second step. Without --write nothing touches the disk.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDoc, findEntry, valueOf, literal } from "./jsonc.mjs";
import { vanillaRequirement } from "./paths.mjs";
import { expandHome } from "./paths.mjs";

function parseArgs(argv) {
  const out = { _: [], write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const emit = (code, message, next) => {
  process.stdout.write(`${code}  ${message}\n`);
  if (next) process.stdout.write(`NEXT  ${next}\n`);
};

/** Follow a dotted path, with numeric steps indexing arrays. */
function resolve(root, dotted) {
  let node = root;
  for (const step of dotted.split(".")) {
    if (!node) return null;
    // Decide by the node type, not by the shape of the step: a counter id such as
    // 7100001 is a numeric object key, not an array index.
    if (node.type === "array") node = node.items[Number(step)] || null;
    else node = node.type === "object" ? findEntry(node, step)?.value : null;
  }
  return node || null;
}

function open(file) {
  const p = expandHome(file);
  if (!existsSync(p)) throw new Error(`no such save file: ${p}`);
  return { p, doc: parseDoc(readFileSync(p, "utf8")) };
}

function show(args) {
  const { doc } = open(args.save);
  const root = doc.root;
  const num = (k) => valueOf(doc, findEntry(root, k)?.value);
  const cardsNode = findEntry(root, "cards")?.value;
  const counters = findEntry(root, "counter")?.value;
  process.stdout.write(`round        ${num("round")}\n`);
  process.stdout.write(`difficulty   ${num("difficulty")}   configId ${num("configId")}   configVersion ${num("configVersion")}\n`);
  process.stdout.write(`save time    ${num("saveTime")}\n`);
  process.stdout.write(`cards        ${cardsNode?.items?.length ?? 0} in hand, uid index ${num("card_uid_index")}\n`);
  process.stdout.write(`rites        ${findEntry(root, "rites")?.value?.items?.length ?? 0} on the board\n`);
  if (counters?.type === "object") {
    process.stdout.write(`counters     ${counters.entries.length} tracked\n`);
  }
  return 0;
}

function get(args) {
  const { doc } = open(args.save);
  if (!args.path) throw new Error("--path is required, e.g. --path counter.7100001");
  const node = resolve(doc.root, args.path);
  if (!node) {
    emit("FAIL", `no ${args.path} in this save`);
    return 1;
  }
  const value = valueOf(doc, node);
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  return 0;
}

function coerce(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^[[{]/.test(raw)) return JSON.parse(raw);
  return raw;
}

function set(args) {
  const { p, doc } = open(args.save);
  if (!args.path) throw new Error("--path is required, e.g. --path round=12");
  const at = args.path.indexOf("=");
  if (at === -1) throw new Error("--path must be key=value, e.g. --path round=12");
  const dotted = args.path.slice(0, at);
  const value = coerce(args.path.slice(at + 1));
  const node = resolve(doc.root, dotted);
  if (!node) {
    emit("FAIL", `no ${dotted} in this save. Use \`show\` to see what exists; a new key would be ignored or corrupt the run.`);
    return 1;
  }
  const before = valueOf(doc, node);

  // A uid index below an existing uid breaks the bag lookup the game indexes by uid.
  if (dotted === "card_uid_index") {
    const cards = findEntry(doc.root, "cards")?.value;
    const worst = cards?.items?.reduce((m, n) => Math.max(m, Number(valueOf(doc, findEntry(n, "uid")?.value) ?? -1)), -1) ?? -1;
    if (typeof value === "number" && value <= worst) {
      emit("FAIL", `card_uid_index ${value} is not above the highest card uid ${worst}; the bag index would collide.`);
      return 1;
    }
  }

  doc.set(node, literal(value));
  process.stdout.write(`${dotted}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}\n`);

  if (!args.write) {
    emit("INFO", "preview only; add --write to apply");
    return 0;
  }
  copyFileSync(p, `${p}.bak`);
  writeFileSync(p, doc.render());
  emit("PASS", `wrote ${path.basename(p)} (backup at ${path.basename(p)}.bak)`, "start the game from Continue");
  return 0;
}

let nameCache = null;
/** Card id -> name, from the vanilla config the caller already verified. */
function cardNames(vanillaDir) {
  if (nameCache) return nameCache;
  nameCache = new Map();
  const file = path.join(vanillaDir, "cards.json");
  if (!existsSync(file)) return nameCache;
  const doc = parseDoc(readFileSync(file, "utf8"));
  for (const entry of doc.root.entries) {
    const name = valueOf(doc, findEntry(entry.value, "name")?.value);
    if (name) nameCache.set(entry.key, name);
  }
  return nameCache;
}

function cards(args) {
  const { doc } = open(args.save);
  // Without the config every card prints a blank name. An empty column looks like a data
  // problem, so say what is actually missing and stop.
  const requirement = vanillaRequirement(args.vanilla);
  if (!requirement.dir) {
    emit("FAIL", requirement.message, requirement.next);
    return 1;
  }
  const names = cardNames(requirement.dir);
  const list = findEntry(doc.root, "cards")?.value;
  if (!list || list.type !== "array") {
    emit("FAIL", "this save has no cards array; it may not be a run save");
    return 1;
  }
  const index = Number(valueOf(doc, findEntry(doc.root, "card_uid_index")?.value) ?? 0);
  let bad = 0;
  for (const item of list.items) {
    const uid = Number(valueOf(doc, findEntry(item, "uid")?.value) ?? -1);
    const id = valueOf(doc, findEntry(item, "id")?.value);
    const name = valueOf(doc, findEntry(item, "name")?.value) ?? names.get(String(id)) ?? "";
    const count = valueOf(doc, findEntry(item, "count")?.value) ?? 1;
    const flag = uid >= index ? "  uid>=index" : "";
    if (uid >= index) bad++;
    process.stdout.write(`uid ${String(uid).padEnd(6)} id ${String(id).padEnd(9)} x${String(count).padEnd(3)} ${name}${flag}\n`);
  }
  if (bad) {
    emit("WARN", `${bad} card(s) have a uid at or above card_uid_index ${index}; the bag index is built from uid`);
    return 0;
  }
  emit("INFO", `${list.items.length} card(s), all uids below card_uid_index ${index}`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const table = { show, get, set, cards };
  if (!cmd || !table[cmd]) {
    process.stderr.write("usage: node tools/save.mjs <show|get|set|cards> --save <file> [--path ...] [--write] [--vanilla <config dir>]\n");
    return 2;
  }
  try {
    return table[cmd](args);
  } catch (e) {
    emit("FAIL", e.message);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("save.mjs")) process.exit(main());
