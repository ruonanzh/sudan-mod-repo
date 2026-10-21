# 仪式

一个 mod 只是数据：JSONC 文件，加 PNG 与音频。没有编译步骤，也没有代码。仪式是这类记录里的一种：玩家把卡放进仪式的槽位，仪式按这些卡结算。

## 写一个仪式

### 一条记录一个文件

`config/rite/<id>.json`：一个文件就是一条记录。新增一条仪式，就是新增一个文件。

文件名必须等于 `id`。游戏用 id 拼路径（字面量 `rite/{0}.json`），名字对不上的文件根本不会被读。

改一条原版仪式要整文件重述。目录式条目没有字段级合并，游戏用整个文件替换原版那一份。整文件重述时，把实际改了哪几个字段单独记下来：下一次游戏更新会挪动原版文件，后来的人要照着重新应用这些改动。

每一条新 id 都是你的责任。这里没有注册表，游戏也不会警告某个 id 撞了。挑 id 之前先查原版，再查每一个已装的 mod；`node tools/lint.mjs --mod-root <ModRoot>` 把这两处都查一遍。创意工坊已经有两个已发布的 mod 在卡 id `9000001` 上撞车。

写完之后跑 `node tools/lint.mjs your_mods/<ModName>`。退出码为 0 才算这条记录通过校验。

### mod 能提供什么

这份清单是完整的。mod 少给哪一项，加载器就为哪一项写一行 `file not exists`，所以任何一个 mod 的日志里都能读出这个集合。

```text
config/game.json          config/tag.json            config/cards.json
config/init               config/over.json           config/rite
config/event              config/loot                config/dt
config/after_story        config/wizard              config/upgrade.json
config/quest.json         config/rite_template       config/rite_template_mappings.json
config/sfx_config.json    config/over_music_config.json
config/sfx_npc_role_dub.json                         config/sfx_settle_card_new.json
```

一个 mod 只交一份 `config/rite/<id>.json` 很正常，也是对的。

注意：游戏自己也读 `variable.json`、`ui.json` 这一类文件，但这些文件**不可 mod**。玩家要求改这些文件时，直接说作为 mod 做不到。不可 mod 的清单是 `achievement.json`、`credits.json`、`gallery_cards.json`、`gallery_cg.json`、`imagestyle.json`、`mobile_help.json`、`textstyle.json`、`ui.json`、`variable.json`。

### JSONC 规则

游戏的读取器接受 `//`、`/* */`、尾逗号与 BOM。按原版的写法写。

重复键不是笔误，重复的键是追加：

```jsonc
"success": {
    "event_on": [5300300, 5300301],
    "event_on": 5300066
}
```

两个 `event_on` 等于加三个事件。绝不要用 JSON 库把配置文件读成对象再写回：字典只保留最后一个值。

不要跑严格的 JSON 格式化器。

不要动别人写的 `config/` JSON 文件的排版。缩进、对齐、换行、空行都不要碰，只改要改的那个值。排版一变，diff 就变成整个文件，谁都看不出实际动了哪几个值。下一个游戏版本更新时，谁也无法对照原版重新应用改动。

### 原版的注释

原版数据是这个格式唯一完整的描述，而且带注释。开发者在这些文件里留了中文 `//` 注释，逐个解释字段。要改一条仪式，先读那个原版文件，再动那个文件。

### 一份完整的仪式

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

### 不要写的四个键

绝不要写 `method_settlement`、`tag_tips`、`mapping`、`random_effect`。原版自己的仪式文件带着这四个键，但四个都不在任何 `handler` 的注册表里，所以没有东西读这四个键。四个键就是 `rite` 的历史键。

### 仪式的其余字段

| 字段 | 含义 |
|---|---|
| `once_new`（必新） | 「新」标记。`1` = 只在第一次出现时是新（`player.only_rites` 记住这条仪式）；`0` = 每次都新；`-1` = 从不 |
| `location`（地点） | 图钉插在哪。写 `place:slot` 或 `place:[lo,hi]`。两半都会被解析 |
| `open_conditions` | 全部都要成立。每条是 `{condition, tips}` |

`open_conditions` 里每一条没满足时，仪式标题栏显示那一条的 `tips`。所以把提示写成打不开的原因，例如「匪帮调动中，无法进行训练」。玩家读到的就是这句话。

`location` 的两半都会解析。区域决定图钉挂到哪个地图变换下：`GameController.GetLocation` 把这个字符串变成 `RitePosition`，`AddRitePin` 把图钉挂到那块区域的变换下。槽位或区间决定它在区域里的位置，`MapController.SetRitesPosition` 处理位置冲突。区间写错是加载期错误。

原版 1498 个仪式里，`location` 有 89 个不同取值，其中 590 个共用 `自宅:[2,12]`。所以位置重合是正常的。

**复用原版的 `location` 字符串，不要自己编。** 区域名是游戏自己地图上的一块区域。`RiteExtensions.GetLocationName` 按 `:` 切开、本地化区域名给显示用，取不到就退回原始串。编出来的区域既没有地图上的位置，也没有名字。一共十个区域，`config` 里没有第十一个。下面原版用到的十组，连同每组的全部槽位取值：

| 组 | 见过的取值 |
|---|---|
| 自宅 | `1` `2` `10` `14` `[1,12]` `[2,6]` `[2,10]` `[2,12]` `[2,14]` `[3,12]` `[4,12]` |
| 上城区 | `3` `[1,6]` `[1,12]` `[2,10]` `[3,12]` `[7,12]` |
| 商业区 | `1` `2` `3` `6` `7` `8` `9` `20` `[4,5]` `[7,10]` `[10,19]` |
| 宫廷 | `1` `2` `7` `[2,6]` `[2,10]` `[7,10]` |
| 神殿区 | `11` `[2,10]` |
| 野外 | `8` `9` `[1,6]` `[1,14]` `[2,14]` `[9,10]` `[9,14]` `[12,14]` |
| 黑街 | `1` `10` `[1,5]` `[1,9]` `[2,5]` `[2,9]` |
| 奇珍 | `1` 到 `15`，一次一个 |
| 结局 | `1` 到 `20`，一次一个 |
| 大敌 | `1` `2` `3` `6` |

`final_pin` 写 `1` 时，仪式在玩家身上留下一个图钉。仪式结算时，游戏先移除这个仪式，再调 `PlayerExtensions.AddRitePin(player, rite.id)`。`RiteResultPanelController.<Settlement>b__8` 在值不是 1 时跳过这一步。结果面板等待时，`UpdateWaiting` 读同一个字段。十二个原版仪式写了 `final_pin`。

`restore_fill_times` 不是死键，只是原版没用。`RitePanelShowController.OnLastState` 读 `restore_fill_times`（`+0x4C`），把它夹在 `1..10`，用于仪式面板关闭时补满槽位。没有一个原版仪式写 `restore_fill_times`，所以所有原版仪式都拿到夹取的下界 1。

## 槽位

`cards_slot`（槽位）是一个字典，键是槽位名。每个槽位是 `cards_slot` 里的一行：

```jsonc
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
```

### `is_empty` 挑的是提示，不是规则

`is_empty`（不能为空 / 可以为空）只决定空槽显示哪一句话：

| 值 | 含义 |
|---|---|
| `0` | 空槽显示「不能为空」的提示 |
| `1` | 空槽显示「可以为空」的提示 |

`CardSlotController.Init` 在 `slot+0x28` 读 `is_empty`。读到的值只用来选**哪一套贴图**：槽位 `tips_icon` 里的名字去这套贴图里查，两个值各一套。除了这套贴图，没有别的东西读这个值。

`CheckConfirm()` 用 `CanPutCard` 走一遍已放进去的卡，不读 `is_empty`。所以一个标了 `0` 的槽空着，引擎也不会拒绝开始仪式。

要强制放卡，把要求写进结算条件：`"s3": 1` 要求 `s3` 放了卡，`"!s3": 1` 要求 `s3` 空着。

`is_empty` 的 0/1 极性来自**原版自己的注释**，不是代码：`"is_empty":0, // 不能为空` 出现 53 次，`"is_empty":1, //可以为空` 与 `// 可以为空` 出现 10 次。图标本身在游戏资源里，配置与代码都没有给这些图标起名。

还有一个容易忽略的地方：`is_empty` 是更大对象里的一行。要判断一个仪式是不是可选，必须读整个槽位。只搜到 `is_empty:1` 说明不了这件事。

### 槽位的其余键

- `is_enemy`（变成敌人）：写 `1` 让这个槽不参与友方标签的合计。`RitePanelController.UpdateTagTipsValue` 累加一个标签的数值时跳过 `is_enemy != 0` 的槽。原版 5406 个槽里有 740 个写了 `is_enemy`。
- `open_adsorb`（吸附）：写 `1` 让这个槽成为仪式打开时从玩家卡池自动吸附的候选。`RiteExtensions.AdsorbCards` 跳过值为 0 的每一个槽。原版 5406 个槽里 3349 个是 `0`，这些槽只能由玩家自己放。
- `is_key`：死键。原版 5406 个槽位全是 `0`，而且整个构建里十二处 `+0x24` 比较没有一处落在槽位上。

### 槽位摆在屏幕的什么位置

`rite_template` 与 `rite_template_mappings` 决定槽位摆在屏幕的什么位置。`rite_template/` 是目录式条目，一个文件一条记录。`rite_template_mappings.json` 是按 key 合并的表。

仪式靠自己的 `mapping_id` 走到这两个文件。那一行给出面板的 `template_id`，以及面板可以打开的槽位键。原版 1422 个 id 里有 1421 个能解析。

不提供模板时，游戏退回一个普通模板，并写一行 `load rite panel {0} failed, rite_template invalid`。那是警告，不是失败。所以仪式不提供这两个文件也能用，只是外观是默认模板。

## 结算与触发顺序

### 三个结算数组

| 数组 | 行为 |
|---|---|
| `settlement_prior`（先结算） | 首条条件成立的分支；然后**整个** `settlement` 数组被跳过 |
| `settlement`（正常结算） | 首条条件成立的分支 |
| `settlement_extre`（附加结算） | 每条自身 `condition` 成立的分支，按数组顺序 |

`settlement_extre` 判断条件时，看到的是产生这条附加结果的那个槽位，不是 `-1`。

原版 wiki 逐字段讲了同一件事，随包数据也与这三个数组的描述一致。反编译出来的循环给了定论：`GetPriorSettlement` 与 `GetNormalSettlement` 各返回一个元素，`DoExtraSettlement` 遍历所有元素，让每一条各自过自己的条件判断。

真正让这条规则能用的是数据本身：

- 在全部 1498 个仪式里，`settlement` 或 `settlement_prior` 里空的 `condition`（`{}` 或没写）都是**最后**一条，69 次里 69 次如此，从没早过。把一条无条件分支放在前面，它后面的每一条分支就都成了死分支。原版没有一个作者把无条件分支写在前面。
- 在 `settlement_extre` 里，空条件出现在每个下标上，包括下标 0 与下标 165，共 216 条；341 条里只有 187 条在最后。`settlement_extre` 的闸门是逐分支的：没有条件的条目总是通过，它后面的条目仍然各自被判断。

所以：无条件分支放在 `settlement_prior` 与 `settlement` 的**最后**，在 `settlement_extre` 里放哪都行。写错了 `node tools/lint.mjs` 会报 `DEAD_BRANCH`。

### `start_trigger` 是未决的

**不要拿 `start_trigger`（是否启动就立即开始校验条件）当设计的地基。** `EventTrigger.Add(EventNode, bool enable_start_trigger)` 把这个事件的字段与第二个参数比较，相等时跳过立即结算那条路。`event_on` 传 `true`，读档传 `false`。

按一种读法，设了 `start_trigger` 时 `event_on` 立刻结算，读档不结算。按另一种读法，结论正好相反：恰恰是 `true` 这个值**不等于**读档传的 `false`，于是走结算那一条分支。

早先的一条笔记声称有探针确认过第一种读法。那条笔记已撤回。

已经确定的是：`auto_start_init` 负责注册事件，`on`（时机）负责排期。所以先让设计在不用 `start_trigger` 的情况下成立，再决定要不要写它。

### 周期与延迟

- `auto_start_init: [1]` 是事件被注册的根本原因。`auto_start_init` 是一组 `init/<n>.json` 的 id，与 `player.configId` 比较，不是延迟。`[1]` 是正常的一局；`[0]` 是引导序章。
- `round_begin_ba: x` 是从启用时刻起算的周期。只写 `x` 表示每 `x` 轮一次，下一次触发用 `current + Random.Range(x, x)` 播种。写 `[a,b]` 用 `current + Random.Range(a, b)` 播种，`b` **不含**，所以 `[3,5]` 是 3 或 4。`99999` 是「触发一次，之后再不来」的惯用写法。
- `delay` 是另一回事：`"delay": {"id": 9001, "round": 5, ...}` 把同一个操作块里其余的操作推迟 5 轮执行，`round: 1` 是下一轮。一轮是游戏内的一天。`id` 是 `delay_off` 用来取消的句柄。同一个 `id` 的第二个 `delay` 会覆盖第一份排期，而不是叠加上去。

### 仪式的时机字段

| 字段 | 含义 |
|---|---|
| `round_number` | 从开始到自动结算走多少轮：`life >= round_number`，而 `life` 是先自增的，所以 `0` 与 `1` 都在第一跳结算。`0` 还会让图钉上不显示剩余轮数。原版取值 0–8 |
| `waiting_round` | 仪式放在地图上没开始时能等多少轮。`0` 表示不限 |
| `waiting_round_end_action` | 等不下去、仪式被移除时执行的结算 |
| `auto_begin`（自动执行） | `1` 让轮次跳到来时自动开始仪式，不需要玩家动手 |

### 每日结算的顺序

每日结算按这个顺序跑：倒计时，然后每张卡自己的 `vanish`，然后按 id 升序跑仪式，然后是刚用掉的卡的 `post_rite`。吸附也按仪式 id 升序。所以 id 小的仪式更早拿走卡。一张卡因此会卡在靠前的仪式里，永远到不了后面那个仪式。

## 条件辅助键

三个键容易混：

| 键 | 含义 |
|---|---|
| `have.<filter>` | 有一张卡活着，在场上任何地方 |
| `table_have.<filter>` | 有一张卡在桌上且空闲 |
| `hand_have.<filter>` | 有一张卡在手上。带 `own`、`adherent` 或 `player` 标签的卡算在手上（`CardExtensions.IsHandCard`，字面量 `0x33796C8` / `0x3374D00` / `0x3379970`） |

过滤器是一个 7 位卡 id 或一个标签名。两者都可以省掉。比较符写在键尾：`have.2000005.幽秘的爱意<`。前面加 `!` 或 `~` 对整个条件取反。
