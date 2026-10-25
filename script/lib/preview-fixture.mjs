/**
 * The fixture the tools/preview.mjs suites share: a throwaway mod, the real CLI, and the page
 * values the app would save. Split out so one test file per topic can spawn the CLI in its own
 * process, which is what the runner parallelises.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_VANILLA } from "../../tools/model.mjs";
import { readPageValues, writePageValues } from "../../editors/card/page.mjs";

export const PREVIEW = fileURLToPath(new URL("../../tools/preview.mjs", import.meta.url));
export const VANILLA = String(DEFAULT_VANILLA).replace(/^~/, os.homedir());
export const skip = existsSync(VANILLA) ? false : "the game's config is not installed on this machine";
export const read = (file) => readFileSync(file, "utf8");
export const run = (args, cwd) => spawnSync(process.execPath, [PREVIEW, ...args], { encoding: "utf8", cwd });

/** A card id, a second card, and an event the graph can draw. */
export const CARD = { id: 9000001, name: "测试卡", is_reversed: 0, type: 1, rare: 1 };
export const eventAt = (id, text) => ({ id, text, is_replay: 0, on: { rite_end: 5000002 }, condition: {}, settlement: [] });

/** A mod with an info.json and the files given: relative path -> record object or text. */
export function mod(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-"));
  writeFileSync(
    path.join(dir, "info.json"),
    JSON.stringify({ name: "Preview probe", description: "", tags: [], version: "1.0.0" })
  );
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** A cards.json with a BOM, a comment, a trailing comma, an unknown key and two cards. */
export const SAMPLE_CARDS =
  "\ufeff{\n" +
  "  // 卡表：一个 id 一张卡\n" +
  '  "9000001": {\n' +
  '    "id": 9000001,\n' +
  '    "name": "旧名字",\n' +
  '    "type": "char",\n' +
  '    "rare": 1,\n' +
  '    "tag": { "体魄": 1, "装备": 1 },\n' +
  '    "text": "说明",\n' +
  '    "future_key": true,\n' +
  "  },\n" +
  '  "9000002": { "id": 9000002, "name": "另一张", "type": "char", "rare": 2, "tag": { "战斗": 3 } }\n' +
  "}\n";

/** A mod whose two cards have pages; the pages are what collect and apply read. */
export function cardMod() {
  const dir = mod({ "config/cards.json": SAMPLE_CARDS });
  const r = run(["--mod", dir]);
  if (r.status !== 0) throw new Error(`preview failed in the fixture: ${r.stdout}${r.stderr}`);
  return dir;
}

export const cardPageFile = (dir, id = "9000001") => path.join(dir, ".preview", `${id}.card.html`);

/** What the app save does: replace the page's own value block. */
export function editPage(dir, change, remove = [], id = "9000001") {
  const file = cardPageFile(dir, id);
  const html = read(file);
  const block = readPageValues(html);
  const values = { ...block.values, ...change };
  for (const key of remove) delete values[key];
  writeFileSync(file, writePageValues(html, block.id, values));
}
