#!/usr/bin/env node
/**
 * plates.mjs — turn one paper texture into the four tier plates.
 *
 *   node tools/plates.mjs --from reference/plates/card.png \
 *        --out /tmp/plates --stone "#8d806b" --copper "#94a56a" --silver "#b0becc" --gold "#e9d678"
 *
 * The game does this with a lit metallic material. We are not reproducing that. We take
 * the shipped paper, keep its mottling, and recolour it so the average matches a colour
 * the player measured from a real card. The result is a plate that looks like the tier,
 * not one that shades like the tier.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { decodePng, encodePng, cropCover, tint } from "./png.mjs";

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

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`bad colour ${hex}`);
  return [1, 2, 3].map((i) => parseInt(m[i], 16));
};

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Keep the texture's variation, replace its colour with the target.
 * Every pixel is scaled by luminance/meanLuminance, then multiplied by the target colour.
 * That makes the average exactly the target and leaves the mottling intact.
 */
export function recolour(img, hex, { contrast = 1 } = {}) {
  const target = hexToRgb(hex);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i + 3] < 8) continue;
    sum += luma(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]);
    n++;
  }
  const mean = n ? sum / n : 128;
  const out = Buffer.alloc(img.rgba.length);
  for (let i = 0; i < img.rgba.length; i += 4) {
    const a = img.rgba[i + 3];
    const l = luma(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]);
    // contrast around the mean, then normalise so the average scale stays 1
    let scale = (l - mean) * contrast + mean;
    scale = Math.max(0, scale) / (mean || 1);
    out[i] = Math.min(255, Math.round(target[0] * scale));
    out[i + 1] = Math.min(255, Math.round(target[1] * scale));
    out[i + 2] = Math.min(255, Math.round(target[2] * scale));
    out[i + 3] = a;
  }
  return { width: img.width, height: img.height, rgba: out };
}

/** Average colour, for checking the result against the target. */
export function averageColor(img) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i + 3] < 8) continue;
    r += img.rgba[i];
    g += img.rgba[i + 1];
    b += img.rgba[i + 2];
    n++;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.out) {
    process.stderr.write(
      'usage: node tools/plates.mjs --from card.png --out <dir> --stone "#8d806b" --copper "#94a56a" --silver "#b0becc" --gold "#e9d678"\n',
    );
    return 2;
  }
  const base = cropCover(decodePng(readFileSync(args.from)), CARD_W, CARD_H);
  mkdirSync(args.out, { recursive: true });
  const contrast = args.contrast ? Number(args.contrast) : 1;
  for (const tier of ["stone", "copper", "silver", "gold"]) {
    const hex = args[tier];
    if (!hex) continue;
    const plate = recolour(base, hex, { contrast });
    const file = path.join(args.out, `card-${tier}.png`);
    writeFileSync(file, encodePng(plate));
    const got = averageColor(plate);
    process.stdout.write(
      `PASS  ${file}  target #${hex.replace("#", "")}  measured #${got.map((v) => v.toString(16).padStart(2, "0")).join("")}\n`,
    );
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("plates.mjs")) process.exit(main());
