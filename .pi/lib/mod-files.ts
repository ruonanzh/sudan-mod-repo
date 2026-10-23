/**
 * Copying a mod folder into the game's mod directory.
 *
 * What the game never loads must not land in the install folder: the page tool's output
 * (`.preview/`), git metadata, and the Finder's litter. `tools/lint.mjs` skips the same names
 * when it scans a mod, so a folder that lints clean also installs clean.
 *
 * The copy is staged: files are written to a sibling `.installing-<pid>` folder, the old copy is
 * renamed aside, the staged folder is renamed into place, and only then is the old copy deleted.
 * A failure at any step puts the old copy back, so a half-written install never replaces a
 * working one.
 */
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

export const SKIP = (name: string): boolean =>
  name === ".preview" || name === ".git" || name === ".DS_Store" || name.startsWith("._");

/** Every file that would land, relative to `dir`. */
export function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

export interface InstallResult {
  files: number;
  replaced: boolean;
}

/**
 * Replace `target` with a copy of `source`. Throws on failure, after putting the old copy back.
 * The caller decides whether the paths are safe; this function only writes.
 */
export function installFolder(source: string, target: string): InstallResult {
  const files = walk(source).length;
  const replaced = existsSync(target);
  const staging = `${target}.installing-${process.pid}`;
  const backup = `${target}.replaced-${process.pid}`;
  let movedOld = false;
  try {
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, { recursive: true, filter: (entry) => !SKIP(path.basename(entry)) });
    if (replaced) {
      rmSync(backup, { recursive: true, force: true });
      renameSync(target, backup);
      movedOld = true;
    }
    renameSync(staging, target);
    if (movedOld) rmSync(backup, { recursive: true, force: true });
    return { files, replaced };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (movedOld) {
      try {
        rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
      } catch {
        // The old copy could not be put back; the caller reports the original failure.
      }
    }
    throw error;
  }
}
