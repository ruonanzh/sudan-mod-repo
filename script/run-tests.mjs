#!/usr/bin/env node
/**
 * script/run-tests.mjs — one entry point for every test in this repo.
 *
 *   node script/run-tests.mjs                 all suites under tools/ and script/
 *   node script/run-tests.mjs fields          only files matching "fields"
 *   node script/run-tests.mjs --verbose       print the full output of failing suites
 *
 * The repository has two homes for tests: `tools/*.test.mjs` (one file per module,
 * written before this script existed) and `script/*.test.mjs` (the schema work).
 * Nothing is moved: this runner collects both so that a single command answers
 * "is the repo green".
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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

if (!files.length) {
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

const passTotal = results.reduce((a, r) => a + r.pass, 0);
const failTotal = results.reduce((a, r) => a + r.fail, 0);
const redSuites = results.filter((r) => r.fail > 0 || r.code !== 0).length;

process.stdout.write(`\n${results.length} suites, ${passTotal} pass, ${failTotal} fail\n`);
if (redSuites) {
  process.stdout.write(`RESULT: FAIL (${redSuites} suite(s) red)\n`);
  process.exit(1);
}
process.stdout.write("RESULT: PASS\n");
