#!/usr/bin/env node
/**
 * lint.mjs - validate a Sultan's Game mod folder.
 *
 * Usage:
 *   node tools/lint.mjs <modDir> [--vanilla <configDir>] [--json]
 *   node tools/lint.mjs --mod-root <ModRoot> [--vanilla <configDir>] [--json]
 *
 * --mod-root lints every mod under a mod root and additionally checks
 * cross-mod id collisions, which vanilla-vs-mod checks cannot see.
 *
 * Exit code: 0 = no FAIL, 1 = at least one FAIL, 2 = bad invocation.
 *
 * Output is ASCII only on purpose (Windows consoles use legacy code pages).
 * Chinese text that comes from the mod is escaped, not printed raw.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Domain constants. Every list here was verified against the game, not guessed.
// ---------------------------------------------------------------------------

/** Config entries the game actually reads from a mod (log-confirmed, see docs/game.md). */
const MODDABLE = new Map([
  ["config/game.json", "single"],
  ["config/tag.json", "table"],
  ["config/cards.json", "table"],
  ["config/init", "dir"],
  ["config/over.json", "table"],
  ["config/rite", "dir"],
  ["config/event", "dir"],
  ["config/loot", "dir"],
  ["config/dt", "dir"],
  ["config/after_story", "dir"],
  ["config/wizard", "dir"],
  ["config/upgrade.json", "table"],
  ["config/quest.json", "table"],
  ["config/rite_template", "dir"],
  ["config/rite_template_mappings.json", "table"],
  ["config/sfx_config.json", "single"],
  ["config/over_music_config.json", "table"],
  ["config/sfx_npc_role_dub.json", "table"],
  ["config/sfx_settle_card_new.json", "table"],
]);

/** Top-level entries a mod root may contain. Anything else is ignored by the game. */
const MOD_ROOT_ENTRIES = new Set(["info.json", "preview.png", "preview.jpg", "config", "image", "bgm"]);

/** dir-style config -> (a) which field holds the id, (b) how the filename must be named. */
const DIR_STYLE = new Map([
  // strict=true: the game builds the path from the id (literal "rite/{0}.json"),
  // so a mismatched filename means the file is never loaded. Code-confirmed for rite only.
  ["config/rite", { ext: ".json", filename: "id", strict: true }],
  ["config/event", { ext: ".json", filename: "id", strict: false }],
  ["config/loot", { ext: ".json", filename: "id", strict: false }],
  ["config/init", { ext: ".json", filename: "id", strict: false }],
  ["config/rite_template", { ext: ".json", filename: "id", strict: false }],
  ["config/after_story", { ext: ".json", filename: "id", strict: false }],
  ["config/dt", { ext: ".json", filename: null }],
  ["config/wizard", { ext: ".json", filename: null }],
]);

/** Table-style config that is a dict keyed by id (used for collision checks). */
const ID_TABLES = new Map([
  ["config/cards.json", "card"],
  ["config/upgrade.json", "upgrade"],
  ["config/quest.json", "quest"],
  ["config/over.json", "over"],
  ["config/tag.json", "tag"],
]);

/** Card `tag` keys that are engine pseudo-tags, not tag.json entries. */
const PSEUDO_TAG_NAMES = new Set([
  "描边", // OUTLINE_TAG_CHS = "描边"
  "金色文字", // GOLD_TEXT_TAG_CHS = "金色文字"
]);

/** Default vanilla config dir. */
const DEFAULT_VANILLA =
  "~/Library/Application Support/Steam/steamapps/common/Sultan's Game/Sultan's Game.app/Contents/Resources/Data/StreamingAssets/config";

// ---------------------------------------------------------------------------
// Field dictionary.
//
// `fields` is the declared field list of the node class in the installed build,
// read out of the decompiled types. That list IS the JSON key set: the loader
// binds keys to fields by name. So a key that is not here and not in `handler`
// is not read, and this is how `auto_start` should have been caught.
//
// `handler` are keys vanilla writes that the class does not declare. The
// generated JsonHandler consumes them explicitly, so they are legal.
//
// `legacy` are keys vanilla writes that no field backs and no handler is known
// to read. They do nothing. Warn, because deleting them changes nothing.
// ---------------------------------------------------------------------------
const NODE_FIELDS = {
  card: {
    fields: ["id", "name", "title", "text", "pops", "type", "rare", "resource", "destroy_resources", "tag", "card_vanishing", "vanish", "equips", "is_only", "sfx", "post_rite"],
    handler: ["tips", "card_favour"],
    legacy: [],
  },
  event: {
    fields: ["id", "is_replay", "auto_start_init", "on", "start_trigger", "condition", "settlement"],
    handler: ["text", "cached_settlement"],
    legacy: ["auto_start"],
  },
  rite: {
    fields: ["id", "name", "text", "tips", "type", "final_pin", "from_pins", "mapping_id", "round_number", "auto_begin", "auto_result", "restore_fill_times", "once_new", "waiting_round", "waiting_round_end_action", "icon", "location", "tag_tips_up", "tips_text", "random_text", "random_text_up", "open_conditions", "settlement_prior", "settlement", "settlement_extre", "cards_slot"],
    handler: ["tag_tips", "method_settlement", "random_effect"],
    legacy: ["mapping"],
  },
  slot: {
    fields: ["guid", "condition", "open_adsorb", "is_key", "is_empty", "is_enemy", "text", "tips_icon", "pops"],
    handler: [],
    legacy: [],
  },
  settlement: {
    fields: ["guid", "condition", "result_title", "result_text", "result", "action", "id", "type", "index", "key", "sort", "pic"],
    handler: ["tips_resource", "tips_text"],
    legacy: [],
  },
  loot: {
    fields: ["id", "name", "repeat", "type", "item"],
    handler: [],
    legacy: [],
  },
  lootItem: {
    fields: ["refLoot", "type", "id", "num", "weight", "condition"],
    handler: [],
    legacy: [],
  },
  upgrade: {
    fields: ["link_card_inst", "id", "name", "text", "cost", "condition", "icon", "link_card", "effect", "incompatible"],
    handler: [],
    legacy: [],
  },
  tag: {
    fields: ["is_composite", "id", "name", "code", "type", "text", "resource", "can_add", "can_visible", "can_inherit", "can_nagative_and_zero", "tag_sfx", "tag_rank", "attributes"],
    handler: ["tips", "fail_tag", "tag_vanishing"],
    legacy: [],
  },
  init: {
    fields: ["id", "name", "wizard", "show_deadline", "show_story", "show_ithink", "show_prestige", "show_helpbtn", "sudan_box_show_after_wizard", "disable_auto_gen_sudan_card", "sudan_pool", "sudan_card_desc", "sudan_pool_desc", "sudan_shuffle", "sudan_redraw_count", "sudan_redraw_times_per_round", "sudan_redraw_times_recovery_round", "default_cards", "card_equips", "default_rite", "default_event", "single_dice_face_weight", "think_id", "think_show_settlement", "gold_dice_count", "back_to_prev_round_count", "sudan_life_time", "difficulty"],
    handler: ["cards"],
    legacy: [],
  },
  quest: {
    fields: ["isComplete", "isReceived", "id", "name", "text", "icon", "favour_text", "upgrade_point", "target"],
    handler: ["pre"],
    legacy: [],
  },
  over: {
    fields: ["id", "name", "sub_name", "text_extra", "open_after_story", "text", "manual_prompt", "success", "comment", "bg", "icon", "title"],
    handler: [],
    legacy: [],
  },
  riteTemplate: {
    fields: ["id", "name", "tips", "bg", "fg", "fg_in_slot_index", "nomal_slot_bg", "bg_pos", "mobile_bg_pos", "mobile_scale", "title_pos", "title_bg_hide", "title_help_btn_hide", "slots"],
    handler: [],
    legacy: [],
  },
  riteMapping: {
    fields: ["id", "tips", "template_id", "slot_open"],
    handler: [],
    legacy: [],
  },
};

/** node kind for a directory-style config path */
const DIR_KIND = new Map([
  ["config/event", "event"],
  ["config/rite", "rite"],
  ["config/loot", "loot"],
  ["config/init", "init"],
  ["config/rite_template", "riteTemplate"],
]);

/** node kind for a table-style config path */
const TABLE_KIND = new Map([
  ["config/cards.json", "card"],
  ["config/upgrade.json", "upgrade"],
  ["config/tag.json", "tag"],
  ["config/quest.json", "quest"],
  ["config/over.json", "over"],
  ["config/rite_template_mappings.json", "riteMapping"],
]);

/**
 * settlement and settlement_prior stop at the first branch whose condition holds, so an
 * unconditional branch must be last. In vanilla, 358 such arrays put it last and none earlier.
 */
function checkDeadBranches(fileRel, arrName, list) {
  if (!Array.isArray(list) || list.length < 2) return;
  list.forEach((item, i) => {
    if (!isPlainObject(item) || i === list.length - 1) return;
    const c = item.condition;
    const empty = c === undefined || c === null || (isPlainObject(c) && Object.keys(c).length === 0);
    if (empty)
      fail(
        "DEAD_BRANCH",
        fileRel,
        `${arrName}[${i}] has an empty condition but is not the last branch. ${arrName} stops at the first match, so every branch after it never runs.`,
      );
  });
}

/** Return the keys of `obj` that the given node kind does not declare. */
function splitKeys(kind, obj) {  const spec = NODE_FIELDS[kind];
  if (!spec || !isPlainObject(obj)) return { fail: [], legacy: [] };
  const ok = new Set([...spec.fields, ...spec.handler]);
  const legacy = new Set(spec.legacy);
  const bad = [];
  const old = [];
  for (const key of Object.keys(obj)) {
    if (ok.has(key)) continue;
    if (legacy.has(key)) old.push(key);
    else bad.push(key);
  }
  return { fail: bad, legacy: old };
}

/** Report unknown and legacy keys for one object. */
function reportFields(fileRel, kind, obj, where) {
  const { fail: bad, legacy } = splitKeys(kind, obj);
  const at = where ? ` (at ${where})` : "";
  if (bad.length) {
    const known = NODE_FIELDS[kind].fields;
    fail(
      "UNKNOWN_FIELD",
      fileRel,
      `${bad.map((k) => JSON.stringify(k)).join(", ")}${at} is not a ${kind} key, so the game never reads it. Known keys: ${known.join(", ")}.`,
    );
  }
  if (legacy.length) {
    warn(
      "LEGACY_FIELD",
      fileRel,
      `${legacy.map((k) => JSON.stringify(k)).join(", ")}${at} appears in vanilla but no field backs it, so it does nothing.`,
    );
  }
}

// ---------------------------------------------------------------------------
// JSONC parser. The game accepts //, /* */, trailing commas and a BOM.
// We accept the same, but report duplicates because duplicate keys are a
// semantic feature here (they mean "append") and authors must know.
// ---------------------------------------------------------------------------

class JsoncError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, col ${col})`);
    this.line = line;
    this.col = col;
  }
}

/**
 * Subtree names where a repeated key means "append another entry" and is the
 * documented authoring idiom. A repeat anywhere else is almost always a typo.
 */
const LIST_CONTEXT = new Set([
  "condition",
  "open_conditions",
  "action",
  "result",
  "success",
  "failed",
  "case",
  "pops",
  "settlement",
  "settlement_prior",
  "settlement_extre",
  "waiting_round_end_action",
  "post_rite",
]);

export function parseJsonc(text) {
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const dups = [];
  const valPath = [];

  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const where = () => {
    let l = 1;
    let start = 0;
    for (let k = 0; k < i && k < text.length; k++) {
      if (text[k] === "\n") {
        l++;
        start = k + 1;
      }
    }
    return { line: l, col: i - start + 1 };
  };
  const fail = (msg) => {
    const w = where();
    throw new JsoncError(msg, w.line, w.col);
  };

  function skip() {
    for (;;) {
      const c = text[i];
      if (c === undefined) return;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        i += 2;
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        if (i >= text.length) fail("unterminated block comment");
        i += 2;
        continue;
      }
      return;
    }
  }

  function parseString() {
    if (text[i] !== '"') fail("expected string");
    i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) fail("unterminated string");
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\n") fail("newline inside string");
      if (c === "\\") {
        const e = text[i + 1];
        i += 2;
        if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "/") out += "/";
        else if (e === "\\") out += "\\";
        else if (e === '"') out += '"';
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else fail(`bad escape \\${e}`);
        continue;
      }
      out += c;
      i++;
    }
  }

  function parseValue() {
    skip();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) fail("bad number");
      i += m[0].length;
      return Number(m[0]);
    }
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    fail(`unexpected character ${JSON.stringify(c)}`);
  }

  function parseArray() {
    i++;
    const out = [];
    for (;;) {
      skip();
      if (text[i] === "]") {
        i++;
        return out;
      }
      out.push(parseValue());
      skip();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      fail("expected , or ] in array");
    }
  }

  function parseObject() {
    i++;
    const out = Object.create(null);
    const seen = new Set();
    for (;;) {
      skip();
      if (text[i] === "}") {
        i++;
        return out;
      }
      if (text[i] !== '"') fail("expected property name");
      const key = parseString();
      if (seen.has(key)) dups.push({ path: valPath.concat(key).join("."), key, inList: valPath.some((p) => LIST_CONTEXT.has(p)) });
      seen.add(key);
      skip();
      if (text[i] !== ":") fail(`expected : after property ${JSON.stringify(key)}`);
      i++;
      valPath.push(key);
      const v = parseValue();
      valPath.pop();
      // Duplicate keys accumulate into an array; that is what the game does too.
      if (seen.has(key) && out[key] !== undefined) {
        if (Array.isArray(out[key]) && out[key].__dup) out[key].push(v);
        else out[key] = Object.assign([out[key], v], { __dup: true });
      } else {
        out[key] = v;
      }
      skip();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      fail("expected , or } in object");
    }
  }

  const value = parseValue();
  skip();
  if (i < text.length) fail("trailing content after value");
  return { value, dups };
}

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------

const results = [];

/** Timing keys the engine registers. A key not here is never scheduled. */
const TIMING_KEYS = new Set([
  "round_begin_ba", "rite_end", "card_clean", "counter", "game_end", "rite_start",
  "card_born", "close_wizard", "close_begin_guide", "sudan_redraw_start", "rite_cancel",
  "open_rite", "open_rite_end", "open_card_info", "open_card_info_end", "close_prompt",
  "show_wizard_option", "rite_can_start", "rite_can_fill", "rite_can_stop",
  "back_to_prev_round_end", "round_begin_fr", "round_end", "rite_begin", "rite_clean",
  "rite_settlement", "card_dead", "back_to_round_begin", "global_counter",
]);
const rel = (mount, p) => p;
function add(level, code, file, message, extra) {
  results.push({ level, code, file, message, ...(extra ? { extra } : {}) });
}
const fail = (code, file, message, extra) => add("FAIL", code, file, message, extra);
const warn = (code, file, message, extra) => add("WARN", code, file, message, extra);
const info = (code, file, message, extra) => add("INFO", code, file, message, extra);

function readText(file) {
  return readFileSync(file, "utf8");
}

/**
 * Collapse duplicate-key findings into one line per (file, severity). Reporting
 * every repeat is unusable: vanilla-shaped conditions repeat keys hundreds of
 * times by design.
 */
function reportDups(fileRel, dups) {
  if (!dups.length) return;
  const odd = dups.filter((d) => !d.inList);
  const keys = [...new Set(odd.map((d) => d.key))];
  if (odd.length) {
    warn(
      "DUPLICATE_KEY",
      fileRel,
      `${odd.length} repeated key(s) outside a list context: ${keys.slice(0, 6).map((k) => JSON.stringify(k)).join(", ")}${
        keys.length > 6 ? `, +${keys.length - 6} more` : ""
      }. A repeat here is a typo; inside condition/action it appends.`,
    );
  } else {
    info("DUPLICATE_KEY_LIST", fileRel, `${dups.length} repeated key(s), all inside condition/action (append semantics).`);
  }
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === ".preview" || name.startsWith("._")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

/** Byte length, which is what the game measures for info.json limits. */
const byteLen = (s) => Buffer.byteLength(s, "utf8");
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

// ---------------------------------------------------------------------------
// Vanilla index (for collision + reference checks)
// ---------------------------------------------------------------------------

/** Join a `config/...` relative path onto the vanilla config directory. */
function vanillaPath(configDir, relPath) {
  return path.join(configDir, relPath.replace(/^config[\/\\]/, ""));
}

function loadVanilla(configDir) {
  const dir = configDir.replace(/^~/, os.homedir());
  if (!existsSync(dir)) return { dir: null, ids: new Map(), tags: new Set(), sprites: null };
  const ids = new Map();
  const tags = new Set();
  const put = (kind, id) => {
    if (!ids.has(kind)) ids.set(kind, new Set());
    ids.get(kind).add(String(id));
  };

  for (const [relPath, kind] of ID_TABLES) {
    const full = vanillaPath(dir, relPath);
    if (!existsSync(full)) continue;
    try {
      const { value } = parseJsonc(readText(full));
      for (const key of Object.keys(value)) {
        put(kind, key);
        // A card's `tag` map is keyed by the tag's display name, not its code string.
        if (kind === "tag" && value[key] && typeof value[key].name === "string") tags.add(value[key].name);
      }
    } catch (e) {
      warn("VANILLA_PARSE", relPath, `could not parse vanilla file: ${e.message}`);
    }
  }
  for (const [relPath, spec] of DIR_STYLE) {
    const full = vanillaPath(dir, relPath);
    if (!existsSync(full)) continue;
    const kind = relPath.split("/").pop();
    for (const name of readdirSync(full)) {
      if (spec.ext && !name.endsWith(spec.ext)) continue;
      if (spec.filename === "id") put(kind, name.slice(0, -spec.ext.length));
    }
  }
  return { dir, ids, tags, sprites: null };
}

// ---------------------------------------------------------------------------
// Mod lint
// ---------------------------------------------------------------------------

function lintMod(modDir, vanilla, opts) {
  const label = path.basename(modDir);
  const before = results.length;

  // ---- info.json -----------------------------------------------------------
  const infoPath = path.join(modDir, "info.json");
  let meta = null;
  if (!existsSync(infoPath)) {
    fail("INFO_MISSING", "info.json", "info.json is required at the mod root.");
  } else {
    try {
      const { value, dups } = parseJsonc(readText(infoPath));
      meta = value;
      reportDups("info.json", dups);
    } catch (e) {
      fail("INFO_PARSE", "info.json", `not parseable: ${e.message}`);
    }
  }
  if (meta) {
    if (typeof meta.name !== "string" || !meta.name.trim()) fail("INFO_NAME", "info.json", "name is required.");
    else if (byteLen(meta.name) > 128) fail("INFO_NAME_LEN", "info.json", `name is ${byteLen(meta.name)} bytes, limit is 128.`);
    if (meta.description !== undefined) {
      if (typeof meta.description !== "string") fail("INFO_DESC", "info.json", "description must be a string.");
      else if (byteLen(meta.description) > 8000)
        fail("INFO_DESC_LEN", "info.json", `description is ${byteLen(meta.description)} bytes, limit is 8000.`);
    }
    if (meta.tags !== undefined) {
      if (!Array.isArray(meta.tags)) fail("INFO_TAGS", "info.json", "tags must be an array of strings.");
      else {
        for (const t of meta.tags) {
          if (typeof t !== "string") fail("INFO_TAGS", "info.json", "every tag must be a string.");
          else if (!isAscii(t))
            warn("INFO_TAGS_ASCII", "info.json", `tag ${JSON.stringify(t)} is not ASCII; the game only matches ASCII tags.`);
        }
      }
    }
    if (meta.enable_reassign_id !== undefined && typeof meta.enable_reassign_id !== "boolean")
      fail("INFO_REASSIGN", "info.json", "enable_reassign_id must be a boolean.");
  }

  // ---- unknown top-level entries ------------------------------------------
  for (const name of readdirSync(modDir)) {
    if (name.startsWith(".") || name.startsWith("._")) continue;
    if (MOD_ROOT_ENTRIES.has(name)) continue;
    if (name === "preview.jpeg") {
      warn("PREVIEW_EXT", name, "use preview.png or preview.jpg. The game globs preview.*, but jpeg is untested.");
      continue;
    }
    info("UNUSED_ENTRY", name, "the game ignores this entry at the mod root.");
  }

  // ---- config tree --------------------------------------------------------
  const configDir = path.join(modDir, "config");
  const found = new Map(); // relPath -> kind
  if (existsSync(configDir)) {
    for (const name of readdirSync(configDir)) {
      const relPath = `config/${name}`;
      const spec = MODDABLE.get(relPath);
      if (!spec) {
        const stem = name.replace(/\.[^.]+$/, "");
        const hint = MODDABLE.has(`config/${stem}`) ? ` There is a directory-style entry config/${stem}/; a file here is ignored.`
          : " Not in the moddable set.";
        warn("CONFIG_UNKNOWN", relPath, `the game does not read this from a mod.${hint}`);
        continue;
      }
      found.set(relPath, spec);
      const full = path.join(configDir, name);
      const st = statSync(full);
      if (spec === "dir" && !st.isDirectory()) fail("CONFIG_SHAPE", relPath, "expected a directory.");
      if (spec !== "dir" && st.isDirectory()) fail("CONFIG_SHAPE", relPath, "expected a file.");
    }
  }

  // ---- per-file parse + shape + id checks ---------------------------------
  const modIds = new Map();
  const put = (kind, id) => {
    if (!modIds.has(kind)) modIds.set(kind, new Map());
    const m = modIds.get(kind);
    if (m.has(String(id))) m.get(String(id)).push(null);
    else m.set(String(id), [null]);
  };

  for (const [relPath, spec] of found) {
    const full = path.join(modDir, relPath);
    if (spec === "dir") {
      const dspec = DIR_STYLE.get(relPath);
      if (!dspec) continue;
      for (const name of readdirSync(full)) {
        if (!name.endsWith(dspec.ext)) {
          warn("DIR_STRAY_FILE", `${relPath}/${name}`, `only ${dspec.ext} files are read here.`);
          continue;
        }
        const fileRel = `${relPath}/${name}`;
        const fileFull = path.join(full, name);
        let value;
        try {
          const parsed = parseJsonc(readText(fileFull));
          value = parsed.value;
          reportDups(fileRel, parsed.dups);
        } catch (e) {
          fail("JSON_PARSE", fileRel, `not parseable: ${e.message}`);
          continue;
        }
        if (typeof value !== "object" || value === null) {
          fail("JSON_SHAPE", fileRel, "expected a JSON object.");
          continue;
        }
        const kind = relPath.split("/").pop().replace(/s$/, "");
        const id = value.id;
        const needsId = dspec.filename !== null;
        if (id === undefined && needsId) {
          fail("ID_MISSING", fileRel, 'the object has no "id" field.');
        } else if (id !== undefined) {
          put(kind, id);
          if (dspec.filename === "id") {
            const stem = name.slice(0, -dspec.ext.length);
            if (String(stem) !== String(id)) {
              const msg = `filename is ${stem} but id is ${id}. Vanilla and every working mod keep them equal.`;
              if (dspec.strict)
                fail("ID_FILENAME", fileRel, `${msg} The game builds this path from the id, so this file is not loaded.`);
              else warn("ID_FILENAME", fileRel, msg);
            }
          }
        }
        if (value.condition !== undefined && !isPlainObject(value.condition) && !Array.isArray(value.condition))
          fail("CONDITION_SHAPE", fileRel, "condition must be an object or an array.");
        if (relPath === "config/rite" && value.cards_slot !== undefined) {
          const slots = Object.keys(value.cards_slot || {});
          for (const s of slots) {
            if (!/^s\d+$/.test(s)) warn("SLOT_NAME", fileRel, `slot ${JSON.stringify(s)} is not of the form s1..sN.`);
          }
        }

        // Field dictionary: a key the node class does not declare is not read.
        const dirKind = DIR_KIND.get(relPath);
        if (dirKind) reportFields(fileRel, dirKind, value);

        // Timing keys are registered by name; anything else never fires.
        if (isPlainObject(value.on)) {
          for (const t of Object.keys(value.on)) {
            if (!TIMING_KEYS.has(t))
              fail(
                "UNKNOWN_TIMING",
                fileRel,
                `on.${JSON.stringify(t)} is not a timing key, so this event never triggers on it. 29 keys exist; the common ones are round_begin_ba, rite_end, card_clean, counter, game_end, rite_start.`,
              );
          }
        }
        if (relPath === "config/rite") {
          for (const [sName, sVal] of Object.entries(value.cards_slot || {})) {
            if (isPlainObject(sVal)) reportFields(fileRel, "slot", sVal, `cards_slot.${sName}`);
          }
          for (const arr of ["settlement_prior", "settlement", "settlement_extre", "waiting_round_end_action"]) {
            const list = value[arr];
            if (!Array.isArray(list)) continue;
            list.forEach((item, i) => {
              if (isPlainObject(item)) reportFields(fileRel, "settlement", item, `${arr}[${i}]`);
            });
          }
          // settlement and settlement_prior stop at the first branch whose condition holds.
          // In every one of the 1498 shipped rites, an empty-condition branch is the last one.
          // An empty condition anywhere else makes every later branch dead.
          for (const arr of ["settlement_prior", "settlement"]) {
            if (Array.isArray(value[arr])) checkDeadBranches(fileRel, arr, value[arr]);
          }
        }
        if (relPath === "config/event" && Array.isArray(value.settlement)) {
          checkDeadBranches(fileRel, "settlement", value.settlement);
        }
        if (relPath === "config/loot" && Array.isArray(value.item)) {
          value.item.forEach((item, i) => {
            if (isPlainObject(item)) reportFields(fileRel, "lootItem", item, `item[${i}]`);
          });
        }
      }
    } else if (spec === "table") {
      let value;
      try {
        const parsed = parseJsonc(readText(full));
        value = parsed.value;
        reportDups(relPath, parsed.dups);
      } catch (e) {
        fail("JSON_PARSE", relPath, `not parseable: ${e.message}`);
        continue;
      }
      if (!isPlainObject(value)) {
        fail("JSON_SHAPE", relPath, "expected a JSON object keyed by id.");
        continue;
      }
      const kind = ID_TABLES.get(relPath);
      const tblKind = TABLE_KIND.get(relPath);
      // tag.json is keyed by the tag code string, and sfx_npc_role_dub.json maps
      // an id to a string array. Neither is an object-per-key table.
      const looseShape = relPath === "config/sfx_npc_role_dub.json" || relPath === "config/sfx_settle_card_new.json";
      const keyIsId = relPath !== "config/tag.json";
      for (const key of Object.keys(value)) {
        const rec = value[key];
        if (looseShape && (Array.isArray(rec) || typeof rec === "string")) continue;
        if (!isPlainObject(rec)) {
          fail("JSON_SHAPE", relPath, `entry ${JSON.stringify(key)} is not an object.`);
          continue;
        }
        if (tblKind) reportFields(relPath, tblKind, rec, String(key));
        if (kind) put(kind, key);
        if (keyIsId && rec.id !== undefined && String(rec.id) !== String(key))
          warn("ID_MISMATCH", relPath, `key ${key} but entry id is ${rec.id}. The game keys by the object key; keep them equal.`);
        if (relPath === "config/cards.json") {
          if (!rec.type) warn("CARD_TYPE", relPath, `card ${key} has no "type" (char | item | sudan).`);
          else if (!["char", "item", "sudan"].includes(rec.type))
            fail("CARD_TYPE", relPath, `card ${key} has type ${JSON.stringify(rec.type)}; expected char, item or sudan.`);
          if (rec.rare !== undefined && !(rec.rare >= 1 && rec.rare <= 4))
            fail("CARD_RARE", relPath, `card ${key} rare=${rec.rare}; expected 1..4.`);
          if (rec.resource !== undefined) {
            const list = Array.isArray(rec.resource) ? rec.resource : [rec.resource];
            for (const r of list) {
              if (typeof r !== "string") fail("CARD_RESOURCE", relPath, `card ${key} resource must be a string or array of strings.`);
              else if (!/^(cards|sudan_big)\//.test(r))
                warn("CARD_RESOURCE_PREFIX", relPath, `card ${key} resource ${JSON.stringify(r)} does not start with cards/ or sudan_big/. Vanilla has no other prefix.`);
            }
          }
          if (Array.isArray(rec.destroy_resources) && rec.destroy_resources.length && rec.type !== "sudan")
            warn(
              "CARD_DESTROY_RES",
              relPath,
              `card ${key} is type ${JSON.stringify(rec.type)} but has destroy_resources; only the 20 vanilla sudan cards use it, always with 7 sudan_big/ sprites.`,
            );
          // `equips` entries are equipment-slot tag names, and repeats are meaningful.
          if (Array.isArray(rec.equips) && vanilla.tags.size) {
            for (const e of rec.equips) {
              if (typeof e !== "string") fail("CARD_EQUIPS", relPath, `card ${key} equips must be an array of tag names.`);
              else if (!vanilla.tags.has(e))
                warn("EQUIP_UNKNOWN", relPath, `card ${key} equips entry ${JSON.stringify(e)} is not a tag name; vanilla only uses 武器, 服装, 饰品, 驯兽.`);
            }
          }
          if (rec.tag !== undefined) {
            if (!isPlainObject(rec.tag)) fail("CARD_TAG", relPath, `card ${key} tag must be an object of name -> number.`);
            else if (vanilla.tags.size) {
              for (const t of Object.keys(rec.tag)) {
                if (PSEUDO_TAG_NAMES.has(t)) continue;
                if (!vanilla.tags.has(t))
                  warn("TAG_UNKNOWN", relPath, `card ${key} uses tag ${JSON.stringify(t)}, which is not a tag name in vanilla tag.json. Card tag keys are the tag's display name, not its code string. Add it to config/tag.json or fix the name.`);
              }
            }
          }
        }
        if (relPath === "config/upgrade.json") {
          if (rec.cost === undefined) warn("UPGRADE_COST", relPath, `upgrade ${key} has no cost.`);
          if (rec.link_card === undefined) warn("UPGRADE_LINK", relPath, `upgrade ${key} has no link_card; the shop shows no thumbnail.`);
        }
      }
    } else {
      // single object
      try {
        const parsed = parseJsonc(readText(full));
        reportDups(relPath, parsed.dups);
        if (!isPlainObject(parsed.value)) fail("JSON_SHAPE", relPath, "expected a JSON object.");
      } catch (e) {
        fail("JSON_PARSE", relPath, `not parseable: ${e.message}`);
      }
    }
  }

  // ---- id collisions ------------------------------------------------------
  for (const [kind, ids] of modIds) {
    const van = vanilla.ids.get(kind) || new Set();
    for (const id of ids.keys()) {
      if (van.has(id)) {
        // Overriding a vanilla id is legal, but for a NEW record it is almost always a mistake.
        warn("ID_OVERRIDES_VANILLA", `config/${kind}`, `${kind} id ${id} already exists in vanilla. This replaces it, it does not add a new one.`);
      }
    }
  }

  // ---- images ------------------------------------------------------------
  const imageDir = path.join(modDir, "image");
  const sprites = new Set();
  if (existsSync(imageDir)) {
    for (const rel of walk(imageDir)) {
      const ext = path.extname(rel).toLowerCase();
      if (ext !== ".png") {
        warn("IMAGE_EXT", `image/${rel}`, "only .png is read from image/. This file is ignored.");
        continue;
      }
      sprites.add(rel.slice(0, -4).split(path.sep).join("/"));
    }
    for (const rel of walk(imageDir)) {
      if (path.dirname(rel) === "." && path.basename(path.dirname(rel)) !== "head") {
        // image/<file>.png at the top level becomes sprite "<file>"; legal but unusual.
      }
    }
  }
  // Every card resource must resolve to a vanilla sprite or one of ours.
  const cardsPath = path.join(modDir, "config/cards.json");
  if (existsSync(cardsPath)) {
    try {
      const { value } = parseJsonc(readText(cardsPath));
      for (const key of Object.keys(value)) {
        const rec = value[key];
        const list = rec.resource === undefined ? [] : Array.isArray(rec.resource) ? rec.resource : [rec.resource];
        for (const r of list) {
          if (typeof r !== "string") continue;
          const own = sprites.has(r);
          if (!own && !r.startsWith("cards/") && !r.startsWith("tag_"))
            warn("SPRITE_UNKNOWN", "config/cards.json", `card ${key} resource ${JSON.stringify(r)} does not look like a sprite name (cards/..., tag_...).`);
          else if (!own)
            info("SPRITE_VANILLA", "config/cards.json", `card ${key} reuses sprite ${JSON.stringify(r)}. Ship image/${r}.png to override it.`);
        }
      }
    } catch {
      /* already reported */
    }
  }

  // ---- bgm ---------------------------------------------------------------
  const bgmDir = path.join(modDir, "bgm");
  if (existsSync(bgmDir)) {
    for (const rel of walk(bgmDir)) {
      const ext = path.extname(rel).toLowerCase();
      if (![".wav", ".mp3", ".ogg"].includes(ext)) {
        warn("BGM_EXT", `bgm/${rel}`, "the game reads only .wav, .mp3 and .ogg here. This file is ignored.");
        continue;
      }
      if (rel.includes(path.sep)) warn("BGM_NESTED", `bgm/${rel}`, "bgm files are keyed by bare filename; subdirectories are surprising.");
    }
  }

  // ---- preview -----------------------------------------------------------
  const hasPreview = ["preview.png", "preview.jpg"].some((n) => existsSync(path.join(modDir, n)));
  if (!hasPreview) info("PREVIEW_MISSING", null, "no preview.png or preview.jpg. The Workshop page will have no thumbnail.");

  return { label, added: results.length - before };
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, vanilla: null, modDir: null, modRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--vanilla") out.vanilla = argv[++i];
    else if (a === "--mod-root") out.modRoot = argv[++i];
    else if (!a.startsWith("-") && !out.modDir) out.modDir = a;
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.modDir && !args.modRoot) {
    process.stderr.write("usage: node tools/lint.mjs <modDir> | --mod-root <dir> [--vanilla <configDir>] [--json]\n");
    process.exit(2);
  }
  const vanilla = loadVanilla(args.vanilla || DEFAULT_VANILLA);
  if (!vanilla.dir) warn("VANILLA_MISSING", null, "vanilla config not found; id collision and tag checks are skipped. Pass --vanilla.");

  const mods = [];
  if (args.modRoot) {
    const root = args.modRoot.replace(/^~/, os.homedir());
    if (!existsSync(root)) {
      process.stderr.write(`no such mod root: ${root}\n`);
      process.exit(2);
    }
    for (const name of readdirSync(root)) {
      const full = path.join(root, name);
      if (!statSync(full).isDirectory()) continue;
      if (!existsSync(path.join(full, "info.json"))) continue;
      mods.push(full);
    }
    if (!mods.length) info("NO_MODS", null, `no mod with info.json under ${root}`);
  } else {
    mods.push(args.modDir.replace(/^~/, os.homedir()));
  }

  for (const m of mods) lintMod(m, vanilla, args);

  // Cross-mod collisions.
  if (args.modRoot) {
    const owner = new Map();
    for (const m of mods) {
      const label = path.basename(m);
      const cards = path.join(m, "config/cards.json");
      if (!existsSync(cards)) continue;
      try {
        const { value } = parseJsonc(readText(cards));
        for (const key of Object.keys(value)) {
          const k = `card:${key}`;
          if (owner.has(k)) fail("ID_CROSS_MOD", "config/cards.json", `card id ${key} is defined by both ${owner.get(k)} and ${label}.`);
          else owner.set(k, label);
        }
      } catch {
        /* reported per-mod */
      }
    }
  }

  const counts = { FAIL: 0, WARN: 0, INFO: 0 };
  for (const r of results) counts[r.level]++;

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: counts.FAIL === 0, counts, results }, null, 2) + "\n");
  } else {
    const order = { FAIL: 0, WARN: 1, INFO: 2 };
    const esc = (s) => String(s).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    for (const r of results.sort((a, b) => order[a.level] - order[b.level])) {
      process.stdout.write(`${r.level.padEnd(4)}  ${(r.file || "-").padEnd(34)}  ${r.code.padEnd(20)}  ${esc(r.message)}\n`);
    }
    process.stdout.write(`\n${counts.FAIL} fail, ${counts.WARN} warn, ${counts.INFO} info\n`);
    process.stdout.write(counts.FAIL === 0 ? "RESULT: PASS\n" : "RESULT: FAIL\n");
  }
  process.exit(counts.FAIL === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("lint.mjs")) main();
