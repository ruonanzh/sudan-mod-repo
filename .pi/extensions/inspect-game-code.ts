import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { probeDotnet } from "../lib/dotnet";
import { serialize } from "../lib/proc";
import { readModRepoConfig, writeState, expandHome, platformKey } from "../lib/state";
import { clipUtf8 } from "../lib/clip";
import {
  buildDump,
  checkFreshness,
  cpp2ilPath,
  dumpDir,
  extractMethods,
  extractTypeBlock,
  folderBytes,
  loadConfig,
  readManifest,
  resolveGame,
  resolveIsilFile,
  searchDump,
  searchStrings,
  setupCpp2il,
  sha256File,
  toolsDir,
  truncate,
} from "../lib/decompile";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MB = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "inspect_game_code",
    label: "Inspect Game Code",
    description:
      "Read the game's code from the local decompiled dump. Actions: status, search, type, body, strings, dump, setup. The dump is rebuilt automatically when the installed game binary, its metadata, or decompile.json changed; a different tool build alone does not trigger a rebuild. setup fetches the tool that produces method bodies. The tool writes inside the product data root, and records the game directory you pass in game in this workspace's state file; it never changes the game or the mod. Every result is capped at 50 KB of UTF-8 text: a long answer is cut and the cut is marked, so ask for a narrower target instead of a wider one.",
    promptSnippet: "Read game code from the local dump (types, bodies, strings), and dump more assemblies",
    promptGuidelines: [
      "Use inspect_game_code to read game code from the dump, and to dump more assemblies.",
      "inspect_game_code returns at most 50 KB of text per call, in UTF-8 bytes. When a result ends with a truncation marker, narrow the target, or ask for one type or one method, rather than rereading.",
      "inspect_game_code reads signature data with search and type. For IL2CPP games, body returns ISIL pseudo-code, not C#: it has no field or local names, and its field offsets are decimal (40 is 0x28). Do not treat ISIL as source.",
      "inspect_game_code rebuilds the dump by itself when the installed game binary, its metadata, or decompile.json changed, and says in the result when it ran and how long it took. Do not rebuild the dump some other way.",
      "inspect_game_code dump writes the assemblies in decompile.json. Pass assemblies= to add one for this dump; a wider set costs disk and time.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("status"),
          Type.Literal("search"),
          Type.Literal("type"),
          Type.Literal("body"),
          Type.Literal("strings"),
          Type.Literal("dump"),
          Type.Literal("setup"),
        ],
        {
          description:
            "status: is the dump current, and what does it cover. search: find type or member names. type: one type's fields, properties and method signatures. body: a method's ISIL and disassembly. strings: string literals. dump: rebuild the dump, adding assemblies. setup: download and verify Cpp2IL for this machine.",
        },
      ),
      target: Type.Optional(
        Type.String({
          description:
            "The type name (full or short), a name substring for search, or the text to look for with strings.",
        }),
      ),
      member: Type.Optional(
        Type.String({ description: "A method name substring, for action=body." }),
      ),
      assemblies: Type.Optional(
        Type.String({
          description:
            "Comma-separated assembly names to add to this dump, for action=dump (for example 'DOTween,UniverseLib').",
        }),
      ),
      game: Type.Optional(
        Type.String({
          description:
            "Path to the game install (or its .app). Recorded for later calls. Use it when the game is not in a standard Steam library.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({ description: "Rebuild even when the dump looks current (action=dump)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      // Illegal calls throw before the work starts. Inside the try below every error becomes a
      // FAIL line, which reads as a game answer ("no such type") rather than a caller mistake.
      const NEEDS_TARGET = new Set(["search", "type", "body", "strings"]);
      if (NEEDS_TARGET.has(params.action) && !params.target)
        throw new Error(`TARGET_MISSING: action=${params.action} needs target=<name>.`);
      let cfg;
      try {
        cfg = loadConfig(cwd);
      } catch (error) {
        // A decompile.json the tool cannot read is a broken workspace, not an answer about the
        // game: throw, so the result is a tool error and not a FAIL to work around.
        throw new Error(`CONFIG_INVALID: ${(error as Error).message}`);
      }

      if (params.game) writeState(cwd, { gameDir: expandHome(params.game) });
      const hint = readModRepoConfig(cwd).game?.installDirHint?.[platformKey()] ?? null;
      const game = resolveGame(cwd, hint, params.game ? expandHome(params.game) : undefined);

      const freshness = checkFreshness(cwd, cfg, game);

      // The order a rebuild fails in: runtime, its tools, the game, then the dump.
      // Only actions that need the dump consult it: a current dump is read without these probes.
      interface Rung {
        name: string;
        state: "ok" | "missing" | "unknown";
        detail: string;
        message?: string;
        next?: string;
      }
      let ladder: Rung[] | null = null;
      const rungs = (): Rung[] => {
        if (ladder) return ladder;
        const items: Rung[] = [];
        const add = (rung: Rung): void => {
          const blocked = items.some((r) => r.state === "missing");
          items.push(blocked ? { name: rung.name, state: "unknown", detail: "not checked until the step above is ready" } : rung);
        };
        const dotnet = probeDotnet();
        if (!dotnet.found || (dotnet.major ?? 0) < 8) {
          add(
            dotnet.found
              ? {
                  name: "dotnet",
                  state: "missing",
                  detail: `dotnet ${dotnet.version} (need >= 8)`,
                  message: `DOTNET_TOO_OLD: dotnet ${dotnet.version} cannot run the dump tools (need >= 8).`,
                  next: "NEXT: run install_runtime, then check_runtime.",
                }
              : {
                  name: "dotnet",
                  state: "missing",
                  detail: "not found",
                  message: "DOTNET_MISSING: the dump tools need the .NET SDK.",
                  next: "NEXT: run check_runtime, then install_runtime.",
                },
          );
        } else {
          add({ name: "dotnet", state: "ok", detail: `dotnet ${dotnet.version}` });
        }
        const cpp2il = cpp2ilPath();
        if (!cpp2il) {
          add({
            name: "cpp2il",
            state: "missing",
            detail: `no build for ${process.platform} ${process.arch}`,
            message: `CPP2IL_UNSUPPORTED_PLATFORM: no Cpp2IL build for ${process.platform} ${process.arch}.`,
          });
        } else if (!existsSync(cpp2il)) {
          add({
            name: "cpp2il",
            state: "missing",
            detail: "not installed",
            message: `CPP2IL_MISSING: expected ${cpp2il}. This is the tool that produces method bodies.`,
            next: "NEXT: run action=setup, which downloads and verifies it.",
          });
        } else {
          add({ name: "cpp2il", state: "ok", detail: cpp2il });
        }
        const dumper = join(cwd, "tools/il2cppdumper/Il2CppDumper.dll");
        if (!existsSync(dumper)) {
          add({
            name: "dumper",
            state: "missing",
            detail: `${dumper} is absent`,
            message: `IL2CPPDUMPER_MISSING: expected ${dumper}. This is the tool that produces signatures.`,
            next: "NEXT: restore tools/il2cppdumper/ (it is part of the repository).",
          });
        } else {
          add({ name: "dumper", state: "ok", detail: "tools/il2cppdumper (bundled)" });
        }
        if (!game) {
          add({
            name: "game",
            state: "missing",
            detail: "not found",
            message: "GAME_NOT_FOUND: the installed game was not found, so the dump cannot be rebuilt or compared.",
            next: "NEXT: pass game=<path to the install> with action=status to record it. On this machine the install is not in a Steam library this tool knows.",
          });
        } else {
          add({ name: "game", state: "ok", detail: game.gameDir });
        }
        ladder = items;
        return items;
      };
      const firstProblem = (): Rung | undefined => rungs().find((r) => r.state === "missing");
      const problemText = (r: Rung): string => [r.message, r.next].filter(Boolean).join("\n");

      // Rebuilding is serialised per dump: parallel calls in one turn must not
      // write the same folder twice.
      const rebuild = async (extra: string[]) => {
        const problem = firstProblem();
        if (problem) throw new Error(problemText(problem));
        if (!game) {
          throw new Error(
            "GAME_NOT_FOUND: the installed game was not found, so the dump cannot be rebuilt or compared.\nNEXT: pass game=<path to the install> with action=status to record it. On this machine the install is not in a Steam library this tool knows.",
          );
        }
        const started = Date.now();
        let stage = "Rebuilding the dump";
        const report = (text: string) => {
          stage = text;
          onUpdate?.({ content: [{ type: "text", text }], details: {} });
        };
        // A dump takes minutes. Without a heartbeat the caller sees one frozen call.
        const beat = setInterval(() => {
          report(`${stage} (${Math.round((Date.now() - started) / 1000)}s)`);
        }, 10_000);
        try {
          return await serialize(`dump:${dumpDir(cwd)}`, () => buildDump(cwd, cfg, game, extra, report));
        } finally {
          clearInterval(beat);
        }
      };

      const dir = dumpDir(cwd);
      // Every action funnels through this, so the 50 KB ceiling is applied once, on the finished
      // text. A long `target` is echoed into the result and must not decide the size by itself.
      const wrap = (text: string, details: Record<string, unknown> = {}) => ({
        content: [{ type: "text", text: clipUtf8(text) }],
        details: { ok: true, ...details },
      });
      /** A business result that did not pass is still a result, not an error. */
      const failed = (text: string, details: Record<string, unknown> = {}) => ({
        content: [{ type: "text", text: clipUtf8(text) }],
        details: { ok: false, ...details },
      });

      if (params.action === "setup") {
        const started = Date.now();
        let stage = "Fetching the dump tool";
        const report = (text: string) => {
          stage = text;
          onUpdate?.({ content: [{ type: "text", text }], details: {} });
        };
        const beat = setInterval(() => {
          report(`${stage} (${Math.round((Date.now() - started) / 1000)}s)`);
        }, 10_000);
        try {
          const done = await serialize(`setup:${cwd}`, () => setupCpp2il(cwd, report));
          return wrap(
            [
              `${
                done.status === "installed" ? `PASS: Cpp2IL installed in ${done.seconds.toFixed(1)}s.` : `SKIP: Cpp2IL is already installed and runs (${done.seconds.toFixed(1)}s).`
              }`,
              `  ${done.path}`,
              `  sha256 ${done.sha256.slice(0, 16)}${done.signed ? " (signed locally, so it differs from the published digest)" : ""}`,
              ...done.attempts.map((a) => `  source: ${a}`),
            ].join("\n"),
            { path: done.path },
          );
        } catch (error) {
          const message = (error as Error).message;
          // A download that fails with its own NEXT step is an answer; only a bare failure is an
          // environment error worth throwing.
          if (/NEXT:/.test(message)) {
            return { content: [{ type: "text", text: clipUtf8(`FAIL: ${message}${/NEXT:/.test(message) ? "" : "\nNEXT: run action=setup, then retry."}`) }], details: { ok: false, reason: "SETUP" } };
          }
          throw new Error(`SETUP_FAILED: ${message}`);
        } finally {
          clearInterval(beat);
        }
      }
      const refreshNote = async (): Promise<string> => {
        if (freshness.state === "fresh") return "";
        const built = await rebuild([]);
        return `# refreshed the dump in ${built.seconds.toFixed(1)}s (${freshness.reasons.join("; ")})\n`;
      };


      try {
        if (params.action === "status") {
          const manifest = readManifest(dir);
          const size = folderBytes(dir);
          const problem = firstProblem();
          const dumpRung: Rung =
            freshness.state === "fresh"
              ? {
                  name: "dump",
                  state: "ok",
                  detail: `current (${MB(size)}, ${String(
                    (manifest?.contents?.["cpp2il/IsilDump"] as { typeFiles?: number } | undefined)?.typeFiles ?? "?",
                  )} type files)`,
                }
              : freshness.state === "stale"
                ? { name: "dump", state: "missing", detail: `stale: ${freshness.reasons.join("; ")}` }
                : { name: "dump", state: "missing", detail: `absent (expected ${dir})` };
          const table = [...rungs(), dumpRung].map((r) => {
            const mark = r.state === "ok" ? "ok  " : r.state === "missing" ? "MISS" : "?   ";
            return `  ${r.name.padEnd(7)} ${mark} ${r.detail}`;
          });
          const coverage = (manifest?.pruning?.keptAssemblies ?? []).join(", ");
          const identity = manifest?.build?.binary?.sha256?.slice(0, 8) ?? "unknown";
          const meta = manifest?.build?.metadata?.sha256?.slice(0, 8) ?? "unknown";
          // The dump records the tools that produced it. A newer tool does not
          // invalidate the artifacts, but the next rebuild will differ.
          const drift: string[] = [];
          const cpp2il = cpp2ilPath();
          const dumper = join(toolsDir(), "il2cppdumper/Il2CppDumper.dll");
          if (
            cpp2il &&
            existsSync(cpp2il) &&
            manifest?.tools?.cpp2il?.sha256 &&
            manifest.tools.cpp2il.sha256 !== sha256File(cpp2il)
          ) {
            drift.push("Cpp2IL changed since this dump");
          }
          if (
            existsSync(dumper) &&
            manifest?.tools?.il2cppdumper?.sha256 &&
            manifest.tools.il2cppdumper.sha256 !== sha256File(dumper)
          ) {
            drift.push("Il2CppDumper changed since this dump");
          }
          const facts = manifest
            ? [
                `  build: ${manifest.build?.label ?? "unknown"}, game binary ${identity}, metadata ${meta}`,
                `  coverage: ${coverage || "(nothing)"}`,
              ]
            : [];
          const fresh = freshness.state === "fresh";
          const head = !fresh && problem
            ? `FAIL: the dump is stale or incomplete. Expected ${dir}.`
            : freshness.state === "missing"
              ? `FAIL: no dump for this repository yet. Expected ${dir}.`
              : !fresh
                ? "FAIL: the dump is stale."
                : problem
                  ? `FAIL: the dump is current, but a rebuild would stop at ${problem.name}.`
                  : `PASS: the dump is current. ${dir}`;
          const next = problem
            ? problemText(problem)
            : fresh
              ? ""
              : "NEXT: action=search/type/body rebuild it by themselves; action=dump rebuilds now.";
          const text = [head, ...table, ...facts, drift.length ? `  warnings: ${drift.join("; ")}` : "", next]
            .filter(Boolean)
            .join("\n");
          return fresh && !problem
            ? wrap(text, { dir, freshness: freshness.state })
            : failed(text, { dir, freshness: freshness.state, reason: problem?.name ?? "DUMP" });
        }

        if (params.action === "dump") {
          const extra = (params.assemblies ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (freshness.state === "fresh" && extra.length === 0 && !params.force) {
            return wrap(`SKIP: the dump is already current (${dir}). Pass force=true to rebuild it anyway.`);
          }
          const built = await rebuild(extra);
          const kept = built.manifest.pruning?.keptAssemblies ?? [];
          const missing = built.removed;
          return wrap(
            [
              `PASS: rebuilt the dump in ${built.seconds.toFixed(1)}s.`,
              `  ${dir} (${MB(folderBytes(dir))}, ${String(
                (built.manifest.contents?.["cpp2il/IsilDump"] as { typeFiles?: number } | undefined)?.typeFiles ?? "?",
              )} type files)`,
              `  coverage: ${kept.join(", ") || "(nothing)"}`,
              missing.length ? `  not found in this build: ${missing.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            { dir, seconds: built.seconds, coverage: kept },
          );
        }

        const note = await refreshNote();
        const dumper = join(dir, "il2cppdumper");

        if (params.action === "search") {
          const hits = searchDump(readFileSync(join(dumper, "dump.cs"), "utf8"), params.target, 50);
          const body = hits.length
            ? hits.map((h) => `${String(h.line).padStart(7)}  ${h.kind.padEnd(6)}  ${h.kind === "member" ? `${h.owner}: ` : ""}${h.text}`).join("\n")
            : `0 matches. Try a shorter substring, or a member name.`;
          return wrap(`${note}# search "${params.target}": ${hits.length} match(es) in ${dir}\n${truncate(body)}`, {
            matches: hits.length,
          });
        }

        if (params.action === "strings") {
          const file = join(dumper, "stringliteral.json");
          if (!existsSync(file)) {
            return {
              content: [{ type: "text", text: clipUtf8(`FAIL: this dump has no stringliteral.json (${file}).\nNEXT: action=dump rebuilds it; the string table is written on every rebuild.`) }],
              details: { ok: false, reason: "NO_STRINGS" },
            };
          }
          const hits = searchStrings(file, params.target, 50);
          const body = hits.map((h) => `${h.address}  ${JSON.stringify(h.value)}`).join("\n") || "0 matches.";
          return wrap(`${note}# strings "${params.target}": ${hits.length} match(es)\n${truncate(body)}`, {
            matches: hits.length,
          });
        }

        const block = extractTypeBlock(readFileSync(join(dumper, "dump.cs"), "utf8"), params.target);
        if (!block) {
          return {
            content: [
              {
                type: "text",
                text: clipUtf8(`FAIL: no type named "${params.target}" in this dump.\nNEXT: action=search target=<substring> to get the real name.`),
              },
            ],
            details: { ok: false, reason: "TYPE_NOT_FOUND" },
          };
        }
        const isil = resolveIsilFile(dir, block.namespace, block.name);

        if (params.action === "type") {
          const methods = isil ? extractMethods(readFileSync(isil, "utf8"), undefined, 1_000).length : 0;
          const where = isil ? `  ISIL: ${isil.slice(dir.length + 1)} (${methods} method(s))` : "  ISIL: none for this type";
          return wrap(
            `${note}# ${block.display} - ${block.declaration}, dump.cs line ${block.line}\n${where}\n\n${truncate(block.text)}`,
          );
        }

        // body
        if (!isil) {
          return {
            content: [
              {
                type: "text",
                text: clipUtf8(`FAIL: this type has no method bodies in the dump (no ISIL file).\nNEXT: action=type target=${params.target} shows its signature.`),
              },
            ],
            details: { ok: false, reason: "NO_BODY" },
          };
        }
        const methods = extractMethods(readFileSync(isil, "utf8"), params.member, 20);
        if (methods.length === 0) {
          const all = extractMethods(readFileSync(isil, "utf8"), undefined, 200).map((m) => `  ${m.signature}`);
          return {
            content: [
              {
                type: "text",
                text: clipUtf8(`FAIL: no method matches "${params.member ?? ""}" in ${params.target}.\nNEXT: action=type target=${params.target} lists the signatures; copy one.\n# methods in this type:\n${truncate(all.join("\n"), 80)}`),
              },
            ],
            details: { ok: false, reason: "METHOD_NOT_FOUND" },
          };
        }
        const text = methods.map((m) => m.text).join("\n\n");
        const member = params.member ? `.${params.member.replace(/^\./, "")}` : "";
        return wrap(
          `${note}# ${block.display}${member}: ${methods.length} method(s)\n` +
            `# ISIL: field offsets are decimal, disassembly offsets are hex\n\n${truncate(text)}`,
          { methods: methods.length },
        );
      } catch (error) {
        const message = (error as Error).message;
        // The rebuild and the runtime are prerequisites, not game answers. Their own messages
        // already carry a NEXT step; answer FAIL so the agent runs it. Anything else
        // (an unreadable file, a crash) is an environment failure: throw, with a code.
        if (/^(DOTNET_MISSING|DOTNET_TOO_OLD|CPP2IL_MISSING|CPP2IL_UNSUPPORTED_PLATFORM|IL2CPPDUMPER_MISSING|GAME_NOT_FOUND)\b/.test(message)) {
          // Not ready to answer, but a business answer all the same: the caller has to fix the
          // environment, and the message already names the step. FAIL, not throw and not PARTIAL.
          return {
            content: [{ type: "text", text: clipUtf8(`FAIL: ${message}${/NEXT:/.test(message) ? "" : "\nNEXT: run check_runtime and install_runtime, then retry."}`) }],
            details: { ok: false, reason: "NOT_READY", dir, sha: game ? sha256File(game.binary).slice(0, 8) : null },
          };
        }
        // A message that already carries a NEXT step is an answer the agent can act on; throwing it
        // would mark the result as a tool error while still telling the agent to run something.
        if (/NEXT:/.test(message)) {
          return {
            content: [{ type: "text", text: clipUtf8(`FAIL: ${message}${/NEXT:/.test(message) ? "" : "\nNEXT: run action=setup, then retry."}`) }],
            details: { ok: false, reason: "NOT_READY", dir, sha: game ? sha256File(game.binary).slice(0, 8) : null },
          };
        }
        throw new Error(/^[A-Z][A-Z0-9_]{2,}:/.test(message) ? message : `DUMP_READ_FAILED: ${message}`);
      }
    },
  });
}
