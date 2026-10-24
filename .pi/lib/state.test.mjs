/**
 * The state file is the only memory between sessions: a corrupted one must not be overwritten.
 * Runs under bun (`bun test ./.pi/lib/state.test.mjs`), like decompile.test.mjs.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readState, writeState, statePath } from "./state";

test("a corrupted state file is moved aside, never overwritten", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-corrupt-"));
  const file = statePath(cwd);
  writeFileSync(file, "{ this is not json");
  expect(() => writeState(cwd, { dotnet: "/x" })).toThrow(/STATE_CORRUPT/);
  expect(existsSync(file)).toBe(false);
  const kept = readdirSync(cwd).filter((n) => n.includes(".corrupt-"));
  expect(kept.length).toBe(1);
  expect(readFileSync(path.join(cwd, kept[0]), "utf8")).toBe("{ this is not json");
});

test("a missing state file starts empty and a second write keeps earlier keys", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-new-"));
  expect(readState(cwd)).toEqual({});
  writeState(cwd, { gameDir: "/g" });
  writeState(cwd, { dotnet: "/d" });
  expect(readState(cwd)).toEqual({ gameDir: "/g", dotnet: "/d" });
});
