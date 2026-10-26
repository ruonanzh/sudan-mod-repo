#!/usr/bin/env node
/**
 * paths.mjs — the one place that decides where the game is, and what follows from it.
 *
 *   node tools/paths.mjs                        same as `check`
 *   node tools/paths.mjs check                  one line per location: OK | MISS | EMPTY | FAIL
 *   node tools/paths.mjs set --game-dir <dir>   record the game directory and what it derives
 *   node tools/paths.mjs check --game-dir <dir> --workshop <dir> --mod-install <dir>
 *   node tools/paths.mjs check --paths <file>   read another state file (tests use this)
 *
 * Four locations, four sentinels. A directory that merely looks right is not accepted:
 *
 *   gameDir        a file the game itself ships inside it (see GAME_MARKERS): GameAssembly.dylib
 *                  or il2cpp_data under Sultan's Game.app on macOS, GameAssembly.dll plus
 *                  il2cpp_data under Sultan's Game_Data on Windows
 *   vanilla        <gameDir>/.../StreamingAssets/config holds cards.json and rite/
 *   modInstallDir  ModLog/__mod.log sits beside it (or SultansGame/ does), and it is writable
 *   workshopDir    <library>/steamapps/workshop/content/3117820; empty means no subscriptions
 *
 * `appmanifest_3117820.acf` is a discovery aid only: it says which folder in a Steam library is
 * the game. It is never the verdict, so a manifest without the game's files proves nothing.
 *
 * The state file is `.gamer-agent.local.json` at the workspace root. It holds three keys this
 * module owns and one it only keeps:
 *
 *   gameDir        the install, the folder holding Sultan's Game.app / Sultan's Game_Data
 *   workshopDir    <library>/steamapps/workshop/content/3117820, derived from gameDir by path
 *   modInstallDir  <MyDocuments>/DoubleCross/SultansGame/Mod, derived from MyDocuments, which on
 *                  Windows is whatever the shell reports: a player can move it to another drive
 *   runtime        the dotnet path check_runtime resolved; never read or written here
 *
 * `vanillaDir` is not a key: it is derived from `gameDir` on every call, so a recorded one could
 * only be stale. A write drops it from the file.
 *
 * The resolution order is one chain per location: an explicit argument, then the state file,
 * then discovery (a candidate list built from the install hint and the Steam libraries). A value
 * from an earlier step is judged and reported even when it fails: a stale record must be loud,
 * not skipped. workshopDir is always derived from the install by path.
 *
 * `~` is expanded with os.homedir(). process.env.HOME does not exist on Windows.
 *
 * Exit codes: 0 when every required location is OK, 1 otherwise, 2 for a usage mistake.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "3117820";

/**
 * `mod-repo.json` as authored. Discovery uses its platform install hint, and the mod install
 * directory is derived from its `modInstall` entry. A missing or unreadable file reads as
 * empty: the built-in defaults describe this game, so the module still answers.
 */
export function readRepoConfig(repo = REPO) {
  try {
    const raw = JSON.parse(readFileSync(path.join(repo, "mod-repo.json"), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** The locations a mod cannot be made without. Everything else is reported but not judged. */
export const REQUIRED = ["gameDir", "vanilla", "modInstallDir"];

/** `~` expands against a home a caller supplied, so a test can describe another machine.
 *  The rule matches `.pi/lib/state.ts`: trim, and only `~` or `~/...` expand. */
const expandAt = (p, home) => {
  if (p === null || p === undefined) return null;
  const t = String(p).trim();
  if (t !== "~" && !t.startsWith("~/") && !t.startsWith("~\\")) return t;
  return t === "~" ? home : path.join(home, t.slice(2));
};

/**
 * `~` expands to the account's home directory. Never process.env.HOME: Windows has no such variable.
 * Shared with every tool that takes a path from the agent, because string-replacing `~` with the
 * home directory yields `C:\Users\x/y.json` on Windows when the argument was written `~/y.json`.
 */
export const expandHome = (p) => expandAt(p, os.homedir());

/** `~` expands to the account's home directory. Never process.env.HOME: Windows has no such variable. */
const expand = (p) => expandAt(p, os.homedir());

/**
 * The inverse, for printing: a path under the home directory shows as `~/...`.
 * Print paths with `/` on every platform: they are copied into chat, into a command and into a
 * SKILL, and a backslash there reads as an escape or disappears.
 */
export function shorten(p) {
  if (!p) return String(p);
  const home = os.homedir();
  const s = String(p);
  const out = s === home ? "~" : s.startsWith(home + path.sep) ? `~${s.slice(home.length)}` : s;
  return out.split(path.sep).join("/");
}

/** path.join per platform, so a Windows shape can be built on a Mac and asserted on. */
const styleOf = (platform) => (platform === "win32" ? path.win32 : path.posix);

/** One judged location. `status` is OK, MISS, EMPTY, FAIL or n/a. */
const row = (name, status, dir, reason, tried = []) => ({ name, status, path: dir ?? null, reason, tried });

// ---------------------------------------------------------------------------
// Steam libraries: the candidate list discovery walks, never a verdict
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
 * candidate list, not a decision: `judgeGameDir` accepts only the folder with the game's files.
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

// ---------------------------------------------------------------------------
// The game: a file the game ships inside its own folder
// ---------------------------------------------------------------------------

/**
 * The game's own files, relative to the install. These are the sentinel: a folder that holds
 * them is the game, and a folder that does not is not, whatever an app manifest says.
 *
 * macOS: verified on this machine — both files are in the installed bundle at
 *   ~/Library/Application Support/Steam/steamapps/common/Sultan's Game/Sultan's Game.app
 * The two are alternatives, because a re-export or a patched build can keep one and not the
 * other; whichever exists first is the reason reported.
 *
 * Windows UNVERIFIED: no Windows machine was measured, so this is the documented Unity/IL2CPP
 * layout (Unity writes both the IL2CPP runtime and its metadata next to the player). Both are
 * required, because either one alone also appears in unrelated Unity builds.
 */
export const GAME_MARKERS = {
  mac: [
    "Sultan's Game.app/Contents/Frameworks/GameAssembly.dylib",
    "Sultan's Game.app/Contents/Resources/Data/il2cpp_data",
  ],
  // GameAssembly.dll sits in the install root; only il2cpp_data is inside _Data.
  windows: ["GameAssembly.dll", "Sultan's Game_Data/il2cpp_data"],
};

const markersFor = (platform) => (platform === "win32" ? GAME_MARKERS.windows : GAME_MARKERS.mac);

/** The marker that proves the folder holds the game, as reported text, or null. */
function markerOf(install, platform) {
  const markers = markersFor(platform);
  const found = markers.filter((rel) => existsSync(path.join(install, rel)));
  if (platform === "win32") return found.length === markers.length ? found.join(" and ") : null;
  return found[0] ?? null;
}

/**
 * The install a path names, or null. The install is the folder that holds `Sultan's Game.app`
 * (macOS) or `Sultan's Game_Data` (Windows); a player may hand us the bundle or a folder inside
 * it instead, so the walk goes up to the folder that holds the game's files.
 */
export function installOf(dir, platform = process.platform) {
  if (!dir) return null;
  let current = path.resolve(dir);
  // A caller may paste the vanilla config directory: it is six levels below the install, so the
  // walk needs the extra room, and its own sentinel says where it belongs.
  const isConfig = existsSync(path.join(current, "cards.json")) && existsSync(path.join(current, "rite"));
  if (isConfig) current = path.dirname(current);
  for (let up = 0; up < 8; up++) {
    if (markerOf(current, platform)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** The `gameDir` row. */
export function judgeGameDir(dir, platform = process.platform) {
  if (!dir) return row("gameDir", "MISS", null, "no game directory was given or recorded");
  const resolved = path.resolve(expand(dir));
  if (!existsSync(resolved)) return row("gameDir", "MISS", resolved, "no such directory");
  const install = installOf(resolved, platform);
  if (!install) {
    return row(
      "gameDir",
      "FAIL",
      resolved,
      `the game's own files are not in this folder (looked for ${markersFor(platform).join(", ")})`,
    );
  }
  return row("gameDir", "OK", install, `${markerOf(install, platform)} present`);
}

/**
 * Candidate install directories for discovery, in the order a player would look: the recorded
 * game, this platform's install hint, then what each Steam library says. The manifest naming an
 * `installdir` is a shortcut, not a proof: every candidate is judged by `judgeGameDir`.
 */
export function gameDirCandidates({
  cfg = null,
  state = {},
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const p = styleOf(platform);
  const out = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) out.push(expandAt(v, home));
  };
  push(state.gameDir);
  const hint = cfg?.game?.installDirHint?.[platform];
  push(hint);
  const folder = (hint && p.basename(hint)) || "Sultan's Game";
  for (const lib of steamCandidates({ platform, home, env })) {
    const named = installdirOf(lib);
    if (named) push(p.join(lib, "steamapps", "common", named));
    push(p.join(lib, "steamapps", "common", folder));
  }
  return [...new Set(out)];
}

/** The first candidate that holds the game's own files. Discovery is not trust: each is judged. */
export function discoverGameDir({
  cfg = null,
  state = {},
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const tried = gameDirCandidates({ cfg, state, platform, home, env });
  for (const candidate of tried) {
    const judged = judgeGameDir(candidate, platform);
    if (judged.status === "OK") return { install: judged.path, tried };
  }
  return { install: null, tried };
}

// ---------------------------------------------------------------------------
// The vanilla config: always derived from the install, never a parameter or a key
// ---------------------------------------------------------------------------

/**
 * The config directory of an install, by platform. Derived on every call: nothing records it,
 * so nothing can go stale. The macOS bundle shape is measured on this machine; the Windows
 * shape is UNVERIFIED.
 */
export function vanillaFrom(install, platform = process.platform) {
  if (!install) return null;
  const rel =
    platform === "win32"
      ? ["Sultan's Game_Data", "StreamingAssets", "config"]
      : ["Sultan's Game.app", "Contents", "Resources", "Data", "StreamingAssets", "config"];
  return path.join(install, ...rel);
}

function judgeVanilla(dir) {
  if (!dir) return row("vanilla", "MISS", null, "derived from the game directory, which was not found");
  if (!existsSync(dir)) return row("vanilla", "MISS", dir, "no such directory");
  const missing = ["cards.json", "rite"].filter((f) => !existsSync(path.join(dir, f)));
  if (missing.length) return row("vanilla", "FAIL", dir, `missing ${missing.join(" and ")}`);
  return row("vanilla", "OK", dir, "cards.json, rite/");
}

// ---------------------------------------------------------------------------
// The mod install directory and the workshop
// ---------------------------------------------------------------------------

/**
 * The `Personal` value under one registry key: the line reads `    Personal    REG_SZ    <path>`.
 * A moved Documents directory shows up only here, never in the environment.
 */
function personalFolder(key) {
  // `reg` by bare name is not enough: the app host runs with its own PATH, and one without
  // C:\Windows\System32 would silently answer "no registry" and fall back to the wrong folder.
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidates = [path.win32.join(systemRoot, "System32", "reg.exe"), "reg"];
  for (const exe of candidates) {
    try {
      const out = execFileSync(exe, ["query", key, "/v", "Personal"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const line = out.match(/^\s*Personal\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m);
      return line ? line[1] : null;
    } catch (error) {
      // A missing key is an answer; a missing executable is a reason to try the next spelling.
      if (error?.code !== "ENOENT") return null;
    }
  }
  return null;
}

let documentsCache;

/**
 * The player's Documents directory, asked of the system on Windows.
 *
 * A player can move it (a second drive is the common reason), and `<home>/Documents` then either
 * does not exist or is an empty leftover. The game asks the shell for the folder, so the answer
 * comes from the same two registry keys: `Shell Folders` holds it resolved, `User Shell Folders`
 * may hold `%USERPROFILE%` and is expanded.
 *
 * A caller that passes `home` is describing a machine it made up; the lookup is skipped and
 * `<home>/Documents` stands in, so a test never reads the real registry. `SUDAN_DOCUMENTS_DIR`
 * pins the answer outright, which is what a test that only fakes the environment needs, and
 * `read` replaces the registry call itself so a test can state what the machine would answer.
 */
const SHELL_FOLDER_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
];

/** Ask the registry, key by key, and expand the variables `User Shell Folders` may hold. */
function shellDocuments(read, p) {
  for (const key of SHELL_FOLDER_KEYS) {
    const raw = read(key);
    if (!raw) continue;
    const expanded = raw.replace(/%([^%]+)%/g, (_m, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? "");
    const dir = p.win32.normalize(expanded.replace(/[\\/]+$/, ""));
    if (expanded.includes("%") || !dir) continue;
    return dir;
  }
  return null;
}

export function documentsDirFor({ platform = process.platform, home = null, documents = null, read = null } = {}) {
  const p = styleOf(platform);
  // Most specific first: a stated folder, a stated registry answer, a made-up machine's home, a
  // pinned folder, the real registry, the old assumption.
  if (documents) return p.normalize(documents);
  if (read) return shellDocuments(read, p) ?? p.join(os.homedir(), "Documents");
  if (home !== null) return p.join(home, "Documents");
  const pinned = process.env.SUDAN_DOCUMENTS_DIR ? process.env.SUDAN_DOCUMENTS_DIR.trim() : null;
  if (pinned) return p.normalize(pinned);
  const fallback = p.join(os.homedir(), "Documents");
  if (platform !== "win32" || process.platform !== "win32") return fallback;
  if (documentsCache === undefined) documentsCache = shellDocuments(personalFolder, p);
  return documentsCache ?? fallback;
}

/**
 * `<MyDocuments>/DoubleCross/SultansGame/Mod`. The game computes it with
 * `Environment.GetFolderPath(MyDocuments)`: the folder Windows reports on Windows (a player can
 * move it, so it is not `%USERPROFILE%\Documents`), `$HOME` on macOS. `mod-repo.json` records the
 * same two facts, and is read when a caller passes `cfg`.
 */
export function modInstallDirFor({ platform = process.platform, home = null, cfg = null, documents = null } = {}) {
  const p = styleOf(platform);
  const spec = cfg?.modInstall ?? null;
  const declared = spec?.path?.[platform];
  const rel = typeof declared === "string" && declared.trim() ? declared : "DoubleCross/SultansGame/Mod";
  const relativeTo = spec?.relativeTo?.[platform] ?? (platform === "win32" ? "userDocuments" : "home");
  const base = relativeTo === "userDocuments" ? (documents ?? documentsDirFor({ platform, home })) : (home ?? os.homedir());
  return p.join(base, rel);
}

const writable = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

function judgeModInstallDir(dir) {
  if (!dir) return row("modInstallDir", "MISS", null, "no MyDocuments base to build it from");
  // A directory named Mod proves nothing. The base is confirmed by the game's own folder beside
  // it, or by the log the game writes there. Either missing on a fresh machine means the base is
  // a guess, and a guessed base would put the mod in the player's home directory.
  const beside = path.dirname(dir);
  const log = path.join(beside, "ModLog", "__mod.log");
  const baseNamed = path.basename(beside).toLowerCase() === "sultansgame";
  const baseExists = existsSync(beside);
  if (!existsSync(dir)) {
    if (baseNamed) return row("modInstallDir", "MISS", dir, baseExists ? "not created yet; the game creates it on first launch" : "not created yet; the MyDocuments base is not there either");
    return row("modInstallDir", "MISS", dir, "nothing confirms this base: no SultansGame/ beside it and no ModLog/__mod.log");
  }
  if (!existsSync(log) && !baseNamed) return row("modInstallDir", "FAIL", dir, "no ModLog/__mod.log beside it and its parent is not SultansGame/");
  if (!writable(dir)) return row("modInstallDir", "FAIL", dir, "not writable");
  return row("modInstallDir", "OK", dir, existsSync(log) ? "ModLog/__mod.log present" : "SultansGame/ present");
}

/** The library a game directory belongs to: the nearest folder above it that holds steamapps/. */
function libraryOf(install) {
  if (!install) return null;
  let dir = path.resolve(install);
  for (;;) {
    if (existsSync(path.join(dir, "steamapps"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The workshop content folder of a Steam library: derived from the install, never asked for. */
export const workshopOf = (library) =>
  library ? path.join(library, "steamapps", "workshop", "content", APP_ID) : null;

const workshopFrom = (install) => workshopOf(libraryOf(install));

function judgeWorkshop(dir) {
  if (!dir) return row("workshopDir", "MISS", null, "no Steam library above the game directory, so no workshop content");
  if (!existsSync(dir)) return row("workshopDir", "MISS", dir, "no workshop content directory; nothing subscribed");
  let items = [];
  try {
    items = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "info.json")))
      .map((e) => e.name);
  } catch (e) {
    return row("workshopDir", "MISS", dir, `cannot be read: ${e.code || e.message}`);
  }
  if (!items.length) return row("workshopDir", "EMPTY", dir, "no subscribed workshop items; not an error");
  return row("workshopDir", "OK", dir, `${items.length} item(s)`);
}

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
 * The same file, but a broken one is an error instead of an empty object. A writer that treated
 * `{` as `{}` would drop every key it does not own — `runtime` included — and still report PASS.
 */
function readRawForWrite(file) {
  if (!file || !existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      `state file is not valid JSON: ${file}. Fix or delete it; this run wrote nothing.`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`state file is not a JSON object: ${file}. Fix or delete it; this run wrote nothing.`);
  }
  return raw;
}

/**
 * The state file, read as the three keys this module owns. Absent is normal and reads as
 * empty; invalid JSON is reported rather than thrown, because every tool imports this module.
 * `present` says whether the file existed, so a report can say "nothing recorded yet" instead
 * of implying that discovery failed.
 */
export function readRecord(file = pathsFile()) {
  const empty = { gameDir: null, workshopDir: null, modInstallDir: null, present: false, problem: null };
  if (!file || !existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      gameDir: text(raw.gameDir),
      workshopDir: text(raw.workshopDir),
      modInstallDir: text(raw.modInstallDir),
      present: true,
      problem: null,
    };
  } catch (e) {
    return { ...empty, present: true, problem: `${shorten(file)} is not valid JSON: ${e.message}` };
  }
}

/**
 * What judged rows put in the file, without writing it. Only the keys that can be computed are
 * here: the game row must be OK, so a path that does not hold the game is never recorded, and
 * the two derived locations are recorded even when their folder does not exist yet (the folder
 * is derived, not guessed). `vanillaDir` is absent on purpose: it is derived on every read.
 */
export function recordOf(rows) {
  const find = (name) => rows.find((r) => r.name === name);
  const out = {};
  const game = find("gameDir");
  if (game?.status === "OK" && game.path) {
    out.gameDir = game.path;
    const workshop = workshopFrom(game.path);
    out.workshopDir = workshop || null;
  }
  // A mod install directory that fails its sentinel is not recorded: null says "not derived",
  // and an old value must not survive as if it still described this machine.
  const mod = find("modInstallDir");
  out.modInstallDir = mod && mod.status !== "FAIL" && mod.path ? mod.path : null;
  return out;
}

/**
 * Write the keys this module owns. Every other key is merged back unchanged, and the retired
 * `vanillaDir` is dropped so the file cannot claim a config the game no longer has.
 */
export function writeRecord(rows, file = pathsFile()) {
  const { vanillaDir: _retired, ...raw } = readRawForWrite(file);
  const body = recordOf(rows);
  mkdirSync(path.dirname(file), { recursive: true });
  // Atomic replace: another writer (state.ts) may read this file while we write it.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ ...raw, ...body }, null, 2)}\n`);
  renameSync(tmp, file);
  return body;
}

// ---------------------------------------------------------------------------
// The judgment
// ---------------------------------------------------------------------------

/**
 * Judge every location once. `opts` exists so a test can build a whole world in a temp
 * directory: pass `platform`, `home`, `env`, `cfg` or `file` to replace the real ones.
 *
 * Returns `{ rows, ok, problem, present }`; `ok` is true when every required row is OK, and
 * `present` is false when the state file does not exist yet.
 */
export function judge(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const cfg = opts.cfg ?? readRepoConfig();
  const file = opts.file === undefined ? pathsFile() : opts.file;
  const saved = readRecord(file);

  // gameDir: explicit -> the state file -> discovery. A stale record is judged and reported.
  const namedGame = opts.gameDir ?? saved.gameDir;
  let game;
  if (namedGame) game = judgeGameDir(expandAt(namedGame, home), platform);
  else {
    const found = discoverGameDir({ cfg, state: saved, platform, home, env });
    game = found.install
      ? judgeGameDir(found.install, platform)
      : row("gameDir", "MISS", null, `the game's own files are in none of ${found.tried.length} candidate(s)`, found.tried);
  }

  // vanilla: derived from whichever game directory was judged, every time.
  const vanilla = judgeVanilla(game.status === "OK" ? vanillaFrom(game.path, platform) : null);

  // modInstallDir: explicit -> derived from the shell's Documents folder -> the state file. The
  // derivation is a measurement (the shell answers where Documents is), so it wins over the
  // record, which is only a cache of it. `workshopDir` follows the same rule for the same reason:
  // a stale record must not survive the thing it was derived from.
  const derivedMod = modInstallDirFor({ platform, home: opts.home, cfg });
  const derivedRow = judgeModInstallDir(derivedMod);
  const recordedMod = saved.modInstallDir ? judgeModInstallDir(expandAt(saved.modInstallDir, home)) : null;
  // The record stands only when it works and the derivation does not: a machine whose registry
  // cannot be read keeps the path that was right before.
  const modInstall = opts.modInstallDir
    ? judgeModInstallDir(expandAt(opts.modInstallDir, home))
    : derivedRow.status === "OK" || !recordedMod || recordedMod.status !== "OK"
      ? derivedRow
      : recordedMod;

  // workshopDir: explicit -> derived from a game directory that judged OK -> the state file. The
  // derived value must win while gameDir is OK, or a stale record points at another library.
  const namedWorkshop = opts.workshopDir ?? (game.status === "OK" ? null : saved.workshopDir);
  const workshop = judgeWorkshop(
    namedWorkshop ? expandAt(namedWorkshop, home) : workshopFrom(game.status === "OK" ? game.path : null),
  );

  const rows = [game, vanilla, modInstall, workshop];
  const ok = REQUIRED.every((name) => rows.find((r) => r.name === name)?.status === "OK");
  return { rows, ok, problem: saved.problem, present: saved.present };
}

/** The three derived locations a recording tool reports, taken from its judged rows. */
function derivedPaths(rows) {
  const of = (name) => rows.find((r) => r.name === name)?.path ?? null;
  return { gameDir: of("gameDir"), vanillaDir: of("vanilla"), modInstallDir: of("modInstallDir"), workshopDir: of("workshopDir") };
}

/** The locations that are not OK, as WARN lines. None of them blocks: they are what to tell the player. */
function derivedWarnings(rows) {
  const out = [];
  for (const name of ["vanilla", "modInstallDir", "workshopDir"]) {
    const r = rows.find((x) => x.name === name);
    if (!r || r.status === "OK" || (name === "workshopDir" && r.status === "EMPTY")) continue;
    const what =
      name === "modInstallDir" && !existsSync(r.path ?? "")
        ? "the mod install directory does not exist yet - normal before the game's first launch"
        : r.reason;
    out.push(`${name}: ${what}`);
  }
  return out;
}

const ASK_PLAYER =
  "Ask the player where the game is installed (the folder that holds Sultan's Game.app on macOS, or Sultan's Game_Data on Windows), then pass that path to set_game_dir. The 'setup-workspace' skill lists the sentinels.";

/**
 * `try_set_game_dir` behind the tool: make sure the game directory is recorded and still valid.
 *
 *   1. the recorded gameDir still holds the game, and the derived keys match this platform
 *      -> "already", nothing written
 *   2. no record, a stale one, or derived keys that disagree -> discover, record -> "recorded"
 *   3. discovery finds nothing -> "missing", nothing written
 */
export function ensureGameDir(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const cfg = opts.cfg ?? readRepoConfig();
  const file = opts.file === undefined ? pathsFile() : opts.file;
  const saved = readRecord(file);

  const recorded = saved.gameDir ? judgeGameDir(expandAt(saved.gameDir, home), platform) : null;
  let install = recorded?.status === "OK" ? recorded.path : null;
  let status = "already";
  if (!install) {
    const found = discoverGameDir({ cfg, state: saved, platform, home, env });
    if (!found.install) {
      return {
        status: "missing",
        reason: `automatic discovery found no folder holding the game's own files (${found.tried.length} candidate(s) searched)`,
        next: ASK_PLAYER,
      };
    }
    install = found.install;
    status = "recorded";
  }

  const judged = judge({ gameDir: install, file: null, platform, home: opts.home, env, cfg });
  const body = recordOf(judged.rows);
  const same = Object.keys(body).every((key) => saved[key] === body[key]);
  // Nothing was discovered when the recorded game directory still holds the game: only the keys
  // derived from it changed. Reporting "discovered" there would say a search ran when none did.
  if (status === "already" && !same) status = "derived";
  if (status === "already") {
    return { status, recorded: install, ...derivedPaths(judged.rows), warnings: derivedWarnings(judged.rows) };
  }
  writeRecord(judged.rows, file);
  return {
    status,
    recorded: install,
    ...derivedPaths(judged.rows),
    warnings: derivedWarnings(judged.rows),
  };
}

/**
 * `set_game_dir` behind the tool: record one game directory.
 *
 *   1. the given path holds the game -> record it and what it derives -> PASS
 *   2. it does not -> discover; if discovery finds the game, record that and say so -> WARN
 *   3. discovery fails too -> record nothing -> FAIL
 */
export function setGameDirWithFallback(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const cfg = opts.cfg ?? readRepoConfig();
  const file = opts.file === undefined ? pathsFile() : opts.file;
  const given = typeof opts.given === "string" && opts.given.trim() ? expandAt(opts.given.trim(), home) : null;
  if (!given) {
    return {
      status: "FAIL",
      given: null,
      recorded: null,
      reason: "no path was given",
      next: `Run try_set_game_dir (no arguments) to find the game and record it. ${ASK_PLAYER}`,
    };
  }

  const judgedGiven = judgeGameDir(given, platform);
  if (judgedGiven.status === "OK") {
    const judged = judge({ gameDir: judgedGiven.path, file: null, platform, home: opts.home, env, cfg });
    writeRecord(judged.rows, file);
    return {
      status: "PASS",
      given,
      recorded: judgedGiven.path,
      ...derivedPaths(judged.rows),
      warnings: derivedWarnings(judged.rows),
    };
  }

  const found = discoverGameDir({ cfg, state: readRecord(file), platform, home, env });
  if (found.install) {
    const judged = judge({ gameDir: found.install, file: null, platform, home: opts.home, env, cfg });
    writeRecord(judged.rows, file);
    return {
      status: "WARN",
      given,
      recorded: found.install,
      reason: judgedGiven.reason,
      next: `The path you passed did not pass validation, so ${shorten(found.install)} was located and recorded instead. Tell the player which path is now in use.`,
      ...derivedPaths(judged.rows),
      warnings: derivedWarnings(judged.rows),
    };
  }

  return {
    status: "FAIL",
    given,
    recorded: null,
    reason: `${judgedGiven.reason} (automatic discovery found nothing either)`,
    next: ASK_PLAYER,
  };
}

/**
 * The vanilla config a tool needs before it can do its work, or the FAIL text that stops it.
 * A tool with no vanilla must say so and exit non-zero: an empty page is a lie.
 */
export function vanillaRequirement(explicit, opts = {}) {
  const found = explicit
    ? judgeVanilla(expand(explicit))
    : judge(opts).rows.find((r) => r.name === "vanilla");
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
  if (next) process.stdout.write(`NEXT: ${next}\n`);
};

function printRows(rows) {
  for (const r of rows) {
    const where = r.path ? shorten(r.path) : "(not found)";
    process.stdout.write(`${r.name.padEnd(14)} ${r.status.padEnd(5)} ${where}${r.reason ? `  (${r.reason})` : ""}\n`);
    for (const tried of r.tried) process.stdout.write(`${" ".repeat(21)}tried ${shorten(tried)}\n`);
  }
}

/** Flags with a value. Anything else is a usage error, not something to ignore. */
const VALUED = new Set(["game-dir", "workshop", "mod-install", "paths"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).trim();
    if (!VALUED.has(name)) throw new Error(`unknown flag --${name}`);
    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      i++;
    }
    if (!value.trim()) throw new Error(`--${name} needs a value`);
    out[name] = value;
  }
  return out;
}

const judgeArgs = (args) => ({
  gameDir: args["game-dir"],
  workshopDir: args.workshop,
  modInstallDir: args["mod-install"],
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
    "NEXT:",
    "run `node tools/paths.mjs set --game-dir <game directory>`; the sentinels are in .pi/skills/setup-workspace/SKILL.md",
  );
  return 1;
}

/**
 * Record what was verified. Nothing is written unless the game directory holds the game: a
 * recorded path that does not is worse than none. `set --game-dir` is the CLI of `set_game_dir`;
 * without it, `set` is the CLI of `try_set_game_dir` and records what discovery found. The
 * workshop and the mod install directory are derived, so `set` takes no flag for them.
 */
function set(args) {
  const file = args.paths ?? pathsFile();
  const out = args["game-dir"] ? setGameDirWithFallback({ given: args["game-dir"], file }) : ensureGameDir({ file });
  if (out.status === "FAIL" || out.status === "missing") {
    emit("FAIL", out.reason ?? "the game directory was not found", out.next);
    return 1;
  }
  if (out.status === "WARN") {
    emit("WARN", `${shorten(out.given)} did not validate: ${out.reason}`, `recorded ${shorten(out.recorded)} instead`);
  }
  if (out.status === "already") {
    emit("PASS", `already recorded: ${shorten(out.recorded)}`, "nothing was written; `node tools/paths.mjs check` re-reads it");
    return 0;
  }
  emit("PASS", `recorded ${shorten(file)}`, "run `node tools/paths.mjs check` to confirm it reads back");
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "check";
  let args;
  try {
    args = parseArgs(cmd === "check" ? argv : argv.slice(1));
  } catch (error) {
    // Exit 2 is the promise in the file header: a usage error must not fall back to discovery.
    process.stderr.write(`paths: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(
      "usage: node tools/paths.mjs check [--game-dir <dir>] [--workshop <dir>] [--mod-install <dir>] [--paths <file>]\n" +
        "       node tools/paths.mjs set [--game-dir <dir>] [--paths <file>]\n",
    );
    return 2;
  }
  try {
    if (cmd === "check") return check(args);
    if (cmd === "set") return set(args);
  } catch (error) {
    // A broken state file or an unwritable path: one line, exit 2, no stack trace to read past.
    process.stderr.write(`paths: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stderr.write(
    "usage: node tools/paths.mjs check [--game-dir <dir>] [--workshop <dir>] [--mod-install <dir>] [--paths <file>]\n" +
      "       node tools/paths.mjs set [--game-dir <dir>] [--paths <file>]\n",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("paths.mjs")) process.exit(main());
