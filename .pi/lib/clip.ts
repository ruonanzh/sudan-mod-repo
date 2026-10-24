/**
 * Output limits for tool `content`: a byte budget, cut on a character boundary.
 *
 * A limit counted in characters lets a message of Chinese (three bytes each) pass a "50 KB" check
 * at 150 KB; a limit applied before escaping lets a 500-character message grow sixfold afterwards.
 * Both tools that write long text call this last, on the finished string.
 */
export const MAX_CONTENT_BYTES = 50 * 1024;

/** Escape everything outside printable ASCII, so a legacy Windows console prints it. */
export const ascii = (text: string): string =>
  String(text).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a character or a surrogate pair. */
export function clipUtf8(text: string, maxBytes = MAX_CONTENT_BYTES): string {
  const input = String(text);
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  const marker = "\n... (output truncated)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  // A budget smaller than the marker gets no marker: the limit wins, silently.
  const budget = Math.max(0, maxBytes - markerBytes);
  let used = 0;
  let out = "";
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return maxBytes < markerBytes ? out : out + marker;
}
