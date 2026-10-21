#!/usr/bin/env node
/**
 * page.mjs — turn a mod record into one self-contained page the player can read and
 * mark up.
 *
 *   node tools/page.mjs card --mod your_mods/x --id 2100900
 *   node tools/page.mjs rite --mod your_mods/x --id 5010901
 *   node tools/page.mjs card --mod your_mods/x --id 2100900 --spec - < proposal.json
 *   node tools/page.mjs card --mod your_mods/x --id 2100900 --out /tmp/x.html
 *
 * `--spec <file|->` renders a proposal that is not in the mod yet: the JSON comes from that file,
 * or from stdin when the value is `-`. Nothing is written to the mod, so the player can approve a
 * shape before it becomes a record.
 *
 * The page is read-only on purpose. There is no page editor wired for this game, so a form
 * control would collect a value nobody reads: the player answers in chat and the agent
 * applies it with tools/card.mjs or tools/story.mjs. Values are printed as text.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openMod, ModelError } from "./model.mjs";
import { toPlain } from "./jsonc.mjs";
import { decodePng, encodePng, cropCover, overlay, solid, nineSlice, tint } from "./png.mjs";
import { composePrompt, composeSubject, composeBoilerplate } from "./art.mjs";
import { esc, CSS, pageHtml as shellPage } from "./html.mjs";

const TAG_ROLES = JSON.parse(readFileSync(new URL("../schema/tag-roles.json", import.meta.url), "utf8"));
const CARD_ART = JSON.parse(readFileSync(new URL("../schema/card-art.json", import.meta.url), "utf8"));
const PLATE = ["stone", "copper", "silver", "gold"];
const CARD_W = 472;
const CARD_H = 1028;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

/**
 * The card name is set in HYJieLongTaoHuaYuanW-2, which is the font behind the game's
 * CardTitle SDF materials. If it has been extracted we use it, otherwise the page falls
 * back to a serif. It is a commercial typeface: reference/fonts is git-ignored, and the
 * page only uses it locally.
 */
function fontFace() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const f = path.join(here, "..", "reference", "fonts", "HYJieLongTaoHuaYuanW-2.ttf");
  if (!existsSync(f)) return { css: "", family: "ui-serif, Georgia, 'Songti SC', serif" };
  return {
    css: `@font-face { font-family: "GameCardTitle"; src: url("file://${f}"); font-weight: 700; font-display: block; }`,
    // single quotes: this string lands inside a double-quoted style attribute
    family: `'GameCardTitle', ui-serif, Georgia, serif`,
  };
}

function pageHtml({ title, sub, body }) {
  const ff = fontFace();
  return shellPage({
    title,
    sub,
    font: ff.css ? ff : null,
    body,
  });
}

/**
 * Every slot name vanilla puts in a character's `equips`, measured across the 131 char
 * cards that declare any. A slot is a repeatable entry, so the page edits counts: three
 * 饰品 means three trinket slots. A fifth name would need a matching tag for items.
 */
const SLOTS = ["武器", "服装", "饰品", "驯兽"];

function cardBody(record, modDir) {
  const subject = composeSubject(record);
  const tags = Object.entries(record.tag || {});
  // A marker tag is present or absent: every vanilla use is exactly 1. A stat tag carries a
  // number and has an observed range. Rendering both as numbers invites a value the game never sees.
  const markerRows = tags
    .filter(([name]) => TAG_ROLES.marker[name])
    .map(
      ([name]) => `<tr>
  <td>${esc(name)}</td>
  <td class="num">有</td>
</tr>`,
    )
    .join("\n");
  const statRows = tags
    .filter(([name]) => !TAG_ROLES.marker[name])
    .map(([name, value]) => {
      const range = TAG_ROLES.stat[name];
      return `<tr>
  <td>${esc(name)}</td>
  <td class="num">${esc(value)}</td>
  <td style="color:#8a7a60;font-size:12px">${range ? `${range.min} … ${range.max}` : "新属性"}</td>
</tr>`;
    })
    .join("\n");

  return `
<h2>卡面</h2>
<div class="split">
  ${artInline(modDir, record.id, record.rare, record.name, record.type, fontFace().family) || '<div class="cardface">472 × 1028<br>卡面图放这里<br><span style="opacity:.6">只替换内部画面，边框由游戏画</span></div>'}
  <div class="grow">
    <div class="panel">
      <div class="row"><div class="lbl">名字</div><div class="val">${esc(record.name)}</div></div>
      <div class="row"><div class="lbl">副标题</div><div class="val">${esc(record.title || "（无）")}</div></div>
      <div class="row"><div class="lbl">类别</div><div class="val">${esc(record.type)}</div></div>
      <div class="row"><div class="lbl">稀有度</div><div class="val">${esc(record.rare)} · ${["石块", "铜", "银", "金"][record.rare - 1] || "?"}</div></div>
      <div class="row"><div class="lbl">说明</div><div class="val" style="white-space:pre-wrap">${esc(record.text || "（无）")}</div></div>
      <div class="row"><div class="lbl">可装备槽</div><div>${record.type === "char"
        ? `<div class="val">${SLOTS.map((slot) => {
            const n = (record.equips || []).filter((x) => x === slot).length;
            return n ? `${esc(slot)} ×${n}` : "";
          }).filter(Boolean).join("、") || "（无）"}</div>`
        : `<div class="note" style="margin:0">这张卡不是角色，没有槽位。物品能不能穿、穿到哪，由标签决定：<b>装备</b>=1 加 <b>武器</b>/<b>服装</b>/<b>饰品</b>/<b>驯兽</b> 之一。</div>`}</div></div>
      <div class="row"><div class="lbl">唯一</div><div class="val">${record.is_only ? "只能有一张" : "可以有多个"}</div></div>
    </div>
  </div>
</div>

<h2>画面 · 你想让图画成什么</h2>
<div class="panel">
<div class="note" style="margin-top:0">只写主体：画谁、画什么、什么神态。构图、风格、透明底这些我按游戏要求自动补，不用你管。</div>
<div class="val" style="white-space:pre-wrap">${esc(subject)}</div>
</div>

<h2>标记 · 有或没有</h2>
<div class="panel">
<table>
<tr><th>标记</th><th>状态</th></tr>
${markerRows || '<tr><td colspan="2" style="color:#8a7a60">没有标记</td></tr>'}
</table>
<div class="note">这些标签在游戏里只可能是 1（有）或不存在。1294 张卡里没有一张用过别的值。</div>
</div>

<h2>数值 · 这张卡的属性</h2>
<div class="panel">
<table>
<tr><th>属性</th><th>数值</th><th>原版范围</th></tr>
${statRows || '<tr><td colspan="3" style="color:#8a7a60">没有属性</td></tr>'}
</table>
<div class="note">标签用的是<b>中文显示名</b>，不是 code。改名会让引用它的所有条件失效。</div>
</div>

<h2>当前记录</h2>
<div class="panel">
<div><span class="pill">id ${esc(record.id)}</span><span class="pill">type ${esc(record.type)}</span><span class="pill">rare ${esc(record.rare)}</span><span class="pill">resource ${esc(Array.isArray(record.resource) ? record.resource.join(", ") : record.resource)}</span></div>
<div class="note">名字在卡面上会被<b>宽度裁切</b>，长名字请写进说明。</div>
</div>`;
}

/**
 * Build the card the way the game does, with the colours the player measured:
 *
 *   地面  reference/plates/card-<tier>.png   the shipped `card` paper, recoloured per tier
 *   卡面  image/cards/<id>.png              transparent, top fifth left empty
 *   名字  TextMeshPro in the game; drawn as text here
 *
 * card.png already carries the diamond divider and the ornate bottom band, so no extra
 * frame is stacked. The name goes on last, over the empty top fifth.
 */
function composeCard(modDir, id, rare, name, type) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const tier = ["stone", "copper", "silver", "gold"][(rare ?? 1) - 1] || "stone";
  const plateDir = path.join(here, "..", "reference", "plates");
  const fit = (f) => cropCover(decodePng(readFileSync(f)), CARD_W, CARD_H);

  const plateFile = path.join(plateDir, `card-${tier}.png`);
  const paper = path.join(plateDir, "card.png");
  // A clone has no reference art: it is DoubleCross's and never enters git. Draw a plain
  // tier-coloured plate instead of failing, and say so on the page.
  let missingPlate = false;
  let img;
  if (existsSync(plateFile)) img = fit(plateFile);
  else if (existsSync(paper)) img = tint(fit(paper), CARD_ART.plate?.tierTint?.[tier] ?? "#ffffff");
  else {
    missingPlate = true;
    img = tint(cropCover(blankPlate(), CARD_W, CARD_H), CARD_ART.plate?.tierTint?.[tier] ?? "#ffffff");
  }

  const artFile = path.join(modDir, "image", "cards", `${id}.png`);
  if (existsSync(artFile)) img = overlay(img, fit(artFile));
  return { img, tier, hasArt: existsSync(artFile), missingPlate };
}

/** Flat paper-coloured rectangle, used when the extracted plate is absent. */
function blankPlate() {
  const rgba = Buffer.alloc(CARD_W * CARD_H * 4, 0xf2);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width: CARD_W, height: CARD_H, rgba };
}

/**
 * The reference set is not in git, so a fresh clone has none. Build it on the spot the
 * first time the page is generated, and show progress: the only work here is reading the
 * player's own game, which takes a few seconds.
 */
function ensureReference(quietIfPresent = true) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const need = ["card.png", "card-stone.png", "card-copper.png", "card-silver.png", "card-gold.png"].map((f) =>
    path.join(here, "..", "reference", "plates", f)
  );
  if (need.every((f) => existsSync(f))) return true;

  process.stderr.write("reference art is missing; building it from the installed game\n");
  const setup = path.join(here, "setup.mjs");
  const bar = (step) => {
    if (!process.stderr.isTTY) return;
    const filled = Math.round((step / 5) * 20);
    process.stderr.write(`\r[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${Math.round((step / 5) * 100)}%  `);
  };
  bar(0);
  const r = spawnSync(process.execPath, [setup], {
    cwd: path.join(here, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = (r.stdout || "").split("\n");
  for (const line of lines) {
    const m = line.match(/^\[(\d)\/(\d)\]\s*(.*)$/);
    if (m) bar(Number(m[1]));
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  if (r.status !== 0) {
    process.stderr.write(
      "could not build the reference art; the page will use a plain placeholder.\n" +
        (lines.slice(-3).join("\n") || "") + "\n"
    );
    return false;
  }
  for (const line of lines) if (line.startsWith("[")) process.stderr.write(`  ${line}\n`);
  return true;
}

const dataUri = (img) => encodePng(img).toString("base64");

/** Halve the size before embedding: the page is displayed at 236px wide anyway. */
const half = (img) => cropCover(img, Math.round(img.width / 2), Math.round(img.height / 2));

function plateSources(modDir, id, type) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const plateDir = path.join(here, "..", "reference", "plates");
  const sources = {};
  for (const [i, tier] of ["stone", "copper", "silver", "gold"].entries()) {
    const f = path.join(plateDir, `card-${tier}.png`);
    if (existsSync(f)) sources[i + 1] = `data:image/png;base64,${dataUri(half(cropCover(decodePng(readFileSync(f)), CARD_W, CARD_H)))}`;
  }
  const artFile = path.join(modDir, "image", "cards", `${id}.png`);
  const art = existsSync(artFile)
    ? `data:image/png;base64,${dataUri(half(cropCover(decodePng(readFileSync(artFile)), CARD_W, CARD_H)))}`
    : null;
  return { sources, art };
}

/**
 * The card is drawn live in a canvas so the rarity and the name respond immediately.
 * A static composite sits under it for the case where scripts do not run, which is what
 * happens inside the game's panel.
 */
function artInline(modDir, id, rare, name, type, fontFamily) {
  const nameFamily = fontFamily || "ui-serif, Georgia, serif";
  const { img, tier, missingPlate } = composeCard(modDir, id, rare, name, type);
  const plateNote = missingPlate
    ? `<div class="note" style="margin-top:8px">用的是<b>占位底图</b>：原版纸纹没解出来。先跑 <code>node tools/setup.mjs</code>。</div>`
    : "";
  const { sources, art } = plateSources(modDir, id, type);
  const payload = JSON.stringify({ plates: sources, art, name, rare });
  return `<div style="position:relative;width:236px">
  <img id="cardStatic" src="data:image/png;base64,${dataUri(half(img))}" style="width:236px;display:block;border:1px solid #57452c" alt="${esc(tier)} card">
  <canvas id="cardCanvas" width="236" height="514" style="display:none;border:1px solid #57452c"></canvas>
  <div id="cardName" style="position:absolute;left:5%;right:5%;top:3.5%;text-align:center;white-space:nowrap;overflow:hidden;font:700 ${nameFont(name)}px/1.05 ${nameFamily};color:#20180f;letter-spacing:0;text-shadow:0 1px 0 rgba(255,255,255,.3)">${esc(name)}</div>
</div>${plateNote}
<script type="application/json" id="cardPayload">${payload}</script>
<script>
(function () {
  var payload = JSON.parse(document.getElementById("cardPayload").textContent);
  var canvas = document.getElementById("cardCanvas");
  var staticImg = document.getElementById("cardStatic");
  if (!canvas.getContext) return;                       // no canvas: keep the static card
  var ctx = canvas.getContext("2d");
  var plate = new Image(), art = new Image();
  var wantPlate = payload.rare || 1;
  var wantArt = Boolean(payload.art);
  var name = payload.name || "";
  var shown = false;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (plate.complete && plate.naturalWidth) ctx.drawImage(plate, 0, 0, canvas.width, canvas.height);
    if (wantArt && art.complete && art.naturalWidth) ctx.drawImage(art, 0, 0, canvas.width, canvas.height);
  }
  function reveal() {
    if (shown) return;
    shown = true;
    staticImg.style.display = "none";
    canvas.style.display = "block";
  }
  // Every load redraws. The first load also swaps the static card for the canvas.
  plate.onload = function () { reveal(); draw(); };
  art.onload = function () { reveal(); draw(); };

  plate.src = payload.plates[wantPlate];
  if (wantArt) art.src = payload.art;

})();
</script>`;
}

/**
 * The game sets the name large: in a real card, two characters fill about half the width.
 * A longer name shrinks so it stays on one line instead of wrapping onto the art.
 */
function nameFont(name) {
  const n = Math.max(1, [...String(name)].length);
  return n <= 2 ? 56 : Math.min(46, Math.floor(200 / n));
}

function riteBody(record) {
  const slots = Object.entries(record.cards_slot || {})
    .map(([name, slot]) => {
      const cond = slot.condition && Object.keys(slot.condition).length ? JSON.stringify(slot.condition) : "任意卡";
      return `<tr>
  <td><code>${esc(name)}</code></td>
  <td>${esc(slot.text || "")}</td>
  <td>${esc(cond)}</td>
  <td class="num">${slot.is_empty ? "可空" : "必填"}</td>
</tr>`;
    })
    .join("\n");

  const branches = (record.settlement || [])
    .map((b, i) => {
      const cond = b.condition && Object.keys(b.condition).length ? JSON.stringify(b.condition, null, 1) : "（无条件是兜底，必须放最后）";
      const ops = Object.keys(b.result || {});
      return `<div class="branch">
  <div class="when">第 ${i + 1} 条 · 条件 ${esc(cond)}</div>
  <div><b>${esc(b.result_title || "（无标题）")}</b></div>
  <div style="color:#cfc0a2">${esc(b.result_text || "")}</div>
  <div class="note">执行：${ops.map((o) => `<code>${esc(o)}</code>`).join(" ") || "无"}</div>
</div>`;
    })
    .join("\n");

  return `
<h2>仪式</h2>
<div class="panel">
  <div class="row"><div class="lbl">名字</div><div class="val">${esc(record.name)}</div></div>
  <div class="row"><div class="lbl">地点</div><div class="val">${esc(record.location)}</div></div>
  <div class="row"><div class="lbl">持续回合</div><div class="val">${esc(record.round_number)}</div></div>
  <div class="row"><div class="lbl">说明</div><div class="val" style="white-space:pre-wrap">${esc(record.text || "（无）")}</div></div>
</div>
<div class="note">地点格式必须是 <code>地区:[最小,最大]</code>。</div>

<h2>槽位</h2>
<div class="panel">
<table>
<tr><th>槽</th><th>提示文字</th><th>只接受</th><th>空缺</th></tr>
${slots || '<tr><td colspan="4" style="color:#8a7a60">还没有槽位</td></tr>'}
</table>
</div>

<h2>结果分支</h2>
<div class="panel">
${branches || '<div style="color:#8a7a60">还没有分支</div>'}
<div class="note">前两个数组在第一条命中时停止，所以空条件只能放最后；<code>settlement_extre</code> 会把命中的全部执行。</div>
</div>

<h2>当前记录</h2>
<div class="panel">
<div><span class="pill">id ${esc(record.id)}</span><span class="pill">mapping ${esc(record.mapping_id ?? "未设置")}</span><span class="pill">等待 ${esc(record.waiting_round)} 回合</span><span class="pill">${Object.keys(record.cards_slot || {}).length} 槽</span></div>
</div>`;
}

/**
 * An event page, in the shape the rite page already uses: the facts that matter, read-only
 * branch list, then the feedback box the player writes into.
 *
 * An event is not a rite: it has no slots and its settlement is a sequence, not a choice.
 * 1866 of 1867 events carry exactly one branch, and all matching branches run in order —
 * branching happens inside `action` (option / case:opN / success / failed).
 */
function eventBody(record) {
  const on = Object.entries(record.on || {})
    .map(([k, v]) => `<span class="pill">${esc(k)} = ${esc(Array.isArray(v) ? v.join(", ") : v)}</span>`)
    .join("") || '<span style="color:#8a7a60">没有触发</span>';
  const cond = record.condition && Object.keys(record.condition).length ? JSON.stringify(record.condition) : "无条件";
  const branches = (record.settlement || [])
    .map((b, i) => {
      const ops = Object.keys(b.result || {});
      const act = Object.keys(b.action || {});
      return `<div class="branch">
  <div class="when">第 ${i + 1} 条${b.condition && Object.keys(b.condition).length ? " · 有条件" : " · 无条件"}</div>
  <div><b>${esc(b.result_title || "（无标题）")}</b></div>
  <div style="color:#cfc0a2">${esc(b.result_text || "")}</div>
  <div class="note">结果：${ops.map((o) => `<code>${esc(o)}</code>`).join(" ") || "无"}</div>
  <div class="note">动作：${act.map((o) => `<code>${esc(o)}</code>`).join(" ") || "无"}</div>
</div>`;
    })
    .join("\n");

  return `
<h2>事件</h2>
<div class="panel">
  <div class="row"><div class="lbl">备注明</div><div class="val">${esc(record.text || "（无）")}</div></div>
  <div class="row"><div class="lbl">触发</div><div>${on}</div></div>
  <div class="row"><div class="lbl">条件</div><div><code>${esc(cond)}</code></div></div>
  <div class="row"><div class="lbl">可重复</div><div class="val">${record.is_replay ? "每回合可以再触发" : "只触发一次"}</div></div>
  <div class="row"><div class="lbl">启动即检查</div><div class="val">${record.start_trigger ? "一开始就检查条件" : "等时机到再检查"}</div></div>
</div>
<div class="note">事件的结算分支是<b>顺序全部执行</b>，不是首条命中。分支选择发生在 <code>action</code> 里（option / case:opN / success / failed）。</div>

<h2>结算分支</h2>
<div class="panel">
${branches || '<div style="color:#8a7a60">还没有分支</div>'}
</div>

<h2>当前记录</h2>
<div class="panel">
<div><span class="pill">id ${esc(record.id)}</span><span class="pill">${(record.settlement || []).length} 条分支</span><span class="pill">${Object.keys(record.on || {}).length} 个触发</span></div>
</div>`;
}

function main() {
  const argv = process.argv.slice(2);
  const kind = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!["card", "rite", "event"].includes(kind) || !args.mod || !args.id) {
    process.stderr.write("usage: node tools/page.mjs <card|rite|event> --mod <dir> --id <id> [--spec <file|->] [--out <file>]\n");
    return 2;
  }
  // Opening the editor is the moment the art is first needed, so that is when it is built.
  ensureReference();

  let mod;
  let record;
  let proposal = false;
  try {
    mod = openMod(args.mod);
    if (args.spec) {
      // A proposal: the JSON is given here, the mod is only used for the palette and the art.
      const text = args.spec === "-" ? readFileSync(0, "utf8") : readFileSync(args.spec, "utf8");
      try {
        record = JSON.parse(text);
      } catch (e) {
        process.stdout.write(`FAIL  --spec is not valid JSON: ${e.message}\n`);
        return 1;
      }
      proposal = true;
    } else {
      const got = mod.get(kind, args.id);
      if (!got) {
        process.stdout.write(`FAIL  no ${kind} ${args.id} in this mod (to preview one that is not written yet, pass --spec)\n`);
        return 1;
      }
      record = toPlain(got.doc, got.node);
    }
  } catch (e) {
    if (e instanceof ModelError) {
      process.stdout.write(`FAIL  ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const title =
    kind === "card" ? record.name || `卡 ${record.id}` : kind === "rite" ? record.name || `仪式 ${record.id}` : `事件 ${record.id}`;
  const mark = proposal ? "提案 · 尚未写入 mod · " : "";
  const sub =
    kind === "card"
      ? `${mark}卡牌 · id ${record.id} · ${record.type} · 稀有度 ${record.rare}`
      : kind === "rite"
        ? `仪式 · id ${record.id} · ${Object.keys(record.cards_slot || {}).length} 个槽 · ${(record.settlement || []).length} 条结果`
        : `事件 · id ${record.id} · ${Object.keys(record.on || {}).length} 个触发 · ${(record.settlement || []).length} 条分支`;
  const html = pageHtml({
    title,
    sub,
    body: kind === "card" ? cardBody(record, mod.dir) : kind === "rite" ? riteBody(record) : eventBody(record),
  });
  const out = args.out || path.join(mod.dir, ".preview", `${kind}-${args.id}.modpage.html`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  process.stdout.write(`PASS  wrote ${out}\n`);
  process.stdout.write(
    proposal
      ? `NEXT  show it to the player; nothing was written. Write the record only after they agree\n`
      : `NEXT  show it to the player, then change the record from what they answer in chat\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("page.mjs")) process.exit(main());
