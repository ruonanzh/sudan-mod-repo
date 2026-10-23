#!/usr/bin/env node
/**
 * preview.mjs — one command that turns what a mod carries into pages a player can open.
 *
 *   node tools/preview.mjs --mod your_mods/<ModName> [--focus kind:id] [--out <dir>]
 *   node tools/preview.mjs --mod your_mods/<ModName> --collect
 *   node tools/preview.mjs --mod your_mods/<ModName> --apply
 *
 * A mod is data, and a page is how a player checks that data before installing it:
 *
 *   graph.html          the story graph, for a rite's or an event's place in the story around it
 *   <id>.card.html      one page per card: the card page editors/page/page.mjs renders, as controls
 *   <kind>-<id>.record.html  one read-only page per rite or event, with every field it carries
 *
 * Which records exist is read from schema/layout.json — the table model.mjs reads and a test
 * keeps in step with lint — so a kind added there shows up here without a second mapping.
 * Everything lands in <mod>/.preview/ unless --out says otherwise, and a mod with no records
 * writes nothing: an empty page is worse than an honest line.
 *
 * A card page edits itself, not the mod: its values live in a JSON block at the end of its own
 * `<body>`, written by the app editor tool `editors/card`. `--collect` prints the
 * values that differ from config/cards.json, and `--apply` writes only those keys back with
 * tools/jsonc.mjs, so comments and field order survive. Regenerating a page keeps the values it
 * already carries, because an edit waiting to be applied must not be lost to a layout refresh.
 * The story graph is still written by editors/graph/graphpage.mjs, which owns that view, and `--focus` is
 * handed to it so the preview opens on the thing it was run for.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lint.mjs";
import { esc, pageHtml } from "../editors/lib/shell.mjs";
import { shorten, vanillaRequirement } from "./paths.mjs";
import { applyCardValues, cardPageHtml, missingValues, pendingValues, readPageValues } from "../editors/card/page.mjs";
import { recordPageHtml } from "../editors/page/page.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYOUT = JSON.parse(readFileSync(new URL("../schema/layout.json", import.meta.url), "utf8"));
/** The app editor tool that opens one `*.card.html`; the index names it too. */
const CARD_PAGE_EDITOR = JSON.parse(
  readFileSync(new URL("../editors/card/.editor.tool.json", import.meta.url), "utf8")
);
const CARD_TABLE = LAYOUT.table.card.file;

/** Kinds the story graph draws. The rest of a mod is listed in the index and has no page. */
const GRAPH_KINDS = new Set(["event", "rite", "loot", "quest", "over", "afterStory", "riteTemplate"]);


/** A record's own name: a card and a rite carry one, an event's designer note is its identity. */
function nameOf(rec) {
  if (!rec || typeof rec !== "object") return "";
  return String(rec.name || rec.text || "");
}

/** Parse one record file, naming it: the parser only knows a position, not which file it was. */
function readRecord(file) {
  try {
    return parseJsonc(readFileSync(file, "utf8")).value;
  } catch (e) {
    throw new Error(`${displayPath(file)}: ${e.message || e}`);
  }
}

/**
 * Every record a mod carries, in layout order: `[{ kind, id, name }]`. Table files are read by
 * key, directory kinds by file name, single files by their own name. A `_`-prefixed table key
 * is a comment the game ignores, so it is not a record.
 */
export function modRecords(modDir) {
  const out = [];
  const push = (kind, id, rec) => out.push({ kind, id: String(id), name: nameOf(rec), record: rec });
  for (const [kind, spec] of Object.entries(LAYOUT.table)) {
    const file = path.join(modDir, spec.file);
    if (!existsSync(file)) continue;
    const table = readRecord(file) || {};
    for (const id of Object.keys(table)) if (!id.startsWith("_")) push(kind, id, table[id]);
  }
  for (const [kind, spec] of Object.entries(LAYOUT.dir)) {
    const dir = path.join(modDir, spec.dir);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      push(kind, name.replace(/\.json$/, ""), readRecord(path.join(dir, name)));
    }
  }
  for (const [kind, spec] of Object.entries(LAYOUT.single)) {
    const file = path.join(modDir, spec.file);
    if (!existsSync(file)) continue;
    push(kind, path.basename(spec.file, ".json"), readRecord(file));
  }
  return out;
}


/**
 * Which ids the game itself ships, per kind. A page says 覆盖原版 when the mod carries an id
 * that already exists there, and 新增 when it does not.
 */
function vanillaIds(dir) {
  const root = String(dir).replace(/^~/, os.homedir());
  const out = new Map();
  const add = (kind, id) => {
    if (!out.has(kind)) out.set(kind, new Set());
    out.get(kind).add(String(id));
  };
  for (const [kind, spec] of Object.entries(LAYOUT.table)) {
    const file = path.join(root, spec.file.replace(/^config\//, ""));
    if (!existsSync(file)) continue;
    for (const id of Object.keys(readRecord(file) || {})) if (!id.startsWith("_")) add(kind, id);
  }
  for (const [kind, spec] of Object.entries(LAYOUT.dir)) {
    const folder = path.join(root, spec.dir.replace(/^config\//, ""));
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) if (name.endsWith(".json")) add(kind, name.replace(/\.json$/, ""));
  }
  return out;
}

function parseArgs(argv) {
  const out = { modDir: null, focus: null, out: null, vanilla: null, collect: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mod") out.modDir = argv[++i];
    else if (a === "--focus") out.focus = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--vanilla") out.vanilla = argv[++i];
    else if (a === "--collect") out.collect = true;
    else if (a === "--apply") out.apply = true;
  }
  return out;
}

/** Run one of the page tools and hand back its result and its own words. */
function runTool(tool, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, tool), ...args], { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

/** A tool that refused to write its page has its own FAIL and NEXT lines; repeat them once. */
function toolFailed(tool, file, output) {
  process.stdout.write(`FAIL  ${tool} could not write ${path.basename(file)}\n`);
  for (const line of output.split("\n")) if (line.trim()) process.stdout.write(`      ${line.trim()}\n`);
  process.stdout.write(`NEXT  fix what ${tool} reported above, then run this again\n`);
}

/** The mod's card table by id. A `_`-prefixed key is a comment the game ignores. */
function cardTable(modDir) {
  const file = path.join(modDir, CARD_TABLE);
  if (!existsSync(file)) return null;
  const parsed = parseJsonc(readFileSync(file, "utf8")).value;
  const records = new Map();
  if (parsed && typeof parsed === "object") {
    for (const [id, record] of Object.entries(parsed)) if (!id.startsWith("_")) records.set(String(id), record);
  }
  return { file, records };
}

/**
 * A path as the agent should repeat it to the player: workspace-relative when the file is inside
 * the workspace, and `~`-shortened only when it is not. The app resolves a leading `~/` as a
 * relative path, so an absolute link in a chat message does not open.
 */
function displayPath(target) {
  const relative = path.relative(process.cwd(), target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return shorten(target);
}

/** Card pages in the preview directory. */
function cardPages(outDir) {
  if (!existsSync(outDir)) return [];
  const suffix = ".card.html";
  return readdirSync(outDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => ({ name, id: name.slice(0, -suffix.length), file: path.join(outDir, name) }));
}

/** A card id doubles as a file name; anything that cannot be one is refused, not written. */
const CARD_ID_FILE = /^[A-Za-z0-9_-]+$/;

/** A value as the diff prints it: the literal a reader would type. */
const show = (value) => (value === undefined ? "(none)" : JSON.stringify(value));

/**
 * `--collect` and `--apply`: what the card pages carry that the card table does not.
 * Collect only prints; apply replaces the value spans named by the diff and nothing else.
 */
function runCardValues({ modDir, outDir, apply }) {
  const pages = cardPages(outDir);
  if (!pages.length) {
    process.stdout.write(`PASS  no card pages under ${displayPath(outDir)}\n`);
    process.stdout.write(`NEXT  run node tools/preview.mjs --mod ${displayPath(modDir)} to write them\n`);
    return 0;
  }
  const table = cardTable(modDir);
  if (!table) {
    process.stdout.write(`FAIL  ${displayPath(modDir)} has no ${CARD_TABLE}\n`);
    process.stdout.write("NEXT  a card page is built from the mod's card table; write that file first\n");
    return 1;
  }

  const pending = [];
  for (const page of pages) {
    const block = readPageValues(readFileSync(page.file, "utf8"));
    if (!block) {
      process.stdout.write(`WARN  ${page.name}: no readable value block; rebuild it with node tools/preview.mjs --mod\n`);
      continue;
    }
    const id = block.id || page.id;
    const record = table.records.get(id);
    if (!record) {
      process.stdout.write(`WARN  ${page.name}: ${CARD_TABLE} has no card ${id}\n`);
      continue;
    }
    const diff = pendingValues(record, block.values);
    if (!Object.keys(diff.fields).length && !diff.removedTags.length) continue;
    pending.push({ page, id, record, diff, missing: missingValues(record, block.values) });
  }

  if (!pending.length) {
    process.stdout.write(`PASS  no card page carries a value different from ${CARD_TABLE}\n`);
    return 0;
  }

  const lines = [];
  for (const item of pending) {
    for (const [key, value] of Object.entries(item.diff.fields)) {
      if (key === "tag") {
        for (const [name, level] of Object.entries(value)) {
          lines.push(`${item.id}  tag.${name}  ${show(item.record.tag?.[name])} -> ${show(level)}`);
        }
      } else {
        lines.push(`${item.id}  ${key}  ${show(item.record[key])} -> ${show(value)}`);
      }
    }
    for (const name of item.diff.removedTags) {
      lines.push(`${item.id}  tag.${name}  ${show(item.record.tag?.[name])} -> (removed)`);
    }
  }

  if (!apply) {
    process.stdout.write(`PASS  ${pending.length} card page(s) carry pending values in ${displayPath(outDir)}\n`);
    for (const line of lines) process.stdout.write(`      ${line}\n`);
    process.stdout.write(`NEXT  run node tools/preview.mjs --mod ${displayPath(modDir)} --apply to write them into ${CARD_TABLE}\n`);
    return 0;
  }

  const text = readFileSync(table.file, "utf8");
  let result;
  try {
    result = applyCardValues(
      text,
      pending.map((item) => ({ id: item.id, ...item.diff })),
    );
  } catch (e) {
    process.stdout.write(`FAIL  could not write ${displayPath(table.file)}: ${e.message || e}\n`);
    process.stdout.write("NEXT  fix the file so it parses, then run this again\n");
    return 1;
  }
  if (result.text !== text) writeFileSync(table.file, result.text);
  process.stdout.write(`PASS  wrote ${result.written} value(s) into ${displayPath(table.file)}\n`);
  for (const line of lines) process.stdout.write(`      ${line}\n`);
  // The game replaces a card entry as a whole when it merges by id, so a page that never carried
  // one of the record's keys is worth saying out loud. Apply is per key, so this is a warning.
  for (const item of pending) {
    for (const key of item.missing) {
      process.stdout.write(
        `WARN  ${item.id}  the page does not carry ${JSON.stringify(key)}; a whole-entry replace would drop it. ` +
          "--apply writes only changed keys, so the record keeps it\n",
      );
    }
  }
  process.stdout.write(`NEXT  run node tools/preview.mjs --mod ${displayPath(modDir)} to rebuild the pages without the pending mark\n`);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.modDir) {
    process.stderr.write(
      "usage: node tools/preview.mjs --mod your_mods/<ModName> [--focus kind:id] [--out <dir>] | --collect | --apply\n",
    );
    return 2;
  }
  const modDir = path.resolve(String(args.modDir).replace(/^~/, os.homedir()));
  if (!existsSync(modDir)) {
    process.stdout.write(`FAIL  no such directory: ${displayPath(modDir)}\n`);
    process.stdout.write("NEXT  pass --mod your_mods/<ModName>\n");
    return 1;
  }
  const infoFile = path.join(modDir, "info.json");
  if (!existsSync(infoFile)) {
    process.stdout.write(`FAIL  ${displayPath(modDir)} has no info.json, so it is not a mod\n`);
    process.stdout.write("NEXT  a mod is your_mods/<ModName>/ with an info.json; see .pi/skills/mod-creator\n");
    return 1;
  }
  let modName = path.basename(modDir);
  try {
    modName = parseJsonc(readFileSync(infoFile, "utf8")).value.name || modName;
  } catch {
    // A description file that does not parse is lint's finding, not a reason to refuse a preview.
  }

  let records;
  try {
    records = modRecords(modDir);
  } catch (e) {
    process.stdout.write(`FAIL  ${e.message || e}\n`);
    process.stdout.write(`NEXT  run node tools/lint.mjs ${displayPath(modDir)} to see what is wrong\n`);
    return 1;
  }
  if (!records.length) {
    process.stdout.write(`PASS  no records under ${displayPath(modDir)}: nothing to preview\n`);
    process.stdout.write("NEXT  add a card, a rite or an event, then run this again\n");
    return 0;
  }

  const cards = records.filter((r) => r.kind === "card");
  const story = records.filter((r) => GRAPH_KINDS.has(r.kind));

  const outDir = path.resolve(String(args.out || path.join(modDir, ".preview")).replace(/^~/, os.homedir()));
  // Collect and apply only read the pages and the card table; neither needs the game's config.
  if (args.collect || args.apply) return runCardValues({ modDir, outDir, apply: args.apply });

  // Only the story graph reads the game's own config. A mod of cards needs nothing but its file:
  // the card page is built from the card table, so requiring an install here would refuse a
  // preview that can be built.
  const requirement = story.length ? vanillaRequirement(args.vanilla) : { dir: null };
  if (story.length && !requirement.dir) {
    process.stdout.write(`FAIL  ${requirement.message}\n`);
    process.stdout.write(`NEXT  ${requirement.next}\n`);
    return 1;
  }

  // Without --focus the page would open on an empty canvas. Point it at the first record the mod
  // carries in the story graph, so opening the page always lands on something to look at.
  const storyFirst = story[0];
  const focus = args.focus ? String(args.focus) : storyFirst ? `${storyFirst.kind}:${storyFirst.id}` : null;
  const picked = focus ? records.find((r) => `${r.kind}:${r.id}` === focus) : null;
  if (focus && !picked) {
    process.stdout.write(`FAIL  focus ${focus} is not a record this mod carries\n`);
    process.stdout.write("NEXT  run this without --focus, then pass the kind:id of a record this mod carries\n");
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  // Older versions wrote a list page; a rebuilt preview must not leave it behind as a stale file.
  const staleIndex = path.join(outDir, "index.html");
  if (existsSync(staleIndex)) rmSync(staleIndex, { force: true });
  const counts = new Map();
  for (const r of records) counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
  process.stdout.write(
    `PASS  ${displayPath(modDir)}  (records ${records.length}: ${[...counts.entries()].map(([k, n]) => `${k} ${n}`).join(", ")})\n`
  );

  const pages = { graph: null, files: [] };
  let recordCount = 0;
  const vanilla = vanillaIds(requirement.dir);
  const originOf = (kind, id) => (vanilla.get(kind) && vanilla.get(kind).has(String(id)) ? "override" : "new");
  const focusFlag = picked ? ["--focus", `${picked.kind}:${picked.id}`] : [];

  if (cards.length) {
    const table = cardTable(modDir);
    let written = 0;
    for (const card of cards) {
      if (!CARD_ID_FILE.test(String(card.id))) {
        process.stdout.write(`FAIL  card id ${JSON.stringify(card.id)} cannot be a file name\n`);
        process.stdout.write("NEXT  give the card a plain id of letters, digits, _ or -\n");
        return 1;
      }
      const record = table?.records.get(String(card.id));
      if (!record) continue;
      const file = path.join(outDir, `${card.id}.card.html`);
      const previous = existsSync(file) ? readPageValues(readFileSync(file, "utf8")) : null;
      try {
        writeFileSync(file, cardPageHtml({ id: card.id, record, modDir, previous, origin: originOf("card", record.id ?? card.id) }));
        pages.files.push(file);
        written += 1;
      } catch (e) {
        process.stdout.write(`FAIL  could not write ${path.basename(file)}: ${e.message || e}\n`);
        process.stdout.write("NEXT  add the missing label to schema/view/field-labels.json, then run this again\n");
        return 1;
      }
    }
    process.stdout.write(`PASS  ${written} card page(s) in ${displayPath(outDir)}\n`);
  }

  // Rites and events get a page of their own too: the story graph shows where they sit, this
  // shows what they contain field by field.
  const recordKinds = new Set(["rite", "event"]);
  for (const r of records) {
    if (!recordKinds.has(r.kind)) continue;
    if (!CARD_ID_FILE.test(String(r.id))) continue;
    const file = path.join(outDir, `${r.kind}-${r.id}.record.html`);
    try {
      writeFileSync(file, recordPageHtml({ kind: r.kind, id: r.id, record: r.record, modDir, origin: originOf(r.kind, r.id) }));
      pages.files.push(file);
      recordCount += 1;
    } catch (e) {
      process.stdout.write(`FAIL  could not write ${path.basename(file)}: ${e.message || e}\n`);
      process.stdout.write("NEXT  add the missing label to schema/view/field-labels.json, then run this again\n");
      return 1;
    }
  }
  if (recordCount) process.stdout.write(`PASS  ${recordCount} record page(s) in ${displayPath(outDir)}\n`);

  if (story.length) {
    const file = path.join(outDir, "graph.html");
    const tool = runTool("graphpage.mjs", [
      "--out",
      file,
      "--mod",
      modDir,
      "--vanilla",
      requirement.dir,
      ...(picked && GRAPH_KINDS.has(picked.kind) ? focusFlag : []),
    ]);
    if (!tool.ok) {
      toolFailed("graphpage.mjs", file, tool.output);
      return 1;
    }
    pages.graph = path.basename(file);
    pages.files.push(file);
    process.stdout.write(`PASS  wrote ${displayPath(file)}\n`);
  }

  const written = pages.files || [];
  if (written.length) {
    process.stdout.write(`PASS  ${written.length} page(s):\n`);
    for (const f of written) process.stdout.write(`  ${displayPath(f)}\n`);
    process.stdout.write("NEXT  give these paths to the player, one per line, and say which record each one shows\n");
  } else {
    process.stdout.write("PASS  nothing to write: this mod carries no record that has a page\n");
  }
  if (cards.length) {
    process.stdout.write(
      `NEXT  to change a card, open its card page in the app: it opens with ${CARD_PAGE_EDITOR.id}\n`,
    );
    process.stdout.write(`NEXT  ${CARD_TABLE} stays untouched until you run this with --apply\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("preview.mjs")) process.exit(main());
