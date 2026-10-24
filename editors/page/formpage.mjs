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
    selects: { type: [["2", "2 · 简单权重"], ["3", "3 · 权重取出 m 份"], ["4", "4 · 加权无放回"], ["99", "99 · 全部给"]] },
    numbers: ["repeat"],
    items: "item",
  },
  upgrade: {
    label: "命运商店",
    scalar: ["name", "text", "cost", "icon", "link_card", "incompatible"],
    selects: { icon: [["gain", "gain · 获得"], ["buff", "buff · 增益"]] },
    numbers: ["cost", "link_card", "incompatible"],
    json: ["condition", "effect"],
  },
};

/** The item row shape a loot table repeats. */
const ITEM_FIELDS = ["type", "id", "num", "weight", "condition"];
const ITEM_NUMBERS = ["id", "num", "weight", "type"];

const show = (value) => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

/** The card page's row rules, so the two kinds of page read the same. */
const FORM_CSS = `
.lbl code { display: block; }
.lbl .key-zh { display: block; color: var(--ink); }
.readonly { padding-top: 4px; }
.panel .row:first-of-type { padding-top: 0; }
.items th { text-align: left; font-weight: 600; font-size: 12.5px; color: var(--dim); padding: 4px 6px; }
.items td { padding: 4px 6px; }
.items input, .items select { width: 100%; box-sizing: border-box; }
.items .pill { margin: 8px 0 0; }
.items td:last-child { width: 1%; white-space: nowrap; }
.items td:last-child .pill { margin: 0; padding: 2px 8px; }
.only-host { color: var(--dim); font-size: 13px; margin-top: 16px; }
`;

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

/** The loot table's repeated rows: one table row per entry, the same width as the value column. */
function itemsPanel(value) {
  const rows = Array.isArray(value) ? value : [];
  const cells = (item) =>
    ITEM_FIELDS.map((key) => {
      const v = item?.[key];
      const numeric = ITEM_NUMBERS.includes(key);
      const input =
        key === "type"
          ? `<select data-item="${esc(key)}" data-kind="number">${["2", "3", "99", "4"]
              .map((t) => `<option value="${t}"${String(v ?? 2) === t ? " selected" : ""}>${t}</option>`)
              .join("")}</select>`
          : `<input data-item="${esc(key)}" data-kind="${numeric ? "number" : "text"}" type="${numeric ? "number" : "text"}" value="${esc(show(v))}">`;
      return `<td>${input}</td>`;
    }).join("");
  return `<div class="panel">
<h2>放什么</h2>
<div class="row" data-items style="border-bottom:0;padding-top:0">
  <div class="lbl"><code>item</code><span class="key-zh">放什么</span></div>
  <div class="val">
    <p class="note" style="margin:0 0 6px">一行就是一件东西。加一行、删一行都可以，顺序就是抽取顺序。</p>
    <table class="items"><thead><tr>${ITEM_FIELDS.map((k) => `<th>${esc(k)}</th>`).join("")}<th></th></tr></thead>
    <tbody id="item-rows">${rows
      .map((item) => `<tr data-item-row>${cells(item)}<td><button type="button" class="pill" data-item-remove>删除</button></td></tr>`)
      .join("")}</tbody></table>
    <button type="button" class="pill" id="item-add">加一行</button>
  </div>
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
    ...spec.scalar.map((field) => row(field, requireLabel(kind, field), control(kind, field, record[field], spec))),
    ...(spec.json || []).map((field) => row(field, requireLabel(kind, field), control(kind, field, record[field], spec))),
  ].join("\n");

  // The wrapper mounts the element that carries `data-form-page`, so that element is the whole
  // `.wrap`: title, subtitle and panels travel together, exactly as they do on a card page.
  return pageHtml({
    title: `${spec.label} ${id}`,
    sub: `${badge}${esc(spec.label)} · id <code>${esc(String(id))}</code>`,
    extraCss: FORM_CSS,
    body: `<div class="panel">${fields}</div>
${spec.items ? itemsPanel(record[spec.items]) : ""}
<script type="application/json" id="form-values">${JSON.stringify({ version: 1, key, values: record }).replace(/</g, "\\u003c")}</script>`,
    wrapAttrs: `data-form-page="${esc(key)}"`,
    script: "",
  });
}
