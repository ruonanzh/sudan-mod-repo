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
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { judge, pathsFile, shorten } from "../../tools/paths.mjs";
import { installFolder, walk } from "../lib/mod-files";
import { absolute, identity, sameOrNested } from "../lib/workspace";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "install_mod",
    label: "Install Mod",
    description:
      "Copy one mod folder from the workspace into the game's mod install directory. The directory is the recorded modInstallDir, or the one derived from MyDocuments when nothing is recorded; a missing folder reports PARTIAL and a wrong folder reports FAIL, never a guess. An existing copy of the same folder is replaced as a whole, so files dropped from the new version do not stay behind. This tool skips .preview, .git, .DS_Store and ._* files. It does not enable the mod, does not edit game records, and does not start the game.",
    promptSnippet: "Copy a mod folder into the game's mod directory",
    promptGuidelines: [
      "Use install_mod after validate_mod reports PASS, and pass modDir=<your_mods/ModName>. Do not copy the folder with a shell command: the tool replaces the whole folder and reports the install directory it used.",
      "install_mod never enables the mod. After it reports PASS, tell the player to enable the mod in the game's mod panel (title screen), then read ModLog/<mod name>_local.log for a `read mod` line before claiming the mod works.",
      "A PARTIAL from install_mod means the mod folder does not exist yet: start the game once so it creates the folder, then install again. A FAIL means the recorded folder is wrong: run try_set_game_dir. Do not create the folder by hand.",
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
      let info: { name?: unknown };
      try {
        info = JSON.parse(readFileSync(infoFile, "utf8")) as typeof info;
      } catch (error) {
        throw new Error(`INVALID_MOD: ${infoFile} is not valid JSON (${(error as Error).message}). Fix info.json first.`);
      }
      if (info.name !== undefined && typeof info.name !== "string") {
        throw new Error(`INVALID_MOD: info.json has a non-string "name". Give it a display name, then retry.`);
      }
      const name = (info.name as string | undefined)?.trim() || path.basename(source);

      const rows = judge({ file: pathsFile(cwd) }).rows as Array<{
        name: string;
        status: string;
        path: string | null;
        reason?: string;
      }>;
      const root = rows.find((row) => row.name === "modInstallDir");
      if (!root?.path || root.status !== "OK") {
        // MISS: the folder does not exist yet (the game creates it on first run).
        // FAIL: a recorded folder exists but is not the game's mod folder; starting the game
        // again will not fix that, so the two cases get different next steps.
        const missing = root?.status === "MISS";
        const why = root?.reason ? ` (${root.reason})` : "";
        return {
          content: [
            {
              type: "text",
              text: [
                `${missing ? "PARTIAL" : "FAIL"}: the mod install directory is not available${why}.`,
                missing
                  ? "NEXT: start the game once so it creates the mod folder, then run install_mod again. Do not create the folder by hand; the game also creates it from the mod panel button."
                  : "NEXT: run try_set_game_dir to find the game again, or set_game_dir with the real install folder, then run install_mod again. Do not create the folder by hand.",
              ].join("\n"),
            },
          ],
          details: {
            ok: false,
            status: missing ? "PARTIAL" : "FAIL",
            wroteState: false,
            installed: false,
            target: null,
          },
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
      // Compare real paths, not spellings: a symlink or a `..` in the argument would otherwise
      // pass the string test and let the copy delete its own source.
      if (sameOrNested(identity(source), identity(target))) {
        throw new Error(
          `UNSAFE_TARGET: ${source} and ${target} are the same folder (or one holds the other). Refusing to copy.`,
        );
      }

      let copied;
      try {
        copied = installFolder(source, target);
      } catch (error) {
        throw new Error(
          `INSTALL_FAILED: could not write ${target} (${(error as Error).message}). The previous copy, if there was one, is still in place. Close the game if it is running and run install_mod again.`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `PASS: installed ${name} to ${shorten(target)} (${copied.files} files${copied.replaced ? ", the previous copy was replaced" : ""}).`,
              copied.replaced
                ? "NEXT: tell the player to refresh the mod list in the game's mod panel, then read ModLog/<mod name>_local.log and confirm a `read mod` line for each file you changed. Installing does not prove the game loads it."
                : "NEXT: tell the player to enable the mod in the game's mod panel (title screen), then read ModLog/<mod name>_local.log and confirm a `read mod` line for each file you changed. Installing does not prove the game loads it.",
            ].join("\n"),
          },
        ],
        details: {
          ok: true,
          status: "PASS",
          wroteState: false,
          installed: true,
          replaced: copied.replaced,
          target,
          files: copied.files,
          fileList: walk(source),
          modName: name,
        },
      };
    },
  });
}
