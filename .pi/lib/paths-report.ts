/**
 * The report the three path tools share.
 *
 * `check_game_paths` prints the judged rows; `set_game_dir` and `try_set_game_dir` print the
 * same verdict words and the same derived lines. Keeping the formatter in one place is what
 * makes "the same shape" true instead of three copies that drift. The judgment itself is
 * `tools/paths.mjs`.
 */
import { REQUIRED, shorten } from "../../tools/paths.mjs";

/** One judged location, as `judge` returns it. */
export interface PathRow {
  name: string;
  status: string;
  path: string | null;
  reason: string;
  tried?: string[];
}

/** The locations a game directory implies. None of them is stored except the first two. */
export interface DerivedPaths {
  gameDir: string | null;
  vanillaDir: string | null;
  modInstallDir: string | null;
  workshopDir: string | null;
}

/** One line per location: the name, the status, the path, and the sentinel that decided it. */
export function formatRows(rows: PathRow[]): string[] {
  return rows.map((r) => {
    const where = r.path ? shorten(r.path) : "(not found)";
    return `${r.name.padEnd(14)} ${r.status.padEnd(5)} ${where}${r.reason ? `  (${r.reason})` : ""}`;
  });
}

/** The required locations that are not OK. The workshop is a reference, so it is never here. */
export function failedNames(rows: PathRow[]): string[] {
  return rows.filter((r) => REQUIRED.includes(r.name) && r.status !== "OK").map((r) => r.name);
}

/** The one-line verdict that closes a check report. */
export function summarize(ok: boolean, rows: PathRow[]): string {
  return ok ? "PASS: every required location is OK" : `FAIL: ${failedNames(rows).join(", ")} not OK`;
}

/** One line per derived location, as the recording tools report them after the verdict. */
export function derivedLines(paths: DerivedPaths): string[] {
  const line = (name: string, value: string | null) => `${name} (derived from gameDir) ${value ? shorten(value) : "(not found)"}`;
  return [line("vanilla", paths.vanillaDir), line("modInstallDir", paths.modInstallDir), line("workshopDir", paths.workshopDir)];
}

/** What `setGameDirWithFallback` reports: the given path was used, replaced, or nothing was recorded. */
export interface PathOutcome extends DerivedPaths {
  status: "PASS" | "WARN" | "FAIL";
  given: string | null;
  recorded: string | null;
  reason?: string;
  next?: string;
}

/**
 * The verdict in words. WARN means the given path did not validate but the game was found
 * anyway, and the recorded path is the one now in use; FAIL means nothing was written.
 */
export function formatOutcome(o: PathOutcome): { text: string; ok: boolean; status: PathOutcome["status"] } {
  if (o.status === "PASS") {
    return {
      text: [`PASS: recorded gameDir ${shorten(o.recorded)} (validated).`, ...derivedLines(o)].join("\n"),
      ok: true,
      status: o.status,
    };
  }
  if (o.status === "WARN") {
    return {
      text: [
        `WARN: the gameDir you passed (${o.given}) did not pass validation - ${o.reason}.`,
        `Recorded ${shorten(o.recorded)} instead.`,
        ...derivedLines(o),
        `NEXT: ${o.next ?? "Tell the player which path is actually in use."}`,
      ].join("\n"),
      ok: true,
      status: o.status,
    };
  }
  return {
    text: [
      "FAIL: could not record gameDir.",
      `Given: ${o.given ?? "(none)"}`,
      `Reason: ${o.reason ?? "unknown"}.`,
      `NEXT: ${o.next ?? "Ask the player where the game is installed."}`,
    ].join("\n"),
    ok: false,
    status: o.status,
  };
}
