---
description: 玩家在战利品表或命运商店页上改了值，把这些值写回记录
argument-hint: "loot:6000123"
---

记录的键、说明与改动：

```
$ARGUMENTS
```

玩家在页面上操作过。参数第一行是记录的键 `<kind>:<id>`（`loot` 或 `upgrade`）。后面可能有两段：

- `说明：` 玩家对这行的要求，每行以 `- 字段名：` 开头，物品条件是 `- 第 N 件的条件：`。命运商店的三个字段只会这样出现：`condition`（显示条件）、`effect`（效果）、`incompatible`（互斥）。玩家写的是白话时，把它翻成字段写法；玩家直接写出了 JSON 或条目编号时，按他写的用。
- `改动：` 只包含改动字段的 JSON，来自页面上的输入框与下拉。

按这个顺序做：

1. 找文件：`loot` 是 `config/loot/<id>.json`；`upgrade` 是 `config/upgrade.json` 里 `id` 等于该值的那一条。
2. 有 `说明：` 时，照下面的写法落地。玩家写的是白话，就翻成字段写法；玩家已经写出 JSON 或编号，就按他写的来，只核对键名与取值是否合法：
   - `condition`：写 `{"unlock_upgrade": <升级id>}`、`{"global_counter.<7位id><比较符>": <数>}` 或 `{}`。
   - `effect`：按键写操作，例如 `{"g.card": [<卡id>, "标签+层数"]}`、`{"counter+7000658": 1}`；多个键按 JSON 顺序执行。
   - `incompatible`：写另一条升级的整数 id，没有写 `0`。
   - `第 N 件的条件`：改 `loot` 里第 N 个 `item.condition`，写法同 `condition`。
   玩家的要求写成这些字段表达不了时，先说清哪一句做不到，再问玩家；不要自己发明键名。

3. 用 `tools/jsonc.mjs` 做 span 编辑写回：标量用 `set`，`item` 数组按索引增删用 `append`/`remove`。注释、字段顺序、重复键一律不动；**不要**读成对象再 `JSON.stringify`。
4. 跑 `validate_mod`，有 `FAIL` 先改到没有。
5. 重跑 `node tools/preview.mjs --mod <ModName>`，让这一页反映新值。
6. 回话：一句话说改了哪几个字段，再给这一页的工作区相对路径。玩家不需要看 JSON。

`改动：` 里的值不合法（例如 `loot.type` 不是 2/3/4/99）时，先说明哪里不对，再问玩家要不要按建议值改；不要猜。
