/**
 * page.mjs — the per-card page `tools/preview.mjs` writes, and the values it carries.
 *
 * A card is one node in a table, so the page for it is the card page `editors/page/page.mjs` already
 * renders (card face, labelled rows, tag tables, the art subject), turned into controls. Every
 * row prints the raw key in code style next to its Chinese label, so a reader who edits the
 * record still sees which key they are touching.
 *
 * The values live in a JSON block at the end of the page's own `<body>`. That block is what the
 * app save writes and what `preview --collect` / `preview --apply` read: a save never touches
 * `config/cards.json`, and an apply replaces only the value spans that changed, so comments,
 * key order and every field this page does not show survive (`tools/jsonc.mjs`).
 *
 * `bridge.js` beside this file is inlined into every page and is the same script the tool's
 * wrapper loads. It speaks the app protocol (`editor:readFile` / `editor:save`), and when the
 * page is opened straight from disk the visible line says values can only be saved in the app.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { esc, pageHtml } from "../lib/shell.mjs";
import { requireLabel } from "../lib/labels.mjs";
import { composeSubject } from "../../tools/art.mjs";
import { artInline, fontFace, fmt, legacySection, tableFor, unknownSection } from "../page/page.mjs";
import { findEntries, literal, parseDoc, toPlain } from "../../tools/jsonc.mjs";

const FIELDS = JSON.parse(readFileSync(new URL("../../schema/fields.json", import.meta.url), "utf8"));
const TAG_ROLES = JSON.parse(readFileSync(new URL("../../schema/view/tag-roles.json", import.meta.url), "utf8"));

/** Every name `tag.json` defines, whichever table carries it. A tag outside this set is to build. */
const KNOWN_TAG_NAMES = new Set([
  ...Object.keys(TAG_ROLES.marker),
  ...Object.keys(TAG_ROLES.stat),
  ...(TAG_ROLES.allTagNames?.names || []).map((tag) => tag.name),
]);

/** What the page says about a name `tag.json` does not carry yet. `bridge.js` says the same. */
const UNKNOWN_TAG_NOTE = "这个标签还没有。agent 会为你在 `tag.json` 里新建一条。";
/** The range cell of that row: `tag.json` carries the range, so the cell waits for the tag. */
const UNKNOWN_TAG_RANGE = "待建标签后确定";

const BRIDGE_SOURCE = readFileSync(new URL("./bridge.js", import.meta.url), "utf8").trimEnd();

/** The id of the `<script type="application/json">` block that carries the page's values. */
export const CARD_VALUES_ID = "card-values";

/** Card keys this page edits. `id` is the table key, the rest of the record is shown read-only. */
export const EDITABLE_FIELDS = [
  "name",
  "title",
  "text",
  "type",
  "rare",
  "resource",
  "destroy_resources",
  "tag",
  "card_vanishing",
  "equips",
  "is_only",
  "sfx",
];

/** Keys `editors/page/page.mjs` renders as a nested table instead of a row, so this page does too. */
const NESTED_CARD = new Set(["post_rite"]);

const TYPE_OPTIONS = [
  ["char", "char · 人物"],
  ["item", "item · 物件"],
  ["sudan", "sudan · 苏丹的需求卡"],
];
const RARE_OPTIONS = [
  [1, "1 · 石块"],
  [2, "2 · 铜"],
  [3, "3 · 银"],
  [4, "4 · 金"],
];
const IS_ONLY_OPTIONS = [
  [1, "1 · 整局只留一张"],
  [0, "0 · 不限张数"],
];

const CARD_PAGE_CSS = `
.leftcol { flex: 0 1 300px; display: flex; flex-direction: column; gap: 14px; }
.leftcol h2 { margin-top: 0; }
.lbl code { display: block; }
.lbl .key-zh { display: block; color: var(--ink); }
#card-pending { border-left: 2px solid var(--gold); padding-left: 10px; }
.savebar { display: flex; align-items: center; gap: 12px; }
.savebar #card-status { margin: 0; }
button.exp:disabled { opacity: 0.45; cursor: default; }
.art-lbl { display: block; color: var(--ink); font-size: 13px; margin: 12px 0 6px; }
#card-art-prompt, #card-art-status, #card-notify-status { margin: 0; }
.tag-add { margin-top: 10px; display: flex; align-items: center; gap: 8px; }
.tag-add-lbl { color: var(--ink); white-space: nowrap; font-size: 13px; }
.tag-add input { flex: 1 1 auto; min-width: 0; }
.tags .empty { color: #8a7a60; }
.tags td .note { margin-top: 5px; }
.tags td .note.bad { color: var(--bad); }
.readonly { padding-top: 4px; }
`;

// ---------------------------------------------------------------- values

/** The editable values of one record: everything the page's controls can change. */
export function valuesFromRecord(record) {
  const values = {};
  for (const key of EDITABLE_FIELDS) {
    if (!(key in record) || key === "tag") continue;
    const value = record[key];
    values[key] = Array.isArray(value) ? value.slice() : value;
  }
  const tag = record.tag;
  values.tag = tag && typeof tag === "object" && !Array.isArray(tag) ? { ...tag } : {};
  return values;
}

/** What the page shows: the record, with the values already stored in the page winning. */
function effectiveValues(record, stored) {
  const values = valuesFromRecord(record);
  if (!stored || typeof stored !== "object") return values;
  for (const [key, value] of Object.entries(stored)) {
    if (!EDITABLE_FIELDS.includes(key)) continue;
    if (key === "tag") {
      values.tag = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
    } else {
      values[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  return values;
}

/** A list written as a string and read back as a list is the same value, not an edit. */
function asList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item));
}

/** Compare the way the page reads a value: `"2"` and `2` are the same rare. */
export function sameValue(left, right) {
  if (left === undefined) left = null;
  if (right === undefined) right = null;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = asList(left);
    const b = asList(right);
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  if (typeof left === "object" || typeof right === "object") {
    const a = typeof left === "object" ? left : {};
    const b = typeof right === "object" ? right : {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (a[key] === undefined || b[key] === undefined) return false;
      if (Number(a[key]) !== Number(b[key])) return false;
    }
    return true;
  }
  return String(left) === String(right);
}

/**
 * The values that differ from the record, in the shape `applyCardValues` takes:
 * `{ fields, removedTags }`. `fields.tag` holds the tag levels that changed or are new, because
 * a whole tag map in the diff would rewrite tags the player never touched.
 */
export function pendingValues(record, values) {
  const fields = {};
  for (const key of EDITABLE_FIELDS) {
    if (key === "tag" || !(key in values)) continue;
    // Clearing a key the record never had is not an edit: it would only add an empty key.
    if (record[key] === undefined && (values[key] === "" || (Array.isArray(values[key]) && values[key].length === 0))) {
      continue;
    }
    if (!sameValue(record[key], values[key])) fields[key] = values[key];
  }
  const before = record.tag && typeof record.tag === "object" && !Array.isArray(record.tag) ? record.tag : {};
  const after = values.tag && typeof values.tag === "object" && !Array.isArray(values.tag) ? values.tag : {};
  const tag = {};
  for (const [name, level] of Object.entries(after)) {
    if (!sameValue(before[name], level)) tag[name] = level;
  }
  if (Object.keys(tag).length) fields.tag = tag;
  const removedTags = Object.keys(before).filter((name) => !(name in after));
  return { fields, removedTags };
}

/** Editable keys the record still carries but the page's value block does not. */
export function missingValues(record, values) {
  return EDITABLE_FIELDS.filter((key) => key in record && !(key in values));
}

// ---------------------------------------------------------------- the JSON block

const blockRe = () =>
  new RegExp(`<script[^>]*\\sid="${CARD_VALUES_ID}"[^>]*>([\\s\\S]*?)</script>`, "i");

/**
 * The block carries two kinds of state. `values` is the card fields a save writes into
 * `config/cards.json`. `artPrompt` is the picture prompt the player typed on the page: it is
 * page state and never a card field, so neither `--collect` nor `--apply` reads it.
 *
 * Escape `<` so a value that contains a tag can never close the block.
 */
const blockText = (id, values, artPrompt) => {
  const payload = { version: 1, id: String(id), values };
  if (typeof artPrompt === "string") payload.artPrompt = artPrompt;
  return JSON.stringify(payload, null, 2).replace(/</g, "\\u003c");
};

/** The values a page carries, or null when it has no readable block. */
export function readPageValues(html) {
  const match = blockRe().exec(String(html ?? ""));
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const values = parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values) ? parsed.values : {};
  return {
    id: String(parsed.id ?? ""),
    values,
    artPrompt: typeof parsed.artPrompt === "string" ? parsed.artPrompt : undefined,
  };
}

/**
 * Replace the block, or put one at the end of `<body>` when the page has none. An `artPrompt`
 * of `undefined` keeps the prompt the page already carries, so writing values never drops it.
 */
export function writePageValues(html, id, values, artPrompt) {
  const source = String(html ?? "");
  const prompt = artPrompt === undefined ? readPageValues(source)?.artPrompt : artPrompt;
  const block = `<script type="application/json" id="${CARD_VALUES_ID}">\n${blockText(id, values, prompt)}\n</script>`;
  if (blockRe().test(source)) return source.replace(blockRe(), block);
  const bodyEnd = source.toLowerCase().lastIndexOf("</body>");
  if (bodyEnd === -1) return `${source.replace(/\s*$/, "\n")}${block}\n`;
  return `${source.slice(0, bodyEnd)}${block}\n${source.slice(bodyEnd)}`;
}

// ---------------------------------------------------------------- writing back

/** The last entry with this key: a repeated key means "append" to the game, so the last wins. */
function nodeAt(doc, keyPath) {
  let node = doc.root;
  for (const key of keyPath) {
    if (!node || node.type !== "object") return null;
    const entries = findEntries(node, key);
    if (!entries.length) return null;
    node = entries[entries.length - 1].value;
  }
  return node;
}

/** Replace one value's span, or add the key when the record never had it. */
function writeValue(doc, keyPath, value) {
  const node = nodeAt(doc, keyPath);
  if (node) {
    if (sameValue(toPlain(doc, node), value)) return false;
    doc.set(node, literal(value));
    return true;
  }
  const parent = nodeAt(doc, keyPath.slice(0, -1));
  if (!parent || parent.type !== "object") return false;
  doc.append(parent, keyPath[keyPath.length - 1], literal(value));
  return true;
}

/** Write the tag levels that changed, and drop the tags the page says are gone. */
function writeTagMap(doc, id, tagFields, removedTags) {
  if (!nodeAt(doc, [id])) return 0;
  let written = 0;
  const tagNode = nodeAt(doc, [id, "tag"]);
  if (!tagNode || tagNode.type !== "object") {
    if (Object.keys(tagFields).length) {
      if (tagNode) {
        doc.set(tagNode, literal(tagFields));
      } else {
        const card = nodeAt(doc, [id]);
        if (card && card.type === "object") doc.append(card, "tag", literal(tagFields));
      }
      written += Object.keys(tagFields).length;
    }
    return written;
  }
  for (const [name, level] of Object.entries(tagFields)) {
    const current = nodeAt(doc, [id, "tag"]);
    if (!current || current.type !== "object") break;
    const entry = findEntries(current, name).at(-1);
    if (entry) {
      if (!sameValue(toPlain(doc, entry.value), level)) {
        doc.set(entry.value, literal(level));
        written += 1;
      }
    } else {
      doc.append(current, name, literal(level));
      written += 1;
    }
  }
  for (const name of removedTags) {
    const current = nodeAt(doc, [id, "tag"]);
    if (!current || current.type !== "object") break;
    if (findEntries(current, name).length) {
      doc.remove(current, name);
      written += 1;
    }
  }
  return written;
}

/**
 * Write `[{ id, fields, removedTags }]` into a `cards.json` text. Only the spans named by the
 * diff move; an id the file does not hold is skipped, so a stale page cannot invent a card.
 */
export function applyCardValues(text, changes) {
  const doc = parseDoc(text);
  if (doc.root.type !== "object") throw new Error("cards.json must be an object keyed by card id");
  let written = 0;
  for (const change of changes || []) {
    const id = String(change?.id ?? "");
    if (!id) continue;
    for (const [key, value] of Object.entries(change.fields || {})) {
      if (key === "tag") continue;
      if (writeValue(doc, [id, key], value)) written += 1;
    }
    written += writeTagMap(doc, id, change.fields?.tag || {}, change.removedTags || []);
  }
  return { text: doc.render(), written };
}

// ---------------------------------------------------------------- the page

function rowHtml({ key, label, note, control }) {
  const tip = note ? `<div class="note" style="margin:5px 0 0">${esc(note)}</div>` : "";
  return `<div class="row" data-key="${esc(key)}">
  <div class="lbl"><code>${esc(key)}</code><span class="key-zh">${esc(label)}</span></div>
  <div class="val">${control}${tip}</div>
</div>`;
}

function textControl(key, value, { multiline = false, array = false } = {}) {
  const text = esc(value === undefined || value === null ? "" : String(value));
  if (multiline) return `<textarea data-field="${esc(key)}">${text}</textarea>`;
  const extra = array ? ' data-array="1"' : "";
  return `<input type="text" data-field="${esc(key)}" autocomplete="off" value="${text}"${extra}>`;
}

function selectControl(key, value, options, { number = false } = {}) {
  const current = value === undefined || value === null ? "" : String(value);
  const list = options.map(([optionValue, optionLabel]) => ({ value: String(optionValue), label: optionLabel }));
  if (current !== "" && !list.some((option) => option.value === current)) {
    list.unshift({ value: current, label: `${current}（不在原版取值里）` });
  }
  const optionsHtml = list
    .map((option) => `<option value="${esc(option.value)}"${option.value === current ? " selected" : ""}>${esc(option.label)}</option>`)
    .join("");
  const attrs = `data-field="${esc(key)}"${number ? ' data-number="1"' : ""}`;
  return `<select ${attrs}>${optionsHtml}</select>`;
}

const listText = (value) => (Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value));

/** One editable row, or one read-only row for a key the page must not change. */
function cardRow({ key, record, values }) {
  const info = requireLabel("card", key);
  const value = key in values ? values[key] : record[key];
  let control;
  let extra = "";
  switch (key) {
    case "id":
      control = `<code>${esc(record.id ?? "")}</code>`;
      extra = "这是卡表里的键，这一页不改编号。";
      break;
    case "name":
    case "title":
      control = textControl(key, value);
      break;
    case "text":
      control = textControl(key, value, { multiline: true });
      break;
    case "type":
      control = selectControl(key, value, TYPE_OPTIONS);
      break;
    case "rare":
      control = selectControl(key, value, RARE_OPTIONS, { number: true });
      break;
    case "resource":
    case "destroy_resources":
      control = textControl(key, listText(value), { array: true });
      extra = "多个值用英文逗号分开。";
      break;
    case "card_vanishing":
      control = `<input type="number" data-field="${esc(key)}" data-number="1" value="${esc(value ?? 0)}">`;
      break;
    case "equips":
      // A slot repeats: three 饰品 is three slots, so this stays a list and not a select.
      control = textControl(key, listText(value), { array: true });
      extra = "写几遍就有几个槽；多个用英文逗号分开。";
      break;
    case "is_only":
      control = selectControl(key, value, IS_ONLY_OPTIONS, { number: true });
      break;
    case "sfx":
      control = textControl(key, value);
      break;
    case "pops":
    case "vanish":
      control = `<div class="readonly">${fmt(value, "card", key)}</div>`;
      extra = "这一页只读这一项。";
      break;
    case "tag":
      control = `<div class="readonly" id="tag-summary">${esc(tagSummary(value))}</div>`;
      extra = "标记只有「有」或「没有」；数值型的范围见下面的表。改标签用下面两张表。";
      break;
    default:
      control = `<div class="readonly">${fmt(value, "card", key)}</div>`;
      extra = "这一页只读这一项。";
  }
  return rowHtml({
    key,
    label: info.label,
    note: [info.note, extra].filter(Boolean).join(" "),
    control,
  });
}

/** Every row the fields panel shows: the record's keys in file order, then pending new ones. */
function fieldRows({ record, values }) {
  const live = new Set(FIELDS.card.fields || []);
  const keys = [];
  for (const key of Object.keys(record)) {
    if (live.has(key) && !NESTED_CARD.has(key) && !keys.includes(key)) keys.push(key);
  }
  for (const key of EDITABLE_FIELDS) {
    if (key !== "tag" && key in values && !keys.includes(key)) keys.push(key);
  }
  if (!keys.includes("tag")) keys.push("tag");
  return keys.map((key) => cardRow({ key, record, values })).join("\n");
}

/** The live tags a new tag can be picked from: the whole of tag.json, marked by how it is used. */
function tagNameOptions() {
  const names = TAG_ROLES.allTagNames?.names || [];
  return names
    .map((tag) => {
      const marker = Boolean(TAG_ROLES.marker[tag.name]);
      const range = TAG_ROLES.stat[tag.name];
      const attrs = [
        `data-kind="${marker ? "marker" : "stat"}"`,
        tag.usedOnCards ? 'data-used="1"' : "",
        range ? `data-min="${range.min}" data-max="${range.max}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<option value="${esc(tag.name)}" ${attrs}></option>`;
    })
    .join("\n");
}

/** The stat tags `数值` takes, with the range its number input must carry. */
function statNameOptions() {
  return Object.entries(TAG_ROLES.stat)
    .map(([name, range]) => `<option value="${esc(name)}" data-kind="stat" data-min="${range.min}" data-max="${range.max}"></option>`)
    .join("\n");
}

/** The matching list `加标记` / `加属性` filter as the player types. */
function tagDatalists() {
  return `<datalist id="tag-name-options">
${tagNameOptions()}
</datalist>
<datalist id="tag-stat-options">
${statNameOptions()}
</datalist>`;
}

/**
 * One add control per table. `加标记` offers every name in tag.json and refuses a stat; `加属性`
 * offers only the stat names, so its list is short enough to read.
 */
function tagAddControl(kind) {
  const marker = kind === "marker";
  const count = marker ? TAG_ROLES.allTagNames?.names?.length ?? 0 : Object.keys(TAG_ROLES.stat).length;
  const label = marker ? "加标记" : "加属性";
  const placeholder = marker
    ? `输入标记名，从 ${count} 个原版标签里匹配`
    : `输入属性名，从 ${count} 个原版属性里匹配`;
  const list = marker ? "tag-name-options" : "tag-stat-options";
  return `<div class="tag-add">
<label class="tag-add-lbl" for="tag-add-${kind}">${esc(label)}</label>
<input id="tag-add-${kind}" type="text" data-tag-add="${kind}" list="${list}" autocomplete="off" placeholder="${esc(placeholder)}">
</div>`;
}

/**
 * A marker is present or absent, so a row is a checked box: unchecking drops the key. A name
 * `tag.json` does not carry gets the same box, says what is missing, and has no range to print.
 */
function markerCell(name, level) {
  const current = Number(level);
  const value = Number.isFinite(current) && current !== 0 ? current : 1;
  const odd = value !== 1;
  const known = KNOWN_TAG_NAMES.has(name);
  const note = known
    ? ""
    : `<div class="note bad" data-tag-warning="${esc(name)}">${esc(UNKNOWN_TAG_NOTE)}</div>`;
  // 1 或不存在 is read off the vanilla uses of this name, so building the tag is what settles it.
  const range = known ? `1 或不存在${odd ? `；这张卡写的是 ${esc(level)}` : ""}` : UNKNOWN_TAG_RANGE;
  const box = `<input type="checkbox" data-tag-level="${esc(name)}" data-tag-kind="marker" value="${esc(value)}" checked>`;
  return `<tr data-tag-row="${esc(name)}"><td><code>${esc(name)}</code>${note}</td><td class="num">${box}</td><td>${range}</td></tr>`;
}

/** A stat row is always a name `tag.json` carries, so its cell is the name alone. */
function statCell(name, level) {
  const range = TAG_ROLES.stat[name];
  // The vanilla range is advice, not a limit: a mod may want 12 体魄 on a boss card.
  const attrs = "";
  const input = `<input type="number" data-tag-level="${esc(name)}" data-tag-kind="stat" value="${esc(level)}"${attrs}>`;
  return `<tr data-tag-row="${esc(name)}"><td><code>${esc(name)}</code></td><td class="num">${input}</td><td>${
    range ? `${range.min} … ${range.max}` : "不在原版 tag 表"
  }</td></tr>`;
}

function tagSections(values) {
  const entries = Object.entries(values.tag || {});
  // A name `tag.json` does not carry has no role to split on: it goes to 标记, the table whose row
  // is a checkbox, so the player can see, uncheck and re-add it. Its row says what is missing.
  const isMarkerRow = ([name]) => Boolean(TAG_ROLES.marker[name]) || !KNOWN_TAG_NAMES.has(name);
  const markers = entries.filter(isMarkerRow);
  const stats = entries.filter((entry) => !isMarkerRow(entry));
  return `<h2>开关标签 · 有或没有</h2>
<div class="panel">
<table class="tags" id="tag-markers">
<thead><tr><th>标记</th><th>状态</th><th>原版范围</th></tr></thead>
<tbody>
${markers.map(([name, level]) => markerCell(name, level)).join("\n") || '<tr><td colspan="3" class="empty">没有标记</td></tr>'}
</tbody>
</table>
${tagAddControl("marker")}
<div class="note">这些标签在游戏里只可能是 1（有）或不存在。取消勾选就去掉这个标记。</div>
</div>

<h2>数值标签 · 这张卡的属性</h2>
<div class="panel">
<table class="tags" id="tag-stats">
<thead><tr><th>属性</th><th>数值</th><th>原版范围</th></tr></thead>
<tbody>
${stats.map(([name, level]) => statCell(name, level)).join("\n") || '<tr><td colspan="3" class="empty">没有属性</td></tr>'}
</tbody>
</table>
${tagAddControl("stat")}
<div class="note">标签用的是<b>中文显示名</b>，不是 code。改名会让引用它的所有条件失效。</div>
</div>

${tagDatalists()}`;
}

/** The tags as one line — `体魄 3、男性 1` — or 「没有标签」 when the card carries none. */
function tagSummary(tag) {
  const entries = Object.entries(tag && typeof tag === "object" && !Array.isArray(tag) ? tag : {});
  if (!entries.length) return "没有标签";
  return entries.map(([name, level]) => `${name} ${level}`).join("、");
}

function cardFace({ id, record, values, modDir }) {
  const artFile = path.join(modDir, "image", "cards", `${id}.png`);
  if (!existsSync(artFile)) {
    return '<div class="cardface">472 × 1028<br>卡面图放这里<br><span style="opacity:.6">只替换内部画面，边框由游戏画</span></div>';
  }
  const face = fontFace();
  return artInline(
    modDir,
    id,
    values.rare ?? record.rare,
    values.name ?? record.name,
    values.type ?? record.type,
    face.family,
  );
}

function postRiteSection(record) {
  const value = record.post_rite;
  if (!Array.isArray(value) || !value.length) return "";
  const info = requireLabel("card", "post_rite");
  return `<h2>${esc(info.label)}</h2>
<div class="panel">
${info.note ? `<div class="note" style="margin-top:0">${esc(info.note)}</div>` : ""}
${tableFor("settlement", value)}
</div>`;
}

/**
 * One card page. `previous` is the block read from a page that already exists: its values win
 * over the record, so regenerating the layout never throws away an edit waiting to be applied,
 * and its `artPrompt` wins over the composed one for the same reason.
 */
export function cardPageHtml({ id, record, modDir, previous = null, origin = "new" }) {
  const stored = previous && String(previous.id) === String(id) ? previous : null;
  const values = effectiveValues(record, stored ? stored.values : null);
  const diff = pendingValues(record, values);
  const pending = Object.keys(diff.fields).length > 0 || diff.removedTags.length > 0;
  const view = { ...record, ...values };
  const subject = composeSubject(view);
  // The prompt the player typed wins over the one this record composes, so regenerating the page
  // never throws away a sentence already read off the old page.
  const artPrompt = stored && typeof stored.artPrompt === "string" ? stored.artPrompt : subject;
  const face = fontFace();

  const live = new Set(FIELDS.card.fields || []);
  const legacy = Object.keys(record).filter((key) => !live.has(key) && (FIELDS.card.legacy || []).includes(key));
  const unknown = Object.keys(record).filter((key) => !live.has(key) && !(FIELDS.card.legacy || []).includes(key));

  const title = String(values.name ?? record.name ?? `卡 ${id}`);
  const badge = origin === "override"
    ? '<span class="origin override">覆盖原版</span>'
    : '<span class="origin">新增</span>';
  const sub = `${badge}卡页 · id <code>${esc(id)}</code> · ${esc(values.type ?? record.type ?? "没写 type")} · 稀有度 ${esc(
    values.rare ?? record.rare ?? "没写",
  )}`;

  const pendingNote = pending
    ? `<p class="note" id="card-pending">这些值还没写回配置。</p>`
    : "";
  const noHost = `<p class="note" id="card-no-host">这些值只能在 app 里保存：直接在浏览器打开这一页时，改了不会写回 <code>cards.json</code>。「发送给 Agent」与「修改卡面图，通知 agent」两个按钮也用不了：它们要 app 把消息发进会话。</p>`;
  const saveBar = `<div class="panel" id="card-savebar" hidden>
<div class="savebar">
<button class="exp" id="card-reload" type="button">重新加载</button>
</div>

</div>`;
  const body = `${pendingNote}
${noHost}
${saveBar}

<h2>卡面</h2>
<div class="split">
  <div class="leftcol">
  ${cardFace({ id, record, values, modDir })}
<h2>画面 · 这张图画成什么</h2>
<div class="panel">
<div class="note" style="margin-top:0">只写主体：画谁、画什么、什么神态。构图、风格、透明底由生成配方补，不用写在这里。</div>
<label class="art-lbl" for="card-art-prompt">卡面图的提示词</label>
<textarea id="card-art-prompt" data-art-prompt="1">${esc(artPrompt)}</textarea>
<div class="savebar" style="margin-top:10px">
<button class="exp" id="card-art-notify" type="button" disabled>修改卡面图，通知 agent</button>
<span class="note" id="card-art-status"></span>
</div>
</div>
  </div>
  <div class="grow">
    <div class="panel">
${fieldRows({ record, values })}
    </div>
  </div>
</div>


${tagSections(values)}

${postRiteSection(record)}
${legacySection(legacy)}
${unknownSection(unknown)}
`;

  return pageHtml({
    title,
    sub,
    body,
    font: face.css ? face : null,
    extraCss: CARD_PAGE_CSS,
    script: BRIDGE_SOURCE,
    tail: `<script type="application/json" id="${CARD_VALUES_ID}">\n${blockText(id, values, artPrompt)}\n</script>\n`,
    document: true,
    wrapAttrs: `data-card-page="${esc(id)}"`,
  });
}

export default {
  CARD_VALUES_ID,
  EDITABLE_FIELDS,
  applyCardValues,
  cardPageHtml,
  missingValues,
  pendingValues,
  readPageValues,
  sameValue,
  valuesFromRecord,
  writePageValues,
};
