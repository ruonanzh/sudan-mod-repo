/**
 * script/lib/fixture.mjs — shared fixture builder for the schema tests.
 *
 * Everything here writes to a throwaway directory under os.tmpdir(), so a test can
 * state its intent in one line:
 *
 *   const dir = makeMod({ "config/cards.json": { "9000001": card({ tips: "x" }) } });
 *   const r = lint(dir);
 *   assert.deepEqual(fieldCodes(r), ["LEGACY_FIELD"]);
 *
 * Two rules that keep assertions honest:
 *   1. assert on the rule CODE and the key name, never on the whole sentence;
 *   2. ignore INFO results. A bare mod always produces SPRITE_VANILLA and
 *      PREVIEW_MISSING, which say nothing about the question under test.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_VANILLA } from "../../tools/model.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LINT = path.join(REPO, "tools/lint.mjs");

/** Where each kind lives in a mod. Mirrors `DIR_KIND` in tools/lint.mjs. */
export const FILE_OF = {
  card: "config/cards.json",
  upgrade: "config/upgrade.json",
  tag: "config/tag.json",
  quest: "config/quest.json",
  over: "config/over.json",
  event: "config/event",
  rite: "config/rite",
  loot: "config/loot",
  init: "config/init",
  riteTemplate: "config/rite_template",
  afterStory: "config/after_story",
  wizard: "config/wizard",
  dtRoot: "config/dt",
};

const dirs = [];

/**
 * Write a throwaway mod. `files` maps a repo-relative path to either an object
 * (rendered as JSON) or a string (written verbatim, for JSONC edge cases).
 * A directory-style entry may be given as a directory path, in which case the
 * record is written to `<dir>/<id>.json`, which is what the loader expects.
 */
export function makeMod(files, { info = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sudan-fixture-"));
  dirs.push(dir);
  writeFileSync(
    path.join(dir, "info.json"),
    JSON.stringify(
      { name: "fixture", description: "test fixture", tags: ["Utilities"], version: "1.0.0", ...info },
      null,
      2,
    ),
  );
  for (const [rel, value] of Object.entries(files)) {
    const target = path.join(dir, rel);
    if (rel.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  return dir;
}

/** Remove every directory this process created. Tests call it in `after()`. */
export function cleanupAll() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Run tools/lint.mjs on a directory and return its parsed --json payload. */
export function lint(dir, { vanilla = DEFAULT_VANILLA } = {}) {
  const argv = [LINT, dir, "--json"];
  if (vanilla) argv.push("--vanilla", vanilla);
  const run = spawnSync(process.execPath, argv, { cwd: REPO, encoding: "utf8" });
  if (run.error) throw run.error;
  if (!run.stdout) throw new Error(`lint produced no stdout (exit ${run.status}): ${run.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new Error(`lint output was not JSON (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
  return { ...parsed, status: run.status, stderr: run.stderr };
}

/** FAIL + WARN results only. INFO is ambient noise and never asserted on. */
export function fieldResults(result) {
  return (result.results || []).filter((r) => r.level === "FAIL" || r.level === "WARN");
}

/** Sorted rule codes of the FAIL + WARN results. */
export function fieldCodes(result) {
  return fieldResults(result)
    .map((r) => r.code)
    .sort();
}

/** Messages of one code, joined for substring assertions. */
export function messagesOf(result, code) {
  return fieldResults(result)
    .filter((r) => r.code === code)
    .map((r) => r.message)
    .join("\n");
}

/** The minimal registered shape of each kind, enough that lint has nothing to say. */
export function record(kind, overrides = {}) {
  const base = {
    card: {
      id: 9000001,
      name: "n",
      title: "t",
      text: "x",
      pops: [],
      type: "item",
      rare: 1,
      resource: ["cards/2000001"],
      tag: {},
      card_vanishing: 0,
      vanish: {},
      equips: [],
      is_only: 0,
    },
    tag: { id: 3900001, name: "n", code: "fixture_tag", type: "attribute", text: "x", can_add: 1, can_visible: 1 },
    quest: { id: 3309901, name: "n", text: "x", icon: "cards/2000001", favour_text: "", upgrade_point: 1, target: [] },
  }[kind];
  if (!base) throw new Error(`record(${kind}) has no base shape yet; add one when a test needs it`);
  return { ...base, ...overrides };
}

/** Write one directory-style record: `<dir>/<id>.json`. */
export function oneRecord(kind, body) {
  return { [`${FILE_OF[kind]}/${body.id}.json`]: body };
}
