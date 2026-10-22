/**
 * model.mjs — read and write one record at a time, against the schema.
 *
 * Every editor goes through here so that nothing can be saved in a state the
 * validator would reject. Reads keep the file's own text; writes go through
 * jsonc.mjs, so comments, ordering, trailing commas and repeated keys survive.
 *
 *   const mod = openMod("your_mods/my_mod");
 *   mod.add("card", { id: 2100900, name: "流浪的佣兵团", type: "item", rare: 4 });
 *   mod.set("card", 2100900, ["tag"], '{"体魄": 2}');
 *   mod.save();
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseDoc, getDoc, findEntry, findEntries, valueOf, literal } from "./jsonc.mjs";
import { resolveVanilla } from "./paths.mjs";

const here = (p) => new URL(p, import.meta.url);
const LAYOUT = JSON.parse(readFileSync(here("../schema/layout.json"), "utf8"));
const FIELDS = JSON.parse(readFileSync(here("../schema/fields.json"), "utf8"));

/**
 * The vanilla config on THIS machine, resolved by paths.mjs: an explicit argument, then
 * `.gamer-agent.local.json`, then discovery. It is null when none of those holds a verified
 * config, and a tool that needs the config must then print a FAIL line instead of rendering
 * an empty result.
 */
export const DEFAULT_VANILLA = resolveVanilla();

const expand = (p) => (p === null || p === undefined ? null : String(p).replace(/^~/, os.homedir()));

/** Thrown for a caller mistake. The CLI turns this into a FAIL line plus a NEXT line. */
export class ModelError extends Error {}

/** Locate a kind: table file, directory, or single file. */
export function locate(kind) {
  if (LAYOUT.table[kind]) return { style: "table", ...LAYOUT.table[kind] };
  if (LAYOUT.dir[kind]) return { style: "dir", ...LAYOUT.dir[kind] };
  if (LAYOUT.single[kind]) return { style: "single", ...LAYOUT.single[kind] };
  throw new ModelError(`unknown kind ${JSON.stringify(kind)}; expected one of ${Object.keys(LAYOUT.table).concat(Object.keys(LAYOUT.dir), Object.keys(LAYOUT.single)).join(", ")}`);
}

/** The id a kind uses as its key, and whether the record repeats it inside itself. */
function keyField(kind) {
  const where = locate(kind);
  if (where.keyOf === "code") return "code";
  if (where.keyOf === "dictionary key only") return null;
  return "id";
}

class Mod {
  constructor(dir, vanillaDir) {
    this.dir = expand(dir);
    this.vanillaDir = expand(vanillaDir);
    this.docs = new Map(); // absolute path -> Doc
    this.created = [];
  }

  // -- file access -------------------------------------------------------
  pathFor(kind, id) {
    const where = locate(kind);
    if (where.style === "table" || where.style === "single") return path.join(this.dir, where.file);
    if (where.style === "dir") {
      if (id === undefined) throw new ModelError(`${kind} needs an id to name its file`);
      const name = where.filename ? `${id}.json` : `${id}.json`;
      return path.join(this.dir, where.dir, name);
    }
    throw new ModelError(`unreachable: ${where.style}`);
  }

  /**
   * A document this mod owns and may write. If the mod has no file for the kind we start
   * from an EMPTY object — copying the vanilla file in would ship all 1294 vanilla cards
   * and freeze the game's data at the moment the mod was made.
   */
  docForWrite(kind, id) {
    const target = this.pathFor(kind, id);
    if (this.docs.has(target)) return this.docs.get(target);
    const text = existsSync(target) ? readFileSync(target, "utf8") : "{}\n";
    const doc = parseDoc(text);
    this.docs.set(target, doc);
    return doc;
  }

  /** A document used only for reading. Vanilla is never registered for saving. */
  docForRead(kind, id) {
    const target = this.pathFor(kind, id);
    if (this.docs.has(target)) return this.docs.get(target);
    if (existsSync(target)) {
      // The mod owns this file, so cache it: the caller may edit it and save.
      const doc = parseDoc(readFileSync(target, "utf8"));
      this.docs.set(target, doc);
      return doc;
    }
    const vanilla = this.vanillaPathFor(kind, id);
    if (vanilla && existsSync(vanilla)) return parseDoc(readFileSync(vanilla, "utf8"));
    return null;
  }

  vanillaPathFor(kind, id) {
    if (!this.vanillaDir) return null;
    const where = locate(kind);
    if (where.style === "dir") return path.join(this.vanillaDir, where.dir.replace(/^config\//, ""), `${id}.json`);
    return path.join(this.vanillaDir, (where.file || "").replace(/^config\//, ""));
  }

  // -- records -----------------------------------------------------------
  /** Read one record as plain JS values (objects and arrays keep their source text). */
  get(kind, id) {
    const where = locate(kind);
    const doc = this.docForRead(kind, id);
    if (!doc) return null;
    if (where.style === "dir") return { doc, node: doc.root, fields: readFields(doc, doc.root) };
    const entry = findEntry(doc.root, String(id));
    if (!entry) return null;
    return { doc, node: entry.value, fields: readFields(doc, entry.value) };
  }

  /** All ids present in the mod (not vanilla). */
  ids(kind) {
    const where = locate(kind);
    const out = [];
    if (where.style === "dir") {
      const dir = path.join(this.dir, where.dir);
      if (!existsSync(dir)) return out;
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".json")) out.push(name.replace(/\.json$/, ""));
      }
      return out;
    }
    const doc = this.docForRead(kind);
    if (!doc || doc.root.type !== "object") return out;
    return doc.root.entries.map((e) => e.key).filter((k) => !k.startsWith("_"));
  }

  /**
   * Make sure the writable document holds this record. When the mod does not carry it yet,
   * copy the vanilla entry's own source text across, so the override ships exactly one
   * record and every byte of it is the shipped one.
   */
  ensureEntry(doc, kind, id) {
    const existing = findEntry(doc.root, String(id));
    if (existing) return existing.value;
    const vanilla = this.vanillaPathFor(kind, id);
    if (!vanilla || !existsSync(vanilla)) return null;
    const vdoc = parseDoc(readFileSync(vanilla, "utf8"));
    const ventry = findEntry(vdoc.root, String(id));
    if (!ventry) return null;
    const text = vdoc.text.slice(ventry.keyStart, ventry.value.end);
    doc.appendSource(String(id), text);
    return findEntry(doc.root, String(id)).value;
  }

  /**
   * Add a record. For a table this appends a key; for a directory this creates the file.
   * An existing id is refused unless `replace` is set, because silently overwriting a
   * vanilla record is the expensive mistake.
   */
  add(kind, record, { replace = false } = {}) {
    const where = locate(kind);
    const keyName = keyField(kind);
    const id = keyName ? record[keyName] : record.id;
    if (id === undefined || id === null) throw new ModelError(`${kind} record needs ${keyName || "id"}`);
    validateRecord(kind, record);

    if (where.style === "dir") {
      const target = this.pathFor(kind, id);
      if (existsSync(target) && !replace) throw new ModelError(`${path.relative(this.dir, target)} already exists; pass --replace`);
      const text = JSON.stringify(record, null, 4) + "\n";
      this.docs.set(target, parseDoc(text));
      this.created.push(target);
      return target;
    }

    const doc = this.docForWrite(kind, id);
    if (findEntry(doc.root, String(id)) && !replace)
      throw new ModelError(`${kind} ${id} already exists in ${where.file}; pass --replace`);
    if (where.style === "table" && where.keyOf === "dictionary key only") {
      // over.json records carry no id of their own.
      doc.append(doc.root, String(id), JSON.stringify(record, null, 4).replace(/\n/g, "\n    "));
    } else {
      doc.append(doc.root, String(id), JSON.stringify(record, null, 4).replace(/\n/g, "\n    "));
    }
    return path.join(this.dir, where.file);
  }

  /** Replace the node at `fieldPath` with a literal. */
  set(kind, id, fieldPath, value) {
    const doc = this.docForWrite(kind, id);
    const where = locate(kind);
    const root = where.style === "dir" ? doc.root : this.ensureEntry(doc, kind, id);
    if (!root) throw new ModelError(`no ${kind} ${id}`);
    const node = getDocIn(doc, root, fieldPath);
    if (!node) throw new ModelError(`${kind} ${id} has no ${fieldPath.join(".")}`);
    doc.set(node, literal(value));
    return true;
  }

  /** The text a save would write, without writing. */
  diff() {
    return [...this.docs.entries()].map(([file, doc]) => ({ file, text: doc.render() }));
  }

  save() {
    const written = [];
    for (const [file, doc] of this.docs) {
      const text = doc.render();
      const before = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (before === text) continue;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      written.push(file);
    }
    return written;
  }
}

/** getDoc but rooted at a node instead of the document root. */
function getDocIn(doc, root, fieldPath) {
  let node = root;
  for (const step of fieldPath) {
    if (node === null || node === undefined) return null;
    if (typeof step === "number") {
      if (node.type !== "array" || step >= node.items.length) return null;
      node = node.items[step];
    } else {
      const entry = node.type === "object" ? findEntry(node, step) : null;
      if (!entry) return null;
      node = entry.value;
    }
  }
  return node;
}

/** Decode an object node into plain values, keeping nested source text. */
function readFields(doc, node) {
  if (!node || node.type !== "object") return {};
  const out = {};
  for (const entry of node.entries) out[entry.key] = valueOf(doc, entry.value);
  return out;
}

/** Refuse to write a key the class does not declare, or a value outside its domain. */
export function validateRecord(kind, record) {
  const spec = FIELDS[kind];
  if (!spec) return;
  const allowed = new Set([...spec.fields, ...(spec.handler || []), ...(spec.legacy || [])]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      throw new ModelError(`${kind} has no field ${JSON.stringify(key)}. Declared: ${spec.fields.join(", ")}`);
  }
  if (kind === "card") {
    if (!["char", "item", "sudan"].includes(record.type))
      throw new ModelError(`card type must be char, item or sudan, not ${JSON.stringify(record.type)}`);
    if (!(record.rare >= 1 && record.rare <= 4)) throw new ModelError("card rare must be 1..4");
  }
}

/** Open a mod directory for editing. */
export function openMod(dir, { vanilla = DEFAULT_VANILLA } = {}) {
  const abs = expand(dir);
  if (!existsSync(abs)) throw new ModelError(`no such mod directory: ${abs}`);
  return new Mod(abs, vanilla);
}

export { LAYOUT, FIELDS };
