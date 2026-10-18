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
 *
 * Extraction needs UnityPy. Without it the script creates .setup-venv/ and installs it
 * there, which is a one-time download. PyPI direct measured 5m58s without a VPN against
 * 4s from the Tsinghua mirror, so the mirror is tried first and PyPI is the fallback.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const REF = path.join(ROOT, "reference");
const VENV = path.join(ROOT, ".setup-venv");

/** Where the install usually is. Steam is not the only place, so the list is a guess. */
function candidates() {
  const home = os.homedir();
  const out = [];
  if (process.platform === "darwin") {
    out.push(path.join(home, "Library/Application Support/Steam/steamapps/common/Sultan's Game"));
  } else if (process.platform === "win32") {
    for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, "C:\\Program Files (x86)", "C:\\Program Files"]) {
      if (base) out.push(path.join(base, "Steam", "steamapps", "common", "Sultan's Game"));
    }
    for (const drive of ["C:", "D:", "E:", "F:"]) out.push(path.join(`${drive}\\`, "SteamLibrary", "steamapps", "common", "Sultan's Game"));
    // Another drive only shows up in libraryfolders.vdf, so read the paths out of it.
    for (const steam of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean)) {
      const vdf = path.join(steam, "Steam", "steamapps", "libraryfolders.vdf");
      if (!existsSync(vdf)) continue;
      for (const m of readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) {
        out.push(path.join(m[1].replace(/\\\\/g, "\\"), "steamapps", "common", "Sultan's Game"));
      }
    }
  }
  return out;
}

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

function findGame(explicit) {
  if (explicit) return dataDir(path.resolve(explicit));
  for (const c of candidates()) {
    const d = dataDir(c);
    if (d) return d;
  }
  return null;
}

/** What the preview needs, and what it can live without. */
function status() {
  const need = ["card.png", "card-stone.png", "card-copper.png", "card-silver.png", "card-gold.png"]
    .map((f) => ({ file: `reference/plates/${f}`, ok: existsSync(path.join(REF, "plates", f)), required: true }));
  const fonts = existsSync(path.join(REF, "fonts"))
    ? readdirSync(path.join(REF, "fonts")).filter((f) => /\.(ttf|otf)$/i.test(f)).length
    : 0;
  const cards = existsSync(path.join(REF, "cards"))
    ? readdirSync(path.join(REF, "cards")).filter((f) => f.endsWith(".png")).length
    : 0;
  return [
    ...need,
    { file: "reference/fonts/ (card title font)", ok: fonts > 0, required: false, detail: `${fonts} files` },
    { file: "reference/cards/ (style references)", ok: cards > 0, required: false, detail: `${cards} files` },
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

function run(cmd, args, label) {
  process.stdout.write(`  ${label}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
  };
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node tools/setup.mjs [--check] [--game <install|Data>] [--python <py>]");
    return 0;
  }

  const rows = status();
  if (process.argv.includes("--check")) {
    for (const r of rows) {
      console.log(`${r.ok ? "OK  " : r.required ? "MISS" : "    "} ${r.file}${r.detail ? ` (${r.detail})` : ""}`);
    }
    const missing = rows.filter((r) => r.required && !r.ok);
    console.log(missing.length ? `\n${missing.length} required file group(s) missing. Run: node tools/setup.mjs` : "\nAll required files present.");
    return missing.length ? 1 : 0;
  }

  if (rows.every((r) => r.ok)) {
    console.log("Already set up. Nothing to do.");
    return 0;
  }

  const game = findGame(arg("--game"));
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
    run(base, ["-m", "venv", VENV], "create .setup-venv");
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
        process.stdout.write(`  ok in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
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

  // sharedassets0 holds the plates and the fonts; resources.assets holds the card art.
  run(py, [path.join(ROOT, "tools/extract-art.py"), "--game", game, "--out", path.join(REF, "plates"), "--plates"], "extract the four base plates");
  run(py, [path.join(ROOT, "tools/extract-art.py"), "--game", game, "--out", path.join(REF, "plates"), "--assets", "sharedassets0.assets", "--plates"], "extract the shared plates");
  run(py, [path.join(ROOT, "tools/extract-art.py"), "--game", game, "--out", path.join(REF, "fonts"), "--assets", "sharedassets0.assets", "--fonts"], "extract the fonts");
  run(py, [path.join(ROOT, "tools/extract-art.py"), "--game", game, "--out", path.join(REF, "cards"), "--by-tier"], "extract one reference card per tier");

  const colours = { stone: "#8d806b", copper: "#94a56a", silver: "#b0becc", gold: "#e9d678" };
  run(process.execPath, [
    path.join(ROOT, "tools/plates.mjs"),
    "--from", path.join(REF, "plates", "card.png"),
    "--out", path.join(REF, "plates"),
    ...Object.entries(colours).flatMap(([tier, hex]) => [`--${tier}`, hex]),
  ], "build the four recoloured plates");

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
  if (pruned) console.log(`  kept the 5 plates the tools read, dropped ${pruned} research extras`);

  console.log("\nDone. node tools/setup.mjs --check reports the result.");
  return 0;
}

process.exit(main());
