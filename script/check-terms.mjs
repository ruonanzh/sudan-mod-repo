#!/usr/bin/env node
/**
 * script/check-terms.mjs — enforce `script/prompt-standard.md`.
 *
 *   node script/check-terms.mjs                     check AGENTS.md and every SKILL.md
 *   node script/check-terms.mjs --files <path> ...  check these files instead
 *   node script/check-terms.mjs --strict            treat an untranslated file as a failure
 *   node script/check-terms.mjs --tools <dir>       check tool messages in this dir
 *   node script/check-terms.mjs --standard <path>   read another copy of the standard
 *
 * Three checks, each one a promise the standard makes:
 *
 * 1. **A key name sits in backticks.** In Chinese prose the reader cannot tell `condition` the
 *    key from 条件 the idea. Backticks are the divider, so a bare key is an error.
 * 2. **No banned synonym.** The standard lists, per concept, the words that must not be used.
 *    One concept one word is what keeps a long document navigable.
 * 3. **A tool message is ASCII.** Windows GBK turns anything else into mojibake, and these
 *    messages are read on both platforms.
 *
 * A file with no CJK prose is *pending translation*, not a violation: the SKILL.md files are
 * being translated one batch at a time, and a red suite for work not yet started would train
 * everyone to ignore it. `--strict` makes pending a failure, which is what the last batch does.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ARGV = process.argv.slice(2);
const valuesOf = (flag) => {
  const out = [];
  ARGV.forEach((a, i) => {
    if (a === flag && ARGV[i + 1]) out.push(ARGV[i + 1]);
  });
  return out;
};
const has = (flag) => ARGV.includes(flag);
const valueOf = (flag, dflt = null) => valuesOf(flag)[0] || dflt;

const STANDARD = valueOf("--standard", path.join(REPO, "script/prompt-standard.md"));
const STRICT = has("--strict");
const FILE_ARGS = valuesOf("--files");
const TOOLS_DIR = valueOf("--tools", path.join(REPO, "tools"));

// ---------------------------------------------------------------- parse the standard

/** Text between `<!-- name:begin -->` and `<!-- name:end -->`. */
function block(text, name) {
  const begin = text.indexOf(`<!-- terms:${name}:begin -->`);
  const end = text.indexOf(`<!-- terms:${name}:end -->`);
  if (begin < 0 || end < 0 || end < begin) return "";
  return text.slice(begin, end);
}

/** Split a markdown table body into rows of trimmed cells, skipping header and rule rows. */
function tableRows(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .filter((line) => !/^\|\s*-+/.test(line))
    .filter((line) => !/^\|\s*(键|英文)\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((c) => c.trim()));
}

/**
 * `keys` → the key names that must sit in backticks. A row whose Chinese column says 不译 or
 * 保留英文 is a word, not a key (`mod` is the whole subject of the repo), so it is not enforced:
 * writing 「mod 根目录」 is correct and demanding backticks there would train people to ignore us.
 */
function readKeyTerms(standard) {
  const out = [];
  for (const cells of tableRows(block(standard, "keys"))) {
    const [first = "", chinese = ""] = cells;
    if (/不译|保留英文/.test(chinese)) continue;
    for (const m of first.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** `concepts` → [{banned, accepted, english}] */
function readConceptTerms(standard) {
  const out = [];
  for (const cells of tableRows(block(standard, "concepts"))) {
    const [english = "", accepted = "", banned = ""] = cells;
    const words = banned.split(/[、,，]/).map((w) => w.trim()).filter((w) => w && w !== "—" && w !== "-");
    const zh = (accepted.match(/[\u4e00-\u9fff]+/g) || []).join("");
    for (const w of words) out.push({ banned: w, accepted: zh || accepted, english });
  }
  return out;
}

// ---------------------------------------------------------------- check one prose file

const CJK = /[\u4e00-\u9fff]/;

/** Blank out fenced code, inline code and HTML comments, keeping line numbers stable. */
function maskNonProse(text) {
  const lines = text.split("\n");
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return "";
    }
    if (fenced) return "";
    return line
      .replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\]\([^)]*\)/g, "]"); // link targets are paths, not prose
  });
}

function checkProse(file, keys, concepts) {
  const text = readFileSync(file, "utf8");
  const rel = path.relative(REPO, file) || file;
  // A file is "translated" when Chinese is a real share of it. An English file that happens to
  // name the game in Chinese (苏丹的游戏) is 0.1% CJK and must not be reported as violations.
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const density = cjkChars / Math.max(text.replace(/\s/g, "").length, 1);
  if (density < 0.05) return { file: rel, pending: true, problems: [] };

  const problems = [];
  const prose = maskNonProse(text);
  prose.forEach((line, i) => {
    if (!CJK.test(line)) return; // a line with no Chinese is a command, a key list or a table row
    const where = `${rel}:${i + 1}`;
    for (const key of keys) {
      const re = new RegExp(`(?<![A-Za-z0-9_\`])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "g");
      if (re.test(line)) problems.push(`${where} 键名 ${key} 没有反引号（指键时写 \`${key}\`，指机制时写中文）`);
    }
    for (const term of concepts) {
      if (line.includes(term.banned)) problems.push(`${where} 禁用说法「${term.banned}」，应写「${term.accepted}」（${term.english}）`);
    }
  });
  return { file: rel, pending: false, problems };
}

// ---------------------------------------------------------------- check tool messages

/** Strings passed to fail()/warn()/info(): the text a player or agent actually reads. */
function checkTools(dir) {
  const problems = [];
  let files = [];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith(".mjs") || n.endsWith(".ts"));
  } catch {
    return problems;
  }
  for (const name of files) {
    const full = path.join(dir, name);
    if (!statSync(full).isFile()) continue;
    const src = readFileSync(full, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/\b(fail|warn|info)\(/.test(line)) return;
      // Only the quoted argument matters; the code on the same line may contain anything.
      for (const m of line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
        const s = m[1];
        if (/[^\x00-\x7f]/.test(s)) problems.push(`${path.relative(REPO, full)}:${i + 1} 工具消息必须 ASCII：${JSON.stringify(s).slice(0, 60)}`);
      }
    });
  }
  return problems;
}

// ---------------------------------------------------------------- main

let standard;
try {
  standard = readFileSync(STANDARD, "utf8");
} catch {
  process.stderr.write(`standard not found: ${STANDARD}\n`);
  process.exit(2);
}
const keys = readKeyTerms(standard);
const concepts = readConceptTerms(standard);
if (!keys.length) {
  process.stderr.write("the standard has no key table (terms:keys block)\n");
  process.exit(2);
}

const targets = FILE_ARGS.length
  ? FILE_ARGS
  : [path.join(REPO, "AGENTS.md"), ...readdirSync(path.join(REPO, ".pi/skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(REPO, ".pi/skills", d.name, "SKILL.md"))
      .filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile())];

const results = targets.map((f) => checkProse(f, keys, concepts));
const toolProblems = checkTools(TOOLS_DIR);

const problems = [...results.flatMap((r) => r.problems), ...toolProblems];
const pending = results.filter((r) => r.pending).map((r) => r.file);

for (const r of results) if (!r.pending) process.stdout.write(`checked  ${r.file}\n`);
if (pending.length) process.stdout.write(`pending  ${pending.join(", ")}  (no Chinese prose yet; --strict fails on this)\n`);
for (const p of problems) process.stdout.write(`FAIL     ${p}\n`);

const failed = problems.length > 0 || (STRICT && pending.length > 0);
if (failed) {
  process.stdout.write(`\n${problems.length} violation(s), ${pending.length} pending\nRESULT: FAIL\n`);
  process.exit(1);
}
process.stdout.write(`\n${results.length - pending.length} file(s) checked, ${pending.length} pending, 0 violation(s)\nRESULT: PASS\n`);
