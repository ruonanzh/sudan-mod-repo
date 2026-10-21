# 苏丹的游戏 mod 工作区

**Sultan's Game**（苏丹的游戏）。mod 只是**数据**：JSONC 文件，加上 PNG 图片与音频。没有编译，没有脚本宿主，没有插件 API。Windows 与 macOS 使用同一份 mod 包。

本仓是这个游戏的 mod 开发环境。玩家与 agent 都用它。

## 第一条：不要猜

**永远不要猜。** 结论只能来自三处：代码（反编译产物、工具源码）、文件（原版语料、本仓文件）、网站（官方文档、商店页）。

- 要说「游戏怎么处理这个字段」，去读代码或原版文件，给出位置。
- 要说「这个目录在哪」，去读推导链或问玩家，不要按别的游戏的习惯推断。
- 要说「这个功能不存在」，先查过再下结论：反编译产物里搜字符串字面量，原版语料里数出现次数。
- 查不到就写「未确认」，并说清下一步该查什么。把猜测写成事实，比说不知道代价大得多。

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

- **`reference/` 不进 git，它由玩家的安装生成。**
  里面是四张品级底板、卡面标题字体和十二张参考卡。美术版权在发行商，字体是商业授权，所以这些一个都不能再分发。
  由 `node tools/setup.mjs` 生成，或第一次打开编辑器（`tools/page.mjs`）时自动生成。环境准备与提取细节见 `tools/setup.mjs` 的文件头注释。

- **脚本优先用 `node`。** 产品自带 node。`tools/lint.mjs` 无依赖。

## 目录地图

- `AGENTS.md` —— 本文件：固定的环境事实与边界。
- `script/` —— 测试与维护者的工具。`run-tests.mjs` 是唯一入口；`gen-field-tables.mjs` 从字段普查重建 `schema/fields.json`；`prompt-standard.md` 是提示词写作标准，改本文件或任一 `SKILL.md` 前先读它。
- `.pi/skills/` —— 分步指导。读匹配的那一份，每份自己写了触发条件。
  - `setup-workspace` —— 环境准备：先确定 mod 根目录（必需）；dump 游戏代码的工具链、参考游戏美术都是可选的，用到时才准备。开局或换机器先读这一份。
  - `mod-creator` —— 主参考：mod 布局、`info.json`、mod 能提供哪些 config、合并语义、JSONC 规则，以及带可用示例的卡与事件/仪式写法。
  - `mod-installer` —— 把 mod 复制进 mod 根目录、启用它、再从日志确认。
  - `card-art` —— 图片怎么制作：尺寸、命名、生成卡面图的提示词，以及一张贴图替换掉什么。
  - `mod-audio` —— 换游戏里已有的音频：文件名即片段名、能用的格式，以及为什么只能替换不能新增。
  - `mod-page` —— 写 mod 说明页：一个本地 HTML 页，列出这个 mod 改了哪些记录与字段，玩家可以在上面标注意见。本文件提到的「mod 说明页」就是它。
- `schema/` —— 唯一事实来源，也是字段规则的唯一所在。
  `fields.json` 存每种节点的形状，`vocab.json` 存时机、条件、操作的词汇表，`save-fields.json` 存存档形状；`SCHEMA.md` 由 `tools/gen-schema-doc.mjs` 从这三个文件生成。**不要手改 `SCHEMA.md`。**
- `tools/lint.mjs` —— 校验器。安装前先跑。它读 `schema/`。
  `--save <file|dir>` 改为校验存档文件，而不是 mod。
- `your_mods/` —— mod 产出区。mod 只写在这里，形式是 `your_mods/<ModName>/`。
- `mod-repo.json` —— 机器可读的游戏与路径声明。
- `reference/` —— 预留。这个版本里没有内容。

## 硬边界

1. **目录式条目：改一条原版记录，等于把那个文件整份照抄过来再改。** `config/event/<id>.json`、`config/rite/<id>.json`、`config/loot/<id>.json` 以及其他目录式条目，一个文件就是一条记录，游戏用整个文件替换原版那一份，没有字段级合并。所以想让一条原版事件加一句台词，也得先复制它的完整 JSON。
   整份照抄原版文件时，还要在 mod 说明页里记下你实际改了哪几个字段。下一次游戏更新会挪动原版文件，后来的人必须能照着重新应用你的改动。

2. **表式条目：按 id 合并，只交你要动的那几条。** `config/cards.json` 是一张表，文件里每个 id 就是一条记录。mod 里只写你要新增或修改的那几个 id，游戏按 id 把它们并进原版表，其他 id 不受影响。`config/upgrade.json`、`config/tag.json`、`config/quest.json`、`config/over.json` 同理。

3. **每个新 id 都是你的责任。** 这里没有注册表，游戏也不会警告。创意工坊已经有两个已发布的 mod 在卡 id `9000001` 上撞车。挑 id 之前先查原版和每一个已安装的 mod。`tools/lint.mjs --mod-root <ModRoot>` 两处都查。

4. **不要动别人写的 `config/` JSON 文件的排版**（`config/` 目录下的 `.json`）。缩进、对齐、换行、空行都不要碰，只改你要改的那个值。理由是排版一变，diff 就变成整个文件，谁都看不出你实际动了哪几个值，下一个游戏版本更新时也无法对照。

5. **重复键是语法，不是笔误 —— 所以按文本改，不要走「读成对象再写回」。** `"event_on"` 写八十次就是加八十个事件。任何「解析成对象、再序列化回去」的往返都会把重复键合并成一个（后写的盖掉前面的），八十个事件于是变成一个。要在原文里直接改字。

6. **不要跑严格的 JSON 格式化器。** 游戏接受 `//`、`/* */`、尾逗号与 BOM，原版自己四种都用。

## 汇报前先自验

这里没有东西能编译，所以「做完了」这个说法需要三件证据：

1. `node tools/lint.mjs your_mods/<ModName>` 退出码为 0。原版并不干净：随包数据里有一个文件的 `settlement`（正常结算）分支是死分支，还有两个操作指向不存在的 id。`schema/SCHEMA.md` 列了它们，所以那里报错不是你的 bug。
2. mod 已安装，且玩家已启用。它的 `_local.log` 里有 `read mod <name> file: config/<你改的东西>`。
3. 改动在游戏里看得见。按玩家操作过的卡或仪式 id 去读日志。

lint 干净加日志干净，并不能证明改动在游戏里看得见。问玩家看到了什么，不要拿信心填这个缺口。
