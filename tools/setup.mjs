#!/usr/bin/env node
/**
 * setup.mjs — say whether the files a preview needs are present.
 *
 * The card plates and the style references ship with this repository: they are card faces,
 * which the game's own players share publicly. The title font is commercial and is not
 * shipped; a page without it falls back to a serif face.
 *
 *   node tools/setup.mjs --check         what is present, what is missing, and where the game is
 *   node tools/setup.mjs --paths <file>  read .gamer-agent.local.json from here instead
 *
 * There is nothing to install and nothing to extract: the old UnityPy path is gone, because a
 * fresh workspace should be able to render a card page without a network round trip.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { judge, shorten } from "./paths.mjs";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const REF = path.join(ROOT, "reference");

/** What the preview needs, and what it can live without, plus the two judged locations. */
function status(judgeOpts = {}) {
  const need = ["card.png", "card-stone.png", "card-copper.png", "card-silver.png", "card-gold.png"]
    .map((f) => ({ file: `reference/plates/${f}`, ok: existsSync(path.join(REF, "plates", f)), required: true }));
  const fonts = existsSync(path.join(REF, "fonts"))
    ? readdirSync(path.join(REF, "fonts")).filter((f) => /\.(ttf|otf)$/i.test(f)).length
    : 0;
  const cards = existsSync(path.join(REF, "cards"))
    ? readdirSync(path.join(REF, "cards")).filter((f) => f.endsWith(".png")).length
    : 0;
  const judged = judge(judgeOpts);
  const location = (name, { game = false } = {}) => {
    const r = judged.rows.find((x) => x.name === name);
    return {
      file: `${name.padEnd(7)} ${r.path ? shorten(r.path) : "(not found)"}`,
      ok: r.status === "OK",
      required: true,
      location: true,
      game,
      detail: r.reason,
    };
  };
  return [
    ...need,
    { file: "reference/fonts/ (card title font, optional)", ok: fonts > 0, required: false, detail: `${fonts} files` },
    { file: "reference/cards/ (style references)", ok: cards > 0, required: false, detail: `${cards} files` },
    location("gameDir", { game: true }),
    location("vanilla"),
  ];
}

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
  };
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node tools/setup.mjs [--check] [--paths <file>]");
    return 0;
  }

  // One file decides where the game is, and a test can replace it. Everything below asks it.
  const paths = arg("--paths");
  const rows = status(paths ? { file: paths } : {});
  for (const r of rows) {
    console.log(`${r.ok ? "OK  " : r.required ? "MISS" : "    "} ${r.file}${r.detail ? ` (${r.detail})` : ""}`);
  }
  const missing = rows.filter((r) => r.required && !r.ok);
  if (missing.some((r) => r.game)) {
    console.log(`\nThe game was not found. Record it with:\n  node tools/paths.mjs set --game-dir "<install folder>"`);
  } else if (missing.some((r) => !r.location)) {
    console.log("\nrequired file group(s) missing: the preview art ships with this repository, so a checkout is incomplete. Re-clone the workspace or restore reference/plates and reference/cards.");
  } else if (missing.length) {
    console.log("\nThe game's config was not found. Record the install with `node tools/paths.mjs set --game-dir <install>`; vanilla is derived from it.");
  } else {
    console.log("\nAll required files present.");
  }
  return missing.length ? 1 : 0;
}

process.exit(main());
