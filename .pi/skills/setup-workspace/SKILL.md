---
name: setup-workspace
description: 苏丹的游戏 mod 工作区的环境准备。先记下游戏目录，以及由它派生的创意工坊内容目录与原版配置目录，再记下 mod 安装目录和 dotnet 路径；dump 游戏代码与提取参考游戏美术是可选的，各写了什么时候需要、怎么准备。在路径未知或记错、要验证玩家给的路径、要 dump 游戏代码、或 `reference/` 为空时读取。
---

# 准备工作区（苏丹的游戏）

把「游戏在哪、三条路径是什么、运行时够不够」弄清楚并记录。**这一步只产出事实**，不产出 mod。
加载技能不等于获得写权限。咨询可以只解释方法。

## 状态文件里有什么（本工作区的约定）

`.gamer-agent.local.json`（**本工作区目录下**，在 `.gitignore` 里）是路径记录的唯一来源，由 `.pi/extensions/` 的工具、`tools/paths.mjs` 与 `check_runtime` 读写。字段：

| 键 | 含义 | 来源 | 谁用 |
|---|---|---|---|
| `gameDir` | 游戏安装目录（macOS 上含 `Sultan's Game.app` 的那一层，Windows 上含 `Sultan's Game_Data` 的那一层）| 玩家给的，或 `try_set_game_dir` 自动发现 | 派生 `vanillaDir` 与 `workshopDir`；`inspect_game_code` 从 `gameDir` 读游戏 |
| `workshopDir` | 创意工坊内容目录（`<Steam 库>/steamapps/workshop/content/3117820`）| **由 `gameDir` 按路径派生并记录**，不检查目录是否存在；目录为空时报 `EMPTY`，不是错误 | **只读参考**：读工坊里现成 mod 的 `info.json`。**不参与安装** |
| `modInstallDir` | mod 安装目录（`<MyDocuments>/DoubleCross/SultansGame/Mod`）| **由 `MyDocuments` 现算，不由 `gameDir` 派生** | 安装 mod 复制到此 |
| `runtime` | dotnet 可执行文件路径与版本 | `check_runtime` 探测后写入 | `inspect_game_code action=dump` 重建 dump 时定位 dotnet |

**原版配置目录不是键**：`vanillaDir` 每次由 `gameDir` 现算，写进文件只会过期。写文件时会顺手把旧的 `vanillaDir` 删掉。
`tools/paths.mjs` 只读写 `gameDir`、`workshopDir`、`modInstallDir` 三个键：读整个文件，按 key 合并，写回。`runtime` 与其他工具写的键原样保留。
文件里存**绝对路径**。报告里的 `~` 只是打印用的缩写，读回来时先展开再判断。展开用 `os.homedir()`，不读 `HOME`：Windows 没有这个变量。

## 派生关系与「不得只设 `gameDir` 就收工」

`vanillaDir` 与 `workshopDir` 都由 `gameDir` 派生：把 `gameDir` 弄对（`try_set_game_dir` 或 `set_game_dir`），这两项会在**当前平台**上一起算好。
`modInstallDir` **不**由 `gameDir` 派生。游戏用 `Environment.GetFolderPath(MyDocuments)` 加 `Application.companyName`（`DoubleCross`）算 `modInstallDir`，与游戏装在哪无关。
macOS 的 `MyDocuments` 是 `$HOME`，Windows 的是 `%USERPROFILE%\Documents`。`mod-repo.json` 的 `modInstall` 记着同一条推导。
所以只把 `gameDir` 弄对，`modInstallDir` 仍可能是错的。

报告逐行叫 `gameDir`、`vanilla`、`modInstallDir`、`workshopDir`；`vanilla` 这一行就是派生的 `vanillaDir`，命令行与工具读的是同一份判定，看哪一份都一样。

**必填与附加**：`gameDir`、`vanilla`、`modInstallDir` 三行都必填。任一行不是 `OK` 就是失败。
`workshopDir` 只是**只读参考**，**永不产 FAIL**（最多 `MISS` 或 `EMPTY`）。`EMPTY` 表示玩家没订阅任何工坊内容，不是错误。

## 完成标准

**三个位置都能用才算准备好**：`gameDir`、`vanilla`、`modInstallDir` 三行都是 `OK`。`workshopDir` 要么 `OK`，要么明说「玩家没订阅工坊内容」。
`vanillaDir` 与 `workshopDir` 由 `gameDir` 派生，把 `gameDir` 弄对就会一起算好。**不得设完 `gameDir` 就收工。**
`modInstallDir` 报 `MISS` 时，让玩家在 mod 面板点「模组目录」（ModList）：这个按钮会把目录建出来，然后再查。

报证据，不报感觉。按实际做过的分支报：

1. 必需：`node tools/paths.mjs check` 打出 `PASS`，或三个位置各一行 `OK`。`modInstallDir` 的证据是同级 `ModLog/__mod.log`，或父目录名为 `SultansGame` 且目录已存在。
2. 做了 A：`status` 的 `PASS` 或 `PARTIAL` 行，加 `action=setup` 的 `PASS` 或 `SKIP`。没做就明说「不需要 dump 代码」。
3. 做了 B：`--check` 说参考集完整。没做就明说 `reference/` 不用。

## 工具分工（不得混用。判据是同一份实现，见 `tools/paths.mjs`）

| 工具 | 做什么 | 副作用 |
|---|---|---|
| `try_set_game_dir` | **确保游戏目录已就绪**（无参、幂等）。已就绪且派生的两条与当前平台一致时只回报。没就绪或过期时自己找，找到才记录 `gameDir` 与派生的 `workshopDir`、`modInstallDir`。| 写 `.gamer-agent.local.json`（只在真的记下了新值时）|
| `set_game_dir` | **记录一个具体的游戏目录**（玩家给的，或你自己找到的）。先用游戏自己的文件验这条路径；不过就自己找，找到的落库并报 `WARN`；都失败就报 `FAIL`，**什么都不写**。| 写 `.gamer-agent.local.json`（`PASS` 或 `WARN` 时）|
| `check_game_paths` | **只验**（只读）：核对玩家给的或已记录的路径，逐行报判出 `OK`、`MISS`、`EMPTY`、`FAIL` 的那个哨兵。不写文件，不找游戏，不建目录。| 无 |
| `check_runtime` | **只查 .NET SDK >= 8**，并记下 dotnet 路径。**不找游戏**。缺 SDK 时用 `install_runtime`：`install_runtime` 只打印安装步骤，不下载、不安装。| 写 `.gamer-agent.local.json` 的 `runtime` 段 |

三个路径工具的判据是 `.pi/extensions/` 调用 `tools/paths.mjs` 的 `judge`、`ensureGameDir` 与 `setGameDirWithFallback`，所以命令行与工具不会对「哪个路径算合格」给出两种答案。

## 怎么用

- **要安装 mod 或读原版数据，而路径未知或已变化**：跑 `try_set_game_dir`（无参，确保就绪）。已记录且仍有效时不必每轮重复检查。
- **只想知道缺哪一项**：跑 `check_game_paths`。`check_game_paths` 也能接 `gameDir`、`workshopDir`、`modInstallDir` 三个参数，只验那几条，不记录。三个都不传时才验已记录的那几条；一条都没记录就报 `FAIL: nothing to check`。
- **玩家给了路径**：用 `set_game_dir`。路径里没有游戏自己的文件时，`set_game_dir` 先自己找；找到了就报 `WARN` 并说明现在用的是哪条，找不到才报 `FAIL` 并**什么都没写**。
- **同一件事的命令行做法**：`node tools/paths.mjs check` 相当于 `check_game_paths`；`node tools/paths.mjs set --game-dir <游戏安装目录>` 相当于 `set_game_dir`；不带 `--game-dir` 的 `node tools/paths.mjs set` 相当于 `try_set_game_dir`。`check` 的退出码为 0，才继续往下做；参数写错时退出码是 2。
- **要 dump 代码而 SDK 未知**：跑 `check_runtime`。缺 SDK 时取 `install_runtime` 的安装指引，装好后**再检查一次**确认，再谈 dump。

## 失败阶梯

三个位置各有一个哨兵。哨兵不过就是不合格：`set_game_dir` 与 `try_set_game_dir` 都只记录通过哨兵的路径。

| 位置 | 哨兵 |
|---|---|
| `gameDir` | 目录里有**游戏自己的文件**：macOS 是 `Sultan's Game.app/Contents/Frameworks/GameAssembly.dylib` 或 `Sultan's Game.app/Contents/Resources/Data/il2cpp_data`（二者之一即可）；Windows 是 `Sultan's Game_Data/GameAssembly.dll` 与 `Sultan's Game_Data/il2cpp_data` 两个都要（未在 Windows 机器上实测）|
| `vanilla` | 由 `gameDir` 现算，目录里同时有 `cards.json` 与 `rite/` |
| `modInstallDir` | 同级有 `ModLog/__mod.log`；没有日志时，父目录名为 `SultansGame` 且目录已存在也算；目录要可写 |
| `workshopDir` | 每个工坊条目目录里有 `info.json` |

`steamapps/appmanifest_3117820.acf` **只是发现线索**：它说游戏在哪个库里，本身不算证据。清单在、目录里却没有游戏自己的文件时，`gameDir` 照样报 `FAIL`。

状态词只有四个。`OK` 表示过了哨兵。`MISS` 表示目录不存在或候选位置一个都没过。`FAIL` 表示目录在、哨兵不过。`EMPTY` 只出现在 `workshopDir`，不是错误。
`modInstallDir` 在装好游戏之后就有。若父目录是 `SultansGame` 而 `Mod` 不存在，它报 `MISS`；让玩家点 mod 面板的「模组目录」（ModList）按钮，这个按钮会把目录建出来。

1. `try_set_game_dir` 自己会找。它按平台找 Steam 根（Windows 用 `ProgramFiles` 与常见盘符下的 `SteamLibrary`，macOS 读 `~/Library/Application Support/Steam`），再读各库的 `config/libraryfolders.vdf`，每个候选都过 `gameDir` 的哨兵。
2. `try_set_game_dir` 失败时，把玩家的模糊线索（「装在 D 盘」「Steam 里」「下的那个」）变成候选目录。用 `check_game_paths` 逐个只读验证。挑中后用 `set_game_dir` 记录。
3. 这样都不行时，才问玩家。问的时候**先说清你已经试过什么**（找过哪些库、验过哪些候选），并给可照做的入口（Steam 的库列表、玩家上次安装时选的盘，或让玩家直接贴路径）。

**不得**猜路径、自己建目录，或用装 SDK 去「解决」找不到游戏的问题。

## 可选 A：dump 游戏代码

**默认不需要。** 这个游戏的 mod 只改数据，多数任务不需要 dump。需要查一个类型、一个方法或一条字符串时，才做这一步。做完得到的是可 grep 的源码树：`dump.cs` 加每类型一份 ISIL 方法体。

### A1. 看 dump 是不是当前时

```
inspect_game_code action=status
```

`PASS` 表示 dump 是当前时。`PARTIAL` 是业务结果，不是工具错误：下一次 `search`、`type`、`body` 会在同一次调用里重建。
`FAIL: no dump for this repository` 时下一步是 `action=dump`，`action=dump` 需要已安装的游戏与 .NET SDK。
`status` 打出 `GAME_NOT_FOUND` 时，传一次安装路径：`inspect_game_code action=status game=<安装目录，或该目录里的 .app>`。路径会被记住，后续调用不用再传。

### A2. dotnet 运行时（只有 dump 代码时用）

```
check_runtime
```

`PASS` 表示 dotnet SDK >= 8 已就绪。`check_runtime` 把路径写进 `.gamer-agent.local.json` 的 `runtime` 段。`FAIL` 的末行是 `NEXT: run install_runtime ...`。

```
install_runtime
```

`install_runtime` 只探测并打印安装步骤，不下载、不安装。用户级安装（`~/.dotnet` 或 `%USERPROFILE%\.dotnet`）不需要管理员权限，是首选方案。跑 `install_runtime` 打印的命令，再调一次 `check_runtime`。

### A3. 转储工具链（只有 dump 代码时用）

```
inspect_game_code action=setup
```

输出是 `PASS: Cpp2IL installed in <秒>s.` 或 `SKIP: Cpp2IL is already installed and runs (<秒>s).`。下一行是二进制路径，再下一行是 `sha256 <16 位十六进制>`。
这个摘要是信任锚。macOS 上二进制在本地签名，所以摘要与发布值不同，输出会说明这一点。
`setup` 把 Cpp2IL 下到 `~/.gamer-agent-pi/decompiled/tools/cpp2il/`，并按 `tools/toolchain.json` 校验。镜像按顺序试，每次尝试打一行 `source:`。Il2CppDumper 已随仓放在 `tools/il2cppdumper/`，`setup` 不下载 Il2CppDumper。

### A4. 失败码与下一步

| 输出 | 含义 | 下一步 |
|---|---|---|
| `GAME_NOT_FOUND: ...` | 安装目录不在这个工具认识的 Steam 库里 | 给 `status` 传 `game=<路径>` |
| `TOOLCHAIN_MISSING` | `tools/toolchain.json` 不存在 | 恢复 `tools/toolchain.json`，文件里写着 Cpp2IL 从哪来 |
| `TOOLCHAIN_UNSUPPORTED_PLATFORM` | `tools/toolchain.json` 没有当前平台的 Cpp2IL 资产 | 补一条资产，或自己把二进制放到目标路径 |
| `CPP2IL_DOWNLOAD_FAILED` | 所有镜像的大小或摘要校验都失败 | 输出里列了每次尝试与确切的目标路径；手动放好文件，再跑 `action=setup` 校验 |
| `CPP2IL_NOT_RUNNABLE` | 文件写好了但跑不起来（macOS 上未签名的 arm64 会被杀） | 再跑一次 `action=setup` 重新本地签名；仍失败说明资产不对 |
| `check_runtime` FAIL | dotnet 缺失或低于 8 | 跑 `install_runtime`，执行 `install_runtime` 打印的命令，再检查一次 |

## 可选 B：参考游戏美术

参考游戏美术是原版四张品级底板、卡面标题字体与十二张参考卡。只有在你要画一张像真卡的预览时才需要。

```
node tools/setup.mjs --check
```

列出已有的与缺的，并报出 `gameDir` 与 `vanilla` 两个判定。要提取：

```
node tools/setup.mjs
```

`node tools/setup.mjs` 读玩家自己的游戏，需要带 UnityPy 的 Python。首次会建 `.setup-venv/` 并在里面装 UnityPy。
pip 源按这个顺序试，直到成功：`--index` → `SUDAN_PIP_INDEX` → 清华 → 阿里 → 默认 PyPI（`tools/setup.mjs:183`）。
`node tools/setup.mjs` 只写 `reference/` 与 `.setup-venv/`。要指定游戏或解释器，用 `--game <安装目录>` 与 `--python <解释器>`。

## 相关技能

- 做 mod 本身（布局、`info.json`、表的合并、事件与仪式的写法）时，用 `mod-creator`。
- 把 mod 复制进 mod 安装目录、启用并从日志确认时，用 `mod-installer`。
- 画一张像真卡的卡面图时，用 `card-art`。写 mod 说明页时，用 `mod-page`。
