/**
 * generate_2d_asset — the 2D side of asset work: draw, crop, verify, check references.
 *
 * There is no card in this file on purpose. A card face is 472x1028 with the top fifth left
 * empty; that sentence belongs to the `card-art` SKILL, together with the prompt recipe and the
 * reference-picture rule. This tool only knows four actions:
 *
 * - `generate`: draw one picture from a prompt (plus reference pictures) and save it to `out`.
 *   With `task`, it downloads an existing task instead and spends nothing.
 * - `fit`: crop or letterbox a PNG to an exact size.
 * - `check`: read a PNG and compare it with what the caller promised.
 * - `refs`: report which expected reference pictures are missing from a directory.
 *
 * The work itself is `tools/image.mjs`; one subprocess, so the CLI and the tool cannot drift.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clipUtf8 } from "../lib/clip";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runAsync } from "../lib/proc";

/** Generation waits up to 15 minutes in the CLI; give the subprocess that much plus overhead. */
const GENERATE_TIMEOUT_MS = 960_000;

interface CliResult {
  stdout: string;
  stderr: string;
}

/** The last few lines of output: the tool speaks in PASS / WARN / FAIL plus a NEXT line. */
function summarize(result: CliResult): string {
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return clipUtf8(text || "(no output)");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_2d_asset",
    label: "Generate 2D Asset",
    description:
      "Draw one 2D picture from a prompt and reference pictures, crop a PNG to an exact size, verify a PNG, or list missing reference pictures. Four actions: generate, fit, check, refs. It saves files where out says and never touches a game record. The prompt, the size, and which pictures to use come from the capability SKILL that calls it.",
    promptSnippet: "Draw, crop, or verify a 2D picture (generate / fit / check / refs)",
    promptGuidelines: [
      "generate_2d_asset with action=generate writes the picture to out. Write previews into .preview/ and show them from the page; the page is where the player confirms a card picture. That tool never edits a game record.",
      "generate_2d_asset with action=fit changes only the size, never the content. When a picture is the wrong shape, fix the prompt or use fit; do not ask for a redraw to change its size.",
      "generate_2d_asset with task= downloads an existing task and spends nothing. Reuse it to crop or copy the same picture again instead of drawing a second one.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("generate"), Type.Literal("fit"), Type.Literal("check"), Type.Literal("refs")],
        { description: "generate: draw or download. fit: resize a PNG. check: verify a PNG. refs: list missing pictures." },
      ),
      prompt: Type.Optional(Type.String({ description: "generate: the whole prompt, as the capability SKILL writes it." })),
      refs: Type.Optional(
        Type.Array(Type.String(), {
          description: "generate: reference pictures, in order. Each must exist on disk; the first one is the style reference.",
        }),
      ),
      out: Type.Optional(Type.String({ description: "generate / fit: where to save the PNG, for example your_mods/M/.preview/a.png." })),
      background: Type.Optional(Type.String({ description: "generate: background, default transparent." })),
      format: Type.Optional(Type.String({ description: "generate: output format, default png." })),
      task: Type.Optional(Type.String({ description: "generate: an existing task id to download instead of drawing." })),
      manifest: Type.Optional(
        Type.String({
          description: "generate: append one line per attempt to this JSONL file, usually your_mods/M/asset_manifest.jsonl.",
        }),
      ),
      in: Type.Optional(Type.String({ description: "fit: the PNG to read." })),
      width: Type.Optional(Type.Number({ description: "fit / check: expected width in pixels." })),
      height: Type.Optional(Type.Number({ description: "fit / check: expected height in pixels." })),
      mode: Type.Optional(Type.Union([Type.Literal("cover"), Type.Literal("contain")], { description: "fit: cover fills the target and crops the overflow, contain fits inside and adds transparent bands. Default cover." })),
      file: Type.Optional(Type.String({ description: "check: the PNG to verify." })),
      alpha: Type.Optional(Type.Boolean({ description: "check: when true, a picture without an alpha channel fails." })),
      dir: Type.Optional(Type.String({ description: "refs: the folder that should hold the reference pictures." })),
      expect: Type.Optional(Type.Array(Type.String(), { description: "refs: the file names that should exist in dir." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      // Resolved from this file, not from the caller's cwd: the tool lives beside the repo's tools.
      const cli = fileURLToPath(new URL("../../tools/image.mjs", import.meta.url));
      const args: string[] = [params.action];
      const push = (name: string, value: unknown) => {
        if (value === undefined || value === null || value === "" || value === false) return;
        if (Array.isArray(value)) {
          for (const item of value) args.push(`--${name}`, String(item));
          return;
        }
        args.push(`--${name}`, value === true ? "true" : String(value));
      };

      if (params.action === "generate") {
        push("prompt", params.prompt);
        push("ref", params.refs);
        push("out", params.out);
        push("background", params.background);
        push("format", params.format);
        push("task", params.task);
        push("manifest", params.manifest);
      } else if (params.action === "fit") {
        push("in", params.in);
        push("out", params.out);
        push("width", params.width);
        push("height", params.height);
        push("mode", params.mode);
      } else if (params.action === "check") {
        push("file", params.file);
        push("width", params.width);
        push("height", params.height);
        push("alpha", params.alpha);
      } else {
        push("dir", params.dir);
        push("expect", params.expect);
      }

      let result: CliResult;
      try {
        result = await runAsync(process.execPath, [cli, ...args], {
          cwd,
          timeoutMs: params.action === "generate" ? GENERATE_TIMEOUT_MS : 60_000,
        });
      } catch (error) {
        // The CLI reports FAIL on its own; a spawn failure is ours to explain.
        const e = error as Error & { stdout?: string; stderr?: string; code?: string };
        if (e.code === "ENOENT") throw new Error("tools/image.mjs is missing from this workspace; run setup-workspace or update the workspace.");
        const text = summarize({ stdout: e.stdout || "", stderr: e.stderr || "" });
        // The CLI exits 1 for WARN and FAIL too: both are answers, not spawn failures.
        if (/(^|\n)(PASS|WARN|FAIL)/.test(text)) return { content: [{ type: "text" as const, text }] };
        throw new Error(text || e.message);
      }

      return { content: [{ type: "text" as const, text: summarize(result) }] };
    },
  });
}
