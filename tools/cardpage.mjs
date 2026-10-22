/**
 * cardpage.mjs — the per-card page `tools/preview.mjs` writes, and the values it carries.
 *
 * A card is one node in a table, so the page for it is the card page `tools/page.mjs` already
 * renders (card face, labelled rows, tag tables, the art subject), turned into controls. Every
 * row prints the raw key in code style next to its Chinese label, so a reader who edits the
 * record still sees which key they are touching.
 *
 * The values live in a JSON block at the end of the page's own `<body>`. That block is what the
 * app save writes and what `preview --collect` / `preview --apply` read: a save never touches
 * `config/cards.json`, and an apply replaces only the value spans that changed, so comments,
 * key order and every field this page does not show survive (`tools/jsonc.mjs`).
 *
 * `editors/sudan_card_page/card-bridge.js` is inlined into every page and is the same script the
 * tool's wrapper loads. It speaks the app protocol (`editor:readFile` / `editor:save`), and when
 * the page is opened straight from disk the visible line says values can only be saved in the app.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { esc, pageHtml } from "./html.mjs";
import { composeSubject } from "./art.mjs";
import { artInline, fontFace, fmt, legacySection, tableFor, unknownSection } from "./page.mjs";
import { findEntries, literal, parseDoc, toPlain } from "./jsonc.mjs";

const FIELDS = JSON.parse(readFileSync(new URL("../schema/fields.json", import.meta.url), "utf8"));
const LABELS = JSON.parse(readFileSync(new URL("../schema/field-labels.json", import.meta.url), "utf8"));
const TAG_ROLES = JSON.parse(readFileSync(new URL("../schema/tag-roles.json", import.meta.url), "utf8"));

const BRIDGE_SOURCE = readFileSync(new URL("../editors/sudan_card_page/card-bridge.js", import.meta.url), "utf8").trimEnd();

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

/** Keys `tools/page.mjs` renders as a nested table instead of a row, so this page does too. */
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
.tag-add { margin-top: 10px; }
.tag-add input { width: 100%; }
.tags .empty { color: #8a7a60; }
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

/** Escape `<` so a value that contains a tag can never close the block. */
const blockText = (id, values) =>
  JSON.stringify({ version: 1, id: String(id), values }, null, 2).replace(/</g, "\\u003c");

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
  return { id: String(parsed.id ?? ""), values };
}

/** Replace the block, or put one at the end of `<body>` when the page has none. */
export function writePageValues(html, id, values) {
  const block = `<script type="application/json" id="${CARD_VALUES_ID}">\n${blockText(id, values)}\n</script>`;
  const source = String(html ?? "");
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

function labelOf(key) {
  return LABELS.card?.[key] || null;
}

/** A page may not print a raw key and no Chinese; fail the way tools/page.mjs fails. */
function requireLabel(key) {
  const info = labelOf(key);
  if (!info) {
    throw new Error(`card: no label for ${JSON.stringify(key)}. Add it to schema/field-labels.json.`);
  }
  return info;
}

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
  const info = requireLabel(key);
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
      control = tagAddControl();
      extra = "标记只有「有」或「没有」；数值型的范围见下面的表。";
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
function tagOptionsHtml() {
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

function tagAddControl() {
  return `<div class="tag-add">
<input type="text" data-tag-add list="tag-name-options" autocomplete="off" placeholder="加一个标签：输入名字，匹配列表会实时过滤">
<datalist id="tag-name-options">
${tagOptionsHtml()}
</datalist>
</div>
<div class="note" style="margin:6px 0 0">原版 tag.json 定义了 ${TAG_ROLES.allTagNames?.count ?? 0} 个标签；输入会从这 ${TAG_ROLES.allTagNames?.names?.length ?? 0} 个名字里过滤。</div>`;
}

function markerCell(name, level) {
  const current = Number(level);
  const odd = current !== 0 && current !== 1;
  const option = (value, text, selected) =>
    `<option value="${value}"${selected ? " selected" : ""}>${text}</option>`;
  const extra = odd ? option(String(level), `${esc(level)}（原版只用 1）`, true) : "";
  const select = `<select data-tag-level="${esc(name)}" data-tag-kind="marker">${extra}${option(
    "1",
    "1 · 有",
    current === 1,
  )}${option("0", "0 · 没有", current === 0)}</select>`;
  return `<tr data-tag-row="${esc(name)}"><td><code>${esc(name)}</code></td><td class="num">${select}</td><td>1 或不存在</td></tr>`;
}

function statCell(name, level) {
  const range = TAG_ROLES.stat[name];
  const attrs = range ? ` min="${range.min}" max="${range.max}"` : "";
  const input = `<input type="number" data-tag-level="${esc(name)}" data-tag-kind="stat" value="${esc(level)}"${attrs}>`;
  return `<tr data-tag-row="${esc(name)}"><td><code>${esc(name)}</code></td><td class="num">${input}</td><td>${
    range ? `${range.min} … ${range.max}` : "不在原版 tag 表"
  }</td></tr>`;
}

function tagSections(values) {
  const entries = Object.entries(values.tag || {});
  const markers = entries.filter(([name]) => TAG_ROLES.marker[name]);
  const stats = entries.filter(([name]) => !TAG_ROLES.marker[name]);
  return `<h2>标记 · 有或没有</h2>
<div class="panel">
<table class="tags" id="tag-markers">
<thead><tr><th>标记</th><th>状态</th><th>原版范围</th></tr></thead>
<tbody>
${markers.map(([name, level]) => markerCell(name, level)).join("\n") || '<tr><td colspan="3" class="empty">没有标记</td></tr>'}
</tbody>
</table>
<div class="note">这些标签在游戏里只可能是 1（有）或不存在。1294 张卡里没有一张用过别的值。</div>
</div>

<h2>数值 · 这张卡的属性</h2>
<div class="panel">
<table class="tags" id="tag-stats">
<thead><tr><th>属性</th><th>数值</th><th>原版范围</th></tr></thead>
<tbody>
${stats.map(([name, level]) => statCell(name, level)).join("\n") || '<tr><td colspan="3" class="empty">没有属性</td></tr>'}
</tbody>
</table>
<div class="note">标签用的是<b>中文显示名</b>，不是 code。改名会让引用它的所有条件失效。</div>
</div>`;
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
  const info = requireLabel("post_rite");
  return `<h2>${esc(info.label)}</h2>
<div class="panel">
${info.note ? `<div class="note" style="margin-top:0">${esc(info.note)}</div>` : ""}
${tableFor("settlement", value)}
</div>`;
}

/**
 * One card page. `previous` is the block read from a page that already exists: its values win
 * over the record, so regenerating the layout never throws away an edit waiting to be applied.
 */
export function cardPageHtml({ id, record, modDir, previous = null }) {
  const stored = previous && String(previous.id) === String(id) ? previous.values : null;
  const values = effectiveValues(record, stored);
  const diff = pendingValues(record, values);
  const pending = Object.keys(diff.fields).length > 0 || diff.removedTags.length > 0;
  const view = { ...record, ...values };
  const subject = composeSubject(view);
  const face = fontFace();

  const live = new Set(FIELDS.card.fields || []);
  const legacy = Object.keys(record).filter((key) => !live.has(key) && (FIELDS.card.legacy || []).includes(key));
  const unknown = Object.keys(record).filter((key) => !live.has(key) && !(FIELDS.card.legacy || []).includes(key));

  const title = String(values.name ?? record.name ?? `卡 ${id}`);
  const sub = `卡页 · id <code>${esc(id)}</code> · ${esc(values.type ?? record.type ?? "没写 type")} · 稀有度 ${esc(
    values.rare ?? record.rare ?? "没写",
  )}`;

  const pendingNote = pending
    ? `<p class="note" id="card-pending">这些值还没写回 <code>cards.json</code>。这一页保存时只写这一页；写回要跑 <code>node tools/preview.mjs --apply --mod &lt;ModName&gt;</code>。</p>`
    : "";
  const noHost = `<p class="note" id="card-no-host">这些值只能在 app 里保存：直接在浏览器打开这一页时，改了不会写回 <code>cards.json</code>。</p>`;
  const saveBar = `<div class="panel" id="card-savebar" hidden>
<div class="savebar">
<span class="note" id="card-status">已保存</span>
<button class="exp" id="card-save" type="button">保存这一页（Ctrl+S）</button>
</div>
<div class="note" style="margin:6px 0 0">保存只写入这一页的值块；写回 <code>cards.json</code> 要跑 <code>node tools/preview.mjs --apply --mod &lt;ModName&gt;</code>。</div>
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
<div class="val" style="white-space:pre-wrap">${esc(subject)}</div>
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
    tail: `<script type="application/json" id="${CARD_VALUES_ID}">\n${blockText(id, values)}\n</script>\n`,
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
