#!/usr/bin/env node
/**
 * The 2D asset tool as the agent sees it: four actions, a generic name, and no card knowledge.
 *
 *   node --test script/generate-2d-asset.test.mjs
 *
 * The card recipe (472×1028, which reference picture) belongs to `card-art` SKILL. If this file
 * ever starts talking about cards, the tool has stopped being reusable and the SKILL has lost its
 * single home.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO, cleanupAll } from "./lib/fixture.mjs";
import { loadExtension } from "./lib/load-extension.mjs";
import { decodePng, encodePng, solid } from "../tools/png.mjs";

after(cleanupAll);

const SOURCE = path.join(REPO, ".pi", "extensions", "generate-2d-asset.ts");
const tool = await loadExtension("generate-2d-asset.ts");
const run = (params, cwd) => tool.execute("t", params, undefined, undefined, { cwd });
const textOf = (r) => (r.content || []).map((c) => c.text || "").join("\n");

const dir = () => mkdtempSync(path.join(tmpdir(), "asset-"));

test("G1 the tool is named for the job, not for cards", () => {
  assert.equal(tool.name, "generate_2d_asset");
  const surface = `${tool.description}\n${JSON.stringify(tool.parameters)}\n${(tool.promptGuidelines || []).join("\n")}`;
  assert.doesNotMatch(surface, /472|1028/, "no card size is baked into what the agent sees");
  assert.doesNotMatch(surface, /card-art|cards\//, "the tool does not know where card pictures live");
});

test("G2 the four actions are the whole surface", () => {
  const source = readFileSync(SOURCE, "utf8");
  for (const action of ["generate", "fit", "check", "refs"]) assert.ok(source.includes(action), `missing action ${action}`);
  const params = tool.parameters?.properties?.action;
  assert.ok(params, "action is a parameter");
});

test("G3 every guideline names the tool", () => {
  for (const line of tool.promptGuidelines || []) assert.match(line, /generate_2d_asset/, line);
  assert.ok((tool.promptGuidelines || []).length >= 3);
});

test("G4 fit writes the size the caller asked for", () => {
  const home = dir();
  const src = path.join(home, "in.png");
  writeFileSync(src, encodePng(solid(20, 30, "#224466")));
  const out = path.join(home, "out.png");
  return run({ action: "fit", in: src, out, width: 6, height: 9 }, home).then((r) => {
    assert.match(textOf(r), /PASS/);
    const img = decodePng(readFileSync(out));
    assert.equal(img.width, 6);
    assert.equal(img.height, 9);
  });
});

test("G5 check reports a wrong size as FAIL, with the fix", async () => {
  const home = dir();
  const file = path.join(home, "wrong.png");
  writeFileSync(file, encodePng(solid(3, 4, "#224466")));
  const r = await run({ action: "check", file, width: 6, height: 9 }, home);
  const text = textOf(r);
  assert.match(text, /FAIL/);
  assert.match(text, /SIZE_MISMATCH|fit/);
});

test("G6 refs lists what is missing", async () => {
  const home = dir();
  writeFileSync(path.join(home, "one.png"), encodePng(solid(2, 2, "#224466")));
  const r = await run({ action: "refs", dir: home, expect: ["one.png", "two.png"] }, home);
  assert.match(textOf(r), /two\.png/);
});

test("G7 a generation with no out is refused as a tool error before any network call", async () => {
  const home = dir();
  // A missing argument is the caller's mistake, so the tool throws instead of answering FAIL.
  await assert.rejects(run({ action: "generate", prompt: "x" }, home), /out|NO_OUT/);
  assert.ok(!existsSync(path.join(home, "image")), "nothing was written under image/");
});
