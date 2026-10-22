#!/usr/bin/env node
/**
 * setup.mjs — build the local reference set from the copy of the game the player owns.
 *
 * The vanilla art and the fonts cannot live in this repository: DoubleCross owns the art
 * and several of the fonts are commercial licences. They are also not needed to make a
 * mod, only to draw a preview that looks like the real card. So this script reads them
 * out of the installed game, on the machine that has the game.
 *
 *   node tools/setup.mjs                 find the game, extract, build the four plates
 *   node tools/setup.mjs --check         say what is present and what is missing
 *   node tools/setup.mjs --game <path>   the install, or its Data directory
 *   node tools/setup.mjs --python <py>   the interpreter that has UnityPy
 *   node tools/setup.mjs --index <url>   a pip index, for a network that needs one
 *   node tools/setup.mjs --paths <file>  read .gamer-agent.local.json from here instead
 *
 * The game is located by tools/paths.mjs, the same judgment every other tool uses: the install
 * is the folder that holds the game's own files (`Contents/Frameworks/GameAssembly.dylib` on
 * macOS), and the candidate libraries come from `config/libraryfolders.vdf` plus the app
 * manifest. This file keeps no candidate list of its own.
 *
 * Extraction needs UnityPy. Without it the script creates .setup-venv/ and installs it
 * there, which is a one-time download. PyPI direct measured 5m58s without a VPN against
 * 4s from the Tsinghua mirror, so the mirror is tried first and PyPI is the fallback.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { judge, shorten } from "./paths.mjs";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const REF = path.join(ROOT, "reference");
const VENV = path.join(ROOT, ".setup-venv");

/** The directory that holds resources.assets, given either the install or the Data dir. */
function dataDir(p) {
  const tries = [
    p,
    path.join(p, "Sultan's Game.app/Contents/Resources/Data"), // macOS bundle
    path.join(p, "Sultan's Game_Data"), // Windows
    path.join(p, "Data"),
  ];
  return tries.find((d) => existsSync(path.join(d, "resources.assets"))) || null;
}

/**
 * The Data directory of the install. tools/paths.mjs judges the game; this turns the judged
 * install into the one directory extract-art.py reads.
 */
function findGame(explicit, judgeOpts) {
  if (explicit) return dataDir(path.resolve(explicit));
  const game = judge(judgeOpts).rows.find((r) => r.name === "gameDir");
  return game.status === "OK" && game.path ? dataDir(game.path) : null;
}

/** What the preview needs, and what it can live without, plus the two judged locations. */
function status(judgeOpts = {}) {
  const need = ["card.png", "card-stone.png", "card-copper.png", "card-silver.png", "card-gold.png"]
    .map((f) => ({ file: `reference/plates/${f}`, ok: existsSync(path.join(REF, "plates", f)), required: true }));
  const fonts = existsSync(path.join(REF, "fonts"))
    ? readdirSync(path.join(REF, "fonts")).filter((f) => /\.(ttf|otf)$/i.test(f)).length
    : 0;
  const cards = existsSync(path.join(REF, "cards"))
    ? readdirSync(path.join(REF, "cards")).filter((f) => f.endsWith(".png")).length
    : 0;
  const judged = judge(judgeOpts);
  const location = (name, { game = false } = {}) => {
    const r = judged.rows.find((x) => x.name === name);
    return {
      file: `${name.padEnd(7)} ${r.path ? shorten(r.path) : "(not found)"}`,
      ok: r.status === "OK",
      required: true,
      location: true,
      game,
      detail: r.reason,
    };
  };
  return [
    ...need,
    { file: "reference/fonts/ (card title font)", ok: fonts > 0, required: false, detail: `${fonts} files` },
    { file: "reference/cards/ (style references)", ok: cards > 0, required: false, detail: `${cards} files` },
    location("gameDir", { game: true }),
    location("vanilla"),
  ];
}

function pythonHasUnityPy(py) {
  const r = spawnSync(py, ["-c", "import UnityPy"], { stdio: "ignore" });
  return r.status === 0;
}

function pythonWithUnityPy(explicit) {
  if (explicit) return pythonHasUnityPy(explicit) ? explicit : null;
  const venvPy = process.platform === "win32" ? path.join(VENV, "Scripts", "python.exe") : path.join(VENV, "bin", "python");
  if (existsSync(venvPy) && pythonHasUnityPy(venvPy)) return venvPy;
  for (const py of ["python3", "python"]) if (pythonHasUnityPy(py)) return py;
  return null;
}

/** Total steps, so a caller can turn the [n/N] markers into a bar. */
const STEPS = 5;

function run(cmd, args, label, step) {
  process.stdout.write(`[${step}/${STEPS}] ${label}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
  };
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node tools/setup.mjs [--check] [--game <install|Data>] [--python <py>] [--paths <file>]");
    return 0;
  }

  // One file decides where the game is, and a test can replace it. Everything below asks it.
  const paths = arg("--paths");
  const judgeOpts = paths ? { file: paths } : {};

  const rows = status(judgeOpts);
  if (process.argv.includes("--check")) {
    for (const r of rows) {
      console.log(`${r.ok ? "OK  " : r.required ? "MISS" : "    "} ${r.file}${r.detail ? ` (${r.detail})` : ""}`);
    }
    const missing = rows.filter((r) => r.required && !r.ok);
    // Only the game directory itself being missing means the game is elsewhere: the config and
    // the workshop are derived from it, so a missing one means "run the extractor", not "find the game".
    if (missing.some((r) => r.game)) {
      console.log(`\nThe game was not found. Pass it explicitly:\n  node tools/setup.mjs --game "<install folder>"`);
    } else if (missing.length) {
      console.log(`\n${missing.length} required file group(s) missing. Run: node tools/setup.mjs`);
    } else {
      console.log("\nAll required files present.");
    }
    return missing.length ? 1 : 0;
  }

  if (rows.every((r) => r.ok)) {
    console.log("Already set up. Nothing to do.");
    return 0;
  }

  const game = findGame(arg("--game"), judgeOpts);
  if (!game) {
    console.error("Cannot find the game. Pass it explicitly:\n  node tools/setup.mjs --game \"<install folder>\"");
    return 2;
  }
  console.log(`Game data: ${game}`);

  mkdirSync(path.join(REF, "plates"), { recursive: true });
  mkdirSync(path.join(REF, "fonts"), { recursive: true });
  mkdirSync(path.join(REF, "cards"), { recursive: true });

  let py = pythonWithUnityPy(arg("--python"));
  if (!py) {
    const base = arg("--python") || (process.platform === "win32" ? "python" : "python3");
    if (spawnSync(base, ["--version"], { stdio: "ignore" }).status !== 0) {
      const mirror = "https://mirrors.huaweicloud.com/python/";
      console.error(
        `Python 3 is required: the extraction step is tools/extract-art.py, which reads Unity asset bundles.\n` +
          `  ${base} was not found. Install Python 3.9 or newer, then run this again.\n\n` +
          `  The official installer is throttled to about 4 KB/s on this network; the Huawei\n` +
          `  mirror of the same files measured 8-12 MB/s. Pick the one for this machine:\n` +
          `    ${mirror}3.13.9/python-3.13.9-macos11.pkg     macOS\n` +
          `    ${mirror}3.13.9/python-3.13.9-amd64.exe      Windows (tick "Add python.exe to PATH")\n` +
          `  Any 3.9+ version works; browse ${mirror} for others.`
      );
      return 2;
    }
    console.log("UnityPy is not installed. Creating .setup-venv and installing it once (needs network).");
    run(base, ["-m", "venv", VENV], "create .setup-venv", 0);
    py = process.platform === "win32" ? path.join(VENV, "Scripts", "python.exe") : path.join(VENV, "bin", "python");

    // Direct PyPI is slow from mainland China; a mirror is not slower anywhere else and
    // falls back, so try mirrors first and finish with the default index.
    const mirrors = [
      arg("--index"),
      process.env.SUDAN_PIP_INDEX,
      "https://pypi.tuna.tsinghua.edu.cn/simple",
      "https://mirrors.aliyun.com/pypi/simple",
    ].filter(Boolean);
    const indexes = [...new Set(mirrors), null];

    let installed = false;
    for (const index of indexes) {
      const where = index || "pypi.org (default)";
      process.stdout.write(`  installing UnityPy from ${where}\n`);
      const args = ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "UnityPy"];
      if (index) args.push("--index-url", index);
      const started = Date.now();
      const pip = spawnSync(py, args, { stdio: "inherit", cwd: ROOT });
      if (pip.status === 0) {
        process.stdout.write(`[0/${STEPS}] UnityPy ready in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
        installed = true;
        break;
      }
      process.stdout.write("  that index did not work, trying the next\n");
    }
    if (!installed) {
      console.error("No index worked. Install UnityPy yourself and pass --python <interpreter>,\n  or point --index at a mirror you can reach.");
      return 2;
    }
  }

  // One --plates call covers both bundles: resources.assets and sharedassets0 return the
  // same 57 textures, `card` included, so a second pass would only rewrite them.
  run(py, [path.join(ROOT, "tools/extract-art.py"), "--game", game, "--out", path.join(REF, "plates"), "--plates"], "extract the base plates", 1);
  run(py, [path.join(ROOT, "tools/extract-art.py"), "--game", game, "--out", path.join(REF, "fonts"), "--assets", "sharedassets0.assets", "--fonts"], "extract the fonts", 2);
  run(py, [path.join(ROOT, "tools/extract-art.py"), "--game", game, "--out", path.join(REF, "cards"), "--by-tier"], "extract one reference card per tier", 3);

  const colours = { stone: "#8d806b", copper: "#94a56a", silver: "#b0becc", gold: "#e9d678" };
  run(process.execPath, [
    path.join(ROOT, "tools/plates.mjs"),
    "--from", path.join(REF, "plates", "card.png"),
    "--out", path.join(REF, "plates"),
    ...Object.entries(colours).flatMap(([tier, hex]) => [`--${tier}`, hex]),
  ], "build the four recoloured plates", 4);

  // Extraction writes every plate it can find, but nothing reads the extras: the page
  // needs card.png and the four recolours, and art.mjs needs the reference cards.
  const keep = new Set(["card.png", "card-stone.png", "card-copper.png", "card-silver.png", "card-gold.png"]);
  const plateDir = path.join(REF, "plates");
  let pruned = 0;
  for (const f of readdirSync(plateDir)) {
    if (!f.endsWith(".png") || keep.has(f)) continue;
    rmSync(path.join(plateDir, f));
    pruned++;
  }
  if (pruned) console.log(`[5/${STEPS}] kept the 5 plates the tools read, dropped ${pruned} research extras`);

  console.log("\nDone. node tools/setup.mjs --check reports the result.");
  return 0;
}

process.exit(main());
