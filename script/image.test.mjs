#!/usr/bin/env node
/**
 * The generic 2D asset tool: generate, fit, check, refs.
 *
 *   node --test script/image.test.mjs
 *
 * Nothing here knows what a card is. The card recipe (472×1028, which reference picture) lives in
 * `card-art` SKILL; these tests only pin the tool's contract, so the SKILL cannot promise a
 * parameter the tool ignores.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { cleanupAll } from "./lib/fixture.mjs";
const require = createRequire(import.meta.url);
import { decodePng, encodePng, solid } from "../tools/png.mjs";

after(cleanupAll);

const dir = () => mkdtempSync(path.join(tmpdir(), "image-"));

function png(w, h, hex = "#3355ff", alpha = 255) {
  const img = solid(w, h, hex);
  if (alpha !== 255) for (let i = 3; i < img.rgba.length; i += 4) img.rgba[i] = alpha;
  return encodePng(img);
}

/** A fake Tripo: upload → create task → poll → download. Records every call. */
function fakeTrip(imageBytes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", body: init.body });
    const json = (data) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) });
    if (u.endsWith("/files")) return json({ file_token: "tok-1" });
    if (u.includes("/generation/")) return json({ task_id: "task-1" });
    if (u.includes("/tasks/")) return json({ status: "success", output: { image: "https://cdn.test/out.png" } });
    if (u === "https://cdn.test/out.png")
      return { ok: true, status: 200, arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength) };
    return { ok: false, status: 404, text: async () => "not found" };
  };
  return { fetchImpl, calls };
}

const { generateImage, fitImage, checkImage, checkRefs, ImageError } = await import("../tools/image.mjs").catch(() => ({}));

// ---------------------------------------------------------------- A. generate

test("A1 the prompt and the reference pictures reach the request", async () => {
  const home = dir();
  const ref = path.join(home, "ref.png");
  writeFileSync(ref, png(4, 4));
  const trip = fakeTrip(png(8, 8));
  await generateImage({ prompt: "a broken blade", refs: [ref], out: path.join(home, "out.png"), key: "k", fetchImpl: trip.fetchImpl, manifest: path.join(home, "asset_manifest.jsonl") });
  const create = trip.calls.find((c) => c.url.includes("/generation/"));
  assert.ok(create, "a generation call happened");
  const body = JSON.parse(create.body);
  assert.match(body.prompt, /a broken blade/);
  const travelled = Array.isArray(body.inputs) ? body.inputs : body.input ? [body.input] : [];
  assert.equal(travelled.length, 1, "the reference travels as an input");
  assert.ok(existsSync(path.join(home, "out.png")), "the picture landed on disk");
});

test("A4 every request carries a timeout, so a dead network cannot hang for minutes", async () => {
  const home = dir();
  const seen = [];
  const fail = async (url, init = {}) => {
    seen.push({ url: String(url), signal: Boolean(init.signal) });
    throw Object.assign(new Error("connect timed out"), { name: "TimeoutError" });
  };
  await assert.rejects(
    () => generateImage({ prompt: "x", out: path.join(home, "a.png"), key: "k", fetchImpl: fail }),
    (e) => e.code === "NETWORK" && /network|proxy/i.test(e.message),
  );
  assert.ok(seen.length >= 1 && seen.every((c) => c.signal), "the request was given an abort signal");
});

test("A2 without out the tool refuses before spending anything", async () => {
  await assert.rejects(
    () => generateImage({ prompt: "x", key: "k", fetchImpl: async () => ({}) }),
    (e) => e.code === "NO_OUT" && /out/.test(e.message),
  );
});

test("A3 a transparent PNG is the default", async () => {
  const home = dir();
  const trip = fakeTrip(png(8, 8));
  await generateImage({ prompt: "x", out: path.join(home, "a.png"), key: "k", fetchImpl: trip.fetchImpl, manifest: path.join(home, "m.jsonl") });
  const body = JSON.parse(trip.calls.find((c) => c.url.includes("/generation/")).body);
  assert.equal(body.background, "transparent");
  assert.equal(body.output_format, "png");
});

// ---------------------------------------------------------------- B. fit

test("B1 fit writes exactly the asked size", () => {
  const home = dir();
  const src = path.join(home, "src.png");
  writeFileSync(src, png(20, 30));
  const out = path.join(home, "fitted.png");
  fitImage({ inFile: src, outFile: out, width: 8, height: 16 });
  const got = decodePng(readFileSync(out));
  assert.equal(got.width, 8);
  assert.equal(got.height, 16);
});

test("B2 contain keeps the whole picture instead of cropping it", () => {
  const home = dir();
  const src = path.join(home, "wide.png");
  writeFileSync(src, png(40, 10, "#ff0000"));
  const out = path.join(home, "contained.png");
  fitImage({ inFile: src, outFile: out, width: 8, height: 16, mode: "contain" });
  const got = decodePng(readFileSync(out));
  assert.equal(got.width, 8);
  assert.equal(got.height, 16);
  const at = (x, y) => Array.from(got.rgba.subarray((y * got.width + x) * 4, (y * got.width + x) * 4 + 4));
  assert.deepEqual(at(4, 8), [255, 0, 0, 255], "the middle row still holds the picture, so nothing was cropped away");
});

test("B3 a file that is not a PNG is refused", () => {
  const home = dir();
  const bad = path.join(home, "x.jpg");
  writeFileSync(bad, "not a png");
  assert.throws(() => fitImage({ inFile: bad, outFile: path.join(home, "o.png"), width: 4, height: 4 }), (e) => e.code === "BAD_PNG");
});

// ---------------------------------------------------------------- C. check

test("C1 a wrong size is reported with the fit call that fixes it", () => {
  const home = dir();
  const file = path.join(home, "wrong.png");
  writeFileSync(file, png(6, 9));
  assert.throws(
    () => checkImage({ file, width: 4, height: 8 }),
    (e) => e.code === "SIZE_MISMATCH" && /fitImage|fit/.test(e.message),
  );
});

test("C2 the right size passes and reports the real numbers", () => {
  const home = dir();
  const file = path.join(home, "ok.png");
  writeFileSync(file, png(4, 8));
  const got = checkImage({ file, width: 4, height: 8 });
  assert.equal(got.width, 4);
  assert.equal(got.height, 8);
  assert.equal(got.alpha, true);
});

test("C3 asking for transparency on a picture without any fails", () => {
  const home = dir();
  const file = path.join(home, "opaque.png");
  writeFileSync(file, rgbPng(4, 4));
  assert.throws(() => checkImage({ file, alpha: true }), (e) => e.code === "NO_ALPHA");
});

// ---------------------------------------------------------------- D. refs

test("D1 refs names every missing picture", () => {
  const home = dir();
  writeFileSync(path.join(home, "have.png"), png(2, 2));
  const got = checkRefs({ dir: home, expect: ["have.png", "gone.png", "also-gone.png"] });
  assert.deepEqual(got.missing, ["gone.png", "also-gone.png"]);
});

test("D2 a complete set passes", () => {
  const home = dir();
  writeFileSync(path.join(home, "a.png"), png(2, 2));
  const got = checkRefs({ dir: home, expect: ["a.png"] });
  assert.deepEqual(got.missing, []);
});

test("D3 a missing directory is its own error, not a list of missing files", () => {
  assert.throws(() => checkRefs({ dir: path.join(dir(), "nope"), expect: ["a.png"] }), (e) => e.code === "NO_DIR");
});

// ---------------------------------------------------------------- E. reuse

test("E1 a task id is downloaded, never regenerated", async () => {
  const home = dir();
  const trip = fakeTrip(png(8, 8));
  await generateImage({ task: "task-9", out: path.join(home, "reuse.png"), key: "k", fetchImpl: trip.fetchImpl, manifest: path.join(home, "m.jsonl") });
  assert.equal(trip.calls.filter((c) => c.url.includes("/generation/")).length, 0, "no generation call");
  assert.ok(trip.calls.some((c) => c.url.endsWith("/tasks/task-9")), "the task was read");
  assert.ok(existsSync(path.join(home, "reuse.png")));
});

// ---------------------------------------------------------------- F. manifest

test("F1 the manifest is one JSON object per line", async () => {
  const home = dir();
  const trip = fakeTrip(png(8, 8));
  const manifest = path.join(home, "asset_manifest.jsonl");
  await generateImage({ prompt: "one", out: path.join(home, "a.png"), key: "k", fetchImpl: trip.fetchImpl, manifest });
  await generateImage({ prompt: "two", out: path.join(home, "b.png"), key: "k", fetchImpl: trip.fetchImpl, manifest });
  const lines = readFileSync(manifest, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(typeof JSON.parse(line), "object");
});

test("F2 a manifest line carries the ten keys", async () => {
  const home = dir();
  const trip = fakeTrip(png(8, 8));
  const manifest = path.join(home, "asset_manifest.jsonl");
  await generateImage({ prompt: "one", out: path.join(home, "a.png"), key: "k", fetchImpl: trip.fetchImpl, manifest });
  const rec = JSON.parse(readFileSync(manifest, "utf8").trim());
  for (const key of ["t", "provider", "endpoint", "name", "request_id", "parent_request_id", "seed", "files", "input"]) {
    assert.ok(key in rec, `missing ${key}`);
  }
  assert.equal(rec.provider, "tripo");
  assert.equal(rec.request_id, "task-1");
});

test("F3 the prompt is hashed, not copied into the manifest", async () => {
  const home = dir();
  const trip = fakeTrip(png(8, 8));
  const manifest = path.join(home, "asset_manifest.jsonl");
  await generateImage({ prompt: "a very long secret prompt", out: path.join(home, "a.png"), key: "k", fetchImpl: trip.fetchImpl, manifest });
  const text = readFileSync(manifest, "utf8");
  assert.doesNotMatch(text, /a very long secret prompt/);
  assert.match(text, /prompt_sha12/);
});

test("F4 a failed generation still leaves a line, with the error", async () => {
  const home = dir();
  const manifest = path.join(home, "asset_manifest.jsonl");
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/generation/")) return { ok: true, status: 200, json: async () => ({ data: { task_id: "t-bad" } }), text: async () => JSON.stringify({ data: { task_id: "t-bad" } }) };
    if (u.includes("/tasks/")) return { ok: true, status: 200, json: async () => ({ data: { status: "failed" } }), text: async () => JSON.stringify({ data: { status: "failed" } }) };
    return { ok: false, status: 500, text: async () => "boom" };
  };
  await assert.rejects(() =>
    generateImage({ prompt: "x", out: path.join(home, "a.png"), key: "k", fetchImpl, manifest }),
  );
  const rec = JSON.parse(readFileSync(manifest, "utf8").trim());
  assert.equal(rec.request_id, "t-bad");
  assert.ok(typeof rec.error === "string" && rec.error.length > 0);
});

/** A minimal RGB PNG (color type 2), so "no alpha" can be tested against a real file. */
function rgbPng(w, h) {
  const zlib = require("node:zlib");
  const crc = (buf) => {
    let c, crcTable = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let x = 0xffffffff;
    for (const b of buf) x = crcTable[(x ^ b) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = y * (1 + w * 3) + 1 + x * 3;
    raw[at] = 10; raw[at + 1] = 20; raw[at + 2] = 30;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
