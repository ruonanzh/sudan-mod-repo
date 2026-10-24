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
  name === ".preview" ||
  name === ".git" ||
  name === ".DS_Store" ||
  name === "asset_manifest.jsonl" ||
  name.startsWith("._") ||
  // The page editor keeps a lock file while saving and one timestamped backup per save; neither
  // is part of the mod, and shipping them would put old copies of records in the player's folder.
  name.endsWith(".lock") ||
  name.includes(".bak-");

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

/** A failed install that knows whether the old copy made it back. */
export class InstallError extends Error {
  /** The previous copy is on disk (either never moved, or moved back). */
  readonly restored: boolean;
  /** Where the old copy sits when it could not be moved back. */
  readonly backup: string | null;
  /** There was an old copy to begin with. */
  readonly replaced: boolean;
  constructor(cause: unknown, restored: boolean, backup: string | null, replaced: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "InstallError";
    this.restored = restored;
    this.backup = backup;
    this.replaced = replaced;
  }
}

/**
 * Put the old copy back. Returns whether it worked; the caller must report the truth, because a
 * silent failure leaves the player with no installed mod and a message that says otherwise.
 */
export function restoreBackup(target: string, backup: string): boolean {
  try {
    rmSync(target, { recursive: true, force: true });
    renameSync(backup, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace `target` with a copy of `source`. Throws on failure, after putting the old copy back.
 * The caller decides whether the paths are safe; this function only writes.
 */
export function installFolder(source: string, target: string): InstallResult {
  const replaced = existsSync(target);
  const staging = `${target}.installing-${process.pid}`;
  const backup = `${target}.replaced-${process.pid}`;
  let movedOld = false;
  try {
    // Reading the source can fail too (an unreadable file); it belongs inside the try so the
    // failure is reported with the same facts as any other step.
    const files = walk(source).length;
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
    // When the copy failed before the old folder was moved aside, the old copy never left.
    const restored = movedOld ? restoreBackup(target, backup) : true;
    throw new InstallError(error, restored, movedOld && !restored ? backup : null, replaced);
  }
}
