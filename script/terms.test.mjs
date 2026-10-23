#!/usr/bin/env node
/**
 * terms test — `script/prompt-standard.md` is only a standard if a command enforces it.
 *
 *   node --test script/terms.test.mjs
 *
 * The standard makes three promises, so there are three checks: a key name in Chinese prose
 * must sit in backticks (otherwise the reader cannot tell the key from the everyday word), a
 * banned synonym must not be used, and a tool message must be ASCII (Windows GBK turns anything
 * else into mojibake). Each case below builds the smallest file that breaks one promise and
 * asserts the checker names both the file and the offending word.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO } from "./lib/fixture.mjs";

const CHECKER = path.join(REPO, "script/check-terms.mjs");
const STANDARD = path.join(REPO, "script/prompt-standard.md");

/** Run the checker against an explicit file list, so the repo's own state is not involved. */
function run(files, extra = []) {
  return spawnSync(process.execPath, [CHECKER, "--standard", STANDARD, ...files.flatMap((f) => ["--files", f]), ...extra], {
    cwd: REPO,
    encoding: "utf8",
  });
}

function tmpFile(name, body) {
  const dir = mkdtempSync(path.join(tmpdir(), "sudan-terms-"));
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

test("T1 the repository as committed satisfies its own standard", () => {
  const r = spawnSync(process.execPath, [CHECKER], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, `the checker reports violations:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /PASS|RESULT: PASS/, "a clean run must say so");
});

test("T2 a bare key name in prose fails and names the key", () => {
  const file = tmpFile("doc.md", "这里说的是 settlement_prior 的判定方式。\n");
  const r = run([file]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /settlement_prior/);
  assert.match(r.stdout + r.stderr, /backtick|反引号/);
});

test("T3 the same key inside backticks passes", () => {
  const file = tmpFile("doc.md", "这里说的是 `settlement_prior` 的判定方式。\n");
  assert.equal(run([file]).status, 0);
});

test("T4 a fenced code block is not prose and is skipped", () => {
  const file = tmpFile("doc.md", "说明：\n\n```jsonc\n{ \"settlement\": [] }\n```\n");
  assert.equal(run([file]).status, 0, "code samples must not be checked for backticks");
});

test("T5 a banned synonym fails and gives the replacement", () => {
  // `废弃键` is listed as 禁写 for dead key; the accepted word is 死键.
  const file = tmpFile("doc.md", "这类废弃键在加载时不会报错。\n");
  const r = run([file]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /废弃键/);
  assert.match(r.stdout + r.stderr, /死键/, "the message must say what to write instead");
});

test("T6 a long key name that merely contains a shorter one is not a hit", () => {
  // `settlement` occurs inside `settlement_prior`; only the standalone word may be reported.
  const file = tmpFile("doc.md", "`settlement_prior` 与 `settlement_extre` 都是数组。\n");
  assert.equal(run([file]).status, 0);
});

test("T9 a banned stage word fails and names the stage word", () => {
  // The same action was called 写 config / 制作 mod / 写 json in different documents. One name now.
  const file = tmpFile("doc.md", "确认之后，再写 config 并安装。\n");
  const r = run([file]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /写 config/);
  assert.match(r.stdout + r.stderr, /写配置记录/);
});

test("T10 the accepted stage word passes", () => {
  const file = tmpFile("doc.md", "确认之后，再写配置记录，然后安装。\n");
  assert.equal(run([file]).status, 0);
});

test("T7 a tool message with non-ASCII text fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sudan-tools-"));
  writeFileSync(
    path.join(dir, "lint.mjs"),
    'export function f(){ warn("LEGACY_FIELD", "config/event/1.json", "这个键没人读"); }\n',
  );
  const r = spawnSync(process.execPath, [CHECKER, "--standard", STANDARD, "--tools", dir], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /lint\.mjs/);
  assert.match(r.stdout + r.stderr, /ASCII/);
});

test("T8 an English file is reported as pending, not as a violation", () => {
  // The SKILL.md files are still English. Until each is translated the checker must stay green
  // and say which ones are left, or the suite goes red for work that has not been done yet.
  const file = tmpFile("skill.md", "A key that is not listed for that node is never read.\n");
  const r = run([file]);
  assert.equal(r.status, 0, "an untranslated file is pending work, not a violation");
  assert.match(r.stdout, /pending/i);
  const strict = run([file], ["--strict"]);
  assert.equal(strict.status, 1, "--strict turns pending into a failure");
});

test("a folded description is a violation: the fold eats a space in the middle of a sentence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "terms-desc-"));
  const file = path.join(dir, "SKILL.md");
  writeFileSync(file, "---\nname: probe\ndescription: >\n  第一行，\n  第二行。\n---\n\n正文。\n");
  const r = spawnSync(process.execPath, [CHECKER, "--files", file], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /description must be one line/);

  writeFileSync(file, "---\nname: probe\ndescription: 第一行，第二行。\n---\n\n正文。\n");
  const ok = spawnSync(process.execPath, [CHECKER, "--files", file], { cwd: REPO, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});
