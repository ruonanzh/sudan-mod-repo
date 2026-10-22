/**
 * set_game_dir - record one path, after deciding which of the three locations it is.
 *
 * A player names a folder; the folder may be the game install, the vanilla config or the
 * mod root. `classify` in `tools/paths.mjs` holds that judgment, so this tool and the CLI
 * agree about which sentinel a path passes and which key it is filed under.
 *
 * A path that passes no sentinel is a bad argument, so it throws: nothing was checked and
 * nothing was recorded, and a FAIL would suggest the check ran.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { classify, judge, pathsFile, shorten, writeRecord } from "../../tools/paths.mjs";
import { failedNames, formatRows, summarize, type PathRow } from "../lib/paths-report";

/** A relative path is relative to the workspace, which is where the tool runs. */
const absolute = (cwd: string, p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

/** `classify` names a state-file key; `judge` takes the report row that key feeds. */
const ROW_OF = { gameDir: "steam", vanillaDir: "vanilla", modInstallDir: "modRoot" } as const;

/** The three sentinels, so a refusal names what was looked for rather than just "invalid". */
const SENTINELS = [
  "  gameDir: no appmanifest_3117820.acf in steamapps/, and no Steam library above the path has one",
  "  vanillaDir: no cards.json and rite/ in the directory",
  "  modInstallDir: no ModLog/__mod.log beside it, and its parent is not SultansGame/",
].join("\n");

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "set_game_dir",
    label: "Set Game Directory",
    description:
      "Record one path in .gamer-agent.local.json. The tool decides which of the three locations the path is by its sentinel: the game install (or its Steam library), the vanilla config, or the mod root. It then records every location it can derive. A path that matches no sentinel is rejected and nothing is written. Use try_set_game_dir when you have no path, and check_game_paths to verify without recording.",
    promptSnippet: "Record one game location by its sentinel, deriving the others",
    promptGuidelines: [
      "Use set_game_dir when you have one path to record: the player named it, or you found it. It decides which location the path is and records every location it can derive.",
      "set_game_dir rejects a path that passes no sentinel. If it does, ask the player for the Steam library (the folder that holds steamapps/) instead of retrying the same path.",
      "set_game_dir writes .gamer-agent.local.json. Use check_game_paths when you only need to verify a path, and try_set_game_dir when the location is unknown.",
    ],
    parameters: Type.Object({
      path: Type.String({
        minLength: 1,
        description:
          "Path to record: the game install (or its Steam library), a vanilla config directory, or a mod root. Relative paths use the workspace root.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const raw = params.path?.trim();
      if (!raw) {
        throw new Error("INVALID_PATH: pass path=<game install, Steam library, vanilla config directory, or mod root>.");
      }
      const target = absolute(cwd, raw);
      const hit = classify(target) as { key: keyof typeof ROW_OF | null; reason: string };
      if (!hit.key) {
        const why =
          hit.reason === "no such directory"
            ? `${shorten(target)} does not exist`
            : `${shorten(target)} matches none of the three sentinels`;
        throw new Error(
          `INVALID_GAME_PATH: ${why}.\n${SENTINELS}\n` +
            "NEXT: pass the game install (the folder that holds Sultan's Game.app, or the Steam library that holds steamapps/), the vanilla config directory (.../StreamingAssets/config), or the mod root (.../DoubleCross/SultansGame/Mod).",
        );
      }

      const file = pathsFile(cwd);
      const wanted = judge({ ...{ [ROW_OF[hit.key]]: target }, file });
      const rows = wanted.rows as PathRow[];

      if (!wanted.ok) {
        const lines = formatRows(rows);
        if (wanted.problem) lines.push(`WARN: ${wanted.problem}`);
        lines.push(summarize(false, rows));
        lines.push(
          `NEXT: ${shorten(target)} is a valid ${hit.key}, but another required location is not. Run check_game_paths to see which sentinel is missing, then pass that location to set_game_dir. Nothing was written.`,
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { ok: false, status: "FAIL", rows, failed: failedNames(rows), wroteState: false },
        };
      }

      const recorded = writeRecord(rows, file);
      const lines = [
        `PASS: recorded ${shorten(file)} (path classified as ${hit.key})`,
        ...formatRows(rows).filter((line) => /^(steam|vanilla|modRoot)\s/.test(line)),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ok: true, status: "recorded", rows, recorded, wroteState: true },
      };
    },
  });
}
