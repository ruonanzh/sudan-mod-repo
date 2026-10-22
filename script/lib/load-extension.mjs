/**
 * Load a `.pi/extensions/*.ts` file the way pi does, and hand back the tool it registered.
 *
 *   const tool = await loadExtension("check-game-paths.ts");
 *   const result = await tool.execute("id", { gameDir }, undefined, undefined, { cwd });
 *
 * The default export of an extension is a factory that receives the pi API; the only method
 * these extensions use is `registerTool`. Registering the hook once, before the first
 * dynamic import, is what makes the module graph resolvable (see extension-loader.mjs).
 */
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./fixture.mjs";

register("./extension-loader.mjs", import.meta.url);

export async function loadExtension(file) {
  const full = path.isAbsolute(file) ? file : path.join(REPO, ".pi", "extensions", file);
  const module = await import(pathToFileURL(full).href);
  let tool = null;
  module.default({ registerTool: (definition) => (tool = definition) });
  if (!tool) throw new Error(`${full} registered no tool`);
  return tool;
}
