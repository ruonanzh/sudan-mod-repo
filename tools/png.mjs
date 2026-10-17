/**
 * png.mjs — the little bit of image work a card face needs, with no dependency.
 *
 * Tripo returns a square 2048x2048 RGBA PNG. A card face is 472x1028. This module
 * decodes the PNG, crops the centre to the card's aspect, box-downsamples to exactly
 * 472x1028, and encodes a PNG again.
 *
 * Supported: 8-bit RGB and RGBA, no interlacing. That is what the generator emits, and
 * refusing anything else is better than silently mangling a 16-bit or palette file.
 */
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode to { width, height, rgba }. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");
  let at = 8;
  let ihdr = null;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.bitDepth !== 8) throw new Error(`only 8-bit PNG is supported, got ${ihdr.bitDepth}`);
  if (ihdr.interlace) throw new Error("interlaced PNG is not supported");
  if (ihdr.colorType !== 6 && ihdr.colorType !== 2) throw new Error(`only RGB and RGBA are supported, got colorType ${ihdr.colorType}`);

  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * bpp;
  const out = Buffer.alloc(ihdr.height * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unknown row filter ${filter}`);
      cur[x] = v & 0xff;
    }
  }

  // Normalise to RGBA.
  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0, j = 0; i < out.length; i += bpp, j += 4) {
    rgba[j] = out[i];
    rgba[j + 1] = out[i + 1];
    rgba[j + 2] = out[i + 2];
    rgba[j + 3] = bpp === 4 ? out[i + 3] : 255;
  }
  return { width: ihdr.width, height: ihdr.height, rgba };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

/** Encode { width, height, rgba } to a PNG buffer. */
export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Centre-crop to the target aspect, then box-downsample to exactly targetWidth x targetHeight.
 * Box averaging is used rather than nearest neighbour because the source is much larger
 * than the target, and nearest neighbour makes card art look like it was chewed.
 */
export function cropCover(img, targetWidth, targetHeight) {
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = img.width / img.height;
  let cw = img.width;
  let ch = img.height;
  if (sourceAspect > targetAspect) cw = Math.round(img.height * targetAspect);
  else ch = Math.round(img.width / targetAspect);
  const cx = Math.floor((img.width - cw) / 2);
  const cy = Math.floor((img.height - ch) / 2);

  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  const xRatio = cw / targetWidth;
  const yRatio = ch / targetHeight;
  for (let ty = 0; ty < targetHeight; ty++) {
    const y0 = cy + Math.floor(ty * yRatio);
    const y1 = Math.min(cy + ch, cy + Math.max(Math.floor((ty + 1) * yRatio), Math.floor(ty * yRatio) + 1));
    for (let tx = 0; tx < targetWidth; tx++) {
      const x0 = cx + Math.floor(tx * xRatio);
      const x1 = Math.min(cx + cw, cx + Math.max(Math.floor((tx + 1) * xRatio), Math.floor(tx * xRatio) + 1));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          r += img.rgba[i];
          g += img.rgba[i + 1];
          b += img.rgba[i + 2];
          a += img.rgba[i + 3];
          n++;
        }
      }
      const o = (ty * targetWidth + tx) * 4;
      if (!n) continue;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: targetWidth, height: targetHeight, rgba: out };
}

export default { decodePng, encodePng, cropCover };
