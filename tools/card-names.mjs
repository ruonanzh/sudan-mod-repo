/**
 * card-names.mjs — card id → name, so a page can say what an effect gives.
 *
 * A settlement effect reads `"card": 2800001`, and a page that prints the id tells a player
 * nothing about what they get. The name lives in a `cards.json`: the mod's own copy first, then
 * the vanilla one, so a mod that adds a card and one that only uses vanilla cards both read
 * `生成卡牌 血滴子`. A missing or unreadable file contributes nothing and the page falls back to
 * the id — an empty table cell would look like a missing effect.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDoc, findEntry, valueOf } from "./jsonc.mjs";

const CARDS = "cards.json";

/** Read one `cards.json` into `map`; a `_`-prefixed key is a comment the game ignores. */
function addFile(map, file) {
  if (!existsSync(file)) return;
  let doc;
  try {
    doc = parseDoc(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  for (const entry of doc.root.entries) {
    if (String(entry.key).startsWith("_")) continue;
    const name = valueOf(doc, findEntry(entry.value, "name")?.value);
    if (name) map.set(String(entry.key), String(name));
  }
}

/**
 * Card id → name from each directory's `cards.json`, earlier directories winning.
 *
 * The directories are config directories, the same shape `vanillaRequirement()` returns. A mod
 * that redefines a vanilla id carries the same key, so the mod's directory must be read last.
 */
export function cardNames(dirs = []) {
  const map = new Map();
  for (const dir of [...dirs].reverse()) if (dir) addFile(map, path.join(dir, CARDS));
  return map;
}

export default { cardNames };
