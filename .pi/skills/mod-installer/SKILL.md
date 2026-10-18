---
name: mod-installer
description: >
  Put a Sultan's Game mod into the game and confirm the game read it. Covers the mod root path on
  macOS and Windows, why a copied folder is not yet an enabled mod, how to read the per-mod log, and
  how to update or remove a mod. Read it when the player wants the mod in the game, says they cannot
  see it, or after you finish writing one.
---

# Install a mod

Part of the Sultan's Game mod workspace. If you have not read `mod-creator`, read it first.

## The mod root

```
macOS    ~/DoubleCross/SultansGame/Mod/
Windows  %USERPROFILE%\Documents\DoubleCross\SultansGame\Mod\
```

The game derives it from `GetFolderPath(MyDocuments)` joined with the company name, `"SultansGame"`
and `"Mod"`. On macOS `MyDocuments` is the home directory; on Windows it is `Documents`. That is the
whole difference between the two paths, so do not reason from one to the other.

If the player cannot find the folder, the in-game mod panel has a button that opens it. The button
creates the folder when it is missing, so "the folder did not exist" is not a reason to look elsewhere.

## Install

Copy `your_mods/<ModName>/` to `<ModRoot>/<ModName>/`. Copy, do not move: the repo copy is the source.

The folder name and `info.json` `name` are independent. The folder name is what appears in paths; the
`name` field is what the panel shows.

## A copied folder is not an enabled mod

The player must open the mod panel and enable it. The panel is reached from the title screen. Enabling
writes the game's own `mods.json`, which you never touch.

Two consequences worth saying out loud:

- When two mods supply the same config path, the one enabled **last** wins. There is no load order
  field and no dependency field.
- A mod that changes a vanilla record replaces the whole file. If the player disables it, vanilla
  comes back. If the game later patches that vanilla file, the mod silently keeps serving its old copy.

## Update

Overwrite the folder, then tell the player to refresh the mod list. A mod that removed files needs the
stale files deleted by hand; the game does not prune a mod folder.

## Remove

Delete the folder. Then have the player refresh. If the mod is still enabled in the panel, the game
logs that it is missing and skips it.

## Confirm that the game read it

Read the log. Do not ask the player whether it worked when the log can answer.

```
~/DoubleCross/SultansGame/ModLog/__mod.log               global
~/DoubleCross/SultansGame/ModLog/<mod name>_local.log    one per mod
```

What to look for:

| line | meaning |
|---|---|
| `read mod <name> file: config/cards.json` | the game read that file |
| `mod <name> file not exists: config/event` | that entry is absent. **Warning, not an error** |
| `mod <name> info.json loaded` | metadata accepted |
| `mod <name> info.json invalid` | fix `info.json` before anything else |
| `unknown how to read operation` | a key you invented is not an operation |
| `can not create operation instance` | an operation key exists but its argument is the wrong shape |
| `is not png, ignored` | something in `image/` is not a PNG |
| `is not wav, mp3, ogg, ignored` | something in `bgm/` has the wrong extension |

A mod that supplies one file logs about eighteen `file not exists` warnings. That is expected and is
not a fault. Report the `read` lines as the evidence, not the warnings.

## What the log cannot tell you

The log proves the game loaded your data. It does not prove the change is visible. Card art, layout,
and whether a rite is reachable all need the player's eyes. Say what the log showed, then ask what
they see.
