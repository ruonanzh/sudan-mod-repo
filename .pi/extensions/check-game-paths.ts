/**
 * check_game_paths - verify the locations, and only verify.
 *
 * The judgment is `tools/paths.mjs`, so the CLI and this tool cannot disagree about what a
 * valid location is. This tool is read-only: it never writes `.gamer-agent.local.json`, never
 * scans for the game and never creates a directory. Recording is `set_game_dir` (one known
 * path) or `try_set_game_dir` (no path, discover).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { judge, pathsFile } from "../../tools/paths.mjs";
import { failedNames, formatRows, summarize, type PathRow } from "../lib/paths-report";

/** A relative path is relative to the workspace, which is where the tool runs. */
const absolute = (cwd: string, p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_game_paths",
    label: "Check Game Paths",
    description:
      "Check the four game locations and report one line per location with OK, MISS, EMPTY, FAIL or n/a and the sentinel that decided it. The locations are the Steam library, the vanilla config, the mod root and the Workshop content; the dump and the venv are reported as n/a. Pass steam, vanilla or modRoot to check those paths, or omit all three to check .gamer-agent.local.json. This tool is read-only: it never writes .gamer-agent.local.json and never creates a directory.",
    promptSnippet: "Check Steam, vanilla config and mod root paths without writing",
    promptGuidelines: [
      "Use check_game_paths when the player gives you a path, or before work that depends on the game being where the record says. It verifies the paths and reports the sentinel that decided each one.",
      "check_game_paths is read-only. It never records anything, never scans for the game and never creates a directory. Run set_game_dir or try_set_game_dir when a path must be recorded.",
      "When check_game_paths reports FAIL, read the NEXT line. A failing check changed nothing, so fix the named location before retrying the task that needed it.",
    ],
    parameters: Type.Object({
      steam: Type.Optional(
        Type.String({
          description: "Steam library or game install to check: the folder that holds steamapps/, or the install folder that holds Sultan's Game.app. Relative paths use the workspace root.",
        }),
      ),
      vanilla: Type.Optional(
        Type.String({
          description: "Vanilla config directory to check: the folder that holds cards.json and rite/. Relative paths use the workspace root.",
        }),
      ),
      modRoot: Type.Optional(
        Type.String({
          description: "Mod root to check: the folder that holds the mod folders and lies beside ModLog/. Relative paths use the workspace root.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const given = (v: string | undefined): string | undefined =>
        v && v.trim() ? absolute(cwd, v.trim()) : undefined;
      const { rows, ok, problem, present } = judge({
        steam: given(params.steam),
        vanilla: given(params.vanilla),
        modRoot: given(params.modRoot),
        file: pathsFile(cwd),
      });
      const judged = rows as PathRow[];

      const lines = formatRows(judged);
      if (problem) lines.push(`WARN: ${problem}`);
      // A missing file is a state, not a failure: discovery is the documented next step.
      if (!present) lines.push("NOTE: .gamer-agent.local.json does not exist yet; every location below came from discovery.");
      lines.push(summarize(ok, judged));
      if (!ok) {
        lines.push(
          "NEXT: run try_set_game_dir to find the game without arguments. If that fails, ask the player which folder holds the game (the Steam library, or the folder that holds Sultan's Game.app), then pass that path to set_game_dir. The 'setup-workspace' skill lists the sentinels.",
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ok, rows: judged, failed: failedNames(judged), wroteState: false, present },
      };
    },
  });
}
