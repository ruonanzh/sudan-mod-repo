# 事件：`config/event/<id>.json`

这一份讲一个事件文件放在哪、怎么写、哪些键有效、哪些键被读取器忽略。

## 一个文件一条记录

`config/event/` 是目录条目。一个文件就是一条记录。游戏用整份文件替换原版的那一条，没有字段级合并。

- 文件名必须等于记录的 `id`。
- 新增一条原版没有的事件，就新增一个文件 `config/event/<id>.json`。
- 修改一条原版事件，先把原版那一份整份复制出来，再改要改的值。
- mod 里只放你要动的那几条记录，其余记录归原版。

## 先读原版，再动原版

原版数据是 mod 配置格式唯一完整的描述。开发者在原版文件里留了中文 `//` 注释，逐个解释字段。改一个事件之前，先读那个事件文件。

`config/event/5300000.json` 是教学局的开场，也是一个事件最好的单一样例文件。这个文件就地写明了 `confirm`、`option`、`success` 与 `failed`，短写与长写两种形状并排给出。

## 一个事件文件

一个事件的行为由三个键表达。`on` 写事件何时触发。`condition` 写必须成立什么。`settlement` 是一串带 `action` 的分支。

```jsonc
{
    "id": 5300029,
    "text": "书店营业",              // 只用于显示, 没有代码读它
    "is_replay": 1,                 // 能不能触发多次
    "auto_start_init": [1],         // init 配置 1 启动时就已经启用
    "start_trigger": true,          // 未决
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

## 历史键

**历史键**指的是原版文件里写着、但现在这一版游戏不读的键。权威清单是 `schema/fields.json` 里每种记录自己的 `legacy` 数组；`node tools/lint.mjs` 见到历史键会报 `LEGACY_FIELD`。

`EventNode` 没有 `auto_start` 字段。原版有 1520 个事件文件带着 `auto_start`。这个键什么都不做。`auto_start` 在 `schema/fields.json` 的 `legacy` 列表里，是历史键。真正的字段是 `auto_start_init`。

`text` 在 1867 个原版事件上都被写了。没有任何代码读 `text`。`text` 不在那七个注册键里，是历史键。把 `text` 当成给打开这个文件的人看的标签。

## 事件分支的行为

事件分支没有 `condition`。`EventTrigger.DoSettlements` 按数组顺序执行每一条分支，一条都不判断。1869 条原版分支里 0 条带这个键。事件分支里写的 `condition` 会被静默忽略。选择分支由 `rite.settlement` 负责。

`tips_resource` 与 `tips_text` 被写进 1813 条事件分支。这两个键不是结算的键。`tips_resource` 在二进制里根本不是字符串。`tips_text` 是 `rite` 的键。这两个键都被忽略。

事件分支不显示自己的文字。结算形状里有 `result_text`。事件这一侧从不读 `result_text`。玩家看到的是 `action.prompt`。1869 条原版分支里 622 条写了 `action.prompt`。措辞写在 `action.prompt` 里。

## `auto_start_init`

`auto_start_init` 是一串 `init` 配置 id。`config/init/1.json` 是正常的一局，所以 `[1]` 的意思是「正常局一开局就启用」。

一个事件不在任何 `auto_start_init` 列表里，也没有被别的事件的 `event_on` 引用时，这个事件不跑。要让一个全新的事件每轮都跑，写 `"auto_start_init": [1]`。

## 时机键

`on` 里写时机键。时机键一共正好 29 个，完整的集合在 `schema/vocab.json` 的 `timings.keys` 里。不在这个集合里的键永远不会被排期。

这 29 个键不必记住，也不要相信任何文档里抄的清单。跑 `node tools/lint.mjs <modDir>`，`UNKNOWN_TIMING` 会指出不在集合里的键。

`on` 的值有两种写法：

| 写法 | 含义 |
|---|---|
| 数字 | 每几轮触发一次。`1` 表示每轮触发 |
| `[lo, hi]` | 在这个区间里随机取一轮触发 |

`"on": { "round_begin_ba": 1 }` 表示每轮开始。

29 个时机键里有 8 个被引擎注册、原版从未写过。`schema/vocab.json` 的 `timings.unused_in_vanilla` 列出这 8 个。

## 条件键

条件键把运算符带在身上。

| 条件键 | 说明 |
|---|---|
| `counter.7000017<=`、`rare<` | 比较运算符写在键里 |
| `!` | 取反 |
| `s1`..`sN` | 把范围限定到仪式的某个槽位 |
| `r1:体魄`、`hand_have.<id>`、`table_have.<id>`、`have.<id>`、`cost.<tag>`、`is`、`type`、`any`、`all` | 原版实际用到的其余形状 |

完整语法与原版实际用到的形状在 `schema/vocab.json` 的 `conditions.used_shapes` 里。

## 操作键

操作键把参数带在身上。读取器认这些键：`rite`、`card`、`g.card`、`event_on`、`event_off`、`clean.self`、`clean.rite`、`clean.sN`、`counter+<id>`、`counter=<id>`、`global_counter+<id>`、`total.<id>+<tag>`、`pop.<shorthand>`、`loot`、`coin`、`table`、`choose`、`option`、`confirm`、`success`、`failed`、`case:op1`..、`delay`、`copy`、`sleep`、`focus`、`slide`、`rebirth.<slot>`、`over`、`steam_achievement`、`enable_auto_gen_sudan_card`、`begin_guide`、`close_story`、`change_name`、`change_card_name`、`change_card_text`、`change_desk_bg`、`change_location_icon`、`debug`、`no_show`、`no_prompt`。

仪式里限定槽位的键用 `s1`..`sN`。骰子检定用 `r1`..`r5`。

## `success` 与 `failed`

`success` 与 `failed` 把 `confirm`、`option` 或骰子检定之后的分支包起来。`case:opN` 选第 N 个选项那一条分支。

