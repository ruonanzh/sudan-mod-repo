#!/usr/bin/env node
/**
 * image.mjs — the 2D side of the asset pipeline, with no game and no card in it.
 *
 *   node tools/image.mjs generate --prompt "<text>" --out a.png [--ref b.png ...] [--task id] [--manifest path]
 *   node tools/image.mjs fit      --in a.png --out b.png --width 472 --height 1028 [--mode cover|contain]
 *   node tools/image.mjs check    --file a.png [--width 472] [--height 1028] [--alpha]
 *   node tools/image.mjs refs     --dir reference/cards --expect a.png --expect b.png
 *
 * Four actions, one file:
 *
 * - `generate` talks to Tripo. With `--task` it only downloads an existing task, which costs
 *   nothing. Every attempt appends one line to the manifest, so a second run can see what was
 *   already paid for.
 * - `fit` crops (cover) or letterboxes (contain) a PNG to an exact size.
 * - `check` reads a PNG and compares it with what the caller promised.
 * - `refs` reports which expected files are missing from a directory.
 *
 * What a card face looks like — 472×1028, transparent, the top fifth left empty — is not here. The
 * capability SKILL passes those numbers in, which is what lets another game reuse this file.
 *
 * The card page still composes its own prompt (editors/lib/card-prompt.mjs); that is the one place
 * a prompt is built from game fields, and it only feeds the page, never this tool.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png.mjs";

const API = "https://openapi.tripo3d.com/v3";
/** A blackholed network must fail in seconds, not in minutes: every request carries this. */
const NET_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROVIDER = "tripo";
const MODEL = "chat_image_2.5_flare";

/** A failure the caller can act on: `code` is stable, `message` is one sentence plus a next step. */
export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const say = (level, message, next) => process.stdout.write(`${level}: ${message}${next ? `\nNEXT: ${next}` : ""}\n`);

// ---------------------------------------------------------------- fit / check / refs

/**
 * Crop (`cover`, the default) or letterbox (`contain`) a PNG to exactly width×height.
 * `cover` keeps the middle and cuts the overflow; `contain` keeps all of the picture and adds
 * transparent bands. Nothing is ever scaled with a different ratio.
 */
export function fitImage({ inFile, outFile, width, height, mode = "cover" }) {
  if (!inFile || !outFile) throw new ImageError("NO_PATH", "fit needs in and out, for example --in a.png --out b.png");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new ImageError("BAD_SIZE", `fit needs integer width and height, got ${width}x${height}`);
  if (!existsSync(inFile)) throw new ImageError("NO_FILE", `no such file: ${inFile}`);
  let img;
  try {
    img = decodePng(readFileSync(inFile));
  } catch (error) {
    throw new ImageError("BAD_PNG", `${inFile} is not a PNG (${error.message}); only PNG has an alpha channel`);
  }
  const fitted = mode === "contain" ? letterbox(img, width, height) : cover(img, width, height);
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSync(outFile, encodePng(fitted));
  return { out: outFile, width, height, mode };
}

/** Fill the target box and cut the overflow, keeping the middle of the picture. */
function cover(img, width, height) {
  const scale = Math.max(width / img.width, height / img.height);
  const sw = Math.max(1, Math.round(width / scale));
  const sh = Math.max(1, Math.round(height / scale));
  const sx = Math.floor((img.width - sw) / 2);
  const sy = Math.floor((img.height - sh) / 2);
  const out = { width, height, rgba: Buffer.alloc(width * height * 4) };
  for (let y = 0; y < height; y += 1) {
    const syy = Math.min(img.height - 1, sy + Math.floor((y * sh) / height));
    for (let x = 0; x < width; x += 1) {
      const sxx = Math.min(img.width - 1, sx + Math.floor((x * sw) / width));
      const from = (syy * img.width + sxx) * 4;
      img.rgba.copy(out.rgba, (y * width + x) * 4, from, from + 4);
    }
  }
  return out;
}

/** Keep all of the picture and add transparent bands. */
function letterbox(img, width, height) {
  const scale = Math.min(width / img.width, height / img.height);
  const dw = Math.max(1, Math.round(img.width * scale));
  const dh = Math.max(1, Math.round(img.height * scale));
  const ox = Math.floor((width - dw) / 2);
  const oy = Math.floor((height - dh) / 2);
  const out = { width, height, rgba: Buffer.alloc(width * height * 4) };
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / dw));
      const from = (sy * img.width + sx) * 4;
      img.rgba.copy(out.rgba, ((oy + y) * width + (ox + x)) * 4, from, from + 4);
    }
  }
  return out;
}

/** Read a PNG and compare it with the promise. Throws SIZE_MISMATCH / NO_ALPHA with the fix. */
export function checkImage({ file, width, height, alpha = false }) {
  if (!file) throw new ImageError("NO_FILE", "check needs a file, for example --file a.png");
  if (!existsSync(file)) throw new ImageError("NO_FILE", `no such file: ${file}`);
  const buf = readFileSync(file);
  let img;
  try {
    img = decodePng(buf);
  } catch (error) {
    throw new ImageError("BAD_PNG", `${file} is not a PNG (${error.message})`);
  }
  const colorType = pngColorType(buf);
  const hasAlpha = colorType === 6;
  if ((width === undefined) !== (height === undefined)) {
    // One dimension alone used to be ignored, so a caller who asked for 472 wide got PASS on any
    // size. A size check means both axes or none.
    throw new ImageError(
      "SIZE_PARTIAL",
      `check needs both width and height, or neither; got width=${width ?? "(none)"} height=${height ?? "(none)"}. A card is checked against 472x1028.`,
    );
  }
  if (width !== undefined && height !== undefined && (img.width !== width || img.height !== height)) {
    throw new ImageError(
      "SIZE_MISMATCH",
      `${file} is ${img.width}x${img.height}, expected ${width}x${height}. ` +
        `Run fitImage({ inFile: "${file}", outFile: "<out>", width: ${width}, height: ${height} }) first.`,
    );
  }
  if (alpha && !hasAlpha) {
    throw new ImageError("NO_ALPHA", `${file} has no alpha channel (color type ${colorType}); a transparent PNG is color type 6`);
  }
  return { file, width: img.width, height: img.height, alpha: hasAlpha };
}

/** Color type from IHDR: 2 = RGB, 6 = RGBA. */
function pngColorType(buf) {
  if (buf.length < 26 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return buf[25];
}

/** Which of the expected files are missing. A missing directory is its own error. */
export function checkRefs({ dir, expect = [] }) {
  if (!dir) throw new ImageError("NO_DIR", "refs needs a directory, for example --dir reference/cards");
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new ImageError("NO_DIR", `no such directory: ${dir}. Extract the game's own art first, or point --dir at it.`);
  const missing = expect.filter((name) => !existsSync(path.join(dir, name)));
  return { dir, present: expect.length - missing.length, missing };
}

// ---------------------------------------------------------------- generate

/**
 * One image from Tripo. `task` reuses an existing task and never calls the generation endpoint.
 * Every attempt appends a manifest line (success or failure) when `manifest` is given.
 */
export async function generateImage({
  prompt,
  refs = [],
  out,
  background = "transparent",
  format = "png",
  task,
  wait = true,
  key,
  manifest,
  fetchImpl = fetch,
  pollMs = 2000,
  timeoutMs = 900_000,
}) {
  if (!out) throw new ImageError("NO_OUT", "nothing would be saved: give out, for example --out your_mods/x/.preview/a.png");
  if (!task && !prompt) throw new ImageError("NO_PROMPT", "nothing to draw: give a prompt, or a task id to download");
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const startedAt = nowLocal();
  const input = { prompt_sha12: sha12(prompt || ""), refs: refs.map((f) => path.basename(f)), background, format };
  let requestId = task || null;
  try {
    let imageUrl;
    if (task) {
      const api = tripoApi(key || requireKey(), fetchImpl);
      const done = await waitForTask(api, task, { wait, pollMs, timeoutMs });
      imageUrl = pickUrl(done?.output);
      if (!imageUrl) throw new ImageError("TASK_FAILED", `task ${task} finished with no image url`);
      writeManifest(manifest, { endpoint: `/v3/tasks/${task}`, name: outName(out), requestId, input, files: [], startedAt, error: null });
    } else {
      const apiKey = key || requireKey();
      const api = tripoApi(apiKey, fetchImpl);
      const tokens = [];
      for (const file of refs) tokens.push(await uploadFile(apiKey, file, fetchImpl));
      // The model decides whether background and output_format are honoured at all:
      // without it the endpoint falls back to a model that ignores both and returns a JPEG.
      const body = { prompt, model: MODEL, background, output_format: format };
      let endpoint = "/generation/text-to-image";
      if (tokens.length === 1) {
        body.input = tokens[0];
        endpoint = "/generation/image-to-image";
      } else if (tokens.length > 1) {
        body.inputs = tokens;
        endpoint = "/generation/image-to-image";
      }
      const created = await api(endpoint, body);
      requestId = String(created?.task_id ?? "");
      if (!requestId) throw new ImageError("TASK_FAILED", `Tripo accepted no task: ${JSON.stringify(created).slice(0, 200)}`);
      const done = await waitForTask(api, requestId, { wait, pollMs, timeoutMs });
      imageUrl = pickUrl(done?.output);
      if (!imageUrl) throw new ImageError("TASK_FAILED", `task ${requestId} finished with no image url`);
      writeManifest(manifest, { endpoint, name: outName(out), requestId, input, files: [], startedAt, error: null });
    }
    const response = await fetchWithTimeout(fetchImpl, imageUrl, {}, DOWNLOAD_TIMEOUT_MS);
    if (!response.ok) throw new ImageError("DOWNLOAD_FAILED", `downloading the picture failed: HTTP ${response.status}`);
    writeFileSync(out, Buffer.from(await response.arrayBuffer()));
    return { out, task: requestId, width: decodePng(readFileSync(out)).width, height: decodePng(readFileSync(out)).height };
  } catch (error) {
    writeManifest(manifest, {
      endpoint: task ? `/v3/tasks/${task}` : "/generation/image-to-image",
      name: outName(out),
      requestId,
      input,
      files: [],
      startedAt,
      error: String(error && error.message ? error.message : error),
    });
    throw error;
  }
}

/** Append one manifest line. Ten keys, `error` only on failure; the prompt never appears in full. */
function writeManifest(manifest, { endpoint, name, requestId, input, startedAt, error }) {
  if (!manifest) return;
  const rec = {
    t: startedAt,
    provider: PROVIDER,
    endpoint,
    name,
    request_id: requestId,
    parent_request_id: null,
    seed: null,
    files: error ? [] : [name],
    input,
  };
  if (error) rec.error = error;
  mkdirSync(path.dirname(path.resolve(manifest)), { recursive: true });
  appendFileSync(manifest, `${JSON.stringify(rec)}\n`);
}

const outName = (out) => path.basename(String(out), path.extname(String(out)));
const sha12 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

function nowLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The Tripo key: the environment first, then the app's key file. */
export function requireKey() {
  const env = process.env.TRIPO_API_KEY;
  if (env) return env.trim();
  const file = path.join(homedir(), ".gamer-agent-pi", "api-keys.json");
  if (!existsSync(file))
    throw new ImageError("NO_TRIPO_KEY", `no Tripo API key. Save it to ~/.gamer-agent-pi/api-keys.json as {"tripo":"tsk_..."}, or set TRIPO_API_KEY.`);
  const key = JSON.parse(readFileSync(file, "utf8")).tripo;
  if (typeof key !== "string" || !key.trim()) throw new ImageError("NO_TRIPO_KEY", "~/.gamer-agent-pi/api-keys.json has no tripo key");
  return key.trim();
}

function tripoApi(key, fetchImpl) {
  return async (endpoint, body) => {
    const response = await fetchWithTimeout(
      fetchImpl,
      API + endpoint,
      {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      },
      NET_TIMEOUT_MS,
    );
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ImageError("BAD_RESPONSE", `Tripo returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (response.status === 429 || json?.code === 2000)
      throw new ImageError("TRIPO_RATE_LIMIT", "the API limit was hit; wait 30-60 seconds before the next call and do not retry in a loop");
    if (!response.ok) throw new ImageError("HTTP_ERROR", `Tripo HTTP ${response.status} on ${endpoint}: ${json?.message ?? text.slice(0, 200)}`);
    return json?.data ?? json;
  };
}

async function uploadFile(key, file, fetchImpl) {
  if (!existsSync(file)) throw new ImageError("NO_FILE", `no such reference picture: ${file}`);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(readFileSync(file))]), path.basename(file));
  const response = await fetchWithTimeout(
    fetchImpl,
    API + "/files",
    { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form },
    NET_TIMEOUT_MS,
  );
  const json = await response.json().catch(() => ({}));
  const token = json?.data?.file_token ?? json?.data?.image_token;
  if (!token) throw new ImageError("UPLOAD_FAILED", `uploading ${path.basename(file)} failed: ${JSON.stringify(json).slice(0, 200)}`);
  return String(token);
}

async function waitForTask(api, id, { wait, pollMs, timeoutMs }) {
  const started = Date.now();
  for (;;) {
    const data = await api(`/tasks/${id}`, null);
    const status = String(data?.status);
    if (status === "success") return data;
    if (["failed", "banned", "expired", "cancelled"].includes(status))
      throw new ImageError("TASK_FAILED", `task ${id} ended as ${status}: ${JSON.stringify(data?.task ?? data).slice(0, 300)}`);
    if (!wait) return data;
    if (Date.now() - started > timeoutMs) throw new ImageError("TASK_TIMEOUT", `task ${id} did not finish within 15 minutes`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** A request that cannot hang forever; a blackholed host reports NETWORK instead of stalling. */
async function fetchWithTimeout(fetchImpl, url, init, ms) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    const name = String(error && error.name);
    if (name === "TimeoutError" || name === "AbortError")
      throw new ImageError("NETWORK", `no answer from ${new URL(url).host} within ${Math.round(ms / 1000)}s; check this machine's network, VPN or proxy`);
    throw new ImageError("NETWORK", `request to ${new URL(url).host} failed: ${String(error && error.message ? error.message : error)}`);
  }
}

const pickUrl = (output) => Object.values(output ?? {}).find((v) => typeof v === "string" && v.startsWith("http")) ?? null;

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { refs: [], expect: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith("--") ? argv[++i] : true;
    if (name === "ref") out.refs = [...(out.refs || []), value];
    else if (name === "expect") out.expect = [...(out.expect || []), value];
    else out[name] = value;
  }
  return out;
}

async function main(argv) {
  const [action, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    if (action === "fit") {
      const got = fitImage({ inFile: args.in, outFile: args.out, width: Number(args.width), height: Number(args.height), mode: args.mode });
      say("PASS", `${got.out} written at ${got.width}x${got.height} (${got.mode || "cover"})`);
      return 0;
    }
    if (action === "check") {
      const got = checkImage({ file: args.file, width: args.width === undefined ? undefined : Number(args.width), height: args.height === undefined ? undefined : Number(args.height), alpha: Boolean(args.alpha) });
      say("PASS", `${got.file} is ${got.width}x${got.height}${got.alpha ? ", alpha channel present" : ""}`);
      return 0;
    }
    if (action === "refs") {
      const got = checkRefs({ dir: args.dir, expect: args.expect });
      if (got.missing.length) {
        say("WARN", `${got.missing.length} of ${args.expect.length} expected picture(s) missing in ${args.dir}`, `${got.missing.join(", ")}: add them, or run without --dir to skip the reference completely`);
        return 1;
      }
      say("PASS", `all ${got.present} expected picture(s) present in ${args.dir}`);
      return 0;
    }
    if (action === "generate") {
      const got = await generateImage({
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        refs: args.refs,
        out: args.out,
        background: args.background,
        format: args.format,
        task: typeof args.task === "string" ? args.task : undefined,
        wait: args.wait !== "false",
        manifest: typeof args.manifest === "string" ? args.manifest : undefined,
      });
      say("PASS", `${got.out} written (${got.width}x${got.height}), task ${got.task}`);
      return 0;
    }
    process.stderr.write(
      "usage: node tools/image.mjs <generate|fit|check|refs> [options]\n" +
        "  generate --prompt <text> --out <png> [--ref f ...] [--background transparent] [--format png] [--task id] [--manifest file]\n" +
        "  fit      --in <png> --out <png> --width N --height N [--mode cover|contain]\n" +
        "  check    --file <png> [--width N] [--height N] [--alpha]\n" +
        "  refs     --dir <dir> --expect <name> [--expect <name> ...]\n",
    );
    return 2;
  } catch (error) {
    if (error instanceof ImageError) {
      const next = /NO_OUT|NO_PROMPT/.test(error.code)
        ? "run with --out <png> (and a --prompt, unless you are reusing --task)"
        : /SIZE_/.test(error.code)
          ? "run fit with the size the check printed, then check again"
          : "fix what the message names, then run the same command again";
      say("FAIL", error.message, next);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main(process.argv.slice(2)));
}
