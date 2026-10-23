---
name: mod-installer
description: >
  把一个苏丹的游戏 mod 装进游戏，并确认游戏真的读到了它。覆盖 macOS 与 Windows 上的 mod 根目录、
  为什么复制文件夹还不等于启用、怎么读单个 mod 的日志，以及怎么更新与移除。玩家要把 mod 装进游戏、
  说看不见它、或你刚写完一个 mod 时，读这一份。
---

# 安装 mod

属于苏丹的游戏 mod 工作区。没读过 `mod-creator` 的话，先读它。

## mod 根目录

```
macOS    ~/DoubleCross/SultansGame/Mod/
Windows  %USERPROFILE%\Documents\DoubleCross\SultansGame\Mod\
```

游戏用 `GetFolderPath(MyDocuments)` 拼上公司名、`"SultansGame"` 与 `"Mod"` 推出它。macOS 上 `MyDocuments` 是家目录，Windows 上是 `Documents`。两条路径的差别只有这一处，不要拿一个去推另一个。

玩家找不到这个文件夹时，游戏内的 mod 面板上有一个按钮可以打开它。文件夹不存在时，这个按钮会把文件夹建出来，所以「文件夹原来不存在」不是去别处找的理由。

## 安装

调 `install_mod`，参数 `modDir=your_mods/<ModName>`。它把整个文件夹复制到 `<ModRoot>/<ModName>/`；遇到旧副本时先删掉再复制，所以旧版多出来的文件不会残留。仓库里的那一份是源文件，工具只读不写。不要改用 shell 复制：工具会整份替换并报告实际写入的目录。

文件夹名与 `info.json` 的 `name` 字段互不相干。文件夹名出现在文件路径里，`name` 字段是 mod 面板上显示的名字。

## 复制过来不等于已启用

复制完成后，玩家要打开 mod 面板启用这个 mod。mod 面板从游戏标题界面进入。启用状态由游戏自己记录（内存里的 `Global.mods`），你不要手写任何启用列表文件。

有两个后果要提前说清：

- 两个 mod 提供同一个 `config` 路径时，**后启用**的那个 mod 生效。这里没有加载顺序字段，也没有依赖字段。
- 改动原版记录的 mod 采取整份替换：游戏读的是这个 mod 提供的那份完整文件，不读原版文件。玩家禁用这个 mod 之后，游戏重新读原版文件，原版内容恢复。游戏以后更新了那个原版文件时，这个 mod 仍然提供它当初复制下来的旧副本。

## 更新

再调一次 `install_mod`，然后让玩家刷新 mod 列表。工具把整个文件夹换掉，旧版多出来的文件不会留下。

手工复制时游戏不会清理 mod 目录：新版删掉的文件要自己从安装目录里删。

## 移除

删掉文件夹后，让玩家刷新 mod 列表。如果这个 mod 在面板里仍然是启用状态，游戏会在日志里记一条缺失，并跳过这个 mod。

## 确认游戏读到了

读日志。日志能回答的问题，不要拿去问玩家。

```
~/DoubleCross/SultansGame/ModLog/__mod.log              全局
~/DoubleCross/SultansGame/ModLog/<mod name>_local.log   每个 mod 一份
```

看什么：

| 行 | 含义 |
|---|---|
| `read mod <name> file: config/cards.json` | 游戏读了这个文件 |
| `mod <name> file not exists: config/event` | 这一项不存在。**警告，不是错误** |
| `mod <name> info.json loaded` | 元数据被接受 |
| `mod <name> info.json invalid` | 先修 `info.json`，别的都放到后面 |
| `unknown how to read operation` | 你编的键不是一个操作 |
| `can not create operation instance` | 操作键存在，但参数的形状不对 |
| `is not png, ignored` | `image/` 里有不是 PNG 的东西 |
| `is not wav, mp3, ogg, ignored` | `bgm/` 里有后缀不对的东西 |

只提供一个文件的 mod 会打出十几条 `file not exists` 警告。这些警告是预期的，不是故障。报证据时引用 `read` 开头的行，不要引用警告行。

## 日志不能告诉你的事

日志能证明游戏加载了你的数据，不能证明改动在游戏里看得见。卡图、布局、一个仪式能不能走到，都要玩家自己看。先说明日志显示了什么，再问玩家在游戏里看到了什么。
