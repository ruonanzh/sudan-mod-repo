#!/usr/bin/env node
/**
 * field-labels test — every live key carries a Chinese label, a one-line note and a source.
 *
 *   node --test script/field-labels.test.mjs
 *
 * `schema/fields.json` says which keys the game reads and where. It does not say what they
 * *mean*, so a page that prints the table still reads as a wall of English field names. This
 * file is the missing half: for each of the 310 live keys, a label a player understands, one
 * sentence about how the game treats it, and a pointer to the paragraph that proves it.
 *
 * The labels are hand-maintained (like `fields.json`): seven agents wrote them once, in
 * parallel, one fragment per group of kinds, and the fragments were merged and deleted. Editing
 * this file directly is the way to change a label; the test below is what keeps it complete.
 *
 * The source is not decoration. The research under
 * `desktop-gamer-agent-pi/docs/sudan-game/` is the only place a claim may come from, so every
 * entry names a file there that exists on disk. An entry with no source is an opinion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO } from "./lib/fixture.mjs";

const FIELDS = JSON.parse(readFileSync(path.join(REPO, "schema/fields.json"), "utf8"));
const LABELS_PATH = path.join(REPO, "schema/view/field-labels.json");

/** Research root: the planning repo, sibling of this one. */
export const RESEARCH = path.resolve(REPO, "../desktop-gamer-agent-pi/docs/sudan-game");

const HAS_CJK = /[\u4e00-\u9fff]/;

function loadLabels() {
  if (!existsSync(LABELS_PATH)) return null;
  return JSON.parse(readFileSync(LABELS_PATH, "utf8"));
}

/** Flatten `{kind: {key: entry}}`, skipping the `_shared` table. */
function entriesOf(labels) {
  const out = [];
  for (const [kind, spec] of Object.entries(labels)) {
    if (kind.startsWith("_")) continue;
    for (const [key, entry] of Object.entries(spec)) out.push({ kind, key, entry });
  }
  return out;
}

test("L1 the label file exists and covers every live key", () => {
  const labels = loadLabels();
  assert.ok(labels, "schema/view/field-labels.json is missing");
  const missing = [];
  for (const [kind, spec] of Object.entries(FIELDS)) {
    const shared = labels._shared || {};
    const own = labels[kind] || {};
    for (const key of spec.fields) if (!own[key] && !shared[key]) missing.push(`${kind}.${key}`);
  }
  assert.deepEqual(missing, [], `keys with no label: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` … (${missing.length} total)` : ""}`);
});

test("L2 no label for a key the game does not read", () => {
  const labels = loadLabels();
  const shared = Object.keys(labels._shared || {});
  const orphans = [];
  for (const { kind, key } of entriesOf(labels)) {
    const spec = FIELDS[kind];
    if (!spec) {
      orphans.push(`${kind}.${key} (unknown kind)`);
      continue;
    }
    if (!spec.fields.includes(key)) orphans.push(`${kind}.${key} (not a live key)`);
  }
  for (const key of shared) {
    const used = Object.values(FIELDS).some((s) => s.fields.includes(key));
    if (!used) orphans.push(`_shared.${key} (no kind reads it)`);
  }
  assert.deepEqual(orphans, [], `labels for keys that do not exist: ${orphans.slice(0, 20).join(", ")}`);
});

test("L3 every entry has a Chinese label, a note, and a research source", () => {
  const labels = loadLabels();
  const problems = [];
  const all = [...entriesOf(labels), ...Object.entries(labels._shared || {}).map(([key, entry]) => ({ kind: "_shared", key, entry }))];
  for (const { kind, key, entry } of all) {
    const where = `${kind}.${key}`;
    if (entry.todo) problems.push(`${where}: still a TODO`);
    if (!entry.label || !HAS_CJK.test(entry.label)) problems.push(`${where}: label is not Chinese (${JSON.stringify(entry.label)})`);
    if (entry.label === key) problems.push(`${where}: label is the English key`);
    if (!entry.note || !HAS_CJK.test(entry.note)) problems.push(`${where}: note missing or not Chinese`);
    if (!entry.from) {
      problems.push(`${where}: no source`);
    } else {
      // `from` is "docs/sudan-game/fields/<file>.md §<heading>". Check the file, then check that
      // the heading is really in it: a citation that cannot be followed is not a citation.
      const [filePart, heading] = entry.from.split(" §");
      const rel = filePart.replace(/^docs\/sudan-game\//, "");
      const full = path.join(RESEARCH, rel);
      if (!existsSync(full)) {
        problems.push(`${where}: source file does not exist: ${filePart}`);
      } else if (heading) {
        const body = readFileSync(full, "utf8").replace(/`/g, "");
        if (!body.includes(heading.replace(/`/g, ""))) {
          problems.push(`${where}: heading not found in ${rel}: "§${heading}"`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.slice(0, 25).join("\n"));
});

test("L4 a note is one sentence, not a paragraph", () => {
  const labels = loadLabels();
  const long = [];
  for (const { kind, key, entry } of entriesOf(labels)) {
    if (typeof entry.note !== "string") continue;
    const sentences = entry.note.split(/[。；]/).filter((s) => s.trim());
    if (sentences.length > 2) long.push(`${kind}.${key} (${sentences.length} sentences)`);
    if (entry.note.length > 120) long.push(`${kind}.${key} (${entry.note.length} chars)`);
  }
  assert.deepEqual(long, [], `notes must stay short, the detail belongs in the research: ${long.slice(0, 15).join(", ")}`);
});

test("L4b the shop notes name their subject instead of saying 它", () => {
  const labels = loadLabels();
  const bad = [];
  for (const [key, entry] of Object.entries(labels.upgrade || {})) {
    if (typeof entry.note !== "string") continue;
    if (!/^(这个|这段)/.test(entry.note)) bad.push(`${key}: 开头没有主语`);
    if (/它|其|该/.test(entry.note)) bad.push(`${key}: 用了指代`);
  }
  assert.deepEqual(bad, [], `shop notes must name their subject: ${bad.join(", ")}`);
});

// ---------------------------------------------------------------- labels follow the glossary

/** Read the `terms:keys` table of the prompt standard: key -> the Chinese gloss we agreed on. */
function glossary(standardPath) {
  const text = readFileSync(standardPath, "utf8");
  const begin = text.indexOf("<!-- terms:keys:begin -->");
  const end = text.indexOf("<!-- terms:keys:end -->");
  const rows = text.slice(begin, end).split("\n").filter((l) => l.startsWith("|"));
  const map = new Map();
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || /^\|?-+/.test(cells[0]) || cells[0] === "键") continue;
    const keys = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (/不译|保留英文/.test(cells[1])) continue;
    // One row can name two keys with two glosses ("`settlement` / `settlement_extre`" -> 正常结算 / 附加结算).
    const parts = cells[1].split(/\s*[\/／、]\s*/).map((c) => (c.match(/[\u4e00-\u9fff]+/g) || []).join(""));
    parts.forEach((gloss, i) => {
      const key = keys[i] ?? keys[keys.length - 1];
      if (gloss && key) map.set(key, gloss);
    });
  }
  return map;
}

test("L5 a label agrees with the glossary in script/prompt-standard.md", () => {
  // One concept, one word: if the standard says `settlement_prior` is 先结算, a page that calls it
  // 优先结算 has invented a second name for the same thing.
  const labels = loadLabels();
  const gloss = glossary(path.join(REPO, "script/prompt-standard.md"));
  const wrong = [];
  for (const [kind, spec] of Object.entries(labels)) {
    for (const [key, entry] of Object.entries(spec)) {
      const want = gloss.get(key);
      if (!want) continue;
      // `settlement` means 效果 on an event and 正常结算 elsewhere, so it is the kind that decides.
      if (key === "settlement" && kind === "event") continue;
      const label = entry.label || "";
      if (!label.includes(want) && !want.includes(label)) wrong.push(`${kind}.${key}: 词库是「${want}」，标签是「${label}」`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
