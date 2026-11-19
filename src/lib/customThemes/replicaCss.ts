// Pure CSS helpers behind the live theme previews (CustomThemePreview.tsx).
//
// A preview is a miniature copy of the real app window drawn inside a shadow
// root, so the app's own stylesheets apply to it but the theme on screen can
// never reach it (and its theme never reaches the app). These helpers turn the
// document's stylesheets into one sheet for those shadow roots:
//   - `:root` becomes `:host`, so rules keyed on the document root still apply;
//   - width/height media queries are decided for the replica's own size, not
//     the real window's, so a narrow window doesn't squash every preview.
// No DOM access here; the caller passes CSSOM-like objects.

/** The size the replica is laid out at (then scaled down to fit a card). 16:10, like the cards. */
export const REPLICA_SIZE = { width: 1200, height: 750 } as const;

export interface Viewport { width: number; height: number }

const LENGTH = /^(-?\d*\.?\d+)(px|em|rem)?$/;
const toPx = (value: string): number | null => {
  const match = LENGTH.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] === "em" || match[2] === "rem" ? n * 16 : n;
};

type Verdict = boolean | null;

/** One `(feature)` of a media query: true/false for width and height, null for anything else. */
function evaluateFeature(feature: string, viewport: Viewport): Verdict {
  const body = feature.trim().replace(/^\(|\)$/g, "").trim();
  const colon = /^(min-|max-)?(width|height)\s*:\s*(.+)$/i.exec(body);
  if (colon) {
    const px = toPx(colon[3]);
    if (px === null) return null;
    const size = colon[2].toLowerCase() === "width" ? viewport.width : viewport.height;
    const prefix = colon[1]?.toLowerCase();
    return prefix === "min-" ? size >= px : prefix === "max-" ? size <= px : size === px;
  }
  // Range syntax: (width <= 900px), (900px < width), (600px <= width <= 900px).
  const range = /^(?:([\d.]+(?:px|em|rem)?)\s*(<=|<|>=|>)\s*)?(width|height)(?:\s*(<=|<|>=|>)\s*([\d.]+(?:px|em|rem)?))?$/i.exec(body);
  if (range && (range[1] || range[5])) {
    const size = range[3].toLowerCase() === "width" ? viewport.width : viewport.height;
    const compare = (a: number, op: string, b: number) => (op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b);
    let ok = true;
    if (range[1]) { const px = toPx(range[1]); if (px === null) return null; ok = ok && compare(px, range[2], size); }
    if (range[5]) { const px = toPx(range[5]); if (px === null) return null; ok = ok && compare(size, range[4], px); }
    return ok;
  }
  return null;
}

/** One query of a list: `screen and (max-width: 700px)`. */
function evaluateQuery(query: string, viewport: Viewport): Verdict {
  const text = query.trim();
  if (!text) return null;
  if (/^not\b/i.test(text) || /\bor\b/i.test(text)) return null;
  const parts = text.replace(/^only\s+/i, "").split(/\s+and\s+/i);
  let unknown = false;
  for (const part of parts) {
    const piece = part.trim();
    if (/^(all|screen)$/i.test(piece)) continue;
    if (/^print$/i.test(piece)) return false;
    const verdict = piece.startsWith("(") ? evaluateFeature(piece, viewport) : null;
    if (verdict === false) return false;
    if (verdict === null) unknown = true;
  }
  return unknown ? null : true;
}

/**
 * Decide a media query for the replica's viewport. true: always applies (unwrap
 * it), false: never applies (drop it), null: depends on something else, such
 * as reduced motion or hover (keep it as written).
 */
export function evaluateViewportMedia(mediaText: string, viewport: Viewport = REPLICA_SIZE): Verdict {
  const queries = mediaText.split(",");
  let unknown = false;
  for (const query of queries) {
    const verdict = evaluateQuery(query, viewport);
    if (verdict === true) return true;
    if (verdict === null) unknown = true;
  }
  return unknown ? null : false;
}

/**
 * `:root` rules for the shadow root: `:root` alone becomes `:host`, `:root[x]`
 * becomes `:host([x])` (a bare attribute after :host never matches).
 */
export function rootToHost(css: string): string {
  return css
    .replace(/:root((?:\[[^\]]*\])+)/g, ":host($1)")
    .replace(/:root\b/g, ":host");
}

/** The CSSOM shape these helpers read (CSSRule, CSSMediaRule, CSSGroupingRule). */
export interface RuleLike {
  cssText: string;
  media?: { mediaText: string };
  cssRules?: ArrayLike<RuleLike>;
}

/** Serialize rules for the replica sheet: viewport media decided, everything else as written. */
export function serializeReplicaRules(rules: ArrayLike<RuleLike>, viewport: Viewport = REPLICA_SIZE): string {
  const out: string[] = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.media && rule.cssRules && /^@media/i.test(rule.cssText.trimStart())) {
      const verdict = evaluateViewportMedia(rule.media.mediaText, viewport);
      if (verdict === false) continue;
      const inner = serializeReplicaRules(rule.cssRules, viewport);
      if (!inner) continue;
      out.push(verdict === true ? inner : `@media ${rule.media.mediaText} {\n${inner}\n}`);
      continue;
    }
    out.push(rule.cssText);
  }
  return out.join("\n");
}

/** The selector prefix a theme compiled for a replica uses (see compileThemeCss, scope "preview"). */
export function replicaScope(id: string): string {
  return `.app-shell[data-theme][data-color-scheme][data-custom-theme="${id}"][data-ct-replica]`;
}
