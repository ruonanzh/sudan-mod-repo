/**
 * The decompile flow, end to end against a fake game and a fake dump.
 *
 * No real game, no dotnet work, no network: the dump is a handful of text files, the tools are
 * scripts that answer --version, and the manifest is written by this test with the same shape
 * buildDump produces. What is exercised is the flow the agent drives — status, search, type,
 * body, strings — and the freshness judgement behind it.
 *
 *   node --test script/decompile-flow.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadExtension } from "./lib/load-extension.mjs";

const DARWIN = process.platform === "darwin";
const CPP2IL = DARWIN
  ? process.arch === "arm64" ? "cpp2il-osx-arm64" : "cpp2il-osx-x64"
  : process.arch === "arm64" ? "cpp2il-linux-arm64" : "cpp2il-linux-x64";

const { configSignature, sha256File } = await import("../.pi/lib/decompile.ts");

const write = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

/** A world where the game, the dump and the tools all exist and agree. */
function world() {
  const root = mkdtempSync(path.join(tmpdir(), "decompile-flow-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "sudan-mod-repo");
  const decompiled = path.join(root, "decompiled");
  const dump = path.join(decompiled, "sudan-mod-repo");

  write(path.join(cwd, ".pi/lib/decompile.json"), JSON.stringify({ version: 1, runtime: "il2cpp", dump: { assemblies: ["Game"], budgetBytes: 10_000_000 } }));
  write(path.join(cwd, "mod-repo.json"), JSON.stringify({ game: { name: "Fake Game" } }));
  write(path.join(cwd, "tools/il2cppdumper/Il2CppDumper.dll"), "not really a dll");

  // A dotnet that answers the version probe, and a Cpp2IL that answers --version.
  write(path.join(home, ".dotnet/dotnet"), "#!/bin/sh\necho 8.0.100\n");
  chmodSync(path.join(home, ".dotnet/dotnet"), 0o755);
  write(path.join(decompiled, "tools/cpp2il", CPP2IL), "#!/bin/sh\necho Cpp2IL 2022.1.0\n");
  chmodSync(path.join(decompiled, "tools/cpp2il", CPP2IL), 0o755);

  // The game: only the two files the decompiler reads matter.
  const app = path.join(root, "Sultan's Game/Sultan's Game.app");
  const binary = path.join(app, "Contents/Frameworks/GameAssembly.dylib");
  const metadata = path.join(app, "Contents/Resources/Data/il2cpp_data/Metadata/global-metadata.dat");
  write(binary, "fake il2cpp binary");
  write(metadata, "fake metadata");

  // The dump: a manifest that matches, one type, one body, one string.
  write(path.join(dump, "il2cppdumper/dump.cs"), "// Namespace: Game\npublic class Foo // TypeDefIndex: 1\n{\n\t// Fields\n\tpublic int hp; // 0x10\n\t// Methods\n\tpublic void Bar (); // RVA: 1\n}\n");
  write(path.join(dump, "cpp2il/IsilDump/Game/Foo.txt"), "Method: public void Foo.Bar ()\n\t000 Move rax, 1\n");
  // The same offset in two folders: the `path` filter has something to choose between.
  write(path.join(dump, "cpp2il/IsilDump/Game/Bar.txt"), "Method: public void Bar.Baz ()\n\t004 Move rax, [rdi+152]\n");
  write(path.join(dump, "cpp2il/IsilDump/Core/Baz.txt"), "Method: public void Baz.Qux ()\n\t004 Move rax, [rdi+152]\n");
  write(path.join(dump, "il2cppdumper/stringliteral.json"), JSON.stringify([{ address: "0x1", value: "hello from the fake dump" }]));
  const cfg = JSON.parse(readFileSync(path.join(cwd, ".pi/lib/decompile.json"), "utf8"));
  write(
    path.join(dump, "MANIFEST.json"),
    JSON.stringify({
      build: { binary: { path: binary, bytes: 18, sha256: sha256File(binary) }, metadata: { path: metadata, bytes: 13, sha256: sha256File(metadata) } },
      config: { signature: configSignature(cfg), assemblies: ["Game"] },
      pruning: { mode: "game-only", keptAssemblies: ["Game"], removedAssemblies: [] },
      tools: { il2cppdumper: { path: "x", sha256: "x", version: "" }, cpp2il: { path: "y", sha256: "y", version: "" } },
      contents: { "il2cppdumper/dump.cs": { bytes: 1 }, "cpp2il/IsilDump": { typeFiles: 1 }, totalBytes: 1 },
    }),
  );

  // The path record is what resolveGame reads first; without it the game is "not found".
  write(path.join(cwd, ".gamer-agent.local.json"), JSON.stringify({ gameDir: app }));

  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: `${home}/.dotnet:/usr/bin:/bin`,
    DECOMPILED_ROOT: decompiled,
  };
  return { root, home, cwd, dump, binary, metadata, env };
}

/** Run `body` with this fake world's environment. */
async function withWorld(body) {
  const w = world();
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, DECOMPILED_ROOT: process.env.DECOMPILED_ROOT };
  Object.assign(process.env, w.env);
  try {
    const tool = await loadExtension("inspect-game-code.ts");
    const run = (params) => tool.execute("c", params, undefined, undefined, { cwd: w.cwd });
    const text = (r) => r.content.map((c) => c.text).join("\n");
    return await body({ ...w, run, text });
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("status of a dump that matches the game is PASS without a NEXT", async () => {
  await withWorld(async ({ run, text }) => {
    const out = await run({ action: "status" });
    const body = text(out);
    assert.match(body, /^PASS: the dump is current/, body);
    assert.doesNotMatch(body, /NEXT:/, "success carries no next step");
  });
});

test("search, type, body and strings read the fake dump", async () => {
  await withWorld(async ({ run, text }) => {
    const search = text(await run({ action: "search", target: "Foo" }));
    assert.match(search, /Foo/, "the type is found");
    const type = text(await run({ action: "type", target: "Foo" }));
    assert.match(type, /hp/, "the field is listed");
    assert.match(type, /Bar/, "the method is listed");
    const bodyText = text(await run({ action: "body", target: "Foo", member: "Bar" }));
    assert.match(bodyText, /Move rax/, "the body comes from the ISIL file");
    const strings = text(await run({ action: "strings", target: "hello from the fake" }));
    assert.match(strings, /hello from the fake dump/, "string literals are searchable");
  });
});

test("a changed game binary makes the dump stale, and says so", async () => {
  await withWorld(async ({ run, text, binary }) => {
    writeFileSync(binary, "a different build");
    const out = await run({ action: "status" });
    const body = text(out);
    assert.match(body, /^FAIL:/, body);
    assert.match(body, /stale/i, "the reason names the change");
    assert.match(body, /NEXT:/, "and gives the next step");
  });
});

test("a changed decompile.json makes the dump stale", async () => {
  await withWorld(async ({ run, text, cwd }) => {
    writeFileSync(path.join(cwd, ".pi/lib/decompile.json"), JSON.stringify({ version: 1, runtime: "il2cpp", dump: { assemblies: ["Game", "Extra"], budgetBytes: 10_000_000 } }));
    const body = text(await run({ action: "status" }));
    assert.match(body, /^FAIL:/, body);
    assert.match(body, /decompile\.json changed/, body);
  });
});

test("a missing dump is FAIL with NEXT, not a crash", async () => {
  await withWorld(async ({ run, text, dump }) => {
    rmSync(dump, { recursive: true, force: true });
    const body = text(await run({ action: "status" }));
    assert.match(body, /^FAIL: no dump/, body);
    assert.match(body, /NEXT:/, body);
  });
});

test("search scope=bodies reads inside the ISIL files; the default reads declarations", async () => {
  await withWorld(async ({ run, text }) => {
    const bodies = text(await run({ action: "search", target: "rdi+152", scope: "bodies" }));
    assert.match(bodies, /2 match/, bodies);
    assert.match(bodies, /cpp2il\/IsilDump\/Game\/Bar\.txt:\d+/, "a hit names the file and the line");
    assert.match(bodies, /cpp2il\/IsilDump\/Core\/Baz\.txt:\d+/, bodies);

    const upper = text(await run({ action: "search", target: "RDI+152", scope: "bodies" }));
    assert.match(upper, /2 match/, "search ignores case");

    const names = text(await run({ action: "search", target: "rdi+152" }));
    assert.match(names, /0 match/, "the default scope reads dump.cs only, so a body-only string is not found");
  });
});

test("search path= narrows scope=bodies to one folder", async () => {
  await withWorld(async ({ run, text }) => {
    const out = text(await run({ action: "search", target: "rdi+152", scope: "bodies", path: "Core/" }));
    assert.match(out, /1 match/, out);
    assert.match(out, /Core\/Baz\.txt/, out);
    assert.doesNotMatch(out, /Game\/Bar\.txt/, "the other folder is not read");
  });
});

test("search scope=all reports names and bodies under their own headings", async () => {
  await withWorld(async ({ run, text }) => {
    const out = text(await run({ action: "search", target: "Bar", scope: "all" }));
    assert.match(out, /# names/, out);
    assert.match(out, /# bodies/, out);
    assert.match(out, /Bar\.Baz/, "the body hit sits under bodies");
  });
});

test("search scope=bodies stops at 50 hits", async () => {
  await withWorld(async ({ run, text, dump }) => {
    const lines = Array.from({ length: 60 }, (_, i) => `\t${String(i).padStart(3, "0")} Move rax, [rdi+999]`);
    write(path.join(dump, "cpp2il/IsilDump/Game/Many.txt"), `Method: public void Many.Loop ()\n${lines.join("\n")}\n`);
    const out = text(await run({ action: "search", target: "rdi+999", scope: "bodies" }));
    assert.match(out, /50 match/, "one call cannot return more than 50 hits");
  });
});
