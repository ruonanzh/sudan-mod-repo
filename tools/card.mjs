#!/usr/bin/env node
/**
 * card.mjs — create and change cards without touching the rest of the file.
 *
 *   node tools/card.mjs new  --mod your_mods/x --id 2100900 --name 流浪的佣兵团 \
 *        --type item --rare 4 --text "一支流浪的军队。" --tag 体魄+2 --tag 战斗+2
 *   node tools/card.mjs set  --mod your_mods/x --id 2100900 --field text "新说明"
 *   node tools/card.mjs tag  --mod your_mods/x --id 2100900 --add 已拥有 --remove 纯色材质
 *   node tools/card.mjs show --mod your_mods/x --id 2100900
 *   node tools/card.mjs list --mod your_mods/x
 *   node tools/card.mjs art  --mod your_mods/x --id 2100900 --from art.png
 *
 * Every write is refused if it would produce a record the validator rejects.
 * Add --dry-run to see the resulting text instead of writing it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { openMod, ModelError, FIELDS, DEFAULT_VANILLA } from "./model.mjs";
import { parseDoc, findEntry, findEntries, getDoc, sourceOf, literal } from "./jsonc.mjs";

const CARD_W = 472;
const CARD_H = 1028;

function parseArgs(argv) {
  const out = { _: [], tags: [], add: [], remove: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--tag") out.tags.push(argv[++i]);
    else if (a === "--add") out.add.push(argv[++i]);
    else if (a === "--remove") out.remove.push(argv[++i]);
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const emit = (code, message, next) => {
  process.stdout.write(`${code}  ${message}\n`);
  if (next) process.stdout.write(`NEXT  ${next}\n`);
};

/** "体魄+2" or "体魄" (means 1) -> [name, value] */
function parseTagSpec(spec) {
  const m = /^(.+?)([+-]\d+)?$/.exec(spec);
  if (!m) throw new ModelError(`tag ${JSON.stringify(spec)} is not of the form 体魄+2`);
  return [m[1], m[2] ? Number(m[2]) : 1];
}

/** Minimal PNG header check: no dependency, and the game only reads PNG. */
function pngSize(file) {
  const buf = readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

function newCard(args) {
  const mod = openMod(args.mod);
  const id = Number(args.id);
  if (!Number.isInteger(id)) throw new ModelError("--id must be an integer");
  if (!args.name) throw new ModelError("--name is required");
  const tag = {};
  for (const spec of args.tags) {
    const [name, value] = parseTagSpec(spec);
    tag[name] = value;
  }
  const record = {
    id,
    name: args.name,
    title: args.title || "",
    text: args.text || "",
    pops: [],
    card_favour: "",
    type: args.type || "item",
    tips: "",
    rare: Number(args.rare || 1),
    resource: [`cards/${id}`],
    tag,
    card_vanishing: 0,
    vanish: {},
    equips: args.equips ? args.equips.split(",") : [],
    is_only: args["is-only"] === "0" ? 0 : 1,
  };
  mod.add("card", record);
  return finish(mod, args, `card ${id} created`);
}

function setCard(args) {
  const mod = openMod(args.mod);
  const id = args.id;
  if (!args.field) throw new ModelError("--field is required, e.g. --field text");
  const raw = args._[0] ?? args.value;
  if (raw === undefined) throw new ModelError("a value is required");
  const field = String(args.field);
  if (field === "tag") throw new ModelError('use `card tag --add 体魄+2` instead of setting tag wholesale');
  mod.set("card", id, [field], coerce(raw));
  return finish(mod, args, `card ${id} field ${field} set`);
}

/** Numbers and booleans in the CLI should become JSON numbers and booleans. */
function coerce(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function tagCard(args) {
  const mod = openMod(args.mod);
  const id = args.id;
  const got = mod.get("card", id);
  if (!got) throw new ModelError(`no card ${id} in this mod`);
  const doc = got.doc;
  const record = findEntry(doc.root, String(id)).value;
  let tagNode = findEntry(record, "tag")?.value;
  if (!tagNode || tagNode.type !== "object") throw new ModelError(`card ${id} has no tag object`);
  for (const spec of args.add) {
    const [name, value] = parseTagSpec(spec);
    const existing = findEntries(tagNode, name).at(-1);
    if (existing) doc.set(existing.value, literal(value));
    else doc.append(tagNode, name, literal(value));
  }
  for (const name of args.remove) {
    const existing = findEntries(tagNode, name).at(-1);
    if (existing) doc.remove(tagNode, name);
  }
  return finish(mod, args, `card ${id} tags updated`);
}

function showCard(args) {
  const mod = openMod(args.mod);
  const got = mod.get("card", args.id);
  if (!got) {
    emit("FAIL", `no card ${args.id} in this mod`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(got.fields, null, 2)}\n`);
  return 0;
}

function listCards(args) {
  const mod = openMod(args.mod);
  const ids = mod.ids("card");
  if (!ids.length) {
    emit("INFO", "this mod defines no cards");
    return 0;
  }
  for (const id of ids) {
    const got = mod.get("card", id);
    const f = got.fields;
    process.stdout.write(`${id}  ${f.name ?? "?"}  type=${f.type ?? "?"}  rare=${f.rare ?? "?"}\n`);
  }
  return 0;
}

function addArt(args) {
  const mod = openMod(args.mod);
  if (!args.from) throw new ModelError("--from <png> is required");
  if (!existsSync(args.from)) throw new ModelError(`no such file: ${args.from}`);
  const size = pngSize(args.from);
  if (!size) {
    emit("FAIL", `${args.from} is not a PNG; the game ignores anything else in image/`);
    return 1;
  }
  if (size.width !== CARD_W || size.height !== CARD_H) {
    emit("FAIL", `art is ${size.width}x${size.height}; a card face is ${CARD_W}x${CARD_H}. A different ratio is distorted.`);
    return 1;
  }
  const target = path.join(mod.dir, "image", "cards", `${args.id}.png`);
  if (args.dryRun) {
    emit("INFO", `would copy ${args.from} to ${path.relative(mod.dir, target)}`);
    return 0;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(args.from, target);
  // The card must point at that sprite, or the file is never read.
  const got = mod.get("card", args.id);
  if (got) {
    mod.set("card", args.id, ["resource"], [`cards/${args.id}`]);
    mod.save();
  }
  emit("PASS", `art installed at ${path.relative(mod.dir, target)}`);
  return 0;
}

/** Write (or print) and then report honestly. */
function finish(mod, args, message) {
  if (args.dryRun) {
    for (const { file, text } of mod.diff()) {
      process.stdout.write(`--- ${path.relative(mod.dir, file)} (would become)\n${text}\n`);
    }
    emit("INFO", `${message} (dry run, nothing written)`);
    return 0;
  }
  const written = mod.save();
  if (!written.length) {
    emit("INFO", "nothing changed");
    return 0;
  }
  for (const file of written) process.stdout.write(`wrote ${path.relative(mod.dir, file)}\n`);
  emit("PASS", message, "run `node tools/lint.mjs <modDir>` before you install");
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!cmd || !["new", "set", "tag", "show", "list", "art"].includes(cmd)) {
    process.stderr.write("usage: node tools/card.mjs <new|set|tag|show|list|art> --mod <dir> [options]\n");
    return 2;
  }
  try {
    switch (cmd) {
      case "new": return newCard(args);
      case "set": return setCard(args);
      case "tag": return tagCard(args);
      case "show": return showCard(args);
      case "list": return listCards(args);
      case "art": return addArt(args);
      default: return 2;
    }
  } catch (e) {
    if (e instanceof ModelError) {
      emit("FAIL", e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("card.mjs")) process.exit(main());
