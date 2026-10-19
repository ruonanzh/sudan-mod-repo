import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { probeDotnet } from "../lib/dotnet";

/**
 * install_runtime — installation instructions for the .NET SDK (>= 8).
 *
 * A user-level install under `~/.dotnet` (or `%USERPROFILE%\.dotnet`) needs no
 * admin rights, so it is the first suggestion. This tool only probes and prints;
 * it never downloads or installs. `details.ok` means "the SDK is ready", which is
 * the same meaning it has in `check_runtime`.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "install_runtime",
    label: "Install Runtime",
    description:
      "Returns instructions for installing .NET SDK >= 8 on this platform, or reports that it is already present. This tool only probes. It does not run an installer, does not download software, and does not locate the game.",
    promptSnippet: "Get SDK installation instructions when an SDK prerequisite is missing",
    promptGuidelines: ["Use install_runtime when check_runtime reports a missing dotnet SDK."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const dotnet = probeDotnet();
      if (dotnet.found && (dotnet.major ?? 0) >= 8) {
        return {
          content: [
            {
              type: "text",
              text: `SKIP: dotnet SDK ${dotnet.version} already present. The tool performed no installation.`,
            },
          ],
          details: { ok: true },
        };
      }

      const lines = [
        "INSTRUCTIONS PROVIDED: No installation has been performed.",
        "Install .NET SDK 8.0 - user-level install (no admin/UAC, recommended):",
      ];
      if (process.platform === "win32") {
        lines.push(
          "  PowerShell:",
          '  iex "& { $(irm https://dot.net/v1/dotnet-install.ps1) } -Channel 8.0"',
          "  -> installs to %USERPROFILE%\\.dotnet, no admin required",
          "",
          "Alternate (system-level, needs admin/UAC):",
          "  winget install Microsoft.DotNet.SDK.8",
        );
      } else if (process.platform === "darwin") {
        lines.push(
          "  curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0",
          "  -> installs to ~/.dotnet, no password required",
          "",
          "Alternate (system-level, needs password):",
          "  brew install --cask dotnet-sdk",
        );
      } else {
        lines.push("  curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0");
      }
      lines.push(
        "",
        "Note: this tool only guides the install. Uninstalling is your choice.",
        "(delete ~/.dotnet, or `brew uninstall --cask dotnet-sdk` / `winget uninstall Microsoft.DotNet.SDK.8`).",
        "NEXT: after installing, call check_runtime again.",
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ok: false },
      };
    },
  });
}
