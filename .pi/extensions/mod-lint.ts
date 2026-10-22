/**
 * validate_mod - run `tools/lint.mjs` on one mod folder and report what it said.
 *
 * The rules are the linter's, not this file's: one subprocess with `--json`, so the CLI and
 * the tool cannot drift. The vanilla config is resolved by `tools/paths.mjs` (explicit path,
 * then `.gamer-agent.local.json`, then the install), so a machine that never recorded one
 * gets PARTIAL instead of a crash or a silent skip.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathsFile, vanillaRequirement } from "../../tools/paths.mjs";
import { runAsync } from "../lib/proc";

/** The tool text shows this many messages; `details` carries every one. */
const MESSAGE_LIMIT = 20;
/** One lint message, clipped so a pathological field value cannot flood the report. */
const MESSAGE_CLIP = 500;

interface LintResult {
  level: string;
  code: string;
  file?: string | null;
  message: string;
}

const clip = (text: string): string =>
  text.length <= MESSAGE_CLIP ? text : `${text.slice(0, MESSAGE_CLIP)}...`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "validate_mod",
    label: "Validate Mod",
    description:
      "Validate one mod folder with tools/lint.mjs and report FAIL, WARN and INFO counts plus the messages. A relative modDir uses the workspace root. It resolves the vanilla config through .gamer-agent.local.json and reports PARTIAL when the config is missing, because id collision and tag checks were skipped. It does not edit files, install the mod, or run the game.",
    promptSnippet: "Lint a mod folder and report FAIL, WARN and INFO messages",
    promptGuidelines: [
      "Use validate_mod after writing or changing a mod, and before installing it. It runs the same linter as `node tools/lint.mjs`, so do not run the CLI for the same folder in the same turn.",
      "validate_mod reports PASS, PARTIAL or FAIL. PARTIAL means the mod passed every rule that ran, but the vanilla config was missing, so id collision and tag checks were skipped; resolve the NEXT line before claiming the mod is clean.",
      "validate_mod does not install the mod and does not prove the game loads it. Install and test in the game as a separate step.",
    ],
    parameters: Type.Object({
      modDir: Type.String({
        minLength: 1,
        description:
          "Mod folder to validate, for example your_mods/MyMod. It may be absolute or relative to the workspace root.",
      }),
      vanilla: Type.Optional(
        Type.String({
          description:
            "Vanilla config directory to validate against, for example .../StreamingAssets/config. Omit it to use the recorded path.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const raw = params.modDir?.trim();
      if (!raw) throw new Error("INVALID_MOD_DIR: pass modDir=<your_mods/ModName>.");
      const modDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      if (!statSync(modDir, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(
          `INVALID_MOD_DIR: ${modDir} is not a directory. Check the path, or create the mod in an authorized mod-development session first.`,
        );
      }

      const lint = path.join(cwd, "tools/lint.mjs");
      if (!existsSync(lint)) {
        throw new Error(
          `LINT_MISSING: ${lint} does not exist. validate_mod runs the repository's own linter; reopen the workspace from its root.`,
        );
      }

      const named = params.vanilla?.trim();
      const vanillaArg = named ? (path.isAbsolute(named) ? named : path.resolve(cwd, named)) : undefined;
      const known = vanillaRequirement(vanillaArg, { file: pathsFile(cwd) }) as { dir: string | null; message?: string };

      const args = [lint, modDir, "--json"];
      if (known.dir) args.push("--vanilla", known.dir);

      let stdout = "";
      try {
        const run = await runAsync(process.execPath, args, {
          cwd,
          // pi-desktop runs extensions inside Electron; this makes process.execPath run as node.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          timeoutMs: 120_000,
        });
        stdout = run.stdout;
      } catch (error) {
        const failed = error as Error & { stdout?: string; stderr?: string };
        if (!failed.stdout) {
          const detail = (failed.stderr || failed.message).split("\n")[0];
          throw new Error(`LINT_FAILED: tools/lint.mjs produced no JSON (${detail}).`);
        }
        // A lint FAIL exits 1 and still writes the report to stdout.
        stdout = failed.stdout;
      }

      let report: { counts?: Record<string, number>; results?: LintResult[] };
      try {
        report = JSON.parse(stdout) as typeof report;
      } catch {
        throw new Error(
          `LINT_FAILED: tools/lint.mjs printed no JSON (first line: ${stdout.split("\n")[0] || "empty"}).`,
        );
      }
      const counts = report.counts ?? { FAIL: 0, WARN: 0, INFO: 0 };
      const results = report.results ?? [];
      const status = (counts.FAIL ?? 0) > 0 ? "FAIL" : known.dir ? "PASS" : "PARTIAL";

      const order: Record<string, number> = { FAIL: 0, WARN: 1, INFO: 2 };
      const sorted = [...results].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
      const shown = sorted.slice(0, MESSAGE_LIMIT);

      const where = path.relative(cwd, modDir) || modDir;
      const lines = [
        `${status}: ${counts.FAIL ?? 0} fail, ${counts.WARN ?? 0} warn, ${counts.INFO ?? 0} info (${where})`,
      ];
      if (status === "PARTIAL") lines.push(`  vanilla config missing: ${known.message ?? "not found"}`);
      for (const r of shown) {
        lines.push(`${r.level.padEnd(4)} ${(r.file || "-").padEnd(30)} ${r.code.padEnd(22)} ${clip(r.message)}`);
      }
      if (results.length > shown.length) {
        lines.push(`... (${results.length - shown.length} more messages; details.results has all ${results.length})`);
      }
      if (status === "FAIL") {
        lines.push(
          "NEXT: fix the FAIL messages, then run validate_mod again. This tool did not edit the mod; nothing is installed.",
        );
      } else if (status === "PARTIAL") {
        lines.push(
          "NEXT: run check_game_paths to see which sentinel is missing, then record the vanilla config with set_game_dir, or pass vanilla=<config dir>. Without it, id collision and tag checks did not run.",
        );
      } else {
        lines.push(
          "NEXT: the mod passes lint. Install it and confirm the game loads it; a clean lint does not prove the change is visible in the game.",
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          ok: status === "PASS",
          status,
          counts,
          results,
          modDir,
          vanilla: known.dir,
        },
      };
    },
  });
}
