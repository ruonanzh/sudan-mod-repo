---
name: card-art
description: 苏丹的游戏 mod 的图片怎么做。覆盖卡面尺寸、贴图命名规则、一张卡怎么指向自己的图，以及一张贴图替换了什么、没有替换什么。生成或放置任何图片之前、向玩家承诺视觉改动之前，先读这一份。参考美术不在本仓，这一份也写了它从哪里来。
---

# 卡与角色美术

属于苏丹的游戏 mod 工作区。没读过 `mod-creator` 的话，先读它。

## 卡面

| 项目 | 值 |
|---|---|
| 尺寸 | **472 x 1028** |
| 格式 | 带透明通道的 PNG，RGBA |
| 放哪 | `image/cards/<name>.png` |
| 贴图名 | `image/` 下的路径去掉扩展名：`cards/<name>` |
| 一张卡怎么指向它 | `"resource": ["cards/<name>"]`，或者直接写字符串 |

名字随意。没有任何规则要求名字等于卡 id，但本地约定是让两者相等，这样 mod 读起来清楚。

复用原版美术不需要额外成本。`"resource": "cards/2000439"` 指向一张已有的贴图，mod 一张图都不用带。新卡是某张已有卡的变体时，就这么做。

多套美术变体：`"resource": ["cards/2100861", "cards/2100861_1", "cards/2100861_2"]`，磁盘上放 `image/cards/2100861.png`、`_1`、`_2`。

## 一张贴图替换了什么，没替换什么

`image/cards/<name>.png` **只替换卡面中间的内容区**，也就是角色或物品的插图本身：这个结论在游戏里验过：把一张 472x1028 的洋红色测试图放到一张原版角色卡后面，测试图铺满了卡面，而卡框、四角的金属装饰和帮助按钮都还在。所以美术就是一张满幅插画：不用做九宫格，不用画边框，也不要给卡框留边距。

同一次实测还给出两个限制：

- **卡名在卡面宽度处被裁掉。** 名字太长，尾巴就看不见了。名字写短，其余信息放进 `text`。
- 卡面是 472x1028，按原样拉伸绘制，不加黑边。换成长宽比不同的图，画面会变形。

## 生成卡面图

**目标**：给一张卡产出 472x1028 的卡面图，并让这张卡指向它。卡的其他字段一个都不改。

**前置**：Tripo 的 key。放在环境变量 `TRIPO_API_KEY`，或写进 `~/.gamer-agent-pi/api-keys.json`：
`{"tripo":"tsk_..."}`。两处都没有时工具报 `NO_TRIPO_KEY`。不要自己申请或猜 key，缺了就告诉玩家。

**工具**：`generate_2d_asset` 做四件事。

| action | 作用 |
|---|---|
| `generate` | 按提示词出图，存到 `out`；带 `task` 时只下载那次任务，不花积分 |
| `fit` | 把一张 PNG 裁成指定尺寸 |
| `check` | 读一张 PNG 并与期望的尺寸、透明通道比对 |
| `refs` | 报告参考图缺哪几张 |

工具不知道卡是什么。472x1028、透明底、参考图在哪，都由这一节规定。

### 提示词：三段，头尾照抄

```
A <tier> tier <type> card: <类型样板>, <构图倾向>. <主体> <尾部常量>
```

| 段 | 内容 | 谁定 |
|---|---|---|
| 头 | `A silver tier item card: a single object, centred, shown large, often near-mon…` | 卡的 `rare` 与 `type`，下表 |
| 主体 | 卡名，副标题。`text`。Mood: 前五个 `tag` | 玩家的话优先；没说话时用卡的字段 |
| 尾 | 下面那段英文常量 | 照抄，一个字不改 |

`rare`：`1` 石块 stone、`2` 铜 copper、`3` 银 silver、`4` 金 gold。

`type` 与两个样板：

| `type` | 类型样板 | 构图倾向 |
|---|---|---|
| `char` | `a single character, full body, facing the viewer` | 取 `schema/view/card-art.json` 的 `measured.<type>.tendency`，缺时用 `centred subject` |
| `item` | `a single object, centred, shown large` | 同上 |
| `sudan` | `an ornate Sultan card motif, symmetrical` | 同上 |

主体里的 `tag` 只取前五个，跳过 `已拥有`、`纯色材质`、`装备`、`已装备`、`可堆叠` 这五个状态词。它们只写进提示词当画面气氛，不改卡。

**尾部常量（照抄，不要改写）**

```
flat engraved illustration, warm muted palette of ochre, oxblood and bone, visible ink linework, folk woodcut influence, vertical composition with the subject filling the full height and centred, subject only, isolated on a FULLY TRANSPARENT background, leave the TOP FIFTH of the image completely empty as blank transparency, because the game draws the card name and a divider row there; the subject may run to the bottom edge, where the frame band is drawn over it, no backdrop, no plate, no frame, no border, no floor, no cast shadow, no vignette, no text, game card art
```

送了参考图时，在尾部再加一句：

```
Match the reference drawing's style and palette, and keep its FULLY TRANSPARENT background: do not add any backdrop, plate or frame.
```

**这七件事不得丢**：竖构图、主体撑满并居中、全透明背景、顶部五分之一留空、不画卡框文字投影、平涂刻线暖色、参考图那句追加文本。

### 参考图

按品级与类型取 `reference/cards/<type>-<rare>.png`，例如 `reference/cards/item-3.png`。它排第一张，风格由它定。

`reference/cards/` 里应有十二张（`char` / `item` / `sudan` × 四个品级）。先查：

```
generate_2d_asset({ action: "refs", dir: "reference/cards", expect: ["char-1.png", …] })
```

缺图时报告缺哪几张，并说明这次只用提示词、画风可能偏离；补齐后再生成。

玩家给了自己的图时：

- 想「内容用玩家的、风格用游戏的」：把玩家的图放在 `refs` 的第二位，并在尾部后面加一句
  `Use the style and palette of image[1]. Take the subject's shape and details from image[2].`
- 只想要玩家的风格：只送玩家那张图，并先说明这张卡可能和其它卡不一致。

### 四步：预览、确认、落地、验收

```
1. generate_2d_asset({ action: "generate",
     prompt: "<头 + 主体 + 尾>",
     refs: ["reference/cards/item-3.png"],
     out: "your_mods/<ModName>/.preview/card-<卡 id>.png",
     manifest: "your_mods/<ModName>/asset_manifest.jsonl" })
2. 把这张图的路径给玩家，问「就要这个吗」。
3. 玩家确认后：action="fit"（in=预览图, out=…-472x1028.png, width=472, height=1028, mode="cover"）
   再跑 node tools/card.mjs art --mod your_mods/<ModName> --id <卡 id> --from <裁好的图>
4. action="check"（file=image/cards/<卡 id>.png, width=472, height=1028, alpha=true）
   再跑 node tools/preview.mjs --mod your_mods/<ModName>，让卡页显示新图。
```

`card.mjs art` 只收 472x1028，尺寸不对会 `FAIL`；所以 `fit` 不能省。它写 `image/cards/<卡 id>.png` 并把这张卡的 `resource` 指向它。

玩家说不像时改主体重生成，不要改尾部常量。**玩家确认这张图之前，不要往下走。**

### 成本与清单

- 每调一次 `generate` 花几积分；`task=<id>` 只下载，不花钱。
- 每次生成往 `your_mods/<ModName>/asset_manifest.jsonl` 追加一行（任务 id、提示词哈希、参考图、产物）。要重裁或换尺寸时先读最后几行，能复用就不要重画。
- `install_mod` 不打包 `.preview/` 与 `asset_manifest.jsonl`。

### 裁切与验收

`fit` 与 `check` 也可以用在「图是从别处拿来的」情况：

```
generate_2d_asset({ action: "fit", in: "<源图>", out: "your_mods/<ModName>/image/cards/<名字>.png", width: 472, height: 1028 })
generate_2d_asset({ action: "check", file: "your_mods/<ModName>/image/cards/<名字>.png", width: 472, height: 1028, alpha: true })
```

`check` 报 `SIZE_MISMATCH` 时按它给的尺寸跑 `fit`；报 `NO_ALPHA` 时那张图没有透明通道，换一张或重新生成。

卡页上「画面 · 这张图画成什么」那段是同一套头尾拼出来的，可以直接当起点，也可以按玩家的话改写后再送 `generate`。

## 对齐游戏的画风

游戏的画风是平涂、带刻线、暖色调，配色有限，线条可见。柔和渐变、光晕、冷色调的渲染放到棋盘上会显得格格不入。生成任何图之前，先拉两张原版卡面看一遍。

参考卡就在本仓：`reference/cards/{char,item,sudan}-{1..4}.png`，四张品级底板在 `reference/plates/`。卡面标题字体不在仓库里（商业授权），缺字体时页面退回衬线字体。

`generate_2d_asset` 的 `refs` 动作报告十二张参考卡是否齐全。这十二张不是装饰：齐全时生成走图生图，画风才贴得住。

## 不要做的事

- 不要往 `image/` 以外的目录放图片。贴图必须能从 `image/` 找到，否则对游戏来说它不存在。
- 不要在 `image/` 里放 `.jpg` 或 `.webp`。游戏只读 `.png`，遇到别的格式会在日志里写它忽略了该文件。
- 不要靠改掉原版贴图的名字来「删掉」一张图。游戏按贴图名取值，名字对不上就没有图，玩家看到空白或占位。要换掉一张原版图，就在 `image/` 下放一份**与它同名**的文件：游戏先加载原版，再用 mod 的同名文件覆盖它。
