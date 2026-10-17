---
name: mod-creator
description: >
  The reference for writing and changing Sultan's Game mods. Read it first, before you search the
  vanilla config, before you write your first file, and before you answer what a mod can do. Covers
  the mod layout, info.json, the exact set of config entries a mod may supply, merge-by-key versus
  whole-file replacement, the JSONC rules, authoring a card and an event or rite with working
  examples, and the verified facts about ids and sprites. Sultan's Game mods are data only. There is
  no compile step and no code.
---

# Writing Sultan's Game mods

A mod is a folder of JSONC and PNG. Nothing compiles. Nothing runs.

## What you must load before writing

The vanilla data is the only complete description of the format, and it is annotated. Read the file
you intend to change before you change it:

```
macOS    ~/Library/Application Support/Steam/steamapps/common/Sultan's Game/Sultan's Game.app/Contents/Resources/Data/StreamingAssets/config/
Windows  <steam>\\steamapps\\common\\Sultan's Game\\Sultan's Game_Data\\StreamingAssets\\config\\
```

The devs left Chinese `//` comments in these files that explain each field. `config/event/5300000.json`
is the tutorial opening and documents `confirm`, `option`, `success` and `failed` in place, with both
the short and the long form side by side. It is the single best example file.

## Mod layout

```
<ModName>/
  info.json          required
  preview.png|jpg    optional Workshop thumbnail; the game globs "preview.*", size is not enforced
  config/            data, mirrors StreamingAssets/config/
  image/             sprites, walked recursively
  bgm/               audio, walked
```

The game discovers a mod by scanning `MOD_ROOT` for subdirectories that contain `info.json`. There is
no registration file. Write mods only under `your_mods/<ModName>/` in this repo.

## info.json

```jsonc
{
    "name": "Short name for the mod panel",
    "description": "One or two sentences.",
    "tags": ["Utilities"],
    "version": "1.0.0"
}
```

| field | type | rule |
|---|---|---|
| `name` | string | required, at most 128 bytes |
| `description` | string | at most 8000 bytes, `\n` allowed |
| `tags` | string[] | ASCII only; the game matches ASCII tags and ignores others |
| `version` | string | present but unused by the game |
| `enable_reassign_id` | bool | optional, opt in to the game's mod id reassignment |

## What a mod may supply, and nothing else

This list is exact. The loader logs `file not exists` for each entry a mod omits, so the set is
readable from the log of any mod.

```
config/game.json          config/tag.json            config/cards.json
config/init               config/over.json           config/rite
config/event              config/loot                config/dt
config/after_story        config/wizard              config/upgrade.json
config/quest.json         config/rite_template       config/rite_template_mappings.json
config/sfx_config.json    config/over_music_config.json
config/sfx_npc_role_dub.json                         config/sfx_settle_card_new.json
```

These are **not** moddable even though the game reads them for itself. If the player asks for a change
here, say it cannot be done as a mod:

`achievement.json` `credits.json` `gallery_cards.json` `gallery_cg.json` `imagestyle.json`
`mobile_help.json` `textstyle.json` `ui.json` `variable.json` `rite.json`

A mod may ship exactly one of the entries above. Shipping one file is normal and correct.

## Two merge behaviours, and how to tell them apart

- **Table entries merge by key.** `cards.json`, `upgrade.json`, `tag.json`, `quest.json`, `over.json`,
  `rite_template_mappings.json` and the `sfx_*` files are dictionaries. Put only the records you add
  or change. Vanilla keeps the rest.
  `tag.json` is keyed by the tag **code string**, not by `id`.

- **Directory entries are one record per file.** `event/`, `rite/`, `loot/`, `init/`, `rite_template/`,
  `after_story/`, `dt/`, `wizard/`. Adding a record means adding a file. Changing a vanilla record
  means restating that whole file, because there is no field-level merge.

Inside a directory entry, the filename must equal the `id`. For `rite` this is load-bearing: the game
builds the path from the id (the literal `rite/{0}.json`), so a mismatched name is not read at all.
The other directories behave the same way in every mod in the wild; treat a mismatch as a defect.

## JSONC rules

The game's reader accepts `//`, `/* */`, trailing commas and a BOM. Follow the same style as vanilla.

**A repeated key is not a mistake.** It appends:

```jsonc
"success": {
    "event_on": [5300300, 5300301],
    "event_on": 5300066
}
```

That adds three events. Never parse a config file and write it back with a JSON library, because a
dictionary keeps only the last value.

`settlement` arrays are the other place repeats appear, inside `result`.

## A card

`config/cards.json` is a dictionary keyed by card id. This is a complete, minimal new item card:

```jsonc
{
    "9000001": {
        "id": 9000001,
        "name": "流浪的佣兵团",
        "title": "军队",
        "text": "一支常年流浪在外但装备精良、训练有素的军队。",
        "pops": [],
        "card_favour": "",
        "type": "item",
        "tips": "",
        "rare": 4,
        "resource": ["cards/2000376"],
        "tag": { "体魄": 10, "战斗": 10, "部队": 1, "纯色材质": 1 },
        "card_vanishing": 0,
        "vanish": {},
        "equips": [],
        "is_only": 1
    }
}
```

Card fields:

| field | meaning |
|---|---|
| `id` | must equal the dictionary key |
| `name` | the card face name. **It is clipped at the card face width, so keep it short** |
| `title` | the subtitle line, e.g. 军队 |
| `text` | the rules or flavour text in the card detail view |
| `type` | `char`, `item`, or `sudan` |
| `rare` | 1 to 4. 1 stone, 2 copper, 3 silver, 4 gold |
| `resource` | sprite name, or an array of sprite names for multiple art variants |
| `tag` | a map of tag name to integer. Negative and zero are legal |
| `pops` | hover bubble text entries |
| `equips` | equipment slots this card accepts, e.g. `["武器","服装","饰品"]` |
| `is_only` | whether only one copy may exist |
| `card_vanishing` / `vanish` | expiry behaviour, usually `0` and `{}` |
| `post_rite` | optional settlement array that runs after use |

Card ids in vanilla run `2000001` to `2001351`. Community mods have used `17xxxxx`, `21xxxxx` to
`27xxxxx`, `2999999` and `9000xxx`. There is no reserved block and no registry, so check for
collisions and pick a value nothing else uses.

To make a card obtainable, add a `config/upgrade.json` entry. It is the destiny shop:

```jsonc
"3300095": {
    "id": 3300095,
    "name": "恶源镜面",
    "text": "全属性 +15。",
    "cost": 30,
    "condition": {},
    "icon": "gain",
    "link_card": 9000002,
    "effect": { "g.card": 9000002 },
    "incompatible": 0
}
```

`link_card` is what draws the shop thumbnail. `cost: 0` is legal and shows the item for free.

## An event

`config/event/<id>.json`. This is the whole language: `on` is when it triggers, `condition` is what
must hold, `settlement` is an array of branches with an `action`.

```jsonc
{
    "id": 5300029,
    "text": "书店营业",
    "is_replay": 1,                 // may it trigger more than once
    "auto_start_init": [1],         // already enabled when init config 1 starts
    "start_trigger": true,          // check conditions as soon as the run begins
    "on": { "round_begin_ba": 1 },  // timing; 1 means every round start
    "condition": {
        "!rite": 5002006,            // ! negates
        "counter.7000017<=": 43      // the comparison operator lives in the key
    },
    "settlement": [
        {
            "tips_resource": "",
            "tips_text": "",
            "action": { "rite": 5002006 }
        }
    ]
}
```

Facts that decide whether the file works:

- **The field list per node type is in `tools/lint.mjs`, in `NODE_FIELDS`.** It was read out of the
  decompiled types and checked against every shipped file: zero keys in the game's own 3365 event and
  rite files are missing from it. A key that is not listed for that node is never read, so
  `node tools/lint.mjs` reports it as `UNKNOWN_FIELD`. Trust that over any prose, including this file.
- `EventNode` has no `auto_start`, even though 1520 vanilla event files carry one. It does nothing.
  `auto_start_init` is the real field.
- `auto_start_init` is a list of `init` config ids. `config/init/1.json` is the normal run, so
  `[1]` means "on from the start of a normal game". An event that is in no `auto_start_init` list and
  is never named by another event's `event_on` does not run. A brand-new event that must run every
  round needs `"auto_start_init": [1]`.

- **Timing keys.** These are the ones that actually appear in the shipped data, so they are safe to
  use: `round_begin_ba`, `rite_start`, `rite_end`, `rite_cancel`, `card_born`, `card_clean`,
  `counter`, `game_end`, `open_rite`, `open_rite_end`, `open_card_info`, `open_card_info_end`,
  `rite_can_start`, `rite_can_fill`, `rite_can_stop`, `close_prompt`, `close_wizard`,
  `close_begin_guide`, `show_wizard_option`, `sudan_redraw_start`, `back_to_prev_round_end`.
  A number means "every round"; `[lo, hi]` means a random round in that range.
  The engine also has classes for `round_begin_fr`, `round_end`, `rite_open`, `rite_open_end`,
  `rite_settlement`, `rite_clean`, `card_dead`, `counter_changed`, `global_counter_changed` and a few
  more, but none of those keys appears anywhere in the shipped data. Their JSON spelling is
  **unverified**. A wrong key is logged as `unknown how to read timing`, so try one and read the log
  rather than assume.
- **Condition keys** carry their operator: `counter.7000017<=`, `rare<`, `r1:体魄`, `hand_have.<id>`,
  `table_have.<id>`, `have.<id>`, `cost.<id>`, `is`, `type`, `any`, `all`, `!` for negation, and
  `s1`..`sN` to scope to a rite slot.
- **Action keys** carry their argument: `rite`, `card`, `g.card`, `event_on`, `event_off`,
  `clean.self`, `clean.rite`, `clean.sN`, `counter+<id>`, `counter=<id>`, `global_counter+<id>`,
  `total.<id>+<tag>`, `pop.<shorthand>`, `loot`, `coin`, `table`, `choose`, `option`, `confirm`,
  `success`, `failed`, `case:op1`.., `delay`, `copy`, `sleep`, `focus`, `slide`, `rebirth.<slot>`,
  `over`, `steam_achievement`, `enable_auto_gen_sudan_card`, `begin_guide`, `close_story`,
  `change_name`, `change_card_name`, `change_card_text`, `change_desk_bg`, `change_location_icon`,
  `debug`, `no_show`, `no_prompt`.
- **`success` and `failed`** wrap branches after a `confirm`, an `option`, or a dice check. `case:opN`
  selects the branch for option N.
- Slot-scoped keys inside a rite use `s1`..`sN`. Dice checks use `r1`..`r5`.

## A rite

`config/rite/<id>.json`. A rite is the board where the player places cards.

```jsonc
{
    "id": 5006558,
    "name": "复原的神迹",
    "text": "把苏丹卡放进去。",
    "tips": "",
    "once_new": 0,
    "round_number": 1,
    "waiting_round": 0,
    "waiting_round_end_action": [],
    "method_settlement": "",
    "auto_begin": 0,
    "auto_result": 0,
    "location": "神殿区:[2,10]",
    "icon": "rite_9",
    "tag_tips": [],
    "tag_tips_up": {},
    "tips_text": ["可以重置苏丹卡的剩余时间"],
    "open_conditions": [],
    "random_text": {},
    "random_text_up": {},
    "settlement_prior": [],
    "settlement": [
        {
            "condition": {},
            "result_title": "净化的神迹中包含了复原",
            "result_text": "苏丹卡的时间被重置了。",
            "result": { "rebirth.s1": 0 },
            "action": {}
        }
    ],
    "settlement_extre": [],
    "cards_slot": {
        "s1": {
            "condition": { "type": "sudan" },
            "open_adsorb": 0,
            "is_key": 0,
            "is_empty": 0,
            "is_enemy": 0,
            "text": "放入苏丹卡",
            "pops": []
        }
    }
}
```

Three settlement arrays exist. What each does with multiple matching branches:

| array | behaviour |
|---|---|
| `settlement_prior` | the first branch whose condition holds runs, then the rite ends |
| `settlement` | the first branch whose condition holds runs |
| `settlement_extre` | every branch whose condition holds runs |

The middle row is observed everywhere in vanilla and is safe. **The two claims about "first match
only" versus "all matches" are community statements, not experiments.** If the player's design depends
on the difference, run the experiment before you promise the result.

`is_empty` is a known trap. The official guide says `1` means a card must be placed; vanilla writes
`"is_empty": 0, // 不能为空`, which means `0` is "may not be empty". The file comment is the one to
trust, but this is also worth an experiment before you rely on it.

`rite_template` and `rite_template_mappings` control where the slots sit on screen. If you do not ship
them, the game falls back to a normal template and logs
`load rite panel {0} failed, rite_template invalid`. That is a Warning, not a failure, so a rite works
without them and just looks generic.

## Verify

```
node tools/lint.mjs your_mods/<ModName>
```

Then install and enable it, and read
`~/DoubleCross/SultansGame/ModLog/<mod name>_local.log`. You want
`read mod <name> file: config/<file>` for each file you changed, and no
`mod <name> info.json invalid`.

Missing files are noise, not errors. A mod that supplies one file will log eighteen warnings and still
work.
