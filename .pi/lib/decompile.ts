/**
 * The decompiled dump: where it lives, whether it is current, how to rebuild it,
 * and how to read it.
 *
 * The dump is a cache, not a source of truth. It is rebuilt from the installed
 * game with pinned tools, so it can always be recreated; the evidence is the
 * build identity recorded in `MANIFEST.json` (game binary and metadata sha256,
 * tool sha256). It lives outside every repository, under the product data root,
 * in a folder named after this repository.
 *
 * Nothing here trusts a name or a path from a previous run: the game files, the
 * tools, and the platform are resolved on every call.
 */
import { closeSync, createReadStream, createWriteStream, existsSync, chmodSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { clipUtf8 } from "./clip";
import os from "node:os";
import { runAsync } from "./proc";
import { repoName, readState } from "./state";

// (hashing helper below; no child-process wrapper is kept here beyond runAsync)

// ── configuration ───────────────────────────────────────────────────────────

export interface DumpConfig {
  /** Assemblies the dump keeps. Empty means "dump nothing by default". */
  assemblies: string[];
  /** IL2CPP only: drop il2cpp.h (84 MB, only for Ghidra/IDA). */
  dropIl2cppHeader?: boolean;
  /** IL2CPP only: gzip script.json (78 MB -> 5 MB). */
  gzipScriptJson?: boolean;
  /** Refuse to write more than this many bytes. */
  budgetBytes?: number;
}

export interface DecompileConfig {
  version: number;
  runtime: "il2cpp";
  dump: DumpConfig;
}

export const configPath = (cwd: string): string => join(cwd, ".pi/lib/decompile.json");

export function loadConfig(cwd: string): DecompileConfig {
  const file = configPath(cwd);
  if (!existsSync(file)) {
    throw new Error(
      `DECOMPILE_CONFIG_MISSING: ${file} does not exist. This repository has no statement of what to dump.`,
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as DecompileConfig;
  if (!Array.isArray(raw?.dump?.assemblies)) {
    throw new Error("DECOMPILE_CONFIG_INVALID: .pi/lib/decompile.json has no dump.assemblies array.");
  }
  if (raw.runtime !== "il2cpp") {
    throw new Error(`DECOMPILE_CONFIG_INVALID: runtime "${String(raw.runtime)}" is not supported by this repository.`);
  }
  return raw;
}

/** The parts of the config that decide the dump's shape (not its budget). */
export function configSignature(cfg: DecompileConfig): string {
  return JSON.stringify({
    assemblies: [...cfg.dump.assemblies].sort(),
    dropIl2cppHeader: cfg.dump.dropIl2cppHeader !== false,
    gzipScriptJson: cfg.dump.gzipScriptJson !== false,
  });
}

// ── paths ───────────────────────────────────────────────────────────────────

/** Product data root, then the shared dump root, then one folder per repository. */
export function decompileRoot(): string {
  if (process.env.DECOMPILED_ROOT) return process.env.DECOMPILED_ROOT;
  const data = process.env.PI_DESKTOP_DATA_DIR || join(os.homedir(), ".gamer-agent-pi");
  return join(data, "decompiled");
}

export const dumpDir = (cwd: string): string => join(decompileRoot(), repoName(cwd));
export const toolsDir = (): string => join(decompileRoot(), "tools");

// ── hashing and small fs helpers ────────────────────────────────────────────

const hashCache = new Map<string, { key: string; value: string }>();

export function sha256File(path: string): string {
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = hashCache.get(path);
  if (hit && hit.key === key) return hit.value;
  const value = createHash("sha256").update(readFileSync(path)).digest("hex");
  hashCache.set(path, { key, value });
  return value;
}

const dirBytes = (dir: string): number => {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
};

const countFiles = (dir: string, ext: string): number => {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(p, ext);
    else if (entry.name.endsWith(ext)) n += 1;
  }
  return n;
};

/** True when the file starts with a Mach-O universal (fat) header. */
function isUniversalMachO(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    return head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && (head[3] === 0xbe || head[3] === 0xbf);
  } finally {
    closeSync(fd);
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

export interface ToolRef {
  path: string;
  sha256: string;
  version: string;
}

const CPP2IL_NAMES: Record<string, string> = {
  "darwin:arm64": "cpp2il-osx-arm64",
  "darwin:x64": "cpp2il-osx-x64",
  "linux:arm64": "cpp2il-linux-arm64",
  "linux:x64": "cpp2il-linux-x64",
  "win32:arm64": "cpp2il-win-arm64.exe",
  "win32:x64": "cpp2il-win-x64.exe",
};

/**
 * The Cpp2IL release ships one native binary per OS and CPU, so pick by platform
 * and then prove it runs: a misnamed copy from another system fails to exec.
 */
export function cpp2ilPath(): string | null {
  const name = CPP2IL_NAMES[`${process.platform}:${process.arch}`];
  return name ? join(toolsDir(), "cpp2il", name) : null;
}

export async function findCpp2il(): Promise<ToolRef> {
  const path = cpp2ilPath();
  if (!path) {
    throw new Error(`CPP2IL_UNSUPPORTED_PLATFORM: no Cpp2IL build for ${process.platform} ${process.arch}.`);
  }
  if (!existsSync(path)) {
    throw new Error(
      `CPP2IL_MISSING: expected ${path}. This is the tool that produces method bodies.\nNEXT: run action=setup, which downloads and verifies it.`,
    );
  }
  let version = "";
  try {
    const out = await runAsync(path, ["--version"], { timeoutMs: 20_000 });
    version = (out.stdout.match(/Version\s+(\S+)/) ?? [])[1] ?? "";
  } catch {
    throw new Error(
      `CPP2IL_NOT_RUNNABLE: ${path} failed to run on ${process.platform} ${process.arch}.\nNEXT: run action=setup to fetch a working copy.`,
    );
  }
  return { path, sha256: sha256File(path), version };
}

/**
 * The tools that produce the dump. `decompile.json` says what to dump; this says
 * which binary does it. Both live in the repository, so the player can change a
 * download location without touching code.
 */
export interface Toolchain {
  version: number;
  download?: { mirrors?: string[] };
  tools?: Record<
    string,
    {
      version?: string;
      release?: string;
      assets?: Record<string, { file: string; bytes: number; sha256: string; sign?: boolean }>;
    }
  >;
}

const toolchainPath = (cwd: string): string => join(cwd, "tools/toolchain.json");

export function loadToolchain(cwd: string): Toolchain {
  const file = toolchainPath(cwd);
  if (!existsSync(file)) {
    throw new Error(`TOOLCHAIN_MISSING: ${file} does not exist. It says where Cpp2IL comes from.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Toolchain;
}

/** Il2CppDumper is bundled (736 KB, platform-neutral); Cpp2IL is not. */
export function findIl2CppDumper(cwd: string): ToolRef {
  const bundled = join(cwd, "tools/il2cppdumper/Il2CppDumper.dll");
  const dll = existsSync(bundled) ? bundled : join(toolsDir(), "il2cppdumper/Il2CppDumper.dll");
  if (!existsSync(dll)) {
    throw new Error(`IL2CPPDUMPER_MISSING: expected ${bundled}. This is the tool that produces signatures.\nNEXT: restore tools/il2cppdumper/ (it is part of the repository).`);
  }
  // No version probe: the tool targets net7 and its only self-report needs a
  // console. The sha256 below is the identity that matters.
  return { path: dll, sha256: sha256File(dll), version: "" };
}

export interface SetupResult {
  status: "installed" | "skipped";
  path: string;
  sha256: string;
  signed: boolean;
  seconds: number;
  attempts: string[];
}

/**
 * Fetch Cpp2IL for this platform. The digest in toolchain.json is the only thing
 * trusted: mirrors may serve the bytes, but they may not change them. On Apple
 * Silicon the release binary is unsigned and is killed on launch, so it is
 * signed here; that changes its digest, which is why the recorded identity is
 * the local one.
 */
export async function setupCpp2il(
  cwd: string,
  onProgress: (message: string) => void = () => undefined,
): Promise<SetupResult> {
  const started = Date.now();
  const attempts: string[] = [];
  const key = `${process.platform}:${process.arch}`;
  const chain = loadToolchain(cwd).tools?.cpp2il;
  const asset = chain?.assets?.[key];
  const target = cpp2ilPath();
  if (!chain?.release || !asset || !target) {
    throw new Error(
      `TOOLCHAIN_UNSUPPORTED_PLATFORM: tools/toolchain.json has no Cpp2IL asset for ${key}. Add one, or install the binary at ${target ?? "the cpp2il folder"}.`,
    );
  }

  if (existsSync(target)) {
    try {
      await runAsync(target, ["--version"], { timeoutMs: 20_000 });
      return {
        status: "skipped",
        path: target,
        sha256: sha256File(target),
        signed: process.platform === "darwin",
        seconds: (Date.now() - started) / 1000,
        attempts: [],
      };
    } catch {
      attempts.push(`${target} exists but does not run; replacing it`);
    }
  }

  const mirrors = loadToolchain(cwd).download?.mirrors ?? [""];
  const encoded = `${chain.release}${asset.file}`;
  let bytes: Buffer | null = null;
  for (const mirror of mirrors) {
    const label = mirror ? mirror.replace(/^https?:\/\//, "").replace(/\/$/, "") : "github.com (direct)";
    onProgress(`Downloading Cpp2IL from ${label} (${Math.round(asset.bytes / 1048576)} MB)`);
    try {
      const res = await fetch(`${mirror}${encoded}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== asset.bytes) throw new Error(`size ${buf.length}, expected ${asset.bytes}`);
      const digest = createHash("sha256").update(buf).digest("hex");
      if (digest !== asset.sha256) throw new Error(`sha256 ${digest.slice(0, 16)} does not match`);
      bytes = buf;
      attempts.push(`${label}: ${(buf.length / 1048576).toFixed(1)} MB, digest ok`);
      break;
    } catch (error) {
      attempts.push(`${label}: ${(error as Error).message}`);
    }
  }
  if (!bytes) {
    throw new Error(
      `CPP2IL_DOWNLOAD_FAILED: no source delivered the expected file.\n  ${attempts.join("\n  ")}\n` +
        `NEXT: download ${encoded} yourself and put it at ${target}, then run action=setup again to verify it.`,
    );
  }

  mkdirSync(join(target, ".."), { recursive: true });
  const tmp = `${target}.part-${process.pid}`;
  writeFileSync(tmp, bytes);
  chmodSync(tmp, 0o755);
  let signed = false;
  if (asset.sign && process.platform === "darwin") {
    onProgress("Signing the binary (Apple Silicon refuses unsigned code)");
    await runAsync("codesign", ["--force", "--sign", "-", "--identifier", target.split("/").pop() as string, tmp], {
      timeoutMs: 60_000,
    });
    signed = true;
  }
  renameSync(tmp, target);
  try {
    await runAsync(target, ["--version"], { timeoutMs: 20_000 });
  } catch {
    throw new Error(
      `CPP2IL_NOT_RUNNABLE: ${target} was written but does not run (signed: ${signed}). On macOS an unsigned or wrongly signed arm64 binary is killed on launch.`,
    );
  }
  return {
    status: "installed",
    path: target,
    sha256: sha256File(target),
    signed,
    seconds: (Date.now() - started) / 1000,
    attempts,
  };
}

// ── the game ────────────────────────────────────────────────────────────────

export interface GameFiles {
  /** The folder a player would call "the game" (holds the .app on macOS). */
  gameDir: string;
  /** What `--game-path` receives. */
  gamePath: string;
  /** The IL2CPP binary, thinned for one architecture when it is universal. */
  binary: string;
  metadata: string;
  exeName: string | null;
  universal: boolean;
}

interface Candidates {
  gameDir: string;
  exeName: string | null;
}

function macAppBundle(dir: string): string | null {
  if (dir.endsWith(".app") && existsSync(join(dir, "Contents"))) return dir;
  if (!existsSync(dir)) return null;
  const apps = readdirSync(dir).filter((n) => n.endsWith(".app"));
  return apps.length ? join(dir, apps[0]) : null;
}

function macExeName(app: string): string | null {
  const macos = join(app, "Contents/MacOS");
  if (existsSync(macos)) {
    const first = readdirSync(macos)[0];
    if (first) return first;
  }
  return null;
}

function windowsDataDir(gameDir: string): string | null {
  if (!existsSync(gameDir)) return null;
  const data = readdirSync(gameDir).find((n) => n.endsWith("_Data"));
  return data ? join(gameDir, data) : null;
}

function inspect(dir: string): GameFiles | null {
  const gameDir = resolve(dir);
  if (process.platform === "darwin") {
    const app = macAppBundle(gameDir);
    if (!app) return null;
    const binary = join(app, "Contents/Frameworks/GameAssembly.dylib");
    const metadata = join(app, "Contents/Resources/Data/il2cpp_data/Metadata/global-metadata.dat");
    if (!existsSync(binary) || !existsSync(metadata)) return null;
    return {
      gameDir,
      gamePath: app,
      binary,
      metadata,
      exeName: macExeName(app),
      universal: isUniversalMachO(binary),
    };
  }
  const binary = join(gameDir, "GameAssembly.dll");
  const data = windowsDataDir(gameDir);
  const metadata = data ? join(data, "il2cpp_data/Metadata/global-metadata.dat") : "";
  if (!existsSync(binary) || !metadata || !existsSync(metadata)) return null;
  return { gameDir, gamePath: gameDir, binary, metadata, exeName: null, universal: false };
}

/**
 * Find the installed game. Order: an explicit path, the path recorded by an
 * earlier call, the hint in `mod-repo.json`, then the usual Steam libraries.
 * Every candidate is verified by the files the dump actually needs.
 */
export function resolveGame(cwd: string, hint: string | null | undefined, override?: string): GameFiles | null {
  const tried: Candidates[] = [];
  const seen = new Set<string>();
  const add = (dir: string | null | undefined, exeName: string | null = null) => {
    if (!dir) return;
    const p = resolve(dir);
    if (seen.has(p)) return;
    seen.add(p);
    tried.push({ gameDir: p, exeName });
  };

  if (override) add(override);
  add(readState(cwd).gameDir ?? null);
  add(hint ?? null);

  const libs = [
    join(os.homedir(), "Library/Application Support/Steam/steamapps/common"),
    "C:/Program Files (x86)/Steam/steamapps/common",
    "C:/Program Files/Steam/steamapps/common",
  ];
  for (const lib of libs) {
    if (!existsSync(lib)) continue;
    for (const name of readdirSync(lib)) {
      if (name.toLowerCase().includes("sultan")) add(join(lib, name));
    }
  }

  for (const candidate of tried) {
    const found = inspect(candidate.gameDir);
    if (found) return found;
  }
  return null;
}

// ── manifest and freshness ──────────────────────────────────────────────────

export interface Manifest {
  game?: { name?: string; steamAppId?: string | number; engine?: string; unityVersion?: string };
  build?: {
    label?: string;
    createdAt?: string;
    binary?: { path: string; bytes: number; sha256: string };
    metadata?: { path: string; bytes: number; sha256: string };
  };
  tools?: Record<string, { path: string; sha256: string; version: string }>;
  config?: { signature?: string; assemblies?: string[] };
  pruning?: { mode?: string; keptAssemblies?: string[]; removedAssemblies?: string[] };
  contents?: Record<string, unknown>;
}

export const manifestPath = (dir: string): string => join(dir, "MANIFEST.json");

export function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(dir), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export type FreshState = "missing" | "stale" | "fresh";

export interface Freshness {
  state: FreshState;
  dir: string;
  reasons: string[];
  manifest: Manifest | null;
}

/**
 * Compare the dump on disk with the game, the config, and the tools.
 * A missing dotnet is not a reason here: freshness answers "is what is on disk
 * still describing the installed game", not "can it be rebuilt right now".
 */
export function checkFreshness(cwd: string, cfg: DecompileConfig, game: GameFiles | null): Freshness {
  const dir = dumpDir(cwd);
  const manifest = readManifest(dir);
  if (!manifest) {
    return { state: "missing", dir, reasons: ["no MANIFEST.json in the dump folder"], manifest: null };
  }

  const reasons: string[] = [];
  if (!game) reasons.push("the installed game was not found, so the dump cannot be compared with it");
  const binarySha = game ? sha256File(game.binary) : "";
  const metadataSha = game ? sha256File(game.metadata) : "";
  if (game && manifest.build?.binary?.sha256 && manifest.build.binary.sha256 !== binarySha) {
    reasons.push(`the game binary changed (dump ${manifest.build.binary.sha256.slice(0, 8)}, installed ${binarySha.slice(0, 8)})`);
  }
  if (game && manifest.build?.metadata?.sha256 && manifest.build.metadata.sha256 !== metadataSha) {
    reasons.push("the game's metadata (types and fields) changed");
  }
  if (manifest.config?.signature && manifest.config.signature !== configSignature(cfg)) {
    reasons.push(`decompile.json changed (dump covers [${(manifest.pruning?.keptAssemblies ?? []).join(", ")}])`);
  }
  if (!manifest.config?.signature) {
    reasons.push("the dump does not record the decompile.json it was built from");
  }
  if (manifest.pruning?.mode !== "game-only") {
    reasons.push(`the dump was built with pruning mode "${String(manifest.pruning?.mode)}"`);
  }
  return { state: reasons.length ? "stale" : "fresh", dir, reasons, manifest };
}

// ── building the dump ───────────────────────────────────────────────────────

export interface BuildResult {
  dir: string;
  seconds: number;
  manifest: Manifest;
  removed: string[];
}

/** Run a tool and fail with its own last words, not just "Command failed". */
async function runTool(file: string, args: string[], timeoutMs = 900_000): Promise<string> {
  try {
    const out = await runAsync(file, args, { timeoutMs });
    return `${out.stdout}\n${out.stderr}`;
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message?: string };
    const detail = [e.stderr, e.stdout]
      .filter((s) => s && String(s).trim())
      .join("\n")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | ")
      .slice(0, 300);
    throw new Error(`${file.split("/").pop()} failed: ${detail || e.message || "no output"}`);
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);

async function gzipFile(src: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(`${src}.gz`));
  rmSync(src);
}

/**
 * Rebuild the dump into a temporary folder and swap it in. A failure leaves the
 * previous dump untouched: the agent may be reading it.
 */
export async function buildDump(
  cwd: string,
  cfg: DecompileConfig,
  game: GameFiles,
  extraAssemblies: string[] = [],
  onProgress: (message: string) => void = () => undefined,
): Promise<BuildResult> {
  const started = Date.now();
  onProgress("Checking the .NET SDK and the dump tools");
  const dotnet = (await import("./dotnet")).probeDotnet();
  if (!dotnet.found || (dotnet.major ?? 0) < 8) {
    throw new Error(
      dotnet.version
        ? `DOTNET_TOO_OLD: dotnet ${dotnet.version} cannot run the dump tools (need >= 8).\nNEXT: run install_runtime, then check_runtime.`
        : "DOTNET_MISSING: the dump tools need the .NET SDK.\nNEXT: run check_runtime, then install_runtime.",
    );
  }
  const cpp2il = await findCpp2il();
  const dumper = findIl2CppDumper(cwd);

  const keep = [...new Set([...cfg.dump.assemblies, ...extraAssemblies])];
  const budget = cfg.dump.budgetBytes ?? 0;
  const dir = dumpDir(cwd);
  const binarySha = sha256File(game.binary);
  const sameGameBuild = readManifest(dir)?.build?.binary?.sha256 === binarySha;
  const parent = join(dir, "..");
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.tmp-${repoName(cwd)}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "il2cppdumper"), { recursive: true });
  mkdirSync(join(tmp, "cpp2il"), { recursive: true });

  try {
    // 1. Signatures. A universal Mach-O makes Il2CppDumper ask which slice to
    //    read, and that prompt needs a console; thin it first instead. Write the
    //    slice outside the dump: it must not be swapped in with the artifacts.
    let binary = game.binary;
    if (game.universal) {
      if (process.platform !== "darwin") {
        throw new Error("UNIVERSAL_BINARY_UNSUPPORTED: this build has no way to pick a Mach-O slice outside macOS.");
      }
      const arch = process.arch === "arm64" ? "arm64" : "x86_64";
      binary = join(os.tmpdir(), `decompiled-slice-${process.pid}`);
      await runAsync("lipo", ["-thin", arch, game.binary, "-output", binary], { timeoutMs: 120_000 });
    }
    onProgress("Reading type signatures with Il2CppDumper");
    // exit code is not trustworthy: after writing its output Il2CppDumper waits
    // for a key press and dies without a console. The files are the proof.
    const dumperLog = await runAsync(dotnet.path as string, [dumper.path, binary, game.metadata, join(tmp, "il2cppdumper")], {
      timeoutMs: 300_000,
      env: { ...process.env, DOTNET_ROLL_FORWARD: "LatestMajor" },
    })
      .then((out) => `${out.stdout}\n${out.stderr}`)
      .catch((error: { stdout?: string; stderr?: string; message?: string }) =>
        `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${String(error?.message ?? "")}`,
      );
    const dumpCs = join(tmp, "il2cppdumper/dump.cs");
    if (!existsSync(dumpCs) || statSync(dumpCs).size < 1024) {
      throw new Error("IL2CPPDUMPER_FAILED: dump.cs was not produced. Check the tool version and the game build.");
    }

    onProgress("Signatures done. Reading method bodies with Cpp2IL");
    // 2. Method bodies. No separate rebuilt-assembly output: Il2CppDumper's
    //    DummyDll already serves ILSpy, and a second copy costs tens of MB.
    const cpp2ilArgs = ["--game-path", game.gamePath];
    if (game.exeName) cpp2ilArgs.push("--exe-name", game.exeName);
    const isilLog = await runTool(cpp2il.path, [
      ...cpp2ilArgs,
      "--output-as",
      "isil",
      "--output-to",
      join(tmp, "cpp2il"),
    ]);
    const unityVersion = (isilLog.match(/unity version to be (\S+)/i) ?? [])[1] ?? null;

    onProgress("Method bodies done. Pruning to the configured assemblies");
    // 3. Prune to the configured assemblies.
    const isilRoot = join(tmp, "cpp2il/IsilDump");
    const removed: string[] = [];
    if (existsSync(isilRoot)) {
      for (const entry of readdirSync(isilRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!keep.includes(entry.name)) {
          removed.push(entry.name);
          rmSync(join(isilRoot, entry.name), { recursive: true, force: true });
        }
      }
    }
    const kept = keep.filter((name) => existsSync(join(isilRoot, name)));
    const missing = keep.filter((name) => !kept.includes(name));
    if (removed.length) {
      mkdirSync(join(tmp, "_pruned"), { recursive: true });
      writeFileSync(join(tmp, "_pruned/assemblies.txt"), `${removed.join("\n")}\n`);
    }

    // 4. Discard what only binary analysis tools want.
    if (cfg.dump.dropIl2cppHeader !== false) rmSync(join(tmp, "il2cppdumper/il2cpp.h"), { force: true });
    if (cfg.dump.gzipScriptJson !== false && existsSync(join(tmp, "il2cppdumper/script.json"))) {
      await gzipFile(join(tmp, "il2cppdumper/script.json"));
    }

    // Keep what the tools said: when a later dump fails, this is the only record.
    mkdirSync(join(tmp, "logs"), { recursive: true });
    writeFileSync(join(tmp, "logs/il2cppdumper.log"), dumperLog);
    writeFileSync(join(tmp, "logs/cpp2il-isil.log"), isilLog);

    const bytes = dirBytes(tmp);
    if (budget > 0 && bytes > budget) {
      throw new Error(
        `DUMP_OVER_BUDGET: this dump is ${Math.round(bytes / 1048576)} MB and the config allows ${Math.round(budget / 1048576)} MB. The previous dump is untouched.\nNEXT: raise dump.budgetBytes, or narrow dump.assemblies.`,
      );
    }

    // 5. Record what produced this dump.
    const manifest: Manifest = {
      game: {
        name: (await import("./state")).readModRepoConfig(cwd).game?.name,
        engine: "Unity IL2CPP",
        unityVersion: unityVersion ?? undefined,
      },
      build: {
        // The label describes the game build, so it may only survive a rebuild
        // of the same build. A new game version gets today's date.
        label: sameGameBuild ? (readManifest(dir)?.build?.label ?? today()) : today(),
        createdAt: new Date().toISOString(),
        binary: { path: game.binary, bytes: statSync(game.binary).size, sha256: binarySha },
        metadata: { path: game.metadata, bytes: statSync(game.metadata).size, sha256: sha256File(game.metadata) },
      },
      tools: { il2cppdumper: dumper, cpp2il },
      config: { signature: configSignature(cfg), assemblies: keep },
      pruning: { mode: "game-only", keptAssemblies: kept, removedAssemblies: removed },
      contents: {
        "il2cppdumper/dump.cs": { bytes: statSync(dumpCs).size },
        "cpp2il/IsilDump": { typeFiles: existsSync(isilRoot) ? countFiles(isilRoot, ".txt") : 0 },
        totalBytes: bytes,
      },
    };
    writeFileSync(
      join(tmp, "README.md"),
      [
        "# Game code dump",
        "",
        "Written by inspect_game_code. Rebuild it with that tool, never by hand.",
        "",
        "| Path | What it is |",
        "|---|---|",
        "| `il2cppdumper/dump.cs` | Types, fields, and method signatures. No method bodies. |",
        "| `il2cppdumper/stringliteral.json` | String literals. |",
        "| `cpp2il/IsilDump/<Assembly>/<Type>.txt` | One file per type: ISIL pseudo-code and disassembly. |",
        "| `_pruned/assemblies.txt` | Assemblies removed from this dump. |",
        "| `MANIFEST.json` | What produced this dump, and when. |",
        "",
        "Read it through `inspect_game_code`: `search` (names, or `scope=bodies` for text inside ISIL), `type`, `body`, `strings`.",
        "`search` ignores case, and a hit names the file and line it came from.",
        "Use rg, sed, or grep only for what the tool cannot express: a regex with context lines, several patterns at once, or reading a line range. Names, one type, one member, strings, and a literal search across ISIL all belong to the tool.",
        "",
      ].join("\n"),
    );
    writeFileSync(manifestPath(tmp), `${JSON.stringify(manifest, null, 2)}\n`);

    onProgress("Dump complete. Swapping it in");
    // 6. Swap: the old dump only disappears after the new one is complete.
    const old = join(parent, `.old-${repoName(cwd)}-${process.pid}`);
    rmSync(old, { recursive: true, force: true });
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(tmp, dir);
    rmSync(old, { recursive: true, force: true });

    return { dir, seconds: (Date.now() - started) / 1000, manifest, removed: missing };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(join(os.tmpdir(), `decompiled-slice-${process.pid}`), { force: true });
  }
}

// ── reading the dump ────────────────────────────────────────────────────────

export function truncate(text: string, maxLines = 200, maxBytes = 48 * 1024): string {
  let out = text;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = `${lines.slice(0, maxLines).join("\n")}\n... (${lines.length - maxLines} more lines truncated)`;
  }
  if (Buffer.byteLength(out) > maxBytes) {
    // `slice` counts UTF-16 code units, so a byte check followed by a slice can still overshoot
    // and can cut a surrogate pair in half. Cut the way the limit is measured.
    out = clipUtf8(out, maxBytes);
  }
  return out;
}

/** Iterate lines without materialising a 26 MB file as an array of strings. */
export function forEachLine(text: string, fn: (line: string, lineNo: number) => boolean | void): void {
  let start = 0;
  let lineNo = 1;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    if (fn(text.slice(start, end), lineNo) === false) return;
    start = end + 1;
    lineNo += 1;
  }
}

const DECL = /^\s*(?:\[[^\]]*\]\s*)*(?:public|internal|private|protected|sealed|abstract|static|partial|readonly|\s)*\b(class|struct|interface|enum)\s+([^\s:{(]+)/;

export interface SearchHit {
  line: number;
  kind: "type" | "member";
  /** The type the line belongs to (equals `name` for a declaration). */
  owner: string;
  text: string;
}

/**
 * Search type names and member names. A member hit names its owning type, so the
 * next call can be `type <owner>` without a second guess.
 */
export function searchDump(dumpCs: string, query: string, limit = 50): SearchHit[] {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  let owner = "";
  forEachLine(dumpCs, (line, lineNo) => {
    if (line.includes("TypeDefIndex:")) {
      const m = line.match(DECL);
      if (m) {
        owner = m[2];
        if (m[2].toLowerCase().includes(needle) || line.toLowerCase().includes(needle)) {
          hits.push({ line: lineNo, kind: "type", owner, text: line.trim() });
        }
        return hits.length >= limit * 4 ? false : undefined;
      }
    }
    if (line.toLowerCase().includes(needle)) {
      hits.push({ line: lineNo, kind: "member", owner, text: line.trim() });
    }
    return hits.length >= limit * 4 ? false : undefined;
  });
  // A declaration is what the caller wants first: it names the type to read next.
  const types = hits.filter((h) => h.kind === "type");
  const members = hits.filter((h) => h.kind === "member");
  return [...types, ...members].slice(0, limit);
}

export interface BodyHit {
  /** Relative to the dump folder, so it reads next to `type` and `body` results. */
  file: string;
  line: number;
  text: string;
}

/**
 * Find text inside the ISIL method bodies, one file per type. This is the one
 * question `searchDump` cannot answer: it reads declarations only.
 */
export function searchBodies(
  dumpRoot: string,
  pattern: string,
  filter?: string,
  limit = 50,
): BodyHit[] {
  const root = join(dumpRoot, "cpp2il/IsilDump");
  if (!existsSync(root)) return [];
  const needle = pattern.toLowerCase();
  const hits: BodyHit[] = [];
  const walk = (dir: string): void => {
    if (hits.length >= limit) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= limit) return;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isFile() || !p.endsWith(".txt")) continue;
      const rel = relative(root, p).split(sep).join("/");
      if (filter && !rel.includes(filter)) continue;
      const text = readFileSync(p, "utf8");
      if (!text.toLowerCase().includes(needle)) continue;
      forEachLine(text, (line, lineNo) => {
        if (line.toLowerCase().includes(needle)) {
          hits.push({ file: `cpp2il/IsilDump/${rel}`, line: lineNo, text: line.trim().slice(0, 200) });
        }
        return hits.length >= limit ? false : undefined;
      });
    }
  };
  walk(root);
  return hits;
}

export interface TypeBlock {
  /** The name as dump.cs writes it: nested with dots, generic with `<T>`. */
  name: string;
  /** `Namespace.Name`, ready to show to a reader. */
  display: string;
  namespace: string;
  declaration: string;
  text: string;
  line: number;
}

/** `PropertyReader<T>` -> `PropertyReader`; anything else is left alone. */
export const withoutGenerics = (name: string): string => name.replace(/<[^<>]*>$/, "");

/** Cut one type out of dump.cs: header line through its closing brace at column 0. */
export function extractTypeBlock(dumpCs: string, typeName: string): TypeBlock | null {
  const wanted = withoutGenerics(typeName.trim()).toLowerCase();
  const shortName = (name: string): string => name.split(".").pop() ?? name;
  let declLine = 0;
  let startLine = 0;
  let endLine = 0;
  let namespace = "";
  let declaration = "";
  let name = "";
  // A declaration line is preceded by its namespace comment, at most a few
  // attribute lines earlier; a 40 line window covers it without a second scan.
  const header: { no: number; line: string }[] = [];

  forEachLine(dumpCs, (line, no) => {
    if (declLine) {
      if (line === "}") {
        endLine = no;
        return false;
      }
      return;
    }
    if (line.includes("TypeDefIndex:")) {
      const m = line.match(DECL);
      if (m) {
        const raw = withoutGenerics(m[2]);
        const ns = header.findLast((h) => h.line.startsWith("// Namespace:"));
        const space = ns ? ((ns.line.match(/^\/\/ Namespace:\s*(.*)$/) ?? [])[1] ?? "") : "";
        // Accept a short name, the name dump.cs writes, or a qualified name.
        const forms = [raw, shortName(raw)].flatMap((n) =>
          space ? [n.toLowerCase(), `${space}.${n}`.toLowerCase()] : [n.toLowerCase()],
        );
        if (forms.includes(wanted)) {
          declLine = no;
          declaration = `${m[1]} ${m[2]}`;
          startLine = ns ? ns.no : no;
          namespace = space;
          name = m[2];
          return;
        }
      }
    }
    header.push({ no, line });
    if (header.length > 40) header.shift();
  });
  if (!declLine || !endLine) return null;

  const parts: string[] = [];
  forEachLine(dumpCs, (line, no) => {
    if (no < startLine) return;
    if (no > endLine) return false;
    parts.push(line);
  });
  const plain = withoutGenerics(name);
  return {
    name,
    display: namespace ? `${namespace}.${plain}` : plain,
    namespace,
    declaration,
    text: parts.join("\n"),
    line: declLine,
  };
}

/**
 * The path of a type inside IsilDump. Cpp2IL flattens nesting with
 * `_NestedType_`, writes a generic as its arity (`PropertyReader`1`), and
 * turns the `<` and `>` of a compiler-generated name into `_`, which is what
 * makes `EventNode_JsonHandler.<>c` become `EventNode_JsonHandler_NestedType___c`.
 */
export function isilRelPath(namespace: string, fullTypeName: string): string {
  const segment = (part: string): string => {
    const generic = part.match(/^(.*)<([^<>]*)>$/);
    if (generic) return `${generic[1]}\`${generic[2].split(",").length}`;
    return part.replace(/[<>]/g, "_");
  };
  const parts = fullTypeName.split(".").map(segment);
  const file = parts.join("_NestedType_") + ".txt";
  const ns = namespace.trim();
  return ns ? join(ns.split(".").join("/"), file) : file;
}

/** Locate a type's ISIL file across assembly folders. */
export function resolveIsilFile(dir: string, namespace: string, fullTypeName: string): string | null {
  const root = join(dir, "cpp2il/IsilDump");
  if (!existsSync(root)) return null;
  const rel = isilRelPath(namespace, fullTypeName);
  const wanted = rel.split("/").pop() as string;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const direct = join(root, entry.name, rel);
    if (existsSync(direct)) return direct;
    // Namespace folders in the dump do not always match; fall back to the name.
    const found = findFile(join(root, entry.name), wanted);
    if (found) return found;
  }
  return null;
}

function findFile(dir: string, name: string, depth = 0): string | null {
  if (depth > 8) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const hit = findFile(p, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export interface MethodBlock {
  signature: string;
  text: string;
}

/** Split an ISIL file into method blocks, optionally only the ones that match. */
export function extractMethods(isilText: string, member?: string, limit = 20): MethodBlock[] {
  const blocks: MethodBlock[] = [];
  const lines = isilText.split("\n");
  let current: { sig: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) blocks.push({ signature: current.sig, text: current.lines.join("\n").trimEnd() });
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("Method: ")) {
      flush();
      current = { sig: line.slice("Method: ".length).trim(), lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  const filtered = member ? blocks.filter((b) => b.signature.toLowerCase().includes(member.toLowerCase())) : blocks;
  return filtered.slice(0, limit);
}

export interface StringHit {
  value: string;
  address: string;
}

export function searchStrings(file: string, query: string, limit = 50): StringHit[] {
  const all = JSON.parse(readFileSync(file, "utf8")) as { value: string; address: string }[];
  const needle = query.toLowerCase();
  const hits: StringHit[] = [];
  for (const item of all) {
    if (typeof item.value !== "string") continue;
    if (!item.value.toLowerCase().includes(needle)) continue;
    hits.push(item);
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Human-readable size of a folder, used by `status`. */
export const folderBytes = (dir: string): number => (existsSync(dir) ? dirBytes(dir) : 0);

/**
 * Ask a search for one hit more than you show. A list that ended and a list that
 * was cut then differ, and the answer can say which one it is.
 */
export function takeCapped<T>(hits: T[], limit: number): { hits: T[]; capped: boolean } {
  return { hits: hits.slice(0, limit), capped: hits.length > limit };
}

export type SearchTally =
  | { scope: "names" | "all"; target: string; matches: number; capped: boolean; limit: number }
  /** `files` is required: a body hit always has a file, and a missing count must not read as 0. */
  | { scope: "bodies"; target: string; matches: number; files: number; capped: boolean; limit: number }
  | { scope: "strings"; target: string; matches: number; capped: boolean; limit: number };

/** The first line of a result. A cap that is not stated reads as a complete list. */
export function searchHeader(t: SearchTally): string {
  if (t.scope === "strings") {
    const cut = t.capped ? ` - capped at ${t.limit} hits, so more may match` : "";
    return `# strings "${t.target}": ${t.matches} match(es)${cut}`;
  }
  // Only bodies knows its files; a name hit is always in dump.cs, and `all` mixes the two.
  // A caller that forgets the count gets no segment, never a false "in 0 file(s)".
  const where = t.scope === "bodies" && typeof t.files === "number" ? ` in ${t.files} file(s)` : "";
  const cut = t.capped
    ? t.scope === "bodies"
      ? ` - capped at ${t.limit} hits, so more files may match`
      : t.scope === "all"
        ? ` - capped at ${t.limit} hits per scope, so more may match`
        : ` - capped at ${t.limit} hits, so more may match`
    : "";
  return `# search "${t.target}" (${t.scope}): ${t.matches} match(es)${where}${cut}`;
}

