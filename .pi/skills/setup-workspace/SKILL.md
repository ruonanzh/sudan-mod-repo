---
name: setup-workspace
description: 苏丹的游戏 mod 工作区的环境准备。先确定 mod 根目录；dump 游戏代码与提取参考游戏美术两项是可选的，各写了什么时候需要、怎么准备。在路径未知、要 dump 游戏代码、或 reference/ 为空时读取。
---

# 准备工作区（苏丹的游戏）

这一步只产出事实，不产出 mod。必需项只有一件：**mod 根目录**。另外两项（dump 游戏代码、提取参考游戏美术）都是可选的，用到时再准备。

## 必需：mod 根目录

这个路径是**推导出来的**，不是设置项，没有环境变量能改它。游戏的推导链是：

```
Environment.GetFolderPath(MyDocuments) + Application.companyName + "SultansGame" + "Mod"
```

`Application.companyName` 是 `DoubleCross`。`MyDocuments` 在两个平台上不同：

| 平台 | MyDocuments | 结果 |
|---|---|---|
| macOS | `$HOME` | `~/DoubleCross/SultansGame/Mod/` |
| Windows | `%USERPROFILE%\Documents` | `%USERPROFILE%\Documents\DoubleCross\SultansGame\Mod\` |

这台机器上实测存在：`/Users/roninzhao/DoubleCross/SultansGame/Mod`，同一个父目录下还有 `ModLog/`。`mod-repo.json` 的 `modInstall` 也记着同一条推导，注明「Verified in game」。

判据：目录存在。全新机器上它由游戏创建；游戏没启动过就没有这个目录，先启动一次游戏。

## 路径不对时怎么办

`node tools/paths.mjs check` 判定三个必需目录，每个目录一个哨兵。哨兵不过时，工具报 `FAIL` 或 `MISS`，并打一行 `NEXT`：它不猜路径，也不渲染空结果。

| 位置 | 哨兵 | 不过时问玩家这一句 |
|---|---|---|
| `steam` | `steamapps/appmanifest_3117820.acf` 存在，它写的 `installdir` 在 `steamapps/common/` 下存在 | 「游戏是用 Steam 装的吗？装在哪个盘？」 |
| `vanilla` | 配置目录里有 `cards.json` 与 `rite/` | 「游戏装在哪个目录？第二个 Steam 库在哪个盘？」 |
| `modRoot` | 同级有 `ModLog/__mod.log`，且目录可写 | 「启动过一次游戏吗？是这台机器吗？」 |

状态词只有四个。`OK` 表示过了哨兵。`MISS` 表示候选位置一个都没过。`FAIL` 表示指定或记录的路径在、哨兵不过。`EMPTY` 只出现在 `workshop`，表示玩家没订阅，不是错误。

问清之后，写进 `.pi/paths.json` 并复查：

```bash
node tools/paths.mjs set --steam "<Steam 库>" --vanilla "<原版 config 目录>"
node tools/paths.mjs check
```

`set` 拒绝哨兵不过的目录，所以它写下的路径一定验证过。`check` 的退出码为 0，才继续往下做。

## 可选 A：dump 游戏代码

**默认不需要。** 这个游戏的 mod 只改数据，多数任务不需要 dump。需要查一个类型、一个方法或一条字符串时，才做这一步。做完得到的是可 grep 的源码树：`dump.cs` 加每类型一份 ISIL 方法体。

### A1. 找游戏（只有 dump 代码时用）

```
inspect_game_code action=status
```

dump 是当前时：

```
PASS: the dump is current. <dump dir> (75 MB, 1635 type files)   // 示例，数字随构建变化
  build: <label>, game binary <sha8>, metadata <sha8>
  coverage: <assemblies>
```

dump 缺失，或不是用现在这个二进制建的：

```
PARTIAL: the dump is stale.
  - <reason>
  game: <install dir>
  binary: <UnityPlayer or Data path>
  metadata: <global-metadata.dat>
  tools: <Cpp2IL> | <Il2CppDumper>
NEXT: action=search/type/body rebuild it by themselves; action=dump rebuilds now.
```

`PARTIAL` 是业务结果，不是工具错误。下一次 `search`、`type`、`body` 会在同一次调用里重建。重建耗时取决于机器与程序集数量，不要给玩家一个固定秒数。`game:` / `binary:` / `metadata:` 三行只在 dump 不是当前时出现。dump 是当前时，同样的事实写在 `build:` 行。

如果 `status` 打出 `game: not found`，或后续调用报 `GAME_NOT_FOUND`，传一次安装路径：

```
inspect_game_code action=status game=<安装目录，或它的 Data 目录>
```

路径会被记住，后续调用不用再传。

### A2. 运行时（只有 dump 代码时用）

```
check_runtime
```

`PASS` 表示 dotnet >= 8 已就绪。`FAIL` 的末行是 `NEXT: run install_runtime ...`。

```
install_runtime
```

这个工具只探测并打印安装步骤。它不下载、不安装。它给两条路：用户级安装（`~/.dotnet` 或 `%USERPROFILE%\.dotnet`，不要管理员权限），以及系统级安装作为备选。跑它打印的命令，再调一次 `check_runtime`。

### A3. 转储工具链（只有 dump 代码时用）

```
inspect_game_code action=setup
```

输出是两种之一：

```
PASS: Cpp2IL installed in 8.7s.
SKIP: Cpp2IL is already installed and runs (0.3s).
```

下一行是二进制路径，再下一行是 `sha256 <16 位十六进制>`。这个摘要是信任锚。macOS 上二进制在本地签名，所以摘要与发布值不同，输出会说明这一点。

`setup` 把 Cpp2IL 下到 `~/.gamer-agent-pi/decompiled/tools/cpp2il/`，并按 `tools/toolchain.json` 校验。镜像按顺序试，每次尝试打一行 `source:`。Il2CppDumper 已随仓放在 `tools/il2cppdumper/`，`setup` 不下载它。

### A4. 失败码与下一步

| 输出 | 含义 | 下一步 |
|---|---|---|
| `GAME_NOT_FOUND: ...` | 安装目录不在这个工具认识的 Steam 库里 | 给 `status` 传 `game=<路径>` |
| `TOOLCHAIN_MISSING` | `tools/toolchain.json` 不存在 | 恢复它，它写着 Cpp2IL 从哪来 |
| `TOOLCHAIN_UNSUPPORTED_PLATFORM` | `toolchain.json` 没有当前平台的 Cpp2IL 资产 | 补一条资产，或自己把二进制放到目标路径 |
| `CPP2IL_DOWNLOAD_FAILED` | 所有镜像的大小或摘要校验都失败 | 输出里列了每次尝试与确切的目标路径；手动放好文件，再跑 `action=setup` 校验 |
| `CPP2IL_NOT_RUNNABLE` | 文件写好了但跑不起来（macOS 上未签名的 arm64 会被杀） | 再跑一次 `action=setup` 让它本地签名；仍失败说明资产不对 |
| `check_runtime` FAIL | dotnet 缺失或低于 8 | 跑 `install_runtime`，执行它打印的命令，再检查一次 |

## 可选 B：参考游戏美术

参考游戏美术是原版四张品级底板、卡面标题字体与十二张参考卡。只有在你要画一张像真卡的预览时才需要。

```
node tools/setup.mjs --check
```

它列出已有的与缺的，并报出 `steam` 与 `vanilla` 两个判定。要提取：

```
node tools/setup.mjs
```

它读玩家自己的游戏，需要带 UnityPy 的 Python。首次会建 `.setup-venv/` 并在里面装 UnityPy。pip 源按这个顺序试，直到成功：`--index` → `SUDAN_PIP_INDEX` → 清华 → 阿里 → 默认 PyPI（`tools/setup.mjs:190`）。它只写 `reference/` 与 `.setup-venv/`。`tools/page.mjs` 第一次打开编辑器时也会跑同一次提取。

## 完成标准

报证据，不报感觉。按你实际做过的分支报：

1. 必需：mod 根目录的路径，以及它存在的证据（`ls`，或游戏写出的 `<mod>_local.log`）。
2. 做了 A：`status` 的 `game:` 或 `build:` 行；`action=setup` 的 `PASS` 或 `SKIP`。没做就明说「不需要 dump 代码」。
3. 做了 B：`--check` 说参考集完整。没做就明说 `reference/` 不用。

## 边界

- `action=setup` 只写 `~/.gamer-agent-pi/decompiled/tools/`。
- `tools/setup.mjs` 只写 `reference/` 与仓内 `.setup-venv/`（后者在 `.gitignore` 里）。
- 两者都不写 `your_mods/` 与 mod 根目录。安装 mod 是另一件事（`mod-installer`）。
- dump 代码是可选的。不要因为「反正要准备」去下载 Cpp2IL；先问自己这次任务要不要 dump 游戏代码。
- 游戏自己的日志是最快的诊断入口。加载器每读一个文件写一行，每缺一个文件写一行。缺文件是警告，不是错误。
