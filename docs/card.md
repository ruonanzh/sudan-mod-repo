# 一张卡

这一份讲 `config/cards.json` 里的一张卡：记录长什么样、每个字段什么含义、卡 id 怎么挑、怎么让玩家拿到这张卡。

## 卡放在哪，怎么合并进去

一个 mod 就是一个装着 JSONC 与 PNG 的文件夹。没有编译步骤，也没有代码。mod 只写在本仓的 `your_mods/<ModName>/` 下，mod 里的 `config/` 目录镜像游戏自己的 `StreamingAssets/config/`。

`config/cards.json` 是表式条目。表式条目按 key 合并，这张表的 key 是卡 id。mod 里只写要新增或要修改的那几条记录，其余 id 归原版，别的 id 不受影响。

目录式条目不是这样。`config/event/<id>.json`、`config/rite/<id>.json`、`config/loot/<id>.json` 这些目录里，一个文件就是一条记录。改一条原版记录，要先把那个文件整份照抄过来，再改要改的字段。卡不在这一列，卡在表里，所以改一张原版卡不需要照抄整套卡表。

`config/upgrade.json`、`config/tag.json`、`config/quest.json`、`config/over.json` 与 `config/rite_template_mappings.json` 也是表式条目。`config/tag.json` 的 key 是标签的 **code 字符串**，不是 `id`。

## mod 能提供的与卡有关的文件

这份清单是完整的。mod 少给哪一项，加载器就为哪一项写一行 `file not exists`。所以从任何一个 mod 的日志里，都能读出这个集合。

```
config/game.json          config/tag.json            config/cards.json
config/init               config/over.json           config/rite
config/event              config/loot                config/dt
config/after_story        config/wizard              config/upgrade.json
config/quest.json         config/rite_template       config/rite_template_mappings.json
config/sfx_config.json    config/over_music_config.json
config/sfx_npc_role_dub.json                         config/sfx_settle_card_new.json
```

写一张卡只会用到上面清单里的两个文件：`config/cards.json` 放卡的记录，`config/upgrade.json` 放命运商店的条目。

下面这些文件游戏自己也读，但**不可 mod**：

`achievement.json` `credits.json` `gallery_cards.json` `gallery_cg.json` `imagestyle.json`
`mobile_help.json` `textstyle.json` `ui.json` `variable.json` `rite.json`

玩家要求改这些文件时，直接说作为 mod 做不到。`gallery_cards.json` 就在这一列里，所以卡廊本身不可 mod。

## JSONC 规则

游戏的读取器接受 `//`、`/* */`、尾逗号与 BOM。按原版的写法写。

**重复键是语法，不是笔误。** 同一份文件里把一个键写八十次，就是加八十个条目：

```jsonc
"success": {
    "event_on": [5300300, 5300301],
    "event_on": 5300066
}
```

这样写等于加三个事件。绝不要用 JSON 库把配置文件读成对象再写回。字典只保留最后一个值，八十个事件于是变成一个。

严格的 JSON 格式不允许同一个键出现两次。所以不要跑严格的 JSON 格式化器。游戏的读取器接受 `//`、`/* */`、尾逗号与 BOM，原版自己四种都用。

不要动别人写的 `config/` 下 JSON 文件的排版。缩进、对齐、换行、空行都不要碰，只改要改的那个值。排版一变，diff 就变成整个文件，谁都看不出实际动了哪几个值。下一个游戏版本更新时，也无法对照原版重新应用这些改动。

`settlement` 数组里也会出现重复键，位置在 `result` 里面。

## 原版语料带 `//` 注释

原版数据是这个格式唯一完整的描述，而且带注释。要改哪个文件，先读那个文件，再动那个文件。

开发者在原版文件里留了中文 `//` 注释，逐个解释字段。`config/event/5300000.json` 是教学局的开场，就地写明了 `confirm`、`option`、`success` 与 `failed`，短写与长写两种形状并排给出。原版里最好的单一样例文件就是这个开场。

原版目录的位置随机器和平台变，所以这一份里不写死路径。取法是跑 `node tools/setup.mjs --check`，这一条命令把原版目录的位置打印出来。要读原版文件却不知道目录在哪时，跑这一条，不要在别处猜路径。

原版 `config/cards.json` 里有 1294 张卡。卡 id 从 `2000001` 到 `2001351`。这一份里的计数都是从原版语料数出来的。

## 一张完整、最小的新道具卡

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

字典的 key 写成字符串 `"9000001"`，记录里的 `id` 写成数字 `9000001`。两者必须相等。

## 卡的字段

| 字段 | 含义 |
|---|---|
| `id` | 必须等于字典的 key |
| `name` | 卡面名字。**`name` 按卡面宽度截断，所以写短** |
| `title` | 卡面副标题那一行，例如 军队 |
| `text` | 卡牌详情里显示的规则或风味文字 |
| `type` | `char`、`item` 或 `sudan` |
| `rare` | 1 到 4。1 石、2 铜、3 银、4 金 |
| `resource` | 贴图名。有多种画法时，`resource` 写贴图名的数组 |
| `tag` | 标签名到整数的映射。负数与 0 都合法 |
| `pops` | 声明为 `string[]`，**原版 1294 张卡全部是空数组**。`pops` 是旧版留下的弹窗定义，写对象会让转换失败。弹窗行为用 `post_rite` |
| `equips` | 这张卡接受的装备槽，例如 `["武器","服装","饰品"]` |
| `is_only` | 是否只允许存在一张 |
| `card_vanishing` / `vanish` | `card_vanishing` 是寿命轮数。每过一轮加 1，`life >= card_vanishing` 时这张卡进消失队列。`0` 表示永不老化。`vanish` 是卡被销毁时执行的操作块。原版 1294 张卡里 1267 张写 `{}` |
| `post_rite` | 可选的结算数组。涉及这张卡的仪式结算完之后，每一条 `condition` 成立的分支追加自己的 `result_text`，并把自己的 `result` 与 `action` 入队。装备在这张卡上的卡，那些卡的分支也一起收集 |

## 卡 id 怎么挑

这里没有保留段，也没有注册表。挑 id 之前先查有没有撞车，再挑一个别人没用过的值。

社区 mod 用过 `17xxxxx`、`21xxxxx` 到 `27xxxxx`、`2999999` 与 `9000xxx`。原版用的是 `2000001` 到 `2001351`。

每个新 id 都是你的责任，游戏不会警告。查两处：原版一次，每一个已安装的 mod 一次。`node tools/lint.mjs --mod-root <ModRoot>` 两处都查。

## 让玩家拿到这张卡：命运商店

要让一张卡能拿到，加一条 `config/upgrade.json` 条目。`config/upgrade.json` 是命运商店：

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

`link_card` 决定商店缩略图画什么。`cost: 0` 合法，等于免费展示这件东西。

`link_card_inst` **不是**可写的键。`link_card_inst` 是 `upgrade` 的历史键。游戏从 `link_card` 合成那张 `Card`（`PointShopController.InitUpgradeCards`），写 `link_card_inst` 没有任何作用。
