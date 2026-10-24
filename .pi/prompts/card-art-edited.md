---
description: 玩家在卡页上点了「修改卡面图，通知 agent」，按页面上的提示词重画这张卡的卡面图
argument-hint: "[卡页路径]"
---
卡页与那句话：

```
$ARGUMENTS
```

玩家在卡页上点了「修改卡面图，通知 agent」。这一步只修改卡面图：不改这一页存下的值，不改标签，也不改 `config/cards.json` 里别的键。

1. 参数 `${1:-<your_mods/<ModName>/.preview/<卡 id>.card.html>}` 是玩家开着的那一页。文件名去掉 `.card.html` 就是 `<卡 id>`，`.preview` 的上一级目录名就是 `<ModName>`。
2. 上面那段里的**第二行**（以 `卡面图的提示词：` 开头，后面引号里就是玩家写的话）才是玩家要的画面。**那句话是原料，不是最终提示词**：措辞由你写，并用 `card-art` 的配方补上头尾。只拿到卡页路径、没有那第二行时，先问玩家要画什么，不要自己编。
3. 先判断玩家要的是哪种：
   - **新画面**（描述这张卡该画成什么）→ 它替换主体，参考图取 `reference/cards/<type>-<rare>.png`。
   - **改上一版**（例如「剑再细一点」「把雪去掉」）→ 把这张卡已有的 `image/cards/<卡 id>.png` 放进 `refs` 的第二位，并在提示词里写明「保持 image[2] 的构图与细节，只改：<玩家说的那处>」。没有旧图时按新画面处理，并说明这次是从零画的。
   - 玩家的话有歧义、或两种都能解释时，先问一句再生成。
4. 用 `generate_2d_asset` 生成：`action=generate`、`prompt=<你写好的整段>`、`refs=[<参考图>]`（改上一版时再加旧图）、`out=your_mods/<ModName>/.preview/card-<卡 id>.png`、`manifest=your_mods/<ModName>/asset_manifest.jsonl`。工具背后是 `tools/image.mjs`，这一步花积分。
5. **不要再问玩家「就要这个吗」**：卡页本身就是确认入口，玩家不满意会再写一句重来。直接落地。
6. `generate_2d_asset` 的 `action=fit`：把预览裁成 472×1028（`mode=cover`），输出 `.preview/card-<卡 id>-472x1028.png`。
7. `node tools/card.mjs art --mod your_mods/<ModName> --id <卡 id> --from <裁好的图>`：写 `image/cards/<卡 id>.png` 并把这张卡的 `resource` 指向它。
8. `generate_2d_asset` 的 `action=check` 验收尺寸与透明通道，再跑 `node tools/preview.mjs --mod your_mods/<ModName>`，卡页会自己重载出新图。
9. 回话：一句话说这次改了什么，再给卡页的工作区相对路径。不需要贴 JSON，也不需要再问确认。
