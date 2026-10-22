#!/usr/bin/env node
/**
 * state-file test — the state file is `.gamer-agent.local.json`, and nothing still names the
 * file it replaced.
 *
 *   node --test script/state-file.test.mjs
 *
 * The path record used to live in a file named `paths.json` under the `.pi` folder; it was
 * tracked by git and the writer is gone. A stale reader would be invisible: the file it looks
 * in no longer exists, so every location would quietly come from discovery and a recorded
 * path would be ignored. The scan below is the guard, and it is a scan rather than a
 * grep-only convention because a description string or a comment that still names the old
 * file sends the reader to the wrong place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";

/** The replaced path record, assembled from pieces so this file does not match its own scan. */
const OLD_FILE = [".pi", `paths${".json"}`].join("/");

/** Directories and the one skill file that describe or read where the game is. */
const SCANNED = ["tools", ".pi/extensions", "script", ".pi/skills/setup-workspace/SKILL.md"];

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
