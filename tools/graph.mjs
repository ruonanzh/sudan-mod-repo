#!/usr/bin/env node
/**
 * graph.mjs — build the story graph from the game's own config.
 *
 *   node tools/graph.mjs --check
 *   node tools/graph.mjs --out editors/.preview/graph/index.json [--mod your_mods/x] [--lang zh]
 *
 * The rules live in schema/view/edges.json and schema/view/categories.json; this file only executes
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
const EDGES = JSON.parse(readFileSync(path.join(ROOT, "schema/view/edges.json"), "utf8"));
const CATEGORIES = JSON.parse(readFileSync(path.join(ROOT, "schema/view/categories.json"), "utf8"));
const FIELD_SWITCHES = JSON.parse(readFileSync(path.join(ROOT, "schema/view/field-switches.json"), "utf8"));

const LANGS = ["zh", "en", "ja", "zhTW"];

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

/** Every key reachable from a record, for operation keys such as `counter+7000350`. */
function* walkKeys(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkKeys(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    yield k;
    yield* walkKeys(v);
  }
}

/**
 * The narration an event writes, in the same shape as an i18n narration record:
 * { opt: [{n, text, items}], prompt: [{n, text}] }. Chinese lives in the event file, not
 * in an i18n table, so this is the only source for it.
 */
function eventNarrationZh(rec) {
  const out = { opt: [], prompt: [] };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if ((k === "option" || k === "prompt" || k === "slide") && v && typeof v === "object" && typeof v.text === "string" && v.text.trim()) {
        if (k === "option") {
          const entry = { n: String(out.opt.length), text: v.text, items: [] };
          for (const it of v.items || []) {
            if (it && typeof it.text === "string" && it.text.trim()) entry.items.push({ n: String(entry.items.length), text: it.text });
          }
          out.opt.push(entry);
        } else {
          out.prompt.push({ n: String(out.prompt.length), text: v.text });
        }
      }
      visit(v);
    }
  };
  visit(rec);
  return out;
}

/** The first narration line, used as the node label. */
function firstNarration(rec) {
  const nr = eventNarrationZh(rec);
  const o = nr.opt[0];
  return (o && (o.text || (o.items[0] && o.items[0].text))) || (nr.prompt[0] && nr.prompt[0].text) || "";
}

/**
 * What a rite asks for and what it can turn into. Slots list the cards the board wants, each
 * with the condition that decides what may be dropped there; the three settlement arrays are
 * separate lists, not one (see plans/story-graph.md §六): prior and normal stop at the first
 * branch whose condition holds, extre runs all of them.
 */
function riteInfoOf(rec) {
  const slots = Object.entries(rec.cards_slot || {}).map(([k, s]) => ({
    k,
    text: (s && s.text) || "",
    cond: (s && s.condition) || null,
    // Two slot flags have a meaning a player can act on (see plans/story-graph.md §六);
    // is_empty only switches the empty-slot hint text and is_key is unused in vanilla.
    adsorb: s && s.open_adsorb ? 1 : 0,
    enemy: s && s.is_enemy ? 1 : 0,
  }));
  const branches = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter((b) => b && typeof b === "object")
      .map((b) => ({ cond: b.condition || null, title: b.result_title || "", text: b.result_text || "" }));
  const info = {
    type: rec.type || "",
    location: rec.location || "",
    tips: (rec.tips_text || []).filter((t) => t && String(t).trim()),
    slots,
    prior: branches(rec.settlement_prior),
    normal: branches(rec.settlement),
    extre: branches(rec.settlement_extre),
  };
  const empty = Object.values(info).every((v) => (Array.isArray(v) ? !v.length : !v));
  return empty ? null : info;
}

/**
 * The switch-like fields a node sets that a player can be told about, in the record's own
 * order. Only fields with an entry in schema/view/field-switches.json are listed: the rest are
 * either unreadable without the decompiled code or mean nothing to a player.
 */
function flagsOf(kind, rec) {
  const switches = FIELD_SWITCHES[kind];
  if (!switches) return null;
  const out = {};
  for (const key of Object.keys(switches)) {
    if (rec[key] === undefined) continue;
    out[key] = rec[key];
  }
  return Object.keys(out).length ? out : null;
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
      // An event has no title. `text` is a designer note (median 7 characters). When the
      // event writes narration, that becomes the label; when it does not, the note is the
      // only human-readable identity it has, so show it and mark it as a note.
      const label = kind === "event" ? (rec.text ? `〔备注〕${rec.text}` : "") : rec.name || rec.text || "";
      const node = add(kind, id, { labelSource: label });
      // The node may already exist from the directory listing, which has no label.
      node.labelSource = label || node.labelSource || "";
      if (kind === "event") {
        node.note = rec.text || "";
        node.on = rec.on || null;
        node.cond = rec.condition || null;
      }
      node.fl = flagsOf(kind, rec);
      if (kind === "rite" && Array.isArray(rec.open_conditions)) {
        node.oc = rec.open_conditions.map((x) => x && x.tips).filter(Boolean);
      }
      if (kind === "rite") node.ri = riteInfoOf(rec);
    }
  }

  const edges = [];
  const crossNotes = [];
  const seen = new Set();
  // A counter has no config record and no player-facing identity: it is an int in the save.
  // Keep references as annotations on the nodes that use them; never make counters nodes.
  const counters = new Map();
  const noteCounter = (nodeKey, id, kind) => {
    const n = Number(id);
    if (!Number.isInteger(n)) return;
    let rec = counters.get(String(n));
    if (!rec) {
      rec = { reads: [], timing: [], writes: [] };
      counters.set(String(n), rec);
    }
    if (!rec[kind].includes(nodeKey)) rec[kind].push(nodeKey);
  };
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
    if (toKind === "counter") return; // annotations only, see noteCounter
    if (!inSpace(toKind, n)) {
      const looks = kindContaining(n);
      if (looks) crossNotes.push({ from, to: `${toKind}:${n}`, rule, looksLike: looks });
      return;
    }
    edge(from, toKind, n, rule);
  };

  const edgeRaw = (from, target, rule) => {
    if (!nodes.has(target)) {
      // keep it: dangling edges are a finding, not something to hide
    }
    const sig = `${from}->${target}|${rule}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    edges.push({ f: from, t: target, r: rule });
  };

  const edge = (from, toKind, toId, rule) => edgeRaw(from, `${toKind}:${toId}`, rule);

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
        const label = kind === "event" ? (rec.text ? `〔备注〕${rec.text}` : "") : rec.name || rec.text || "";
        const node = add(kind, id, { labelSource: label });
        node.o = "mod";
        node.labelSource = label || node.labelSource;
        if (kind === "event") {
          node.note = rec.text || "";
          node.on = rec.on || null;
          node.cond = rec.condition || null;
        }
        node.fl = flagsOf(kind, rec);
        if (kind === "rite" && Array.isArray(rec.open_conditions)) {
          node.oc = rec.open_conditions.map((x) => x && x.tips).filter(Boolean);
        }
        if (kind === "rite") node.ri = riteInfoOf(rec);
      }
    }
    // counters referenced only by the mod
    for (const e of []) void e;
  }

  // Recount after the merge: a mod that adds an event must show up in the totals, otherwise
  // "categories partition the events" and the corpus counts disagree.
  for (const kind of Object.keys(counts)) counts[kind] = Object.keys(vanilla[kind] || {}).length;

  // rule: event.on.<timing>. Causality runs into the event: rite 5000563 ending is what
  // fires event 5300064, so the edge starts at the rite. Counter timings are annotations.
  for (const [id, ev] of Object.entries(vanilla.event)) {
    const on = ev.on || {};
    for (const [timing, value] of Object.entries(on)) {
      const spec = EDGES.timings[timing];
      if (!spec) continue;
      const { kind: toKind, route } = spec;
      if (route === "annotate") {
        for (const v of asIds(value)) noteCounter(`event:${id}`, v, "timing");
        continue;
      }
      for (const v of asIds(value)) {
        if (v === 1 && (toKind === "card" || toKind === "rite")) continue; // wildcard: any
        if (toKind === "over" && (v === -1 || v === -3)) continue; // sentinels
        if (!inSpace(toKind, v)) {
          const looks = kindContaining(v);
          if (looks) crossNotes.push({ from: `event:${id}`, to: `${toKind}:${v}`, rule: `on.${timing}`, looksLike: looks });
          continue;
        }
        edgeRaw(`${toKind}:${v}`, `event:${id}`, `trigger.${timing}`);
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
            const counterId = Number(key.split(".")[1].replace(/[<>=].*$/, ""));
            noteCounter(`${kind}:${id}`, counterId, "reads");
            continue;
          }

          if (!target) continue;
          if (Array.isArray(value)) continue; // ranges, not ids
          emit(`${kind}:${id}`, target, value, `condition.${target}`);
        }
      }
    }
  }

  // counters are read by conditions and the counter timing, and written by operation keys
  for (const kind of ["event", "rite", "card", "loot", "quest", "afterStory"]) {
    for (const [id, rec] of Object.entries(vanilla[kind] || {})) {
      for (const k of walkKeys(rec)) {
        const m = /^(global_)?counter([+\-=])(\d{7})$/.exec(k);
        if (m) noteCounter(`${kind}:${id}`, m[3], "writes");
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
  for (const n of nodes.values()) {
    if (n.t === "event") {
      const rec = vanilla.event?.[n.id];
      const zh = rec ? eventNarrationZh(rec) : { opt: [], prompt: [] };
      // Event narration is translated per line, not per record, so it rides alongside the label.
      n.nr = {
        zh,
        en: i18n.en?.narr.get(n.id) || null,
        ja: i18n.ja?.narr.get(n.id) || null,
        zhTW: i18n.zhTW?.narr.get(n.id) || null,
      };
      n.narrZh = firstNarration(rec || {});
    }
    n.l = labels(n, vanilla, i18n, lang);
    n.dl = descriptions(n, vanilla, i18n);
  }

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
    counters: Object.fromEntries([...counters.entries()].sort(([a], [b]) => Number(a) - Number(b))),
    dangling,
    crossType,
    components: comp,
    modSummary,
    categoryCounts: countBy([...nodes.values()].filter((n) => n.t === "event"), (n) => n.cat),
    fieldSwitches: { event: FIELD_SWITCHES.event, rite: FIELD_SWITCHES.rite },
    lint: { FAIL: lintSummary.FAIL, WARN: lintSummary.WARN, INFO: lintSummary.INFO },
  };
}

// ---------------------------------------------------------------- walking the graph
// A page draws one node's neighbourhood, so the walk has to be the same arithmetic in Node
// and in the browser. This is the Node half; editors/graph/graphpage.mjs carries the browser half in
// its inline script, because a page cannot import a module.

/**
 * The adjacency a walk needs: id -> ids, outgoing and incoming. Only `nodes` and `edges` are
 * read, so a hand-built `{nodes, edges}` is a valid index and a test can use one.
 */
export function graphIndex(g) {
  const out = new Map();
  const inc = new Map();
  for (const n of g.nodes) {
    out.set(n.k, []);
    inc.set(n.k, []);
  }
  for (const e of g.edges) {
    if (!out.has(e.f) || !inc.has(e.t)) continue; // a dangling edge is reported by lint, not walked
    out.get(e.f).push(e.t);
    inc.get(e.t).push(e.f);
  }
  return { out, inc };
}

const walkDepth = (depth) => {
  const n = Math.round(Number(depth));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
};

/** Direct neighbours of `id`, in both directions, sorted so two runs answer the same. */
export function neighbours(index, id) {
  return [...new Set([...(index.out.get(id) || []), ...(index.inc.get(id) || [])])].sort();
}

/**
 * Every node within `depth` hops of `id`, following edges both ways. The depth is clamped to
 * 1..5: 0 would be "the node alone", which is not a picture, and 5 is what the page offers.
 */
export function subgraph(index, id, depth = 1) {
  const d = walkDepth(depth);
  const hops = new Map();
  if (!index.out.has(id)) return { centre: id, depth: d, nodes: [] };
  hops.set(id, 0);
  let frontier = [id];
  for (let step = 1; step <= d && frontier.length; step++) {
    const next = [];
    for (const at of frontier) {
      for (const to of [...(index.out.get(at) || []), ...(index.inc.get(at) || [])]) {
        if (hops.has(to)) continue;
        hops.set(to, step);
        next.push(to);
      }
    }
    frontier = next;
  }
  return { centre: id, depth: d, nodes: [...hops.keys()].sort() };
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
/**
 * Build the translation lookup.
 *
 * The tables use one flat namespace with a fixed grammar: `<KIND>_<id>_<field>`, where KIND is
 * card / rite / quest / over / after_story / upgrade for record fields, and OPTION / PROMPT for
 * the narration lines of an event. There is no `event_` KIND at all: an event has no translated
 * title, and its text is a short label (median 7 characters, 84.5% are 12 or fewer) that the
 * tables never touch. What the tables do translate is the narration the player reads:
 *   OPTION_<eventId>_option_<n>_TEXT          the paragraph the event opens with
 *   OPTION_<eventId>_option_<n>_ITEM_<m>_TEXT a button label inside that paragraph
 *   PROMPT_<eventId>_prompt_<n>_TEXT          the paragraph after the choice
 * Of 1867 events, 279 have OPTION lines and 793 have PROMPT lines; the rest are silent.
 */
function indexI18n(table) {
  const byKey = new Map(); // "card:2000001" -> { text, pref }
  const desc = new Map(); // "rite:5008014" -> the paragraph under the name
  const narr = new Map(); // "5300176" -> { opt: [...], prompt: [...] }
  if (!table) return { byKey, narr, desc };
  const PREF = { name: 0, title: 1, text: 2 };
  const slot = (id) => {
    let rec = narr.get(id);
    if (!rec) { rec = { opt: [], prompt: [] }; narr.set(id, rec); }
    return rec;
  };
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const named = k.match(/^(card|rite|quest|over|after_story|upgrade)_(\d+)_([a-z0-9_]+)$/);
    if (named) {
      // Fields are ranked, not concatenated: a card's name is its label, and its text is a
      // paragraph. Mixing them makes one language show a paragraph where another shows a name.
      const key = `${named[1]}:${named[2]}`;
      const pref = PREF[named[3]] ?? 3;
      const prev = byKey.get(key);
      if (!prev || pref < prev.pref) byKey.set(key, { text: v, pref });
      // The paragraph sits beside the name in the same record but answers a different
      // question, so it gets its own table instead of being ranked against the name.
      if (named[3] === "text" && !desc.has(key)) desc.set(key, v);
      continue;
    }
    let m = k.match(/^OPTION_(\d+)_option_(\d+)_ITEM_(\d+)_TEXT$/);
    if (m) {
      const rec = slot(m[1]);
      let o = rec.opt.find((x) => x.n === m[2]);
      if (!o) { o = { n: m[2], text: "", items: [] }; rec.opt.push(o); }
      o.items.push({ n: m[3], text: v });
      continue;
    }
    m = k.match(/^OPTION_(\d+)_option_(\d+)_TEXT$/);
    if (m) {
      const rec = slot(m[1]);
      let o = rec.opt.find((x) => x.n === m[2]);
      if (!o) { o = { n: m[2], text: "", items: [] }; rec.opt.push(o); }
      o.text = v;
      continue;
    }
    m = k.match(/^PROMPT_(\d+)_prompt_(\d+)_TEXT$/);
    if (m) slot(m[1]).prompt.push({ n: m[2], text: v });
  }
  for (const rec of narr.values()) {
    rec.opt.sort((a, b) => a.n - b.n);
    rec.prompt.sort((a, b) => a.n - b.n);
    for (const o of rec.opt) o.items.sort((a, b) => a.n - b.n);
  }
  return { byKey, narr, desc };
}

/**
 * The paragraph a node shows under its name, per language. A rite's `text` is the sentence
 * the panel opens with; a card's `text` is the card's own paragraph. An event is left empty
 * on purpose: what it shows is narration, delivered line by line in `nr`, never this field.
 */
function descriptions(node, vanilla, i18n) {
  const prefix = { rite: "rite", card: "card", quest: "quest", afterStory: "after_story" }[node.t];
  const out = { zh: "", en: "", ja: "", zhTW: "" };
  if (!prefix) return out;
  const rec = vanilla[node.t] ? vanilla[node.t][node.id] : null;
  if (rec && typeof rec.text === "string") out.zh = rec.text;
  for (const l of ["en", "ja", "zhTW"]) {
    const v = i18n[l] && i18n[l].desc.get(`${prefix}:${node.id}`);
    if (v) out[l] = v;
  }
  return out;
}

function labels(node, vanilla, i18n, lang) {
  const prefixOf = { event: "event", rite: "rite", card: "card", quest: "quest", afterStory: "after_story", loot: "loot" };
  const prefix = prefixOf[node.t];
  // The game writes Unity rich text in these strings (<color=…><size=172%>…); a label is not
  // a renderer, so the tags are stripped. `tr` records which languages had a real string, so
  // a fallback can be labelled as one instead of passing Chinese off as a translation.
  const clean = (s) => String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const out = {};
  const tr = { en: false, ja: false, zhTW: false };
  // An event has no title in any language. What it has is narration: the opening paragraph,
  // the prompt, or a slide. Use its first line as the label so the graph shows something a
  // player would recognize instead of the designer's 7-character note.
  const narrOf = (l) => {
    if (node.t !== "event") return "";
    if (l === "zh") return node.narrZh || "";
    const rec = i18n[l]?.narr.get(node.id);
    if (!rec) return "";
    for (const o of rec.opt || []) {
      const t = o.text || (o.items && o.items[0] && o.items[0].text);
      if (t) return t;
    }
    for (const p of rec.prompt || []) if (p.text) return p.text;
    return "";
  };
  for (const l of LANGS) {
    const idx = l === "zh" ? null : i18n[l];
    // Only an exact `<prefix>:<id>` hit counts. Falling back to "any key that carries this id"
    // used to put an option button's text where the event's title belongs.
    const v = idx && prefix ? (idx.byKey.get(`${prefix}:${node.id}`) || {}).text : null;
    const nv = narrOf(l);
    if (v) {
      if (l !== "zh") tr[l] = true;
      out[l] = clean(v);
    } else if (nv) {
      if (l !== "zh") tr[l] = true;
      out[l] = clean(nv);
    } else {
      out[l] = clean(node.labelSource || (node.t === "event" ? `规则 ${node.id}` : node.id));
    }
  }
  out.zh = clean(narrOf("zh") || node.labelSource || (node.t === "event" ? `规则 ${node.id}` : node.id));
  node.tr = tr;
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
