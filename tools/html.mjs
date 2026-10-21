/**
 * Shared HTML shell for every page this repo generates.
 *
 * page.mjs and graphpage.mjs both need the same escaping, the same palette and the same
 * panel shapes. Keeping one copy here is the only way they cannot drift apart.
 */

/** Escape text for an HTML text node or a double-quoted attribute. */
export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The palette and widget styles, shared by every page. */
export const CSS = `
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
.wrap.wide { max-width: none; }
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
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #362c21; vertical-align: top; word-break: break-word; }
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
.pill {
  display: inline-block; border: 1px solid var(--rule); padding: 1px 8px; margin: 0 6px 6px 0;
  font-size: 12px; color: var(--dim); background: transparent; font-family: inherit; cursor: pointer;
}
.pill:hover { border-color: var(--gold); color: var(--ink); }
.pill.on { background: var(--gold); border-color: var(--gold); color: #1a1510; font-weight: 600; }
.bad { color: var(--bad); }
.note { color: var(--dim); font-size: 12.5px; margin-top: 10px; }
.branch { border-left: 2px solid var(--rule); padding: 8px 0 8px 14px; margin-bottom: 12px; }
.branch .when { color: var(--gold); font-size: 12px; letter-spacing: .06em; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; color: #d9c9a3; word-break: break-all; }
details { margin-top: 4px; }
summary { cursor: pointer; color: var(--dim); font-size: 12px; }
details[open] summary { color: var(--ink); }
table.sub { margin-top: 6px; background: #262019; border: 1px solid #3c3227; }
table.sub th, table.sub td { font-size: 12.5px; padding: 4px 6px; border-bottom: 1px dotted #3c3227; }
table.sub th { width: 42%; color: var(--dim); }
.fb { min-height: 120px; }
`;

/**
 * The page frame. `font` is optional `{css, family}` from a caller that embeds a
 * typeface; `wide` drops the 860px cap for canvas pages.
 */
export function pageHtml({ title, sub, body, font = null, wide = false, extraCss = "" }) {
  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${CSS}
${extraCss}
${font ? font.css : ""}</style>
<div class="wrap${wide ? " wide" : ""}">
<h1>${esc(title)}</h1>
<div class="sub">${sub}</div>
${body}
</div>
`;
}

export default { esc, CSS, pageHtml };
