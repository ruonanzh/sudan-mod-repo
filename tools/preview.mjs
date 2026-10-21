#!/usr/bin/env node
/**
 * preview.mjs — one command that turns what a mod carries into pages a player can open.
 *
 *   node tools/preview.mjs --mod your_mods/<ModName> [--focus kind:id] [--out <dir>]
 *
 * A mod is data, and a page is how a player checks that data before installing it. Two views,
 * because a record reads two ways:
 *
 *   cards.html   the card editor's page, for a card's numbers, rarity and tags
 *   graph.html   the story graph, for a rite's or an event's place in the story around it
 *   index.html   every record the mod carries, one row each, linked to the page that shows it
 *
 * Which records exist is read from schema/layout.json — the table model.mjs reads and a test
 * keeps in step with lint — so a kind added there shows up here without a second mapping.
 * Everything lands in <mod>/.preview/ unless --out says otherwise, and a mod with no records
 * writes nothing: an empty page is worse than an honest line.
 *
 * The two pages are written by the tools that own them, not re-rendered here: editor.mjs for
 * cards, graphpage.mjs for the story graph. `--focus` is handed to whichever page holds that
 * record, so the preview opens on the thing it was run for.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lint.mjs";
import { esc, pageHtml } from "./html.mjs";
import { shorten, vanillaRequirement } from "./paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYOUT = JSON.parse(readFileSync(new URL("../schema/layout.json", import.meta.url), "utf8"));

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
    throw new Error(`${shorten(file)}: ${e.message || e}`);
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
  if (record.kind === "card") return pages.card;
  if (GRAPH_KINDS.has(record.kind)) return pages.graph;
  return null;
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
  const rows = records
    .map((r) => {
      const page = pageOf(r, pages);
      return (
        `<tr data-record="${esc(r.kind)}:${esc(r.id)}">` +
        `<td>${esc(KIND_LABEL[r.kind] || r.kind)}</td>` +
        `<td><code>${esc(r.id)}</code></td>` +
        `<td class="txt">${esc(r.name)}</td>` +
        `<td>${page ? `<a href="${esc(page)}">打开</a>` : '<span class="note">这类记录没有预览页</span>'}</td>` +
        "</tr>"
      );
    })
    .join("\n");
  const body = `
<div class="panel">
<p class="note" style="margin-top:0">这些页只说明改动长什么样。能不能加载，要把它装进游戏、在游戏内的面板里启用之后才知道。</p>
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
  const out = { modDir: null, focus: null, out: null, vanilla: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mod") out.modDir = argv[++i];
    else if (a === "--focus") out.focus = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--vanilla") out.vanilla = argv[++i];
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.modDir) {
    process.stderr.write("usage: node tools/preview.mjs --mod your_mods/<ModName> [--focus kind:id] [--out <dir>]\n");
    return 2;
  }
  const modDir = path.resolve(String(args.modDir).replace(/^~/, os.homedir()));
  if (!existsSync(modDir)) {
    process.stdout.write(`FAIL  no such directory: ${shorten(modDir)}\n`);
    process.stdout.write("NEXT  pass --mod your_mods/<ModName>\n");
    return 1;
  }
  const infoFile = path.join(modDir, "info.json");
  if (!existsSync(infoFile)) {
    process.stdout.write(`FAIL  ${shorten(modDir)} has no info.json, so it is not a mod\n`);
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
    process.stdout.write(`NEXT  run node tools/lint.mjs ${shorten(modDir)} to see what is wrong\n`);
    return 1;
  }
  if (!records.length) {
    process.stdout.write(`PASS  no records under ${shorten(modDir)}: nothing to preview\n`);
    process.stdout.write("NEXT  add a card, a rite or an event, then run this again\n");
    return 0;
  }

  const requirement = vanillaRequirement(args.vanilla);
  if (!requirement.dir) {
    process.stdout.write(`FAIL  ${requirement.message}\n`);
    process.stdout.write(`NEXT  ${requirement.next}\n`);
    return 1;
  }

  // Without --focus the page would open on an empty canvas. Point it at the first record the mod
  // carries in the story graph, so opening the page always lands on something to look at.
  const storyFirst = records.find((r) => r.kind !== "card");
  const focus = args.focus ? String(args.focus) : storyFirst ? `${storyFirst.kind}:${storyFirst.id}` : null;
  const picked = focus ? records.find((r) => `${r.kind}:${r.id}` === focus) : null;
  if (focus && !picked) {
    process.stdout.write(`FAIL  focus ${focus} is not a record this mod carries\n`);
    process.stdout.write("NEXT  run this without --focus, open index.html, then pass the kind:id of a row\n");
    return 1;
  }

  const outDir = path.resolve(String(args.out || path.join(modDir, ".preview")).replace(/^~/, os.homedir()));
  mkdirSync(outDir, { recursive: true });
  const counts = new Map();
  for (const r of records) counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
  process.stdout.write(
    `PASS  ${shorten(modDir)}  (records ${records.length}: ${[...counts.entries()].map(([k, n]) => `${k} ${n}`).join(", ")})\n`
  );

  const pages = { card: null, graph: null };
  const cards = records.filter((r) => r.kind === "card");
  const story = records.filter((r) => GRAPH_KINDS.has(r.kind));
  const focusFlag = picked ? ["--focus", `${picked.kind}:${picked.id}`] : [];

  if (cards.length) {
    const file = path.join(outDir, "cards.html");
    const tool = runTool("editor.mjs", [
      "--static",
      file,
      "--mod",
      modDir,
      "--vanilla",
      requirement.dir,
      ...(picked && picked.kind === "card" ? focusFlag : []),
    ]);
    if (!tool.ok) {
      toolFailed("editor.mjs", file, tool.output);
      return 1;
    }
    pages.card = path.basename(file);
    process.stdout.write(`PASS  wrote ${shorten(file)}\n`);
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
    process.stdout.write(`PASS  wrote ${shorten(file)}\n`);
  }

  const index = path.join(outDir, "index.html");
  writeFileSync(index, indexHtml({ modName, records, pages }));
  process.stdout.write(`PASS  wrote ${shorten(index)}\n`);
  process.stdout.write(`NEXT  open ${shorten(index)} in a browser\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("preview.mjs")) process.exit(main());
