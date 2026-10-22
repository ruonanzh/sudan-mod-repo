/**
 * Editor tool for a mod's `config/cards.json`.
 *
 * Talks to the app over the postMessage bridge only (`editor:init`, `editor:readFile`,
 * `editor:save`, `editor:theme`): the iframe has no network and may read only the file it was
 * opened with. A save is built by `cards-doc.js`, which replaces the text span of each value
 * that changed, so comments, key order and every field this page does not show survive.
 */
import { readCards, applyCardChanges, changesBetween } from "./cards-doc.js";
import { validateCard, tagKind, TAG_STAT, RARE_MIN, RARE_MAX } from "./card-rules.js";

let writable = false;
let revision = null;
/** The text on disk, and the cards read from it. A save replaces `text` with what it wrote. */
let text = "";
let cards = [];
/** A read, parse or save failure. It sits above the button and keeps the save blocked. */
let fatal = "";
let seq = 0;
const pending = new Map();

const $ = (id) => document.getElementById(id);
const post = (message) => window.parent.postMessage(message, "*");

function request(type, payload) {
  const requestId = `r${++seq}`;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    post({ type, requestId, ...payload });
  });
}

function settle(requestId, value) {
  const resolve = pending.get(requestId);
  if (resolve) {
    pending.delete(requestId);
    resolve(value);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function labelled(labelText, keyName, control) {
  const label = el("label");
  label.append(el("span", { class: "label" }, el("span", { text: labelText }), el("code", { text: keyName })));
  label.append(control);
  return label;
}

function textInput(field, value) {
  return el("input", { type: "text", "data-field": field, autocomplete: "off", value: value == null ? "" : String(value) });
}

/** A rare outside 1–4 stays visible and selected, so the card it belongs to can be fixed. */
function rareSelect(raw) {
  const select = el("select", { "data-field": "rare" });
  if (raw === undefined) select.append(el("option", { value: "", text: "没写" }));
  else if (!(typeof raw === "number" && raw >= RARE_MIN && raw <= RARE_MAX)) {
    select.append(el("option", { value: String(raw), text: `${raw}（不在 ${RARE_MIN}–${RARE_MAX}）` }));
  }
  for (let v = RARE_MIN; v <= RARE_MAX; v++) select.append(el("option", { value: String(v), text: String(v) }));
  select.value = raw === undefined ? "" : String(raw);
  return select;
}

function tagRow(name, level) {
  const kind = tagKind(name);
  const row = el("label", { class: `tag ${kind}` });
  row.append(el("span", { class: "tag-name", text: name }));
  const input = el("input", { type: "number", "data-tag": name, value: String(level) });
  if (kind === "stat") {
    input.min = String(TAG_STAT[name].min);
    input.max = String(TAG_STAT[name].max);
  }
  if (kind === "marker") input.readOnly = true;
  row.append(input);
  row.append(
    el("span", {
      class: "tag-note",
      text:
        kind === "stat"
          ? `${TAG_STAT[name].min}–${TAG_STAT[name].max}`
          : kind === "marker"
            ? "标记：只能是 1"
            : "不在原版 tag 表",
    })
  );
  return row;
}

function cardSection({ id, value }) {
  const card = value && typeof value === "object" ? value : {};
  const section = el("section", { class: "card", "data-id": id });
  const head = el("header", { class: "card-head" });
  head.append(el("code", { class: "card-id", text: id }));
  head.append(el("span", { class: "badge", text: card.type == null ? "没写 type" : String(card.type) }));
  head.append(el("span", { class: "card-state" }));
  section.append(head);

  const names = el("div", { class: "row" });
  names.append(labelled("卡面名称", "name", textInput("name", card.name)));
  names.append(labelled("副标题", "title", textInput("title", card.title)));
  section.append(names);

  const rare = el("div", { class: "row" });
  rare.append(labelled("稀有度", "rare", rareSelect(card.rare)));
  rare.append(labelled("卡牌类型", "type", el("input", { type: "text", value: card.type == null ? "" : String(card.type), readOnly: true })));
  section.append(rare);

  const description = el("textarea", { class: "description", rows: "3", readonly: true });
  description.value = card.text == null ? "" : String(card.text);
  section.append(labelled("卡面描述", "text", description));

  const tag = card.tag && typeof card.tag === "object" && !Array.isArray(card.tag) ? card.tag : null;
  const tags = el("div", { class: "tags" }, el("span", { class: "label" }, el("span", { text: "初始标签" }), el("code", { text: "tag" })));
  if (tag) for (const [name, level] of Object.entries(tag)) tags.append(tagRow(name, level));
  else tags.append(el("span", { class: "note", text: "这张卡没有 tag。" }));
  section.append(tags);

  return section;
}

/** What the page currently shows, with every field the page does not edit carried over. */
function collect() {
  const current = [];
  for (const section of $("cards").querySelectorAll("section.card")) {
    const id = section.dataset.id;
    const loaded = cards.find((card) => card.id === id)?.value || {};
    const value = { ...loaded };
    value.name = section.querySelector('[data-field="name"]').value;
    value.title = section.querySelector('[data-field="title"]').value;
    const rare = section.querySelector('[data-field="rare"]').value;
    value.rare = rare === "" ? undefined : Number(rare);
    const tag = { ...(loaded.tag && typeof loaded.tag === "object" ? loaded.tag : {}) };
    for (const input of section.querySelectorAll("[data-tag]")) {
      const raw = input.value.trim();
      tag[input.dataset.tag] = raw === "" ? Number.NaN : Number(raw);
    }
    value.tag = tag;
    current.push({ id, value });
  }
  return current;
}

function issuesOf(current) {
  const errors = [];
  const warnings = [];
  const perCard = new Map();
  for (const { id, value } of current) {
    const found = validateCard(id, value);
    if (found.errors.length) perCard.set(id, found.errors.length);
    errors.push(...found.errors);
    warnings.push(...found.warnings);
  }
  return { errors, warnings, perCard };
}

function paint() {
  const current = collect();
  const changes = changesBetween(cards, current);
  const { errors, warnings, perCard } = issuesOf(current);

  const items = [];
  if (fatal) items.push(el("li", { class: "error", text: fatal }));
  for (const message of errors) items.push(el("li", { class: "error", text: message }));
  for (const message of warnings) items.push(el("li", { class: "warn", text: message }));
  const list = $("issues");
  list.replaceChildren(...items);
  list.hidden = items.length === 0;

  for (const section of $("cards").querySelectorAll("section.card")) {
    const count = perCard.get(section.dataset.id) || 0;
    section.dataset.state = count ? "error" : "";
    section.querySelector(".card-state").textContent = count ? `${count} 处错误` : "";
  }

  const blocked = Boolean(fatal) || errors.length > 0;
  const status = $("status");
  status.dataset.state = !writable ? "readonly" : blocked ? "error" : changes.length ? "dirty" : "clean";
  status.textContent = !writable
    ? "只读"
    : blocked
      ? "有错误，不能保存"
      : changes.length
        ? "未保存（Ctrl+S）"
        : "已保存";
  $("save").disabled = !writable || blocked || changes.length === 0;
}

function render() {
  const container = $("cards");
  container.replaceChildren(...cards.map(cardSection));
  if (!cards.length && !fatal) container.append(el("p", { class: "note", text: "这个 cards.json 里没有卡。" }));
  if (!writable) {
    for (const control of container.querySelectorAll("input, select, textarea")) control.disabled = true;
  }
  paint();
}

async function load() {
  const response = await request("editor:readFile", {});
  if (response.code) {
    cards = [];
    fatal = `读不到这个文件：${response.message || response.code}`;
    render();
    return;
  }
  revision = response.revision ?? null;
  text = typeof response.data === "string" ? response.data : "";
  fatal = "";
  try {
    cards = readCards(text);
  } catch (error) {
    cards = [];
    fatal = `这个文件读不懂：${error.message}`;
  }
  render();
}

async function save() {
  if (!writable) return;
  const current = collect();
  const changes = changesBetween(cards, current);
  if (!changes.length || issuesOf(current).errors.length || fatal) {
    paint();
    return;
  }
  let next;
  try {
    next = applyCardChanges(text, changes);
  } catch (error) {
    fatal = `写回失败：${error.message}`;
    paint();
    return;
  }
  if (next === text) {
    paint();
    return;
  }
  const response = await request("editor:save", { data: next, baseRevision: revision ?? undefined });
  if (response.code) {
    fatal =
      response.code === "CONFLICT"
        ? "文件在别处被改过。先点「重新读取」，否则会盖掉别人的改动。"
        : `保存失败：${response.message || response.code}`;
    paint();
    return;
  }
  revision = response.revision ?? revision;
  text = next;
  fatal = "";
  cards = readCards(text);
  render();
}

window.addEventListener("message", (event) => {
  const data = event.data || {};
  switch (data.type) {
    case "editor:init":
      writable = data.mode === "edit" && Boolean(data.writable);
      $("file").textContent = (data.file && data.file.name) || "cards.json";
      applyTheme(data.theme);
      void load();
      break;
    case "editor:fileContent":
    case "editor:saved":
    case "editor:error":
      settle(data.requestId, data);
      break;
    case "editor:theme":
      applyTheme(data.theme);
      break;
    default:
      break;
  }
});

$("cards").addEventListener("input", () => paint());
$("cards").addEventListener("change", () => paint());
$("reload").addEventListener("click", () => void load());
$("save").addEventListener("click", () => void save());
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
});
