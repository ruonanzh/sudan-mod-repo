---
description: 玩家在战利品表或命运商店页上改了值，把这些值写回记录
argument-hint: "loot:6000123"
---

记录的键与改动：

```
$ARGUMENTS
```

玩家在页面上改了值。参数是记录的键 `<kind>:<id>`（`loot` 或 `upgrade`），消息下一行 `改动：` 后面是只包含改动字段的 JSON。

按这个顺序做：

1. 找文件：`loot` 是 `config/loot/<id>.json`；`upgrade` 是 `config/upgrade.json` 里 `id` 等于该值的那一条。
2. 用 `tools/jsonc.mjs` 做 span 编辑写回：标量用 `set`，`item` 数组按索引增删用 `append`/`remove`。注释、字段顺序、重复键一律不动；**不要**读成对象再 `JSON.stringify`。
3. 跑 `validate_mod`，有 `FAIL` 先改到没有。
4. 重跑 `node tools/preview.mjs --mod <ModName>`，让这一页反映新值。
5. 回话：一句话说改了哪几个键，再给这一页的工作区相对路径。玩家不需要看 JSON。

`改动：` 里的值不合法（例如 `loot.type` 不是 2/3/4/99）时，先说明哪里不对，再问玩家要不要按建议值改；不要猜。
