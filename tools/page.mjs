#!/usr/bin/env node
/**
 * page.mjs — turn a mod record into one self-contained page the player can read and
 * mark up.
 *
 *   node tools/page.mjs card --mod your_mods/x --id 2100900
 *   node tools/page.mjs rite --mod your_mods/x --id 5010901
 *   node tools/page.mjs card --mod your_mods/x --id 2100900 --out /tmp/x.html
 *
 * The page writes nothing and runs no script: the game panel injects the markup, so a
 * <script> would never run. Values are shown as form controls so the player can change
 * them with a click, and the panel saves each named control with their comments. The
 * agent then applies what they picked with tools/card.mjs or tools/story.mjs.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { openMod, ModelError } from "./model.mjs";
import { toPlain } from "./jsonc.mjs";
import { decodePng, encodePng, cropCover, overlay, solid, nineSlice, tint } from "./png.mjs";
import { composePrompt } from "./art.mjs";

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

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const CSS = `
:root {
  --ink: #efe3c8;
  --dim: #b9a887;
  --paper: #221c16;
  --panel: #2c241c;
  --rule: #57452c;
  --gold: #c9a227;
  --bad: #b4543f;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 28px 20px 64px;
  background: radial-gradient(circle at 50% 0%, #2e2519 0%, #17120c 100%);
  color: var(--ink);
  font: 15px/1.6 ui-serif, Georgia, "Songti SC", serif;
}
.wrap { max-width: 860px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: .04em; }
h2 { font-size: 15px; margin: 34px 0 10px; color: var(--gold); letter-spacing: .12em; text-transform: uppercase; }
.sub { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
.panel { background: var(--panel); border: 1px solid var(--rule); padding: 16px 18px; }
.row { display: grid; grid-template-columns: 118px 1fr; gap: 10px; align-items: start; padding: 7px 0; border-bottom: 1px dotted #3c3227; }
.row:last-child { border-bottom: 0; }
.lbl { color: var(--dim); font-size: 13px; padding-top: 6px; }
input[type=text], input[type=number], textarea, select {
  width: 100%; background: #1a1510; color: var(--ink);
  border: 1px solid var(--rule); padding: 6px 8px; font: inherit; font-size: 14px;
}
textarea { min-height: 84px; resize: vertical; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #362c21; }
th { color: var(--dim); font-weight: normal; font-size: 12px; letter-spacing: .08em; }
td.num { width: 92px; }
.cardface {
  width: 236px; aspect-ratio: 472 / 1028; border: 1px solid var(--rule);
  background: repeating-linear-gradient(45deg, #3a2f22, #3a2f22 10px, #322819 10px, #322819 20px);
  display: flex; align-items: center; justify-content: center; text-align: center;
  color: var(--dim); font-size: 12px; padding: 14px;
}
.split { display: flex; gap: 22px; align-items: flex-start; flex-wrap: wrap; }
.grow { flex: 1 1 380px; }
.pill { display: inline-block; border: 1px solid var(--rule); padding: 1px 8px; margin: 0 6px 6px 0; font-size: 12px; color: var(--dim); }
.bad { color: var(--bad); }
.note { color: var(--dim); font-size: 12.5px; margin-top: 10px; }
.branch { border-left: 2px solid var(--rule); padding: 8px 0 8px 14px; margin-bottom: 12px; }
.branch .when { color: var(--gold); font-size: 12px; letter-spacing: .06em; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; color: #d9c9a3; }
.fb { min-height: 120px; }
`;

function pageHtml({ title, sub, body }) {
  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${CSS}</style>
<div class="wrap">
<h1>${esc(title)}</h1>
<div class="sub">${sub}</div>
${body}
<h2>你的意见</h2>
<div class="panel">
<div class="note">在下面写，或者直接改上面的输入框。改完保存后告诉我，我按你选的值落地。</div>
<textarea class="fb" name="feedback" placeholder="哪一项要改、改成什么；哪一段剧情不对；卡面想要什么风格。"></textarea>
</div>
</div>
`;
}

function cardBody(record, prompt, modDir) {
  const tags = Object.entries(record.tag || {});
  // A marker tag is present or absent: every vanilla use is exactly 1. A stat tag carries a
  // number and has an observed range. Rendering both as numbers invites a value the game never sees.
  const markerRows = tags
    .filter(([name]) => TAG_ROLES.marker[name])
    .map(
      ([name]) => `<tr>
  <td>${esc(name)}</td>
  <td class="num"><input type="checkbox" name="tag_${esc(name)}" value="1" checked> 有</td>
  <td><input type="checkbox" name="tag_drop_${esc(name)}"> 删掉</td>
</tr>`,
    )
    .join("\n");
  const statRows = tags
    .filter(([name]) => !TAG_ROLES.marker[name])
    .map(([name, value]) => {
      const range = TAG_ROLES.stat[name];
      return `<tr>
  <td>${esc(name)}</td>
  <td class="num"><input type="number" name="tag_${esc(name)}" value="${esc(value)}"></td>
  <td style="color:#8a7a60;font-size:12px">${range ? `${range.min} … ${range.max}` : "自定义"}</td>
</tr>`;
    })
    .join("\n");

  return `
<h2>卡面</h2>
<div class="split">
  ${artInline(modDir, record.id, record.rare, record.name, record.type) || '<div class="cardface">472 × 1028<br>卡面图放这里<br><span style="opacity:.6">只替换内部画面，边框由游戏画</span></div>'}
  <div class="grow">
    <div class="panel">
      <div class="row"><div class="lbl">名字</div><div><input type="text" name="name" value="${esc(record.name)}"></div></div>
      <div class="row"><div class="lbl">副标题</div><div><input type="text" name="title" value="${esc(record.title || "")}"></div></div>
      <div class="row"><div class="lbl">类别</div><div><select name="type">
        ${["item", "char", "sudan"].map((t) => `<option value="${t}"${record.type === t ? " selected" : ""}>${t}</option>`).join("")}
      </select></div></div>
      <div class="row"><div class="lbl">稀有度</div><div><select name="rare">
        ${[1, 2, 3, 4].map((r) => `<option value="${r}"${record.rare === r ? " selected" : ""}>${r} · ${["石块", "铜", "银", "金"][r - 1]}</option>`).join("")}
      </select></div></div>
      <div class="row"><div class="lbl">说明</div><div><textarea name="text">${esc(record.text || "")}</textarea></div></div>
      <div class="row"><div class="lbl">可装备槽</div><div><input type="text" name="equips" value="${esc((record.equips || []).join(","))}"></div></div>
      <div class="row"><div class="lbl">唯一</div><div><input type="checkbox" name="is_only"${record.is_only ? " checked" : ""}> 只能有一张</div></div>
    </div>
  </div>
</div>

<h2>四档对照 · 同一张卡面</h2>
<div class="panel">
${tierStrip(modDir, record.id, record.name, record.type)}
<div class="note">底牌是游戏里那张 card 纸，按你从截图量的四个颜色重新上色。卡面只在最上层叠一次。</div>
</div>

<h2>画面 · 交给 Tripo 的提示词</h2>
<div class="panel">
<div class="note" style="margin-top:0">生成的是方图，会自动居中裁成 472 × 1028。所以要<b>竖构图、主体撑满高度</b>，横向的东西会被切掉。</div>
<textarea name="art_prompt" style="min-height:120px">${esc(prompt)}</textarea>
<div class="note">风格写在这句里：flat engraved、暖色低饱和、可见线稿、做旧纸质。改这句话比改别的地方更直接。</div>
</div>

<h2>标记 · 有或没有</h2>
<div class="panel">
<table>
<tr><th>标记</th><th>状态</th><th></th></tr>
${markerRows || '<tr><td colspan="3" style="color:#8a7a60">没有标记</td></tr>'}
</table>
<div class="note">这些标签在游戏里只可能是 1（有）或不存在。1294 张卡里没有一张用过别的值。</div>
</div>

<h2>数值 · 这张卡的属性</h2>
<div class="panel">
<table>
<tr><th>属性</th><th>数值</th><th>原版范围</th></tr>
${statRows || '<tr><td colspan="3" style="color:#8a7a60">没有属性</td></tr>'}
<tr><td><input type="text" name="tag_new_name" placeholder="新属性（中文名）"></td>
    <td class="num"><input type="number" name="tag_new_value" value="1"></td>
    <td></td></tr>
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
  let img = existsSync(plateFile)
    ? fit(plateFile)
    : tint(fit(path.join(plateDir, "card.png")), CARD_ART.plate?.tierTint?.[tier] ?? "#ffffff");

  const artFile = path.join(modDir, "image", "cards", `${id}.png`);
  if (existsSync(artFile)) img = overlay(img, fit(artFile));
  return { img, tier, hasArt: existsSync(artFile) };
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
function artInline(modDir, id, rare, name, type) {
  const { img, tier } = composeCard(modDir, id, rare, name, type);
  const { sources, art } = plateSources(modDir, id, type);
  const payload = JSON.stringify({ plates: sources, art, name, rare });
  return `<div style="position:relative;width:236px">
  <img id="cardStatic" src="data:image/png;base64,${dataUri(half(img))}" style="width:236px;display:block;border:1px solid #57452c" alt="${esc(tier)} card">
  <canvas id="cardCanvas" width="236" height="514" style="display:none;border:1px solid #57452c"></canvas>
</div>
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
    ctx.fillStyle = "#20180f";
    ctx.font = "600 11px ui-serif, Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText(name, canvas.width / 2, 26);
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

  // The script sits above the fields in the document, so the controls do not exist yet
  // when it runs. Wire them once the document has parsed.
  function wire() {
    var rareSelect = document.querySelector('select[name="rare"]');
    if (rareSelect) rareSelect.addEventListener("change", function () {
      var v = Number(rareSelect.value) || 1;
      if (payload.plates[v]) { wantPlate = v; plate.src = payload.plates[v]; }
    });
    var nameInput = document.querySelector('input[name="name"]');
    if (nameInput) nameInput.addEventListener("input", function () { name = nameInput.value; draw(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
</script>`;
}

/** The same card in all four tiers, so the colour can be judged at a glance. */
function tierStrip(modDir, id, name, type) {
  const cells = [1, 2, 3, 4]
    .map((rare) => {
      const { img } = composeCard(modDir, id, rare, name, type);
      const label = `<div style="position:absolute;left:0;right:0;top:4%;text-align:center;font:600 11px ui-serif,Georgia,serif;color:#20180f;letter-spacing:.1em">${esc(name)}</div>`;
      return `<div style="flex:0 0 108px"><div style="position:relative;border:1px solid #57452c"><img src="data:image/png;base64,${dataUri(half(img))}" style="width:100%;display:block">${label}</div><div style="text-align:center;color:#8a7a60;font-size:11px;margin-top:4px">${["石块", "铜", "银", "金"][rare - 1]}</div></div>`;
    })
    .join("");
  return `<div style="display:flex;gap:12px;flex-wrap:wrap">${cells}</div>`;
}

function riteBody(record) {
  const slots = Object.entries(record.cards_slot || {})
    .map(([name, slot]) => {
      const cond = slot.condition && Object.keys(slot.condition).length ? JSON.stringify(slot.condition) : "任意卡";
      return `<tr>
  <td><code>${esc(name)}</code></td>
  <td>${esc(slot.text || "")}</td>
  <td>${esc(cond)}</td>
  <td class="num"><select name="slot_empty_${esc(name)}">
    <option value="0"${slot.is_empty === 0 ? " selected" : ""}>0 必填</option>
    <option value="1"${slot.is_empty === 1 ? " selected" : ""}>1 可空</option>
  </select></td>
  <td><input type="checkbox" name="slot_drop_${esc(name)}"> 删掉</td>
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
  <div class="row"><div class="lbl">名字</div><div><input type="text" name="name" value="${esc(record.name)}"></div></div>
  <div class="row"><div class="lbl">地点</div><div><input type="text" name="location" value="${esc(record.location)}"></div></div>
  <div class="row"><div class="lbl">持续回合</div><div><input type="number" name="round_number" value="${esc(record.round_number)}"></div></div>
  <div class="row"><div class="lbl">说明</div><div><textarea name="text">${esc(record.text || "")}</textarea></div></div>
</div>
<div class="note">地点格式必须是 <code>地区:[最小,最大]</code>。</div>

<h2>槽位</h2>
<div class="panel">
<table>
<tr><th>槽</th><th>提示文字</th><th>只接受</th><th>空缺</th><th></th></tr>
${slots || '<tr><td colspan="5" style="color:#8a7a60">还没有槽位</td></tr>'}
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

function main() {
  const argv = process.argv.slice(2);
  const kind = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!["card", "rite"].includes(kind) || !args.mod || !args.id) {
    process.stderr.write("usage: node tools/page.mjs <card|rite> --mod <dir> --id <id> [--out <file>]\n");
    return 2;
  }
  let mod;
  let got;
  try {
    mod = openMod(args.mod);
    got = mod.get(kind, args.id);
  } catch (e) {
    if (e instanceof ModelError) {
      process.stdout.write(`FAIL  ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  if (!got) {
    process.stdout.write(`FAIL  no ${kind} ${args.id} in this mod\n`);
    return 1;
  }
  const record = toPlain(got.doc, got.node);
  const title = kind === "card" ? record.name || `卡 ${record.id}` : record.name || `仪式 ${record.id}`;
  const sub =
    kind === "card"
      ? `卡牌 · id ${record.id} · ${record.type} · 稀有度 ${record.rare}`
      : `仪式 · id ${record.id} · ${Object.keys(record.cards_slot || {}).length} 个槽 · ${(record.settlement || []).length} 条结果`;
  const html = pageHtml({
    title,
    sub,
    body: kind === "card" ? cardBody(record, composePrompt(record), mod.dir) : riteBody(record),
  });
  const out = args.out || path.join(mod.dir, ".preview", `${kind}-${args.id}.modpage.html`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  process.stdout.write(`PASS  wrote ${out}\n`);
  process.stdout.write(`NEXT  open it and mark it up; tell me what to change\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("page.mjs")) process.exit(main());
