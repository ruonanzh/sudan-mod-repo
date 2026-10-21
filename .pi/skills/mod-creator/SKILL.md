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

## Creating the folder

The folder is created by a tool, not by `mkdir`: `create_mod_folder(name=...)` makes
`your_mods/<name>/` and binds the session to it. It is also the write-isolation boundary — the
guard only allows writes inside the bound directory — so do not create the directory another way.

- `name` is lowercase snake_case: `a-z`, `0-9`, `_`, starts with a letter, at most 40 characters
  (`broken_blade`, not `Broken Blade`). It is the folder name, not the panel name: the display
  name is `info.json`'s `name`.
- It creates no source files. Write `info.json` yourself (next section).
- Failures and what to do:

| output | action |
|---|---|
| `EXISTING: This session is already bound to <path>` | already bound; keep using it, do not create a second one |
| `INVALID_MOD_NAME: ...` | fix the name and call again |
| `MOD_NAME_TAKEN: <name> already exists` | the folder is taken; pick another name |
| `MOD_DIRECTORY_MISSING` / `UNAVAILABLE` | the bound folder is gone or unreadable. Ask the player to restore it, or start a new session; do not bind a second directory |
| `HELPER_READ_ONLY` | Game Helper sessions cannot create a mod; switch to a mod-development session |

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
        "type": "item",
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
| `pops` | declared as `string[]` and **empty in all 1294 vanilla cards**. Legacy: an object here fails the conversion. Use `post_rite` for the pop-up behaviour |
| `equips` | equipment slots this card accepts, e.g. `["武器","服装","饰品"]` |
| `is_only` | whether only one copy may exist |
| `card_vanishing` / `vanish` | `card_vanishing` is rounds of life: each round pass adds 1, and once `life >= card_vanishing` the card is queued to vanish. `0` = never ages. `vanish` is the operation block run when the card is destroyed; `{}` in 1267 of 1294 vanilla cards |
| `post_rite` | optional settlement array. After a rite that involved this card settles, every branch whose `condition` holds appends its `result_text` and queues its `result`/`action`. Branches of cards equipped on it are collected too |

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
`link_card_inst` is **not** an authored key: the game synthesises that `Card` from `link_card`
(`PointShopController.InitUpgradeCards`), so writing it does nothing.

## An event

`config/event/<id>.json`. This is the whole language: `on` is when it triggers, `condition` is what
must hold, `settlement` is an array of branches with an `action`.

```jsonc
{
    "id": 5300029,
    "text": "书店营业",              // display only: nothing reads it
    "is_replay": 1,                 // may it trigger more than once
    "auto_start_init": [1],         // already enabled when init config 1 starts
    "start_trigger": true,          // unsettled; see the note below
    "on": { "round_begin_ba": 1 },  // timing; 1 means every round start
    "condition": {
        "!rite": 5002006,            // ! negates
        "counter.7000017<=": 43      // the comparison operator lives in the key
    },
    "settlement": [
        {
            "action": { "rite": 5002006 }
        }
    ]
}
```

Facts that decide whether the file works:

- **The field list per node type is in `schema/fields.json`**, which `tools/lint.mjs` loads as
  `NODE_FIELDS`. It was read out of the decompiled `*_JsonHandler` types and checked against every
  shipped file. A key that is not registered for that node is never read, so `node tools/lint.mjs`
  reports it as `UNKNOWN_FIELD`. The per-key evidence (reader index, field offset, corpus count) is in
  `docs/sudan-game/fields/21-handler-keys.md` in the planning repo.
- **Where those field lists come from.** `inspect_game_code` reads the dump: `action=search` finds a type or member in `dump.cs`, `action=type` prints its fields with offsets, properties and signatures, `action=body member=<name>` prints that method's ISIL and disassembly, and `action=strings` searches string literals. The dump is `~/.gamer-agent-pi/decompiled/sudan-mod-repo/` and covers the game's eight assemblies; add one in `.pi/lib/decompile.json`, then run `action=dump assembly=<name>`. Field offsets are decimal (`[r14+40]` is `0x28`); disassembly offsets are hex (`+58h` is `88`). This repository ships data only, so read the dump to confirm a key or a type, not to write code.
- `EventNode` has no `auto_start`, even though 1520 vanilla event files carry one. It does nothing.
  `auto_start_init` is the real field.
- `text` is authored on all 1867 vanilla events and **no code reads it** — it is not one of the seven
  registered keys. Treat it as a label for whoever opens the file.
- **An event branch has no `condition`.** `EventTrigger.DoSettlements` runs every branch in array
  order without testing one, and 0 of the 1869 vanilla branches carry the key. A `condition` you
  write there is silently ignored; branch selection belongs in `rite.settlement`.
- `tips_resource` and `tips_text` are written into 1813 event branches and are **not** keys of a
  settlement: `tips_resource` is not a string in the binary at all, and `tips_text` is a key of
  `rite`. Both are ignored.
- **An event branch shows no text of its own.** The settlement shape has `result_text`, but the event
  host never reads it: what the player sees comes from `action.prompt` (622 of the 1869 vanilla
  branches). Put the wording there.
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
  `table_have.<id>`, `have.<id>`, `cost.<tag>`, `is`, `type`, `any`, `all`, `!` for negation, and
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
    "auto_begin": 0,
    "auto_result": 0,
    "location": "神殿区:[2,10]",
    "icon": "rite_9",
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

Never write these keys: `method_settlement`, `tag_tips`, `mapping`, `random_effect`. Vanilla's own rite
files carry them, but none of the four is registered by a handler, so nothing reads them.

Three settlement arrays exist. What each does with multiple branches:

| array | behaviour |
|---|---|
| `settlement_prior` | first branch whose condition holds; the whole `settlement` array is then skipped |
| `settlement` | first branch whose condition holds |
| `settlement_extre` | every branch whose own `condition` holds, in array order. The condition sees the slot that produced the extra result, not `-1` |

The shipped data agrees, and the decompiled loops settle it: `GetPriorSettlement` and
`GetNormalSettlement` each return one element, and `DoExtraSettlement` walks all elements and lets
each one pass through its own condition test.

The wiki documents it field by field. The shipped data agrees, and it is the data that makes this
usable as a rule:

- In all 1498 rites, an empty `condition` (`{}` or absent) inside `settlement` or `settlement_prior`
  is the **last** branch, 69 out of 69 times, never earlier. An unconditional branch placed earlier
  would make everything after it dead, so no author ever wrote one.
- In `settlement_extre`, empty conditions appear at every index including index 0 and index 165, 216
  of them, and only 187 of those 341 are last. That is what a per-branch gate looks like: an entry
  with no condition always passes, and the entries after it are still tested on their own.

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
| `location` | where the pin goes: `place:slot` or `place:[lo,hi]`. **Both halves are parsed** — the area picks the map transform the pin is parented to, the slot or range picks the position inside it, and `MapController.SetRitesPosition` resolves collisions. 89 distinct values over 1498 rites, and 590 of them share `自宅:[2,12]`, so sharing a position is normal. A malformed range is a load-time error |
| `open_conditions` | **all of them must hold.** Each entry is `{condition, tips}`, and the rite title bar prints the `tips` of every unmet entry, so write the tip as the reason it cannot open ("匪帮调动中，无法进行训练") — that is the sentence the player reads |
| `is_enemy` (slot) | `1` keeps the slot out of the friendly tag tally: `RitePanelController.UpdateTagTipsValue` skips slots whose `is_enemy != 0` while it sums a tag chip. 740 of the 5406 vanilla slots set it |

**Reuse a vanilla `location` string; do not invent one.** The area token names an area of the game's
own map: `GameController.GetLocation` turns the string into a `RitePosition` and `AddRitePin` parents
the pin to that area's transform, and `RiteExtensions.GetLocationName` splits on `:` and localises the
area for display, falling back to the raw token. A made-up area therefore has neither a place on the
map nor a name. There are ten areas, and no eleventh is reachable from config. The ten groups vanilla
uses, with every slot value each one carries:

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

`final_pin: 1` is read, and it does one thing: when the rite settles, the game removes the rite and
then calls `PlayerExtensions.AddRitePin(player, rite.id)` — so the rite leaves a pin behind on the
player. `RiteResultPanelController.<Settlement>b__8` skips that when the value is not 1, and
`UpdateWaiting` reads the same field while the result panel waits. Twelve vanilla rites set it.

Dead field: `is_key` — `0` in all 5406 vanilla slots, and none of the twelve `+0x24` comparisons in
the whole build sits on a slot.

`restore_fill_times` is **not** dead, just unused in vanilla: `RitePanelShowController.OnLastState`
reads it (`+0x4C`), clamps it to `1..10`, and uses the result to refill slots when a rite panel
closes. No vanilla rite sets it, so every one of them gets the clamp floor of 1.

## Triggers, timeouts and the order things settle

**`start_trigger` is unsettled. Do not build a design on it.** `EventTrigger.Add(EventNode, bool
enable_start_trigger)` compares the event's field with the second argument and skips its immediate
settle path when they are equal. `event_on` passes `true`, a save load passes `false`. Read one way,
that means `event_on` settles at once when `start_trigger` is set and load does not; read the other
way it is the reverse, because `true` is the value that *differs* from the load's `false` and so takes
the settling branch. An earlier note in this file claimed a probe had confirmed the first reading;
that claim is withdrawn. What is settled: `auto_start_init` is what registers an event, and `on` is
what schedules it, so make a design work without `start_trigger` and only then decide whether to
write it.

- `auto_start_init: [1]` is what registers an event at all. It is a set of `init/<n>.json` ids,
  compared with `player.configId`, not a delay. `[1]` is the normal run; `[0]` is the guided prologue.
- `round_begin_ba: x` is a period measured from activation. `x` alone means every `x` rounds, and the
  next fire is seeded with `current + Random.Range(x, x)`; `[a,b]` seeds `current + Random.Range(a, b)`
  with `b` **exclusive**, so `[3,5]` means 3 or 4. `99999` is the idiom for "fire once, then never".

`delay` is separate: `"delay": {"id": 9001, "round": 5, ...}` runs its other operations 5 rounds
later, and `round: 1` means the next round. A round is one in-game day. `id` is the handle that
`delay_off` cancels, and a second `delay` with the same `id` overwrites the first schedule instead of
stacking.

Rite timing fields:

| field | meaning |
|---|---|
| `round_number` | ticks from start to automatic settlement: `life >= round_number`, and `life` is incremented first, so `0` and `1` both settle on the first tick. `0` also hides the remaining-rounds counter on the pin. Vanilla runs 0–8 |
| `waiting_round` | patience in ticks while the rite sits on the map unstarted. `0` means no limit |
| `waiting_round_end_action` | the settlements fired when that patience runs out and the rite is removed |
| `auto_begin` | `1` makes the round tick start the rite without player input |
| `open_adsorb` (slot) | `1` makes the slot a candidate for auto-filling from the player's pool when the rite opens (`RiteExtensions.AdsorbCards` skips every slot whose value is 0). `0` is 3349 of the 5406 vanilla slots, and those are filled only by the player |

Daily settlement runs in this order: countdown ticks, then each card's own `vanish`, then rites in
ascending id order, then the used card's `post_rite`. Absorption follows ascending rite id too. So a
lower id competes harder for a card, which is why a card can get stuck in an early rite and never
reach a later one.

## Condition helpers that are easy to confuse

| key | means |
|---|---|
| `have.<filter>` | a card is alive, anywhere in play |
| `table_have.<filter>` | a card is on the table and free |
| `hand_have.<filter>` | a card is in hand. A card counts as held when it carries the `own`, `adherent` or `player` tag (`CardExtensions.IsHandCard`, literals `0x33796C8` / `0x3374D00` / `0x3379970`) |

The filter is a 7-digit card id and/or a tag name, either may be left out, and the comparator sits on
the end of the key: `have.2000005.幽秘的爱意<`. `!` or `~` in front negates the whole thing.

`rite_template` and `rite_template_mappings` control where the slots sit on screen. A rite reaches
them through its own `mapping_id`: that row supplies the panel `template_id` and the slot keys the
panel may open, and 1421 of the 1422 vanilla ids resolve. If you do not ship the template, the game
falls back to a normal template and logs
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

| `type` | what it draws | vanilla |
|---|---|---|
| `2` | one weighted pick per draw | 125 |
| `3` | one weighted pick per draw, after removing the entries the player already owns | 55 |
| `4` | `repeat` **weighted** picks without replacement: `repeat` is the `m` in "choose m of n", and the algorithm runs once, not `repeat` times | 2 |
| `99` | every eligible entry, weights ignored, `repeat` times | 11 |

`repeat` is how many independent draws happen — except under `type: 4`, where it is `m`. In vanilla 188
tables use `1`; the rest use 3, 6 or 13.

Each `item` is `{type, id, num, weight, condition}`. `type` is `card`, `event`, `rite` or `loot`
(a table inside a table). `weight` is relative — only the ratios matter, and `SimpleWeightLoot` really does draw with
`Random.Range` after summing them. `num` is how many are
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
  Do not write it.
- `upgrade_point` is what the quest is worth; the completion notification prints it (1 each across
  the 161 vanilla quests).
- `target.value` is a number **printed into the target line** (`StoryTargetItemController.Init` boxes
  it and appends it), never compared. No vanilla target sets it.
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
- `text_extra` is a `RiteNode.Settlement[]` and it is **read**: `OverNewStep2StoryController` prints
  the ending's own `text`, then walks `text_extra` (length at `+0x18`, each entry's `condition` at
  `+0x18` of the entry) and appends the passage of every branch whose condition holds. So write one
  branch per extra paragraph you want to be able to appear, each with its own condition.

### After-story — `config/after_story/<characterCardId>.json`

One file per character card; the id is the **card** id, not a new id range (66 in vanilla: 61
characters + 5 items).

- `pic` is the picture shown.
- `close_condition` **is** evaluated. The page loop calls `condition.IsSatisfied`, and a satisfied
  `close_condition` skips its page instead of rendering it. No vanilla file ships it live: 59 of the
  66 carry it **commented out** with the same body, `{ "!s1": 1 }`.
- `prior` and `extra` are **`RiteNode.Settlement[]`**, the same branch shape a rite uses:
  `{condition, result_text, pic, result, action, key, sort}`. They are not alternatives to each other
  and not two halves of one list: `prior` has **precedence**.
- `prior` is the single opening passage. The game walks it first, takes the first branch that passes,
  runs its `result` then its `action`, and **returns**, so `extra` is never read. All 66 vanilla files
  declare it as `[]`; writing one turns the whole epilogue into that one passage.
- `extra` is the epilogue itself, and **every branch that passes becomes a page**, in array order. A
  pass means: a branch with a `key` must match the save's `after_story_key` (a branch without a key
  skips that test), its `condition` must hold, and it must not leave both `result_title` and
  `result_text` empty. So a card with 385 branches renders as a 385-page carousel gated by world
  state, not as one page chosen from 385. All 7750 vanilla branches carry a key such as
  `2000001_extra_1`; write one. `key` also feeds `Datapool.SetOverId`, which is what the page text
  and the previous/next buttons resolve against.
- `sort` sits on the branch but its consumer is not located, so do not rely on it to order pages:
  the array order is what you can see and control.
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
