import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { serialize } from "../lib/proc";
import { readModRepoConfig, readState, writeState, expandHome, platformKey } from "../lib/state";
import {
  asciiSafe,
  buildDump,
  checkFreshness,
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
  sha256File,
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
      "Read the game's code from the local decompiled dump. Actions: status, search, type, body, strings, dump. The dump is rebuilt automatically when the installed game, the config, or the tool version changed. The tool only writes inside the product data root; it never changes the game or the mod.",
    promptSnippet: "Read game code from the local dump (types, bodies, strings), and dump more assemblies",
    promptGuidelines: [
      "Use inspect_game_code to read game code from the dump, and to dump more assemblies.",
      "inspect_game_code reads signature data with search and type. For IL2CPP games, body returns ISIL pseudo-code, not C#: it has no field or local names, and its field offsets are decimal (40 is 0x28). Do not treat ISIL as source.",
      "inspect_game_code rebuilds the dump by itself when the installed game or the config changed, and says in the result when it ran and how long it took. Do not rebuild the dump some other way.",
      "inspect_game_code dump writes one assembly unless you ask for more. A glob dump is capped by the config's budgetBytes and needs all=true.",
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
        ],
        {
          description:
            "status: is the dump current, and what does it cover. search: find type or member names. type: one type's fields, properties and method signatures. body: a method's ISIL and disassembly. strings: string literals. dump: rebuild the dump, adding assemblies.",
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
      let cfg;
      try {
        cfg = loadConfig(cwd);
      } catch (error) {
        return {
          content: [{ type: "text", text: `FAIL: ${(error as Error).message}` }],
          details: { ok: false, reason: "CONFIG" },
        };
      }

      if (params.game) writeState(cwd, { gameDir: expandHome(params.game) });
      const hint = readModRepoConfig(cwd).game?.installDirHint?.[platformKey()] ?? null;
      const game = resolveGame(cwd, hint, params.game ? expandHome(params.game) : undefined);

      // Rebuilding is serialised per dump: parallel calls in one turn must not
      // write the same folder twice.
      const rebuild = async (extra: string[]) => {
        if (!game) {
          throw new Error(
            "GAME_NOT_FOUND: the installed game was not found, so the dump cannot be rebuilt or compared.\nNEXT: pass game=<path to the install> with action=status to record it. On this machine the install is not in a Steam library this tool knows.",
          );
        }
        const started = Date.now();
        let stage = "Rebuilding the dump";
        const report = (text: string) => {
          stage = text;
          onUpdate?.({ content: [{ type: "text", text: asciiSafe(text) }], details: {} });
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

      const freshness = checkFreshness(cwd, cfg, game);
      const refreshNote = async (): Promise<string> => {
        if (freshness.state === "fresh") return "";
        try {
          const built = await rebuild([]);
          return `# refreshed the dump in ${built.seconds.toFixed(1)}s (${freshness.reasons.join("; ")})\n`;
        } catch (error) {
          throw new Error(`DUMP_REBUILD_FAILED: ${(error as Error).message}`);
        }
      };

      const dir = dumpDir(cwd);
      const wrap = (text: string, details: Record<string, unknown> = {}) => ({
        content: [{ type: "text", text: asciiSafe(text) }],
        details: { ok: true, ...details },
      });

      try {
        if (params.action === "status") {
          const manifest = readManifest(dir);
          const size = folderBytes(dir);
          const coverage = (manifest?.pruning?.keptAssemblies ?? []).join(", ");
          const identity = manifest?.build?.binary?.sha256?.slice(0, 8) ?? "unknown";
          const meta = manifest?.build?.metadata?.sha256?.slice(0, 8) ?? "unknown";
          if (freshness.state === "missing") {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `FAIL: no dump for this repository. Expected ${dir}.\n` +
                    `NEXT: call action=dump. It needs the installed game and the .NET SDK (check_runtime says whether the SDK is there).`,
                },
              ],
              details: { ok: false, reason: "MISSING", dir },
            };
          }
          const head =
            freshness.state === "fresh"
              ? `PASS: the dump is current. ${dir} (${MB(size)}, ${String(
                  (manifest?.contents?.["cpp2il/IsilDump"] as { typeFiles?: number } | undefined)?.typeFiles ?? "?",
                )} type files)`
              : `PARTIAL: the dump is stale.\n  - ${freshness.reasons.join("\n  - ")}`;
          const lines = [
            head,
            `  build: ${manifest?.build?.label ?? "unknown"}, game binary ${identity}, metadata ${meta}`,
            `  coverage: ${coverage || "(nothing)"}`,
            freshness.warnings.length ? `  warnings: ${freshness.warnings.join("; ")}` : "",
            freshness.state === "fresh"
              ? ""
              : "NEXT: action=search/type/body rebuild it by themselves; action=dump rebuilds now.",
          ];
          return wrap(lines.filter(Boolean).join("\n"), { dir, freshness: freshness.state });
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

        if (!params.target) {
          return {
            content: [{ type: "text", text: `FAIL: action=${params.action} needs target=<name>.` }],
            details: { ok: false, reason: "TARGET_MISSING" },
          };
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
              content: [{ type: "text", text: `FAIL: this dump has no stringliteral.json (${file}).` }],
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
                text: `FAIL: no type named "${params.target}" in this dump.\nNEXT: action=search target=<substring> to get the real name.`,
              },
            ],
            details: { ok: false, reason: "TYPE_NOT_FOUND" },
          };
        }
        const isil = resolveIsilFile(dir, block.namespace, params.target);

        if (params.action === "type") {
          const methods = isil ? extractMethods(readFileSync(isil, "utf8"), undefined, 1_000).length : 0;
          const where = isil ? `  ISIL: ${isil.slice(dir.length + 1)} (${methods} method(s))` : "  ISIL: none for this type";
          return wrap(
            `${note}# ${block.declaration}${block.namespace ? ` (namespace ${block.namespace})` : ""}, dump.cs line ${block.line}\n${where}\n\n${truncate(block.text)}`,
          );
        }

        // body
        if (!isil) {
          return {
            content: [
              {
                type: "text",
                text: `FAIL: this type has no method bodies in the dump (no ISIL file).\nNEXT: action=type target=${params.target} shows its signature.`,
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
                text: `FAIL: no method matches "${params.member ?? ""}" in ${params.target}.\n# methods in this type:\n${truncate(all.join("\n"), 80)}`,
              },
            ],
            details: { ok: false, reason: "METHOD_NOT_FOUND" },
          };
        }
        const text = methods.map((m) => m.text).join("\n\n");
        return wrap(
          `${note}# ${params.target}${params.member ? `.${params.member}` : ""}: ${methods.length} method(s)\n` +
            `# ISIL: field offsets are decimal, disassembly offsets are hex\n\n${truncate(text)}`,
          { methods: methods.length },
        );
      } catch (error) {
        const message = (error as Error).message;
        return {
          content: [{ type: "text", text: `FAIL: ${message}` }],
          details: { ok: false, reason: "DUMP", dir, sha: game ? sha256File(game.binary).slice(0, 8) : null },
        };
      }
    },
  });
}
