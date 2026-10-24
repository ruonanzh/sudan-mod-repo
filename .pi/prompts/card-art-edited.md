---
description: 玩家在卡页上点了「修改卡面图，通知 agent」，按页面上的提示词重画这张卡的卡面图
argument-hint: "[卡页路径]"
---
玩家在卡页上点了「修改卡面图，通知 agent」。这一步只修改卡面图：不改这一页存下的值，不改标签，也不改 `config/cards.json` 里别的键。

1. 参数 `${1:-<your_mods/<ModName>/.preview/<卡 id>.card.html>}` 是玩家开着的那一页。文件名去掉 `.card.html` 就是 `<卡 id>`，`.preview` 的上一级目录名就是 `<ModName>`。
2. 这条消息的下一行是玩家写进页面的画面内容，格式是 `卡面图的提示词：「……」`。画什么以那一句为准，卡名与 `text` 里的描述不再塞回去。
3. 按 `card-art` SKILL 的配方拼整段提示词：头部与尾部照抄，主体换成玩家那一句。参考图取 `reference/cards/<type>-<rare>.png`。
4. 用 `generate_2d_asset` 生成预览：`action=generate`、`prompt=<整段>`、`refs=[<参考图>]`、`out=your_mods/<ModName>/.preview/card-<卡 id>.png`、`manifest=your_mods/<ModName>/asset_manifest.jsonl`。这个工具背后是 `tools/image.mjs`，画一张要花积分。
5. 把预览图的路径给玩家，问他「就要这个吗」。玩家说不像时改主体重生成，不要改尾部常量。
6. 玩家确认后：`generate_2d_asset` 的 `action=fit`（`width=472`、`height=1028`、`mode=cover`）裁出成品，再跑 `node tools/card.mjs art --mod your_mods/<ModName> --id <卡 id> --from <裁好的图>`。它写 `image/cards/<卡 id>.png` 并把这张卡的 `resource` 指向它，`resource` 不用再手改。
7. `node tools/preview.mjs --mod your_mods/<ModName>` 重建页面，页面会自己重新载入，玩家马上能看到新图。
8. 报告里给卡页的**工作区相对路径**：`your_mods/<ModName>/.preview/<卡 id>.card.html`。没有清单页。
