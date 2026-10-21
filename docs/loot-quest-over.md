# 掉落表、任务、结局与后日谈

一个 mod 还能提供四样东西：掉落表、任务、结局与后日谈。游戏读取这四种记录时，只读本文列出的字段。其他字段一律忽略。

## 动手前要守的规则

**一个 mod 提供的是数据。** mod 是一组 JSONC 数据文件，没有编译，没有脚本，也没有插件接口。游戏只从下面这份清单里读文件。这份清单是完整的。mod 少给哪一项，加载器就为哪一项写一行 `file not exists`。所以这份清单从任何一个 mod 的日志里都能读出来。

```
config/game.json          config/tag.json            config/cards.json
config/init               config/over.json           config/rite
config/event              config/loot                config/dt
config/after_story        config/wizard              config/upgrade.json
config/quest.json         config/rite_template       config/rite_template_mappings.json
config/sfx_config.json    config/over_music_config.json
config/sfx_npc_role_dub.json                         config/sfx_settle_card_new.json
```

下面这些文件游戏自己也读，但不可 mod。玩家要求改这些文件时，直接说作为 mod 做不到：

`achievement.json` `credits.json` `gallery_cards.json` `gallery_cg.json` `imagestyle.json`
`mobile_help.json` `textstyle.json` `ui.json` `variable.json` `rite.json`

一个 mod 能提供的只有上面清单里的条目。只交一份文件很正常，也是对的。

**表条目按 key 合并。** `cards.json`、`upgrade.json`、`tag.json`、`quest.json`、`over.json`、`rite_template_mappings.json` 与 `sfx_*` 文件都是字典。mod 里只写要新增或修改的那几条记录，其余条目留给原版。`tag.json` 的 key 是标签的 code 字符串，不是 `id`。

**目录条目一个文件一条记录。** `event/`、`rite/`、`loot/`、`init/`、`rite_template/`、`after_story/`、`dt/` 与 `wizard/` 都是这种形状。新增一条记录就是新增一个文件。目录条目里，文件名必须等于 `id`。`rite` 这一条是关键的：游戏用 id 拼路径（字面量 `rite/{0}.json`），名字对不上的文件根本不会被读。其余目录在现存每一个 mod 里都是同样的行为。

**改一条原版记录，要用整文件重述。** 目录条目没有字段级合并，所以改一条原版记录，等于把那个文件整份照抄过来再改。下一次游戏更新会挪动原版文件，后来的人必须能照着重新应用改动。

**JSONC 规则。** 游戏读取器接受 `//`、`/* */`、尾逗号与 BOM。按原版的写法写。不要跑严格的 JSON 格式化器。也不要重排原版文件的排版：缩进、对齐、换行、空行都不要碰，只改要改的那个值。排版一变，diff 就变成整个文件，下一个游戏版本更新时无法对照。

**重复键是追加，不是笔误。** `"event_on"` 写八十次就是加八十个事件：

```jsonc
"success": {
    "event_on": [5300300, 5300301],
    "event_on": 5300066
}
```

这样写等于加三个事件。绝不要用 JSON 库把配置文件读成对象再写回：字典只保留最后一个值。`settlement` 数组是重复键出现的另一处，在 `result` 里面。

**每个新 id 是自己的责任。** 挑 id 之前先查原版和每一个已安装的 mod：`node tools/lint.mjs --mod-root <ModRoot>` 两处都查。

## 掉落表

掉落表是目录条目，位置是 `config/loot/<id>.json`，一个文件一张表。文件名必须等于 `id`。

```jsonc
{
    "id": 6000004,
    "name": "情报掉落",
    "repeat": 1,
    "type": 2,
    "item": [ { "type": "card", "id": 2000032, "num": "1", "weight": 60 } ]
}
```

`type` 是常量，不是自由文本。引擎拿 `type` 与四个值比较：

| `type` | 每次抽什么 | 原版数量 |
|---|---|---|
| `2` | 每次抽一次带权选择 | 125 |
| `3` | 每次抽一次带权选择，先排除玩家已有的条目 | 55 |
| `4` | 不重复地做 `repeat` 次**带权**抽取：`repeat` 就是「n 中选 m」的 `m`，算法整体跑一遍，不是跑 `repeat` 遍 | 2 |
| `99` | 每条合格条目都抽，忽略权重，跑 `repeat` 次 | 11 |

`type: 4` 时，`repeat` 就是「n 中选 m」的 `m`。其余 `type` 下，`repeat` 是独立抽取的次数。原版 188 张表用 `1`，其余用 3、6 或 13。

每条 `item` 是 `{type, id, num, weight, condition}` 这五个键。`type` 的取值是 `card`、`event`、`rite` 与 `loot` 四个，其中 `loot` 表示表套表。`weight` 是相对值，只有比值有意义：`SimpleWeightLoot` 确实是把权重加起来之后用 `Random.Range` 抽。`num` 是给几条，原版写成字符串（`"1"`）。`condition` 过滤条目，工作方式与游戏里每一个条件一样。

原版计数：193 张表，1280 条 `item`（870 张卡、215 个事件、171 个仪式、24 个掉落表）。

`item` 对象上有两个警告。

1. `refLoot` 是历史键。加载器只注册 `type`、`id`、`num`、`weight` 与 `condition`，没有一条原版 `item` 带着 `refLoot`。要套表就写 `"type": "loot"`。
2. `condition` 会被读进来，但从不求值。`SimpleWeightLoot`、`WeightedNChooseM`、`RealGenCard` 与 `Generate` 都构造了 `ConditionContext`，四个都没有调 `IsSatisfied`。所以不要用 `condition` 闸住掉落。要限制掉落，要么拆表，要么把闸设在结算上。

## 任务

任务是表条目，位置是 `config/quest.json`，这是一张按 `id` 索引的表。mod 只写要新增或修改的那几个 `id`。

```jsonc
"3300001": { "id": 3300001, "name": "坠落的初端", "text": "...", "favour_text": "...",
             "upgrade_point": 1, "icon": "cards/2000001",
             "target": [ { "text": "完成1局苏丹的游戏", "show_counter": "",
                           "condition": { "global_counter.7220001>=": 1 } } ] }
```

加载器真正注册的只有七个字段：`id`、`name`、`text`、`icon`、`favour_text`、`upgrade_point` 与 `target`。对象里别的字段都被丢掉。

- `target[]` 列出必须成立的条件。`condition` 是普通条件。`text` 是玩家读到的那一行，它经过 `FormatStringVariable`，所以 `{变量}` 有效。`show_counter` 指定一个计数器，显示在 `text` 那一行旁边；`show_counter` 留空就是不显示，由 `StoryTargetItemController.Init` 里的 `String.IsNullOrEmpty` 决定。原版 193 条 `target` 都带条件。
- 任务上与 `target` 上都有 `isComplete`。`isComplete` 是存档侧的状态，负责那个勾的贴图。不要写 `isComplete`。
- `upgrade_point` 是这个任务值多少。完成提示会显示 `upgrade_point`。原版 161 个任务每个都是 1。
- `target.value` 是一个显示进 `target` 那一行的数字。`StoryTargetItemController.Init` 把 `target.value` 括起来再拼上去。`target.value` 从不参与比较。原版没有任何 `target` 写 `target.value`，它在 `questTargetItem` 的 `legacy`（历史键）列表里。
- `pre` 什么都不做。`pre` 在 `quest.json` 里到处都是（161 个值，每个是另一个任务 id），但字符串 `pre` 在 `global-metadata.dat` 里根本不存在。所以加载器没有键可匹配。`pre` 与事件上的 `auto_start` 是同一种历史键。不要拿 `pre` 搭任务链。

## 结局

结局是表条目，位置是 `config/over.json`，这是一张按 `id` 索引的表。mod 只写要新增或修改的那几个 `id`。

加载器把十二个字段全部注册了，所以这里没有死键：`id`、`name`、`sub_name`、`text_extra`、`open_after_story`、`text`、`manual_prompt`、`success`、`comment`、`bg`、`icon` 与 `title`。

- `name`、`sub_name`、`text`、`bg`、`icon`、`title`、`manual_prompt` 与 `comment` 都是显示用的。`comment` 注册了，但没有一个原版结局用它。
- `open_after_story: 1` 让这个结局继续进后日谈。`OverNewStep2StoryController` 把 `open_after_story` 当作 `Action<bool> hasAfterStory`，所以是 `open_after_story` 决定跳不跳。原版 159 个结局里 108 个写了它。
- `success` 决定回顾界面用哪个标题（`OverNodeController`）。`success` 为 `0` 时显示 `DeadTitle`，其他任何值显示 `SuccessTitle`，而 `2` 另外把 `VictoryIcon` 打开。所以失败结局写 `0`，胜利写 `1`，胜利并带胜利图标写 `2`。原版：63 个是 `1`，46 个是 `2`，4 个是 `0`，46 个没写。
- `text_extra` 会被读。`text_extra` 是一个 `RiteNode.Settlement[]`。`OverNewStep2StoryController` 先显示结局自己的 `text`，再遍历 `text_extra`（长度在 `+0x18`，每条条目的 `condition` 在条目自己的 `+0x18`）。每一条条件成立的分支，那一段都追加上去。所以想多出一段，就写一条带自己条件的分支。

## 后日谈

后日谈是目录条目，位置是 `config/after_story/<characterCardId>.json`，一张角色卡一个文件。文件名里的 id 是卡的 `id`，不是新的编号段。原版 66 个文件：61 个角色加 5 个道具。

- `pic` 是显示的那张画。
- `close_condition` 会被求值。页面循环调 `condition.IsSatisfied`；`close_condition` 成立时，游戏跳过这一页、不渲染它。没有原版文件把 `close_condition` 写成活的：66 个里 59 个用同一份内容把它注释掉了，`{ "!s1": 1 }`。
- `prior` 与 `extra` 都是 `RiteNode.Settlement[]`，与仪式用的分支形状一样：`{condition, result_text, pic, result, action, key, sort}`。两者不是互相替代的关系，也不是同一个列表的两半：`prior` 有优先权。
- `prior` 是那一段开场白。游戏先走 `prior`，取第一条通过的分支，跑它的 `result` 再跑它的 `action`，然后返回。所以 `extra` 从来不会被读。66 个原版文件全都把 `prior` 声明成 `[]`。往 `prior` 里写一条，整个尾声就变成那一段。
- `extra` 才是尾声本身。每一条通过的分支都成为一页，按数组顺序。通过要满足三条：带 `key` 的分支必须匹配存档里的 `after_story_key`（没有 `key` 的分支跳过这项检查）；`condition` 必须成立；`result_title` 与 `result_text` 不能都空着。所以一张有 385 条分支的卡渲染成的是一个由世界状态做闸门的 385 页轮播，而不是从 385 条里挑一页。7750 条原版分支每条都带一个 `key`，例如 `2000001_extra_1`，写一个。这个 `key` 还被传给 `Datapool.SetOverId`，页面的正文与上一页下一页按钮都靠 `key` 定位。
- `sort` 落在分支上，但找不到读 `sort` 的地方，所以不要靠 `sort` 排页序。你能看见、能控制的是数组顺序。

存档把 `prior` 存成字符串键、把 `extra` 存成集合，所以同一份配置可以被好几局复用。
