#!/usr/bin/env node
/**
 * editor.mjs — the command; the server is `editors/editor/editor.mjs`.
 *
 *   node tools/editor.mjs [--mod your_mods/<name>] [--port 7801] [--static out.html] [--focus kind:id]
 *
 * Nothing is parsed here: the arguments go straight to the server's `main`. It returns null
 * once the server is listening, and that is the signal to leave the process running. The
 * re-export keeps the old import path working, and only a direct run calls `main` —
 * importing this file must not start a server.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../editors/editor/editor.mjs";

export * from "../editors/editor/editor.mjs";

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2));
  if (code !== null && code !== undefined) process.exit(code);
}
