#!/usr/bin/env node
/**
 * page.mjs — the command; the renderer is `editors/page/page.mjs`.
 *
 *   node tools/page.mjs card --mod your_mods/x --id 2100900
 *   node tools/page.mjs rite --mod your_mods/x --id 5010901
 *   node tools/page.mjs card --mod your_mods/x --id 2100900 --spec - < proposal.json
 *   node tools/page.mjs card --mod your_mods/x --id 2100900 --out /tmp/x.html
 *
 * Nothing is parsed here: the arguments go straight to the renderer's `main`, so flags,
 * output and exit codes are the renderer's own. The re-export keeps the old import path
 * working, and only a direct run calls `main` — importing this file must stay silent.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../editors/page/page.mjs";

export * from "../editors/page/page.mjs";

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
