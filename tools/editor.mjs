#!/usr/bin/env node
/**
 * editor.mjs — a local process that serves the story graph and writes edits back.
 *
 *   node tools/editor.mjs [--mod your_mods/<name>] [--port 7801] [--static out.html]
 *
 * Without `--mod` the page is read-only: it still shows the whole graph, and every write is
 * refused. A save must land in a mod, and a mod is a directory with an `info.json` inside it
 * — the rest of the repo takes `--mod <dir>` the same way (story, page, art).
 *
 * Why a process and not a file: `file://` cannot write. The page is the same one
 * graphpage.mjs renders, so there is a single implementation of the view.
 *
 * Save path: the text you typed is parsed as JSONC, the record is validated with the same
 * checks the rest of the repo uses, and only then is it written — into the mod, never into
 * the game's own files. A `.bak` copy of the previous file is kept beside it.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMod, locate, validateRecord, ModelError } from "./model.mjs";
import { parseJsonc } from "./lint.mjs";
import { buildGraph } from "./graph.mjs";
import { renderPage, payload, detailScript, writePage } from "./graphpage.mjs";
import { DEFAULT_VANILLA } from "./model.mjs";

const KIND_OF = { event: "event", rite: "rite", card: "card", loot: "loot", quest: "quest", afterStory: "afterStory", riteTemplate: "riteTemplate", over: "over" };

function parseArgs(argv) {
  const out = { modDir: null, vanilla: DEFAULT_VANILLA, port: 7801, static: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mod") out.modDir = argv[++i];
    else if (a === "--vanilla") out.vanilla = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--static") out.static = argv[++i];
  }
  return out;
}

const expand = (p) => String(p || "").replace(/^~/, os.homedir());

/**
 * Where this node's JSON lives: the mod's copy first, then the game's.
 * `locate()` returns paths relative to the assets root ("config/rite"), while vanilladir
 * already points at `.../config`, so the prefix is stripped exactly the way model.mjs does.
 */
function sourcePath(mod, kind, id, vanillaDir) {
  const where = locate(kind);
  const strip = (p) => String(p).replace(/^config\//, "");
  const isTable = where.style === "table" || where.style === "single";
  const modFile = mod ? path.join(mod.dir, isTable ? where.file : path.join(where.dir, `${id}.json`)) : null;
  if (modFile && existsSync(modFile)) return modFile;
  if (mod) return mod.vanillaPathFor(kind, id) || path.join(mod.vanillaDir, isTable ? strip(where.file) : path.join(strip(where.dir), `${id}.json`));
  // No mod: this is a read-only page, and the game's own file is what it shows.
  const base = expand(vanillaDir || DEFAULT_VANILLA);
  return isTable ? path.join(base, strip(where.file)) : path.join(base, strip(where.dir), `${id}.json`);
}

/** For a table-style file the record lives under a key; the page edits the whole record. */
export function readNodeSource(mod, kind, id, { vanilla } = {}) {
  const file = sourcePath(mod, kind, id, vanilla);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const doc = parseJsonc(text).value;
  const where = locate(kind);
  if (where.style === "table" || where.style === "single") {
    const rec = doc && doc[id];
    if (!rec) return null;
    // Re-serialise just this record, so the textarea shows the node and not the table.
    return { file, text: JSON.stringify(rec, null, 1), whole: true };
  }
  return { file, text, whole: false };
}

/**
 * Write an edited record. Table-style kinds are merged back into their table file; every
 * other kind is a file of its own.
 */
export function saveNode(mod, kind, id, source) {
  let parsed;
  try {
    parsed = parseJsonc(source);
  } catch (e) {
    return { ok: false, error: `解析失败：${String(e.message || e)}` };
  }
  // Duplicate keys are the game's own style (the vanilla files are full of them), so they
  // are a warning to show, not a reason to refuse the save.
  const warnings = (parsed.dups || []).length ? [`重复键 ${parsed.dups.length} 处（游戏允许，但只会读最后一个）`] : [];
  const record = parsed.value;
  if (!record || typeof record !== "object") return { ok: false, error: "内容不是一个对象" };
  try {
    validateRecord(kind, record); // throws a ModelError with a readable reason
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const where = locate(kind);
  const target = where.style === "table" || where.style === "single" ? path.join(mod.dir, where.file) : path.join(mod.dir, where.dir, `${id}.json`);
  // A save that changes nothing must not create a mod copy of a vanilla file. That copy is
  // an override the player would then ship, and it shows up in the graph as "mod 改的".
  // Values are compared, not text: a table record is re-serialised on its way to the
  // textarea, and the browser hands a CRLF file back with LF endings.
  const currentFile = sourcePath(mod, kind, id);
  if (existsSync(currentFile)) {
    const before = parseJsonc(readFileSync(currentFile, "utf8")).value;
    const isTable = where.style === "table" || where.style === "single";
    const same = JSON.stringify(isTable ? (before && before[id]) : before) === JSON.stringify(record);
    if (same) return { ok: true, unchanged: true, path: currentFile, backup: null, warnings };
  }
  const previous = existsSync(target) ? target : null;
  mkdirSync(path.dirname(target), { recursive: true });
  let backup = null;
  if (previous) {
    backup = `${target}.bak`;
    copyFileSync(previous, backup);
  }

  if (where.style === "table" || where.style === "single") {
    // Table files hold many records: load (or start) the table, replace the one key.
    const base = existsSync(target) ? parseJsonc(readFileSync(target, "utf8")).value : {};
    base[id] = record;
    writeFileSync(target, `${JSON.stringify(base, null, 1)}\n`);
  } else {
    writeFileSync(target, source.endsWith("\n") ? source : `${source}\n`);
  }
  return { ok: true, path: target, backup, warnings };
}

/**
 * A save goes into a mod, and a mod is `your_mods/<ModName>/` with an `info.json`. Every other
 * writer here takes `--mod <dir>` and refuses without it; `your_mods` is the parent of mods, not a
 * mod, and treating it as one writes files the game never loads. So this one refuses too, and the
 * page it serves without a mod is read-only.
 */
export function openModDir(dir, { vanilla } = {}) {
  if (!existsSync(dir)) throw new ModelError(`no such directory: ${dir}`);
  if (!existsSync(path.join(dir, "info.json")))
    throw new ModelError(`${dir} has no info.json, so it is not a mod. A mod is your_mods/<ModName>/ (see .pi/skills/mod-creator).`);
  return openMod(dir, { vanilla });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vanilla = expand(args.vanilla);
  if (!existsSync(vanilla)) {
    process.stderr.write(`no config at ${vanilla}\n`);
    return 2;
  }
  let mod = null;
  if (args.modDir) {
    try {
      mod = openModDir(expand(args.modDir), { vanilla });
    } catch (e) {
      if (e instanceof ModelError) {
        process.stdout.write(`FAIL  ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }
  const readOnlyHint = `read-only: no --mod. To edit, pass --mod your_mods/<ModName>`;

  if (args.static) {
    const g = buildGraph({ configDir: vanilla, modDir: mod ? mod.dir : null });
    // Both files: the page draws without the detail one, but its panels have no text then.
    const written = writePage(g, args.static, {
      editable: false,
      modNote: mod ? `mod ${path.relative(process.cwd(), mod.dir)}` : "只读（未指定 --mod）",
    });
    process.stdout.write(`PASS  wrote ${written.file} + ${written.detail} (${g.nodes.length} nodes, read-only)\n`);
    return 0;
  }

  let cache = null;
  const graph = () => {
    cache ??= buildGraph({ configDir: vanilla, modDir: mod ? mod.dir : null });
    return cache;
  };
  // The page pulls its panel text from this route on the first node it opens.
  const DETAIL_ROUTE = "/graph.detail.js";
  const page = () =>
    renderPage(graph(), {
      editable: Boolean(mod),
      modNote: mod ? `mod ${path.relative(process.cwd(), mod.dir)}` : "只读（未指定 --mod）",
      detailUrl: DETAIL_ROUTE,
    });

  const send = (res, code, type, body) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const json = (res, code, value) => send(res, code, "application/json; charset=utf-8", JSON.stringify(value));

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, "text/html; charset=utf-8", page());
      }
      if (req.method === "GET" && url.pathname === DETAIL_ROUTE) {
        return send(res, 200, "application/javascript; charset=utf-8", detailScript(graph()));
      }
      if (req.method === "GET" && url.pathname === "/api/index") {
        return json(res, 200, payload(graph()));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/node/")) {
        // Reading is not writing: a read-only page still shows the file a node lives in.
        const key = decodeURIComponent(url.pathname.slice("/api/node/".length));
        const [t, id] = key.split(":");
        const kind = KIND_OF[t];
        if (!kind) return json(res, 200, { ok: false, error: `未知类型 ${t}` });
        const got = readNodeSource(mod, kind, id, { vanilla });
        if (!got) return json(res, 200, { ok: false, error: `${key} 没有可编辑的源文件` });
        return json(res, 200, { ok: true, key, path: got.file, source: got.text, whole: got.whole });
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        if (!mod) return json(res, 200, { ok: false, error: readOnlyHint });
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { key, source } = JSON.parse(body || "{}");
            const [t, id] = String(key || "").split(":");
            const kind = KIND_OF[t];
            if (!kind) return json(res, 200, { ok: false, error: `未知类型 ${t}` });
            const out = saveNode(mod, kind, id, String(source || ""));
            cache = null; // the graph just changed
            return json(res, 200, out);
          } catch (e) {
            return json(res, 200, { ok: false, error: String(e.message || e) });
          }
        });
        return;
      }
      return json(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  });

  server.listen(args.port, "127.0.0.1", () => {
    const g = graph();
    process.stdout.write(`PASS  http://127.0.0.1:${args.port}/  (${g.nodes.length} nodes)\n`);
    process.stdout.write(`      ${mod ? `mod ${mod.dir}` : readOnlyHint}\n`);
    process.stdout.write(`      Ctrl+C 停止\n`);
  });
  return null; // keep the process alive: the server owns it now
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("editor.mjs")) {
  const code = main();
  if (code !== null) process.exit(code);
}
