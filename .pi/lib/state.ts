/**
 * The repository contract (`mod-repo.json`) and the local state file
 * (`.gamer-agent.local.json`).
 *
 * This repository ships data only: it needs no SDK to make a mod. It does need
 * the .NET SDK to regenerate the decompiled dump, so the state file records the
 * dotnet path that `check_runtime` resolved and the game directory the dump was
 * read from.
 *
 * Two writers share that file: this module (`runtime`, and the `gameDir` a dump was
 * read from) and `tools/paths.mjs` (the four path keys `gameDir`, `vanillaDir`,
 * `modInstallDir` and `workshopDir`). Both merge: each reads the file and writes
 * every key it does not own back unchanged. `writeState` replaces the file
 * atomically (same-volume rename), so a crash cannot leave half a JSON file behind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import os from "node:os";

export interface ModRepoConfig {
  game?: {
    name?: string;
    steamAppId?: string | number;
    installDirHint?: Record<string, string>;
  };
  compile?: unknown;
  [key: string]: unknown;
}

export interface RuntimeState {
  /** Where the game is installed (the folder that holds the .app on macOS). */
  gameDir?: string | null;
  /** `<gameDir>/.../StreamingAssets/config`, derived from `gameDir`. */
  vanillaDir?: string | null;
  /** `<MyDocuments>/DoubleCross/SultansGame/Mod`, derived from MyDocuments. */
  modInstallDir?: string | null;
  /** `<Steam library>/steamapps/workshop/content/3117820`, derived from `gameDir`. */
  workshopDir?: string | null;
  runtime?: { dotnet?: string; dotnetVersion?: string } | null;
  [key: string]: unknown;
}

/** Platform key used by `mod-repo.json` (`windows` / `mac` / `linux`). */
export const platformKey = (): string =>
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";

export const statePath = (cwd: string): string => join(cwd, ".gamer-agent.local.json");

/** The repository directory name. The dump lives in a folder of this name. */
export const repoName = (cwd: string): string => basename(cwd);

export function readModRepoConfig(cwd: string): ModRepoConfig {
  return JSON.parse(readFileSync(join(cwd, "mod-repo.json"), "utf8")) as ModRepoConfig;
}

export function readState(cwd: string): RuntimeState {
  try {
    return JSON.parse(readFileSync(statePath(cwd), "utf8")) as RuntimeState;
  } catch {
    return {};
  }
}

export function writeState(cwd: string, patch: RuntimeState): RuntimeState {
  const next = { ...readState(cwd), ...patch };
  const file = statePath(cwd);
  const tmp = `${file}.tmp-${process.pid}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}

/** Expand a leading `~` (the hints in `mod-repo.json` are written that way). */
export const expandHome = (p: string): string => {
  const t = p.trim();
  if (t !== "~" && !t.startsWith("~/")) return t;
  return join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), t.slice(2));
};
