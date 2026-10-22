---
description: 玩家在卡页上点了「改好了，通知 agent」，把这一页存下的值写回 config/cards.json
argument-hint: "[卡页路径]"
---
玩家在卡页上点了「改好了，通知 agent」。按下面的顺序做，不要跳到第 4 步。

1. 参数 `${1:-<your_mods/<ModName>/.preview/<卡 id>.card.html>}` 是玩家开着的那一页。文件名去掉 `.card.html` 就是 `<卡 id>`，`.preview` 的上一级目录名就是 `<ModName>`。
2. `node tools/preview.mjs --mod your_mods/<ModName> --collect` 打印这一页存下、`config/cards.json` 里还没有的值，一行一个：`<卡 id>  <键>  <旧值> -> <新值>`。它说 `no card page carries a value different` 时，告诉玩家这一页没有待写的值，然后停，不要改任何文件。
3. 第 2 步里带 `tag.` 的行是标签。名字不在 `config/tag.json` 里的，先给每个名字建一条：key 写标签的 code 字符串，`type` 与 `attributes` 按 `schema/SCHEMA.md` 的 `tag` 一节写，数值标签的原版范围照同类标签取。建完跑 `node tools/lint.mjs your_mods/<ModName>`，这几个名字不再被 `TAG_UNKNOWN` 点名。
4. `node tools/preview.mjs --mod your_mods/<ModName> --apply` 把值写回 `config/cards.json`。它只改第 2 步列出的键，注释、字段顺序和这一页没有显示的字段都不动。
5. `node tools/preview.mjs --mod your_mods/<ModName>` 重建页面。重建后再跑一次 `--collect`，应看到 `no card page carries a value different`。
6. 向玩家报告改了什么：一行一个 `<卡 id>  <键>  <旧值> -> <新值>`，再说页面已经重建。报告里给两个链接：卡页 `your_mods/<ModName>/.preview/<卡 id>.card.html`，清单 `your_mods/<ModName>/.preview/index.html`。
