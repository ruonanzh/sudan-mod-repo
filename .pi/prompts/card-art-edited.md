---
description: 玩家在卡页上点了「修改卡面图，通知 agent」，按页面上的提示词重画这张卡的卡面图
argument-hint: "[卡页路径]"
---
玩家在卡页上点了「修改卡面图，通知 agent」。这一步只修改卡面图：不改这一页存下的值，不改标签，也不改 `config/cards.json` 里别的键。

1. 参数 `${1:-<your_mods/<ModName>/.preview/<卡 id>.card.html>}` 是玩家开着的那一页。文件名去掉 `.card.html` 就是 `<卡 id>`，`.preview` 的上一级目录名就是 `<ModName>`。
2. 这条消息的下一行是玩家写进页面的画面内容，格式是 `卡面图的提示词：「……」`。画什么以那一句为准，卡名与 `text` 里的描述不再塞回去。
3. `node tools/art.mjs gen --mod your_mods/<ModName> --id <卡 id> --subject "<那一句>"` 生成卡面图。头尾不动，风格留在游戏这边；玩家另外给了参考图时，按 `card-art` 方式二加 `--ref-add <图>`。
4. `gen` 把图写到 `image/cards/<卡 id>.png`（472x1028），并把这张卡的 `resource` 指向它，`resource` 不用再手改。`gen` 打印的第一行 `PASS` 与图片路径都告诉玩家。
5. `node tools/preview.mjs --mod your_mods/<ModName>` 重建页面，页面会自己重新载入，玩家马上能看到新图。
6. 报告里给两个链接：卡页 `your_mods/<ModName>/.preview/<卡 id>.card.html`，清单 `your_mods/<ModName>/.preview/index.html`。玩家说不像时改 `--subject` 再来一次。玩家确认这张图之前，不要往下走。
