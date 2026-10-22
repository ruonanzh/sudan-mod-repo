/**
 * The two things pi's loader provides that a bare `node --test` process does not.
 *
 * 1. `typebox` is a runtime dependency of the extensions; this repository ships no
 *    node_modules, so the hook answers that specifier with a local shim.
 * 2. The extensions import their helpers without a file extension (`../lib/state`), which is
 *    what jiti resolves for pi. Plain ESM needs the extension spelled out.
 *
 * Everything else is Node's own TypeScript type stripping: the modules are the files pi
 * loads, not a copy.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TYPEBOX = new URL("./typebox-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "typebox") return { url: TYPEBOX, shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
    for (const ext of [".ts", ".mjs", ".js"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
