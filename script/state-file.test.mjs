#!/usr/bin/env node
/**
 * state-file test — the state file is `.gamer-agent.local.json`, and the names the path work
 * retired are not back.
 *
 *   node --test script/state-file.test.mjs
 *
 * Two things can only be caught by a scan, because neither is a type error:
 *
 * 1. The path record used to live in a file named `paths.json` under the `.pi` folder; it was
 *    tracked by git and the writer is gone. A stale reader would be invisible: the file it looks
 *    in no longer exists, so every location would quietly come from discovery and a recorded
 *    path would be ignored.
 * 2. The keys and report rows were renamed (`gameDir`, `workshopDir`, `modInstallDir`, and the
 *    derived `vanilla` row). A description string or a comment that still names the old key sends
 *    the reader to the wrong place, so this is a scan rather than a grep-only convention.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";

/** The replaced path record, assembled from pieces so this file does not match its own scan. */
const OLD_FILE = [".pi", `paths${".json"}`].join("/");

/** The retired names, assembled for the same reason. */
const RETIRED = {
  steam: `ste${"am"}`,
  modRoot: `mod${"Root"}`,
  dump: `du${"mp"}`,
  venv: `ve${"nv"}`,
};

/** Directories and the one skill file that describe or read where the game is. */
const SCANNED = ["tools", ".pi/extensions", "script", ".pi/skills/setup-workspace/SKILL.md"];

/**
 * The files that define or report the paths. `modRoot` is only banned here: `tools/lint.mjs`
 * has a `--mod-root` of its own, the folder of mods to lint, which is a different argument.
 */
const PATH_FILES = [
  "tools/paths.mjs",
  "tools/setup.mjs",
  ".pi/extensions/check-game-paths.ts",
  ".pi/extensions/set-game-dir.ts",
  ".pi/extensions/try-set-game-dir.ts",
  ".pi/lib/paths-report.ts",
  ".pi/lib/state.ts",
  "script/paths.test.mjs",
  "script/extensions.test.mjs",
  "script/setup-check.test.mjs",
  ".pi/skills/setup-workspace/SKILL.md",
];

/** Every text file under a scanned root, so a `.ts`, `.mjs`, `.json` or `.md` all count. */
function textFiles(target) {
  const full = path.join(REPO, target);
  if (statSync(full).isFile()) return [full];
  const out = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const child = path.join(full, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(path.relative(REPO, child)));
    else if (/\.(mjs|js|ts|json|md|jsonc)$/.test(entry.name)) out.push(child);
  }
  return out;
}

test("the replaced path record is named nowhere the tools or the skill can see it", () => {
  const hits = [];
  for (const target of SCANNED) {
    for (const file of textFiles(target)) {
      if (readFileSync(file, "utf8").includes(OLD_FILE)) hits.push(path.relative(REPO, file));
    }
  }
  assert.deepEqual(hits, [], `these files still name ${OLD_FILE}: ${hits.join(", ")}`);
});

test(`no state key or tool parameter is still ${RETIRED.steam}`, () => {
  const key = new RegExp(`["'\`]${RETIRED.steam}["'\`]|--${RETIRED.steam}\\b`);
  const hits = [];
  for (const target of SCANNED) {
    for (const file of textFiles(target)) {
      const src = readFileSync(file, "utf8");
      for (const [index, line] of src.split("\n").entries()) {
        if (key.test(line)) hits.push(`${path.relative(REPO, file)}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(hits, [], `these lines still use ${RETIRED.steam} as a key or parameter: ${hits.join(", ")}`);
});

test(`no state key or tool parameter is still ${RETIRED.modRoot}`, () => {
  const key = new RegExp(`${RETIRED.modRoot}|--mod-root`);
  const hits = PATH_FILES.filter((file) => key.test(readFileSync(path.join(REPO, file), "utf8")));
  assert.deepEqual(hits, [], `these files still use ${RETIRED.modRoot} as a key or parameter: ${hits.join(", ")}`);
});

test("the dump and venv rows are gone from the report and from the skill", () => {
  const skill = readFileSync(path.join(REPO, ".pi/skills/setup-workspace/SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /^\|\s*`?(?:dump|venv)`?\s*\|/m, "the skill still has a dump/venv table row");
  assert.doesNotMatch(skill, /(?:dump|venv)[^\n]{0,12}两行/, "the skill still says the report has dump/venv rows");

  const rowOf = new RegExp(`row\\(\\s*["'\`](?:${RETIRED.dump}|${RETIRED.venv})["'\`]`);
  for (const file of ["tools/paths.mjs", ".pi/extensions/check-game-paths.ts", ".pi/extensions/try-set-game-dir.ts"]) {
    assert.doesNotMatch(readFileSync(path.join(REPO, file), "utf8"), rowOf, `${file} still reports a dump/venv row`);
  }
});
