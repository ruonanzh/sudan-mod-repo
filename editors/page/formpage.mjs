/**
 * Editable pages for records whose fields are few and fixed: a loot table, a fate-shop entry.
 *
 * The page is static and its shape is the card page's shape: one panel of rows, each row a key in
 * a narrow left column and the value (with the sentence that explains it) in the right column.
 * The values also sit in one JSON block at the end, which the app's editor wrapper (editors/form/)
 * rewrites on save and reads when diffing, so sending tells the agent exactly which keys changed.
 */
import { esc, pageHtml } from "../lib/shell.mjs";
import { requireLabel } from "../lib/labels.mjs";

/** The fields each kind shows, in the order the page prints them. `id` is read-only. */
export const FORM_FIELDS = {
  loot: {
    label: "战利品表",
    scalar: ["repeat", "type", "name"],
    selects: {
      type: [
        ["2", "2 · 普通权重：每一轮按权重抽一件"],
        ["3", "3 · 必新：每一轮先去掉玩家已有的，再按权重抽一件"],
        ["4", "4 · 无放回：一次抽 m 件，不重复"],
        ["99", "99 · 全部：表里所有符合条件的物品都给"],
      ],
    },
    numbers: ["repeat"],
    items: "item",
  },
  upgrade: {
    label: "命运商店",
    scalar: ["name", "text", "cost", "icon", "link_card"],
    selects: { icon: [["gain", "gain · 获得"], ["buff", "buff · 增益"]] },
    numbers: ["cost", "link_card"],
    /** Fields the player describes in their own words; the agent writes the JSON, not the page. */
    prose: ["condition", "effect", "incompatible"],
  },
};

/** The item row shape a loot table repeats. */
const ITEM_FIELDS = ["type", "id", "num", "weight", "condition"];
const ITEM_NUMBERS = ["id", "num", "weight", "type"];

const show = (value) => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

/** The card page's row rules, so the two kinds of page read the same. */
/**
 * One line per algorithm: what one round gives, how `repeat` reads for it, and a worked example.
 * The page swaps the visible line when the player picks another value.
 */
export const LOOT_TYPE_NOTES = {
  "2": "这个算法每一轮按权重抽一件，所以玩家得到 repeat 件，同一个物品可以出现多次。例如 repeat 写 3、两项权重是 10 与 5，玩家得到 3 件，权重 10 的那项大约出现两件。",
  "3": "这个算法每一轮先去掉玩家已经拥有的物品，再按权重抽一件，所以最多得到 repeat 件，池子抽空时会少一些。例如 repeat 写 2、表里三件而玩家已有一件，这次最多得到 2 件，已经有的那件不会再给。",
  "4": "这个算法把 repeat 当成件数，一次抽出这么多件，而且不重复。例如 repeat 写 2，玩家一次得到 2 件不同的物品；表里符合条件的不足 2 件时，把有的都给出来。",
  "99": "这个算法每一轮把整张表里符合条件的物品各给一份，所以玩家得到 repeat 乘表中物品数那么多件。例如 repeat 写 2、表里 3 件，玩家得到 6 件，每一件两份。",
};

const FORM_CSS = `
.lbl code { display: block; }
.lbl .key-zh { display: block; color: var(--ink); }
.readonly { padding-top: 4px; }
.panel .row:first-of-type { padding-top: 0; }
.item { border: 1px solid var(--rule); border-radius: 4px; padding: 10px 12px; margin-bottom: 10px; }
.item-head { display: flex; align-items: center; justify-content: space-between; color: var(--dim); font-size: 12.5px; margin-bottom: 8px; }
.item-head .pill { margin: 0; padding: 2px 8px; }
.item-fields { display: grid; grid-template-columns: 150px 1fr 78px 78px; gap: 8px; }
.item-fields .cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.item-fields .cell input, .item-fields .cell select { width: 100%; box-sizing: border-box; }
.item-condition { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.item-condition textarea { width: 100%; box-sizing: border-box; }
.item-condition .cur { color: var(--dim); font-size: 12px; margin-left: 6px; }
#item-add { margin-top: 2px; }
.only-host { color: var(--dim); font-size: 13px; margin-top: 16px; }
`;

/** What each described field asks the player to write, in one sentence. */
const PROSE_ASK = {
  condition: '用你自己的话写什么条件，也可以直接写 JSON，例如 {"have.2000009": 1}。',
  effect: '用你自己的话写玩家得到什么，也可以直接写 JSON，例如 {"g.card": [2000001, "已拥有+1"]}。',
  incompatible: "用你自己的话写和哪条升级互斥，也可以直接写条目编号，例如 3300016。",
};

/** A row the player reads and describes: the value is shown, the sentence travels to the agent. */
function proseRow(kind, key, value) {
  const current = value === undefined ? "（还没有写）" : typeof value === "string" ? value : JSON.stringify(value);
  return row(
    key,
    requireLabel(kind, key),
    `<div class="readonly"><code>${esc(current)}</code></div>
<textarea data-prose="${esc(key)}" rows="2" spellcheck="false" placeholder="${esc(PROSE_ASK[key] || "用你自己的话写")}"></textarea>`,
  );
}

/** The type pick carries a second line that changes with the value: what one round gives. */
function tooltipControl(kind, field, record, spec) {
  const base = control(kind, field, record[field], spec);
  if (kind !== "loot" || field !== "type") return base;
  const current = String(record.type ?? "2");
  return `${base}<p class="note dyn" id="type-note">${esc(LOOT_TYPE_NOTES[current] || LOOT_TYPE_NOTES["2"])}</p>`;
}

/** One row: key and its Chinese name on the left, the control and its sentence on the right. */
function row(key, info, control) {
  return `<div class="row" data-key="${esc(key)}">
  <div class="lbl"><code>${esc(key)}</code><span class="key-zh">${esc(info.label)}</span></div>
  <div class="val">${control}<div class="note" style="margin:5px 0 0">${esc(info.note)}</div></div>
</div>`;
}

function control(kind, key, value, spec) {
  const options = spec?.selects?.[key];
  if (options) {
    const current = String(value ?? options[0][0]);
    // A record may carry a value outside the list (a third icon key someone added to variable.json).
    const list = options.some(([v]) => v === current) ? options : [[current, `${current}（不在原版取值里）`], ...options];
    const numeric = spec?.numbers?.includes(key);
    return `<select data-form="${esc(key)}"${numeric ? ' data-kind="number"' : ""}>${list
      .map(([v, text]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(text)}</option>`)
      .join("")}</select>`;
  }
  if (spec?.json?.includes(key) || (value !== null && typeof value === "object")) {
    return `<textarea data-form="${esc(key)}" data-kind="json" rows="3" spellcheck="false">${esc(show(value))}</textarea>`;
  }
  const numeric = spec?.numbers?.includes(key) || typeof value === "number";
  return `<input data-form="${esc(key)}" data-kind="${numeric ? "number" : "text"}" type="${numeric ? "number" : "text"}" value="${esc(show(value))}">`;
}

/** The loot table's repeated rows: each entry is one block of two rows — numbers, then its condition. */
function itemsPanel(value) {
  return `<h2>放什么</h2>
<div class="panel">
<p class="note" style="margin:0 0 10px">一行就是一件东西。加一件、删一件都可以，顺序就是抽签的顺序。</p>
<div id="item-rows">${(Array.isArray(value) ? value : []).map((item, i) => itemBlock(item, i)).join("")}</div>
<button type="button" class="pill" id="item-add">加一件</button>
</div>`;
}

/** The four drawn-from namespaces, with the sentence that says what each one holds. */
const ITEM_TYPES = [
  ["card", "card · 卡"],
  ["event", "event · 事件"],
  ["rite", "rite · 仪式"],
  ["loot", "loot · 另一张战利品表"],
];

/**
 * One entry: type, id, count and weight on the first row, the condition the player describes on
 * the second. The id gets the room, because a card id is seven digits and the old narrow cell cut it.
 */
function itemBlock(item = {}, index = 0) {
  const cell = (key, label, input) =>
    `<label class="cell"><span class="key-zh">${esc(label)}</span>${input}</label>`;
  const current = item.condition === undefined ? "" : `<code class="cur">${esc(JSON.stringify(item.condition))}</code>`;
  return `<div class="item" data-item-row>
  <div class="item-head"><span>第 ${index + 1} 件</span><button type="button" class="pill" data-item-remove>删除</button></div>
  <div class="item-fields">
    ${cell("type", "类型", `<select data-item="type">${ITEM_TYPES.map(([v, text]) => `<option value="${v}"${String(item.type ?? "card") === v ? " selected" : ""}>${esc(text)}</option>`).join("")}</select>`)}
    ${cell("id", "编号", `<input data-item="id" data-kind="number" type="number" value="${esc(show(item.id))}">`)}
    ${cell("num", "数量", `<input data-item="num" data-kind="number" type="number" value="${esc(show(item.num))}">`)}
    ${cell("weight", "权重", `<input data-item="weight" data-kind="number" type="number" value="${esc(show(item.weight))}">`)}
  </div>
  <div class="item-condition">
    <span class="key-zh">条件${current}</span>
    <textarea data-prose-item="condition" rows="2" spellcheck="false" placeholder='用你自己的话写什么条件，也可以直接写 JSON，例如 {"have.2000009": 1}。' ></textarea>
  </div>
</div>`;
}

export function formPageHtml({ kind, id, record = {}, origin = "new", recordKey = null }) {
  const spec = FORM_FIELDS[kind];
  if (!spec) throw new Error(`no form page for ${kind}`);
  const key = recordKey || `${kind}:${id}`;
  const badge = origin === "override"
    ? '<span class="origin override">覆盖原版</span>'
    : '<span class="origin">新增</span>';
  const fields = [
    row("id", requireLabel(kind, "id"), `<div class="readonly">${esc(String(id))}</div>`),
    ...spec.scalar.map((field) => row(field, requireLabel(kind, field), tooltipControl(kind, field, record, spec))),
    ...(spec.prose || []).map((field) => proseRow(kind, field, record[field])),
  ].join("\n");

  // The wrapper mounts the element that carries `data-form-page`, so that element is the whole
  // `.wrap`: title, subtitle and panels travel together, exactly as they do on a card page.
  return pageHtml({
    title: `${spec.label} ${id}`,
    sub: `${badge}${esc(spec.label)} · id <code>${esc(String(id))}</code>`,
    extraCss: FORM_CSS,
    body: `<div class="panel">${fields}</div>
${spec.items ? itemsPanel(record[spec.items]) : ""}
<script type="application/json" id="loot-type-notes">${JSON.stringify(LOOT_TYPE_NOTES).replace(/</g, "\\u003c")}</script>
<script type="application/json" id="form-values">${JSON.stringify({ version: 1, key, values: record }).replace(/</g, "\\u003c")}</script>`,
    wrapAttrs: `data-form-page="${esc(key)}"`,
    script: "",
  });
}
