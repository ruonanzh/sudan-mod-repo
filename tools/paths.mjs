#!/usr/bin/env node
/**
 * paths.mjs — the one place that decides where the game, its config, the mod root and the
 * workshop content are. Every other tool asks here instead of guessing again.
 *
 *   node tools/paths.mjs                 same as `check`
 *   node tools/paths.mjs check           one line per location: OK | MISS | EMPTY | FAIL
 *   node tools/paths.mjs set             record what was verified in .pi/paths.json
 *   node tools/paths.mjs check --steam <library> --vanilla <config dir> --mod-root <dir>
 *   node tools/paths.mjs check --paths <file>    read another record file (tests use this)
 *
 * Four locations, four sentinels. A directory that merely looks right is not accepted:
 *
 *   steam    appmanifest_3117820.acf exists, its `installdir` exists under steamapps/common
 *   vanilla  cards.json and rite/ are both inside it (derived from the install, never guessed)
 *   modRoot  ModLog/__mod.log sits beside it (or SultansGame/ does), and it is writable
 *   workshop <lib>/steamapps/workshop/content/3117820; empty means no subscriptions, not a failure
 *
 * The resolution order is one chain per location: an explicit argument, then `.pi/paths.json`,
 * then the game directory the app recorded in `.gamer-agent.local.json`, then discovery
 * (`appmanifest` plus `config/libraryfolders.vdf`). A value from an earlier step is judged and
 * reported even when it fails: a stale record must be loud, not skipped.
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

function judgeSteam(lib) {
  if (!lib) return row("steam", "MISS", null, "no Steam library in any known location");
  if (!existsSync(lib)) return row("steam", "MISS", lib, "no such directory");
  if (!existsSync(acfPath(lib))) return row("steam", "FAIL", lib, `no appmanifest_${APP_ID}.acf in steamapps/`);
  const name = installdirOf(lib);
  if (!name) return row("steam", "FAIL", lib, `appmanifest_${APP_ID}.acf has no installdir`);
  const install = path.join(lib, "steamapps", "common", name);
  if (!existsSync(install)) return row("steam", "FAIL", lib, `installdir "${name}" is not in steamapps/common/`);
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
// The mod root, the dump and the venv
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
// What is recorded, and what the app recorded
// ---------------------------------------------------------------------------

/** The record file. A tool that runs against another workspace root passes that root. */
export const pathsFile = (repo = REPO) => path.join(repo, ".pi", "paths.json");

/**
 * The record file. Absent is normal, so it reads as empty; invalid JSON is reported rather
 * than thrown, because this module is imported by every tool.
 */
export function readRecord(file = pathsFile()) {
  const empty = { steam: null, vanilla: null, modRoot: null, problem: null };
  if (!file || !existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { steam: raw.steam ?? null, vanilla: raw.vanilla ?? null, modRoot: raw.modRoot ?? null, problem: null };
  } catch (e) {
    return { ...empty, problem: `${shorten(file)} is not valid JSON: ${e.message}` };
  }
}

/**
 * What a record holds for judged rows, without writing it. Callers judge first: a recorded
 * path that does not hold the game is worse than none.
 */
export function recordOf(rows) {
  const pick = (name) => shorten(rows.find((r) => r.name === name).path);
  return { steam: pick("steam"), vanilla: pick("vanilla"), modRoot: pick("modRoot") };
}

/** Write a judged record. `recordOf` is separate so a caller can compare before it writes. */
export function writeRecord(rows, file = pathsFile()) {
  const body = recordOf(rows);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

/** The game directory the app verified, recorded beside the repo. Absent outside the app. */
function recordedGameDir(file = path.join(REPO, ".gamer-agent.local.json")) {
  if (!existsSync(file)) return null;
  try {
    const dir = JSON.parse(readFileSync(file, "utf8")).gameDir;
    return dir ? String(dir) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The judgment
// ---------------------------------------------------------------------------

/**
 * Judge every location once. `opts` exists so a test can build a whole world in a temp
 * directory: pass `platform`, `home`, `env`, `file` or `recorded` to replace the real ones.
 *
 * Returns `{ rows, ok, problem }`; `ok` is true when every required row is OK.
 */
export function judge(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const saved = readRecord(opts.file === undefined ? pathsFile() : opts.file);
  const recorded = "recorded" in opts ? opts.recorded : recordedGameDir();

  // steam: explicit -> .pi/paths.json -> the app's gameDir -> discovery
  const namedSteam = opts.steam ?? saved.steam;
  let steam;
  if (namedSteam) steam = judgeSteam(expand(namedSteam));
  else if (recorded && steamOf(recorded)) steam = judgeSteam(steamOf(recorded));
  else {
    const candidates = steamCandidates({ platform, home, env });
    steam =
      candidates.map(judgeSteam).find((r) => r.status === "OK") ??
      row("steam", "MISS", null, `no library with appmanifest_${APP_ID}.acf in ${candidates.length} candidate(s)`, candidates);
  }

  // vanilla: explicit -> recorded file -> app's gameDir -> the resolved install
  const namedVanilla = opts.vanilla ?? saved.vanilla;
  let vanilla;
  if (namedVanilla) vanilla = judgeVanilla(expand(namedVanilla));
  else if (recorded) vanilla = judgeVanilla(vanillaFrom(recorded));
  else if (steam.install) vanilla = judgeVanilla(vanillaFrom(steam.install));
  else vanilla = judgeVanilla(null);

  // modRoot: explicit -> recorded file -> the MyDocuments base for this platform
  const namedModRoot = opts.modRoot ?? saved.modRoot;
  const modRoot = judgeModRoot(namedModRoot ? expand(namedModRoot) : modRootFor({ platform, home }));

  const workshop = judgeWorkshop(steam.path ? path.join(steam.path, "steamapps", "workshop", "content", APP_ID) : null);

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
  return { rows, ok, problem: saved.problem };
}

/**
 * Which location a path is, by its sentinel. `set_game_dir` takes one path and must know
 * which of the three it is before it can record anything, so the decision lives here and
 * not in the tool.
 *
 * An exact sentinel wins first. A path that is only *inside* the game falls back to the
 * Steam library above it (`steamapps/common/<install>` is the folder a player copies), then
 * to the vanilla config derived from an install shape below it.
 */
export function classify(p) {
  const dir = expand(p);
  if (!dir || !existsSync(dir)) return { name: null, reason: "no such directory" };
  const exact = [
    ["steam", judgeSteam(dir)],
    ["vanilla", judgeVanilla(dir)],
    ["modRoot", judgeModRoot(dir)],
  ];
  const hit = exact.find(([, r]) => r.status === "OK");
  if (hit) return { name: hit[0], row: hit[1] };
  const library = steamOf(dir);
  if (library) {
    const row = judgeSteam(library);
    if (row.status === "OK") return { name: "steam", row };
  }
  const vanilla = judgeVanilla(vanillaFrom(dir));
  if (vanilla.status === "OK") return { name: "vanilla", row: vanilla };
  return { name: null, reason: "none of the three sentinels matched" };
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
    "run `node tools/paths.mjs set --steam <library> --vanilla <config dir>`; the three sentinels are in .pi/skills/setup-workspace/SKILL.md",
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
    "usage: node tools/paths.mjs <check|set> [--steam <library>] [--vanilla <config dir>] [--mod-root <dir>] [--paths <file>]\n",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("paths.mjs")) process.exit(main());
