/**
 * install_mod — copy one mod folder into the game's mod install directory.
 *
 * What this tool does not do: it does not enable the mod (the game owns enablement, in the
 * mod panel), does not edit the game's records, and does not prove the game loaded anything.
 * The install directory comes from `tools/paths.mjs`, so an unrecorded or missing folder is
 * reported as PARTIAL with the sentence that fixes it, not guessed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { judge, pathsFile, shorten } from "../../tools/paths.mjs";

const absolute = (cwd: string, p: string): string => {
  const expanded = p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
};

/** Every file under `dir`, relative, so the count and the list agree. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "install_mod",
    label: "Install Mod",
    description:
      "Copy one mod folder from the workspace into the game's mod install directory. The directory comes from .gamer-agent.local.json; when it is missing the tool reports PARTIAL instead of guessing. An existing copy of the same folder is replaced as a whole, so files dropped from the new version do not stay behind. It does not enable the mod, does not edit game records, and does not start the game.",
    promptSnippet: "Copy a mod folder into the game's mod directory",
    promptGuidelines: [
      "Use install_mod after validate_mod reports PASS, and pass modDir=<your_mods/ModName>. Do not copy the folder with a shell command: the tool replaces the whole folder and reports the install directory it used.",
      "install_mod never enables the mod. After it reports PASS, tell the player to enable the mod in the game's mod panel (title screen), then read ModLog/<mod name>_local.log for a `read mod` line before claiming the mod works.",
      "A PARTIAL from install_mod means the mod install directory is missing. Start the game once so it creates the folder, then run install_mod again; do not create the folder by hand.",
    ],
    parameters: Type.Object({
      modDir: Type.String({
        minLength: 1,
        description:
          "Mod folder to install, for example your_mods/<ModName>. It may be absolute or relative to the workspace root.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const raw = params.modDir?.trim();
      if (!raw) throw new Error("INVALID_MOD_DIR: pass modDir=<your_mods/ModName>.");

      const source = absolute(cwd, raw);
      if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`INVALID_MOD_DIR: ${source} is not a directory. Check the path.`);
      }
      const infoFile = path.join(source, "info.json");
      if (!existsSync(infoFile)) {
        throw new Error(
          `INVALID_MOD: ${source} has no info.json. The game only loads a folder with a valid info.json; fix the mod first.`,
        );
      }
      let info: { name?: string };
      try {
        info = JSON.parse(readFileSync(infoFile, "utf8")) as typeof info;
      } catch (error) {
        throw new Error(`INVALID_MOD: info.json is not valid JSON (${(error as Error).message}).`);
      }
      const name = info.name?.trim() || path.basename(source);
      const files = walk(source);

      const rows = judge({ file: pathsFile(cwd) }).rows as Array<{ name: string; status: string; path: string | null; reason?: string }>;
      const root = rows.find((row) => row.name === "modInstallDir");
      if (!root?.path || root.status !== "OK") {
        const why = root?.reason ? ` (${root.reason})` : "";
        return {
          content: [
            {
              type: "text",
              text: [
                `PARTIAL: the mod install directory is not available${why}.`,
                "NEXT: start the game once so it creates the mod folder, then run install_mod again. Do not create the folder by hand; the game also creates it from the mod panel button.",
              ].join("\n"),
            },
          ],
          details: { ok: false, status: "PARTIAL", wroteState: false, installed: false, target: null },
        };
      }

      const folder = path.basename(source);
      const target = path.join(root.path, folder);
      const relative = path.relative(root.path, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          `UNSAFE_TARGET: ${target} is not inside the mod install directory ${root.path}. Refusing to copy.`,
        );
      }
      if (target === source || source.startsWith(`${target}${path.sep}`)) {
        throw new Error(`UNSAFE_TARGET: ${source} is already the install directory. Refusing to copy onto itself.`);
      }

      const replaced = existsSync(target);
      if (replaced) rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });

      return {
        content: [
          {
            type: "text",
            text: [
              `PASS: installed ${name} to ${shorten(target)} (${files.length} files${replaced ? ", the previous copy was replaced" : ""}).`,
              "NEXT: tell the player to enable the mod in the game's mod panel (title screen), then read ModLog/<mod name>_local.log and confirm a `read mod` line for each file you changed. Installing does not prove the game loads it.",
            ].join("\n"),
          },
        ],
        details: {
          ok: true,
          status: "PASS",
          wroteState: false,
          installed: true,
          replaced,
          target,
          files: files.length,
          fileList: files,
          modName: name,
        },
      };
    },
  });
}
