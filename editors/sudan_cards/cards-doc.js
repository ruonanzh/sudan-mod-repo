/**
 * Reading and writing a mod's `config/cards.json` from inside the sandboxed editor page.
 *
 * A save must not cost the player their comments, their key order or a card the page never
 * showed. So the page never re-serialises the file: it asks `./jsonc.js` for the text span of
 * the one value that changed and replaces that span. `jsonc.js` is a byte-for-byte copy of
 * `tools/jsonc.mjs` (the app serves scripts only from the tool's own directory);
 * `script/editor-tool.test.mjs` fails if the two drift apart.
 */
import { parseDoc, findEntries, toPlain, valueOf, literal } from "./jsonc.js";

/** The last entry with this key. A repeated key means "append" to the game, so the last one wins. */
function lastNode(doc, path) {
  let node = doc.root;
  for (const step of path) {
    if (!node || node.type !== "object") return null;
    const entries = findEntries(node, step);
    if (!entries.length) return null;
    node = entries[entries.length - 1].value;
  }
  return node;
}

/**
 * The cards in a `cards.json` text, in file order: `[{ id, value }]`.
 * `value` is decoded to plain JS values; a card the table repeats is folded to its last copy.
 * A `_`-prefixed key is a comment the game ignores, not a card.
 */
export function readCards(text) {
  const doc = parseDoc(text);
  if (doc.root.type !== "object") throw new Error("cards.json 的最外层必须是一个以 id 为键的对象。");
  const cards = new Map();
  for (const entry of doc.root.entries) {
    if (entry.key.startsWith("_")) continue;
    cards.set(entry.key, toPlain(doc, entry.value));
  }
  return [...cards.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Write `changes` into `text` and return the new text.
 *
 * `changes` is `[{ id, fields }]`, where `fields` holds only the fields that differ from what
 * was read: `name`, `title`, `rare` (a number), and `tag` (`{ 标签名: 数字 }`). A field that
 * already holds that value is left alone, an id the file does not hold is skipped, and a key
 * the page does not edit is never touched.
 */
export function applyCardChanges(text, changes) {
  const doc = parseDoc(text);
  if (doc.root.type !== "object") throw new Error("cards.json 的最外层必须是一个以 id 为键的对象。");
  for (const change of changes || []) {
    const id = String(change?.id ?? "");
    const fields = change?.fields;
    if (!id || !fields || typeof fields !== "object") continue;
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (field === "tag") {
        for (const [name, level] of Object.entries(value || {})) {
          if (level !== undefined) writeValue(doc, [id, "tag", name], level);
        }
      } else {
        writeValue(doc, [id, field], value);
      }
    }
  }
  return doc.render();
}

/**
 * The changes between what was read and what the page shows: `[{ id, fields }]`, holding only
 * the fields that differ. Feeding this to `applyCardChanges` is what keeps a value the player
 * never touched out of the file — a rare written as `"2"` and a rare shown as `2` are the same
 * card, not an edit.
 */
export function changesBetween(loaded, current) {
  const before = new Map(loaded.map((card) => [card.id, card.value || {}]));
  const changes = [];
  for (const { id, value } of current) {
    const was = before.get(id);
    if (!was) continue;
    const fields = {};
    for (const field of ["name", "title"]) {
      // Both sides are text: a title the file leaves out and an empty input are the same card.
      const next = String(value[field] ?? "");
      if (next !== String(was[field] ?? "")) fields[field] = next;
    }
    const wasRare = was.rare == null ? undefined : Number(was.rare);
    if (value.rare !== wasRare) fields.rare = value.rare;
    const wasTag = was.tag && typeof was.tag === "object" ? was.tag : {};
    const tag = {};
    for (const [name, level] of Object.entries(value.tag || {})) {
      const old = wasTag[name];
      if (level !== (typeof old === "number" ? old : Number(old))) tag[name] = level;
    }
    if (Object.keys(tag).length) fields.tag = tag;
    if (Object.keys(fields).length) changes.push({ id, fields });
  }
  return changes;
}

/** Replace one value's span, or add the key when the card has never had it. */
function writeValue(doc, path, value) {
  const node = lastNode(doc, path);
  if (node) {
    if (valueOf(doc, node) === value) return;
    doc.set(node, literal(value));
    return;
  }
  const parent = lastNode(doc, path.slice(0, -1));
  if (!parent || parent.type !== "object") return;
  doc.append(parent, path[path.length - 1], literal(value));
}
