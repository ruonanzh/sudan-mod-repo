#!/usr/bin/env node
/**
 * paths.mjs — the one place that decides where the game, its config, the mod root and the
 * workshop content are. Every other tool asks here instead of guessing again.
 *
 *   node tools/paths.mjs                 same as `check`
 *   node tools/paths.mjs check           one line per location: OK | MISS | EMPTY | FAIL
 *   node tools/paths.mjs set             record what was verified in .gamer-agent.local.json
 *   node tools/paths.mjs check --steam <library or install> --vanilla <config dir> --mod-root <dir>
 *   node tools/paths.mjs check --paths <file>    read another state file (tests use this)
 *
 * Four locations, four sentinels. A directory that merely looks right is not accepted:
 *
 *   steam    appmanifest_3117820.acf exists, its `installdir` exists under steamapps/common
 *   vanilla  cards.json and rite/ are both inside it (derived from the install, never guessed)
 *   modRoot  ModLog/__mod.log sits beside it (or SultansGame/ does), and it is writable
 *   workshop <lib>/steamapps/workshop/content/3117820; empty means no subscriptions, not a failure
 *
 * The state file is `.gamer-agent.local.json` at the workspace root. It holds four keys this
 * module owns and one it only keeps:
 *
 *   gameDir        the install, the folder holding Sultan's Game.app / Sultan's Game_Data
 *   vanillaDir     <gameDir>/.../StreamingAssets/config, derived from gameDir
 *   modInstallDir  <MyDocuments>/DoubleCross/SultansGame/Mod, derived from MyDocuments
 *   workshopDir    <library>/steamapps/workshop/content/3117820, derived from gameDir
 *   runtime        the dotnet path check_runtime resolved; never read or written here
 *
 * The report keeps its row names — steam, vanilla, modRoot, workshop — because the CLI and
 * the setup-workspace skill print and read that shape. The rows map onto the keys: steam is
 * gameDir, vanilla is vanillaDir, modRoot is modInstallDir, workshop is workshopDir. The
 * steam row shows the library (that is the folder with the sentinel) and carries the install
 * as `install`, which is the value recorded as gameDir.
 *
 * The resolution order is one chain per location: an explicit argument, then the state file,
 * then discovery (`appmanifest` plus `config/libraryfolders.vdf`). A value from an earlier
 * step is judged and reported even when it fails: a stale record must be loud, not skipped.
 * The workshop directory is the exception: it is always derived from the resolved library,
 * because no player hands us one.
 *
 * `~` is expanded with os.homedir(). process.env.HOME does not exist on Windows.
 *
 * Exit codes: 0 when every required location is OK, 1 otherwise, 2 for a usage mistake.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "3117820";

/** The locations a mod cannot be made without. Everything else is reported but not judged. */
export const REQUIRED = ["steam", "vanilla", "modRoot"];

/** `~` expands to the account's home directory. Never process.env.HOME: Windows has no such variable. */
const expand = (p) => (p === null || p === undefined ? null : String(p).replace(/^~/, os.homedir()));

/** The inverse, for printing: a path under the home directory shows as `~/...`. */
export function shorten(p) {
  if (!p) return String(p);
  const home = os.homedir();
  const s = String(p);
  if (s === home) return "~";
  return s.startsWith(home + path.sep) ? `~${s.slice(home.length)}` : s;
}

/** path.join per platform, so a Windows shape can be built on a Mac and asserted on. */
const styleOf = (platform) => (platform === "win32" ? path.win32 : path.posix);

/** One judged location. `status` is OK, MISS, EMPTY, FAIL or n/a. */
const row = (name, status, dir, reason, tried = []) => ({ name, status, path: dir ?? null, reason, tried });

// ---------------------------------------------------------------------------
// Steam libraries
// ---------------------------------------------------------------------------

/** The authoritative copy is `<Steam>/config/libraryfolders.vdf`; `steamapps/` holds the pre-2021 one. */
function libraryFolders(steamRoot) {
  const out = [];
  for (const rel of [["config", "libraryfolders.vdf"], ["steamapps", "libraryfolders.vdf"]]) {
    const file = path.join(steamRoot, ...rel);
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) out.push(m[1].replace(/\\\\/g, "\\"));
  }
  return out;
}

/**
 * Every Steam library worth looking at, in the order Steam itself would. Discovery is a
 * candidate list, not a decision: `judgeSteam` accepts only the one with the app manifest.
 *
 * Windows: `ProgramFiles`/`ProgramFiles(x86)`/Steam, then `C:`..`F:` SteamLibrary, plus
 * whatever `libraryfolders.vdf` adds. UNVERIFIED: no Windows machine was available, so the
 * drive list and the Documents base below are the documented layout, not a measurement.
 */
export function steamCandidates({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const p = styleOf(platform);
  const roots = [];
  if (platform === "win32") {
    for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles, "C:\\Program Files (x86)", "C:\\Program Files"]) {
      if (base) roots.push(p.join(base, "Steam"));
    }
    for (const drive of ["C:", "D:", "E:", "F:"]) roots.push(p.join(`${drive}\\`, "SteamLibrary"));
  } else if (platform === "darwin") {
    roots.push(path.join(home, "Library", "Application Support", "Steam"));
  }
  const out = [];
  for (const root of roots) out.push(root, ...libraryFolders(root));
  return [...new Set(out)];
}

const acfPath = (lib) => path.join(lib, "steamapps", `appmanifest_${APP_ID}.acf`);

/** The `installdir` the manifest names, or null when the manifest is missing or says nothing. */
function installdirOf(lib) {
  const file = acfPath(lib);
  if (!existsSync(file)) return null;
  const m = /"installdir"\s+"([^"]+)"/.exec(readFileSync(file, "utf8"));
  return m ? m[1] : null;
}

/** The library a game directory belongs to, by walking up to the folder that holds the manifest. */
function steamOf(gameDir) {
  let dir = path.resolve(gameDir);
  for (;;) {
    if (existsSync(acfPath(dir))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The `steam` row, given either the Steam library, the install inside it, the `.app` bundle,
 * or any folder inside the install. All of them resolve to one library, one install and one
 * verdict, so a player and the state file can name the game in different shapes.
 */
function judgeSteam(p) {
  if (!p) return row("steam", "MISS", null, "no Steam library in any known location");
  const dir = path.resolve(p);
  if (!existsSync(dir)) return row("steam", "MISS", dir, "no such directory");
  const lib = steamOf(dir);
  if (!lib) return row("steam", "FAIL", dir, `no appmanifest_${APP_ID}.acf in steamapps/, nor in a folder above`);
  const name = installdirOf(lib);
  if (!name) return row("steam", "FAIL", lib, `appmanifest_${APP_ID}.acf has no installdir`);
  const install = path.join(lib, "steamapps", "common", name);
  if (!existsSync(install)) return row("steam", "FAIL", lib, `installdir "${name}" is not in steamapps/common/`);
  if (dir !== lib && dir !== install && !dir.startsWith(install + path.sep)) {
    return row("steam", "FAIL", dir, `appmanifest_${APP_ID}.acf names installdir "${name}", which is not this folder`);
  }
  const r = row("steam", "OK", lib, `appmanifest_${APP_ID}.acf, installdir="${name}"`);
  return { ...r, install };
}

// ---------------------------------------------------------------------------
// The vanilla config: always derived from an install, never guessed on its own
// ---------------------------------------------------------------------------

/**
 * The config directory for an install, its Data directory, or a config directory itself.
 * The macOS bundle shape is measured on this machine; the Windows shape is UNVERIFIED.
 */
function vanillaFrom(dir) {
  if (!dir) return null;
  const shapes = [
    ["Sultan's Game.app", "Contents", "Resources", "Data", "StreamingAssets", "config"],
    ["Sultan's Game_Data", "StreamingAssets", "config"],
    ["StreamingAssets", "config"],
    [],
  ];
  const tried = shapes.map((s) => path.join(dir, ...s));
  return tried.find((d) => existsSync(path.join(d, "cards.json")) || existsSync(path.join(d, "rite"))) ?? tried[0];
}

function judgeVanilla(dir) {
  if (!dir) return row("vanilla", "MISS", null, "derived from the install, which was not found");
  if (!existsSync(dir)) return row("vanilla", "MISS", dir, "no such directory");
  const missing = ["cards.json", "rite"].filter((f) => !existsSync(path.join(dir, f)));
  if (missing.length) return row("vanilla", "FAIL", dir, `missing ${missing.join(" and ")}`);
  return row("vanilla", "OK", dir, "cards.json, rite/");
}

// ---------------------------------------------------------------------------
// The mod root, the workshop, the dump and the venv
// ---------------------------------------------------------------------------

/**
 * `<MyDocuments>/DoubleCross/SultansGame/Mod`. `MyDocuments` is `$HOME` on macOS and
 * `%USERPROFILE%\Documents` on Windows (UNVERIFIED: no Windows measurement).
 */
export function modRootFor({ platform = process.platform, home = os.homedir() } = {}) {
  const p = styleOf(platform);
  const base = platform === "win32" ? p.join(home, "Documents") : home;
  return p.join(base, "DoubleCross", "SultansGame", "Mod");
}

const writable = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

function judgeModRoot(dir) {
  if (!dir) return row("modRoot", "MISS", null, "no MyDocuments base to build it from");
  // A directory named Mod proves nothing. The base is confirmed by the game's own folder beside
  // it, or by the log the game writes there. Either missing on a fresh machine means the base is
  // a guess, and a guessed base would put the mod in the player's home directory.
  const beside = path.dirname(dir);
  const log = path.join(beside, "ModLog", "__mod.log");
  const baseNamed = path.basename(beside).toLowerCase() === "sultansgame";
  if (!existsSync(dir)) {
    if (baseNamed) return row("modRoot", "MISS", dir, "not created yet; the game creates it on first launch (SultansGame/ exists)");
    return row("modRoot", "MISS", dir, "nothing confirms this base: no SultansGame/ beside it and no ModLog/__mod.log");
  }
  if (!existsSync(log) && !baseNamed) return row("modRoot", "FAIL", dir, "no ModLog/__mod.log beside it and its parent is not SultansGame/");
  if (!writable(dir)) return row("modRoot", "FAIL", dir, "not writable");
  return row("modRoot", "OK", dir, existsSync(log) ? "ModLog/__mod.log present" : "SultansGame/ present");
}

/** The workshop content folder of a Steam library: derived, never asked for. */
const workshopOf = (lib) => path.join(lib, "steamapps", "workshop", "content", APP_ID);

function judgeWorkshop(dir) {
  if (!dir) return row("workshop", "MISS", null, "no Steam library, so no workshop content");
  if (!existsSync(dir)) return row("workshop", "MISS", dir, "no workshop content directory; nothing subscribed");
  let items = [];
  try {
    items = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "info.json")))
      .map((e) => e.name);
  } catch (e) {
    return row("workshop", "FAIL", dir, `cannot be read: ${e.code || e.message}`);
  }
  if (!items.length) return row("workshop", "EMPTY", dir, "no subscribed workshop items; not an error");
  return row("workshop", "OK", dir, `${items.length} item(s)`);
}

/** The decompiled dump. Product managed, so it is reported and never judged. */
function dumpDir() {
  const root =
    process.env.DECOMPILED_ROOT ||
    path.join(process.env.PI_DESKTOP_DATA_DIR || path.join(os.homedir(), ".gamer-agent-pi"), "decompiled");
  return path.join(root, path.basename(REPO));
}

const venvDir = () => path.join(REPO, ".setup-venv");
const venvPython = (platform = process.platform) =>
  path.join(venvDir(), platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");

// ---------------------------------------------------------------------------
// What is recorded
// ---------------------------------------------------------------------------

/** The state file. A tool that runs against another workspace root passes that root. */
export const pathsFile = (repo = REPO) => path.join(repo, ".gamer-agent.local.json");

const text = (v) => (typeof v === "string" && v.trim() ? v : null);

/** The file as authored, so a write can keep every key this module does not own. */
function readRaw(file) {
  if (!file || !existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * The state file, read as the four keys this module owns. Absent is normal and reads as
 * empty; invalid JSON is reported rather than thrown, because every tool imports this module.
 * `present` says whether the file existed, so a report can say "nothing recorded yet" instead
 * of implying that discovery failed.
 */
export function readRecord(file = pathsFile()) {
  const empty = { gameDir: null, vanillaDir: null, modInstallDir: null, workshopDir: null, present: false, problem: null };
  if (!file || !existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      gameDir: text(raw.gameDir),
      vanillaDir: text(raw.vanillaDir),
      modInstallDir: text(raw.modInstallDir),
      workshopDir: text(raw.workshopDir),
      present: true,
      problem: null,
    };
  } catch (e) {
    return { ...empty, present: true, problem: `${shorten(file)} is not valid JSON: ${e.message}` };
  }
}

/**
 * What judged rows put in the file, without writing it. Only the keys that can be computed
 * are here: a caller judges first, so a path that does not hold the game is never recorded,
 * and a derived location that does not exist yet is still recorded because it is derived.
 */
export function recordOf(rows) {
  const find = (name) => rows.find((r) => r.name === name);
  const out = {};
  const steam = find("steam");
  if (steam?.status === "OK" && steam.install) out.gameDir = shorten(steam.install);
  const vanilla = find("vanilla");
  if (vanilla?.status === "OK") out.vanillaDir = shorten(vanilla.path);
  const modRoot = find("modRoot");
  if (modRoot?.status === "OK") out.modInstallDir = shorten(modRoot.path);
  if (steam?.status === "OK" && steam.path) out.workshopDir = shorten(workshopOf(steam.path));
  return out;
}

/** Write the keys this module owns. The rest of the file is merged, never replaced. */
export function writeRecord(rows, file = pathsFile()) {
  const body = recordOf(rows);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...readRaw(file), ...body }, null, 2)}\n`);
  return body;
}

// ---------------------------------------------------------------------------
// The judgment
// ---------------------------------------------------------------------------

/**
 * Judge every location once. `opts` exists so a test can build a whole world in a temp
 * directory: pass `platform`, `home`, `env` or `file` to replace the real ones.
 *
 * Returns `{ rows, ok, problem, present }`; `ok` is true when every required row is OK, and
 * `present` is false when the state file does not exist yet.
 */
export function judge(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const file = opts.file === undefined ? pathsFile() : opts.file;
  const saved = readRecord(file);

  // steam (gameDir): explicit -> the state file -> discovery
  const namedSteam = opts.steam ?? saved.gameDir;
  let steam;
  if (namedSteam) steam = judgeSteam(expand(namedSteam));
  else {
    const candidates = steamCandidates({ platform, home, env });
    steam =
      candidates.map(judgeSteam).find((r) => r.status === "OK") ??
      row("steam", "MISS", null, `no library with appmanifest_${APP_ID}.acf in ${candidates.length} candidate(s)`, candidates);
  }

  // vanilla (vanillaDir): explicit -> the state file -> the install the game row resolved
  const namedVanilla = opts.vanilla ?? saved.vanillaDir;
  let vanilla;
  if (namedVanilla) vanilla = judgeVanilla(expand(namedVanilla));
  else if (steam.install) vanilla = judgeVanilla(vanillaFrom(steam.install));
  else vanilla = judgeVanilla(null);

  // modRoot (modInstallDir): explicit -> the state file -> the MyDocuments base for this platform
  const namedModRoot = opts.modRoot ?? saved.modInstallDir;
  const modRoot = judgeModRoot(namedModRoot ? expand(namedModRoot) : modRootFor({ platform, home }));

  // workshop (workshopDir): derived from the resolved library. No argument, no record read:
  // the folder is fixed by the app id, so a recorded one could only be stale.
  const workshop = judgeWorkshop(steam.path ? workshopOf(steam.path) : null);

  const dump = dumpDir();
  const python = venvPython(platform);
  const rows = [
    steam,
    vanilla,
    modRoot,
    workshop,
    row("dump", "n/a", dump, existsSync(dump) ? "product managed" : "not built; inspect_game_code action=dump builds it"),
    row("venv", "n/a", venvDir(), existsSync(python) ? "python present" : "not created; node tools/setup.mjs creates it"),
  ];
  const ok = REQUIRED.every((name) => rows.find((r) => r.name === name)?.status === "OK");
  return { rows, ok, problem: saved.problem, present: saved.present };
}

/**
 * Which key a path belongs in, by its sentinel. `set_game_dir` takes one path and must know
 * which of the three keys it is before it can record anything, so the decision lives here
 * and not in the tool.
 *
 * The vanilla and mod-root sentinels are exact: the folder itself either holds the files or
 * it does not. The game sentinel accepts the library, the install, the `.app` and any folder
 * inside the install, because all of them name the same game. Checking the two exact shapes
 * first is what keeps `.../StreamingAssets/config` from being filed as the game.
 */
export function classify(p) {
  const dir = expand(p);
  if (!dir || !existsSync(dir)) return { key: null, reason: "no such directory" };
  const candidates = [
    ["vanillaDir", judgeVanilla(dir)],
    ["modInstallDir", judgeModRoot(dir)],
    ["gameDir", judgeSteam(dir)],
  ];
  const hit = candidates.find(([, r]) => r.status === "OK");
  if (hit) return { key: hit[0], row: hit[1] };
  return { key: null, reason: "none of the three sentinels matched" };
}

/**
 * The vanilla config a tool needs before it can do its work, or the FAIL text that stops it.
 * A tool with no vanilla must say so and exit non-zero: an empty page is a lie.
 */
export function vanillaRequirement(explicit, opts = {}) {
  const found = judge({ ...opts, vanilla: explicit }).rows.find((r) => r.name === "vanilla");
  if (found.status === "OK") return { dir: found.path };
  const where = found.path ? ` at ${shorten(found.path)}` : "";
  return {
    dir: null,
    message: `vanilla config ${found.status}${where}: ${found.reason}`,
    next: "run `node tools/paths.mjs check` to see what is missing, or pass --vanilla <config dir>",
  };
}

/** What `model.mjs` calls DEFAULT_VANILLA: the verified config, or null when there is none. */
export const resolveVanilla = () => vanillaRequirement().dir;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const emit = (code, message, next) => {
  process.stdout.write(`${code}  ${message}\n`);
  if (next) process.stdout.write(`NEXT  ${next}\n`);
};

function printRows(rows) {
  for (const r of rows) {
    const where = r.path ? shorten(r.path) : "(not found)";
    process.stdout.write(`${r.name.padEnd(8)} ${r.status.padEnd(5)} ${where}${r.reason ? `  (${r.reason})` : ""}\n`);
    for (const tried of r.tried) process.stdout.write(`${" ".repeat(15)}tried ${shorten(tried)}\n`);
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const judgeArgs = (args) => ({
  steam: args.steam,
  vanilla: args.vanilla,
  modRoot: args["mod-root"],
  file: args.paths ?? undefined,
});

function check(args) {
  const { rows, ok, problem } = judge(judgeArgs(args));
  printRows(rows);
  if (problem) emit("WARN", problem, "fix or delete the file, or pass --paths <file>");
  if (ok) {
    emit("PASS", "every required location is OK");
    return 0;
  }
  const bad = rows.filter((r) => REQUIRED.includes(r.name) && r.status !== "OK").map((r) => r.name);
  process.stdout.write("\n");
  emit("FAIL", `${bad.join(", ")} not OK`);
  emit("ASK", "Is the game installed through Steam on this machine? If it is on another disk, name that library folder.");
  emit(
    "NEXT",
    "run `node tools/paths.mjs set --steam <library or game directory> --vanilla <config dir>`; the three sentinels are in .pi/skills/setup-workspace/SKILL.md",
  );
  return 1;
}

/**
 * Record what was verified. Nothing is written unless every location that was asked for
 * passes its sentinel: a recorded path that does not hold the game is worse than none.
 */
function set(args) {
  const file = args.paths ?? pathsFile();
  const wanted = judge(judgeArgs(args));
  const refused = wanted.rows.filter((r) => REQUIRED.includes(r.name) && r.status !== "OK");
  if (refused.length) {
    printRows(wanted.rows);
    process.stdout.write("\n");
    for (const r of refused) emit("FAIL", `${r.name} ${r.status}: ${r.reason}`);
    emit("NEXT", "fix the location, or run `node tools/paths.mjs check` to see what is missing");
    return 1;
  }
  writeRecord(wanted.rows, file);
  emit("PASS", `recorded ${shorten(file)}`, "run `node tools/paths.mjs check` to confirm it reads back");
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "check";
  const args = parseArgs(cmd === "check" ? argv : argv.slice(1));
  if (cmd === "check") return check(args);
  if (cmd === "set") return set(args);
  process.stderr.write(
    "usage: node tools/paths.mjs <check|set> [--steam <library or game directory>] [--vanilla <config dir>] [--mod-root <dir>] [--paths <file>]\n",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("paths.mjs")) process.exit(main());
