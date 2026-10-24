#!/usr/bin/env node
/**
 * script/run-tests.mjs — one entry point for every test in this repo.
 *
 *   node script/run-tests.mjs                 all suites under tools/ and script/
 *   node script/run-tests.mjs fields          only files matching "fields"
 *   node script/run-tests.mjs --verbose       print the full output of failing suites
 *
 * The repository has three homes for tests: `tools/*.test.mjs` (one file per module,
 * written before this script existed), `script/*.test.mjs` (the schema work) and
 * `.pi/lib/*.test.mjs` (the extension-side libraries, which use `bun:test`).
 * Nothing is moved: this runner collects all three so that one command answers
 * "is the repo green". The `.pi/lib` files run under bun; a machine without bun gets a
 * SKIP line, never a silent gap.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes("--verbose");
const FILTER = ARGS.find((a) => !a.startsWith("-")) || "";

const files = ["tools", "script"]
  .flatMap((dir) => {
    let names;
    try {
      names = readdirSync(path.join(REPO, dir));
    } catch {
      return []; // script/ may not exist yet
    }
    return names
      .filter((n) => n.endsWith(".test.mjs"))
      .filter((n) => !FILTER || n.includes(FILTER))
      .sort()
      .map((n) => path.join(dir, n));
  });

// `.pi/lib` suites use bun:test. They count when the filter matches them, so a filter that only
// names a library test is not "no such test".
const libFiles = (() => {
  try {
    return readdirSync(path.join(REPO, ".pi/lib"))
      .filter((n) => n.endsWith(".test.mjs"))
      .filter((n) => !FILTER || n.includes(FILTER))
      .sort();
  } catch {
    return [];
  }
})();

if (!files.length && !libFiles.length) {
  process.stderr.write(`no test file matched "${FILTER}"\n`);
  process.exit(2);
}

/** Run one suite and return { file, pass, fail, output, code }. */
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", file], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("close", (code) => {
      // Node prints "ℹ pass 7" with the spec reporter and "# pass 7" with tap.
      const grab = (name) => {
        const m = out.match(new RegExp(`^[^\\n]*?\\b${name} (\\d+)$`, "m"));
        return m ? Number(m[1]) : null;
      };
      const pass = grab("pass") ?? 0;
      const fail = grab("fail") ?? 0;
      resolve({ file, pass, fail, output: out, code });
    });
  });
}

const results = [];
for (const file of files) {
  const r = await runOne(file);
  results.push(r);
  const label = r.fail === 0 && r.code === 0 ? "PASS" : "FAIL";
  process.stdout.write(`${label}  ${String(r.pass).padStart(3)} pass  ${String(r.fail).padStart(2)} fail  ${r.file}\n`);
  if (!(r.fail === 0 && r.code === 0)) {
    // The failing test names are the whole point of a red run: keep them.
    const lines = r.output.split("\n").filter((l) => /✖|not ok|Error|AssertionError/.test(l));
    process.stdout.write(lines.slice(0, 30).map((l) => `        ${l.trim()}`).join("\n") + "\n");
    if (VERBOSE) process.stdout.write(r.output + "\n");
  }
}

// Run the bun suites when bun exists, and say so when it does not: a missing runner must not
// look like "these tests passed".
if (libFiles.length) {
  {
    const r = await runBun(libFiles.map((n) => `./.pi/lib/${n}`));
    if (r === null) {
      process.stdout.write("SKIP    bun is not installed; .pi/lib tests did not run\n");
      skippedSuites += 1;
    } else {
      results.push({ file: ".pi/lib (bun)", pass: r.pass, fail: r.fail, code: r.code, output: r.output });
      const label = r.fail === 0 && r.code === 0 ? "PASS" : "FAIL";
      process.stdout.write(`${label}  ${String(r.pass).padStart(3)} pass  ${String(r.fail).padStart(2)} fail  .pi/lib (bun)\n`);
      if (!(r.fail === 0 && r.code === 0)) process.stdout.write(r.output.split("\n").filter((l) => /fail|error/i.test(l)).slice(0, 20).join("\n") + "\n");
    }
  }
}

/** Run bun on a list of files; null when bun is not on this machine. */
function runBun(files) {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return null;
  const r = spawnSync("bun", ["test", ...files], { cwd: REPO, encoding: "utf8" });
  const output = `${r.stdout || ""}${r.stderr || ""}`;
  const pass = Number((output.match(/(\d+) pass/) || [])[1] ?? 0);
  const fail = Number((output.match(/(\d+) fail/) || [])[1] ?? 0);
  return { pass, fail, code: r.status ?? 1, output };
}

let skippedSuites = 0;

const passTotal = results.reduce((a, r) => a + r.pass, 0);
const failTotal = results.reduce((a, r) => a + r.fail, 0);
const redSuites = results.filter((r) => r.fail > 0 || r.code !== 0).length;

process.stdout.write(`\n${results.length} suites, ${passTotal} pass, ${failTotal} fail${skippedSuites ? `, ${skippedSuites} skipped` : ""}\n`);
if (redSuites) {
  process.stdout.write(`RESULT: FAIL (${redSuites} suite(s) red)\n`);
  process.exit(1);
}
process.stdout.write(`RESULT: PASS${skippedSuites ? " (with skipped suites)" : ""}\n`);
