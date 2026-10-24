---
name: mod-creator
description: 写苏丹的游戏 mod、改苏丹的游戏 mod 的主参考。在你翻原版配置之前、写第一个文件之前、回答「一个 mod 能做什么」之前，先读这一份。覆盖 mod 布局、`info.json`、mod 能提供的 config 条目全集、按 key 合并与整文件重述的区别、JSONC 规则、带可用示例的卡与事件/仪式写法，以及 id 与贴图上已经验证的事实。苏丹的游戏 mod 只是数据：没有编译，没有代码。
---

# 写苏丹的游戏 mod

一个 mod 就是一个装着 JSONC 与 PNG 的文件夹。没有编译步骤，也没有代码。

## 动手前必须先读什么

原版数据是这个格式唯一完整的描述，而且带注释。先读你要改的那个文件，再动它。

**原版数据在哪里：游戏安装目录下的 `StreamingAssets/config/`。**

| 平台 | 路径 |
|---|---|
| macOS | `<游戏安装>/Sultan's Game.app/Contents/Resources/Data/StreamingAssets/config/` |
| Windows | `<游戏安装>/Sultan's Game_Data/StreamingAssets/config/` |

`cards.json`、`event/`、`rite/`、`tag.json`、`init.json` 这些元数据都在这个目录里。mod 的 `config/` 就是它的镜像：路径相对 `config/` 写，例如原版的 `config/event/5300000.json` 在 mod 里就是 `config/event/5300000.json`。

不知道 `<游戏安装>` 是哪台机器上的哪个目录时，跑 `node tools/setup.mjs --check`：它打印 `gameDir` 与 `vanilla` 两行，`vanilla` 就是上面那个 `config/` 目录。路径判据与准备步骤见 `setup-workspace`，不要在别处猜。

开发者在这些文件里留了中文 `//` 注释，逐个解释字段。`config/event/5300000.json` 是教学局的开场，就地写明了 `confirm`、`option`、`success` 与 `failed`，短写与长写两种形状并排给出。它是最好的单一样例文件。

要改卡面图，或者改动需要图片时，读 `card-art`。需要玩家先就某个范围或某个值达成一致时，答案是页面：读 `mod-page`。写完之后，`mod-installer` 负责把它装进游戏并读回日志。

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

目录必须用 `create_mod_folder(name=...)` 建：它建出 `your_mods/<name>/`，并把会话绑定到它。它同时是写入隔离的边界——守卫只允许写绑定目录里面——所以建目录只走这一条路。

- `name` 是小写 snake_case：`a-z`、`0-9`、`_`，以字母开头，最多 40 个字符（`broken_blade`，不是 `Broken Blade`）。它是文件夹名，不是面板名：面板上显示的名字是 `info.json` 的 `name`。
- 它不建任何源文件。`info.json` 自己写（下一节）。
- 这些失败都是 `create_mod_folder` 的 `throw`，消息里已经写了下一步，照做即可。不要为同一个会话建第二个目录。

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

| 条目 | 是什么 | 常用 |
|---|---|---|
| `config/cards.json` | 全部卡，1294 条 | **常改**：加卡、改卡数值 |
| `config/rite/` | 仪式，一个 `id` 一个文件，1498 条 | **常改**：加事件线、加仪式 |
| `config/event/` | 事件，一个 `id` 一个文件，1867 条 | **常改**：加剧情触发 |
| `config/upgrade.json` | 命运商店条目，50 条 | **常改**：让玩家拿到新卡 |
| `config/tag.json` | 标签（状态与属性），444 条 | 常改：新卡要用新状态时 |
| `config/loot/` | 战利品表，一个 `id` 一个文件，193 条 | 常改：仪式或事件的奖励 |
| `config/over.json` | 结局，159 条 | 少改：通常只在做新结局时 |
| `config/after_story/` | 后日谈段落，一个 `id` 一个文件，66 条 | 少改 |
| `config/quest.json` | 任务，161 条 | 少改：多数 mod 用事件代替 |
| `config/init/` | 开局（难度、起始卡），2 个文件 | 少改：改开局规则时 |
| `config/wizard/` | 开场向导对话，2 个文件 | 少改 |
| `config/dt/` | 对话树，9 个文件 | 少改：要连续多段对话时 |
| `config/rite_template/` | 仪式面板模板，252 条 | 少改：只影响外观 |
| `config/rite_template_mappings.json` | 仪式到模板的映射 | 少改：只影响外观 |
| `config/game.json` | 全局开关与派生规则 | 少改 |
| `config/sfx_config.json` | 音乐与音效配置 | 少改：`mod-audio` 用 |
| `config/sfx_npc_role_dub.json` | 角色配音映射 | 少改 |
| `config/over_music_config.json` | 结局音乐映射 | 少改 |
| `config/sfx_settle_card_new.json` | 结算新卡音效映射 | 少改 |
| `image/` | 贴图，递归遍历，同名覆盖原版贴图 | 加卡面、改图标时 |
| `bgm/` | 音频，文件名即片段名，只能替换已有片段 | 换音乐或音效时，写法见 `mod-audio` |

前六行是常改的六项：`cards.json`（加卡、改数值）、`rite/`（加玩法）、`event/`（加剧情）、`upgrade.json`（放进命运商店）、`tag.json`（新卡要用的状态与属性）、`loot/`（仪式或事件的奖励）。这六项之外的条目，先确认真的需要再写。

发卡有三条路：命运商店（`upgrade.json`）、事件结算、战利品表。只做命运商店条目时，玩家要自己攒够资源才会看到那张卡。

下面这些游戏自己也读，但**不可 mod**。玩家要求改这些时，直接说作为 mod 做不到：

`achievement.json` `credits.json` `gallery_cards.json` `gallery_cg.json` `imagestyle.json`
`mobile_help.json` `textstyle.json` `ui.json` `variable.json`

一个 mod 能提供的只有上面清单里的条目。只交一份文件很正常，也是对的。

## 两种合并行为，以及怎么区分

- **表条目按 key 合并。** `cards.json`、`upgrade.json`、`tag.json`、`quest.json`、`over.json`、`rite_template_mappings.json` 与 `sfx_*` 文件都是字典。只写你要新增或修改的那几条记录，其余归原版。`tag.json` 的 key 是标签的 **code 字符串**，不是 `id`。

- **目录条目一个文件一条记录。** 目录条目包括 `event/`、`rite/`、`loot/`、`init/`、`rite_template/`、`after_story/`、`dt/`、`wizard/`。新增一条记录就是新增一个文件。改一条原版记录要整文件重述，因为这里没有字段级合并。

目录条目里，文件名必须等于 `id`。这条规则对所有目录都成立，仪式只是证据最直接的一个：游戏用字面量 `rite/{0}.json` 拼路径，所以文件名与 `id` 对不上时，那个文件不会被读。其余目录在现存每一个 mod 里都是同样的行为，名字对不上按缺陷处理。

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

## 四种记录怎么写

这一份只讲结构与通用规则。某一种记录怎么写，读对应的一份：

| 要写什么 | 读哪一份 |
|---|---|
| 卡（含让玩家拿到这张卡的命运商店条目） | `docs/card.md` |
| 事件 | `docs/event.md` |
| 仪式（含触发、超时、结算顺序、条件辅助键） | `docs/rite.md` |
| 掉落表、任务、结局、后日谈 | `docs/loot-quest-over.md` |

每一份都写全了这一类记录自己的规则，读那一份不必回读本 SKILL。它们都会用到仓库里的数据与工具：有效键看 `schema/fields.json`，时机与条件语法看 `schema/vocab.json`，路径与校验靠 `tools/paths.mjs` 与 `tools/lint.mjs`。

## 验收

**第一步必须做：调 `validate_mod`。** 参数是 `modDir`（例如 `your_mods/<ModName>`），可选 `vanilla`（原版 `config` 目录）。它跑的就是同一个 linter，但把 FAIL、WARN、INFO 分类报回来。这一步不做，不许说 mod 写完了。

看它的状态词再往下：

- `FAIL`：有硬错误，按消息改。
- `PARTIAL`：跑过的规则全过，但**没找到原版 `config`**，所以 id 冲突与标签检查没跑。先跑 `check_game_paths` 看缺哪一项，补上 `vanilla` 再验一次，不许当 `PASS` 用。
- `PASS`：规则全过。它不证明游戏会加载这个 mod，安装与实机验收另算。

然后安装、启用，读 `~/DoubleCross/SultansGame/ModLog/<mod name>_local.log`。你要看到你改过的每个文件都有 `read mod <name> file: config/<file>`，并且没有 `mod <name> info.json invalid`。

缺文件是噪音，不是错误。只提供一个文件的 mod 会打出十八条警告，照样能用。
