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
import { ascii, clipUtf8 } from "../lib/clip";
import path from "node:path";
import { judge, pathsFile, readRecord, shorten } from "../../tools/paths.mjs";
import { absolute } from "../lib/workspace";
import { failedNames, formatRows, summarize, type PathRow } from "../lib/paths-report";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_game_paths",
    label: "Check Game Paths",
    description:
      "Check all four locations together: the game directory, the vanilla config derived from it, the Steam Workshop content directory, and the mod install directory derived from MyDocuments. This tool is read-only: it never writes .gamer-agent.local.json and never creates a directory. A path you pass overrides the recorded value for that location; the other locations are still judged. When no game directory is given or recorded, it locates the game the way try_set_game_dir does, so the report can still name one. Use it when the player gives you a path, or to re-check a remembered one; use try_set_game_dir when you want the found path recorded.",
    promptSnippet: "Check the game, vanilla, workshop and mod paths (read-only)",
    promptGuidelines: [
      "Use check_game_paths when the player gives you a path, or to check a remembered path. It writes no state: checking and recording are separate tools.",
      "check_game_paths judges all four locations and reports each row. A path you pass replaces the recorded value for that row only.",
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
      // A passed path replaces the recorded one, per key. A key left out is judged from the
      // record, and `judge` starts a discovery scan when no game directory is recorded — this tool
      // is read-only, but it is not scan-free.
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
              text: clipUtf8(ascii(`FAIL: nothing to check - no paths were given and none are recorded in this workspace's state file (${shorten(file)}).\nNEXT: run try_set_game_dir with no arguments to find the game, or pass gameDir explicitly. See the 'setup-workspace' skill if discovery fails.`)),
            },
          ],
          details: { ok: false, reason: "NOTHING_TO_CHECK", rows: [], failed: [], stale: [], wroteState: false, present: recorded.present },
        };
      }

      const { rows, ok, problem, stale } = judge({ ...targets, file });
      const judged = rows as PathRow[];

      const lines = formatRows(judged);
      if (problem) lines.push(`WARN: ${problem}`);
      // The record is a cache of what this machine derives. When the two disagree, one of them is
      // old, and the derived value is the measurement: the player moved the folder, or installed
      // the game in another library. Name both, and the tool that records the derived value.
      for (const entry of stale as Array<{ key: string; recorded: string; derived: string }>) {
        lines.push(
          `WARN: the state file records ${entry.key} ${shorten(entry.recorded)}, but this machine derives ${shorten(entry.derived)} - the record is out of date. Run try_set_game_dir (no arguments) to repair it.`,
        );
      }
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
            ? "NEXT: the game is fine; the mod root is missing. Ask the player to press the \"ModList\" button in the game's mod panel, which creates the folder, then check again. Nothing was written."
            : "NEXT: run try_set_game_dir (no arguments) to find the game and record it. If that fails, ask the player which folder holds the game (the install folder), then pass that path to set_game_dir. Nothing was written.",
        );
      }

      return {
        content: [{ type: "text", text: clipUtf8(ascii(lines.join("\n"))) }],
        details: { ok, rows: judged, failed: failedNames(judged), stale, wroteState: false, present: recorded.present },
      };
    },
  });
}
