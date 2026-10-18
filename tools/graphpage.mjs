#!/usr/bin/env node
/**
 * graphpage.mjs — render the story graph as one page: a list on the left, a canvas on the
 * right, a category switcher in the top right, and a node that opens its own editor.
 *
 *   node tools/graphpage.mjs --out .preview/graph/graph.html [--mod your_mods/x]
 *
 * Positions are computed here, in Node, not in the browser: the canvas only reads them.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph } from "./graph.mjs";
import { esc, pageHtml } from "./html.mjs";
import { DEFAULT_VANILLA } from "./model.mjs";

const ROW_H = 26;
const COL_W = 268;
const VIEW_H = 880; // one screenful: the plan's "column height = one screen"
const PER_COL = Math.floor(VIEW_H / ROW_H);

/** Assign a column and a y for every node, per category, in a stable order. */
export function layout(g) {
  const order = ["unused", "reputation", "ending", "guide", "achievement", "daily", "periodic", "other"];
  const groups = new Map();
  for (const n of g.nodes) {
    const cat = n.cat || (n.t === "card" ? "card" : n.t === "counter" ? "counter" : "other");
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(n);
  }
  // deterministic grouping key inside a category, so the layout never jitters
  const groupKey = (n) => {
    if (n.t === "event") return String(n.id).slice(0, 5);
    if (n.t === "rite") return String(Math.floor(Number(n.id) / 1000));
    return n.t;
  };
  for (const [, list] of groups) {
    list.sort((a, b) => (groupKey(a) < groupKey(b) ? -1 : groupKey(a) > groupKey(b) ? 1 : Number(a.id) - Number(b.id)));
  }
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  let col = 0;
  for (const cat of cats) {
    const list = groups.get(cat);
    let i = 0;
    let currentKey = null;
    let used = PER_COL; // force a new column at the start of a category
    for (const n of list) {
      const key = groupKey(n);
      if (key !== currentKey || used >= PER_COL) {
        if (used >= PER_COL) {
          col += key === currentKey ? 0 : 1;
          used = 0;
        }
        currentKey = key;
      }
      n.col = col;
      n.y = used * ROW_H;
      used++;
    }
    col += 1; // a category always starts a fresh column
  }
  return g;
}

/** The payload the page needs: nodes and edges only, with labels in all four languages. */
export function payload(g) {
  const index = new Map(g.nodes.map((n, i) => [n.k, i]));
  return {
    builtAt: g.builtAt,
    nodes: g.nodes.map((n) => ({
      k: n.k,
      t: n.t,
      id: n.id,
      c: n.cat || "other",
      o: n.o,
      l: n.l,
      x: (n.col || 0) * COL_W,
      y: n.y || 0,
      ch: Boolean(n.chain),
      b: (() => {
        const levels = (n.badges || []).map((x) => x.level);
        return levels.includes("FAIL") ? "FAIL" : levels.includes("WARN") ? "WARN" : levels.includes("INFO") ? "INFO" : null;
      })(),
      bm: (n.badges || []).map((x) => x.code),
      d: 0,
    })),
    edges: g.edges.filter((e) => index.has(e.f) && index.has(e.t)).map((e) => [index.get(e.f), index.get(e.t), e.r]),
    counts: g.counts,
    categoryCounts: g.categoryCounts,
    components: { count: g.components.count, largest: g.components.largest },
  };
}


const SCRIPT = (payloadJson) => `
const DATA = ${payloadJson};
const ROW_H = ${ROW_H}, COL_W = ${COL_W}, VIEW_H = ${VIEW_H};
const cv = document.getElementById("cv"), ctx = cv.getContext("2d");
const listEl = document.getElementById("list"), qEl = document.getElementById("q");
const canvasWrap = document.getElementById("cwrap");
let lang = "zh", cat = null, chainOnly = false, zoom = 1, selected = null;

const CAT_COLOR = {
  unused: "#6b6257", reputation: "#b07a4a", ending: "#c96f5a", guide: "#7f9e8a",
  achievement: "#8d84b8", daily: "#7d8fa8", periodic: "#6f7f96", other: "#8a7a60",
  card: "#b9a887", counter: "#5e5a52",
};

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function visible() {
  return DATA.nodes.filter((n) => !cat || n.c === cat).filter((n) => !chainOnly || n.ch);
}

function layoutView(nodes) {
  const per = Math.floor(VIEW_H / ROW_H);
  nodes.forEach((n, i) => { n.vx = Math.floor(i / per) * COL_W; n.vy = (i % per) * ROW_H; });
  return nodes;
}

function draw() {
  const nodes = layoutView(visible());
  const idx = new Map(nodes.map((n, i) => [n.k, i]));
  const w = Math.max(1, ...nodes.map((n) => n.vx + COL_W));
  const h = Math.max(VIEW_H, ...nodes.map((n) => n.vy + ROW_H));
  cv.width = Math.max(w * zoom, canvasWrap.clientWidth);
  cv.height = Math.max(h * zoom, 320);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(zoom, 0, 0, zoom, 0, 0);
  ctx.font = "12px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 0.6;
  for (const [a, b] of DATA.edges) {
    const na = nodes[idx.get(DATA.nodes[a].k)], nb = nodes[idx.get(DATA.nodes[b].k)];
    if (!na || !nb) continue;
    ctx.strokeStyle = "rgba(201,162,39,0.18)";
    ctx.beginPath();
    ctx.moveTo(na.vx + 210, na.vy + ROW_H / 2);
    ctx.lineTo(nb.vx, nb.vy + ROW_H / 2);
    ctx.stroke();
  }
  for (const n of nodes) {
    const hot = selected === n.k;
    ctx.fillStyle = hot ? "#c9a227" : CAT_COLOR[n.c] || "#8a7a60";
    ctx.globalAlpha = n.o === "mod" ? 1 : 0.9;
    ctx.fillRect(n.vx, n.vy + 5, 4, ROW_H - 10);
    ctx.globalAlpha = 1;
    ctx.fillStyle = hot ? "#fff4d0" : n.o === "mod" ? "#ffd9a0" : "#d7c9ab";
    ctx.fillText((n.id + "  " + (n.l[lang] || n.l.zh || "")).slice(0, 34), n.vx + 12, n.vy + ROW_H / 2);
    if (n.b) {
      ctx.fillStyle = n.b === "FAIL" ? "#b4543f" : n.b === "WARN" ? "#c9a227" : "#7f9e8a";
      ctx.beginPath();
      ctx.arc(n.vx + 246, n.vy + ROW_H / 2, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (n.o === "mod") { ctx.fillStyle = "#c9a227"; ctx.fillText("mod", n.vx + 210, n.vy + ROW_H / 2); }
  }
}

function listRows() {
  const q = qEl.value.trim().toLowerCase();
  const nodes = visible().filter((n) => {
    if (!q) return true;
    return ["zh", "en", "ja", "zhTW"].some((l) => (n.l[l] || "").toLowerCase().includes(q)) || n.id.includes(q);
  });
  listEl.innerHTML = nodes.slice(0, 600).map((n) =>
    '<div class="row" data-k="' + n.k + '"><span class="id">' + n.id + '</span><span class="nm">' +
    (n.b ? '<span class="badge ' + n.b + '">' + n.b + "</span> " : "") +
    escHtml((n.l[lang] || n.l.zh || "").slice(0, 40)) + "</span></div>"
  ).join("") || '<div class="note">没有匹配</div>';
  listEl.querySelectorAll(".row").forEach((el) => { el.onclick = () => focusNode(el.dataset.k); });
  document.getElementById("count").textContent = nodes.length + " / " + DATA.nodes.length;
}

function focusNode(key) {
  selected = key;
  const nodes = layoutView(visible());
  const n = nodes.find((x) => x.k === key);
  if (n) canvasWrap.scrollTo({ left: Math.max(0, n.vx * zoom - 40), top: Math.max(0, n.vy * zoom - 60), behavior: "smooth" });
  draw();
  window.__openNode(key);
}

function cats() {
  const box = document.getElementById("cats");
  const all = [["", "全部"]].concat(Object.keys(DATA.categoryCounts).map((c) => [c, c]));
  box.innerHTML = all.map(([v, label]) =>
    '<button class="pill' + (v === cat ? " on" : "") + '" data-c="' + v + '">' + label + " " +
    (v ? (DATA.categoryCounts[v] || 0) : DATA.nodes.length) + "</button>"
  ).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { cat = b.dataset.c || null; cats(); listRows(); draw(); };
  });
}

// ---------------------------------------------------------------- node panel
const BYKEY = new Map(DATA.nodes.map((n, i) => [n.k, i]));
const OUT = new Map(), IN = new Map();
DATA.edges.forEach(([a, b, r]) => {
  const ka = DATA.nodes[a].k, kb = DATA.nodes[b].k;
  if (!OUT.has(ka)) OUT.set(ka, []);
  if (!IN.has(kb)) IN.set(kb, []);
  OUT.get(ka).push([kb, r]);
  IN.get(kb).push([ka, r]);
});

function chip(key) {
  const n = DATA.nodes[BYKEY.get(key)];
  if (!n) return escHtml(key);
  return '<a href="#" data-go="' + key + '">' + n.id + " " + escHtml((n.l[lang] || n.l.zh || "").slice(0, 24)) + "</a>";
}

window.__openNode = (key) => {
  const n = DATA.nodes[BYKEY.get(key)];
  if (!n) return;
  const out = (OUT.get(key) || []).slice(0, 40);
  const inc = (IN.get(key) || []).slice(0, 40);
  const box = document.getElementById("modal-body");
  box.innerHTML =
    '<h2 style="margin-top:0">' + escHtml(n.id) + " · " + escHtml(n.t) + "</h2>" +
    '<div class="note" style="margin-top:0">' + escHtml(n.c) + " · " +
    (n.o === "mod" ? "mod 覆盖/新增" : "vanilla") + " · " +
    (n.ch ? "在剧情链上（分量 " + n.compSize + "）" : "不在链上") +
    (n.b ? " · " + n.b + "：" + escHtml((n.bm || []).join(", ")) : "") + "</div>" +
    "<table>" +
    "<tr><th>简中</th><td>" + escHtml(n.l.zh || "") + "</td></tr>" +
    "<tr><th>en</th><td>" + escHtml(n.l.en || "") + "</td></tr>" +
    "<tr><th>ja</th><td>" + escHtml(n.l.ja || "") + "</td></tr>" +
    "<tr><th>zhTW</th><td>" + escHtml(n.l.zhTW || "") + "</td></tr>" +
    "</table>" +
    "<h2>出边 " + out.length + '</h2><div class="note">' +
    (out.map(([k, r]) => chip(k) + " <code>" + escHtml(r) + "</code>").join("<br>") || "无") + "</div>" +
    "<h2>入边 " + inc.length + '</h2><div class="note">' +
    (inc.map(([k, r]) => chip(k) + " <code>" + escHtml(r) + "</code>").join("<br>") || "无") + "</div>" +
    '<div class="note" id="editbox">' +
    (location.protocol === "http:"
      ? '<button id="editbtn" class="pill">编辑这个节点</button>'
      : "静态页面只读：用 node tools/editor.mjs 打开才能编辑") + "</div>";
  const modal = document.getElementById("modal");
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
  box.querySelectorAll("[data-go]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); focusNode(a.dataset.go); };
  });
  const edit = document.getElementById("editbtn");
  if (edit) edit.onclick = () => openEditor(key);
};

async function openEditor(key) {
  const box = document.getElementById("modal-body");
  box.innerHTML = '<div class="note">读取中…</div>';
  const res = await fetch("/api/node/" + encodeURIComponent(key));
  const node = await res.json();
  if (!node.ok) { box.innerHTML = '<div class="note bad">' + escHtml(node.error) + "</div>"; return; }
  box.innerHTML =
    '<h2 style="margin-top:0">编辑 ' + escHtml(node.key) + "</h2>" +
    '<div class="note">' + escHtml(node.path) + "</div>" +
    '<textarea id="ed" style="min-height:420px;font-family:ui-monospace,Menlo,monospace">' + escHtml(node.source) + "</textarea>" +
    '<div class="note"><button id="save" class="pill">保存</button> <span id="saveMsg"></span></div>';
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("saveMsg");
    msg.textContent = "保存中…";
    const r = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, source: document.getElementById("ed").value }),
    });
    const out = await r.json();
    msg.textContent = out.ok ? "已保存（备份 " + out.backup + "）" : "失败：" + out.error;
  };
}

document.onkeydown = (e) => { if (e.key === "Escape") document.getElementById("modal").hidden = true; };

qEl.oninput = listRows;
document.getElementById("chain").onchange = (e) => { chainOnly = e.target.checked; listRows(); draw(); };
document.getElementById("lang").onchange = (e) => { lang = e.target.value; listRows(); draw(); };
cv.onwheel = (e) => {
  e.preventDefault();
  const next = Math.min(2, Math.max(0.4, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
  if (next !== zoom) { zoom = next; document.getElementById("z").textContent = Math.round(zoom * 100) + "%"; draw(); }
};
cv.onclick = (e) => {
  const nodes = layoutView(visible());
  const x = e.offsetX / zoom, y = e.offsetY / zoom;
  const hit = nodes.find((n) => x >= n.vx && x < n.vx + COL_W && y >= n.vy && y < n.vy + ROW_H);
  if (hit) { selected = hit.k; draw(); window.__openNode(hit.k); }
};

cats(); listRows(); draw();
`;

export function renderPage(g, { title = "苏丹的游戏 · 剧情图" } = {}) {
  const body = `
<div class="gwrap">
  <div class="gtop">
    <span class="note" style="margin:0">节点 ${g.nodes.length} · 边 ${g.edges.length} · 剧情链 ${g.components.count} 条（最大 ${g.components.largest}）</span>
    <span id="cats" class="cats"></span>
    <span class="ctl">
      <input id="q" type="text" placeholder="搜索 ID / 名字 / 任意语言">
      <label><input id="chain" type="checkbox"> 只看剧情链</label>
      <select id="lang">
        <option value="zh">简中</option><option value="en">en</option><option value="ja">ja</option><option value="zhTW">zhTW</option>
      </select>
      <span id="z" class="note" style="margin:0">100%</span>
    </span>
  </div>
  <div class="gmain">
    <div class="glist" id="list"></div>
    <div class="gcanvas" id="cwrap"><canvas id="cv"></canvas></div>
  </div>
  <div class="note">滚轮缩放 40%–200%，点节点打开编辑页。<span id="count"></span></div>
</div>
<div id="modal" class="modal" hidden><div class="modal-body" id="modal-body"></div></div>
`;
  const css = `
.gwrap { display: flex; flex-direction: column; gap: 10px; }
.gtop { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.cats { display: flex; gap: 6px; flex-wrap: wrap; }
.pill.on { border-color: var(--gold); color: var(--ink); }
.ctl { display: flex; gap: 10px; align-items: center; margin-left: auto; }
.ctl input[type=text] { width: 240px; }
.gmain { display: grid; grid-template-columns: 340px 1fr; gap: 12px; height: 78vh; }
.glist { overflow: auto; border: 1px solid var(--rule); background: var(--panel); }
.glist .row { display: grid; grid-template-columns: 76px 1fr; gap: 8px; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #2f2a24; }
.glist .row:hover { background: #35291c; }
.glist .id { color: var(--dim); font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.glist .nm { font-size: 13px; }
.gcanvas { overflow: auto; border: 1px solid var(--rule); background: #17120c; }
canvas { display: block; }
.badge { font-size: 10px; padding: 0 4px; border-radius: 2px; }
.badge.FAIL { background: var(--bad); color: #fff; }
.badge.WARN { background: var(--gold); color: #1a1510; }
.badge.INFO { background: #4f5a52; color: var(--ink); }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal[hidden] { display: none; }
.modal-body { background: var(--panel); border: 1px solid var(--rule); width: min(880px, 92vw); max-height: 86vh; overflow: auto; padding: 18px 20px; }
`;
  // The script goes after the shell: it reads DOM ids that only exist once the body is parsed.
  return (
    pageHtml({
      title,
      sub: `构建于 ${g.builtAt?.slice(0, 19).replace("T", " ") || ""}`,
      body,
      wide: true,
      extraCss: css,
    }) + `<script>${SCRIPT(JSON.stringify(payload(g)))}</script>\n`
  );
}

function parseArgs(argv) {
  const out = { configDir: DEFAULT_VANILLA, modDir: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vanilla") out.configDir = argv[++i];
    else if (a === "--mod") out.modDir = argv[++i];
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    process.stderr.write("usage: node tools/graphpage.mjs --out <file> [--mod <dir>]\n");
    return 2;
  }
  const g = buildGraph({ configDir: String(args.configDir).replace(/^~/, os.homedir()), modDir: args.modDir });
  const html = renderPage(g);
  const file = path.resolve(String(args.out).replace(/^~/, os.homedir()));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, html);
  process.stdout.write(`PASS  wrote ${file}  (${(html.length / 1048576).toFixed(1)} MB, ${g.nodes.length} nodes)\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("graphpage.mjs")) process.exit(main());
