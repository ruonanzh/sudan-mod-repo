/**
 * Workspace path helpers shared by the extensions.
 *
 * Two rules live here because more than one tool needs them:
 *   · a path the agent typed may be relative or start with `~`; both must resolve the same way
 *     in every tool, or the same string means two different folders;
 *   · "is this the same folder" is a real-path question, not a string question.
 *
 * The judgment of *which* folders are the game's stays in `tools/paths.mjs`, which the CLI also
 * uses; this file never decides paths, only spells them.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./state";

/** A path from a tool argument, resolved against the workspace. */
export const absolute = (cwd: string, p: string): string => {
  // A path copied out of our own report starts with `~`; resolving that against the workspace
  // would invent `<workspace>/~/...`, so expand it first with the same rule every tool uses.
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
};

/** `realpath`, or the input unchanged when it does not exist yet (a target often does not). */
export const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** One spelling for a folder that may or may not exist: real parent plus the final name. */
export const identity = (p: string): string => {
  const resolved = path.resolve(p);
  return path.join(real(path.dirname(resolved)), path.basename(resolved));
};

/** The same folder, or one holding the other. */
export const sameOrNested = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
