/**
 * tools/preview.mjs, where pages land: --out and --focus. Each case spawns the CLI, so this is its
 * own suite and runs beside the graph cases instead of behind them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skip, run, mod, CARD, eventAt } from "./lib/preview-fixture.mjs";

test("--out decides where the pages land, and the default directory is left alone", { skip }, () => {
  const dir = mod({ "config/event/9000001.json": eventAt(9000001, "新事件") });
  const out = path.join(mkdtempSync(path.join(tmpdir(), "preview-out-")), "pages");
  const r = run(["--mod", dir, "--out", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(path.join(out, "index.html")), false, "no list page is written");
  assert.equal(existsSync(path.join(out, "graph.html")), true);
  assert.match(r.stdout, /graph\.html/, "the run names the page it wrote under --out");
  assert.equal(existsSync(path.join(dir, ".preview")), false);
});

test("--focus must name a record the mod carries, and a typo writes nothing", { skip }, () => {
  const dir = mod({ "config/event/9000001.json": eventAt(9000001, "新事件") });
  const r = run(["--mod", dir, "--focus", "event:5300090"]);
  assert.equal(r.status, 1, "a focus the mod does not carry is caught before any page is written");
  assert.match(r.stdout, /^FAIL {2}focus event:5300090/, "and named");
  assert.equal(existsSync(path.join(dir, ".preview")), false);
});

// SAMPLE_CARDS, cardMod, cardPageFile and editPage live in script/lib/preview-fixture.mjs.
