---
description: 玩家在战利品表页上改了值，或说了某一件的条件，把这些写回这张表
argument-hint: "loot:6000123"
---

记录的键、说明与改动：

```
$ARGUMENTS
```

玩家在战利品表页上操作过。参数第一行是记录的键 `loot:<id>`。后面可能有两段：

- `说明：` 玩家对某一件条件的要求，每行是 `- 第 N 件的条件：`。玩家写的是白话时，把它翻成条件写法；玩家直接写出了 JSON 时，按他写的用。
- `改动：` 只包含改动字段的 JSON，来自页面上的输入框与下拉。可能出现的键是 `repeat`、`type`、`name`，以及 `item` 数组（每项含 `type`、`id`、`num`、`weight`）。

按这个顺序做：

1. 找文件：这张表是 `config/loot/<id>.json`。
2. 有 `说明：` 时，把第 N 件的条件写进 `item[N-1].condition`。条件的形状是一个对象，多个键表示全部满足，例如 `{"!have.2000707": 1, "counter.7000673<": 1}`：玩家没有 2000707 这张卡，并且计数器 7000673 小于 1。写成这些键表达不了时，先说清哪一句做不到，再问玩家；不要自己发明键名。
3. 用 `tools/jsonc.mjs` 写回，只改动的部分，注释、字段顺序、重复键一律不动；**不要**读成对象再 `JSON.stringify`。按改动挑方法：
   - `set(node, literal)`：改一个标量。表自己的 `repeat`、`type`、`name` 用 `getDoc(doc, ["<键>"])`；某一件的 `type`、`id`、`num`、`weight` 用 `getDoc(doc, ["item", <下标>, "<键>"])`，`condition` 用 `getDoc(doc, ["item", <下标>, "condition"])`。这样只换这一个值，这一件里的注释与其余字段原样保留。
   - `appendElement(arr, literal)`：在末尾加一件。`arr` 用 `getDoc(doc, ["item"])` 取；新件写成完整的 JSON 对象。
   - `removeElement(arr, i)`：删掉第 i 件。删多件时从大到小删，否则后面的索引会错位。
   - `element(arr, i)`：读出第 i 件当前的 JSON，改之前先看它有哪些键。

   `改动：` 里的 `item` 是**整份数组**，用它判断哪几件变了：逐项和文件里的比，第 i 件只是字段变了就逐字段 `set`，件数变多 `appendElement`，件数变少按上面的顺序 `removeElement`。只有 `condition` 在 `说明：` 里改时，也走 `set`，不要整件替换。
4. 跑 `validate_mod`，必须 **PASS**：`PARTIAL` 不算通过（它说明原版配置没读到），按 `NEXT` 解决后重跑；`FAIL` 先改到没有。
5. 重跑 `node tools/preview.mjs --mod your_mods/<ModName>`，让这一页反映新值。
6. 回话：一句话说改了哪几个字段，再给这一页的工作区相对路径。玩家不需要看 JSON。

`改动：` 里的值不合法（例如 `type` 不是 2/3/4/99，或 `item[].type` 不是 card/event/rite/loot）时，先说明哪里不对，再问玩家要不要按建议值改；不要猜。
