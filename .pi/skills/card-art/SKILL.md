---
name: card-art
description: >
  The image contract for Sultan's Game mod art. Covers the card face size, the sprite name rule, how
  a card points at its art, the head icon, and what a sprite does and does not replace. Read it
  before you generate or place any image, and before you promise the player a visual change. Also
  covers where the reference art comes from, since it is not in this repo.
---

# Card and character art

Part of the Sultan's Game mod workspace. If you have not read `mod-creator`, read it first.

## The card face

| item | value |
|---|---|
| size | **472 x 1028** |
| format | PNG with alpha, RGBA |
| where | `image/cards/<name>.png` |
| sprite name | the path under `image/` without the extension: `cards/<name>` |
| how a card points at it | `"resource": ["cards/<name>"]`, or a bare string |

The name is arbitrary. Nothing requires it to match the card id, but matching the id is the local
convention and it makes a mod readable.

Reusing vanilla art is free. `"resource": "cards/2000439"` points at an existing sprite and the mod
ships no image at all. Do that when a new card is a variant of an existing one.

Multiple art variants: `"resource": ["cards/2100861", "cards/2100861_1", "cards/2100861_2"]` with
`image/cards/2100861.png`, `_1`, `_2` on disk.

## What a sprite replaces, and what it does not

`image/cards/<name>.png` replaces **only the inner picture**. Verified in game by putting a magenta
test pattern at 472x1028 behind a vanilla character card: the pattern filled the face, and the card
frame, the corner metal ornaments and the help button all stayed. So the artwork is a plain full-bleed
illustration. You do not build a nine-slice, you do not draw a border, and you do not leave a margin
for the frame.

Two limits that came out of the same test:

- **The card name is clipped at the card face width.** A long name loses its tail on the card. Keep
  names short and put the rest in `text`.
- The card face is 472x1028 and is drawn without letterboxing. A different aspect ratio distorts.

## The character head icon

`image/head/<cardId>.png`, 92x92 PNG RGBA. It is keyed by card id and **no config field references
it**, so the loader finds it by path.

This one is **not verified by experiment**. The file convention is observed in a published mod at
92x92, but the mechanism that binds it to a character is unconfirmed. If a head icon is what the
player is asking for, say it is untested and try it before you promise it.

## Matching the game's style

The game's art is a flat, engraved, warm-toned illustration with a limited palette and visible
linework. A render with soft gradients, bloom, or a cool palette will read as foreign on the board.
Pull two vanilla card images and look at them before you generate anything. Vanilla sprites are packed
inside the Unity assets, so they cannot ship in this repo: `reference/` is git-ignored, because the art
belongs to DoubleCross and the fonts are commercial.

`node tools/setup.mjs` extracts them from the player's own install, and `tools/page.mjs` runs it by
itself the first time the editor is opened, with a progress bar. It reads `gameDir` from
`.gamer-agent.local.json` when the app recorded one. Three groups come out: the four tier plates
(`reference/plates/card-*.png`), the card title font (`reference/fonts/`), and one reference card per
type and tier (`reference/cards/{char,item,sudan}-{1..4}.png`).

`node tools/art.mjs refs` reports whether all twelve reference cards are present. They are not
decoration: with them present, generation runs as image-to-image, which is what keeps the style close.

## Audio

Same idea, different folder. `bgm/<clipName>.<ext>`, where the bare filename **is** the clip name.
Extensions `.wav`, `.mp3`, `.ogg`. The one published example replaces `start_game` with a
16-bit PCM 48 kHz stereo WAV. `ogg` is a fraction of the size and is accepted, so prefer it when the
file is large.

**A mod can replace a music clip. It cannot add one.** The swap happens through
`SFxManager.ModifyAudio`, which finds a `ModAudioModifyer` component already sitting on an `AudioSource`
in the scene, reads its `audioName`, and asks the mod data for a clip with that name. A mod cannot add
that component, so there has to be a place in the game that already plays music for you to replace.

Two log lines tell you what happened:

| line | meaning |
|---|---|
| `mod modify key {0} {1} not found` | your filename matches no audio name in the game. Nothing plays |
| `modAudioModifyerMap already contains ` | two mods claim the same clip. One wins |

Clip names other than `start_game` are mostly unknown. `config/over_music_config.json` lists the ending
tracks (`over_game_dead`, `over_game_happiness`, and so on) and those are a different subsystem.
If the player wants a clip you cannot name, the honest move is to say that only replacement is
supported and to find the name together from the game's own files.

## Do not

- Do not put images anywhere except `image/`. A sprite must be reachable from `image/` or it does not
  exist to the game.
- Do not ship a `.jpg` or `.webp` in `image/`. Only `.png` is read, and the loader logs that it
  ignored the file.
- Do not rename a vanilla sprite to hide it. Override it by shipping a file at the same sprite name.
