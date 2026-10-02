import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, EFFORT_SLIDER_STYLES, sanitizeAutoArchiveSubagentThreads, sanitizeChatFont, sanitizeEffortSlider, sanitizeTheme, themeColorScheme, THEMES } from "./appConfig";

describe("theme catalog", () => {
  it("places the Mythra pair above the Kiwi pair", () => {
    expect(THEMES.slice(0, 4).map((theme) => [theme.id, theme.name])).toEqual([
      ["mythra", "Mythra"],
      ["light-mythra", "Light Mythra"],
      ["kiwi", "Kiwi"],
      ["daylight", "Light Kiwi"],
    ]);
    expect(DEFAULT_SETTINGS.theme).toBe("mythra");
  });

  it("offers exactly the supported palettes, each once", () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(["mythra", "light-mythra", "kiwi", "daylight", "synthwave", "atari"]);
    expect(THEMES.some((theme) => /midnight|monochrome/i.test(`${theme.id} ${theme.name}`))).toBe(false);
  });

  it.each(["ember", "terminal", "midnight", "monochrome"])("migrates a retired %s selection to Mythra", (retired) => {
    expect(sanitizeTheme(retired)).toBe("mythra");
  });

  it("keeps supported selections as saved", () => {
    for (const theme of THEMES) expect(sanitizeTheme(theme.id)).toBe(theme.id);
  });

  it("previews Synthwave on Mythra's neutral graphite and Light Mythra with a clear cyan", () => {
    const swatches = Object.fromEntries(THEMES.map((theme) => [theme.id, theme.swatches]));
    expect(swatches.synthwave.slice(0, 2)).toEqual(swatches.mythra.slice(0, 2));
    expect(swatches.synthwave[2]).toBe("#ff6ac1");
    expect(swatches["light-mythra"][2]).not.toBe("#0880a3");
  });

  it("marks both branded light palettes for shared light component styling", () => {
    expect(themeColorScheme("light-mythra")).toBe("light");
    expect(themeColorScheme("daylight")).toBe("light");
    expect(themeColorScheme("mythra")).toBe("dark");
    expect(themeColorScheme("kiwi")).toBe("dark");
  });

  it("registers and restores Atari and Synthwave with the correct color schemes", () => {
    for (const id of ["atari", "synthwave"] as const) {
      expect(THEMES.filter((theme) => theme.id === id)).toHaveLength(1);
      expect(sanitizeTheme(id)).toBe(id);
    }
    expect(themeColorScheme("atari")).toBe("light");
    expect(themeColorScheme("synthwave")).toBe("dark");
  });
});

describe("effort slider catalog", () => {
  it("retires Dart and migrates saved selections to its registered replacement", () => {
    const replacement = sanitizeEffortSlider("dart");
    expect(EFFORT_SLIDER_STYLES.some((style) => String(style.id) === "dart" || style.name === "Dart")).toBe(false);
    expect(replacement).not.toBe("dart");
    expect(replacement).not.toBe(DEFAULT_SETTINGS.effortSlider);
    expect(EFFORT_SLIDER_STYLES.some((style) => style.id === replacement)).toBe(true);
  });

  it("registers every style exactly once, with a name and a description", () => {
    const ids = EFFORT_SLIDER_STYLES.map((style) => style.id);
    expect(ids).toEqual(["aurora", "astra", "spectrum", "classic", "neon", "pixel", "ink", "reactor", "comet", "coil"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EFFORT_SLIDER_STYLES.every((style) => style.name.length > 0 && style.description.length > 0)).toBe(true);
  });

  it("persists the newest styles and still falls back for unknown ones", () => {
    expect(sanitizeEffortSlider("astra")).toBe("astra");
    expect(sanitizeEffortSlider("reactor")).toBe("reactor");
    expect(sanitizeEffortSlider("dart")).toBe("comet");
    expect(sanitizeEffortSlider("filament")).toBe("comet");
    expect(sanitizeEffortSlider("comet")).toBe("comet");
    expect(sanitizeEffortSlider("coil")).toBe("coil");
    expect(sanitizeEffortSlider("tidal")).toBe(DEFAULT_SETTINGS.effortSlider);
    expect(sanitizeEffortSlider(undefined)).toBe(DEFAULT_SETTINGS.effortSlider);
  });

  it("migrates a saved Shard selection directly to Reactor", () => {
    expect(sanitizeEffortSlider("shard")).toBe("reactor");
    expect(sanitizeEffortSlider("tide")).toBe("reactor");
  });
});

describe("chat typeface catalog", () => {
  it("defaults to the existing interface typeface", () => {
    expect(DEFAULT_SETTINGS.chatFont).toBe("system");
  });

  it("leaves settings saved before the selector on the interface default", () => {
    expect(sanitizeChatFont(undefined)).toBe("system");
    expect(sanitizeChatFont(null)).toBe("system");
    expect(sanitizeChatFont("Comic Sans MS")).toBe("system");
    expect(sanitizeChatFont({ id: "serif" })).toBe("system");
    expect(sanitizeChatFont("humanist")).toBe("humanist");
    expect(sanitizeChatFont("serif")).toBe("serif");
    expect(sanitizeChatFont("mono")).toBe("mono");
  });
});

describe("sub-agent cleanup defaults", () => {
  it("keeps conversations visible unless the user explicitly enables archiving", () => {
    expect(DEFAULT_SETTINGS.autoArchiveSubagentThreads).toBe(false);
    expect(sanitizeAutoArchiveSubagentThreads(undefined)).toBe(false);
    expect(sanitizeAutoArchiveSubagentThreads("invalid")).toBe(false);
    expect(sanitizeAutoArchiveSubagentThreads(true)).toBe(true);
    expect(sanitizeAutoArchiveSubagentThreads(false)).toBe(false);
  });
});
