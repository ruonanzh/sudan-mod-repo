/**
 * tools/preview.mjs, the graph half: a mod with story records gets a graph page per record and a
 * story graph, and --focus and --out decide where those pages land. Each case builds the game's
 * graph, so the file is separate: the runner gives every suite its own process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PREVIEW, skip, read, run, mod, CARD, eventAt } from "./lib/preview-fixture.mjs";

test("a mod of only events gets one story graph that opens on the record named by --focus", { skip }, () => {
  const dir = mod({ "config/event/9000001.json": eventAt(9000001, "新事件") });
  const r = run(["--mod", dir, "--focus", "event:9000001"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = path.join(dir, ".preview");
  const page = read(path.join(out, "graph.html"));
  const data = read(path.join(out, "graph.data.js"));
  const script = read(path.join(out, "graph.page.js"));
  assert.match(page, /<script src="graph\.data\.js"><\/script>/, "the page loads its graph from the sibling file");
  assert.match(script, /\["mod", "mod", modCount\]/, "the filter row carries the mod button");
  assert.match(data, /"defaultCat":"mod"/, "and it is the filter the page opens with");
  assert.match(data, /"focus":"event:9000001"/, "the page opens on the record preview was asked for");
  assert.match(data, /"mod":true/, "the mod's record is flagged in the payload");
  assert.equal(existsSync(path.join(out, "cards.html")), false, "no card page for a mod with no cards");
  const recordPage = path.join(out, "event-9000001.record.html");
  assert.ok(existsSync(recordPage), "an event gets a page of its own, next to the story graph");
  const record = read(recordPage);
  assert.match(record, /<script src="graph\.data\.js"><\/script>/, "it is the whole story graph, from the same data");
  assert.match(record, /<script src="event-9000001\.focus\.js"><\/script>/, "opened on the record it belongs to");
  assert.match(read(path.join(out, "event-9000001.focus.js")), /__GRAPH_FOCUS__ = "event:9000001"/);
  assert.match(record, /<script src="record-prompt\.js"><\/script>/, "and it carries the prompt box's script");
  assert.match(record, /id="record-prompt"/, "the box the player types into");
  const promptJs = read(path.join(out, "record-prompt.js"));
  assert.match(promptJs, /pi:preview-prompt/, "which talks to the app");
  assert.match(promptJs, /\/record-edited /, "and sends a command the agent has a template for");
  assert.match(promptJs, /要改的地方：「/, "with the sentence the player typed");
  assert.match(record, /data-record="event:9000001"/, "the page knows which record it belongs to");
  assert.match(r.stdout, /event-9000001\.record\.html/, "the run lists the record page");
  assert.match(r.stdout, /graph\.html#event:9000001/, "the run prints the graph link too");
  assert.match(r.stdout, /graph\.html/, "the run names the story graph it wrote");
});

test("the run lists every page it wrote, one line each", { skip }, () => {
  const dir = mod({
    "config/cards.json": { 9000001: CARD },
    "config/event/9000001.json": eventAt(9000001, "事件一"),
    "config/event/9000002.json": eventAt(9000002, "事件二"),
    "config/rite/9000003.json": { id: 9000003, name: "测试仪式", cards_slot: [] },
  });
  const r = run(["--mod", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(path.join(dir, ".preview", "index.html")), false, "no list page");
  assert.match(r.stdout, /9000001\.card\.html/, "the card page is named");
  assert.match(r.stdout, /graph\.html/, "the story graph is named");
  assert.doesNotMatch(r.stdout, /cards\.html/, "a card table gets no page of its own");
});
