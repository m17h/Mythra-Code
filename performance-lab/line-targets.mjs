// Conservative source-to-visible-text matching for opt-in lab measurements.
// Syntax-bearing/ambiguous lines are unsupported, not failed render output.
export const compact = (text) => text.replace(/\s+/g, " ").trim();

function occurrences(text, target) {
  let count = 0, from = 0;
  for (let index; (index = text.indexOf(target, from)) !== -1; from = index + 1) count++;
  return count;
}

export function planLineTargets(capture, finalVisibleText) {
  const lines = [], excluded = [];
  const finalVisible = compact(finalVisibleText);
  let source = "", consumed = 0, completeNonemptyLines = 0;
  for (const event of capture.events) {
    source += event.text;
    for (let end; (end = source.indexOf("\n", consumed)) !== -1;) {
      const raw = source.slice(consumed, end), text = compact(raw);
      consumed = end + 1;
      if (!text) continue;
      completeNonemptyLines++;
      let reason = null;
      if (/[`*_#|>\[\]<>\\~]/.test(raw) || /&(?:[a-zA-Z][\w]*|#(?:\d+|x[0-9a-fA-F]+));/.test(raw)
        || /^ {0,3}(?:[-+]\s|\d+[.)]\s|(?:=+|-+)\s*$)/.test(raw) || /^(?: {4}|\t)/.test(raw)) reason = "markdown-syntax-or-entity";
      else {
        const count = occurrences(finalVisible, text);
        if (count === 0) reason = "not-visible-in-static-markdown";
        else if (count !== 1) reason = "ambiguous-visible-occurrence";
      }
      const entry = { text, sourceAtMs: event.at };
      if (reason) excluded.push({ ...entry, reason });
      else lines.push({ ...entry, observedAtMs: null });
    }
  }
  return { lines, excluded, completeNonemptyLines };
}

export function observeLineTargets(lines, visibleText, nowMs, receivedThroughAtMs) {
  const visible = compact(visibleText);
  for (const line of lines) {
    if (line.observedAtMs === null && nowMs >= line.sourceAtMs && receivedThroughAtMs >= line.sourceAtMs && visible.includes(line.text)) line.observedAtMs = nowMs;
  }
}
