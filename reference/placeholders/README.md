# 占位图

数据 mod 里没有美术时，用这两张顶着。它们是**我们自己的标记**，不是原版美术，可以随 mod 发布。

| 文件 | 尺寸 | 用在哪 |
|---|---|---|
| `card.png` | 472 × 1028，透明底 | 卡面：`your_mods/<ModName>/image/cards/<名字>.png`，卡的 `resource` 指向 `cards/<名字>` |
| `preview.png` | 512 × 512，黑底 | mod 根目录的 `preview.png`，创意工坊的缩略图 |

## 为什么是这个规格

- **卡面 472 × 1028 RGBA**：`card-art` SKILL 的硬要求，`node tools/card.mjs art` 只收这个尺寸。标记放在竖直 64% 的位置，和物品卡的主体差不多；顶部五分之一留空，因为游戏在那里画卡名和分隔行。
- **缩略图 512 × 512**：Steam 在搜索结果里按这个尺寸渲染。游戏本身只按 `preview.*` 通配找文件，不校验尺寸——所以这一条是为了好看，不是游戏的要求。

## 怎么换掉

占位图只服务「先能看」，正式美术按 `card-art` SKILL 生成或裁切，然后覆盖同一个路径。

```bash
node tools/image.mjs check --file reference/placeholders/card.png --width 472 --height 1028 --alpha
```

## 来源

标记取自产品仓库 `pi-desktop/build/brand/module-mark.png`（200 × 202，透明底），等比缩放到 300 宽后贴上去。这个文件不是原版素材，没有授权问题。
