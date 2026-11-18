import { memo, useMemo, type ReactNode } from "react";
import { highlightLines, languageForFence, languageForPath, type SyntaxLanguage, type SyntaxToken } from "../lib/syntaxHighlight";

/** Larger blocks stay plain text: colouring them costs more than it helps. */
const MAX_HIGHLIGHT_CHARS = 60_000;

/** Coloured spans for one line's tokens. Plain tokens stay bare text nodes. */
export function renderSyntaxTokens(tokens: SyntaxToken[], keyPrefix: string | number = ""): ReactNode[] {
  return tokens.map((token, index) => token.kind
    ? <span key={`${keyPrefix}:${index}`} className={`syn-${token.kind}`}>{token.text}</span>
    : token.text);
}

/**
 * A code block's text, coloured with the shared tokenizer (the same one the
 * diff viewer uses) and the theme's `--syntax-*` colours.
 *
 * Use it as the *content* of an existing `<code>`/`<pre>`: it renders only
 * spans and newline text, so the element's `textContent` — what Copy reads —
 * is exactly `code`. `language` accepts a Markdown fence name ("ts",
 * "python") or a file path; anything unknown renders as plain text.
 */
export const HighlightedCode = memo(function HighlightedCode({ code, language, path }: {
  code: string;
  /** Fence name such as "tsx" or "bash". */
  language?: string | null;
  /** A file path, when the language should come from its extension instead. */
  path?: string | null;
}) {
  const resolved: SyntaxLanguage | null = languageForFence(language) ?? languageForPath(path);
  const content = useMemo(() => {
    if (!resolved || code.length > MAX_HIGHLIGHT_CHARS) return code;
    const lines = code.split("\n");
    const tokens = highlightLines(lines, resolved);
    const nodes: ReactNode[] = [];
    lines.forEach((_, index) => {
      nodes.push(...renderSyntaxTokens(tokens[index], index));
      if (index < lines.length - 1) nodes.push("\n");
    });
    return nodes;
  }, [code, resolved]);
  return <>{content}</>;
});
