#!/usr/bin/env node
/**
 * graphpage.mjs — the command; the renderer is `editors/graph/graphpage.mjs`.
 *
 *   node tools/graphpage.mjs --out editors/.preview/graph/graph.html [--mod your_mods/x] [--focus rite:5010901]
 *
 * Nothing is parsed here: the arguments go straight to the renderer's `main`, so flags,
 * output and exit codes are the renderer's own. The re-export keeps the old import path
 * working, and only a direct run calls `main` — importing this file must stay silent.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../editors/graph/graphpage.mjs";

export * from "../editors/graph/graphpage.mjs";

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
