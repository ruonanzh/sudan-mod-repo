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
import { buildGraph, classify, graphIndex, neighbours, subgraph } from "./graph.mjs";
import { DEFAULT_VANILLA } from "./model.mjs";
import os from "node:os";

const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, os.homedir());
const CATEGORIES = JSON.parse(readFileSync(new URL("../schema/categories.json", import.meta.url), "utf8"));
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

test("a literal 1 is a wildcard, not an id", { skip }, () => {
  const g = graph();
  // `rite_end: 1` means "any rite". If the wildcard handling broke, this would become `rite:1`.
  assert.equal(g.edges.filter((e) => e.t === "rite:1" || e.t === "card:1").length, 0);
  // event 5300239 fires on `rite_end: 1`; it must not claim a real triggering rite.
  assert.equal(g.edges.filter((e) => e.t === "event:5300239" && e.r === "trigger.rite_end").length, 0);
});

test("a rite nested under case:opN still makes an edge", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "graphnested-"));
  mkdirSync(path.join(dir, "config/event"), { recursive: true });
  writeFileSync(
    path.join(dir, "config/event/9000002.json"),
    JSON.stringify({
      id: 9000002,
      text: "嵌套",
      is_replay: 0,
      on: { round_begin_ba: 1 },
      condition: {},
      settlement: [{ action: { "case:op1": { rite: 5000002 } } }],
    })
  );
  const nested = buildGraph({ configDir: VANILLA, modDir: dir, edgeMode: "nested" });
  const direct = buildGraph({ configDir: VANILLA, modDir: dir, edgeMode: "direct" });
  assert.ok(
    nested.edges.some((e) => e.f === "event:9000002" && e.t === "rite:5000002" && e.r === "action.rite"),
    "a rite inside case:op1 is a real edge in nested mode"
  );
  assert.ok(
    !direct.edges.some((e) => e.f === "event:9000002" && e.t === "rite:5000002"),
    "direct mode reads only action.rite, not its descendants"
  );
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

test("edge keys are unique", { skip }, () => {
  const g = graph();
  const key = (e) => `${e.f}|${e.t}|${e.r}`;
  assert.equal(new Set(g.edges.map(key)).size, g.edges.length, "the same edge must not be emitted twice");
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

test("every event lands in a declared category", { skip }, () => {
  const g = graph();
  const ids = new Set(CATEGORIES.rules.map((r) => r.id));
  for (const n of g.nodes) {
    if (n.t !== "event") continue;
    assert.ok(ids.has(n.cat), `event ${n.id} has category ${n.cat}, which no rule declares`);
  }
  assert.equal(Object.values(g.categoryCounts).reduce((a, b) => a + b, 0), g.counts.event);
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
  assert.ok(
    g.edges.some((e) => e.f === "rite:5000002" && e.t === "event:9000001" && e.r === "trigger.rite_end"),
    "on.rite_end is a trigger: the rite fires the event, so the edge runs into the event"
  );
});

test("counters are annotations, not nodes", { skip }, () => {
  const g = graph();
  assert.equal(g.nodes.filter((n) => n.t === "counter").length, 0, "a counter has no record and must not be a node");
  assert.ok(Object.keys(g.counters).length > 1000, "counter references must still be indexed");
  assert.ok(g.counters["7000350"].writes.includes("rite:5002018"), "rite 5002018 writes the 爽约 counter");
  assert.equal(g.edges.filter((e) => e.t.startsWith("counter:")).length, 0, "a counter must not be an edge target");
});

test("on.rite_end runs into the event", { skip }, () => {
  const g = graph();
  assert.ok(
    g.edges.some((e) => e.f === "rite:5000563" && e.t === "event:5300064" && e.r === "trigger.rite_end"),
    "rite 5000563 ending fires event 5300064"
  );
  assert.equal(g.edges.filter((e) => e.r.startsWith("on.")).length, 0, "no edge may use the old reference direction");
});

test("an event carries a note for its row and narration for search", { skip }, () => {
  const g = graph();
  const narrated = g.nodes.find((n) => n.k === "event:5300064");
  assert.equal(narrated.note, "选择如何处理禁卫队长", "the note is the name the page prints");
  assert.notEqual(narrated.l.zh, narrated.note, "the note is not what a search matches on");
  assert.ok(narrated.l.zh.length > 10, "the narration stays searchable in its own language");
  const silent = g.nodes.find((n) => n.k === "event:5360014");
  assert.ok(silent.note.includes("善名"), "a silent event still has its note");
  assert.ok(silent.l.zh.startsWith("〔备注〕"), "with no narration, the note stands in and says so");
});

test("a node's description is its own paragraph, in every language", { skip }, () => {
  const g = graph();
  const rite = g.nodes.find((n) => n.k === "rite:5008014");
  assert.equal(rite.l.zh, "荣耀回归", "the name is the label");
  assert.ok(rite.dl.zh.startsWith("你已经拿到了盖斯家的世袭头衔"), "the paragraph sits beside the name, not in place of it");
  assert.match(rite.dl.en, /hereditary title/, "the paragraph is translated per language");
  const card = g.nodes.find((n) => n.k === "card:2000001");
  assert.ok(card.dl.zh.length > 5 && card.dl.ja.length > 5, "a card carries its own paragraph too");
  // An event never borrows its designer note as a description: what it shows is narration.
  const ev = g.nodes.find((n) => n.k === "event:5300090");
  assert.equal(ev.note, "浴场移除提示");
  assert.equal(ev.dl.zh, "", "the note is the heading, never the description");
  assert.ok(ev.nr.zh.prompt.some((p) => p.text.includes("浴场暂时关闭")), "the narration is what the panel describes");
  // A rite with no paragraph in any table reports none, instead of repeating its name.
  const bare = g.nodes.find((n) => n.k === "rite:5000062");
  assert.equal(bare.dl.zh, "");
  assert.equal(bare.dl.en, "");
});

test("every switch names a real field and reads in all four languages", () => {
  const spec = JSON.parse(readFileSync(new URL("../schema/field-switches.json", import.meta.url), "utf8"));
  const fields = JSON.parse(readFileSync(new URL("../schema/fields.json", import.meta.url), "utf8"));
  for (const kind of ["event", "rite"]) {
    // A switch may name a legacy field: some of them are still in vanilla data and worth saying
    // something about, so the guard accepts every field the schema knows, not just the live ones.
    const declared = new Set([...(fields[kind].fields || []), ...(fields[kind].handler || []), ...(fields[kind].legacy || [])]);
    for (const [key, slots] of Object.entries(spec[kind])) {
      assert.ok(declared.has(key), `${kind}.${key} is not a field of ${kind}`);
      const names = Object.keys(slots).filter((x) => x !== "note");
      assert.ok(names.length, `${kind}.${key} says nothing`);
      const LANG = ["zh", "en", "ja", "zhTW"];
      for (const slot of names) {
        // `values` holds one sentence per value, each in four languages.
        const bodies = slot === "values" ? Object.entries(slots.values) : [[slot, slots[slot]]];
        assert.ok(bodies.length, `${kind}.${key}.values is empty`);
        for (const [label, body] of bodies) {
          for (const l of LANG) {
            assert.ok(body[l] && body[l].trim(), `${kind}.${key}.${slot}.${label} has no ${l}`);
          }
          if (slot === "num") assert.match(body.zh, /\{v\}/, `${kind}.${key} fills no value`);
        }
      }
    }
  }
});

test("a node carries the switches it sets, and only the ones we can explain", { skip }, () => {
  const g = graph();
  const ev = g.nodes.find((n) => n.k === "event:5300090");
  assert.deepEqual(ev.fl, { is_replay: 1, auto_start_init: [1], start_trigger: false });
  const rite = g.nodes.find((n) => n.k === "rite:5008014");
  assert.equal(rite.fl.auto_begin, 0);
  assert.equal(rite.fl.round_number, 1);
  // A switch with no note is not reported, so the panel never prints a bare field name.
  assert.equal(g.nodes.find((n) => n.k === "card:2000001").fl, null);
  assert.deepEqual(Object.keys(g.fieldSwitches).sort(), ["event", "rite"]);
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

test("the panel can read a node's own conditions", { skip }, () => {
  const g = graph();
  const ev = g.nodes.find((n) => n.k === "event:5300040");
  assert.equal(ev.cond["!rite"], 5002018);
  assert.equal(ev.cond["have.2000080.激情"], 1);
  assert.equal(ev.on.round_begin_ba, 1);
  const rite = g.nodes.find((n) => n.k === "rite:5000104");
  assert.ok(Array.isArray(rite.oc) && rite.oc.length > 0, "a rite carries the tips of its open conditions");
  assert.ok(rite.oc[0].includes("权势"), "the tip is the designer's own sentence");
});

// ---------------------------------------------------------------- the walk a page draws
// A hand-built index keeps these tests independent of the corpus: the walk is arithmetic on
// ids, and the game's own data is too tangled to read a distance off.
const chain = () =>
  graphIndex({
    nodes: ["a", "b", "c", "d", "e", "f", "x", "y"].map((k) => ({ k })),
    edges: [
      { f: "a", t: "b", r: "action.event" },
      { f: "b", t: "c", r: "action.event" },
      { f: "c", t: "d", r: "action.event" },
      { f: "d", t: "e", r: "action.event" },
      { f: "e", t: "f", r: "action.event" },
      { f: "y", t: "x", r: "action.event" },
    ],
  });

test("depth 1 is the direct neighbours and nothing further", () => {
  assert.deepEqual(subgraph(chain(), "a", 1).nodes, ["a", "b"]);
  assert.deepEqual(subgraph(chain(), "b", 1).nodes, ["a", "b", "c"], "both ends of b are neighbours");
  assert.deepEqual(neighbours(chain(), "b"), ["a", "c"]);
});

test("depth 5 walks five hops, and depth 4 stops one short", () => {
  assert.deepEqual(subgraph(chain(), "a", 4).nodes, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(subgraph(chain(), "a", 5).nodes, ["a", "b", "c", "d", "e", "f"], "five hops reach f");
  assert.equal(neighbours(chain(), "f").length, 1);
});

test("a node nothing connects to stays out of the walk", () => {
  const seen = subgraph(chain(), "a", 5).nodes;
  assert.ok(!seen.includes("x") && !seen.includes("y"), "a separate pair is not drawn");
  assert.deepEqual(subgraph(chain(), "x", 1).nodes, ["x", "y"], "and it keeps its own neighbourhood");
});

test("the walk follows edges in both directions", () => {
  // c is reached from a by following a->b->c forward; a is reached from c by following back.
  assert.ok(subgraph(chain(), "c", 2).nodes.includes("a"), "an incoming edge is a way back");
  assert.deepEqual(subgraph(chain(), "d", 1).nodes, ["c", "d", "e"], "one in, one out");
});

test("the depth is clamped to the range the page offers", () => {
  assert.equal(subgraph(chain(), "a", 0).depth, 1, "0 hops is not a picture");
  assert.equal(subgraph(chain(), "a", -3).depth, 1);
  assert.equal(subgraph(chain(), "a", 99).depth, 5, "5 is the ceiling");
  assert.equal(subgraph(chain(), "a", "3").depth, 3, "a control hands over a string");
  assert.equal(subgraph(chain(), "a", 3.6).depth, 4, "and a fraction rounds");
});

test("an id the index does not know draws nothing, instead of throwing", () => {
  const empty = subgraph(chain(), "nope", 2);
  assert.deepEqual(empty.nodes, []);
  assert.equal(empty.centre, "nope");
  assert.deepEqual(neighbours(chain(), "nope"), []);
});
