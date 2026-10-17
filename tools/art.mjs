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
/** The four tiers, with the colour plate the game uses for each. */
const RARITY = {
  1: { name: "石块 stone", plate: "cool grey stone plate" },
  2: { name: "铜 copper", plate: "warm copper plate" },
  3: { name: "银 silver", plate: "pale silver plate" },
  4: { name: "金 gold", plate: "deep gold plate" },
};

/** The four tiers, and the composition each card type wants. */
const TYPE_HINT = {
  char: "a single character, full body, facing the viewer",
  item: "a single object, centred, shown large",
  sudan: "an ornate Sultan card motif, symmetrical",
};

const CARD_ART = JSON.parse(readFileSync(new URL("../schema/card-art.json", import.meta.url), "utf8"));

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
  const tier = RARITY[card.rare] || RARITY[1];
  const kind = TYPE_HINT[card.type] || TYPE_HINT.item;
  // The plate colour is fixed by rarity in the game, so the picture has to sit on it.
  const tendency = CARD_ART.measured[card.type]?.tendency ?? "centred subject";
  const plate = `A ${tier.name} tier card: ${kind}, ${tendency}, set on a ${tier.plate} background that fills the frame.`;
  return `${plate} ${subject}.${facts}${flavour} ${STYLE}`;
}

/** Where a same-tier, same-type reference picture lives. */
const REF_DIR = "reference/cards";

function refFor(card, modDir) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(here, "..", REF_DIR, `${card.type}-${card.rare}.png`),
    path.join(here, "..", REF_DIR, `${card.type}-${card.rare}.jpg`),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function cmdRefs() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const dir = path.join(here, "..", REF_DIR);
  const missing = [];
  for (const type of ["char", "item", "sudan"]) {
    for (const rare of [1, 2, 3, 4]) {
      const name = `${type}-${rare}.png`;
      const has = existsSync(path.join(dir, name));
      process.stdout.write(`${has ? "OK  " : "MISS"}  ${name}   ${RARITY[rare].name} / ${type}\n`);
      if (!has) missing.push(name);
    }
  }
  if (missing.length) {
    emit("WARN", `${missing.length} reference picture(s) missing in ${REF_DIR}/.`);
    process.stdout.write(
      "NEXT  extract them from the game: /tmp/unitypy-venv/bin/python tools/extract-art.py --out reference/cards --by-tier\n",
    );
    return 0;
  }
  emit("PASS", "every tier has a reference picture; gen will use image-to-image");
  return 0;
}

async function uploadRef(key, file) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(readFileSync(file))]), path.basename(file));
  const r = await fetch(TRIPO_V3 + "/files", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  const token = j?.data?.file_token ?? j?.data?.image_token;
  if (!token) throw new ModelError(`uploading the reference failed: ${JSON.stringify(j).slice(0, 200)}`);
  return String(token);
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
  let prompt = args.prompt || composePrompt(card);
  const key = requireKey();

  const ref = args.ref || refFor(card, mod.dir);
  const body = {
    prompt,
    model: "chat_image_2.5_flare",
    background: "transparent",
    output_format: "png",
  };
  let endpoint = "/generation/text-to-image";
  if (ref) {
    // Same tier and type as the card: the model follows the game's own plate and palette.
    body.input = await uploadRef(key, ref);
    endpoint = "/generation/image-to-image";
    prompt = `${prompt} Match the reference card's palette, lighting and background plate; change only the subject.`;
    body.prompt = prompt;
  } else {
    emit("WARN", "no reference picture for this tier; the palette comes from the prompt alone. Run `node tools/art.mjs refs`.");
  }
  process.stdout.write(`prompt  ${prompt}\n`);
  process.stdout.write(`ref     ${ref ? path.basename(ref) : "none"}\n`);
  const created = await api(key, endpoint, body);
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
  const table = { prompt: cmdPrompt, gen: cmdGen, fit: cmdFit, check: cmdCheck, refs: cmdRefs };
  if (!table[cmd]) {
    process.stderr.write(
      "usage: node tools/art.mjs <prompt|gen|fit|check|refs> [--mod <dir> --id <id>] [--ref f] [--in f] [--out f] [--prompt text]\n",
    );
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
