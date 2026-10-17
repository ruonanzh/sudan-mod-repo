---
name: card-art
description: >
  The image contract for Sultan's Game mod art. Covers the card face size, the sprite name rule, how
  a card points at its art, the head icon, and what a sprite does and does not replace. Read it
  before you generate or place any image, and before you promise the player a visual change.
---

# Card and character art

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
inside the Unity assets, so the practical source is the mods and screenshots the player already has.

## Audio

Same idea, different folder. `bgm/<clipName>.<ext>`, where the bare filename **is** the clip name.
Extensions `.wav`, `.mp3`, `.ogg`. The one published example replaces `start_game` with a
16-bit PCM 48 kHz stereo WAV. `ogg` is a fraction of the size and is accepted, so prefer it when the
file is large.

Clip names other than `start_game` are mostly unknown. `config/over_music_config.json` lists the ending
tracks (`over_game_dead`, `over_game_happiness`, and so on) and those are a different subsystem.

## Do not

- Do not put images anywhere except `image/`. A sprite must be reachable from `image/` or it does not
  exist to the game.
- Do not ship a `.jpg` or `.webp` in `image/`. Only `.png` is read, and the loader logs that it
  ignored the file.
- Do not rename a vanilla sprite to hide it. Override it by shipping a file at the same sprite name.
