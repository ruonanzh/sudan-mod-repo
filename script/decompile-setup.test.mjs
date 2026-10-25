/**
 * The one step of the decompile flow that no other test touches: fetching Cpp2IL.
 *
 * `script/decompile-flow.test.mjs` starts from a world where the tool is already installed, so
 * the download, the size check, the digest check, the mirror order and the "an installed file
 * that does not run" repair path were never run by anything. This file runs them against a
 * mirror on 127.0.0.1: no internet, no real game, no dotnet work.
 *
 *   node --test script/decompile-setup.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadExtension } from "./lib/load-extension.mjs";

// The fixture below is a POSIX install: the "tool" is a sh script. The tool name still comes from
// the product table, so a Windows fixture would ask for the executable the product looks for.
const skip = process.platform === "win32" ? "the fixture is a POSIX install: the tool is a sh script" : false;
const posixTest = skip ? test.skip : test;

const { cpp2ilName } = await import("../.pi/lib/decompile.ts");
/** The name `cpp2ilPath()` expects on this machine. */
const TOOL_NAME = cpp2ilName();

/**
 * A mirror. Every path is answered with `body`; `status` other than 200 stands in for a mirror
 * that is down or refuses the release. A fake tool is a shell script that prints a version and
 * exits 0, which is all `setupCpp2il` asks of it.
 */
async function mirror(body, status = 200) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(status, { "content-type": "application/octet-stream", "content-length": String(body.length) });
    res.end(body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    label: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done(undefined))),
  };
}

const FAKE_TOOL = Buffer.from('#!/bin/sh\necho "Cpp2IL 2022.1.0-pre-release.21 (fake)"\n', "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const write = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

/**
 * A repository with a toolchain that points at the given mirrors, and an empty dump root.
 * Nothing here is a real game: `setup` never reads the game.
 */
function world(mirrors, asset = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "decompile-setup-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "sudan-mod-repo");
  const decompiled = path.join(root, "decompiled");
  const target = path.join(decompiled, "tools/cpp2il", TOOL_NAME);

  write(path.join(cwd, ".pi/lib/decompile.json"), JSON.stringify({ version: 1, runtime: "il2cpp", dump: { assemblies: ["Game"] } }));
  write(path.join(cwd, "mod-repo.json"), JSON.stringify({ game: { name: "Fake Game" } }));
  write(path.join(cwd, "tools/il2cppdumper/Il2CppDumper.dll"), "not really a dll");
  write(
    path.join(cwd, "tools/toolchain.json"),
    JSON.stringify({
      version: 1,
      download: { mirrors },
      tools: {
        cpp2il: {
          version: "2022.1.0-pre-release.21",
          release: "https://example.test/cpp2il/2022.1.0-pre-release.21/",
          assets: {
            [`${process.platform}:${process.arch}`]: {
              file: `Cpp2IL-${TOOL_NAME}`,
              bytes: FAKE_TOOL.length,
              sha256: sha256(FAKE_TOOL),
              sign: false, // a fake binary must not be code-signed; the digest is the subject here
              ...asset,
            },
          },
        },
      },
    }),
  );

  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    DECOMPILED_ROOT: decompiled,
  };
  return { root, cwd, decompiled, target, env };
}

/** Run `body` as the extension with this world's environment and an empty dump root. */
async function withWorld(mirrors, asset, body) {
  const w = world(mirrors, asset);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, DECOMPILED_ROOT: process.env.DECOMPILED_ROOT };
  Object.assign(process.env, w.env);
  try {
    const tool = await loadExtension("inspect-game-code.ts");
    const run = async (params) => {
      const result = await tool.execute("c", params, undefined, undefined, { cwd: w.cwd });
      return { text: result.content.map((c) => c.text).join("\n"), ok: result.details?.ok };
    };
    return await body({ ...w, run });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(w.root, { recursive: true, force: true });
  }
}

posixTest("setup downloads the tool, checks the digest, and a second call skips", async () => {
  const server = await mirror(FAKE_TOOL);
  try {
    await withWorld([server.url], {}, async ({ run, target }) => {
      const first = await run({ action: "setup" });
      assert.equal(first.ok, true, first.text);
      assert.match(first.text, /^PASS: Cpp2IL installed in [\d.]+s\./, first.text);
      assert.match(first.text, new RegExp(`source: ${server.label}: 0\\.0 MB, digest ok`), first.text);
      assert.equal(server.requests.length, 1, "one mirror, one request");

      assert.equal(existsSync(target), true, "the tool is written where cpp2ilPath() looks for it");
      const bytes = readFileSync(target);
      assert.deepEqual(bytes, FAKE_TOOL, "the bytes are the ones the digest was checked against");
      assert.notEqual(statSync(target).mode & 0o111, 0, "the tool is executable");
      assert.match(first.text, new RegExp(`sha256 ${sha256(bytes).slice(0, 16)}`), first.text);

      const second = await run({ action: "setup" });
      assert.match(second.text, /^SKIP: Cpp2IL is already installed and runs/, second.text);
      assert.equal(server.requests.length, 1, "an installed, runnable tool is not fetched again");
    });
  } finally {
    await server.close();
  }
});

posixTest("bytes that do not match the recorded digest are refused, and nothing is written", async () => {
  // Same length, different content: only the digest can tell them apart.
  const tampered = Buffer.from(FAKE_TOOL.toString("utf8").replace("2022.1.0", "2022.9.9"), "utf8");
  assert.equal(tampered.length, FAKE_TOOL.length, "the fixture must fail on the digest, not on the size");
  const server = await mirror(tampered);
  try {
    await withWorld([server.url], {}, async ({ run, target }) => {
      const out = await run({ action: "setup" });
      assert.equal(out.ok, false, out.text);
      assert.match(out.text, /CPP2IL_DOWNLOAD_FAILED/, out.text);
      assert.match(out.text, /does not match/, "the attempt names the digest as the reason");
      assert.match(out.text, /NEXT: download .* yourself and put it at /, "the next step hands over the exact path");
      assert.equal(existsSync(target), false, "a failed download leaves no file behind");
    });
  } finally {
    await server.close();
  }
});

posixTest("a mirror that is down does not stop the next one, and both attempts are reported", async () => {
  const down = await mirror(Buffer.from("gone"), 500);
  const good = await mirror(FAKE_TOOL);
  try {
    await withWorld([down.url, good.url], {}, async ({ run }) => {
      const out = await run({ action: "setup" });
      assert.equal(out.ok, true, out.text);
      assert.match(out.text, /^PASS: Cpp2IL installed/, out.text);
      const sources = out.text.split("\n").filter((line) => line.includes("source:"));
      assert.equal(sources.length, 2, `both mirrors are reported:\n${out.text}`);
      assert.match(sources[0], new RegExp(`${down.label}: HTTP 500`), "the first attempt and its reason come first");
      assert.match(sources[1], new RegExp(`${good.label}: .* digest ok`), "the mirror that worked is named");
      assert.deepEqual(
        [down.requests.length, good.requests.length],
        [1, 1],
        "mirrors are tried in the order toolchain.json lists them",
      );
    });
  } finally {
    await down.close();
    await good.close();
  }
});

posixTest("an installed tool that does not run is replaced, not trusted", async () => {
  const server = await mirror(FAKE_TOOL);
  try {
    await withWorld([server.url], {}, async ({ run, target }) => {
      write(target, "truncated, not a binary");
      chmodSync(target, 0o755);
      const out = await run({ action: "setup" });
      assert.equal(out.ok, true, out.text);
      assert.match(out.text, /^PASS: Cpp2IL installed/, out.text);
      assert.match(out.text, /source: .* exists but does not run; replacing it/, "the reason for the download is stated");
      assert.deepEqual(readFileSync(target), FAKE_TOOL, "the broken file is gone");
    });
  } finally {
    await server.close();
  }
});
