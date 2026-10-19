---
name: mod-creator
description: >
  The reference for writing and changing Sultan's Game(苏丹的游戏) mods. Read it first, before you search the
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

When the change needs an image, also load `card-art`. When the player must agree on a scope or a
value, the answer is a page: load `mod-page`. After writing, `mod-installer` puts it in the game and
reads the log back.

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
    "start_trigger": true,          // event_on checks the condition at once
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
- **Where those field lists come from.** `inspect_game_code` reads the dump: `action=search` finds a type or member in `dump.cs`, `action=type` prints its fields with offsets, properties and signatures, `action=body member=<name>` prints that method's ISIL and disassembly, and `action=strings` searches string literals. The dump is `~/.gamer-agent-pi/decompiled/sudan-mod-repo/` and covers the game's eight assemblies; add one in `decompile.json`, then run `action=dump assembly=<name>`. Field offsets are decimal (`[r14+40]` is `0x28`); disassembly offsets are hex (`+58h` is `88`). This repository ships data only, so read the dump to confirm a key or a type, not to write code.
- `EventNode` has no `auto_start`, even though 1520 vanilla event files carry one. It does nothing.
  `auto_start_init` is the real field.
- `auto_start_init` is a list of `init` config ids. `config/init/1.json` is the normal run, so
  `[1]` means "on from the start of a normal game". An event that is in no `auto_start_init` list and
  is never named by another event's `event_on` does not run. A brand-new event that must run every
  round needs `"auto_start_init": [1]`.

- **Timing keys.** There are exactly 29, and a key outside that set is never scheduled. Do not
  memorise them and do not trust a list in any document: read
  [`schema/SCHEMA.md`](../../../schema/SCHEMA.md) section Timings, or run
  `node tools/lint.mjs <modDir>` and let `UNKNOWN_TIMING` tell you. A number means "every round";
  `[lo, hi]` means a random round in that range. Eight of the 29 are registered by the engine but
  never written by vanilla; SCHEMA.md marks which ones.
- **Condition keys** carry their operator: `counter.7000017<=`, `rare<`, `r1:体魄`, `hand_have.<id>`,
  `table_have.<id>`, `have.<id>`, `cost.<id>`, `is`, `type`, `any`, `all`, `!` for negation, and
  `s1`..`sN` to scope to a rite slot. The full grammar, with the shapes vanilla actually uses, is the
  Conditions section of [`schema/SCHEMA.md`](../../../schema/SCHEMA.md).
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

Three settlement arrays exist. What each does with multiple branches:

| array | behaviour |
|---|---|
| `settlement_prior` | first branch whose condition holds; the whole `settlement` array is then skipped |
| `settlement` | first branch whose condition holds |
| `settlement_extre` | every element, in order; it does not test conditions |

The shipped data agrees, and the decompiled loop settles it: `GetPriorSettlement` and
`GetNormalSettlement` each return one element, and `DoExtraSettlement` copies every element into
the queue without calling its condition.

The wiki documents it field by field. The shipped data agrees, and it is the data that makes this
usable as a rule:

- In all 1498 rites, an empty `condition` (`{}` or absent) inside `settlement` or `settlement_prior`
  is the **last** branch, 69 out of 69 times, never earlier. An unconditional branch placed earlier
  would make everything after it dead, so no author ever wrote one.
- In `settlement_extre`, empty conditions appear at every index including index 0 and index 165, 216
  of them. Position does not matter there, which is what "all matches run" looks like.

So: put the unconditional branch **last** in `settlement_prior` and `settlement`, and anywhere in
`settlement_extre`. `node tools/lint.mjs` reports `DEAD_BRANCH` when you get this wrong.

`is_empty` picks a hint, and it is not a rule:

| value | meaning |
|---|---|
| `0` | the empty slot shows the "cannot be empty" hint |
| `1` | the empty slot shows the "may stay empty" hint |

`CardSlotController.Init` reads it at `slot+0x28`, and all it does is choose **which sprite set** the
slot's `tips_icon` names are looked up in — one set for each value, nothing else. `CheckConfirm()`
walks the placed cards with `CanPutCard` without reading it, so the engine does not refuse to start
a rite because a slot marked `0` is empty. To require a card, write the requirement in the
settlement condition instead: `"s3": 1` requires it, `"!s3": 1` requires it to be empty.

The 0/1 polarity in that table comes from **vanilla's own comments**, not from code: `"is_empty":0,
// 不能为空` appears 53 times and `"is_empty":1, //可以为空` / `// 可以为空` 10 times. The icons
themselves are in the game's assets, so nothing in the config or the code names them. One more trap:
`is_empty` is a line inside a bigger object, so a search for `is_empty:1` tells you nothing about
whether that *rite* is optional. Read the whole slot.

### The rest of a rite's fields

| field | meaning |
|---|---|
| `once_new` | the "new" badge: `1` = new only the first time it appears (`player.only_rites` remembers it), `0` = every time, `-1` = never |
| `location` | a map pin label, `place:number` or `place:[a,b]`. Only the text before the colon is read, as a name — **nothing parses the number**, so it is not a round. Vanilla has 89 distinct values for 1498 rites; 590 of them share `自宅:[2,12]` |
| `open_conditions` | **all of them must hold.** Each entry is `{condition, tips}`, and the rite title bar prints the `tips` of every unmet entry, so write the tip as the reason it cannot open ("匪帮调动中，无法进行训练") — that is the sentence the player reads |
| `is_enemy` (slot) | `1` = the slot counts for the enemy side; dice and battle rites split their cards by it |

**Reuse a vanilla `location` string; do not invent one.** `GetLocationName` splits on `:` and looks
only the part before it up as a translation key, then the map looks the whole string up in a
`SerializableDictionary<string, Vector2>` for the pin position. A made-up name misses both. The ten
groups vanilla uses, with every number each one carries:

| group | values seen |
|---|---|
| 自宅 | `1` `2` `10` `14` `[1,12]` `[2,6]` `[2,10]` `[2,12]` `[2,14]` `[3,12]` `[4,12]` |
| 上城区 | `3` `[1,6]` `[1,12]` `[2,10]` `[3,12]` `[7,12]` |
| 商业区 | `1` `2` `3` `6` `7` `8` `9` `20` `[4,5]` `[7,10]` `[10,19]` |
| 宫廷 | `1` `2` `7` `[2,6]` `[2,10]` `[7,10]` |
| 神殿区 | `11` `[2,10]` |
| 野外 | `8` `9` `[1,6]` `[1,14]` `[2,14]` `[9,10]` `[9,14]` `[12,14]` |
| 黑街 | `1` `10` `[1,5]` `[1,9]` `[2,5]` `[2,9]` |
| 奇珍 | `1` through `15`, one at a time |
| 结局 | `1` through `20`, one at a time |
| 大敌 | `1` `2` `3` `6` |

Dead fields — the game never reads them, so do not copy them into a new rite:
`is_key` (0 in all 5406 vanilla slots) and `final_pin` (12 rites, only the serializer touches it).

`restore_fill_times` is **not** dead, just unused in vanilla: `RitePanelShowController.OnLastState`
reads it (`+0x4C`), clamps it to `1..10`, and uses the result to refill slots when a rite panel
closes. No vanilla rite sets it, so every one of them gets the clamp floor of 1.

## Triggers, timeouts and the order things settle

`start_trigger` is about registration, not about `round_begin_ba`:

- `event_on` calls `Add(id, true)`. If the event's `start_trigger` is also true, the condition is
  evaluated immediately against `player.round`, and a passing condition runs the settlement at once.
- Loading a save calls `Add(e, false)`. `start_trigger: true` therefore does nothing at load: the
  event waits for its next timing. A probe confirmed this. An event with `start_trigger: true` and
  `round_begin_ba: 1` opened nothing until the next round began.
- `auto_start_init: [1]` is what registers an event at all. It is a set of `init/<n>.json` ids,
  compared with `player.configId`, not a delay. `[1]` is the normal run; `[0]` is the guided prologue.
- `round_begin_ba: x` is a period measured from activation. The game stores
  `timing_rounds[eventId*100+index] = round + x` and re-arms after each fire. `[min,max]` is
  max-exclusive (`Random.Range`), so `[3,5]` means 3 or 4.

`delay` is separate: `"delay": {"round": 5, ...}` fires the next thing after 5 rounds, and
`round: 1` means the next round. A round is one in-game day.

Rite timing fields:

| field | meaning |
|---|---|
| `round_number` | how many rounds the rite itself takes. `0` settles immediately |
| `waiting_round` | how long it may sit on the map. `0` means no limit |
| `waiting_round_end_action` | what happens on timeout |
| `auto_begin` | `1` starts the rite automatically. It overrides the timeout |
| `open_adsorb` | `1` makes the slot pull matching cards in by itself |

Daily settlement runs in this order: countdown ticks, then each card's own `vanish`, then rites in
ascending id order, then the used card's `post_rite`. Absorption follows ascending rite id too. So a
lower id competes harder for a card, which is why a card can get stuck in an early rite and never
reach a later one.

## Condition helpers that are easy to confuse

| key | means |
|---|---|
| `have.<filter>` | a card is alive |
| `table_have.<filter>` | a card is on the table and free |
| `hand_have.<filter>` | a card is in hand |

`rite_template` and `rite_template_mappings` control where the slots sit on screen. If you do not ship
them, the game falls back to a normal template and logs
`load rite panel {0} failed, rite_template invalid`. That is a Warning, not a failure, so a rite works
without them and just looks generic.

## Loot tables, quests, endings and after-story

Four more things a mod can ship. Only the fields below are read; anything else is ignored.

### Loot tables — `config/loot/<id>.json`, one file per table

```jsonc
{
    "id": 6000004,
    "name": "情报掉落",
    "repeat": 1,
    "type": 2,
    "item": [ { "type": "card", "id": 2000032, "num": "1", "weight": 60 } ]
}
```

`type` is a constant, not free text — the engine compares it to four values:

| `type` | what it draws |
|---|---|
| `2` | normal: one weighted pick per draw |
| `3` | only-new: one pick per draw, and each draw re-excludes what you already got |
| `4` | choose M of N: `repeat` entries are picked from the table |
| `99` | package: the whole table is granted, `repeat` times |

`repeat` is how many draws happen. In vanilla, 188 tables use `1`; the rest use 3, 6 or 13.

Each `item` is `{type, id, num, weight, condition}`. `type` is `card`, `event`, `rite` or `loot`
(a table inside a table). `weight` is relative — only the ratios matter. `num` is how many are
granted, and writes as a string in vanilla (`"1"`). `condition` filters the item the same way every
other condition does.

Vanilla counts: 193 tables, 1280 items (870 card, 215 event, 171 rite, 24 loot).

Two warnings on the item object. `refLoot` is an **ignored key** — the loader registers only
`type`, `id`, `num`, `weight` and `condition`, and no vanilla item carries it; nest a table with
`"type": "loot"` instead. And `condition` is parsed but never evaluated: `SimpleWeightLoot`,
`WeightedNChooseM`, `RealGenCard` and `Generate` build a `ConditionContext` and none of them calls
`IsSatisfied`. Do not try to gate a drop with it — split the table or gate the settlement instead.

### Quests — `config/quest.json`, one table keyed by id

```jsonc
"3300001": { "id": 3300001, "name": "坠落的初端", "text": "...", "favour_text": "...",
             "upgrade_point": 1, "icon": "cards/2000001",
             "target": [ { "text": "完成1局苏丹的游戏", "show_counter": "",
                           "condition": { "global_counter.7220001>=": 1 } } ] }
```

What the loader actually registers: `id`, `name`, `text`, `icon`, `favour_text`, `upgrade_point`,
`target`. Anything else in the object is dropped.

- `target[]` is what must hold. `condition` is a normal condition, `text` is the line the player
  reads (it goes through `FormatStringVariable`, so `{变量}` works), `show_counter` names a counter
  to print beside it — empty means none, decided by `String.IsNullOrEmpty` in
  `StoryTargetItemController.Init`. All 193 vanilla targets carry a condition.
- `isComplete` (on both the quest and the target) is save-side state, and drives the tick sprite.
  Do not write it. `target.value` is registered too but no vanilla target sets it.
- `upgrade_point` is what the quest is worth; the completion notification prints it (1 each across
  the 161 vanilla quests).
- **`pre` does nothing.** It is all over `quest.json` (161 values, each another quest id), but the
  string `pre` does not exist in `global-metadata.dat` at all, so the loader has no key to match —
  the same dead-key situation as `auto_start` on events. Do not build a quest chain on it.

### Endings — `config/over.json`, one table keyed by id

The loader registers all twelve fields, so nothing here is dead: `id`, `name`, `sub_name`,
`text_extra`, `open_after_story`, `text`, `manual_prompt`, `success`, `comment`, `bg`, `icon`,
`title`.

- `name`, `sub_name`, `text`, `bg`, `icon`, `title`, `manual_prompt`, `comment` are display.
  `comment` is registered but no vanilla ending uses it.
- `open_after_story: 1` makes the ending continue into the after-story. `OverNewStep2StoryController`
  takes it as `Action<bool> hasAfterStory`, so it decides that jump (108 of 159 in vanilla).
- `success` decides which title the record screen uses (`OverNodeController`): `0` shows
  `DeadTitle`, anything else shows `SuccessTitle`, and `2` additionally switches `VictoryIcon` on.
  So write `0` for a failure ending, `1` for a win, `2` for a win with the victory icon.
  Vanilla: 63 are `1`, 46 are `2`, 4 are `0`, 46 leave it out.
- `text_extra` is a `RiteNode.Settlement[]` — the same branch struct a rite uses, so it is
  first-match with a `condition`, not a list of paragraphs.

### After-story — `config/after_story/<characterCardId>.json`

One file per character card; the id is the **card** id, not a new id range (66 in vanilla: 61
characters + 5 items).

- `pic` is the picture shown, `close_condition` decides when the panel closes.
- `prior` and `extra` are **`RiteNode.Settlement[]`**, exactly the shape a rite's branches use:
  `{condition, result_text, pic, result, action, sort}`. Nothing new to learn, and the same rule
  applies — `sort` decides the order, and a missing `sort` counts as `10`.
- The save keeps `prior` as a string key and `extra` as a set, so the same config can be reused by
  several runs.

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
