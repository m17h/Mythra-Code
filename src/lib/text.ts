const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

/** Decode entity-escaped model labels into plain text. React still escapes the
 * returned string when rendering it, so decoded angle brackets remain text. */
export function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|apos|gt|lt|nbsp|quot);/gi, (match, encoded: string) => {
    if (!encoded.startsWith("#")) return NAMED_HTML_ENTITIES[encoded.toLowerCase()] ?? match;
    const hexadecimal = encoded[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(encoded.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return match;
    }
    return String.fromCodePoint(codePoint);
  });
}
