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
 *   index.html          every record the mod carries, one row each, linked to its page
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lint.mjs";
import { esc, pageHtml } from "../editors/lib/shell.mjs";
import { shorten, vanillaRequirement } from "./paths.mjs";
import { applyCardValues, cardPageHtml, missingValues, pendingValues, readPageValues } from "../editors/card/page.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYOUT = JSON.parse(readFileSync(new URL("../schema/layout.json", import.meta.url), "utf8"));
/** The app editor tool that opens one `*.card.html`; the index names it too. */
const CARD_PAGE_EDITOR = JSON.parse(
  readFileSync(new URL("../editors/card/.editor.tool.json", import.meta.url), "utf8")
);
const CARD_TABLE = LAYOUT.table.card.file;

/** Kinds the story graph draws. The rest of a mod is listed in the index and has no page. */
const GRAPH_KINDS = new Set(["event", "rite", "loot", "quest", "over", "afterStory", "riteTemplate"]);

const KIND_LABEL = {
  card: "卡",
  upgrade: "升级",
  tag: "标签",
  quest: "任务",
  over: "结局",
  event: "事件",
  rite: "仪式",
  loot: "掉落表",
  init: "初始配置",
  riteTemplate: "棋盘布局",
  afterStory: "后日谈",
  dtRoot: "对话树",
  wizard: "向导",
  game: "游戏设置",
  riteMapping: "棋盘映射",
  sfxTop: "音效",
};

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
  const push = (kind, id, rec) => out.push({ kind, id: String(id), name: nameOf(rec) });
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

/** The page a record is shown on, or null when no view shows this kind. */
function pageOf(record, pages) {
  if (record.kind === "card") return `${record.id}.card.html`;
  return GRAPH_KINDS.has(record.kind) ? pages.graph : null;
}

/**
 * index.html: the player's list. Every record the mod carries is a row, so nothing the mod
 * changes is hidden; a kind with no view says so instead of linking nowhere.
 */
function indexHtml({ modName, records, pages }) {
  const counts = new Map();
  for (const r of records) counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
  const summary = [...counts.entries()]
    .map(([kind, n]) => `<span class="pill on">${esc(KIND_LABEL[kind] || kind)} ${n}</span>`)
    .join(" ");
  const hasCards = records.some((r) => r.kind === "card");
  const rows = records
    .map((r) => {
      const page = pageOf(r, pages);
      const action = page
        ? `<a href="${esc(page)}">打开</a>`
        : '<span class="note">这类记录没有预览页</span>';
      return (
        `<tr data-record="${esc(r.kind)}:${esc(r.id)}">` +
        `<td>${esc(KIND_LABEL[r.kind] || r.kind)}</td>` +
        `<td><code>${esc(r.id)}</code></td>` +
        `<td class="txt">${esc(r.name)}</td>` +
        `<td>${action}</td>` +
        "</tr>"
      );
    })
    .join("\n");
  const cardNote = hasCards
    ? `<p class="note">卡页可以在 app 里用「${esc(CARD_PAGE_EDITOR.name)}」打开：保存只写入那一页自己的值块。写回 <code>${esc(CARD_TABLE)}</code> 用 <code>node tools/preview.mjs --apply --mod your_mods/&lt;ModName&gt;</code>，只写改过的键。</p>`
    : "";
  const body = `
<div class="panel">
<p class="note" style="margin-top:0">这些页只说明改动长什么样。能不能加载，要把它装进游戏、在游戏内的面板里启用之后才知道。</p>
${cardNote}
<p>${summary}</p>
<table>
<tr><th>类型</th><th>id</th><th>名字</th><th></th></tr>
${rows}
</table>
</div>
${pages.graph ? '<p class="note">剧情图是两个文件：graph.html 画图，graph.detail.js 是它要读的正文。两个放在一起，页面才完整。</p>' : ""}`;
  return pageHtml({
    title: `${modName} · 预览`,
    sub: `${records.length} 条记录`,
    body,
    extraCss: `.panel a { color: var(--gold); }`,
  });
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
    process.stdout.write("NEXT  run this without --focus, open index.html, then pass the kind:id of a row\n");
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  const counts = new Map();
  for (const r of records) counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
  process.stdout.write(
    `PASS  ${displayPath(modDir)}  (records ${records.length}: ${[...counts.entries()].map(([k, n]) => `${k} ${n}`).join(", ")})\n`
  );

  const pages = { graph: null };
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
        writeFileSync(file, cardPageHtml({ id: card.id, record, modDir, previous }));
        written += 1;
      } catch (e) {
        process.stdout.write(`FAIL  could not write ${path.basename(file)}: ${e.message || e}\n`);
        process.stdout.write("NEXT  add the missing label to schema/view/field-labels.json, then run this again\n");
        return 1;
      }
    }
    process.stdout.write(`PASS  ${written} card page(s) in ${displayPath(outDir)}\n`);
  }

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
    process.stdout.write(`PASS  wrote ${displayPath(file)}\n`);
  }

  const index = path.join(outDir, "index.html");
  writeFileSync(index, indexHtml({ modName, records, pages }));
  process.stdout.write(`PASS  wrote ${displayPath(index)}\n`);
  process.stdout.write(`NEXT  open ${displayPath(index)} in a browser\n`);
  if (cards.length) {
    process.stdout.write(
      `NEXT  to change a card, open its card page in the app: it opens with ${CARD_PAGE_EDITOR.id}\n`,
    );
    process.stdout.write(`NEXT  ${CARD_TABLE} stays untouched until you run this with --apply\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("preview.mjs")) process.exit(main());
