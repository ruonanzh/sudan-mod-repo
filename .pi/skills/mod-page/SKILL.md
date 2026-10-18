---
name: mod-page
description: >
  Write a mod page: one self-contained HTML file under the mod directory's `.preview/` that shows what
  a mod changes, which values it sets, and which choices are still open. The player comments on the
  page in the app, and you revise from the comments. Read it before you answer with options, a scope,
  or a value to agree on, and before you describe what a mod does. The answer is a page, not a long
  reply.
---

# The mod page

Part of the Sultan's Game mod workspace. If you have not read `mod-creator`, read it first.

A mod page is one HTML file the player reads. It shows what the mod changes, which values it sets, and
which choices are still open. The player comments on the page and you revise.

## When to write a page

Write a page. Do not put the options in a long reply and ask.

Write a page when any of these is true:

- You and the player must agree on a scope or a value before you write the mod.
- The player asks what the mod does, or what changed.
- The result needs numbers, options, or a comparison.
- The player says the work is thin, vague, or incomplete.

A plain reply is enough when the answer fits in one short paragraph.

## Where the page goes

`your_mods/<ModName>/.preview/<topic>.modpage.html`

- The name must end in `.modpage.html`. Another name opens in the plain viewer, without commenting.
- `.preview/` is not part of the mod. It is git-ignored and must not be installed into the game.

## What a page must be

- **One file.** Put styles and images inside it. The player may open it with no network.
- **The game, not the files.** Write what changes in the game. Do not list the files you edited.
  For this game that means naming the card, the rite, the event, the number.
- **Images inside the file.** An image must be a data URI.
- **Real controls for a choice.** Use `<input type="checkbox">`, `<input type="radio">` or `<select>`
  with a `name`. A drawn box such as `☐` cannot be clicked, and the panel saves a named control's
  value with the comments.
- **Room to write.** When the page asks for a sentence or more, use a `<textarea>` about four rows
  tall. A one-line field is for a value, not for a thought.
- **No page script.** The panel reads the file and injects the markup, so a `<script>` in the page
  does not run. To show the effect of a selection, use CSS only, for example `:checked + label` or
  `:has()`.

## Card data belongs in a table

When the page proposes a card, show the fields as a table with the value you propose and the vanilla
value beside it. The fields that matter to a player are `name`, `title`, `text`, `type`, `rare` and
the `tag` numbers. Show the tag numbers as a small table of tag name to integer, because the numbers
are the balance and the player has opinions about them.

## Rite and story data belongs in a branch list

When the page proposes a rite or an event, show the trigger, the condition, and each settlement branch
as its own row with its condition and its outcome. The player needs to see which branch fires first.
That ordering is the design, not a detail.

## Style

The page should read as part of the game, not as a document. The game's interface is deep warm brown
with parchment panels, gold rules and engraved ornament.

Do not invent colour values. Take them from the game's own screenshots: ask the player for one
screenshot of a card, a rite board and the mod panel, and sample the ground, the panel, the rule and
the text colour from those. Invented hex values look almost right and read as foreign.

Use a serif for headings and a system sans for body. Keep the measure narrow; the panel is not
full width.

## After the player comments

Read the feedback block from the page, change the mod, and revise the page. Do not argue with a
comment inside the page. Answer it by changing the value or by adding a row that shows the
consequence.
