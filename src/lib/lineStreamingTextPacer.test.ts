import { describe, expect, it } from "vitest";
import { streamingLinePlan } from "./lineStreamingTextPacer";

describe("Work-modal source line boundaries", () => {
  it("keeps a possible GFM header and its delimiter together", () => {
    const header = "| Name | Result |\n";
    expect(streamingLinePlan(header)).toEqual({ ends: [], proseTail: false });
    expect(streamingLinePlan(header + "| --- | :---")).toEqual({ ends: [], proseTail: false });
    const table = header + "| --- | :---: |\n";
    expect(streamingLinePlan(table)).toEqual({ ends: [table.length], proseTail: false });
    expect(streamingLinePlan(table + "| test | pend")).toEqual({ ends: [table.length], proseTail: false });
    const row = "| test | passed |\n";
    expect(streamingLinePlan(table + row)).toEqual({ ends: [table.length, table.length + row.length], proseTail: false });
  });

  it("matches GFM unescaped pipes inside code, escaped pipes, and short delimiters", () => {
    const codeHeader = "a `b|c`\n-|-\n";
    expect(streamingLinePlan(codeHeader)).toEqual({ ends: [codeHeader.length], proseTail: false });
    expect(streamingLinePlan("ordinary \\| prose")).toEqual({ ends: [], proseTail: true });
    const escaped = "| `a\\|b` | c |\n| - | - |\n";
    expect(streamingLinePlan(escaped)).toEqual({ ends: [escaped.length], proseTail: false });
    expect(streamingLinePlan(escaped + "| `d|e` | f |")).toEqual({ ends: [escaped.length], proseTail: false });
  });

  it("releases a pipe-containing paragraph when its next complete line disproves a table", () => {
    const first = "alpha | bravo\n";
    const second = "ordinary continuation\n";
    expect(streamingLinePlan(first + second)).toEqual({ ends: [first.length, first.length + second.length], proseTail: false });
  });

  it("holds GFM body rows without a pipe and recognizes block interruptions", () => {
    const table = "| A | B |\n| - | - |\n";
    expect(streamingLinePlan(table + "plain row words with no pipe")).toEqual({ ends: [table.length], proseTail: false });
    const row = "plain row words with no pipe\n";
    expect(streamingLinePlan(table + row)).toEqual({ ends: [table.length, table.length + row.length], proseTail: false });
    for (const ending of ["\nprose", "---\nprose", "# heading\nprose", "    code\n\nprose", "<!-- html -->\n\nprose"]) {
      expect(streamingLinePlan(table + ending).proseTail).toBe(true);
    }
    expect(streamingLinePlan(table + "====").proseTail).toBe(false);
  });

  it("preserves headings, lists, blank lines, fenced code and CRLF source offsets", () => {
    const source = "# Heading\r\n\r\n- item\r\n```ts\r\nconst row = '| incomplete';\r\n```\r\nplain tail";
    const ends = [...source.matchAll(/\n/g)].map(match => match.index + 1);
    expect(streamingLinePlan(source)).toEqual({ ends, proseTail: true });
    for (const tail of ["# head", "- list", "1. list", "> quote", "    code", "```js", "~~~\nunfinished"]) {
      expect(streamingLinePlan(tail).proseTail).toBe(false);
    }
  });

  it("does not close a code fence on a shorter or differently marked fence", () => {
    expect(streamingLinePlan("````js\n```\nstill code").proseTail).toBe(false);
    expect(streamingLinePlan("```\n~~~\nstill code").proseTail).toBe(false);
    expect(streamingLinePlan("```\n```\nnow prose").proseTail).toBe(true);
  });

  it("does not confuse angle-bracket prose or inline HTML with an HTML block", () => {
    const table = "| A | B |\n| - | - |\n";
    expect(streamingLinePlan("<3 ordinary prose").proseTail).toBe(true);
    expect(streamingLinePlan(table + "<3 row text").proseTail).toBe(false);
    expect(streamingLinePlan(table + "<b>inline row</b>").proseTail).toBe(false);
    expect(streamingLinePlan(table + "<span>\n\nprose").proseTail).toBe(true);
  });
});
