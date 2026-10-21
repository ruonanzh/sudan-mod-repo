# 一张卡

这一份讲 `config/cards.json` 里的一张卡：记录长什么样、每个字段什么含义、卡 id 怎么挑、怎么让玩家拿到这张卡。

## 原版语料带 `//` 注释

原版数据是这个格式唯一完整的描述，而且带注释。要改哪个文件，先读那个文件，再动那个文件。

开发者在原版文件里留了中文 `//` 注释，逐个解释字段。原版每一张卡旁边的注释就是这张卡的字段说明，先读注释再改值。

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
