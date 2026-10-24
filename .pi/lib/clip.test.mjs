/** bun test ./.pi/lib/clip.test.mjs */
import { test, expect } from "bun:test";
import { clipUtf8, ascii } from "./clip";

test("the limit is bytes, not characters", () => {
  const text = "汉".repeat(10000); // 30000 bytes, 10000 characters
  const out = clipUtf8(text, 1000);
  expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1000);
});

test("a character is never split and a surrogate pair stays whole", () => {
  const out = clipUtf8("汉😀".repeat(1000), 101);
  expect(out.includes("\uFFFD")).toBe(false);
  const body = out.replace(/\n\.\.\. \(output truncated\)$/, "");
  expect([...body].every((c) => c === "汉" || c === "😀")).toBe(true);
});

test("short text is returned unchanged", () => {
  expect(clipUtf8("abc", 10)).toBe("abc");
});

test("ascii escapes non-ASCII and leaves printable ASCII", () => {
  expect(ascii("a 汉")).toBe("a \\u6c49");
});
