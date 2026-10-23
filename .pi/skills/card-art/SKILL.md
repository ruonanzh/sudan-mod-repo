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
`{"tripo":"tsk_..."}`。两处都没有时工具抛 `no Tripo API key. Save it to ~/.gamer-agent-pi/api-keys.json ...`。
不要自己申请或猜 key，缺了就告诉玩家。

三种用法，按这个顺序选：**能用方式一就别用方式二，能用方式二就别用方式三。**

### 方式一：按卡 id 直接生成（默认）

```
node tools/art.mjs prompt --mod your_mods/<ModName> --id <卡 id>     # 只打印，不花钱
node tools/art.mjs gen    --mod your_mods/<ModName> --id <卡 id>     # 生成
```

提示词由这张卡的 json 拼出来：头部（品级与类型）、主体（`name`、`title`、`text`、前五个 `tag`）、尾部（画风与构图常量）。参考图自动取同品级同类型那一张，存在时走图生图。

这条最省事，也最不容易跑偏：画面内容来自卡自己的字段，玩家改了卡名或说明，下一次生成就跟着变。

### 方式二：玩家指定的画面 + 游戏的画风（推荐）

玩家说「画成一把断成两截的剑」「剑身上缠着红布」时用这条。**头尾不动，只换或只加中间那段。**

| 参数 | 作用 | `gen` 打印的 `mode` 值 |
|---|---|---|
| `--subject "<画面内容>"` | **替换**主体：只用玩家说的画面，不再用卡名与 `text` | `composed+subject` |
| `--add "<补充>"` | **追加**在主体后面：保留卡字段生成的画面，再加玩家那几句 | `composed+add` |
| `--ref <图>` | **换掉**参考图。默认那张是游戏自己的同品级参考；换成玩家的图后，画面最贴近玩家的图，风格也随那张图 | 不改变 `mode`，参考图情况看 `refs` 那行 |
| `--ref-add <图>` | **加一张**内容参考，同时保留游戏的参考图：风格取 `image[1]`（游戏），形状与细节取 `image[2]`（玩家的图） | 不改变 `mode`，参考图情况看 `refs` 那行 |

```
node tools/art.mjs gen --mod your_mods/<ModName> --id <卡 id> --subject "一把断成两截的长剑，插在雪里"
node tools/art.mjs gen --mod your_mods/<ModName> --id <卡 id> --add "剑身上缠着褪色的红布"
node tools/art.mjs gen --mod your_mods/<ModName> --id <卡 id> --subject "<画面内容>" --ref-add <玩家的图>
```

**「内容用玩家的、风格用游戏的」有三条路，按贴合程度选：**

1. **`--ref-add <玩家的图>`** —— 两张参考图一起送：游戏那张排第一，玩家的图排第二；追加的那句提示词写明「风格与配色取 `image[1]`，主体的形状与细节取 `image[2]`」。画面照玩家的图，风格留在游戏这边。**优先用这条。**
2. **`--subject "<玩家图里画的是什么>"`** —— 不送玩家的图，只用文字描述它的内容。适合玩家给的是参考照片、而文字能说清的情况。
3. **`--ref <玩家的图>`** —— 只送玩家的图，风格会跟着那张图走。画面最贴，但可能和其它卡不一致，要先说明。

接口本身支持多张参考图（`chat_image` 最多 16 张，提示词里用 `image[1]`、`image[2]` 指名）；`--ref-add` 只是把这条用起来。

`mode` 表示的是**提示词用了哪种拼法**，不是图像模型的模式；后面的 `refs` 行才是参考图的情况。

**画面内容优先表现玩家的要求。** 用了 `--subject` 之后，不要再把卡名、`text` 里的描述塞回去；玩家的那几句话就是画面。风格、构图、透明背景由头尾负责，不用玩家操心。

玩家给了图又给了要求时，用 `--ref <图> --subject "<要求>"`：图定风格与配色，`--subject` 定画面。

### 方式三：整段提示词自己写（最后才用）

```
node tools/art.mjs gen --mod your_mods/<ModName> --id <卡 id> --prompt "<整段提示词>"
```

`--prompt` 会把整段提示词换成你写的那句，`gen` 打印的第一行是 `mode    verbatim`。**头部与尾部都不再加**，只有参考图那句仍会追加。所以这条不要拿来「微调」——它是「不要游戏的画风」。

用这条时必须自己写全：先写画面，再接上下面的「尾部常量」整段。格式就是这两段拼起来：

```
<这张卡画什么>，<尾部常量>
```

把最前面那句换成具体画面，后面的常量原样复制。**玩家说「就要照片感 / 不要游戏那种画风」时才用这条**，并提前说明画面会和其它卡不一致。

### 参考图：检查与替换

```
node tools/art.mjs refs
```

- 十二张齐：`PASS  every tier has a reference picture; gen will use image-to-image`。
- 缺几张：`WARN  <n> reference picture(s) missing in reference/cards/.`，后面一行 `NEXT` 说明怎么提取。
- 缺了也能生成，但画风只能靠提示词文字扛，`gen` 会再打一条 `WARN  no reference picture for this tier; the palette comes from the prompt alone.`

参考图就是原版卡面，生成时当输入用。默认先补齐。**例外两种**：玩家明确说不要参考图；玩家要自己的画风而不是游戏画风。这两种情况直接生成，接受画风偏离。

### 裁切与验收

`gen` 已经裁过，下面两条留给「图是从别处拿来的」情况：

```
node tools/art.mjs fit   --in <源图> --out your_mods/<ModName>/image/cards/<名字>.png
node tools/art.mjs check --file your_mods/<ModName>/image/cards/<名字>.png
```

- `fit`：居中裁切到 472x1028 并保存，打印 `PASS  wrote <输出路径> (472x1028)`，并给一行 `node tools/card.mjs art ...` 让卡指向它。
- `check`：只验收不改图。对就打印 `PASS  472x1028 RGBA, ready`；不对打印 `FAIL  <宽>x<高>; a card face is 472x1028.`，后面跟一行可复制的 `fit` 命令。

生成时依次打印 `mode`、`prompt`、`ref`、`task` 四行，结束时打印 `PASS  image/cards/<卡 id>.png written at 472x1028`，并把这张卡的 `resource` 设成 `["cards/<卡 id>"]`。**把图的路径告诉玩家**，不要假设他会自己看到。

不像就改 `--subject` / `--add` 再来一次，每次都很便宜。**玩家确认这张图之前，不要往下走。** `gen` 已经把这张卡的 `resource` 字段设成 `["cards/<卡 id>"]`，不用再改；确认之后按 `script/prompt-standard.md` §5.3 的七步继续。

#### 提示词怎么拼出来的

省略 `--prompt` 时，`composePrompt()` 拼三段：

```
A <品级> tier <类型> card: <类型样板>, <构图倾向>. <卡名>，<副标题>。<text> Mood: <tag1> / <tag2> / … <尾部常量>
```

| 占位符 | 从哪来 |
|---|---|
| `<品级>` | 卡的 `rare`：1 stone、2 copper、3 silver、4 gold（样板里同时写中英文，如「银 silver」） |
| `<类型>` | 卡的 `type` 字段 |
| `<类型样板>` 与 `<构图倾向>` | 两者都只由 `type` 决定。样板是 `tools/art.mjs` 里的默认值：`char` → `a single character, full body, facing the viewer`；`item` → `a single object, centred, shown large`；`sudan` → `an ornate Sultan card motif, symmetrical`。构图倾向取 `schema/view/card-art.json` 的实测值，该文件缺这个 `type` 时用默认值 `centred subject` |
| `<卡名>` `<副标题>` `<text>` | 卡的 `name`、`title`、`text` 三个字段 |
| `<tag1>…` | 卡自己的 `tag` 字段里的键，取前五个。它们**只写进提示词当画面气氛**（例如 `体魄` 让角色显得壮），不改卡、不进游戏、不影响数值。`已拥有`、`纯色材质`、`装备`、`已装备`、`可堆叠` 五个是状态词，跳过 |

`--subject` 换掉的就是 `<卡名>…Mood:` 这一段；`--add` 追加在它后面。

### 尾部常量（照抄，不要改写）

这一段是给图像模型的，保持英文。结尾的 `game card art` 是类别提示：告诉模型这是游戏卡面美术。

```
flat engraved illustration, warm muted palette of ochre, oxblood and bone, visible ink linework, folk woodcut influence, vertical composition with the subject filling the full height and centred, subject only, isolated on a FULLY TRANSPARENT background, leave the TOP FIFTH of the image completely empty as blank transparency, because the game draws the card name and a divider row there; the subject may run to the bottom edge, where the frame band is drawn over it, no backdrop, no plate, no frame, no border, no floor, no cast shadow, no vignette, no text, game card art
```

参考图存在时，`gen` 还会在这段后面追加一句：`Match the reference drawing's style and palette, and keep its FULLY TRANSPARENT background: do not add any backdrop, plate or frame.`

**这七件事不得丢：**

1. **竖构图。** 方图生成后会被裁掉两侧。
2. **主体撑满整个高度并居中。**
3. **全透明背景。** 不是白底，不是纯色底。
4. **顶部五分之一留空。** 游戏在卡面顶部画卡名与分隔行；画了东西会被盖住。
5. **不画卡框、底板、文字、投影、暗角。** 卡框由游戏绘制。
6. **平涂、刻线、暖色有限配色。** 换柔和渐变或冷色调，卡放到棋盘上会显得格格不入。
7. **参考图那句追加文本不要删。** 它把配色绑回游戏自己的卡面。

## 对齐游戏的画风

游戏的画风是平涂、带刻线、暖色调，配色有限，线条可见。柔和渐变、光晕、冷色调的渲染放到棋盘上会显得格格不入。生成任何图之前，先拉两张原版卡面看一遍。

参考卡就在本仓：`reference/cards/{char,item,sudan}-{1..4}.png`，四张品级底板在 `reference/plates/`。卡面标题字体不在仓库里（商业授权），缺字体时页面退回衬线字体。

`node tools/art.mjs refs` 报告十二张参考卡是否齐全。这十二张不是装饰：齐全时生成走图生图，画风才贴得住。

## 不要做的事

- 不要往 `image/` 以外的目录放图片。贴图必须能从 `image/` 找到，否则对游戏来说它不存在。
- 不要在 `image/` 里放 `.jpg` 或 `.webp`。游戏只读 `.png`，遇到别的格式会在日志里写它忽略了该文件。
- 不要靠改掉原版贴图的名字来「删掉」一张图。游戏按贴图名取值，名字对不上就没有图，玩家看到空白或占位。要换掉一张原版图，就在 `image/` 下放一份**与它同名**的文件：游戏先加载原版，再用 mod 的同名文件覆盖它。
