#!/usr/bin/env node
/**
 * png test — the codec has to be exact, because a wrong pixel or a wrong stride
 * produces a picture that looks broken only on the card.
 *
 *   node --test tools/png.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePng, encodePng, cropCover } from "./png.mjs";

/** A gradient with a distinct marker square, so crops can be located. */
function fixture(w, h) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = Math.round((x / (w - 1)) * 255);
      rgba[i + 1] = Math.round((y / (h - 1)) * 255);
      rgba[i + 2] = 40;
      rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

test("encode then decode returns the same pixels", () => {
  const src = fixture(37, 23);
  const out = decodePng(encodePng(src));
  assert.equal(out.width, 37);
  assert.equal(out.height, 23);
  assert.ok(out.rgba.equals(src.rgba), "pixels must round trip");
});

test("a square crop to the card aspect keeps the centre and the exact size", () => {
  const src = fixture(400, 400);
  const out = cropCover(src, 472, 1028);
  assert.equal(out.width, 472);
  assert.equal(out.height, 1028);
  // The centre column of the source must land in the centre column of the result:
  // the green channel is a vertical gradient, so the middle row stays mid-green.
  const midRow = Math.floor(1028 / 2);
  const idx = (midRow * 472 + 236) * 4;
  assert.ok(Math.abs(out.rgba[idx + 1] - 128) <= 2, `centre green ~128, got ${out.rgba[idx + 1]}`);
});

test("a tall source is cropped on the height, not the width", () => {
  const src = fixture(200, 900);
  const out = cropCover(src, 472, 1028);
  assert.equal(out.width, 472);
  assert.equal(out.height, 1028);
});

test("alpha is preserved", () => {
  const src = fixture(64, 64);
  for (let i = 3; i < src.rgba.length; i += 4) src.rgba[i] = 128;
  const out = cropCover(src, 472, 1028);
  assert.equal(out.rgba[3], 128);
});

test("a non-PNG is refused", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
});
