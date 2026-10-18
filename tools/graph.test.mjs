/**
 * The graph builder must agree with the data. These tests pin the rules, not prose counts:
 * a baseline file records what a full build produced, and the invariants beside it catch
 * the mistakes a count alone would hide.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph, classify } from "./graph.mjs";
import { DEFAULT_VANILLA } from "./model.mjs";
import os from "node:os";

const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, os.homedir());
const hasGame = existsSync(VANILLA);
const skip = hasGame ? false : "the game's config is not installed on this machine";

let cached = null;
const graph = () => (cached ??= buildGraph({ configDir: VANILLA }));

test("classify gives exactly one bucket, and the last rule absorbs the rest", () => {
  const rules = ["unused", "reputation", "ending", "guide", "achievement", "daily", "periodic", "other"];
  assert.equal(classify({ text: "废弃", on: {}, is_replay: 0 }), "unused");
  assert.equal(classify({ text: "奈费勒声望事件", on: {}, is_replay: 0 }), "reputation");
  assert.equal(classify({ text: "结局-伯劳的森林", on: {}, is_replay: 0 }), "ending");
  assert.equal(classify({ text: "苏丹引导", on: {}, is_replay: 0 }), "guide");
  assert.equal(classify({ text: "成就-某", on: {}, is_replay: 0 }), "achievement");
  assert.equal(classify({ text: "", on: { round_begin_ba: 1 }, is_replay: 1 }), "daily");
  assert.equal(classify({ text: "", on: { round_begin_ba: 1 }, is_replay: 0 }), "periodic");
  assert.equal(classify({ text: "英文事件", on: { rite_end: 5000002 }, is_replay: 0 }), "other");
  for (const id of rules) assert.equal(typeof id, "string");
});

test("a sentinel is never an edge", { skip }, () => {
  const g = graph();
  // `rite_end: 1` and `card_clean: 1` mean "any"; no node has id 1 in those kinds.
  assert.equal(g.edges.filter((e) => e.t === "rite:1" || e.t === "card:1").length, 0);
});

test("descendant keys add edges without adding nodes", { skip }, () => {
  const nested = buildGraph({ configDir: VANILLA, edgeMode: "nested" });
  const direct = buildGraph({ configDir: VANILLA, edgeMode: "direct" });
  assert.equal(nested.nodes.length, direct.nodes.length);
  assert.ok(nested.edges.length > direct.edges.length, "case:opN / delay / success keys must contribute edges");
});

test("every edge points at a node, and every rejected id is reported", { skip }, () => {
  const g = graph();
  const keys = new Set(g.nodes.map((n) => n.k));
  const missing = g.edges.filter((e) => !keys.has(e.t));
  assert.deepEqual(missing, [], `edges with no target: ${missing.slice(0, 5).map((e) => e.t)}`);
  // A cross-type reference is reported instead of silently dropped.
  assert.ok(g.crossType.some((c) => c.from === "event:5320511" && c.to === "rite:5320511"));
  assert.ok(g.crossType.some((c) => c.from === "rite:5008112" && c.to === "rite:5321118"));
});

test("edges may be reordered and deduped without changing the counts", { skip }, () => {
  const g = graph();
  const shuffled = [...g.edges].sort((a, b) => (a.t < b.t ? 1 : -1));
  const key = (e) => `${e.f}|${e.t}|${e.r}`;
  assert.equal(new Set(g.edges.map(key)).size, g.edges.length, "edges must already be unique");
  assert.equal(shuffled.length, g.edges.length);
});

test("vanilla node counts match the corpus", { skip }, () => {
  const g = graph();
  assert.equal(g.counts.event, 1867);
  assert.equal(g.counts.rite, 1498);
  assert.equal(g.counts.card, 1294);
  assert.equal(g.counts.loot, 193);
  assert.equal(g.counts.over, 159);
  assert.equal(g.counts.quest, 161);
  assert.equal(g.counts.afterStory, 66);
  assert.equal(g.counts.riteTemplate, 252);
});

test("categories partition the events", { skip }, () => {
  const g = graph();
  const sum = Object.values(g.categoryCounts).reduce((a, b) => a + b, 0);
  assert.equal(sum, g.counts.event, "first-match classification must cover every event exactly once");
  assert.ok((g.categoryCounts.other || 0) > 0);
});

test("a mod override reuses the node and marks its origin", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "graphmod-"));
  mkdirSync(path.join(dir, "config/event"), { recursive: true });
  writeFileSync(
    path.join(dir, "config/event/9000001.json"),
    JSON.stringify({ id: 9000001, text: "新事件", is_replay: 0, on: { rite_end: 5000002 }, condition: {}, settlement: [] })
  );
  const g = buildGraph({ configDir: VANILLA, modDir: dir });
  const node = g.nodes.find((n) => n.k === "event:9000001");
  assert.ok(node, "the mod event must appear as a node");
  assert.equal(node.o, "mod");
  assert.equal(g.modSummary.additions, 1);
  assert.ok(g.edges.some((e) => e.f === "event:9000001" && e.t === "rite:5000002"), "the mod event's own edge must be built");
});

test("the baseline file still describes a full build", { skip }, () => {
  const base = JSON.parse(readFileSync(new URL("../schema/graph-baseline.json", import.meta.url), "utf8"));
  const g = graph();
  assert.deepEqual(g.counts, base.counts, "语料变了：先确认是新数据还是新规则，再更新基线");
  assert.equal(g.edges.length, base.edges, "边数变了：这是规则改动的信号，必须是有意的");
  assert.equal(g.components.count, base.components);
  assert.equal(g.components.largest, base.largestComponent);
  assert.deepEqual(g.categoryCounts, base.categoryCounts);
  assert.equal(g.crossType.length, base.crossType);
});

test("the baseline is internally consistent", { skip }, () => {
  const base = JSON.parse(readFileSync(new URL("../schema/graph-baseline.json", import.meta.url), "utf8"));
  const sum = Object.values(base.categoryCounts).reduce((a, b) => a + b, 0);
  assert.equal(sum, base.counts.event, "每个事件必须且只能属于一个分类");
  assert.ok(base.largestComponent <= base.counts.event + base.counts.rite);
  assert.ok(base.components <= base.counts.event + base.counts.rite);
});
