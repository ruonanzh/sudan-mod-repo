#!/usr/bin/env node
/**
 * editor.mjs — a local process that serves the story graph and writes edits back.
 *
 *   node tools/editor.mjs --mod your_mods/<name> [--port 7801] [--static out.html]
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
import { openMod, locate, validateRecord } from "./model.mjs";
import { parseJsonc } from "./lint.mjs";
import { buildGraph } from "./graph.mjs";
import { renderPage, payload } from "./graphpage.mjs";
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
function sourcePath(mod, kind, id) {
  const where = locate(kind);
  const strip = (p) => String(p).replace(/^config\//, "");
  if (where.style === "table" || where.style === "single") {
    const inMod = path.join(mod.dir, where.file);
    return existsSync(inMod) ? inMod : mod.vanillaPathFor(kind, id);
  }
  if (where.style === "dir") {
    const inMod = path.join(mod.dir, where.dir, `${id}.json`);
    if (existsSync(inMod)) return inMod;
    return path.join(mod.vanillaDir, strip(where.dir), `${id}.json`);
  }
  throw new Error(`unsupported kind ${kind}`);
}

/** For a table-style file the record lives under a key; the page edits the whole record. */
export function readNodeSource(mod, kind, id) {
  const file = sourcePath(mod, kind, id);
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vanilla = expand(args.vanilla);
  const modDir = expand(args.modDir || "your_mods");
  if (!existsSync(vanilla)) {
    process.stderr.write(`no config at ${vanilla}\n`);
    return 2;
  }
  const mod = openMod(modDir, { vanilla });

  if (args.static) {
    const g = buildGraph({ configDir: vanilla, modDir: mod.dir });
    const html = renderPage(g);
    mkdirSync(path.dirname(path.resolve(args.static)), { recursive: true });
    writeFileSync(path.resolve(args.static), html);
    process.stdout.write(`PASS  wrote ${args.static} (${g.nodes.length} nodes, read-only)\n`);
    return 0;
  }

  let cache = null;
  const graph = () => {
    cache ??= buildGraph({ configDir: vanilla, modDir: mod.dir });
    return cache;
  };

  const send = (res, code, type, body) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const json = (res, code, value) => send(res, code, "application/json; charset=utf-8", JSON.stringify(value));

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, "text/html; charset=utf-8", renderPage(graph()));
      }
      if (req.method === "GET" && url.pathname === "/api/index") {
        return json(res, 200, payload(graph()));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/node/")) {
        const key = decodeURIComponent(url.pathname.slice("/api/node/".length));
        const [t, id] = key.split(":");
        const kind = KIND_OF[t];
        if (!kind) return json(res, 200, { ok: false, error: `未知类型 ${t}` });
        const got = readNodeSource(mod, kind, id);
        if (!got) return json(res, 200, { ok: false, error: `${key} 没有可编辑的源文件` });
        return json(res, 200, { ok: true, key, path: got.file, source: got.text, whole: got.whole });
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
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
    process.stdout.write(`PASS  http://127.0.0.1:${args.port}/  (${g.nodes.length} nodes, mod ${mod.dir})\n`);
    process.stdout.write(`      Ctrl+C 停止\n`);
  });
  return null; // keep the process alive: the server owns it now
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("editor.mjs")) {
  const code = main();
  if (code !== null) process.exit(code);
}
