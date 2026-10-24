# 苏丹的游戏 mod 工作区

**Sultan's Game**（苏丹的游戏）。mod 只是**数据**：JSONC 文件，加上 PNG 图片与音频。没有编译，没有脚本宿主，没有插件 API。Windows 与 macOS 使用同一份 mod 包。

本仓是这个游戏的 mod 开发环境。玩家与 agent 都用它。

## 环境事实

这些是固定的。记错会白白浪费回合。

- **mod 根目录在本仓之外。**
  macOS：`~/DoubleCross/SultansGame/Mod/`
  Windows：`%USERPROFILE%\Documents\DoubleCross\SultansGame\Mod\`
  游戏用 `Path.Combine(GetFolderPath(MyDocuments), Application.companyName, "SultansGame", "Mod")` 推出它。`MyDocuments` 在 macOS 上是 `$HOME`，在 Windows 上是 `Documents`。差别只有这一处。
  在 `your_mods/` 里干活。安装就是把文件复制到 mod 根目录，之后玩家还要在游戏内的面板里启用这个 mod。不要把文件夹放进去就当作它会被加载。

- **游戏自己的日志是最快的诊断入口。**
  `~/DoubleCross/SultansGame/ModLog/__mod.log` 是全局消息，`~/DoubleCross/SultansGame/ModLog/<mod name>_local.log` 是单个 mod 的消息。加载器每读一个文件写一行 `read mod <name> file: config/...`，每找一个缺的文件写一行 `mod <name> file not exists: config/...`。缺文件是 **Warning**，不是错误。先读日志，再猜。

- **不要自己在 mod 根目录里造「已启用列表」。** 哪些 mod 启用由游戏自己记（内存里的 `Global.mods`），玩家在游戏内面板里勾选。mod 不需要任何启用记录文件；伪造一个只会让状态和游戏不一致。

- **mod 只提供数据。** 没有 `.dll`、没有 `.cs`、没有脚本、没有 AssetBundle。想要的改动如果不能用下面的数据键表达，就是做不到 —— 这时要说做不到，而不是编一条代码路线。有一个热门 mod 随包提供 `code/` 目录，里面全是 Python，游戏从不读它。

- **`reference/` 里的卡面随仓库提供。**
  四张品级底板（`reference/plates/`）与十二张参考卡（`reference/cards/`）是公开的卡面，供预览页与画风参考使用，已进 git。
  卡面标题字体不在仓库里（商业授权），缺字体时页面退回衬线字体。没有安装步骤，也没有 Python 依赖：`node tools/setup.mjs --check` 只报告缺什么。

- **脚本优先用 `node`。** 产品自带 node。`tools/lint.mjs` 无依赖。

## 目录地图

- `script/` —— 测试与维护者的工具。
- `docs/` —— 一份记录一份：`card.md`、`event.md`、`rite.md`、`loot-quest-over.md`。写哪类记录就先读那一份。
- `schema/` —— 工具与页面读的数据，agent 不直接改。
  - `SCHEMA.md` 是生成物（由 `tools/gen-schema-doc.mjs` 生成），**不要手改**。要查四份 `docs/` 之外的 kind，看它的 Field tables；lint 报的错若是原版数据自带，看 Known defects。
- `editors/` —— 玩家在应用里打开的页面与编辑器。任务不是改页面时，不要动它的源码。
- `your_mods/` —— mod 产出区。mod 只写在这里，形式是 `your_mods/<ModName>/`。
- `mod-repo.json` —— 机器可读的游戏与路径声明。
- `reference/` —— 随仓提供的美术：`plates/` 五张卡面底板，`cards/` 十二张风格参考（三种类型 × 四个品级）。预览与卡图都用它们，不需要提取。

## 硬边界

1. **目录式条目：改一条原版记录，等于把那个文件整份照抄过来再改。** `config/event/<id>.json`、`config/rite/<id>.json`、`config/loot/<id>.json` 以及其他目录式条目，一个文件就是一条记录，游戏用整个文件替换原版那一份，没有字段级合并。所以想让一条原版事件加一句台词，也得先复制它的完整 JSON。
   整份照抄原版文件时，还要在 mod 说明页里记下你实际改了哪几个字段。下一次游戏更新会挪动原版文件，后来的人必须能照着重新应用你的改动。

2. **表式条目：按 id 合并，只交你要动的那几条。** `config/cards.json` 是一张表，文件里每个 id 就是一条记录。mod 里只写你要新增或修改的那几个 id，游戏按 id 把它们并进原版表，其他 id 不受影响。`config/upgrade.json`、`config/tag.json`、`config/quest.json`、`config/over.json` 同理。

3. **每个新 id 都是你的责任。** 这里没有注册表，游戏也不会警告。创意工坊已经有两个已发布的 mod 在卡 id `9000001` 上撞车。挑 id 之前先查原版和每一个已安装的 mod。`tools/lint.mjs --mod-root <ModRoot>` 两处都查。

4. **不要动别人写的 `config/` JSON 文件的排版**（`config/` 目录下的 `.json`）。缩进、对齐、换行、空行都不要碰，只改你要改的那个值。理由是排版一变，diff 就变成整个文件，谁都看不出你实际动了哪几个值，下一个游戏版本更新时也无法对照。

5. **重复键是语法，不是笔误 —— 所以按文本改，不要走「读成对象再写回」。** `"event_on"` 写八十次就是加八十个事件。任何「解析成对象、再序列化回去」的往返都会把重复键合并成一个（后写的盖掉前面的），八十个事件于是变成一个。要在原文里直接改字。

6. **不要跑严格的 JSON 格式化器。** 游戏接受 `//`、`/* */`、尾逗号与 BOM，原版自己四种都用。

## 汇报前先自验

「做完了」不是一种感觉，是三件证据：`validate_mod` 通过、mod 已安装且玩家已启用、玩家确认改动在游戏里看得见。三步怎么做，写在 `.pi/skills/mod-creator/` 的验收一节与 `.pi/skills/mod-installer/` 里；这一节只说它们缺一不可。
