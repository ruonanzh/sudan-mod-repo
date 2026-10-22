/**
 * try_set_game_dir - make sure the three locations are recorded (no arguments, idempotent).
 *
 * Discovery is `judge` with nothing explicit: the record file, then the game directory the
 * app recorded, then the Steam library. It writes only when every required location passes
 * its sentinel, and only when the record actually changed, so a second call touches nothing.
 *
 * When discovery fails it writes nothing and reports what is missing. Finding a game that is
 * not where it usually is becomes the agent's job only after this tool has failed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { judge, pathsFile, readRecord, recordOf, shorten, writeRecord } from "../../tools/paths.mjs";
import { readState } from "../lib/state";
import { failedNames, formatRows, summarize, type PathRow } from "../lib/paths-report";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "try_set_game_dir",
    label: "Ensure Game Directory",
    description:
      "Find the game and record the three locations in .pi/paths.json. It takes no arguments. When the recorded paths are already correct it writes nothing; when discovery succeeds it records all three; when discovery fails it writes nothing and reports the sentinel that is missing. Use it when a task needs the game location and you are not sure it is recorded.",
    promptSnippet: "Ensure the game locations are recorded, finding them when needed",
    promptGuidelines: [
      "Use try_set_game_dir when a task needs the game location: validating a mod, installing one, or reading the vanilla config. Use it when you are not sure the paths are recorded or still valid.",
      "try_set_game_dir takes no arguments and finds the game itself. Do not look for the path first. It says whether it found a new path or the record was already correct.",
      "try_set_game_dir only writes .pi/paths.json. It never creates or changes anything inside the game. When it reports FAIL, ask the player where the game is installed and pass that path to set_game_dir.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = pathsFile(cwd);
      const state = readState(cwd);
      const { rows, ok, problem } = judge({
        file,
        recorded: typeof state.gameDir === "string" ? state.gameDir : null,
      });
      const judged = rows as PathRow[];

      if (!ok) {
        const lines = formatRows(judged);
        if (problem) lines.push(`WARN: ${problem}`);
        lines.push(summarize(false, judged));
        lines.push(
          "NEXT: ask the player where the game is installed (the Steam library folder, not the game folder inside it), then pass that path to set_game_dir. See the 'setup-workspace' skill for the sentinels. Nothing was written.",
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            ok: false,
            reason: "PATHS_NOT_FOUND",
            rows: judged,
            failed: failedNames(judged),
            wroteState: false,
          },
        };
      }

      const body = recordOf(judged);
      const current = readRecord(file);
      const unchanged =
        current.steam === body.steam && current.vanilla === body.vanilla && current.modRoot === body.modRoot;
      const lines = formatRows(judged);
      if (problem) lines.push(`WARN: ${problem}`);
      if (unchanged) {
        lines.push("PASS: every required location is OK (already recorded; nothing written)");
      } else {
        writeRecord(judged, file);
        lines.push(`PASS: every required location is OK (discovered and recorded in ${shorten(file)})`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          ok: true,
          status: unchanged ? "already" : "recorded",
          rows: judged,
          recorded: body,
          wroteState: !unchanged,
        },
      };
    },
  });
}
