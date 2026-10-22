/**
 * The report `check_game_paths` and `try_set_game_dir` share.
 *
 * Both tools report the same six locations in the same shape, and a reader compares their
 * output across calls. Keeping the formatter in one place is what makes "the same shape" true
 * instead of two copies that drift. The judgment itself is `tools/paths.mjs`.
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

/** One line per location: the name, the status, the path, and the sentinel that decided it. */
export function formatRows(rows: PathRow[]): string[] {
  return rows.map((r) => {
    const where = r.path ? shorten(r.path) : "(not found)";
    return `${r.name.padEnd(8)} ${r.status.padEnd(5)} ${where}${r.reason ? `  (${r.reason})` : ""}`;
  });
}

/** The required locations that are not OK. A missing optional location is not here. */
export function failedNames(rows: PathRow[]): string[] {
  return rows.filter((r) => REQUIRED.includes(r.name) && r.status !== "OK").map((r) => r.name);
}

/** The one-line verdict that closes a report. */
export function summarize(ok: boolean, rows: PathRow[]): string {
  return ok ? "PASS: every required location is OK" : `FAIL: ${failedNames(rows).join(", ")} not OK`;
}
