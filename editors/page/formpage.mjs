/**
 * Editable pages for records whose fields are few and fixed: a loot table, a fate-shop entry.
 *
 * The page is static. It carries every control in the markup and the current values in one JSON
 * block at the end; the app's editor wrapper (editors/form/) mounts the page, reads the block,
 * writes the player's values back into it, and sends the change to the agent. Nothing runs in the
 * page itself, so opening it from disk only shows what the record says.
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
    scalar: ["name", "text", "cost", "icon", "link_card"],
    numbers: ["cost", "link_card"],
    json: ["condition", "effect", "incompatible"],
  },
};

/** The item row shape a loot table repeats. */
const ITEM_FIELDS = ["type", "id", "num", "weight", "condition"];
const ITEM_NUMBERS = ["id", "num", "weight", "type"];

const show = (value) => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

const CSS = `.srow { padding: 10px 0; border-bottom: 1px dotted #3c3227; }
.srow:last-of-type { border-bottom: 0; }
.srow .top { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.srow .top code { min-width: 92px; }
.srow .top .lbl { font-weight: 600; }
.srow .top .note { margin-top: 0; }
.srow .full { margin-top: 7px; }
.srow .full input[type="text"], .srow .full input[type="number"], .srow .full select, .srow .full textarea { width: 100%; box-sizing: border-box; }
table.items { width: 100%; border-collapse: collapse; margin-top: 8px; }
table.items th { text-align: left; font-weight: 600; font-size: 12.5px; color: var(--dim); padding: 4px 6px; }
table.items td { padding: 4px 6px; }
table.items input, table.items select { width: 100%; box-sizing: border-box; }
.readonly { font-family: ui-monospace, monospace; color: var(--dim); }
.only-host { color: var(--dim); font-size: 13px; margin-top: 14px; }`;

/** One labelled row: name and label on the first line, the whole control on the next. */
function row(key, info, control, note) {
  return `<div class="srow" data-key="${esc(key)}">
  <div class="top"><code>${esc(key)}</code><span class="lbl">${esc(info.label)}</span><span class="note">${esc(info.note)}</span></div>
  <div class="full">${control}</div>${note ? `\n  <div class="note">${note}</div>` : ""}
</div>`;
}

function control(kind, key, value, spec) {
  const options = spec?.selects?.[key];
  if (options) {
    const current = String(value ?? options[0][0]);
    return `<select data-form="${esc(key)}" data-kind="number">${options
      .map(([v, text]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(text)}</option>`)
      .join("")}</select>`;
  }
  if (spec?.json?.includes(key) || (value !== null && typeof value === "object")) {
    return `<textarea data-form="${esc(key)}" data-kind="json" rows="3" spellcheck="false">${esc(show(value))}</textarea>`;
  }
  const numeric = spec?.numbers?.includes(key) || typeof value === "number";
  return `<input data-form="${esc(key)}" data-kind="${numeric ? "number" : "text"}" type="${numeric ? "number" : "text"}" value="${esc(show(value))}">`;
}

/** The loot table's repeated rows: a small table, one row per entry. */
function itemRows(value) {
  const rows = Array.isArray(value) ? value : [];
  const cells = (item) =>
    ITEM_FIELDS.map((key) => {
      const v = item?.[key];
      const input =
        key === "type"
          ? `<select data-item="${esc(key)}" data-kind="number">${["2", "3", "99", "4"]
              .map((t) => `<option value="${t}"${String(v ?? 2) === t ? " selected" : ""}>${t}</option>`)
              .join("")}</select>`
          : `<input data-item="${esc(key)}" data-kind="${ITEM_NUMBERS.includes(key) ? "number" : "text"}" type="${ITEM_NUMBERS.includes(key) ? "number" : "text"}" value="${esc(show(v))}">`;
      return `<td>${input}</td>`;
    }).join("");
  return `<div class="srow" data-items>
  <div class="top"><code>item</code><span class="lbl">放什么</span><span class="note">一行就是一件东西。加一行、删一行都可以，顺序就是抽取顺序。</span></div>
  <div class="full">
    <table class="items"><thead><tr>${ITEM_FIELDS.map((k) => `<th>${esc(k)}</th>`).join("")}<th></th></tr></thead>
    <tbody id="item-rows">${rows
      .map((item) => `<tr data-item-row>${cells(item)}<td><button type="button" class="pill" data-item-remove>删除</button></td></tr>`)
      .join("")}</tbody></table>
    <button type="button" class="pill" id="item-add">加一行</button>
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
  const body = [
    row("id", requireLabel(kind, "id"), `<div class="readonly">${esc(String(id))}</div>`),
    ...spec.scalar.map((field) => row(field, requireLabel(kind, field), control(kind, field, record[field], spec))),
    ...(spec.json || []).map((field) => row(field, requireLabel(kind, field), control(kind, field, record[field], spec))),
    spec.items ? itemRows(record[spec.items]) : "",
  ].join("\n");

  return pageHtml({
    title: `${spec.label} ${id}`,
    sub: `${badge}${esc(spec.label)} · id <code>${esc(String(id))}</code>`,
    extraCss: CSS,
    body: `<div data-form-page="${esc(key)}">${body}
<p class="only-host" id="card-no-host">在应用里打开这一页才能编辑：保存会写回这条记录，发送会把改动交给 agent。</p>
<script type="application/json" id="form-values">${JSON.stringify({ version: 1, key, values: record }).replace(/</g, "\\u003c")}</script>
</div>`,
    script: "",
  });
}
