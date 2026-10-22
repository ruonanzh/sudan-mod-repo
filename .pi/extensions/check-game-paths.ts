/**
 * check_game_paths — **只验**：校验游戏目录 / 创意工坊目录 / mod 安装目录（只读、幂等、不扫描、不写状态）。
 *
 * 与其它工具的分工（别混用）：
 *   · check_game_paths   只验给定或已记录的路径            ← 本工具（无副作用）
 *   · set_game_dir       已有一个路径，要记下来
 *   · try_set_game_dir   没有路径，自己找（无参）
 *
 * 典型用途：玩家说"我的游戏装在 D:\Games" → 带上 gameDir 验一下就知道对不对，
 * 不需要重跑扫描（重且会覆盖缓存）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { homedir } from "node:os";
import { judge, pathsFile, readRecord, shorten } from "../../tools/paths.mjs";
import { failedNames, formatRows, summarize, type PathRow } from "../lib/paths-report";

/** A relative path is relative to the workspace, which is where the tool runs. */
const absolute = (cwd: string, p: string): string => {
  // A path copied out of our own report starts with `~`; resolving that against the workspace
  // would invent `<workspace>/~/...`, so expand it first.
  const expanded = p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_game_paths",
    label: "Check Game Paths",
    description:
      "Check three directories: the game directory, the Steam Workshop content directory, and the mod install directory. It also reports the vanilla config derived from the game directory. This tool is read-only. It never writes .gamer-agent.local.json, never scans for the game, and never creates a directory. Pass any of gameDir, workshopDir, or modInstallDir to check those paths. Omit all three to check the paths in .gamer-agent.local.json. Use it when the player gives you a path, or to re-check a remembered path. Use try_set_game_dir when the location is unknown.",
    promptSnippet: "Check game and mod paths without scanning or writing",
    promptGuidelines: [
      "Use check_game_paths when the player gives you a path, or to check a remembered path. It verifies a path without scanning and without writing state.",
      "check_game_paths never writes .gamer-agent.local.json. Checking and recording are separate tools.",
      "A failed check_game_paths changes nothing. Follow its NEXT line to fix the problem. It never creates or installs anything.",
    ],
    parameters: Type.Object({
      gameDir: Type.Optional(
        Type.String({
          description:
            "Game directory to check: the install, the folder that holds Sultan's Game.app (macOS) or Sultan's Game_Data (Windows). Relative paths use the workspace root.",
        }),
      ),
      workshopDir: Type.Optional(Type.String({ description: "Steam Workshop content directory to check (optional)." })),
      modInstallDir: Type.Optional(Type.String({ description: "Mod install directory to check (optional)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = pathsFile(cwd);
      const recorded = readRecord(file);
      // Check only what was passed, or everything recorded when nothing was passed. Never fall
      // back per-key: a stale recorded path would decide the verdict for a location the caller
      // did not ask about, and judging a missing gameDir would start a discovery scan.
      const anyGiven = Boolean(params.gameDir?.trim() || params.workshopDir?.trim() || params.modInstallDir?.trim());
      const use = (given: string | undefined, saved: string | null): string | undefined => {
        if (anyGiven) return given?.trim() ? absolute(cwd, given.trim()) : undefined;
        return saved ? absolute(cwd, saved) : undefined;
      };

      const targets = {
        gameDir: use(params.gameDir, recorded.gameDir),
        workshopDir: use(params.workshopDir, recorded.workshopDir),
        modInstallDir: use(params.modInstallDir, recorded.modInstallDir),
      };
      if (!targets.gameDir && !targets.workshopDir && !targets.modInstallDir) {
        return {
          content: [
            {
              type: "text",
              text: `FAIL: nothing to check - no paths were given and none are recorded in this workspace's state file (${shorten(file)}).\nNEXT: run try_set_game_dir with no arguments to find the game, or pass gameDir explicitly. See the 'setup-workspace' skill if discovery fails.`,
            },
          ],
          details: { ok: false, reason: "NOTHING_TO_CHECK", rows: [], failed: [], wroteState: false, present: recorded.present },
        };
      }

      const { rows, ok, problem } = judge({ ...targets, file });
      const judged = rows as PathRow[];

      const lines = formatRows(judged);
      if (problem) lines.push(`WARN: ${problem}`);
      if (!recorded.present) {
        lines.push(
          `NOTE: ${shorten(file)} does not exist yet; the locations below came from the arguments you passed and what they derive.`,
        );
      }
      lines.push(summarize(ok, judged));
      if (!ok) {
        const failed = failedNames(judged);
        const onlyModRoot = failed.length === 1 && failed[0] === "modInstallDir";
        lines.push(
          onlyModRoot
            ? "NEXT: the game is fine; the mod root is missing. Start the game once so it creates DoubleCross/SultansGame/Mod, then check again. Nothing was written."
            : "NEXT: run try_set_game_dir (no arguments) to find the game and record it. If that fails, ask the player which folder holds the game (the install folder), then pass that path to set_game_dir. Nothing was written.",
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ok, rows: judged, failed: failedNames(judged), wroteState: false, present: recorded.present },
      };
    },
  });
}
