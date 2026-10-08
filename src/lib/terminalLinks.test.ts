import { describe, expect, it } from "vitest";
import { findTerminalLinks, linksAtBufferRow, normalizeTerminalLink, type TerminalBufferReader } from "./terminalLinks";

const urls = (text: string) => findTerminalLinks(text).map((link) => link.url);
const texts = (text: string) => findTerminalLinks(text).map((link) => link.text);
// Invisible and combining characters are built from code points so the
// source itself never contains them.
const ACUTE = String.fromCodePoint(0x301);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

describe("findTerminalLinks", () => {
  it("opens bare loopback servers over http and keeps explicit schemes", () => {
    expect(urls("  ➜  Local:   localhost:5173")).toEqual(["http://localhost:5173/"]);
    expect(urls("listening on 127.0.0.1:8080/api?x=1#top")).toEqual(["http://127.0.0.1:8080/api?x=1#top"]);
    expect(urls("bound to [::1]:3000")).toEqual(["http://[::1]:3000/"]);
    expect(urls("https://localhost:5173/")).toEqual(["https://localhost:5173/"]);
    expect(urls("http://127.0.0.1:4000/docs")).toEqual(["http://127.0.0.1:4000/docs"]);
    expect(urls("see https://example.com/a/b?q=1&r=2")).toEqual(["https://example.com/a/b?q=1&r=2"]);
    expect(urls("LOCALHOST:5173")).toEqual(["http://localhost:5173/"]);
  });

  it("reports the printed range, not the normalized one", () => {
    const [link] = findTerminalLinks("Local: localhost:5173/app.");
    expect(link).toMatchObject({ start: 7, end: 25, text: "localhost:5173/app", url: "http://localhost:5173/app" });
  });

  it("trims sentence punctuation but keeps balanced brackets", () => {
    expect(texts("Open localhost:5173.")).toEqual(["localhost:5173"]);
    expect(texts("(at http://localhost:3000/)")).toEqual(["http://localhost:3000/"]);
    expect(texts("ready at localhost:5173: press h")).toEqual(["localhost:5173"]);
    expect(texts("[docs](https://example.com/guide)")).toEqual(["https://example.com/guide"]);
    expect(texts("https://en.wikipedia.org/wiki/Vite_(software), ok")).toEqual(["https://en.wikipedia.org/wiki/Vite_(software)"]);
    expect(texts('"http://localhost:8000"')).toEqual(["http://localhost:8000"]);
    expect(texts("'http://localhost:8000/it's'")).toEqual(["http://localhost:8000/it's"]);
    expect(texts("<http://localhost:8000/>")).toEqual(["http://localhost:8000/"]);
    expect(texts("│http://localhost:8000│")).toEqual(["http://localhost:8000"]);
  });

  it("requires word boundaries", () => {
    expect(urls("mylocalhost:5173")).toEqual([]);
    expect(urls("app.localhost:5173")).toEqual([]);
    expect(urls("/srv/localhost:5173")).toEqual([]);
    expect(urls("user@localhost:22")).toEqual([]);
    expect(urls("10.127.0.0.1:80")).toEqual([]);
    expect(urls("xhttps://example.com")).toEqual([]);
    expect(urls("localhost:5173abc")).toEqual([]);
    expect(urls("--host=localhost:5173")).toEqual(["http://localhost:5173/"]);
  });

  it("rejects invalid ports and hosts", () => {
    expect(urls("localhost:0")).toEqual([]);
    expect(urls("localhost:65536")).toEqual([]);
    expect(urls("localhost:123456")).toEqual([]);
    expect(urls("localhost:")).toEqual([]);
    expect(urls("localhost:abc")).toEqual([]);
    expect(urls("localhost")).toEqual([]);
    expect(urls("http://localhost:99999/")).toEqual([]);
    expect(urls("http://")).toEqual([]);
    expect(urls("https://exa_mple.com")).toEqual([]);
    expect(urls("localhost:65535")).toEqual(["http://localhost:65535/"]);
  });

  it("never yields a non-http scheme or a disguised host", () => {
    expect(urls("javascript:alert(1)")).toEqual([]);
    expect(urls("file:///etc/passwd")).toEqual([]);
    expect(urls("ftp://localhost:21")).toEqual([]);
    expect(urls("vscode://localhost:5173")).toEqual([]);
    // Userinfo would read as localhost while opening example.com.
    expect(urls("http://localhost:3000@example.com/")).toEqual([]);
    expect(urls("http://user:pass@localhost:3000/")).toEqual([]);
  });

  it("finds several links on a line", () => {
    expect(urls("Local: http://localhost:5173/  Network: http://192.168.1.4:5173/")).toEqual([
      "http://localhost:5173/",
      "http://192.168.1.4:5173/",
    ]);
  });
});

describe("international links", () => {
  it("keeps Unicode paths and queries whole instead of opening a truncated address", () => {
    expect(findTerminalLinks("open http://localhost:5173/café?view=résumé now")).toEqual([{
      start: 5,
      end: 43,
      candidateEnd: 43,
      text: "http://localhost:5173/café?view=résumé",
      url: "http://localhost:5173/caf%C3%A9?view=r%C3%A9sum%C3%A9",
    }]);
    expect(urls("localhost:5173/日本語")).toEqual(["http://localhost:5173/%E6%97%A5%E6%9C%AC%E8%AA%9E"]);
    // A decomposed é is a base letter plus a combining mark.
    expect(urls(`localhost:5173/cafe${ACUTE}`)).toEqual(["http://localhost:5173/cafe%CC%81"]);
    expect(urls("http://localhost:5173/#section-ü")).toEqual(["http://localhost:5173/#section-%C3%BC"]);
  });

  it("opens international domains by their punycode name, which the hint shows", () => {
    expect(urls("http://münich.example/page")).toEqual(["http://xn--mnich-kva.example/page"]);
    expect(urls("https://例え.jp/")).toEqual(["https://xn--r8jz45g.jp/"]);
    // A Cyrillic look-alike cannot pass for the Latin name.
    expect(urls("https://аpple.com/")).toEqual(["https://xn--pple-43d.com/"]);
  });

  it("trims CJK sentence punctuation like Latin punctuation", () => {
    expect(texts("サーバー：http://localhost:5173/日本語。")).toEqual(["http://localhost:5173/日本語"]);
    expect(texts("（localhost:5173/設定）")).toEqual(["localhost:5173/設定"]);
    expect(texts("「http://localhost:3000」")).toEqual(["http://localhost:3000"]);
  });

  it("rejects a candidate whole when any part of it cannot be in a link", () => {
    for (const text of [
      "http://localhost:5173/a{b}",
      "localhost:5173/a|b",
      "http://localhost:5173/a\\b",
      `http://localhost:5173/x${RIGHT_TO_LEFT_OVERRIDE}y`,
      `http://localhost:5173/a${ZERO_WIDTH_SPACE}b`,
      "http://localhost:5173/➜x",
      "http://localhost:5173/🚀",
      "localhost:５１７３",
      "http://localhost:3000@例え.jp/",
    ]) {
      expect(findTerminalLinks(text), text).toEqual([]);
    }
  });

  it("treats letters and digits in any script as part of the preceding word", () => {
    for (const text of ["élocalhost:5173", "日本localhost:5173", "аhttp://example.com", "Ⅷhttp://example.com", "𝒜localhost:5173", `e${ACUTE}localhost:5173`]) {
      expect(findTerminalLinks(text), text).toEqual([]);
    }
    expect(urls("→localhost:5173")).toEqual(["http://localhost:5173/"]);
  });
});

describe("normalizeTerminalLink", () => {
  it("validates a complete target", () => {
    expect(normalizeTerminalLink("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeTerminalLink("https://example.com")).toBe("https://example.com/");
    expect(normalizeTerminalLink("https://example.com evil")).toBeNull();
    expect(normalizeTerminalLink("javascript:alert(1)")).toBeNull();
    expect(normalizeTerminalLink("data:text/html,hi")).toBeNull();
    expect(normalizeTerminalLink("http://localhost:3000@example.com")).toBeNull();
    expect(normalizeTerminalLink("http://localhost:5173/café")).toBe("http://localhost:5173/caf%C3%A9");
    expect(normalizeTerminalLink(`http://localhost:5173/a${RIGHT_TO_LEFT_OVERRIDE}`)).toBeNull();
  });
});

/** A buffer of rows; `wrapped[i]` marks row i as a soft-wrapped continuation. */
function buffer(rows: string[], wrapped: boolean[] = [], columns = 20): TerminalBufferReader {
  return {
    getLine: (y) => {
      if (y < 0 || y >= rows.length) return undefined;
      const cells = [...rows[y]];
      return {
        isWrapped: Boolean(wrapped[y]),
        length: columns,
        getCell: (x) => x >= columns ? undefined : {
          getChars: () => cells[x] ?? "",
          getWidth: () => 1,
        },
      };
    },
  };
}

type Cell = [chars: string, width: number];

/** Cells as xterm stores them: wide CJK characters take two (the second
 * empty, width 0) and combining marks join the preceding cell. */
function cellsOf(text: string): Cell[] {
  const cells: Cell[] = [];
  for (const character of text) {
    if (/\p{M}/u.test(character) && cells.length) cells[cells.length - 1][0] += character;
    else if (/[　-鿿]/u.test(character)) cells.push([character, 2], ["", 0]);
    else cells.push([character, 1]);
  }
  return cells;
}

function cellBuffer(rows: Cell[][], wrapped: boolean[], columns: number): TerminalBufferReader {
  return {
    getLine: (y) => rows[y] && {
      isWrapped: Boolean(wrapped[y]),
      length: columns,
      getCell: (x) => {
        if (x >= columns) return undefined;
        const [chars, width] = rows[y][x] ?? ["", 1];
        return { getChars: () => chars, getWidth: () => width };
      },
    },
  };
}

describe("linksAtBufferRow", () => {
  it("maps a link to 1-based inclusive cells", () => {
    const reader = buffer(["Local: localhost:51", "73/ ok"], [false, false], 19);
    const [link] = linksAtBufferRow(reader, 0);
    expect(link.url).toBe("http://localhost:51/");
    expect(link.range).toEqual({ start: { x: 8, y: 1 }, end: { x: 19, y: 1 } });
  });

  it("joins a URL that the terminal soft-wrapped across rows", () => {
    const rows = ["go http://localhost:", "5173/some/long/path", " now"];
    const reader = buffer(rows, [false, true, true], 20);
    for (const row of [0, 1]) {
      const links = linksAtBufferRow(reader, row);
      expect(links).toHaveLength(1);
      expect(links[0].url).toBe("http://localhost:5173/some/long/path");
      expect(links[0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: 19, y: 2 } });
    }
    expect(linksAtBufferRow(reader, 2)).toEqual([]);
  });

  it("does not join across a hard line break", () => {
    const reader = buffer(["go http://localhost:", "5173/"], [false, false], 20);
    expect(linksAtBufferRow(reader, 0).map((link) => link.url)).toEqual(["http://localhost/"]);
    expect(linksAtBufferRow(reader, 1)).toEqual([]);
  });

  it("accounts for wide characters before a link", () => {
    // "界" occupies cells 0-1; the link starts at cell 3.
    const [link] = linksAtBufferRow(cellBuffer([cellsOf("界 localhost:80")], [false], 20), 0);
    expect(link.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 15, y: 1 } });
  });

  it("maps wide and combining characters inside a link to their cells", () => {
    // "localhost:81/" is cells 0-12, 日 13-14, 本 15-16, e + combining acute 17.
    const reader = cellBuffer([cellsOf(`localhost:81/日本e${ACUTE} ok`)], [false], 24);
    const [link] = linksAtBufferRow(reader, 0);
    expect(link.text).toBe(`localhost:81/日本e${ACUTE}`);
    expect(link.url).toBe("http://localhost:81/%E6%97%A5%E6%9C%ACe%CC%81");
    expect(link.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 18, y: 1 } });
  });

  it("joins a wrap left early by a wide character that did not fit", () => {
    // 19 cells of text, then an unwritten cell where 日 could not fit.
    const reader = cellBuffer([cellsOf("go localhost:81/abc"), cellsOf("日本 ok")], [false, true], 20);
    for (const row of [0, 1]) {
      const [link] = linksAtBufferRow(reader, row);
      expect(link.url).toBe("http://localhost:81/abc%E6%97%A5%E6%9C%AC");
      expect(link.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 4, y: 2 } });
    }
  });

  it("returns nothing for a missing row", () => {
    expect(linksAtBufferRow(buffer([]), 4)).toEqual([]);
  });
});
