# Sultan's Game mod workspace

**Sultan's Game** (苏丹的游戏, DoubleCross, Steam `3117820`). Mods are **data**: JSONC files plus
PNG images and audio clips. There is no compilation, no scripting host, and no plugin API.
Windows and macOS run the same mod package.

This repo is the modding environment for this game. The player and the agent both use it.

## Environment facts

These are fixed. They prevent wasted turns.

- **The mod root is outside this repo.**
  macOS: `~/DoubleCross/SultansGame/Mod/`
  Windows: `%USERPROFILE%\Documents\DoubleCross\SultansGame\Mod\`
  The game derives it as `Path.Combine(GetFolderPath(MyDocuments), Application.companyName, "SultansGame", "Mod")`.
  `MyDocuments` is `$HOME` on macOS and `Documents` on Windows. That is the only difference.
  Work in `your_mods/`. Install is a copy into the mod root, and the player must then enable the mod
  in the in-game panel. Do not assume that dropping a folder in loads it.

- **The game's own log is the fastest diagnosis.**
  `~/DoubleCross/SultansGame/ModLog/__mod.log` holds global messages and
  `~/DoubleCross/SultansGame/ModLog/<mod name>_local.log` holds one mod's messages. The loader writes
  `read mod <name> file: config/...` for every file it reads and
  `mod <name> file not exists: config/...` for every file it looks for and misses. A missing file is
  a **Warning**, not an error. Read the log before you guess.

- **Never hand-write `mods.json`.** That file is the game's own record of which mods are enabled.
  The game writes it. A mod does not need it, and a mod with a wrong one is worse than no mod.

- **A mod supplies data only.** No `.dll`, no `.cs`, no script, no AssetBundle. If a desired change
  cannot be expressed with the data keys below, it cannot be done, and you say so instead of
  inventing a code route. One popular mod ships a `code/` folder full of Python; the game never
  reads it.

- **Prefer `node` for scripts.** The product ships its own node. `tools/lint.mjs` is dependency-free.

## Directory map

- `AGENTS.md` — this file: the fixed facts and the boundaries.
- `.pi/skills/` — the step guidance. Read the matching skill, each describes its own trigger.
  - `mod-creator` — the reference: mod layout, `info.json`, which config entries a mod may supply,
    merge semantics, JSONC rules, card and event/rite authoring with working examples.
  - `mod-installer` — copy a mod into the mod root, enable it, and confirm from the log.
  - `card-art` — the image contract: sizes, names, and what a sprite replaces.
  - `mod-page` — write the HTML page that shows the player what a mod changes and collects their marks.
- `schema/` — the single source of truth, and the only place a field rule lives.
  `fields.json` holds every node shape, `vocab.json` the timing/condition/operation
  vocabulary, `save-fields.json` the save shapes, and `SCHEMA.md` is generated from
  those three by `tools/gen-schema-doc.mjs`. Never edit `SCHEMA.md` by hand.
- `tools/lint.mjs` — the validator. Run it before you install. It reads `schema/`.
  `--save <file|dir>` validates save files instead of a mod.
- `your_mods/` — the mod output area. Write mods only here, as `your_mods/<ModName>/`.
- `mod-repo.json` — the machine-readable game and path declaration.
- `reference/` — reserved. Not populated in this version.

## Hard boundaries

1. **Changing one vanilla record means restating that whole file.** `config/event/<id>.json`,
   `config/rite/<id>.json`, `config/loot/<id>.json` and the other directory-style entries are one
   record per file, replaced whole. `config/cards.json` and the other table-style entries merge by
   key, so you ship only the records you add or change.
   When you restate a vanilla file, also record in the mod page which fields you actually changed.
   The next game patch will move the vanilla file, and a reader must be able to re-apply your intent.

2. **Every new id is your responsibility.** There is no registry and the game does not warn.
   Two published Workshop mods already collide on card id `9000001`. Before you pick an id, check
   vanilla and every mod already installed. `tools/lint.mjs --mod-root <ModRoot>` checks both.

3. **Do not reformat a config file you did not author.** A repeated key is meaningful here: it
   appends. `"event_on"` written eighty times adds eighty events. Any parse-and-reserialise round
   trip silently destroys that, so edit as text and keep the repeats.

4. **Do not run a strict JSON formatter.** The game accepts `//`, `/* */`, trailing commas and a BOM,
   and vanilla itself uses all of them.

## Verify before you report

Nothing here can compile, so a claim of "done" needs evidence of these three things:

1. `node tools/lint.mjs your_mods/<ModName>` exits 0. Vanilla does not: the shipped data has
   one file with dead settlement branches and two operations that point at ids which do not
   exist. `schema/SCHEMA.md` lists them, so a failure there is not your bug.
2. The mod is installed and the player enabled it. Its `_local.log` shows
   `read mod <name> file: config/<what you changed>`.
3. The change shows in the game. Read the log for the card or rite id the player touched.

A clean lint plus a clean log does not prove the change is visible in the game. Ask the player what
they see, and do not fill that gap with confidence.
