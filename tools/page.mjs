#!/usr/bin/env node
/**
 * page.mjs — turn a mod record into one self-contained page the player can read and
 * mark up.
 *
 *   node tools/page.mjs card --mod your_mods/x --id 2100900
 *   node tools/page.mjs rite --mod your_mods/x --id 5010901
 *   node tools/page.mjs card --mod your_mods/x --id 2100900 --spec - < proposal.json
 *   node tools/page.mjs card --mod your_mods/x --id 2100900 --out /tmp/x.html
 *
 * `--spec <file|->` renders a proposal that is not in the mod yet: the JSON comes from that file,
 * or from stdin when the value is `-`. Nothing is written to the mod, so the player can approve a
 * shape before it becomes a record.
 *
 * The page is read-only on purpose. There is no page editor wired for this game, so a form
 * control would collect a value nobody reads: the player answers in chat and the agent
 * applies it with tools/card.mjs or tools/story.mjs. Values are printed as text.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openMod, ModelError } from "./model.mjs";
import { toPlain } from "./jsonc.mjs";
import { decodePng, encodePng, cropCover, overlay, solid, nineSlice, tint } from "./png.mjs";
import { composePrompt, composeSubject, composeBoilerplate } from "./art.mjs";
import { esc, CSS, pageHtml as shellPage } from "./html.mjs";

const TAG_ROLES = JSON.parse(readFileSync(new URL("../schema/tag-roles.json", import.meta.url), "utf8"));
const CARD_ART = JSON.parse(readFileSync(new URL("../schema/card-art.json", import.meta.url), "utf8"));
const PLATE = ["stone", "copper", "silver", "gold"];
const CARD_W = 472;
const CARD_H = 1028;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

/**
 * The card name is set in HYJieLongTaoHuaYuanW-2, which is the font behind the game's
 * CardTitle SDF materials. If it has been extracted we use it, otherwise the page falls
 * back to a serif. It is a commercial typeface: reference/fonts is git-ignored, and the
 * page only uses it locally.
 */
function fontFace() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const f = path.join(here, "..", "reference", "fonts", "HYJieLongTaoHuaYuanW-2.ttf");
  if (!existsSync(f)) return { css: "", family: "ui-serif, Georgia, 'Songti SC', serif" };
  return {
    css: `@font-face { font-family: "GameCardTitle"; src: url("file://${f}"); font-weight: 700; font-display: block; }`,
    // single quotes: this string lands inside a double-quoted style attribute
    family: `'GameCardTitle', ui-serif, Georgia, serif`,
  };
}

function pageHtml({ title, sub, body }) {
  const ff = fontFace();
  return shellPage({
    title,
    sub,
    font: ff.css ? ff : null,
    body,
  });
}

/**
 * Every slot name vanilla puts in a character's `equips`, measured across the 131 char
 * cards that declare any. A slot is a repeatable entry, so the page edits counts: three
 * 饰品 means three trinket slots. A fifth name would need a matching tag for items.
 */
const SLOTS = ["武器", "服装", "饰品", "驯兽"];

// ---------------------------------------------------------------- labels

let LABELS = JSON.parse(readFileSync(new URL("../schema/field-labels.json", import.meta.url), "utf8"));
let FIELDS = JSON.parse(readFileSync(new URL("../schema/fields.json", import.meta.url), "utf8"));

/** Point the page at another label table (used by the tests). */
export function useLabels(file) {
  LABELS = JSON.parse(readFileSync(file, "utf8"));
}

export function useFields(file) {
  FIELDS = JSON.parse(readFileSync(file, "utf8"));
}

/** The Chinese label and the one-line note for a key, or null when nobody described it. */
function labelOf(kind, key) {
  return LABELS[kind]?.[key] || LABELS._shared?.[key] || null;
}

/** Which child kind renders a nested value. `slotMap` means the value is an object of objects. */
const NESTED = {
  card: { post_rite: "settlement" },
  rite: {
    cards_slot: "slotMap",
    open_conditions: "riteOpenCondition",
    from_pins: "riteFromPin",
    random_text_up: "riteRandomTextUp",
    tag_tips_up: "riteTagTipsUp",
    settlement_prior: "settlement",
    settlement: "settlement",
    settlement_extre: "settlement",
    waiting_round_end_action: "settlement",
  },
  event: { settlement: "settlement" },
  loot: { item: "lootItem" },
  quest: { target: "questTargetItem" },
  over: { text_extra: "settlement" },
  afterStory: { prior: "afterStoryExtra", extra: "afterStoryExtra" },
  init: { difficulty: "initDifficulty" },
  upgrade: {},
  tag: {},
};

/** Render any value compactly: strings plain, numbers bare, objects as one code line. */
function fmt(value) {
  if (value === undefined || value === null) return "（无）";
  if (typeof value === "string") return value ? esc(value) : "（空）";
  if (typeof value === "number" || typeof value === "boolean") return esc(String(value));
  if (Array.isArray(value)) {
    if (!value.length) return "（空）";
    return value.map((v) => fmt(v)).join("、");
  }
  // A whole nested object in one row would push everything else off the page; fold it.
  const text = esc(JSON.stringify(value));
  const count = Object.keys(value || {}).length;
  if (text.length <= 60) return `<code>${text}</code>`;
  return `<details><summary>${count} 项，点开看</summary><div><code>${text}</code></div></details>`;
}

/** One label/value row, with the note as a dim line under the value. */
function fieldRow(label, valueHtml, note) {
  const tip = note ? `<div class="note" style="margin:2px 0 0">${esc(note)}</div>` : "";
  return `<div class="row"><div class="lbl">${esc(label)}</div><div class="val">${valueHtml}${tip}</div></div>`;
}

/** How many rows a table shows before folding the rest behind a summary. */
const TABLE_FOLD = 25;

/** Columns to show for a child table: the live keys of that kind, in reader order. */
function columnsFor(kind, rows) {
  const order = FIELDS[kind]?.fields || [];
  const present = new Set();
  for (const row of rows) if (row && typeof row === "object") for (const k of Object.keys(row)) present.add(k);
  return order.filter((k) => present.has(k));
}

/** A table of nested records, with each column headed by that key's label. */
function tableFor(kind, value) {
  const head = (cols, extra) =>
    `<tr>${extra}${cols.map((c) => `<th>${esc(labelOf(kind, c)?.label || c)}</th>`).join("")}</tr>`;
  if (Array.isArray(value)) {
    if (!value.length) return '<div style="color:#8a7a60">这一项没写内容。</div>';
    if (value.every((v) => !v || typeof v !== "object")) return `<div>${value.map((v) => fmt(v)).join("、")}</div>`;
    const cols = columnsFor(kind, value);
    const rowHtml = (row) => `<tr>${cols.map((c) => `<td>${fmt(row?.[c])}</td>`).join("")}</tr>`;
    // A 180-row table buries everything after it; show a screenful and fold the rest.
    const shown = value.slice(0, TABLE_FOLD);
    const rest = value.slice(TABLE_FOLD);
    const head1 = `<table>${head(cols, "")}${shown.map(rowHtml).join("")}</table>`;
    if (!rest.length) return head1;
    return `${head1}<details style="margin-top:10px"><summary>还有 ${rest.length} 条，点开看</summary><table>${head(cols, "")}${rest.map(rowHtml).join("")}</table></details>`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return '<div style="color:#8a7a60">这一项没写内容。</div>';
    const cols = columnsFor(kind, entries.map(([, v]) => v));
    const rows = entries
      .map(([name, row]) => `<tr><td><code>${esc(name)}</code></td>${cols.map((c) => `<td>${fmt(row?.[c])}</td>`).join("")}</tr>`)
      .join("");
    return `<table>${head(cols, "<th>名称</th>")}${rows}</table>`;
  }
  return `<div>${fmt(value)}</div>`;
}

/** The three settlement arrays are one idea ("which branch wins"), so they share one heading. */
const SETTLEMENT_KEYS = ["settlement_prior", "settlement", "settlement_extre"];

function renderSections(kind, sections) {
  const out = [];
  let merged = null;
  for (const section of sections) {
    if (kind === "rite" && SETTLEMENT_KEYS.includes(section.key)) {
      merged ||= { title: "结算分支", items: [] };
      merged.items.push(section);
      continue;
    }
    if (merged) {
      out.push(mergedSection(merged));
      merged = null;
    }
    out.push(`<h2>${esc(section.title)}</h2><div class="panel">${section.html}</div>`);
  }
  if (merged) out.push(mergedSection(merged));
  return out.join("\n");
}

function mergedSection(group) {
  const note = `<div class="note" style="margin-top:0">该看哪一条：先结算与正常结算都是「第一条成立的生效」，后面的不看；附加结算则是「每条成立的都执行」。所以没有条件的兜底只能放最后。</div>`;
  const items = group.items
    .map((s) => `<h3 style="margin:18px 0 8px;color:#b9a887;font-size:14px;font-weight:normal">${esc(s.title)}</h3>${s.html}`)
    .join("\n");
  return `<h2>${esc(group.title)}</h2><div class="panel">${note}${items}</div>`;
}

/**
 * Every live key of the record as a label/value row, then one table per nested kind.
 * Returns the keys the game does not read and the live keys nobody has described, so the
 * caller can say so instead of dropping them silently.
 */
function recordBody(kind, record) {
  const nested = NESTED[kind] || {};
  const rows = [];
  const tables = [];
  const unknown = [];
  const legacy = [];
  const undescribed = [];

  for (const [key, value] of Object.entries(record)) {
    if (key in nested) continue;
    if (!(FIELDS[kind]?.fields || []).includes(key)) {
      // Vanilla writes some keys nothing reads; that is documented, not a mistake by the author.
      if ((FIELDS[kind]?.legacy || []).includes(key)) legacy.push(key);
      else unknown.push(key);
      continue;
    }
    const info = labelOf(kind, key);
    if (!info) undescribed.push(key);
    // `tag` is a map of Chinese tag name to number: it has its own table on the card page.
    const shown = value && typeof value === "object" && !Array.isArray(value) && kind === "card" && key === "tag"
      ? `${Object.entries(value).map(([k, v]) => `${k} ${v}`).join(" · ") || "（空）"}`
      : fmt(value);
    rows.push(fieldRow(info?.label || key, shown, info?.note));
  }

  for (const [key, childKind] of Object.entries(nested)) {
    const value = record[key];
    if (value === undefined) continue;
    const info = labelOf(kind, key);
    if (!info) undescribed.push(key);
    const title = info?.label || key;
    const note = info?.note ? `<div class="note">${esc(info.note)}</div>` : "";
    tables.push({ key, title, html: `${note}${tableFor(childKind, value)}` });
  }

  return { rows: rows.join("\n"), tables: renderSections(kind, tables), unknown, legacy, undescribed };
}

/** The keys nobody described must stop the page: a label-less row is an English field name. */
function assertDescribed(kind, undescribed) {
  if (!undescribed.length) return;
  throw new ModelError(
    `${kind}: no label for ${undescribed.map((k) => JSON.stringify(k)).join(", ")}. ` +
      `Add them to schema/field-labels.json; a page that prints the raw key teaches the player nothing.`,
  );
}

/** Keys vanilla itself writes and nothing reads: keep them, but say what they are. */
function legacySection(legacy) {
  if (!legacy.length) return "";
  const rows = legacy.map((k) => `<tr><td><code>${esc(k)}</code></td></tr>`).join("");
  return `<h2>原版会写、游戏不读</h2>
<div class="panel">
<div class="note">下面这些名字在原版文件里出现过，但游戏不会读它们。照着原版抄可以留着，自己新写时不用加。</div>
<table><tr><th>不生效的名字</th></tr>${rows}</table>
</div>`;
}

function unknownSection(unknown) {
  if (!unknown.length) return "";
  const rows = unknown.map((k) => `<tr><td><code>${esc(k)}</code></td></tr>`).join("");
  return `<h2>游戏不读这些键</h2>
<div class="panel">
<div class="note">下面这些名字游戏不认识，写进记录也不会起作用。要么删掉，要么先查清楚它本来该写在哪。</div>
<table><tr><th>这些名字游戏不认识</th></tr>${rows}</table>
</div>`;
}

/** A card page: the composed card face, the fields as labels, the tag tables, the art subject. */
function cardBody(record, modDir) {
  const subject = composeSubject(record);
  const body = recordBody("card", record);
  assertDescribed("card", body.undescribed);

  const tags = Object.entries(record.tag || {});
  const markerRows = tags
    .filter(([name]) => TAG_ROLES.marker[name])
    .map(([name]) => `<tr><td>${esc(name)}</td><td class="num">有</td></tr>`)
    .join("\n");
  const statRows = tags
    .filter(([name]) => !TAG_ROLES.marker[name])
    .map(([name, value]) => {
      const range = TAG_ROLES.stat[name];
      return `<tr>
  <td>${esc(name)}</td>
  <td class="num">${esc(value)}</td>
  <td style="color:#8a7a60;font-size:12px">${range ? `${range.min} … ${range.max}` : "新属性"}</td>
</tr>`;
    })
    .join("\n");

  return `
<h2>卡面</h2>
<div class="split">
  ${artInline(modDir, record.id, record.rare, record.name, record.type, fontFace().family) || '<div class="cardface">472 × 1028<br>卡面图放这里<br><span style="opacity:.6">只替换内部画面，边框由游戏画</span></div>'}
  <div class="grow">
    <div class="panel">
${body.rows}
    </div>
  </div>
</div>

<h2>标记 · 有或没有</h2>
<div class="panel">
<table>
<tr><th>标记</th><th>状态</th></tr>
${markerRows || '<tr><td colspan="2" style="color:#8a7a60">没有标记</td></tr>'}
</table>
<div class="note">这些标签在游戏里只可能是 1（有）或不存在。1294 张卡里没有一张用过别的值。</div>
</div>

<h2>数值 · 这张卡的属性</h2>
<div class="panel">
<table>
<tr><th>属性</th><th>数值</th><th>原版范围</th></tr>
${statRows || '<tr><td colspan="3" style="color:#8a7a60">没有属性</td></tr>'}
</table>
<div class="note">标签用的是<b>中文显示名</b>，不是 code。改名会让引用它的所有条件失效。</div>
</div>

${body.tables}

<h2>画面 · 这张图画成什么</h2>
<div class="panel">
<div class="note" style="margin-top:0">只写主体：画谁、画什么、什么神态。构图、风格、透明底由生成配方补，不用写在这里。</div>
<div class="val" style="white-space:pre-wrap">${esc(subject)}</div>
</div>
${legacySection(body.legacy)}
${unknownSection(body.unknown)}`;
}

/**
 * Build the card the way the game does, with the colours the player measured:
 *
 *   地面  reference/plates/card-<tier>.png   the shipped `card` paper, recoloured per tier
 *   卡面  image/cards/<id>.png              transparent, top fifth left empty
 *   名字  TextMeshPro in the game; drawn as text here
 *
 * card.png already carries the diamond divider and the ornate bottom band, so no extra
 * frame is stacked. The name goes on last, over the empty top fifth.
 */
function composeCard(modDir, id, rare, name, type) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const tier = ["stone", "copper", "silver", "gold"][(rare ?? 1) - 1] || "stone";
  const plateDir = path.join(here, "..", "reference", "plates");
  const fit = (f) => cropCover(decodePng(readFileSync(f)), CARD_W, CARD_H);

  const plateFile = path.join(plateDir, `card-${tier}.png`);
  const paper = path.join(plateDir, "card.png");
  // A clone has no reference art: it is DoubleCross's and never enters git. Draw a plain
  // tier-coloured plate instead of failing, and say so on the page.
  let missingPlate = false;
  let img;
  if (existsSync(plateFile)) img = fit(plateFile);
  else if (existsSync(paper)) img = tint(fit(paper), CARD_ART.plate?.tierTint?.[tier] ?? "#ffffff");
  else {
    missingPlate = true;
    img = tint(cropCover(blankPlate(), CARD_W, CARD_H), CARD_ART.plate?.tierTint?.[tier] ?? "#ffffff");
  }

  const artFile = path.join(modDir, "image", "cards", `${id}.png`);
  if (existsSync(artFile)) img = overlay(img, fit(artFile));
  return { img, tier, hasArt: existsSync(artFile), missingPlate };
}

/** Flat paper-coloured rectangle, used when the extracted plate is absent. */
function blankPlate() {
  const rgba = Buffer.alloc(CARD_W * CARD_H * 4, 0xf2);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width: CARD_W, height: CARD_H, rgba };
}

/**
 * The reference set is not in git, so a fresh clone has none. Build it on the spot the
 * first time the page is generated, and show progress: the only work here is reading the
 * player's own game, which takes a few seconds.
 */
function ensureReference(quietIfPresent = true) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const need = ["card.png", "card-stone.png", "card-copper.png", "card-silver.png", "card-gold.png"].map((f) =>
    path.join(here, "..", "reference", "plates", f)
  );
  if (need.every((f) => existsSync(f))) return true;

  process.stderr.write("reference art is missing; building it from the installed game\n");
  const setup = path.join(here, "setup.mjs");
  const bar = (step) => {
    if (!process.stderr.isTTY) return;
    const filled = Math.round((step / 5) * 20);
    process.stderr.write(`\r[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${Math.round((step / 5) * 100)}%  `);
  };
  bar(0);
  const r = spawnSync(process.execPath, [setup], {
    cwd: path.join(here, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = (r.stdout || "").split("\n");
  for (const line of lines) {
    const m = line.match(/^\[(\d)\/(\d)\]\s*(.*)$/);
    if (m) bar(Number(m[1]));
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  if (r.status !== 0) {
    process.stderr.write(
      "could not build the reference art; the page will use a plain placeholder.\n" +
        (lines.slice(-3).join("\n") || "") + "\n"
    );
    return false;
  }
  for (const line of lines) if (line.startsWith("[")) process.stderr.write(`  ${line}\n`);
  return true;
}

const dataUri = (img) => encodePng(img).toString("base64");

/** Halve the size before embedding: the page is displayed at 236px wide anyway. */
const half = (img) => cropCover(img, Math.round(img.width / 2), Math.round(img.height / 2));

function plateSources(modDir, id, type) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const plateDir = path.join(here, "..", "reference", "plates");
  const sources = {};
  for (const [i, tier] of ["stone", "copper", "silver", "gold"].entries()) {
    const f = path.join(plateDir, `card-${tier}.png`);
    if (existsSync(f)) sources[i + 1] = `data:image/png;base64,${dataUri(half(cropCover(decodePng(readFileSync(f)), CARD_W, CARD_H)))}`;
  }
  const artFile = path.join(modDir, "image", "cards", `${id}.png`);
  const art = existsSync(artFile)
    ? `data:image/png;base64,${dataUri(half(cropCover(decodePng(readFileSync(artFile)), CARD_W, CARD_H)))}`
    : null;
  return { sources, art };
}

/**
 * The card is drawn live in a canvas so the rarity and the name respond immediately.
 * A static composite sits under it for the case where scripts do not run, which is what
 * happens inside the game's panel.
 */
function artInline(modDir, id, rare, name, type, fontFamily) {
  const nameFamily = fontFamily || "ui-serif, Georgia, serif";
  const { img, tier, missingPlate } = composeCard(modDir, id, rare, name, type);
  const plateNote = missingPlate
    ? `<div class="note" style="margin-top:8px">用的是<b>占位底图</b>：原版纸纹没解出来。先跑 <code>node tools/setup.mjs</code>。</div>`
    : "";
  const { sources, art } = plateSources(modDir, id, type);
  const payload = JSON.stringify({ plates: sources, art, name, rare });
  return `<div style="position:relative;width:236px">
  <img id="cardStatic" src="data:image/png;base64,${dataUri(half(img))}" style="width:236px;display:block;border:1px solid #57452c" alt="${esc(tier)} card">
  <canvas id="cardCanvas" width="236" height="514" style="display:none;border:1px solid #57452c"></canvas>
  <div id="cardName" style="position:absolute;left:5%;right:5%;top:3.5%;text-align:center;white-space:nowrap;overflow:hidden;font:700 ${nameFont(name)}px/1.05 ${nameFamily};color:#20180f;letter-spacing:0;text-shadow:0 1px 0 rgba(255,255,255,.3)">${esc(name)}</div>
</div>${plateNote}
<script type="application/json" id="cardPayload">${payload}</script>
<script>
(function () {
  var payload = JSON.parse(document.getElementById("cardPayload").textContent);
  var canvas = document.getElementById("cardCanvas");
  var staticImg = document.getElementById("cardStatic");
  if (!canvas.getContext) return;                       // no canvas: keep the static card
  var ctx = canvas.getContext("2d");
  var plate = new Image(), art = new Image();
  var wantPlate = payload.rare || 1;
  var wantArt = Boolean(payload.art);
  var name = payload.name || "";
  var shown = false;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (plate.complete && plate.naturalWidth) ctx.drawImage(plate, 0, 0, canvas.width, canvas.height);
    if (wantArt && art.complete && art.naturalWidth) ctx.drawImage(art, 0, 0, canvas.width, canvas.height);
  }
  function reveal() {
    if (shown) return;
    shown = true;
    staticImg.style.display = "none";
    canvas.style.display = "block";
  }
  // Every load redraws. The first load also swaps the static card for the canvas.
  plate.onload = function () { reveal(); draw(); };
  art.onload = function () { reveal(); draw(); };

  plate.src = payload.plates[wantPlate];
  if (wantArt) art.src = payload.art;

})();
</script>`;
}

/**
 * The game sets the name large: in a real card, two characters fill about half the width.
 * A longer name shrinks so it stays on one line instead of wrapping onto the art.
 */
function nameFont(name) {
  const n = Math.max(1, [...String(name)].length);
  return n <= 2 ? 56 : Math.min(46, Math.floor(200 / n));
}

/** A rite page: the fields as labels, the slot table, then the settlement branches. */
function riteBody(record) {
  const body = recordBody("rite", record);
  assertDescribed("rite", body.undescribed);
  return `
<h2>仪式</h2>
<div class="panel">
${body.rows}
</div>
<div class="note">地点的写法必须是「地区名:[最小,最大]」。</div>

${body.tables}
${legacySection(body.legacy)}
${unknownSection(body.unknown)}`;
}

/**
 * An event page. An event is not a rite: it has no slots, and its settlement is a sequence,
 * not a choice — every branch runs, in order, and no branch condition is consulted.
 */
function eventBody(record) {
  const body = recordBody("event", record);
  assertDescribed("event", body.undescribed);
  return `
<h2>事件</h2>
<div class="panel">
${body.rows}
</div>
<div class="note">事件的结算分支是<b>顺序全部执行</b>，不是首条命中。分支选择发生在 <code>action</code> 里（option / case:opN / success / failed）。</div>

${body.tables}
${legacySection(body.legacy)}
${unknownSection(body.unknown)}`;
}

/** The kinds this page knows how to lay out, in the order the CLI help lists them. */
const PAGE_KINDS = ["card", "rite", "event", "loot", "quest", "over", "afterStory", "upgrade", "tag", "init"];

/** How a page names its own kind. A player never needs the English kind name. */
const KIND_LABEL = {
  card: "卡",
  rite: "仪式",
  event: "事件",
  loot: "战利品表",
  quest: "任务",
  over: "结局",
  afterStory: "后日谈",
  upgrade: "命运商店条目",
  tag: "标签",
  init: "开局",
};

/** Every other supported kind is a list of labelled fields plus whatever nests inside it. */
function genericBody(kind, record) {
  const body = recordBody(kind, record);
  assertDescribed(kind, body.undescribed);
  return `
<h2>${esc(KIND_LABEL[kind] || kind)}</h2>
<div class="panel">
${body.rows}
</div>

${body.tables}
${legacySection(body.legacy)}
${unknownSection(body.unknown)}`;
}

function bodyFor(kind, record, modDir) {
  if (kind === "card") return cardBody(record, modDir);
  if (kind === "rite") return riteBody(record);
  if (kind === "event") return eventBody(record);
  return genericBody(kind, record);
}


function main() {
  const argv = process.argv.slice(2);
  const kind = argv[0];
  const args = parseArgs(argv.slice(1));
  if (args.labels) useLabels(args.labels);
  if (!PAGE_KINDS.includes(kind) || !args.mod || !args.id) {
    process.stderr.write(
      `usage: node tools/page.mjs <${PAGE_KINDS.join("|")}> --mod <dir> --id <id> [--spec <file|->] [--out <file>] [--labels <file>]\n`,
    );
    return 2;
  }
  // Opening the editor is the moment the art is first needed, so that is when it is built.
  ensureReference();

  let mod;
  let record;
  let proposal = false;
  try {
    mod = openMod(args.mod);
    if (args.spec) {
      // A proposal: the JSON is given here, the mod is only used for the palette and the art.
      const text = args.spec === "-" ? readFileSync(0, "utf8") : readFileSync(args.spec, "utf8");
      try {
        record = JSON.parse(text);
      } catch (e) {
        process.stdout.write(`FAIL  --spec is not valid JSON: ${e.message}\n`);
        return 1;
      }
      proposal = true;
    } else {
      const got = mod.get(kind, args.id);
      if (!got) {
        process.stdout.write(`FAIL  no ${kind} ${args.id} in this mod (to preview one that is not written yet, pass --spec)\n`);
        return 1;
      }
      record = toPlain(got.doc, got.node);
    }
  } catch (e) {
    if (e instanceof ModelError) {
      process.stdout.write(`FAIL  ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const idForTitle = record.id ?? args.id;
  const title =
    kind === "card" || kind === "rite"
      ? record.name || `${kind} ${idForTitle}`
      : record.name || record.title || `${kind} ${idForTitle}`;
  const mark = proposal ? "提案 · 尚未写入 mod · " : "";
  const sub =
    kind === "card"
      ? `${mark}卡牌 · id ${record.id} · ${record.type} · 稀有度 ${record.rare}`
      : kind === "rite"
        ? `仪式 · id ${record.id} · ${Object.keys(record.cards_slot || {}).length} 个槽 · ${(record.settlement || []).length} 条结果`
        : `事件 · id ${record.id} · ${Object.keys(record.on || {}).length} 个触发 · ${(record.settlement || []).length} 条分支`;
  let body;
  try {
    body = bodyFor(kind, record, mod.dir);
  } catch (e) {
    if (e instanceof ModelError) {
      process.stdout.write(`FAIL  ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const html = pageHtml({ title, sub, body });
  const out = args.out || path.join(mod.dir, ".preview", `${kind}-${args.id}.modpage.html`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  process.stdout.write(`PASS  wrote ${out}\n`);
  process.stdout.write(
    proposal
      ? `NEXT  show it to the player; nothing was written. Write the record only after they agree\n`
      : `NEXT  show it to the player, then change the record from what they answer in chat\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("page.mjs")) process.exit(main());
