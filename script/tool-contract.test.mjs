/**
 * The boundary between a tool error and an answer, enforced.
 *
 *   throw        caller mistake or environment cannot start: message starts with a CODE:
 *   PARTIAL      started, a prerequisite is missing; carries NEXT
 *   FAIL         started, the business answer is "no"; carries NEXT
 *   PASS         success; carries no NEXT when a SKILL already says what to do next
 *
 * The static part reads the extension sources; the behavioural part calls each tool with a
 * broken argument and asserts which of the two it is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO, cleanupAll, makeMod } from "./lib/fixture.mjs";
import { loadExtension } from "./lib/load-extension.mjs";

test.after(cleanupAll);

const extensions = () =>
  readdirSync(path.join(REPO, ".pi/extensions"))
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ name: n, text: readFileSync(path.join(REPO, ".pi/extensions", n), "utf8") }));

test("every thrown tool error carries a CODE: prefix", () => {
  const bad = [];
  for (const { name, text } of extensions()) {
    for (const m of text.matchAll(/throw new Error\(\s*(`([^`]*)`|"([^"]*)")/g)) {
      const message = (m[2] ?? m[3] ?? "").trim();
      if (!/^[A-Z][A-Z0-9_]{2,}:/.test(message)) bad.push(`${name}: ${message.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, [], "an error without a code reads like a game answer: add CODE: at the front");
});

test("every FAIL line carries a NEXT step", () => {
  const bad = [];
  for (const { name, text } of extensions()) {
    for (const m of text.matchAll(/`(FAIL:[^`]*)`/g)) {
      const literal = m[1];
      if (literal.includes("NEXT:")) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 240);
      if (after.includes("NEXT:")) continue;
      bad.push(`${name}: ${literal.slice(0, 70)}`);
    }
  }
  assert.deepEqual(bad, [], "a FAIL without NEXT leaves the agent with no next step");
});

test("PASS does not repeat a next step the SKILL already gives", () => {
  const bad = [];
  for (const { name, text } of extensions()) {
    for (const m of text.matchAll(/`(PASS:[^`]*)`/g)) {
      if (/NEXT:/.test(m[1])) bad.push(`${name}: ${m[1].slice(0, 70)}`);
    }
  }
  assert.deepEqual(bad, [], "the SKILL owns the next step after success");
});

test("an illegal call throws with a code; a missing prerequisite is PARTIAL", async () => {
  const inspect = await loadExtension("inspect-game-code.ts");
  await assert.rejects(inspect.execute("c", { action: "type" }, undefined, undefined, { cwd: REPO }), /TARGET_MISSING:/);

  const broken = mkdtempSync(path.join(tmpdir(), "contract-cfg-"));
  mkdirSync(path.join(broken, ".pi"), { recursive: true });
  writeFileSync(path.join(broken, ".pi/decompile.json"), "{ not json");
  await assert.rejects(
    inspect.execute("c", { action: "status" }, undefined, undefined, { cwd: broken }),
    /CONFIG_INVALID:/,
    "a decompile.json the tool cannot read is a tool error",
  );

  const generate = await loadExtension("generate-2d-asset.ts");
  await assert.rejects(generate.execute("c", { action: "fit", in: "x.png" }, undefined, undefined, { cwd: REPO }), /INVALID_ARGS:/);
});

test("a tool that worked returns PASS and no NEXT", async () => {
  const tool = await loadExtension("install-mod.ts");
  const home = mkdtempSync(path.join(tmpdir(), "contract-install-"));
  const root = path.join(home, "SultansGame", "Mod");
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(home, "SultansGame", "ModLog"), { recursive: true });
  writeFileSync(path.join(home, "SultansGame", "ModLog", "__mod.log"), "");
  const cwd = mkdtempSync(path.join(tmpdir(), "contract-ws-"));
  writeFileSync(path.join(cwd, ".gamer-agent.local.json"), JSON.stringify({ modInstallDir: root }));
  const result = await tool.execute("c", { modDir: makeMod({}) }, undefined, undefined, { cwd });
  const text = result.content.map((c) => c.text).join("\n");
  assert.match(text, /^PASS:/);
  assert.doesNotMatch(text, /NEXT:/);
});
