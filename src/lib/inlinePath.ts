export type InlinePathParts = { prefix: string; middle: string; destination: string };

/** Recognize standalone paths without changing their source text. The three
 * slices join to the original path, including mixed or trailing separators. */
export function inlinePathParts(text: string): InlinePathParts | null {
  if (!text || text !== text.trim() || text.startsWith("//") || /[\r\n\t<>|"`*?={};&$]/.test(text)) return null;
  const windowsRooted = /^[a-z]:[\\/]|^\\/i.test(text);
  if (/[()]/.test(text) && !windowsRooted) return null;
  // A separator surrounded by spaces is usually arithmetic; a new rooted path
  // or option after whitespace is usually a command argument. Leave ambiguous
  // inline code alone instead of hiding an executable or argument boundary.
  if (/\s[\\/]|[\\/]\s/.test(text)
    || /\s(?:--?\w|\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/])/i.test(text)) return null;
  if (/^\/(?:s?bin|usr\/(?:local\/)?s?bin)\/\S+\s/.test(text)
    || /\.(?:exe|cmd|bat|ps1|sh|py|rb|js)\s+\S/i.test(text)) return null;
  const rooted = /^(?:[a-z]:[\\/]|\\|\/|~\/|\.{1,2}[\\/])/i.test(text);
  // Bare slash expressions such as total/count are ambiguous. A relative
  // filename, explicit ./ or ../ root, Windows separator or trailing slash
  // provides path evidence without changing ordinary arithmetic/code.
  if (!rooted && (!/^[\p{L}\p{N}_.@ +\\/-]+$/u.test(text) || !/[\\/]/.test(text) || /\S\+|\+\S/.test(text))) return null;
  if (!rooted && /^[\d.\\/\s-]+$/.test(text)) return null;
  const windows = windowsRooted || (!text.startsWith("/") && text.includes("\\"));
  const components = Array.from(text.matchAll(windows ? /[^\\/]+/g : /[^/]+/g));
  if (!components.length) return null;
  const last = components[components.length - 1];
  if (!rooted && !text.includes("\\") && !/[\\/]$/.test(text) && !/\.\p{L}/u.test(last[0])) return null;
  const destinationStart = last.index!;
  // Retain the root and first directory when there is a real middle to hide.
  // Otherwise the directory portion itself can shrink beside the destination.
  const next = components[1];
  const prefixEnd = next && next.index! < destinationStart ? next.index! : 0;
  return {
    prefix: prefixEnd ? text.slice(0, prefixEnd) : "",
    middle: text.slice(prefixEnd, destinationStart),
    destination: text.slice(destinationStart),
  };
}
