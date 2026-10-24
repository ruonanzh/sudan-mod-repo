/**
 * jsonc.mjs — read and edit the game's config files without destroying them.
 *
 * The game's JSON is not plain JSON: it has `//` and block comments, a BOM, trailing
 * commas, and repeated keys that mean "append" rather than "overwrite". A
 * JSON.parse / JSON.stringify round trip destroys all four, so an editor must never
 * do one. This module parses to a tree of byte offsets and applies surgical span
 * edits, which leaves every byte it did not touch exactly as it was.
 *
 *   const doc = parseDoc(text);
 *   const action = getDoc(doc, ["settlement", 0, "action"]);
 *   doc.set(action, literal('"counter+7000001": 1'));   // replace a node
 *   doc.append(action, "event_on", "5300123");          // add, keeping repeats
 *   doc.render();                                       // text with those two edits
 *
 * A duplicate key is created by appending the same key twice. That is the correct
 * way to make the game run two operations, and it is why `append` exists next to
 * `set`.
 */

const WS = new Set([" ", "\t", "\r", "\n"]);

class Doc {
  constructor(text, bom) {
    this.text = text;
    this.bom = Boolean(bom);
    this.root = parseValue(this, skipWs(this, 0));
  }

  /**
   * Apply one edit immediately, then re-parse. Immediate application keeps node offsets
   * valid for the next call, which matters because an editor chains several edits on the
   * same record. The files here are at most a couple of megabytes, so re-parsing is cheap.
   */
  applyEdit(edits) {
    const list = Array.isArray(edits) ? edits : [edits];
    const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
    let out = "";
    let cursor = 0;
    for (const e of sorted) {
      if (e.start < cursor) throw new Error(`applyEdit: overlapping edit at ${e.start}`);
      out += this.text.slice(cursor, e.start) + e.text;
      cursor = e.end;
    }
    this.text = out + this.text.slice(cursor);
    this.root = parseValue(this, skipWs(this, 0));
  }

  /** Replace one node wholesale with literal source text. */
  set(node, literalText) {
    if (!node) throw new Error("set: no node");
    this.applyEdit({ start: node.start, end: node.end, text: literalText });
    return this;
  }

  /**
   * Add `key: value` to an object. If the key already exists, this creates a second
   * entry with the same key, which the game reads as a second operation.
   */
  append(objNode, key, literalText) {
    if (!objNode || objNode.type !== "object") throw new Error("append: not an object");
    const t = this.text;
    const close = objNode.closeBrace;
    const last = objNode.entries[objNode.entries.length - 1];

    if (!last) {
      // An empty nested object stays on one line; an empty file gets a real body.
      const at = objNode.openBrace + 1;
      const text =
        objNode === this.root
          ? `\n    ${JSON.stringify(key)}: ${literalText}\n`
          : `${JSON.stringify(key)}: ${literalText}`;
      this.applyEdit({ start: at, end: at, text });
      return this;
    }

    const indent = this.entryIndent(objNode);
    // A trailing line comment belongs to the last entry's line. The separator comma
    // must go before it, or the comma is swallowed by the comment.
    const after = skipWs(this, last.value.end);
    const edits = [];
    if (t[after] !== ",") edits.push({ start: last.value.end, end: last.value.end, text: "," });
    // Insert the new entry on its own line, after the line the last entry ends on.
    const nl = t.indexOf("\n", last.value.end);
    const at = nl === -1 || nl > close ? close : nl + 1;
    const prefix = nl === -1 || nl > close ? `\n${indent}` : indent;
    edits.push({ start: at, end: at, text: `${prefix}${JSON.stringify(key)}: ${literalText}\n` });
    this.applyEdit(edits);
    return this;
  }

  /**
   * Add an entry from raw source text, `"key": value` where value is already valid JSONC.
   * Used to copy a vanilla record across without re-serialising it.
   */
  appendSource(key, entrySource) {
    if (this.root.type !== "object") throw new Error("appendSource: root is not an object");
    const last = this.root.entries[this.root.entries.length - 1];
    const indent = this.entryIndent(this.root);
    if (!last) {
      this.applyEdit({ start: this.root.openBrace + 1, end: this.root.openBrace + 1, text: `\n${indent}${entrySource}\n` });
      return this;
    }
    const nl = this.text.indexOf("\n", last.value.end);
    const at = nl === -1 || nl > this.root.closeBrace ? this.root.closeBrace : nl + 1;
    // JSONC allows a trailing comma after the last entry. When the file already has one, adding
    // another produces `,,` — a file the game cannot read. Look at what sits between the value
    // and the insertion point: a comma there means "already separated".
    const between = this.text.slice(last.value.end, at);
    const hasComma = /,/.test(between.replace(/\/\/[^\n]*/g, ""));
    const edits = [];
    if (!hasComma) edits.push({ start: last.value.end, end: last.value.end, text: "," });
    edits.push({ start: at, end: at, text: `${indent}${entrySource}\n` });
    this.applyEdit(edits);
    return this;
  }

  /** Remove the first entry with this key. */
  remove(objNode, key) {
    const entry = findEntry(objNode, key);
    if (!entry) return this;
    let start = entry.keyStart;
    let end = entry.value.end;
    // Take the trailing comma with it, or the leading comma if it was last.
    let i = end;
    while (i < this.text.length && WS.has(this.text[i])) i++;
    if (this.text[i] === ",") {
      end = i + 1;
    } else {
      // Last entry: take the comma that precedes it instead.
      let j = start - 1;
      while (j >= 0 && WS.has(this.text[j])) j--;
      if (this.text[j] === ",") start = j;
    }
    // Take the whitespace and the newline that precede the entry, so no blank line is left.
    let k = start - 1;
    while (k >= 0 && (this.text[k] === " " || this.text[k] === "\t" || this.text[k] === "\r")) k--;
    if (this.text[k] === "\n") start = k;
    this.applyEdit({ start, end, text: "" });
    return this;
  }

  /** The indentation an existing entry uses, so an append matches the file's style. */
  entryIndent(objNode) {
    const first = objNode.entries[0];
    if (!first) return "    ";
    const lineStart = this.text.lastIndexOf("\n", first.keyStart) + 1;
    const lead = this.text.slice(lineStart, first.keyStart);
    return /^[ \t]*$/.test(lead) ? lead : "    ";
  }

  /** Apply the pending edits. Edits must not overlap. */
  render() {
    return (this.bom ? "\ufeff" : "") + this.text;
  }
}

function skipWs(doc, i) {
  const t = doc.text;
  for (;;) {
    while (i < t.length && WS.has(t[i])) i++;
    if (t[i] === "/" && t[i + 1] === "/") {
      while (i < t.length && t[i] !== "\n") i++;
      continue;
    }
    if (t[i] === "/" && t[i + 1] === "*") {
      i += 2;
      while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    return i;
  }
}

function parseString(doc, i) {
  const t = doc.text;
  let j = i + 1;
  while (j < t.length) {
    if (t[j] === "\\") j += 2;
    else if (t[j] === '"') return { type: "string", start: i, end: j + 1, value: JSON.parse(t.slice(i, j + 1)) };
    else j++;
  }
  throw new Error(`unterminated string at ${i}`);
}

function parseValue(doc, i) {
  const t = doc.text;
  const start = i;
  const c = t[i];
  if (c === "{") {
    const node = { type: "object", start, end: 0, openBrace: i, closeBrace: 0, entries: [] };
    let j = skipWs(doc, i + 1);
    if (t[j] === "}") {
      node.closeBrace = j;
      node.end = j + 1;
      return node;
    }
    for (;;) {
      j = skipWs(doc, j);
      if (t[j] !== '"') throw new Error(`expected key at ${j}`);
      const keyNode = parseString(doc, j);
      const keyStart = j;
      j = skipWs(doc, keyNode.end);
      if (t[j] !== ":") throw new Error(`expected : at ${j}`);
      const value = parseValue(doc, skipWs(doc, j + 1));
      node.entries.push({ key: keyNode.value, keyStart, keyEnd: keyNode.end, value });
      j = skipWs(doc, value.end);
      if (t[j] === ",") {
        j++;
        if (t[skipWs(doc, j)] === "}") {
          j = skipWs(doc, j);
          break;
        }
        continue;
      }
      break;
    }
    if (t[j] !== "}") throw new Error(`expected } at ${j}`);
    node.closeBrace = j;
    node.end = j + 1;
    return node;
  }
  if (c === "[") {
    const node = { type: "array", start, end: 0, items: [] };
    let j = skipWs(doc, i + 1);
    if (t[j] === "]") {
      node.end = j + 1;
      return node;
    }
    for (;;) {
      const value = parseValue(doc, skipWs(doc, j));
      node.items.push(value);
      j = skipWs(doc, value.end);
      if (t[j] === ",") {
        j++;
        if (t[skipWs(doc, j)] === "]") {
          j = skipWs(doc, j);
          break;
        }
        continue;
      }
      break;
    }
    if (t[j] !== "]") throw new Error(`expected ] at ${j}`);
    node.end = j + 1;
    return node;
  }
  if (c === '"') return parseString(doc, i);
  const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(start, start + 40));
  if (!m) throw new Error(`unexpected ${JSON.stringify(c)} at ${start}`);
  return { type: "scalar", start, end: start + m[0].length };
}

/** Parse text (BOM tolerated) into an editable document. */
export function parseDoc(text) {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  return new Doc(hasBom ? text.slice(1) : text, hasBom);
}

/** Follow a path of keys and indexes. Returns null when the path does not exist. */
export function getDoc(doc, path) {
  let node = doc.root;
  for (const step of path) {
    if (node === null || node === undefined) return null;
    if (typeof step === "number") {
      if (node.type !== "array" || step < 0 || step >= node.items.length) return null;
      node = node.items[step];
    } else {
      const entry = node.type === "object" ? findEntry(node, step) : null;
      if (!entry) return null;
      node = entry.value;
    }
  }
  return node;
}

export function findEntry(objNode, key) {
  if (!objNode || objNode.type !== "object") return null;
  return objNode.entries.find((e) => e.key === key) || null;
}

/** All entries with this key, in file order. Repeated keys are how the game appends. */
export function findEntries(objNode, key) {
  if (!objNode || objNode.type !== "object") return [];
  return objNode.entries.filter((e) => e.key === key);
}

/** Read a node's own source text. */
export function sourceOf(doc, node) {
  return node ? doc.text.slice(node.start, node.end) : null;
}

/** Decode a scalar or string node to a JS value; objects and arrays return their source. */
export function valueOf(doc, node) {
  if (!node) return undefined;
  if (node.type === "string") return JSON.parse(doc.text.slice(node.start, node.end));
  if (node.type === "scalar") {
    const raw = doc.text.slice(node.start, node.end);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null") return null;
    return Number(raw);
  }
  return doc.text.slice(node.start, node.end);
}

/**
 * Decode a node fully into plain JS values. A repeated key keeps the last value, which is
 * fine for display; use findEntries when the repeats matter.
 */
export function toPlain(doc, node) {
  if (!node) return undefined;
  if (node.type === "object") {
    const out = {};
    for (const e of node.entries) out[e.key] = toPlain(doc, e.value);
    return out;
  }
  if (node.type === "array") return node.items.map((n) => toPlain(doc, n));
  return valueOf(doc, node);
}

/** Build a literal for a plain JS value. Strings are quoted; objects become compact JSON. */
export function literal(value) {
  return JSON.stringify(value);
}

export default { parseDoc, getDoc, findEntry, findEntries, sourceOf, valueOf, toPlain, literal };
