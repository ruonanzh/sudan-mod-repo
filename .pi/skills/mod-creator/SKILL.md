---
name: mod-creator
description: >
  写苏丹的游戏 mod、改苏丹的游戏 mod 的主参考。在你翻原版配置之前、写第一个文件之前、回答「一个 mod
  能做什么」之前，先读这一份。覆盖 mod 布局、`info.json`、mod 能提供的 config 条目全集、按 key 合并
  与整文件重述的区别、JSONC 规则、带可用示例的卡与事件/仪式写法，以及 id 与贴图上已经验证的事实。
  苏丹的游戏 mod 只是数据：没有编译，没有代码。
---

# 写苏丹的游戏 mod

一个 mod 就是一个装着 JSONC 与 PNG 的文件夹。没有编译步骤，也没有代码。

## 动手前必须先读什么

原版数据是这个格式唯一完整的描述，而且带注释。先读你要改的那个文件，再动它：

```
macOS    ~/Library/Application Support/Steam/steamapps/common/Sultan's Game/Sultan's Game.app/Contents/Resources/Data/StreamingAssets/config/
Windows  <steam>\\steamapps\\common\\Sultan's Game\\Sultan's Game_Data\\StreamingAssets\\config\\
```

开发者在这些文件里留了中文 `//` 注释，逐个解释字段。`config/event/5300000.json` 是教学局的开场，就地写明了 `confirm`、`option`、`success` 与 `failed`，短写与长写两种形状并排给出。它是最好的单一样例文件。

改动需要图片时，再读 `card-art`。需要玩家先就某个范围或某个值达成一致时，答案是页面：读 `mod-page`。写完之后，`mod-installer` 负责把它装进游戏并读回日志。

## mod 布局

```
<ModName>/
  info.json          必需
  preview.png|jpg    可选, 创意工坊缩略图, 游戏用 "preview.*" 通配, 不校验尺寸
  config/            数据, 镜像 StreamingAssets/config/
  image/             贴图, 递归遍历
  bgm/               音频, 递归遍历
```

游戏靠扫描 `MOD_ROOT` 下含 `info.json` 的子目录来发现 mod。没有注册文件。写 mod 只写在本仓的 `your_mods/<ModName>/` 下。

## 建 mod 骨架

目录由工具建，不用 `mkdir`：`create_mod_folder(name=...)` 建出 `your_mods/<name>/`，并把会话绑定到它。它同时是写入隔离的边界——守卫只允许写绑定目录里面——所以不要用别的办法建这个目录。

- `name` 是小写 snake_case：`a-z`、`0-9`、`_`，以字母开头，最多 40 个字符（`broken_blade`，不是 `Broken Blade`）。它是文件夹名，不是面板名：面板上显示的名字是 `info.json` 的 `name`。
- 它不建任何源文件。`info.json` 自己写（下一节）。
- 失败与对应的做法：

| 输出 | 做法 |
|---|---|
| `EXISTING: This session is already bound to <path>` | 已经绑定过了，继续用这个目录，不要再建第二个 |
| `INVALID_MOD_NAME: ...` | 改名字，再调一次 |
| `MOD_NAME_TAKEN: <name> already exists` | 这个名字被占了，换一个名字 |
| `MOD_DIRECTORY_MISSING` / `UNAVAILABLE` | 绑定的目录已经不在了或读不了。请玩家恢复它，或者开一个新会话；不要绑定第二个目录 |
| `HELPER_READ_ONLY` | Game Helper 会话不能建 mod；换到 mod 开发会话 |

## info.json

```jsonc
{
    "name": "Short name for the mod panel",
    "description": "One or two sentences.",
    "tags": ["Utilities"],
    "version": "1.0.0"
}
```

| 字段 | 类型 | 规则 |
|---|---|---|
| `name` | string | 必需，最多 128 字节 |
| `description` | string | 最多 8000 字节，允许 `\n` |
| `tags` | string[] | 只允许 ASCII；游戏按 ASCII 匹配标签，其他字符忽略 |
| `version` | string | 写了，游戏不用 |
| `enable_reassign_id` | bool | 可选，接受游戏对这个 mod 的 id 重新分配 |

## mod 能提供什么，别的都不行

这份清单是完整的。mod 少给哪一项，加载器就为哪一项写一行 `file not exists`，所以这个集合从任何一个 mod 的日志里都能读出来。

```
config/game.json          config/tag.json            config/cards.json
config/init               config/over.json           config/rite
config/event              config/loot                config/dt
config/after_story        config/wizard              config/upgrade.json
config/quest.json         config/rite_template       config/rite_template_mappings.json
config/sfx_config.json    config/over_music_config.json
config/sfx_npc_role_dub.json                         config/sfx_settle_card_new.json
```

下面这些游戏自己也读，但**不可 mod**。玩家要求改这些时，直接说作为 mod 做不到：

`achievement.json` `credits.json` `gallery_cards.json` `gallery_cg.json` `imagestyle.json`
`mobile_help.json` `textstyle.json` `ui.json` `variable.json` `rite.json`

一个 mod 能提供的只有上面清单里的条目。只交一份文件很正常，也是对的。

## 两种合并行为，以及怎么区分

- **表条目按 key 合并。** `cards.json`、`upgrade.json`、`tag.json`、`quest.json`、`over.json`、`rite_template_mappings.json` 与 `sfx_*` 文件都是字典。只写你要新增或修改的那几条记录，其余归原版。`tag.json` 的 key 是标签的 **code 字符串**，不是 `id`。

- **目录条目一个文件一条记录。** `event/`、`rite/`、`loot/`、`init/`、`rite_template/`、`after_story/`、`dt/`、`wizard/`。新增一条记录就是新增一个文件。改一条原版记录要整文件重述，因为这里没有字段级合并。

目录条目里，文件名必须等于 `id`。`rite` 这一条是关键的：游戏用 id 拼路径（字面量 `rite/{0}.json`），名字对不上的文件根本不会被读。其余目录在现存每一个 mod 里都是同样的行为；名字对不上就当缺陷处理。

## JSONC 规则

游戏的读取器接受 `//`、`/* */`、尾逗号与 BOM。按原版的写法写。

**重复键不是笔误。** 它是追加：

```jsonc
"success": {
    "event_on": [5300300, 5300301],
    "event_on": 5300066
}
```

这样写等于加三个事件。绝不要用 JSON 库把配置文件读成对象再写回：字典只保留最后一个值。

`settlement` 数组是重复键出现的另一处，在 `result` 里面。

## 一张卡

`config/cards.json` 是按卡 id 索引的字典。下面是一张完整、最小的新道具卡：

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

卡的字段：

| 字段 | 含义 |
|---|---|
| `id` | 必须等于字典的 key |
| `name` | 卡面名字。**它按卡面宽度截断，所以写短** |
| `title` | 卡面副标题那一行，例如 军队 |
| `text` | 卡牌详情里显示的规则或风味文字 |
| `type` | `char`、`item` 或 `sudan` |
| `rare` | 1 到 4。1 石、2 铜、3 银、4 金 |
| `resource` | 贴图名；多种画法时写贴图名的数组 |
| `tag` | 标签名到整数的映射。负数与 0 都合法 |
| `pops` | 声明为 `string[]`，**原版 1294 张卡全部是空数组**。它是旧版留下的弹窗定义，写对象会让转换失败；弹窗行为用 `post_rite` |
| `equips` | 这张卡接受的装备槽，例如 `["武器","服装","饰品"]` |
| `is_only` | 是否只允许存在一张 |
| `card_vanishing` / `vanish` | `card_vanishing` 是寿命轮数：每过一轮加 1，`life >= card_vanishing` 时这张卡进消失队列。`0` = 永不老化。`vanish` 是卡被销毁时执行的操作块；原版 1294 张卡里 1267 张是 `{}` |
| `post_rite` | 可选的结算数组。涉及这张卡的仪式结算完之后，每一条 `condition` 成立的分支追加自己的 `result_text`，并把自己的 `result`/`action` 入队。装备在这张卡上的卡，它们的分支也一起收集 |

原版的卡 id 从 `2000001` 到 `2001351`。社区 mod 用过 `17xxxxx`、`21xxxxx` 到 `27xxxxx`、`2999999` 与 `9000xxx`。这里没有保留段，也没有注册表，所以先查有没有撞车，再挑一个别人没用过的值。

要让一张卡能拿到，加一条 `config/upgrade.json` 条目。它是命运商店：

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

`link_card` 决定商店缩略图画什么。`cost: 0` 合法，等于免费展示这件东西。`link_card_inst` **不是**可写的键（`upgrade` 的历史键）：游戏从 `link_card` 合成那张 `Card`（`PointShopController.InitUpgradeCards`），写它没有任何作用。

## 一个事件

`config/event/<id>.json`。整套语言就这些：`on` 是它何时触发，`condition` 是必须成立什么，`settlement` 是一串带 `action` 的分支。

```jsonc
{
    "id": 5300029,
    "text": "书店营业",              // 只用于显示, 没有代码读它
    "is_replay": 1,                 // 能不能触发多次
    "auto_start_init": [1],         // init 配置 1 启动时就已经启用
    "start_trigger": true,          // 未决, 见下面的说明
    "on": { "round_begin_ba": 1 },  // 时机, 1 表示每轮开始
    "condition": {
        "!rite": 5002006,            // ! 表示取反
        "counter.7000017<=": 43      // 比较运算符写在键里
    },
    "settlement": [
        {
            "action": { "rite": 5002006 }
        }
    ]
}
```

决定这个文件有没有效的事实：

- **每种节点类型的字段清单在 `schema/fields.json` 里**，`tools/lint.mjs` 把它读作 `NODE_FIELDS`。这份清单是从反编译出来的 `*_JsonHandler` 类型里读出来的，并且对着每一个随包文件核对过。某个节点没有注册的键永远不被读，所以 `node tools/lint.mjs` 把它报成 `UNKNOWN_FIELD`。逐键的证据（读取器序号、字段偏移、语料计数）在设计仓的 `docs/sudan-game/fields/21-handler-keys.md`。
- **这些字段清单从哪来。** `inspect_game_code` 读那份 dump：`action=search` 在 `dump.cs` 里找类型或成员，`action=type` 打印它的字段与偏移、属性、签名，`action=body member=<name>` 打印那个方法的 ISIL 与反汇编，`action=strings` 搜字符串字面量。dump 在 `~/.gamer-agent-pi/decompiled/sudan-mod-repo/`，覆盖游戏八个程序集；要加一个就写进 `.pi/lib/decompile.json`，再跑 `action=dump assemblies=<name>`。字段偏移是十进制（`[r14+40]` 就是 `0x28`），反汇编偏移是十六进制（`+58h` 就是 `88`）。本仓只提供数据，所以读 dump 是为了确认一个键或一个类型，不是为了写代码。
- `EventNode` 没有 `auto_start`，尽管有 1520 个原版事件文件带着它。这个键什么都不做，它在 `schema/fields.json` 的 `legacy` 列表里（历史键）。真字段是 `auto_start_init`。
- `text` 在 1867 个原版事件上都被写了，而**没有任何代码读它**——它不在那七个注册键里，是历史键。把它当成给打开这个文件的人看的标签。
- **事件分支没有 `condition`。** `EventTrigger.DoSettlements` 按数组顺序执行每一条分支，一条都不判断，1869 条原版分支里 0 条带这个键。你在那里写的 `condition` 会被静默忽略；挑分支是 `rite.settlement` 的事。
- `tips_resource` 与 `tips_text` 被写进 1813 条事件分支，而它们**不是**结算的键：`tips_resource` 在二进制里根本不是字符串，`tips_text` 是 `rite` 的键。两个都被忽略。
- **事件分支不显示自己的文字。** 结算形状里有 `result_text`，但事件这一侧从不读它：玩家看到的是 `action.prompt`（1869 条原版分支里 622 条写了它）。措辞写在那里。
- `auto_start_init` 是一串 `init` 配置 id。`config/init/1.json` 是正常的一局，所以 `[1]` 的意思是「正常局一开局就启用」。一个事件如果不在任何 `auto_start_init` 列表里，也没有被别的事件的 `event_on` 点到，它就不跑。一个全新的事件要每轮都跑，就得写 `"auto_start_init": [1]`。

- **时机键。** 一共正好 29 个，不在这个集合里的键永远不会被排期。不要背它们，也不要信任何文档里的清单：读 [`schema/SCHEMA.md`](../../../schema/SCHEMA.md) 的 Timings 一节，或者跑 `node tools/lint.mjs <modDir>`，让 `UNKNOWN_TIMING` 告诉你。写数字表示「每几轮一次」；写 `[lo, hi]` 表示在这个区间里随机取一轮。29 个里有 8 个被引擎注册、原版从未写过；SCHEMA.md 标了是哪几个。
- **条件键**把运算符带在身上：`counter.7000017<=`、`rare<`、`r1:体魄`、`hand_have.<id>`、`table_have.<id>`、`have.<id>`、`cost.<tag>`、`is`、`type`、`any`、`all`、`!` 表示取反，`s1`..`sN` 把范围限定到仪式的某个槽位。完整语法与原版实际用到的形状，是 [`schema/SCHEMA.md`](../../../schema/SCHEMA.md) 的 Conditions 一节。
- **操作键**把参数带在身上：`rite`、`card`、`g.card`、`event_on`、`event_off`、`clean.self`、`clean.rite`、`clean.sN`、`counter+<id>`、`counter=<id>`、`global_counter+<id>`、`total.<id>+<tag>`、`pop.<shorthand>`、`loot`、`coin`、`table`、`choose`、`option`、`confirm`、`success`、`failed`、`case:op1`..、`delay`、`copy`、`sleep`、`focus`、`slide`、`rebirth.<slot>`、`over`、`steam_achievement`、`enable_auto_gen_sudan_card`、`begin_guide`、`close_story`、`change_name`、`change_card_name`、`change_card_text`、`change_desk_bg`、`change_location_icon`、`debug`、`no_show`、`no_prompt`。
- **`success` 与 `failed`** 把 `confirm`、`option` 或骰子检定之后的分支包起来。`case:opN` 选第 N 个选项那一条分支。
- 仪式里限定槽位的键用 `s1`..`sN`。骰子检定用 `r1`..`r5`。

## 一个仪式

`config/rite/<id>.json`。仪式就是玩家放卡的那块板子。

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

绝不要写这几个键：`method_settlement`、`tag_tips`、`mapping`、`random_effect`。原版自己的仪式文件带着它们，但四个都不在任何 `handler` 的注册表里，所以没有东西读它们——它们就是 `schema/fields.json` 里 `rite` 的 `legacy` 列表（历史键）。

有三个结算数组。多个分支时各自怎么做：

| 数组 | 行为 |
|---|---|
| `settlement_prior` | 首条条件成立的分支；然后**整个** `settlement` 数组被跳过 |
| `settlement` | 首条条件成立的分支 |
| `settlement_extre` | 每条自身 `condition` 成立的分支，按数组顺序。判断条件看到的是产生这条附加结果的那个槽位，不是 `-1` |

随包数据与它一致，反编译出来的循环给了定论：`GetPriorSettlement` 与 `GetNormalSettlement` 各返回一个元素，`DoExtraSettlement` 遍历所有元素，让每一条各自过自己的条件判断。

wiki 逐字段讲了这件事。随包数据与它一致，而真正让这条规则能用的是数据本身：

- 在全部 1498 个仪式里，`settlement` 或 `settlement_prior` 里空的 `condition`（`{}` 或没写）都是**最后**一条，69 次里 69 次如此，从没早过。把一条无条件分支放在前面，它后面的每一条分支就都成了死分支，所以没有一个作者这么写。
- 在 `settlement_extre` 里，空条件出现在每个下标上，包括下标 0 与下标 165，共 216 条；341 条里只有 187 条在最后。逐分支的闸门就是这个样子：没有条件的条目总是通过，它后面的条目仍然各自被判断。

所以：无条件分支放在 `settlement_prior` 与 `settlement` 的**最后**，在 `settlement_extre` 里放哪都行。写错了 `node tools/lint.mjs` 会报 `DEAD_BRANCH`。

`is_empty` 挑的是提示，不是规则：

| 值 | 含义 |
|---|---|
| `0` | 空槽显示「不能为空」的提示 |
| `1` | 空槽显示「可以为空」的提示 |

`CardSlotController.Init` 在 `slot+0x28` 读它，读到的值只用来选**哪一套贴图**：槽位 `tips_icon` 里的名字去这套贴图里查，两个值各一套，别的什么都没有。`CheckConfirm()` 用 `CanPutCard` 走一遍已放进去的卡，不读这个值，所以引擎不会因为一个标了 `0` 的槽空着就拒绝开始仪式。要强制放卡，把要求写进结算条件：`"s3": 1` 要求放了，`"!s3": 1` 要求空着。

这张表里的 0/1 极性来自**原版自己的注释**，不是代码：`"is_empty":0, // 不能为空` 出现 53 次，`"is_empty":1, //可以为空` / `// 可以为空` 出现 10 次。图标本身在游戏资源里，配置与代码都没有给它们起名。还有一个坑：`is_empty` 是更大对象里的一行，所以搜到 `is_empty:1` 说明不了那个**仪式**是不是可选。要读整个槽位。

### 仪式的其余字段

| 字段 | 含义 |
|---|---|
| `once_new` | 「新」标记：`1` = 只在第一次出现时是新（`player.only_rites` 记住它），`0` = 每次都新，`-1` = 从不 |
| `location` | 图钉插在哪：`place:slot` 或 `place:[lo,hi]`。**两半都会被解析**——区域决定图钉挂到哪个地图变换下，槽位或区间决定它在区域里的位置，`MapController.SetRitesPosition` 处理位置冲突。1498 个仪式里 89 个不同取值，其中 590 个共用 `自宅:[2,12]`，所以位置重合是正常的。区间写错是加载期错误 |
| `open_conditions` | **全部都要成立。** 每条是 `{condition, tips}`，仪式标题栏会显示每一条没满足的 `tips`，所以把提示写成打不开的原因（「匪帮调动中，无法进行训练」）——玩家读到的就是这句话 |
| `is_enemy`（槽位） | `1` 让这个槽不参与友方标签的合计：`RitePanelController.UpdateTagTipsValue` 累加一个标签的数值时跳过 `is_enemy != 0` 的槽。原版 5406 个槽里有 740 个写了它 |

**复用原版的 `location` 字符串，不要自己编。** 区域名是游戏自己地图上的一块区域：`GameController.GetLocation` 把这个字符串变成 `RitePosition`，`AddRitePin` 把图钉挂到那块区域的变换下，`RiteExtensions.GetLocationName` 按 `:` 切开、本地化区域名给显示用，取不到就退回原始串。所以编出来的区域既没有地图上的位置，也没有名字。一共十个区域，config 里没有第十一个。下面原版用到的十组，连同每组的全部槽位取值：

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

`final_pin: 1` 会被读，只做一件事：仪式结算时，游戏先移除这个仪式，再调 `PlayerExtensions.AddRitePin(player, rite.id)`——于是这个仪式在玩家身上留下一个图钉。`RiteResultPanelController.<Settlement>b__8` 在值不是 1 时跳过这一步，结果面板等待时 `UpdateWaiting` 读同一个字段。十二个原版仪式写了它。

死键：`is_key`——原版 5406 个槽位全是 `0`，而且整个构建里十二处 `+0x24` 比较没有一处落在槽位上。

`restore_fill_times` 不是死键，只是原版没用：`RitePanelShowController.OnLastState` 读它（`+0x4C`），把它夹在 `1..10`，用于仪式面板关闭时补满槽位。没有一个原版仪式写它，所以它们全都拿到夹取的下界 1。

## 触发、超时，以及结算的先后

**`start_trigger` 是未决的。不要拿它当设计的地基。** `EventTrigger.Add(EventNode, bool enable_start_trigger)` 把这个事件的字段与第二个参数比较，相等时跳过立即结算那条路。`event_on` 传 `true`，读档传 `false`。按一种读法，这意味着设了 `start_trigger` 时 `event_on` 立刻结算、读档不结算；按另一种读法正好相反，因为恰恰是 `true` 这个值**不等于**读档传的 `false`，于是走结算那一支。本文件早先的一条笔记声称有探针确认过第一种读法；那个说法已撤回。已经确定的是：`auto_start_init` 负责注册事件，`on` 负责排期，所以先让设计在不用 `start_trigger` 的情况下成立，再决定要不要写它。

- `auto_start_init: [1]` 是事件被注册的根本原因。它是一组 `init/<n>.json` 的 id，与 `player.configId` 比较，不是延迟。`[1]` 是正常的一局；`[0]` 是引导序章。
- `round_begin_ba: x` 是从启用时刻起算的周期。只写 `x` 表示每 `x` 轮一次，下一次触发用 `current + Random.Range(x, x)` 播种；`[a,b]` 用 `current + Random.Range(a, b)` 播种，`b` **不含**，所以 `[3,5]` 是 3 或 4。`99999` 是「触发一次，之后再不来」的惯用写法。

`delay` 是另一回事：`"delay": {"id": 9001, "round": 5, ...}` 让它其余的操作在 5 轮之后执行，`round: 1` 是下一轮。一轮是游戏内的一天。`id` 是 `delay_off` 用来取消的句柄，同一个 `id` 的第二个 `delay` 会覆盖第一份排期，而不是叠加上去。

仪式的时机字段：

| 字段 | 含义 |
|---|---|
| `round_number` | 从开始到自动结算走多少轮：`life >= round_number`，而 `life` 是先自增的，所以 `0` 与 `1` 都在第一跳结算。`0` 还会让图钉上不显示剩余轮数。原版取值 0–8 |
| `waiting_round` | 仪式放在地图上没开始时能等多少轮。`0` 表示不限 |
| `waiting_round_end_action` | 等不下去、仪式被移除时执行的结算 |
| `auto_begin` | `1` 让轮次跳到来时自动开始仪式，不需要玩家动手 |
| `open_adsorb`（槽位） | `1` 让这个槽成为仪式打开时从玩家卡池自动吸附的候选（`RiteExtensions.AdsorbCards` 跳过值为 0 的每一个槽）。原版 5406 个槽里 3349 个是 `0`，这些槽只能由玩家自己放 |

每日结算按这个顺序跑：倒计时，然后每张卡自己的 `vanish`，然后按 id 升序跑仪式，然后是刚用掉的卡的 `post_rite`。吸附也按仪式 id 升序。所以 id 小的仪式抢卡更凶，这就是一张卡会卡在靠前的仪式里、永远到不了后面那个仪式的原因。

## 容易混的条件辅助键

| 键 | 含义 |
|---|---|
| `have.<filter>` | 有一张卡活着，在场上任何地方 |
| `table_have.<filter>` | 有一张卡在桌上且空闲 |
| `hand_have.<filter>` | 有一张卡在手上。带 `own`、`adherent` 或 `player` 标签的卡算在手上（`CardExtensions.IsHandCard`，字面量 `0x33796C8` / `0x3374D00` / `0x3379970`） |

过滤器是一个 7 位卡 id 或一个标签名，两者都可以省掉，比较符写在键尾：`have.2000005.幽秘的爱意<`。前面加 `!` 或 `~` 对整个条件取反。

`rite_template` 与 `rite_template_mappings` 决定槽位摆在屏幕的什么位置。仪式靠自己的 `mapping_id` 走到它们：那一行给出面板的 `template_id` 与面板可以打开的槽位键，原版 1422 个 id 里有 1421 个能解析。你不提供模板时，游戏退回一个普通模板，并写一行 `load rite panel {0} failed, rite_template invalid`。那是警告，不是失败，所以仪式不提供这两个文件也能用，只是长得普通。

## 掉落表、任务、结局与后日谈

一个 mod 还能提供四样东西。只读下面这些字段，其他都被忽略。

### 掉落表——`config/loot/<id>.json`，一个文件一张表

```jsonc
{
    "id": 6000004,
    "name": "情报掉落",
    "repeat": 1,
    "type": 2,
    "item": [ { "type": "card", "id": 2000032, "num": "1", "weight": 60 } ]
}
```

`type` 是常量，不是自由文本——引擎拿它与四个值比较：

| `type` | 每次抽什么 | 原版数量 |
|---|---|---|
| `2` | 每次抽一次带权选择 | 125 |
| `3` | 每次抽一次带权选择，先排除玩家已有的条目 | 55 |
| `4` | 不重复地做 `repeat` 次**带权**抽取：`repeat` 就是「n 中选 m」的 `m`，算法整体跑一遍，不是跑 `repeat` 遍 | 2 |
| `99` | 每条合格条目都抽，忽略权重，跑 `repeat` 次 | 11 |

`repeat` 是独立抽取的次数——除了 `type: 4` 时它是 `m`。原版 188 张表用 `1`，其余用 3、6 或 13。

每条 `item` 是 `{type, id, num, weight, condition}`。`type` 是 `card`、`event`、`rite` 或 `loot`（表套表）。`weight` 是相对值——只有比值有意义，`SimpleWeightLoot` 确实是把它们加起来之后用 `Random.Range` 抽。`num` 是给几条，原版写成字符串（`"1"`）。`condition` 过滤条目的方式与别处每一个条件一样。

原版计数：193 张表，1280 条 item（870 张卡、215 个事件、171 个仪式、24 个掉落表）。

item 对象上有两个警告。`refLoot` 是**历史键**——加载器只注册 `type`、`id`、`num`、`weight` 与 `condition`，没有一条原版 item 带着它；要套表就写 `"type": "loot"`。而 `condition` 会被读进来，但从不求值：`SimpleWeightLoot`、`WeightedNChooseM`、`RealGenCard` 与 `Generate` 都构造了 `ConditionContext`，四个都没有调 `IsSatisfied`。不要想用它闸住掉落——拆表，或者把闸设在结算上。

### 任务——`config/quest.json`，一张按 id 索引的表

```jsonc
"3300001": { "id": 3300001, "name": "坠落的初端", "text": "...", "favour_text": "...",
             "upgrade_point": 1, "icon": "cards/2000001",
             "target": [ { "text": "完成1局苏丹的游戏", "show_counter": "",
                           "condition": { "global_counter.7220001>=": 1 } } ] }
```

加载器真正注册的只有：`id`、`name`、`text`、`icon`、`favour_text`、`upgrade_point`、`target`。对象里别的都被丢掉。

- `target[]` 是必须成立的东西。`condition` 是普通条件，`text` 是玩家读到的那一行（它经过 `FormatStringVariable`，所以 `{变量}` 有效），`show_counter` 指定一个计数器显示在它旁边——留空就是不显示，由 `StoryTargetItemController.Init` 里的 `String.IsNullOrEmpty` 决定。原版 193 条 target 都带条件。
- `isComplete`（任务上与 target 上都有）是存档侧的状态，负责那个勾的贴图。不要写它。
- `upgrade_point` 是这个任务值多少；完成提示会把它显示出来（原版 161 个任务每个都是 1）。
- `target.value` 是一个**显示进 target 那一行**的数字（`StoryTargetItemController.Init` 把它括起来再拼上去），从不参与比较。原版没有任何 target 写它；它在 `questTargetItem` 的 `legacy` 列表里。
- **`pre` 什么都不做。** 它在 `quest.json` 里到处都是（161 个值，每个是另一个任务 id），但字符串 `pre` 在 `global-metadata.dat` 里根本不存在，所以加载器没有键可匹配——与事件上的 `auto_start` 是同一种历史键。不要拿它搭任务链。

### 结局——`config/over.json`，一张按 id 索引的表

加载器把十二个字段全部注册了，所以这里没有死键：`id`、`name`、`sub_name`、`text_extra`、`open_after_story`、`text`、`manual_prompt`、`success`、`comment`、`bg`、`icon`、`title`。

- `name`、`sub_name`、`text`、`bg`、`icon`、`title`、`manual_prompt`、`comment` 都是显示用的。`comment` 注册了，但没有一个原版结局用它。
- `open_after_story: 1` 让这个结局继续进后日谈。`OverNewStep2StoryController` 把它当作 `Action<bool> hasAfterStory`，所以是它决定跳不跳（原版 159 个结局里 108 个写了它）。
- `success` 决定回顾界面用哪个标题（`OverNodeController`）：`0` 显示 `DeadTitle`，其他任何值显示 `SuccessTitle`，而 `2` 另外把 `VictoryIcon` 打开。所以失败结局写 `0`，胜利写 `1`，胜利并带胜利图标写 `2`。原版：63 个是 `1`，46 个是 `2`，4 个是 `0`，46 个没写。
- `text_extra` 是一个 `RiteNode.Settlement[]`，而且它**会被读**：`OverNewStep2StoryController` 先显示结局自己的 `text`，再遍历 `text_extra`（长度在 `+0x18`，每条条目的 `condition` 在条目自己的 `+0x18`），把每一条条件成立的分支那一段追加上去。所以想多出一段，就写一条带自己条件的分支。

### 后日谈——`config/after_story/<characterCardId>.json`

一个角色卡一个文件；这个 id 是**卡**的 id，不是新的编号段（原版 66 个：61 个角色加 5 个道具）。

- `pic` 是显示的那张画。
- `close_condition` **会**被求值。页面循环调 `condition.IsSatisfied`，`close_condition` 成立就跳过这一页、不渲染它。没有原版文件把它写成活的：66 个里 59 个用同一份内容把它**注释掉**了，`{ "!s1": 1 }`。
- `prior` 与 `extra` 都是 **`RiteNode.Settlement[]`**，与仪式用的分支形状一样：`{condition, result_text, pic, result, action, key, sort}`。两者不是互相替代的关系，也不是同一个列表的两半：`prior` 有**优先权**。
- `prior` 是那一段开场白。游戏先走它，取第一条通过的分支，跑它的 `result` 再跑它的 `action`，然后**返回**，所以 `extra` 从来不会被读。66 个原版文件全都把它声明成 `[]`；写一条进去，整个尾声就变成那一段。
- `extra` 才是尾声本身，**每一条通过的分支都成为一页**，按数组顺序。通过的意思是：带 `key` 的分支必须匹配存档里的 `after_story_key`（没有 `key` 的分支跳过这项检查），它的 `condition` 必须成立，而且 `result_title` 与 `result_text` 不能都空着。所以一张有 385 条分支的卡渲染成的是一个由世界状态做闸门的 385 页轮播，而不是从 385 条里挑一页。7750 条原版分支每条都带一个 key，例如 `2000001_extra_1`；写一个。这个 `key` 还喂给 `Datapool.SetOverId`，页面的正文与上一页下一页按钮都靠它定位。
- `sort` 落在分支上，但找不到读它的地方，所以不要靠它排页序：你能看见、能控制的是数组顺序。
- 存档把 `prior` 存成字符串键、把 `extra` 存成集合，所以同一份配置可以被好几局复用。

## 验收

```
node tools/lint.mjs your_mods/<ModName>
```

然后安装、启用，读 `~/DoubleCross/SultansGame/ModLog/<mod name>_local.log`。你要看到你改过的每个文件都有 `read mod <name> file: config/<file>`，并且没有 `mod <name> info.json invalid`。

缺文件是噪音，不是错误。只提供一个文件的 mod 会打出十八条警告，照样能用。
