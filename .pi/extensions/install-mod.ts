/**
 * install_mod — copy one mod folder into the game's mod install directory.
 *
 * What this tool does not do: it does not enable the mod (the game owns enablement, in the
 * mod panel), does not edit the game's records, and does not prove the game loaded anything.
 * The install directory comes from `tools/paths.mjs`, so an unrecorded or missing folder is
 * reported as FAIL with the sentence that fixes it, not guessed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { judge, pathsFile, shorten } from "../../tools/paths.mjs";
import { parseDoc, toPlain } from "../../tools/jsonc.mjs";
import { InstallError, installFolder, walk } from "../lib/mod-files";
import { ascii, clipUtf8 } from "../lib/clip";
import { absolute, identity, sameOrNested } from "../lib/workspace";

/** The thumbnail the installed copy gets when the mod ships none of its own. */
const PLACEHOLDER_PREVIEW = fileURLToPath(new URL("../../reference/placeholders/preview.png", import.meta.url));

/** A thrown message is shown to the agent as text too: escape it like any other content. */
const fail = (message: string): never => {
  throw new Error(ascii(clipUtf8(message)));
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "install_mod",
    label: "Install Mod",
    description:
      "Copy one mod folder from the workspace into the game's mod install directory. The directory is the recorded modInstallDir, or the one derived from MyDocuments when nothing is recorded; a missing or wrong folder reports FAIL with the step that fixes it, never a guess. An existing copy of the same folder is replaced as a whole, so files dropped from the new version do not stay behind. A mod with no preview.png or preview.jpg gets reference/placeholders/preview.png in the installed copy, named in the PASS line; the mod folder itself is never touched. This tool skips .preview, .git, .DS_Store, asset_manifest.jsonl and ._* files. It does not enable the mod, does not edit game records, and does not start the game.",
    promptSnippet: "Copy a mod folder into the game's mod directory",
    promptGuidelines: [
      "Use install_mod after validate_mod reports PASS, and pass modDir=<your_mods/ModName>. Do not copy the folder with a shell command: the tool replaces the whole folder and reports the install directory it used.",
      "install_mod never enables the mod. After it reports PASS, tell the player to enable the mod in the game's mod panel (title screen), then read ModLog/<mod name>_local.log for a `read mod` line before claiming the mod works.",
      "A FAIL naming a missing folder means the mod folder does not exist yet: ask the player to press the \"ModList\" button in the game's mod panel, which creates the folder, then install again. A FAIL naming a wrong folder means run try_set_game_dir. Do not create the folder by hand.",
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
        fail(`INVALID_MOD_DIR: ${source} is not a directory. Check the path.`);
      }
      const infoFile = path.join(source, "info.json");
      if (!existsSync(infoFile)) {
        fail(
          `INVALID_MOD: ${source} has no info.json. The game only loads a folder with a valid info.json; fix the mod first.`,
        );
      }
      // info.json is read by the game's JSONC loader, and `tools/lint.mjs` accepts comments, a BOM
      // and trailing commas. Parsing it here as strict JSON refused files the linter had just
      // passed, so both now read it the same way.
      let info: { name?: unknown };
      try {
        const doc = parseDoc(readFileSync(infoFile, "utf8"));
        info = (toPlain(doc, doc.root) ?? {}) as typeof info;
        if (typeof info !== "object" || info === null) throw new Error("INVALID_MOD: info.json holds no object");
      } catch (error) {
        fail(`INVALID_MOD: ${infoFile} is not readable JSONC (${(error as Error).message}). Fix info.json first.`);
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
                `FAIL: the mod install directory is not available${why}.`,
                missing
                  ? "NEXT: ask the player to press the \"ModList\" button in the game's mod panel, which creates the mod folder, then run install_mod again. Do not create the folder by hand."
                  : "NEXT: run try_set_game_dir to find the game again, or set_game_dir with the real install folder, then run install_mod again. Do not create the folder by hand.",
              ].join("\n"),
            },
          ],
          details: {
            ok: false,
            wroteState: false,
            installed: false,
            target: null,
          },
        };
      }

      const folder = path.basename(source);
      const target = path.join(root.path, folder);
      // The workspace is app-managed: writing into it is forbidden everywhere else in this repo,
      // and an install target that happens to sit inside it would break that rule through the one
      // tool whose job is writing.
      if (sameOrNested(identity(cwd), identity(target))) {
        fail(
          `UNSAFE_TARGET: the install directory ${shorten(target)} is inside the workspace ${shorten(cwd)}. Install into the game's mod folder, not into the repo.`,
        );
      }
      const relative = path.relative(root.path, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        fail(
          `UNSAFE_TARGET: ${target} is not inside the mod install directory ${root.path}. Refusing to copy.`,
        );
      }
      // Compare real paths, not spellings: a symlink or a `..` in the argument would otherwise
      // pass the string test and let the copy delete its own source.
      if (sameOrNested(identity(source), identity(target))) {
        fail(
          `UNSAFE_TARGET: ${source} and ${target} are the same folder (or one holds the other). Refusing to copy.`,
        );
      }

      let copied;
      try {
        copied = installFolder(source, target);
      } catch (error) {
        // Say what actually stands on disk: a swallowed rollback used to be reported as "the old
        // copy is still in place", which was false exactly when the player needed to know.
        const detail = error instanceof Error ? error.message : String(error);
        const restored = error instanceof InstallError ? error.restored : false;
        const backup = error instanceof InstallError ? error.backup : null;
        const replaced = error instanceof InstallError ? error.replaced : false;
        const state = !replaced
          ? "Nothing was installed, and there was no previous copy to restore."
          : restored
            ? "The previous copy is still in place."
            : backup
              ? `The previous copy could not be put back; it is at ${backup}. Copy it back by hand before running the game.`
              : "The previous copy is not in place; check the install folder before running the game.";
        fail(`INSTALL_FAILED: could not write ${target} (${detail}). ${state} Close the game if it is running and run install_mod again.`);
      }

      const folderName = path.basename(source);
      // A mod with no thumbnail shows an empty card in the game's mod panel and on the Workshop
      // page. The placeholder lands in the installed copy only — the mod folder stays as the
      // author left it — and a mod that later ships its own preview wins, because every install
      // replaces the whole folder.
      let placeholder = false;
      if (!["preview.png", "preview.jpg"].some((n) => existsSync(path.join(target, n))) && existsSync(PLACEHOLDER_PREVIEW)) {
        copyFileSync(PLACEHOLDER_PREVIEW, path.join(target, "preview.png"));
        placeholder = true;
      }
      const files = copied.files + (placeholder ? 1 : 0);
      // The game shows `info.json`'s `name` and names `ModLog/<name>_local.log` after it; the folder
      // name is only where the files sit. A workshop mod's folder is a numeric id and its name is
      // Chinese, so the two differing is normal — say which name to look for, do not ask for a rename.
      const shown =
        typeof name === "string" && name !== folderName
          ? `INFO: the folder is ${folderName}; the mod panel and ModLog use the name "${name}".`
          : null;
      return {
        content: [
          {
            type: "text",
            text: clipUtf8(
              ascii(
                [
                  // The name is the player's own text; escape it for a console that cannot print it.
                  `PASS: installed ${name} to ${shorten(target)} (${files} files${copied.replaced ? ", the previous copy was replaced" : ""}${placeholder ? ", the placeholder preview was added because the mod ships none" : ""}).`,
                  // No NEXT on PASS: the mod-installer SKILL already tells the agent to have the
                  // player enable the mod and to read the log. Repeating it here adds noise.
                  ...(shown ? [shown] : []),
                ].join("\n"),
              ),
            ),
          },
        ],
        details: {
          ok: true,
          wroteState: false,
          installed: true,
          replaced: copied.replaced,
          target,
          files,
          placeholderPreview: placeholder,
          fileList: walk(source),
          modName: name,
        },
      };
    },
  });
}
