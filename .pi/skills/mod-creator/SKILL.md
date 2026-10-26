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

要改卡面图，或者改动需要图片时，读 `card-art`。需要玩家先就某个范围或某个值达成一致时，先把记录写进 `config/`，再生成页面和玩家讨论（`mod-page`）；玩家回话就改那几条记录。写完之后，`mod-installer` 负责把它装进游戏并读回日志。

## 要读游戏代码时

原版数据回答「有哪些字段」，不回答「游戏怎么处理这个字段」：默认值、判断顺序、谁先结算，这些只在代码里。这时用 `inspect_game_code` 读本机的 dump，不要用 `rg` 或 `sed` 去翻 dump 目录。

1. 先跑 `inspect_game_code action=status`。它给出五行：`dotnet`、`cpp2il`、`dumper`、`game`、`dump`。
2. `status` 不是 `PASS` 时，照它给的 `NEXT:` 做。`cpp2il` 缺失就跑 `action=setup`：它按 `tools/toolchain.json` 下载并校验工具，本机只下一次。
3. `action=search target=<名字片段>` 找类型与成员的名字。不知道类名时从这一步开始。
4. `action=type target=<类型>` 看字段、属性与方法签名。字段后的十六进制是该字段的内存偏移。
5. `action=body target=<类型> member=<方法名>` 看一个方法的方法体。
6. `action=search target=<文本> scope=bodies` 搜方法体里的内容，例如某个字段偏移被谁读过。加 `path=Game/` 只搜一个目录或一个类型。`search` 不区分大小写。
7. `action=strings target=<文本>` 找字符串字面量。

方法体是 ISIL 伪代码，不是 C#：没有字段名，也没有局部变量名。字段偏移是十进制（`[r14+40]` 是 `0x28`），反汇编段的偏移是十六进制（`+58h` 是 `88`）。不要把 ISIL 当源码读。

`rg` 只用于工具表达不了的三件事：带上下文行的正则、一次多模式、按行号读一段。其它都用上面这些动作：bash 不判断路径，猜错一次就白跑。

dump 在 `~/.gamer-agent-pi/decompiled/`，不在仓库里，也不要手改。结论要标构建。`status` 报 `PASS` 才说明 dump 对应这台机器上装着的游戏。

## mod 布局

```
<ModName>/
  info.json          必需
  preview.png|jpg    可选, 创意工坊缩略图, 游戏用 "preview.*" 通配, 不校验尺寸；不写时安装副本会得到占位图
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

目录条目分三种寻址方式，别把一种当成全部：

- **按 id 拼路径**：`rite/` 是唯一有代码字面量证据的——游戏用 `rite/{0}.json` 拼，文件名与 `id` 对不上，那个文件不会被读。`event/`、`loot/`、`init/`、`rite_template/`、`after_story/` 在原版与每一个 mod 里文件名都等于 `id`，名字对不上按缺陷处理。
- **按文件里的 id 字段**：`dt/` 一个文件一棵对话树，文件名是 `DT<n>.json`，树自己的编号写在 `dialog_tree_id` 里。这两个应当一致；原版有三个文件不一致（`DT3`、`DT4` 声明 `DT2`，`DT9` 声明 `DT7`，见 `schema/SCHEMA.md` 的原版缺陷表），照抄会跟着错。
- **按文件名当键**：`wizard/` 一个文件一个开场向导，游戏用 `init` 记录里的 `wizard` 字符串取它，那个字符串等于**文件名去掉 `.json`**（`wizard_sudan`）。文件里的 `id` 是大写形式（`WIZARD_SUDAN`），`name` 是显示文本，两者都不决定读哪个文件。

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

## 改玩家的存档（不是 mod）

存档不是 mod，改它不经过 mod 目录。工具是 `tools/save.mjs`：

```
node tools/save.mjs show  --save <存档文件>
node tools/save.mjs get   --save <存档文件> --path counter.7100001
node tools/save.mjs set   --save <存档文件> --path round=12          # 只打印，不写盘
node tools/save.mjs set   --save <存档文件> --path round=12 --write  # 写盘，先留 .bak
node tools/save.mjs cards --save <存档文件>
```

- **存档路径必须由玩家给**。游戏没有把存档位置写进任何我们读到的推导链，猜一个只会改错文件。
- **默认不写盘**。`set` 不带 `--write` 只打印改前改后；玩家确认后才加 `--write`。
- `--path` 用点号分段，数字下标表示数组元素，例如 `counter.7100001`。路径不存在时工具报 `FAIL`，不会新建。
- 写之前先跑一次 `node tools/lint.mjs --save <存档文件>`：它按 `schema/save-fields.json` 检查整份存档的形状。它报错说明这份存档不符合当前版本的字段表，不要继续改。

## 验收

**第一步必须做：调 `validate_mod`。** 参数是 `modDir`（例如 `your_mods/<ModName>`），可选 `vanilla`（原版 `config` 目录）。它跑的就是同一个 linter，但把 FAIL、WARN、INFO 分类报回来。这一步不做，不许说 mod 写完了。

看它的状态词再往下：

- `FAIL`：有硬错误，按消息改。
- `PARTIAL`：跑过的规则全过，但**没找到原版 `config`**，所以 id 冲突与标签检查没跑。先跑 `check_game_paths` 看缺哪一项，补上 `vanilla` 再验一次，不许当 `PASS` 用。
- `PASS`：规则全过。它不证明游戏会加载这个 mod，安装与实机验收另算。
- 原版自己也不干净：随包数据里有一条死结算分支、两个指向不存在 id 的操作。`schema/SCHEMA.md` 的 Known defects 一节列了它们，所以拿原版目录跑 lint 也不是零错误。

然后安装、启用，读 `~/DoubleCross/SultansGame/ModLog/<mod name>_local.log`。你要看到你改过的每个文件都有 `read mod <name> file: config/<file>`，并且没有 `mod <name> info.json invalid`。

缺文件是噪音，不是错误。只提供一个文件的 mod 会打出十八条警告，照样能用。
