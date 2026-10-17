#!/usr/bin/env node
/**
 * story.mjs — create and extend events and rites.
 *
 * These are the hard shapes: one record per file, deeply nested, and duplicate keys
 * everywhere because a repeated key is how the game appends a second operation.
 *
 *   node tools/story.mjs event new    --mod m --id 5901000 --text 书店营业 --on round_begin_ba=1
 *   node tools/story.mjs event branch --mod m --id 5901000 --action 'rite=5010901'
 *   node tools/story.mjs rite  new    --mod m --id 5010901 --name 语义探针 --location '自宅:[1,10]'
 *   node tools/story.mjs rite  slot   --mod m --id 5010901 --slot s2 --is-empty 1
 *   node tools/story.mjs rite  op     --mod m --id 5010901 --at settlement.0.result --op 'counter+7000163=1'
 *
 * `--op` writes by appending, never by replacing. Two `event_on` in the same action
 * object are two events; passing the same --op twice must produce two keys.
 *
 * Value syntax for --op is `<key>=<json>`. The split is at the LAST '=' because a key
 * may contain one: `global_counter=7230001=1` is key `global_counter=7230001`, value 1.
 * With no '=' at all the value is 1.
 */
import { randomUUID } from "node:crypto";
import { openMod, ModelError, LAYOUT } from "./model.mjs";
import { findEntry, findEntries, getDoc, literal } from "./jsonc.mjs";

function parseArgs(argv) {
  const out = { _: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const emit = (code, message, next) => {
  process.stdout.write(`${code}  ${message}\n`);
  if (next) process.stdout.write(`NEXT  ${next}\n`);
};

const num = (v, what) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ModelError(`${what} must be a number, not ${JSON.stringify(v)}`);
  return n;
};

/** Parse `key=value` into the operation key and a JSON literal. */
export function parseOp(spec) {
  if (!spec) throw new ModelError("--op needs a value, e.g. counter+7000163=1");
  const at = spec.lastIndexOf("=");
  if (at === -1) return { key: spec, value: "1" };
  const key = spec.slice(0, at);
  const raw = spec.slice(at + 1);
  if (!key) throw new ModelError(`--op ${JSON.stringify(spec)} has an empty key`);
  // Bare words stay strings; numbers, true/false, null and JSON stay themselves.
  const value = /^-?\d+(\.\d+)?$/.test(raw) || raw === "true" || raw === "false" || raw === "null" ? raw : JSON.stringify(raw);
  return { key, value };
}

/** Parse `timing=arg` for --on. */
function parseTiming(spec) {
  const at = spec.indexOf("=");
  if (at === -1) return { key: spec, value: "1" };
  const key = spec.slice(0, at);
  const raw = spec.slice(at + 1);
  const value = /^-?\d+$/.test(raw) ? raw : JSON.stringify(raw);
  return { key, value };
}

function eventNew(args) {
  const mod = openMod(args.mod);
  const id = num(args.id, "--id");
  if (!args.text) throw new ModelError("--text is required; it is the event card's line");
  const timing = parseTiming(args.on || "round_begin_ba=1");
  const record = {
    id,
    text: args.text,
    is_replay: args.replay === "0" ? 0 : 1,
    start_trigger: true,
    on: { [timing.key]: Number(timing.value) || timing.value },
    condition: {},
    settlement: [],
  };
  // An event no list names and no other event fires never runs. init 1 is the normal run.
  const inits = (args["auto-start-init"] || "1").split(",").map((s) => Number(s.trim()));
  if (inits.length) record.auto_start_init = inits;
  mod.add("event", record);
  return finish(mod, args, `event ${id} created`);
}

/**
 * Append one settlement branch. `into` names the array: settlement, settlement_prior
 * or settlement_extre. The array is rewritten with one more element, and every existing
 * element keeps its original source text.
 */
function addBranch(args) {
  const kind = args.kind;
  const into = args.into || (kind === "event" ? "settlement" : "settlement");
  const mod = openMod(args.mod);
  const id = args.id;
  const got = mod.get(kind, id);
  if (!got) throw new ModelError(`no ${kind} ${id} in this mod`);
  const doc = got.doc;
  const array = findEntry(doc.root, into)?.value;
  if (!array || array.type !== "array")
    throw new ModelError(`${kind} ${id} has no ${into} array. Valid arrays: settlement, settlement_prior, settlement_extre.`);
  const branch = {
    guid: randomUUID(),
    condition: args.condition ? JSON.parse(args.condition) : {},
    result_title: args["result-title"] || "",
    result_text: args["result-text"] || "",
    result: {},
    action: {},
  };
  const items = array.items.map((n) => doc.text.slice(n.start, n.end));
  items.push(JSON.stringify(branch, null, 4).replace(/\n/g, "\n    "));
  doc.set(array, `[\n    ${items.join(",\n    ")}\n]`);
  if (args.action) {
    const fresh = mod.get(kind, id);
    const freshDoc = fresh.doc;
    const added = findEntry(freshDoc.root, into).value.items.at(-1);
    const action = findEntry(added, "action").value;
    const op = parseOp(args.action);
    freshDoc.append(action, op.key, op.value);
  }
  return finish(mod, args, `${kind} ${id} branch added to ${into}`);
}

function eventBranch(args) {
  return addBranch({ ...args, kind: "event", into: args.into || "settlement" });
}

function riteBranch(args) {
  const into = args.into || "settlement";
  if (!["settlement", "settlement_prior", "settlement_extre", "waiting_round_end_action"].includes(into))
    throw new ModelError(`--into must be settlement, settlement_prior, settlement_extre or waiting_round_end_action`);
  return addBranch({ ...args, kind: "rite", into });
}

function riteNew(args) {
  const mod = openMod(args.mod);
  const id = num(args.id, "--id");
  if (!args.name) throw new ModelError("--name is required");
  const record = {
    id,
    name: args.name,
    text: args.text || "",
    tips: "",
    once_new: num(args["once-new"]) ?? 0,
    round_number: num(args["round-number"]) ?? 1,
    waiting_round: num(args["waiting-round"]) ?? 0,
    waiting_round_end_action: [],
    method_settlement: "",
    auto_begin: 0,
    auto_result: 0,
    location: args.location || "自宅:[1,10]",
    icon: args.icon || "rite_9",
    tag_tips: [],
    tag_tips_up: {},
    tips_text: args["tips-text"] ? [args["tips-text"]] : [],
    open_conditions: [],
    random_text: {},
    random_text_up: {},
    settlement_prior: [],
    settlement: [],
    settlement_extre: [],
    cards_slot: {},
  };
  mod.add("rite", record);
  return finish(mod, args, `rite ${id} created`);
}

function riteSlot(args) {
  const mod = openMod(args.mod);
  const id = args.id;
  const slotName = args.slot;
  if (!slotName) throw new ModelError("--slot is required, e.g. --slot s2");
  if (!/^s\d+$/.test(slotName)) throw new ModelError(`slot ${JSON.stringify(slotName)} must be s1..sN`);
  const got = mod.get("rite", id);
  if (!got) throw new ModelError(`no rite ${id} in this mod`);
  const doc = got.doc;
  const slot = {
    guid: randomUUID(),
    condition: args.condition ? JSON.parse(args.condition) : {},
    open_adsorb: 0,
    is_key: 0,
    // 0 means the slot may not be left empty; 1 means it may. Vanilla writes 不能为空 next to 0.
    is_empty: args["is-empty"] === undefined ? 1 : num(args["is-empty"], "--is-empty"),
    is_enemy: 0,
    text: args.text || "",
    pops: [],
  };
  const slots = findEntry(doc.root, "cards_slot")?.value;
  if (!slots) throw new ModelError(`rite ${id} has no cards_slot object`);
  const existing = findEntries(slots, slotName);
  if (existing.length) throw new ModelError(`rite ${id} already has a slot ${slotName}`);
  doc.append(slots, slotName, JSON.stringify(slot, null, 4).replace(/\n/g, "\n        "));
  return finish(mod, args, `rite ${id} slot ${slotName} added`);
}

function riteOp(args) {
  const mod = openMod(args.mod);
  if (!args.at) throw new ModelError("--at is required, e.g. --at settlement.0.result");
  const op = parseOp(args.op);
  const got = mod.get("rite", args.id);
  if (!got) throw new ModelError(`no rite ${args.id} in this mod`);
  const doc = got.doc;
  const fieldPath = args.at.split(".");
  const parentPath = fieldPath.slice(0, -1);
  const leaf = fieldPath[fieldPath.length - 1];
  let parent = resolve(doc.root, parentPath);
  if (!parent) throw new ModelError(`rite ${args.id} has no ${parentPath.join(".")}`);
  let target = findEntries(parent, leaf).at(-1)?.value;
  if (!target) {
    // Create the leaf as an empty object, then append into it.
    doc.append(parent, leaf, "{}");
    parent = resolve(doc.root, parentPath);
    target = findEntries(parent, leaf).at(-1)?.value;
  }
  if (!target || target.type !== "object") throw new ModelError(`${args.at} is not an object`);
  // Always append: a second operation is a second key, not an overwrite.
  doc.append(target, op.key, op.value);
  return finish(mod, args, `rite ${args.id} ${args.at} += ${op.key}`);
}

function resolve(root, fieldPath) {
  let node = root;
  for (const step of fieldPath) {
    if (!node) return null;
    if (/^\d+$/.test(step)) {
      if (node.type !== "array") return null;
      node = node.items[Number(step)] || null;
    } else {
      node = node.type === "object" ? findEntry(node, step)?.value : null;
    }
  }
  return node || null;
}

function finish(mod, args, message) {
  if (args.dryRun) {
    for (const { file, text } of mod.diff()) {
      process.stdout.write(`--- ${file} (would become)\n${text}\n`);
    }
    emit("INFO", `${message} (dry run, nothing written)`);
    return 0;
  }
  const written = mod.save();
  if (!written.length) {
    emit("INFO", "nothing changed");
    return 0;
  }
  for (const f of written) process.stdout.write(`wrote ${f}\n`);
  emit("PASS", message, "run `node tools/lint.mjs <modDir>` before you install");
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const [group, cmd] = argv;
  const args = parseArgs(argv.slice(2));
  const table = {
    "event new": eventNew,
    "event branch": eventBranch,
    "rite new": riteNew,
    "rite branch": riteBranch,
    "rite slot": riteSlot,
    "rite op": riteOp,
  };
  const fn = table[`${group} ${cmd}`];
  if (!fn) {
    process.stderr.write(
    "usage: node tools/story.mjs <event new|event branch|rite new|rite branch|rite slot|rite op> --mod <dir> [options]\n",
  );
    return 2;
  }
  try {
    return fn(args);
  } catch (e) {
    if (e instanceof ModelError) {
      emit("FAIL", e.message);
      return 1;
    }
    if (e instanceof SyntaxError) {
      emit("FAIL", `the JSON you passed is not valid: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("story.mjs")) process.exit(main());
