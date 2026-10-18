#!/usr/bin/env node
/**
 * graph.mjs — build the story graph from the game's own config.
 *
 *   node tools/graph.mjs --check
 *   node tools/graph.mjs --out .preview/graph/index.json [--mod your_mods/x] [--lang zh]
 *
 * The rules live in schema/edges.json and schema/categories.json; this file only executes
 * them. Counts are printed, never stored in prose: they depend on the counting method
 * (direct key vs descendant key, append vs dedupe), and a document that restates them goes
 * stale the moment a rule changes.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DEFAULT_VANILLA } from "./model.mjs";
import { parseJsonc } from "./lint.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, "..");
const EDGES = JSON.parse(readFileSync(path.join(ROOT, "schema/edges.json"), "utf8"));
const CATEGORIES = JSON.parse(readFileSync(path.join(ROOT, "schema/categories.json"), "utf8"));

const LANGS = ["zh", "en", "ja", "zhTW"];
const KINDS = ["event", "rite", "card", "loot", "over", "ounter", "quest", "afterStory", "riteTemplate"];
// "ounter" above is deliberately absent: counters are terminal nodes with no config file.

// ---------------------------------------------------------------- loading

/** Read a JSONC file into a plain value, keeping duplicate keys as arrays. */
function readJsonc(file) {
  // A full build parses 3365 records plus three i18n tables; within one process the same
  // file is often needed twice (two counting modes, two mod overlays). Cache by path.
  if (docCache.has(file)) return docCache.get(file);
  const value = parseJsonc(readFileSync(file, "utf8")).value;
  docCache.set(file, value);
  return value;
}

const docCache = new Map();

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/**
 * Vanilla node ids by kind. model.mjs's ids() only reports what a mod overrides, so the
 * vanilla side is enumerated here from the same layout the rest of the repo uses.
 */
export function vanillaNodes(configDir) {
  const c = (p) => path.join(configDir, p);
  const nodes = { event: [], rite: [], card: [], loot: [], over: [], quest: [], afterStory: [], riteTemplate: [] };

  for (const f of listJson(c("event"))) nodes.event.push(f.replace(/\.json$/, ""));
  for (const f of listJson(c("rite"))) nodes.rite.push(f.replace(/\.json$/, ""));
  for (const f of listJson(c("loot"))) nodes.loot.push(f.replace(/\.json$/, ""));
  for (const f of listJson(c("after_story"))) nodes.afterStory.push(f.replace(/\.json$/, ""));
  for (const f of listJson(c("rite_template"))) nodes.riteTemplate.push(f.replace(/\.json$/, ""));

  if (existsSync(c("cards.json"))) nodes.card = Object.keys(readJsonc(c("cards.json"))).filter((k) => !k.startsWith("_"));
  if (existsSync(c("quest.json"))) nodes.quest = Object.keys(readJsonc(c("quest.json"))).filter((k) => !k.startsWith("_"));
  if (existsSync(c("over.json"))) nodes.over = Object.keys(readJsonc(c("over.json"))).filter((k) => !k.startsWith("_"));

  return nodes;
}

/** Records by kind, as plain objects keyed by id. */
function loadRecords(dir) {
  // Accept either a mod root (which holds config/) or a config directory itself.
  const configDir = existsSync(path.join(dir, "cards.json")) || existsSync(path.join(dir, "event")) ? dir : path.join(dir, "config");
  const c = (p) => path.join(configDir, p);
  const out = { event: {}, rite: {}, loot: {}, afterStory: {}, riteTemplate: {} };
  for (const kind of ["event", "rite", "loot", "after_story", "rite_template"]) {
    const target = kind === "after_story" ? "afterStory" : kind === "rite_template" ? "riteTemplate" : kind;
    for (const f of listJson(c(kind))) out[target][f.replace(/\.json$/, "")] = readJsonc(path.join(c(kind), f));
  }
  out.card = existsSync(c("cards.json")) ? readJsonc(c("cards.json")) : {};
  out.quest = existsSync(c("quest.json")) ? readJsonc(c("quest.json")) : {};
  out.over = existsSync(c("over.json")) ? readJsonc(c("over.json")) : {};
  return out;
}

/** Localised string tables; the simplified Chinese base lives in config itself. */
function loadI18n(assetsDir) {
  const out = { zh: null };
  for (const lang of ["en", "ja", "zhTW"]) {
    const f = path.join(assetsDir, "i18n", lang, "config.json");
    out[lang] = existsSync(f) ? indexI18n(readJsonc(f)) : null;
  }
  return out;
}

// ---------------------------------------------------------------- helpers

const KIND_ALIAS = { riteTemplate: "rite_template", afterStory: "after_story" };
const spaceOf = (kind) => EDGES.idSpaces[KIND_ALIAS[kind] || kind];

const inSpace = (kind, id) => {
  const space = spaceOf(kind);
  if (!space) return true;
  const n = Number(id);
  return Number.isInteger(n) && n >= space[0] && n <= space[1];
};

/** "loot.已拥有+1" and "counter+7000001" both carry an id we must dig out. */
function idFromKeyOrValue(key, value) {
  const m = String(key).match(/^([a-z_]+)(?:\.([^+\-=]+))?[+\-=]/i);
  const picked = m && m[2] ? m[2] : value;
  const n = Number(picked);
  return Number.isInteger(n) ? n : null;
}

const asIds = (v) => (Array.isArray(v) ? v : [v]);

/** Walk every object under a settlement-ish key, yielding {key, value} for a matching key. */
function* walkKey(node, key, depth = 0) {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkKey(item, key, depth);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === key) {
      yield { key: k, value: v };
      continue; // the value of a matched key is an operand, not a container
    }
    yield* walkKey(v, key, depth + 1);
  }
}

/**
 * Direct-key mode: only look at the action object's own keys, not at case:opN / delay /
 * success branches. The difference between the two modes is exactly what the descendant
 * keys add, and both numbers have to be printable.
 */
function* directKey(node, key) {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object" && item.action && typeof item.action === "object" && key in item.action) {
        yield { key, value: item.action[key] };
      }
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.action && typeof node.action === "object" && key in node.action) yield { key, value: node.action[key] };
}

/** Collect every `condition` object reachable from a record. */
function* walkConditions(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkConditions(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "condition" && v && typeof v === "object") yield v;
    yield* walkConditions(v);
  }
}

/** Leaf keys of a condition tree, unwrapping any/all. */
function* conditionLeaves(cond) {
  if (!cond || typeof cond !== "object") return;
  for (const [k, v] of Object.entries(cond)) {
    if (k === "any" || k === "all") {
      yield* conditionLeaves(v);
      continue;
    }
    yield { key: k, value: v };
  }
}

// ---------------------------------------------------------------- build

export function buildGraph({ configDir = DEFAULT_VANILLA, modDir = null, lang = "zh", edgeMode = "nested" } = {}) {
  configDir = String(configDir).replace(/^~/, os.homedir());
  if (modDir) modDir = String(modDir).replace(/^~/, os.homedir());
  const assets = path.dirname(configDir);
  const vanilla = loadRecords(configDir);
  const i18n = loadI18n(assets);

  const nodes = new Map(); // key -> node
  const add = (kind, id, extra) => {
    const key = `${kind}:${id}`;
    if (!nodes.has(key)) nodes.set(key, { k: key, t: kind, id: String(id), o: "vanilla", ...extra });
    return nodes.get(key);
  };

  // Seed from the directory listing first: an id whose file failed to parse still has to
  // exist as a node, otherwise its incoming edges look dangling for the wrong reason.
  const enumerated = vanillaNodes(configDir);
  for (const [kind, ids] of Object.entries(enumerated)) {
    for (const id of ids) add(kind, id, { labelSource: "" });
  }

  const counts = { event: 0, rite: 0, card: 0, loot: 0, over: 0, quest: 0, afterStory: 0, riteTemplate: 0 };
  for (const [kind, recs] of Object.entries(vanilla)) {
    for (const [id, rec] of Object.entries(recs)) {
      counts[kind] = (counts[kind] || 0) + 1;
      const node = add(kind, id, { labelSource: rec.name || rec.text || "" });
      // The node may already exist from the directory listing, which has no label.
      node.labelSource = rec.name || rec.text || node.labelSource || "";
    }
  }

  // Counters have no config file: they are engine state, and their ids are the only
  // definition that exists. Create them on first reference.
  const ensureCounter = (id) => add("counter", id, { labelSource: `counter ${id}` });

  const edges = [];
  const crossNotes = [];
  const seen = new Set();
  const kindContaining = (id) => {
    const n = Number(id);
    for (const [kind, space] of Object.entries(EDGES.idSpaces)) {
      if (space && n >= space[0] && n <= space[1]) return kind;
    }
    return null;
  };
  /** Emit an edge, or record a cross-type reference when the id belongs to another kind. */
  const emit = (from, toKind, value, rule) => {
    const n = Number(value);
    if (!Number.isInteger(n)) return;
    if (toKind === "counter") {
      if (!inSpace("counter", n)) {
        const looks = kindContaining(n);
        if (looks) crossNotes.push({ from, to: `counter:${n}`, rule, looksLike: looks });
        return;
      }
      ensureCounter(n);
    } else if (!inSpace(toKind, n)) {
      const looks = kindContaining(n);
      if (looks) crossNotes.push({ from, to: `${toKind}:${n}`, rule, looksLike: looks });
      return;
    }
    edge(from, toKind, n, rule);
  };

  const edge = (from, toKind, toId, rule) => {
    const target = `${toKind}:${toId}`;
    if (!nodes.has(target)) {
      // keep it: dangling edges are a finding, not something to hide
    }
    const sig = `${from}->${target}|${rule}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    edges.push({ f: from, t: target, r: rule });
  };

  // ---------------------------------------------------------------- mod overlay
  // Merged before edges are built: a mod that adds an event must get its own edges.
  const modSummary = { nodes: 0, overrides: 0, additions: 0 };
  if (modDir) {
    const modRecords = loadRecords(modDir);
    for (const kind of ["event", "rite", "loot", "afterStory", "riteTemplate", "card", "quest", "over"]) {
      for (const [id, rec] of Object.entries(modRecords[kind] || {})) {
        const key = `${kind}:${id}`;
        const existed = Boolean(nodes.get(key));
        if (existed) modSummary.overrides++;
        else modSummary.additions++;
        modSummary.nodes++;
        vanilla[kind] = vanilla[kind] || {};
        vanilla[kind][id] = rec;
        const node = add(kind, id, { labelSource: rec.name || rec.text || "" });
        node.o = "mod";
        node.labelSource = rec.name || rec.text || node.labelSource;
      }
    }
    // counters referenced only by the mod
    for (const e of []) void e;
  }

  // Recount after the merge: a mod that adds an event must show up in the totals, otherwise
  // "categories partition the events" and the corpus counts disagree.
  for (const kind of Object.keys(counts)) counts[kind] = Object.keys(vanilla[kind] || {}).length;

  // rule: event.on.<timing>
  for (const [id, ev] of Object.entries(vanilla.event)) {
    const on = ev.on || {};
    for (const [timing, value] of Object.entries(on)) {
      const toKind = EDGES.timings[timing];
      if (!toKind) continue;
      for (const v of asIds(value)) {
        if (v === 1 && (toKind === "card" || toKind === "rite")) continue; // sentinel: any
        if (toKind === "over" && (v === -1 || v === -3)) continue; // sentinels
        emit(`event:${id}`, toKind, v, `on.${timing}`);
      }
    }
  }

  // rules: nested keys inside settlement-ish containers
  const nested = EDGES.rules.filter((r) => r.match === "nestedKey");
  const containers = ["event", "rite", "card"];
  for (const kind of containers) {
    for (const [id, rec] of Object.entries(vanilla[kind] || {})) {
      for (const rule of nested) {
        if (!rule.from.includes(kind)) continue;
        for (const field of rule.within) {
          const hits = edgeMode === "direct" ? directKey(rec[field], rule.key) : walkKey(rec[field], rule.key);
          for (const hit of hits) {
            for (const v of asIds(hit.value)) {
              const n = idFromKeyOrValue(rule.key, v);
              if (n === null) continue;
              emit(`${kind}:${id}`, rule.to, n, rule.id);
            }
          }
        }
      }
    }
  }

  // rules: conditions (have / is / rite / counter)
  for (const kind of ["event", "rite", "card", "loot", "quest", "afterStory"]) {
    for (const [id, rec] of Object.entries(vanilla[kind] || {})) {
      for (const cond of walkConditions(rec)) {
        for (const leaf of conditionLeaves(cond)) {
          const key = leaf.key.replace(/^!/, "");
          let target = null;
          let value = leaf.value;

          if (/^(have|table_have|hand_have)\./.test(key)) {
            const parts = key.split(".");
            if (/^\d+$/.test(parts[1] || "")) {
              target = "card";
              value = Number(parts[1]);
            }
          } else if (key === "is") {
            target = "card";
          } else if (key === "is_rite" || key === "rite") {
            target = "rite";
          } else if (/^(counter|global_counter)\./.test(key)) {
            target = "counter";
            value = Number(key.split(".")[1].replace(/[<>=].*$/, ""));
          }

          if (!target) continue;
          if (Array.isArray(value)) continue; // ranges, not ids
          if (Array.isArray(value)) continue;
          emit(`${kind}:${id}`, target, value, `condition.${target}`);
        }
      }
    }
  }

  // rule: loot items point at a card, an event, a rite or another table
  for (const [id, table] of Object.entries(vanilla.loot)) {
    for (const item of table.item || []) {
      const kind = { card: "card", event: "event", rite: "rite", loot: "loot" }[item.type];
      if (!kind) continue;
      emit(`loot:${id}`, kind, item.id, "loot.item");
    }
  }

  // rule: rite.mapping_id -> rite_template
  const mappings = existsSync(path.join(configDir, "rite_template_mappings.json"))
    ? readJsonc(path.join(configDir, "rite_template_mappings.json"))
    : {};
  for (const [id, rite] of Object.entries(vanilla.rite)) {
    const m = mappings[String(rite.mapping_id)];
    if (m && m.template_id) emit(`rite:${id}`, "riteTemplate", m.template_id, "rite.template");
  }

  // ---------------------------------------------------------------- categories
  const categoryOf = new Map();
  for (const [id, ev] of Object.entries(vanilla.event)) {
    categoryOf.set(`event:${id}`, classify(ev));
  }
  // rites inherit from the events that point at them
  const riteVotes = new Map();
  for (const e of edges) {
    if (!e.f.startsWith("event:") || !e.t.startsWith("rite:")) continue;
    const cat = categoryOf.get(e.f);
    if (!cat) continue;
    if (!riteVotes.has(e.t)) riteVotes.set(e.t, new Map());
    const m = riteVotes.get(e.t);
    m.set(cat, (m.get(cat) || 0) + 1);
  }
  for (const [key, votes] of riteVotes) {
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    categoryOf.set(key, best);
  }
  for (const n of nodes.values()) {
    if (n.t === "rite") n.cat = categoryOf.get(n.k) || "other";
    else if (n.t === "event") n.cat = categoryOf.get(n.k) || "other";
  }

  // ---------------------------------------------------------------- components (spine only)
  const comp = components(edges, nodes);
  // A node is "in a chain" when its spine component has more than one member. The canvas
  // uses this for the "only story chains" filter.
  for (const [key, size] of Object.entries(comp.memberSize || {})) {
    const n = nodes.get(key);
    if (n) {
      n.chain = size > 1;
      n.compSize = size;
    }
  }

  // ---------------------------------------------------------------- labels
  for (const n of nodes.values()) n.l = labels(n, vanilla, i18n, lang);

  // ---------------------------------------------------------------- lint badges
  const lintSummary = { FAIL: 0, WARN: 0, INFO: 0, results: [] };
  if (modDir && existsSync(modDir)) {
    // lint takes a mod directory positionally, so pass the mod itself, not its parent.
    const run = spawnSync(process.execPath, [path.join(ROOT, "tools/lint.mjs"), modDir, "--json"], { encoding: "utf8" });
    try {
      const out = JSON.parse(run.stdout || "{}");
      lintSummary.FAIL = out.counts?.FAIL || 0;
      lintSummary.WARN = out.counts?.WARN || 0;
      lintSummary.INFO = out.counts?.INFO || 0;
      lintSummary.results = out.results || [];
      for (const r of lintSummary.results) {
        const m = String(r.file || "").match(/^config\/(event|rite|loot|after_story|rite_template)\/([^.]+)\.json$/);
        if (!m) continue;
        const kind = m[1] === "after_story" ? "afterStory" : m[1] === "rite_template" ? "riteTemplate" : m[1];
        const node = nodes.get(`${kind}:${m[2]}`);
        if (!node) continue;
        node.badges = node.badges || [];
        node.badges.push({ level: r.level, code: r.code });
      }
    } catch {
      // lint is a convenience here: a broken run must not take the graph down
    }
  }

  // ---------------------------------------------------------------- dangling
  const dangling = edges.filter((e) => !nodes.has(e.t)).map((e) => ({ from: e.f, to: e.t, rule: e.r }));
  // A reference whose id belongs to a different kind's id space is a data bug worth
  // naming on its own: it is not an edge, it is a broken pointer.
  const crossType = crossNotes;

  return {
    builtAt: new Date().toISOString(),
    configDir,
    counts,
    nodes: [...nodes.values()],
    edges,
    dangling,
    crossType,
    components: comp,
    modSummary,
    categoryCounts: countBy([...nodes.values()].filter((n) => n.t === "event"), (n) => n.cat),
    lint: { FAIL: lintSummary.FAIL, WARN: lintSummary.WARN, INFO: lintSummary.INFO },
  };
}

function countBy(list, fn) {
  const out = {};
  for (const x of list) {
    const k = fn(x) || "other";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** First matching rule wins; the last rule is the residual bucket. */
export function classify(ev) {
  const text = String(ev.text ?? "");
  const onKeys = Object.keys(ev.on || {});
  for (const rule of CATEGORIES.rules) {
    const w = rule.when;
    if (w.always) return rule.id;
    if (w.any && w.any.some((sub) => matches(sub, ev, text, onKeys))) return rule.id;
    if (w.textStartsWith && w.textStartsWith.some((p) => text.startsWith(p))) return rule.id;
    if (w.textContains && w.textContains.some((p) => text.includes(p))) return rule.id;
    if (w.onAny && w.onAny.some((t) => onKeys.includes(t))) return rule.id;
    if (w.onOnly && onKeys.length === w.onOnly.length && onKeys.every((k) => w.onOnly.includes(k))) {
      if (w.isReplay === undefined || Boolean(ev.is_replay) === w.isReplay) return rule.id;
    }
  }
  return "other";
}

/** One branch of a category rule. Kept separate so `any` can reuse it. */
function matches(w, ev, text, onKeys) {
  if (w.always) return true;
  if (w.textStartsWith && w.textStartsWith.some((p) => text.startsWith(p))) return true;
  if (w.textContains && w.textContains.some((p) => text.includes(p))) return true;
  if (w.onAny && w.onAny.some((t) => onKeys.includes(t))) return true;
  if (w.onOnly && onKeys.length === w.onOnly.length && onKeys.every((k) => w.onOnly.includes(k))) {
    if (w.isReplay === undefined || Boolean(ev.is_replay) === w.isReplay) return true;
  }
  return false;
}

/** Undirected components over event<->rite edges only: that is the story spine. */
function components(edges, nodes) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of edges) {
    const a = e.f;
    const b = e.t;
    if (!a.startsWith("event:") && !a.startsWith("rite:")) continue;
    if (!b.startsWith("event:") && !b.startsWith("rite:")) continue;
    link(a, b);
    link(b, a);
  }
  const seen = new Set();
  const sizes = [];
  const memberSize = {};
  let touched = 0;
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    let size = 0;
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      size++;
      for (const y of adj.get(x) || []) if (!seen.has(y)) stack.push(y);
    }
    touched += size;
    sizes.push(size);
    for (const member of seen) if (!(member in memberSize)) memberSize[member] = size;
  }
  sizes.sort((a, b) => b - a);
  const total = [...nodes.values()].filter((n) => n.t === "event" || n.t === "rite").length;
  return { count: sizes.length, largest: sizes[0] || 0, top: sizes.slice(0, 5), touched, isolated: total - touched, memberSize };
}

/**
 * One pass over each language table builds the lookup the labels need.
 *
 * The naive version scanned 56892 keys per node, which is 300M comparisons over the whole
 * graph. Indexing once turns a 25 s build into a fraction of a second.
 */
function indexI18n(table) {
  const byKey = new Map(); // "event:5300000" -> string
  const byId = new Map(); // "5300000" -> first PROMPT/OPTION/CONFIRM line
  if (!table) return { byKey, byId };
  const PREF = { name: 0, title: 1, text: 2 };
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const named = k.match(/^(card|rite|quest|after_story|loot|event)_(\d+)_(name|title|text)$/);
    if (named) {
      const key = `${named[1]}:${named[2]}`;
      const prev = byKey.get(key);
      if (!prev || PREF[named[3]] < prev.pref) byKey.set(key, { text: v, pref: PREF[named[3]] });
      continue;
    }
    // Events have no name key at all; their first line lives under a family prefix that
    // varies by node type (PROMPT / OPTION / CONFIRM / POP ...). Any key carrying the id
    // is a usable fallback, and the first one in file order wins.
    const m = k.match(/_(\d{6,7})_/);
    if (m && !byId.has(m[1])) byId.set(m[1], v);
  }
  return { byKey, byId };
}

/** Four-language label with the fallback order the data actually supports. */
function labels(node, vanilla, i18n, lang) {
  const prefixOf = { event: "event", rite: "rite", card: "card", quest: "quest", afterStory: "after_story", loot: "loot" };
  const prefix = prefixOf[node.t];
  // The game writes Unity rich text in these strings (<color=…><size=172%>…). A label is
  // not a renderer, so the tags are stripped rather than shown.
  const clean = (s) => String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const out = {};
  for (const l of LANGS) {
    const idx = l === "zh" ? null : i18n[l];
    let v = idx && prefix ? (idx.byKey.get(`${prefix}:${node.id}`) || {}).text : null;
    if (!v && idx && prefix === "event") v = idx.byId.get(node.id);
    out[l] = clean(v || node.labelSource || node.id);
  }
  out.zh = clean(node.labelSource || node.id);
  return out;
}

// ---------------------------------------------------------------- cli

function parseArgs(argv) {
  const out = { configDir: DEFAULT_VANILLA, modDir: null, out: null, lang: "zh", check: false, edgeMode: "nested" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--vanilla") out.configDir = argv[++i];
    else if (a === "--mod") out.modDir = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--lang") out.lang = argv[++i];
    else if (a === "--edges") out.edgeMode = argv[++i];
  }
  return out;
}

export function summarize(g) {
  const lines = [];
  lines.push(`nodes  ${Object.entries(g.counts).map(([k, v]) => `${k}=${v}`).join(" ")}  total=${g.nodes.length}`);
  lines.push(`edges  ${g.edges.length}`);
  lines.push(`categories  ${Object.entries(g.categoryCounts).map(([k, v]) => `${k}=${v}`).join(" ")}  sum=${Object.values(g.categoryCounts).reduce((a, b) => a + b, 0)}`);
  lines.push(`components  count=${g.components.count} largest=${g.components.largest} top=${g.components.top.join(",")} touched=${g.components.touched} isolated=${g.components.isolated}`);
  if (g.lint) lines.push(`lint  FAIL=${g.lint.FAIL} WARN=${g.lint.WARN} INFO=${g.lint.INFO}`);
  lines.push(`dangling  ${g.dangling.length}  crossType=${g.crossType.length}`);
  if (g.dangling.length) lines.push(`  ` + g.dangling.slice(0, 8).map((d) => `${d.from}->${d.to}`).join("  "));
  if (g.crossType.length) {
    lines.push(`  cross-type  ` + g.crossType.slice(0, 6).map((d) => `${d.from}->${d.to} (looks like ${d.looksLike})`).join("  "));
    if (g.crossType.length > 6) lines.push(`  ... and ${g.crossType.length - 6} more`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  args.configDir = String(args.configDir).replace(/^~/, os.homedir());
  if (!args.check && !args.out) {
    process.stderr.write("usage: node tools/graph.mjs --check | --out <file> [--mod <dir>] [--vanilla <config>]\n");
    return 2;
  }
  if (!existsSync(args.configDir)) {
    process.stderr.write(`no config at ${args.configDir}\n`);
    return 2;
  }
  const g = buildGraph(args);
  const report = summarize(g);
  if (args.check) process.stdout.write(`${report}\n`);
  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(g));
    process.stdout.write(`wrote ${args.out}  (${(JSON.stringify(g).length / 1048576).toFixed(1)} MB)\n`);
    if (!args.check) process.stdout.write(`${report}\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("graph.mjs")) process.exit(main());
