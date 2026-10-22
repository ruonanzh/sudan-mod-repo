/**
 * The Chinese label and the one-line note a page prints for a field key.
 *
 * `schema/field-labels.json` is the hand-written half of `fields.json`:
 * `script/field-labels.test.mjs` keeps it complete and sourced. A page that prints a key reads
 * its label from a single table, so two pages cannot name the same key differently.
 *
 * The card editor reads through here. `editors/page/page.mjs` keeps its own copy behind `useLabels()`:
 * a test points it at a modified table to prove a missing label fails the way it should, and
 * that indirection does not belong in the shared module.
 */
import { readFileSync } from "node:fs";

const LABELS = JSON.parse(readFileSync(new URL("../../schema/field-labels.json", import.meta.url), "utf8"));

/** The `{label, note}` for `kind.key`, or null when nobody described it. */
export function labelOf(kind, key) {
  return LABELS[kind]?.[key] || null;
}

/** The label for a key a page must show; throws naming the file to add it to, as editors/page/page.mjs does. */
export function requireLabel(kind, key) {
  const info = labelOf(kind, key);
  if (!info) {
    throw new Error(`${kind}: no label for ${JSON.stringify(key)}. Add it to schema/field-labels.json.`);
  }
  return info;
}
