/**
 * try_set_game_dir —— **确保游戏目录已就绪**（无参、幂等）。
 *
 * 语义（判据与发现都在 `tools/paths.mjs`，本工具只是入口）：
 *   ① 记录的 `gameDir` 仍有效，且派生的 `modInstallDir` / `workshopDir` 与**当前平台**一致
 *      → 什么都不写 → `PASS: gameDir already correct`
 *   ② 无效 / 过期 / 从没记过 → 自动发现（每个候选都过哨兵）→ 记录 `gameDir` + 派生的两条
 *      → `PASS: gameDir discovered and recorded`
 *   ③ 找不到 → `FAIL`（不写状态）
 *
 * 为什么无参：agent 不需要先知道路径 —— "确保它已就绪"这件事由工具自己做；它自己找过之后仍然失败，
 * 才轮到 agent 去想办法（找线索、问玩家）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureGameDir, pathsFile, shorten } from "../../tools/paths.mjs";
import { derivedLines } from "../lib/paths-report";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "try_set_game_dir",
    label: "Ensure Game Directory",
    description:
      "Makes sure the game directory is recorded and still valid for this platform. It also checks the Steam Workshop directory derived from it, and the mod install directory derived from MyDocuments. This tool takes no arguments. It checks the recorded paths, or locates the game and records the paths.",
    promptSnippet: "Ensure the game directory is recorded (locates it when needed)",
    promptGuidelines: [
      "Use try_set_game_dir when a task needs the game location, such as reading the vanilla config or installing a mod. Use it when you are not sure the paths are recorded or still valid.",
      "try_set_game_dir takes no arguments. It checks the recorded paths or locates and records them. You do not have to find the path yourself.",
      "try_set_game_dir only records paths in .gamer-agent.local.json. It never creates or changes anything inside the game.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const file = pathsFile(cwd);
      const out = ensureGameDir({ file });

      if (out.status === "missing") {
        return {
          content: [
            {
              type: "text",
              text: `FAIL: gameDir not found - ${out.reason}.\nNEXT: ${out.next ?? "see the 'setup-workspace' skill."}`,
            },
          ],
          details: {
            ok: false,
            reason: "GAME_DIRECTORY_NOT_FOUND",
            wroteState: false,
          },
        };
      }

      const lines = [
        `PASS: gameDir ${out.status === "already" ? "already correct" : "discovered and recorded"} (${shorten(out.recorded)})`,
        ...derivedLines(out),
      ];
      for (const warning of out.warnings) lines.push(`WARN: ${warning}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          ok: true,
          gameDir: out.recorded,
          vanillaDir: out.vanillaDir,
          modInstallDir: out.modInstallDir,
          workshopDir: out.workshopDir,
          wroteState: out.status === "recorded",
        },
      };
    },
  });
}
