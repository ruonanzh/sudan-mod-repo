/**
 * Editable pages for records whose fields are few and fixed: a loot table, a fate-shop entry.
 *
 * The page looks like the card page and behaves like it too: rows of "key + label + note", a
 * control per field, and one button that hands the change to the agent. The difference is where
 * the values go. A card page lives inside the app editor and saves into its own JSON block; these
 * pages are plain HTML previews, so they send the changed values in the message instead.
 */
import { esc, pageHtml } from "../lib/shell.mjs";
import { requireLabel } from "../lib/labels.mjs";

/** The fields each kind shows, in the order the page prints them. `id` is read-only. */
export const FORM_FIELDS = {
  loot: {
    label: "战利品表",
    scalar: ["repeat", "type", "name"],
    selects: { type: [["2", "2 · 简单权重"], ["3", "3 · 权重取出 m 份"], ["4", "4 · 加权无放回"], ["99", "99 · 全部给"]] },
    items: "item",
  },
  upgrade: {
    label: "命运商店",
    scalar: ["name", "text", "cost", "icon", "link_card"],
    textarea: ["condition", "effect", "incompatible"],
  },
};

/** The item row shape a loot table repeats. */
const ITEM_FIELDS = ["type", "id", "num", "weight", "condition"];

const show = (value) => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

/** One labelled row: the control is the only thing named; the text beside it says what it is. */
function row(kind, key, control) {
  const info = requireLabel(kind, key);
  return `<div class="row" data-key="${esc(key)}">
  <code>${esc(key)}</code>
  <div class="lbl">${esc(info.label)}<span class="note">${esc(info.note)}</span></div>
  ${control}
</div>`;
}

function control(kind, key, value, spec) {
  const options = spec?.selects?.[key];
  if (options) {
    const current = String(value ?? options[0][0]);
    return `<select data-form="${esc(key)}">${options
      .map(([v, text]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(text)}</option>`)
      .join("")}</select>`;
  }
  if (spec?.textarea?.includes(key) || (value !== null && typeof value === "object")) {
    return `<textarea data-form="${esc(key)}" rows="4" spellcheck="false">${esc(show(value))}</textarea>`;
  }
  const numeric = typeof value === "number" || ["repeat", "cost"].includes(key);
  return `<input data-form="${esc(key)}" type="${numeric ? "number" : "text"}" value="${esc(show(value))}">`;
}

/** The loot table's repeated rows: a small table, one row per entry. */
function itemRows(value) {
  const rows = Array.isArray(value) ? value : [];
  const cells = (item, i) =>
    ITEM_FIELDS.map((key) => {
      const v = item?.[key];
      const numeric = key === "id" || key === "num" || key === "weight";
      const input =
        key === "type"
          ? `<select data-item="${esc(key)}">${["2", "3", "99", "4"]
              .map((t) => `<option value="${t}"${String(v ?? 2) === t ? " selected" : ""}>${t}</option>`)
              .join("")}</select>`
          : `<input data-item="${esc(key)}" type="${numeric ? "number" : "text"}" value="${esc(show(v))}">`;
      return `<td>${input}</td>`;
    }).join("");
  return `<h2>放什么（item）</h2>
<p class="note" style="margin-top:0">一行就是一件东西。加一行、删一行都可以，顺序就是抽取顺序。</p>
<table class="items"><thead><tr>${ITEM_FIELDS.map((k) => `<th>${esc(k)}</th>`).join("")}<th></th></tr></thead>
<tbody id="item-rows">${rows
    .map((item, i) => `<tr data-item-row>${cells(item, i)}<td><button type="button" class="pill" data-item-remove>删除</button></td></tr>`)
    .join("")}</tbody></table>
<button type="button" class="pill" id="item-add">加一行</button>`;
}

export function formPageHtml({ kind, id, record = {}, origin = "new", recordKey = null }) {
  const spec = FORM_FIELDS[kind];
  if (!spec) throw new Error(`no form page for ${kind}`);
  const badge = origin === "override"
    ? '<span class="origin override">覆盖原版</span>'
    : '<span class="origin">新增</span>';
  const body = [
    row(kind, "id", `<div class="readonly">${esc(String(id))}</div>`),
    ...spec.scalar.map((key) => row(kind, key, control(kind, key, record[key], spec))),
    ...(spec.textarea || []).map((key) => row(kind, key, control(kind, key, record[key], spec))),
    spec.items ? itemRows(record[spec.items]) : "",
  ].join("\n");

  return pageHtml({
    title: `${spec.label} ${id}`,
    sub: `${badge}${esc(spec.label)} · id <code>${esc(String(id))}</code>`,
    body: `<div data-form-page="${esc(kind)}:${esc(id)}">${body}
<h2>改完了</h2>
<p class="note" style="margin-top:0">点下面这个按钮，把改动交给 agent：它会写回这条记录，再重新生成这一页。</p>
<div class="savebar"><button class="exp" id="form-send" type="button" disabled>发送给 Agent</button><span class="note" id="form-status"></span></div>
</div>
<script type="application/json" id="form-initial">${JSON.stringify({ kind, id, recordKey, values: record }).replace(/</g, "\\u003c")}</script>
<script src="form-page.js"></script>`,
    script: "",
  });
}

/** The page's behaviour, written beside the pages so the preview's CSP (no inline scripts) holds. */
export function formPageScript() {
  return `(function () {
  var root = document.querySelector("[data-form-page]");
  var initialEl = document.getElementById("form-initial");
  var send = document.getElementById("form-send");
  var status = document.getElementById("form-status");
  if (!root || !initialEl || !send) return;
  var initial = JSON.parse(initialEl.textContent || "{}");
  var kind = initial.kind;
  var id = initial.id;
  var recordKey = initial.recordKey || kind + ":" + id;

  function say(text) { if (status) status.textContent = text; }

  function scalarInputs() { return [].slice.call(root.querySelectorAll("[data-form]")); }

  function itemRowsNow() {
    return [].slice.call(root.querySelectorAll("[data-item-row]")).map(function (tr) {
      var item = {};
      [].slice.call(tr.querySelectorAll("[data-item]")).forEach(function (el) {
        var key = el.getAttribute("data-item");
        var v = String(el.value || "").trim();
        if (v === "") return;
        if (key === "id" || key === "num" || key === "weight") item[key] = Number(v);
        else if (key === "type") item[key] = Number(v);
        else item[key] = v;
      });
      return item;
    });
  }

  function collect() {
    var values = {};
    scalarInputs().forEach(function (el) {
      var key = el.getAttribute("data-form");
      var v = String(el.value || "").trim();
      if (v === "") return;
      if (el.tagName === "TEXTAREA") {
        try { values[key] = JSON.parse(v); } catch (e) { throw new Error(key + " 不是合法 JSON：" + e.message); }
      } else if (el.type === "number") values[key] = Number(v);
      else if (el.tagName === "SELECT" && /^[0-9]+$/.test(v)) values[key] = Number(v);
      else values[key] = v;
    });
    if (root.querySelector("[data-item-row]")) values.item = itemRowsNow();
    return values;
  }

  function wire() {
    var add = document.getElementById("item-add");
    if (add) add.addEventListener("click", function () {
      var body = document.getElementById("item-rows");
      if (!body) return;
      var last = body.querySelector("[data-item-row]");
      var tr = last.cloneNode(true);
      [].slice.call(tr.querySelectorAll("input")).forEach(function (i) { i.value = ""; });
      body.appendChild(tr);
      wireRemove(tr);
      say("");
    });
    [].slice.call(root.querySelectorAll("[data-item-row]")).forEach(wireRemove);
  }

  function wireRemove(tr) {
    var btn = tr.querySelector("[data-item-remove]");
    if (!btn) return;
    btn.onclick = function () { tr.parentNode.removeChild(tr); say(""); };
  }

  send.disabled = false;
  wire();
  send.addEventListener("click", function () {
    var values;
    try { values = collect(); } catch (e) { say(e.message); return; }
    var changed = {};
    Object.keys(values).forEach(function (k) {
      if (JSON.stringify(values[k]) !== JSON.stringify(initial.values ? initial.values[k] : undefined)) changed[k] = values[k];
    });
    if (!Object.keys(changed).length) { say("还没有改动。"); return; }
    if (!(window.parent && window.parent !== window)) { say("要在应用里打开这一页，才能发给 agent。"); return; }
    send.disabled = true;
    say("已发送，等 agent 回话…");
    window.parent.postMessage({
      type: "pi:preview-prompt",
      text: "/page-edited " + recordKey + "\\n改动：" + JSON.stringify(changed),
    }, "*");
  });

  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || d.type !== "pi:preview-prompt-result") return;
    send.disabled = false;
    say(d.ok ? "已通知 agent，它按这些值写回记录并重新生成这一页。" : "没发出去（" + (d.code || "?") + "）：到对话里说。");
  });
})();
`;
}
