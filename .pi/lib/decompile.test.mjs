/**
 * Tests for the dump reader. Run with: `cd .pi/lib && bun test`（Bun 会跳过以点开头的目录）
 *
 * The pure functions are checked against small fixtures. The four integration
 * cases read the dump that is actually on this machine and skip when it is
 * absent, so the suite stays honest on a machine that never dumped the game.
 */
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFreshness,
  configSignature,
  dumpDir,
  extractMethods,
  extractTypeBlock,
  isilRelPath,
  loadConfig,
  resolveGame,
  resolveIsilFile,
  searchBodies,
  searchDump,
  searchHeader,
  searchStrings,
  takeCapped,
  truncate,
} from "./decompile.ts";

const FIXTURE = `
// Image 4: Game.dll - 4049

// Namespace: 
public class EventNode // TypeDefIndex: 5662
{
	// Fields
	[CompilerGenerated]
	private bool <is_replay>k__BackingField; // 0x1C

	// Properties
	public bool is_replay { get; set; }

	// Methods
	// RVA: 0x4E5890 Offset: 0x4E5890 VA: 0x4E5890
	public void .ctor() { }
}

// Namespace: DataNode.Json
public class EventNode_JsonHandler // TypeDefIndex: 5912
{
	// Fields
	private bool is_replay; // 0x10
}
`;

test("isilRelPath maps namespaces to folders", () => {
  expect(isilRelPath("", "EventNode")).toBe("EventNode.txt");
  expect(isilRelPath("DataNode.Json", "EventNode_JsonHandler")).toBe("DataNode/Json/EventNode_JsonHandler.txt");
});

test("isilRelPath flattens nested and compiler-generated names", () => {
  expect(isilRelPath("DataNode.Json", "EventNode_JsonHandler.<>c")).toBe(
    "DataNode/Json/EventNode_JsonHandler_NestedType___c.txt",
  );
  expect(isilRelPath("DG.Tweening", "DOTweenModuleUI.<>c__DisplayClass9_0")).toBe(
    "DG/Tweening/DOTweenModuleUI_NestedType___c__DisplayClass9_0.txt",
  );
});

test("extractTypeBlock cuts one type and keeps its fields", () => {
  const block = extractTypeBlock(FIXTURE, "EventNode");
  expect(block).not.toBeNull();
  expect(block.namespace).toBe("");
  expect(block.declaration).toBe("class EventNode");
  expect(block.text).toContain("<is_replay>k__BackingField; // 0x1C");
  expect(block.text).not.toContain("EventNode_JsonHandler");
});

test("isilRelPath writes a generic as its arity", () => {
  // dump.cs says PropertyReader<T>; Cpp2IL names the file PropertyReader`1.
  expect(isilRelPath("DataNode.Json", "JsonSerializerHandler.PropertyReader<T>")).toBe(
    "DataNode/Json/JsonSerializerHandler_NestedType_PropertyReader`1.txt",
  );
  expect(isilRelPath("", "Foo<TKey, TValue>")).toBe("Foo`2.txt");
});

test("extractTypeBlock finds a generic type by every name a reader may type", () => {
  const generic = [
    "// Namespace: DataNode.Json",
    "public sealed class PropertyReader<T> // TypeDefIndex: 8196",
    "{",
    "\tprivate bool ok; // 0x10",
    "}",
  ].join("\n");
  for (const name of ["PropertyReader", "PropertyReader<T>", "DataNode.Json.PropertyReader"]) {
    expect(extractTypeBlock(generic, name)?.display).toBe("DataNode.Json.PropertyReader");
  }
});

test("extractTypeBlock accepts a namespace and a short name", () => {
  const byShort = extractTypeBlock(FIXTURE, "EventNode_JsonHandler");
  expect(byShort.namespace).toBe("DataNode.Json");
  expect(extractTypeBlock(FIXTURE, "NoSuchType")).toBeNull();
});

test("searchDump names the owner of a member hit", () => {
  const hits = searchDump(FIXTURE, "is_replay");
  const member = hits.find((h) => h.kind === "member");
  expect(member?.owner).toBe("EventNode");
  expect(hits.some((h) => h.kind === "type" && h.owner === "EventNode")).toBe(false);
});

test("searchDump finds type declarations by substring", () => {
  const hits = searchDump(FIXTURE, "eventnode");
  expect(hits.filter((h) => h.kind === "type").map((h) => h.owner)).toEqual([
    "EventNode",
    "EventNode_JsonHandler",
  ]);
});

test("searchBodies reads inside ISIL files, filters by path, and caps the hits", () => {
  const root = mkdtempSync(join(tmpdir(), "isil-"));
  mkdirSync(join(root, "cpp2il/IsilDump/Game"), { recursive: true });
  mkdirSync(join(root, "cpp2il/IsilDump/Core"), { recursive: true });
  writeFileSync(join(root, "cpp2il/IsilDump/Game/A.txt"), "Method: A\n\t004 Move rax, [rdi+40]\n");
  writeFileSync(join(root, "cpp2il/IsilDump/Core/B.txt"), "Method: B\n\t004 Move rax, [rdi+40]\n");
  writeFileSync(
    join(root, "cpp2il/IsilDump/Game/Many.txt"),
    ["Method: Many", ...Array.from({ length: 60 }, (_, i) => `\t${i} Move rax, [rdi+999]`)].join("\n"),
  );

  try {
    // Case is ignored, and a hit says which file and line it came from.
    const all = searchBodies(root, "[RDI+40]");
    expect(all.map((h) => h.file).sort()).toEqual(["cpp2il/IsilDump/Core/B.txt", "cpp2il/IsilDump/Game/A.txt"]);
    expect(all[0].line).toBe(2);

    // A path fragment narrows the walk before the file is read.
    expect(searchBodies(root, "[rdi+40]", "Game/").map((h) => h.file)).toEqual(["cpp2il/IsilDump/Game/A.txt"]);

    // 60 matching lines arrive as 50 hits, so one call cannot flood the context.
    expect(searchBodies(root, "[rdi+999]").length).toBe(50);

    // No hit, and no ISIL tree at all, are both empty results rather than errors.
    expect(searchBodies(root, "nothing here")).toEqual([]);
    expect(searchBodies(join(root, "no-such-dump"), "[rdi+40]")).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a search header says when the list was cut, and what the file count covers", () => {
  expect(searchHeader({ scope: "names", target: "class EventNode", matches: 8, capped: false, limit: 50 })).toBe(
    '# search "class EventNode" (names): 8 match(es)',
  );
  expect(
    searchHeader({ scope: "bodies", target: "InitNode", matches: 50, files: 11, capped: true, limit: 50 }),
  ).toBe('# search "InitNode" (bodies): 50 match(es) in 11 file(s) - capped at 50 hits, so more files may match');
  // `all` mixes dump.cs with ISIL files: a file count would read as if the matches were spread over it.
  expect(
    searchHeader({ scope: "all", target: "InitNode", matches: 100, capped: true, limit: 50 }),
  ).toBe('# search "InitNode" (all): 100 match(es) - capped at 50 hits per scope, so more may match');
  expect(searchHeader({ scope: "strings", target: "Rite", matches: 50, capped: true, limit: 50 })).toBe(
    '# strings "Rite": 50 match(es) - capped at 50 hits, so more may match',
  );
});

test("takeCapped separates the end of a list from a cut list", () => {
  const exact = takeCapped(Array.from({ length: 50 }, (_, i) => i), 50);
  expect(exact.hits.length).toBe(50);
  expect(exact.capped).toBe(false);

  const more = takeCapped(Array.from({ length: 51 }, (_, i) => i), 50);
  expect(more.hits.length).toBe(50);
  expect(more.capped).toBe(true);
  expect(more.hits.at(-1)).toBe(49);
});

test("extractMethods splits blocks and filters by member", () => {
  const isil = [
    "Type: EventNode",
    "",
    "Method: System.Boolean get_is_replay()",
    "",
    "ISIL:",
    "\t001 Return rax",
    "",
    "Method: System.Void set_is_replay(System.Boolean value)",
    "",
    "ISIL:",
    "\t001 Return ",
  ].join("\n");
  expect(extractMethods(isil).length).toBe(2);
  const only = extractMethods(isil, "set_is_replay");
  expect(only.length).toBe(1);
  expect(only[0].text).toContain("set_is_replay");
});

test("truncate caps lines and bytes", () => {
  expect(truncate("a\nb\nc", 2)).toContain("1 more lines truncated");
  const clipped = truncate("x".repeat(1000), 10, 200);
  expect(clipped).toContain("output truncated");
  expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(200);
});

test("configSignature ignores order and budget", () => {
  const a = configSignature({ version: 1, runtime: "il2cpp", dump: { assemblies: ["B", "A"] } });
  const b = configSignature({
    version: 1,
    runtime: "il2cpp",
    dump: { assemblies: ["A", "B"], budgetBytes: 1 },
  });
  expect(a).toBe(b);
});

// ── integration: the dump on this machine ──────────────────────────────────

const REPO = join(import.meta.dirname, "..", "..");
const DIR = dumpDir(REPO);

test("this repository's dump is fresh", () => {
  if (!existsSync(join(DIR, "MANIFEST.json"))) return; // no dump on this machine
  const cfg = loadConfig(REPO);
  const game = resolveGame(REPO, null);
  expect(game).not.toBeNull();
  const fresh = checkFreshness(REPO, cfg, game);
  expect(fresh.state).toBe("fresh");
});

test("EventNode resolves to a type block and an ISIL file", () => {
  const dumpCs = join(DIR, "il2cppdumper/dump.cs");
  if (!existsSync(dumpCs)) return;
  const block = extractTypeBlock(readFileSync(dumpCs, "utf8"), "EventNode");
  expect(block?.namespace).toBe("");
  const isil = resolveIsilFile(DIR, block.namespace, "EventNode");
  expect(isil).toContain("IsilDump");
  const methods = extractMethods(readFileSync(isil, "utf8"));
  expect(methods.length).toBeGreaterThan(0);
});

test("a nested type resolves to its flattened ISIL file", () => {
  const root = join(DIR, "cpp2il/IsilDump");
  if (!existsSync(root)) return;
  const name = "JsonSerializerHandler.<>c";
  const isil = resolveIsilFile(DIR, "DataNode.Json", name);
  expect(isil).not.toBeNull();
  expect(isil?.endsWith("_NestedType___c.txt")).toBe(true);
});

test("string literals are searchable", () => {
  const file = join(DIR, "il2cppdumper/stringliteral.json");
  if (!existsSync(file)) return;
  const hits = searchStrings(file, "Rite", 5);
  expect(hits.length).toBeGreaterThan(0);
});
