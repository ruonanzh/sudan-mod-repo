#!/usr/bin/env node
/**
 * art.mjs — write the prompt for a card's picture, generate it, and cut it to fit.
 *
 *   node tools/art.mjs prompt --mod your_mods/x --id 2100900
 *   node tools/art.mjs gen    --mod your_mods/x --id 2100900                 # uses the composed prompt
 *   node tools/art.mjs gen    --mod your_mods/x --id 2100900 --prompt "..."  # or yours
 *   node tools/art.mjs fit    --in raw.png --out image/cards/2100900.png     # no API, no credits
 *   node tools/art.mjs check  --file image/cards/2100900.png
 *
 * `gen` spends Tripo credits. The API returns a square 2048x2048 PNG, so the picture is
 * centre-cropped to the card's 472x1028 aspect and box-downsampled to that exact size.
 * That means the prompt has to ask for a vertical composition; a wide scene loses its
 * sides. `prompt` writes one that does.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { openMod, ModelError } from "./model.mjs";
import { toPlain } from "./jsonc.mjs";
import { decodePng, encodePng, cropCover } from "./png.mjs";

const CARD_W = 472;
const CARD_H = 1028;
const TRIPO_V3 = "https://openapi.tripo3d.com/v3";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const emit = (code, message, next) => {
  process.stdout.write(`${code}  ${message}\n`);
  if (next) process.stdout.write(`NEXT  ${next}\n`);
};

/**
 * The house style, as far as the shipped cards show it: flat engraved illustration,
 * warm limited palette, visible linework. The composition clause matters most, because
 * a square generation gets cut down to a tall card.
 */
const STYLE =
  "flat engraved illustration, warm muted palette of ochre, oxblood and bone, " +
  "visible ink linework, aged paper texture, folk woodcut influence, " +
  "vertical composition with the subject filling the full height and centred, " +
  "plain dark background, no text, no border, no frame, game card art";

/** One or two sentences built from the card's own fields. */
export function composePrompt(card) {
  const tags = Object.keys(card.tag || {}).filter((t) => !["已拥有", "纯色材质", "装备", "已装备", "可堆叠"].includes(t));
  const subject = [card.name, card.title].filter(Boolean).join("，");
  const facts = card.text ? ` ${card.text}` : "";
  const flavour = tags.length ? ` Mood: ${tags.slice(0, 5).join(" / ")}.` : "";
  return `${subject}.${facts}${flavour} ${STYLE}`;
}

function requireKey() {
  const env = process.env.TRIPO_API_KEY;
  if (env) return env.trim();
  const file = path.join(homedir(), ".gamer-agent-pi", "api-keys.json");
  if (!existsSync(file)) throw new ModelError("no Tripo API key. Save it to ~/.gamer-agent-pi/api-keys.json as {\"tripo\":\"tsk_...\"}, or set TRIPO_API_KEY.");
  const key = JSON.parse(readFileSync(file, "utf8")).tripo;
  if (typeof key !== "string" || !key.trim()) throw new ModelError("~/.gamer-agent-pi/api-keys.json has no tripo key");
  return key.trim();
}

async function api(key, p, body) {
  const r = await fetch(TRIPO_V3 + p, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ModelError(`Tripo returned something that is not JSON (HTTP ${r.status}): ${text.slice(0, 200)}`);
  }
  if (r.status === 429 || json?.code === 2000)
    throw new ModelError("Tripo rate limit hit. Wait 30-60 seconds before the next generation; do not retry in a loop.");
  if (!r.ok) throw new ModelError(`Tripo HTTP ${r.status} on ${p}: ${json?.message ?? text.slice(0, 200)}`);
  return json?.data ?? json;
}

async function waitFor(key, id) {
  const started = Date.now();
  for (;;) {
    const d = await api(key, `/tasks/${id}`);
    const status = String(d?.status);
    if (status === "success") return d;
    if (["failed", "banned", "expired", "cancelled"].includes(status))
      throw new ModelError(`Tripo task ${id} ended as ${status}: ${JSON.stringify(d?.task ?? d).slice(0, 300)}`);
    if (Date.now() - started > 900_000) throw new ModelError(`Tripo task ${id} did not finish within 15 minutes`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const pickUrl = (o) => Object.values(o ?? {}).find((v) => typeof v === "string" && v.startsWith("http")) ?? null;

function loadCard(args) {
  const mod = openMod(args.mod);
  const got = mod.get("card", args.id);
  if (!got) throw new ModelError(`no card ${args.id} in this mod`);
  return { mod, card: toPlain(got.doc, got.node) };
}

function cmdPrompt(args) {
  const { card } = loadCard(args);
  process.stdout.write(composePrompt(card) + "\n");
  return 0;
}

function cmdFit(args) {
  if (!args.in || !args.out) throw new ModelError("--in and --out are required");
  if (!existsSync(args.in)) throw new ModelError(`no such file: ${args.in}`);
  const img = decodePng(readFileSync(args.in));
  const fitted = cropCover(img, CARD_W, CARD_H);
  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, encodePng(fitted));
  emit("PASS", `wrote ${args.out} (${CARD_W}x${CARD_H})`, "point the card at it with: node tools/card.mjs art --mod <mod> --id <id> --from <file>");
  return 0;
}

function cmdCheck(args) {
  const file = args.file;
  if (!file || !existsSync(file)) throw new ModelError(`no such file: ${file}`);
  const img = decodePng(readFileSync(file));
  if (img.width !== CARD_W || img.height !== CARD_H) {
    emit("FAIL", `${img.width}x${img.height}; a card face is ${CARD_W}x${CARD_H}. Run: node tools/art.mjs fit --in ${file} --out ${file}`);
    return 1;
  }
  emit("PASS", `${CARD_W}x${CARD_H} RGBA, ready`);
  return 0;
}

async function cmdGen(args) {
  const { mod, card } = loadCard(args);
  const prompt = args.prompt || composePrompt(card);
  const key = requireKey();

  process.stdout.write(`prompt  ${prompt}\n`);
  const created = await api(key, "/generation/text-to-image", {
    prompt,
    model: "chat_image_2.5_flare",
    background: "transparent",
    output_format: "png",
  });
  const taskId = String(created?.task_id ?? "");
  if (!taskId) throw new ModelError(`Tripo accepted no task: ${JSON.stringify(created).slice(0, 200)}`);
  process.stdout.write(`task    ${taskId}\n`);
  const done = await waitFor(key, taskId);
  const url = pickUrl(done?.output);
  if (!url) throw new ModelError(`task ${taskId} finished with no image url: ${JSON.stringify(done?.output).slice(0, 200)}`);

  const res = await fetch(url);
  if (!res.ok) throw new ModelError(`download failed: HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const fitted = cropCover(decodePng(raw), CARD_W, CARD_H);
  const target = path.join(mod.dir, "image", "cards", `${card.id}.png`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, encodePng(fitted));
  // The card must point at the sprite, or the file is never read.
  mod.set("card", card.id, ["resource"], [`cards/${card.id}`]);
  mod.save();
  emit("PASS", `image/cards/${card.id}.png written at ${CARD_W}x${CARD_H}`, "install the mod and look at the card; the frame, ornaments and help button are drawn by the game");
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const table = { prompt: cmdPrompt, gen: cmdGen, fit: cmdFit, check: cmdCheck };
  if (!table[cmd]) {
    process.stderr.write("usage: node tools/art.mjs <prompt|gen|fit|check> [--mod <dir> --id <id>] [--in f] [--out f] [--prompt text]\n");
    return 2;
  }
  try {
    return await table[cmd](args);
  } catch (e) {
    if (e instanceof ModelError) {
      emit("FAIL", e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("art.mjs")) process.exit(await main());
