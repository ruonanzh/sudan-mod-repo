import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { probeDotnet } from "../lib/dotnet";
import { readState, writeState } from "../lib/state";

/**
 * check_runtime — check the .NET SDK (>= 8) and record the resolved path.
 *
 * This repository ships data only, so the SDK exists for one job: regenerating
 * the decompiled dump (`inspect_game_code`). The rule lives in `../lib/dotnet.ts`,
 * which `install_runtime` shares, so the check and the instructions cannot drift.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_runtime",
    label: "Check Runtime",
    description:
      "Checks that the .NET SDK (>= 8.0) is installed. It records the resolved dotnet path in .gamer-agent.local.json. It does not locate the game.",
    promptSnippet: "Check the .NET SDK when the decompiled dump must be rebuilt",
    promptGuidelines: [
      "Use check_runtime when a dump rebuild reports that dotnet is missing or too old, or when the player asks whether reading game code is possible.",
      "check_runtime only checks the SDK and records its path. It does not find the game and does not rebuild the dump.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const dotnet = probeDotnet();
      if (!dotnet.found || (dotnet.major ?? 0) < 8) {
        return {
          content: [
            {
              type: "text",
              text: dotnet.version
                ? `FAIL: dotnet SDK ${dotnet.version} is too old (need >= 8.0).\nNEXT: run install_runtime for install instructions.`
                : "FAIL: dotnet SDK not found.\nNEXT: run install_runtime for install instructions.",
            },
          ],
          details: { ...readState(cwd), ok: false },
        };
      }
      writeState(cwd, {
        runtime: { dotnet: dotnet.path, dotnetVersion: dotnet.version },
      });
      return {
        content: [
          {
            type: "text",
            text: `PASS: dotnet ${dotnet.version} (${dotnet.path}) - .NET SDK is ready.`,
          },
        ],
        details: { ...readState(cwd), ok: true },
      };
    },
  });
}
