import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, EFFORT_SLIDER_STYLES, sanitizeAutoArchiveSubagentThreads, sanitizeEffortSlider, sanitizeTheme, themeColorScheme, THEMES } from "./appConfig";

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

  it("migrates retired Ember and Terminal selections to Mythra", () => {
    expect(sanitizeTheme("ember")).toBe("mythra");
    expect(sanitizeTheme("terminal")).toBe("mythra");
    expect(sanitizeTheme("light-mythra")).toBe("light-mythra");
  });

  it("marks both branded light palettes for shared light component styling", () => {
    expect(themeColorScheme("light-mythra")).toBe("light");
    expect(themeColorScheme("daylight")).toBe("light");
    expect(themeColorScheme("mythra")).toBe("dark");
    expect(themeColorScheme("kiwi")).toBe("dark");
  });
});

describe("effort slider catalog", () => {
  it("registers every style exactly once, with a name and a description", () => {
    const ids = EFFORT_SLIDER_STYLES.map((style) => style.id);
    expect(ids).toEqual(["aurora", "spectrum", "classic", "neon", "pixel", "ink", "tide", "dart", "coil"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EFFORT_SLIDER_STYLES.every((style) => style.name.length > 0 && style.description.length > 0)).toBe(true);
  });

  it("persists the newest styles and still falls back for unknown ones", () => {
    expect(sanitizeEffortSlider("tide")).toBe("tide");
    expect(sanitizeEffortSlider("dart")).toBe("dart");
    expect(sanitizeEffortSlider("coil")).toBe("coil");
    expect(sanitizeEffortSlider("tidal")).toBe(DEFAULT_SETTINGS.effortSlider);
    expect(sanitizeEffortSlider(undefined)).toBe(DEFAULT_SETTINGS.effortSlider);
  });

  it("migrates a saved Shard selection directly to Tide", () => {
    expect(sanitizeEffortSlider("shard")).toBe("tide");
  });
});

describe("sub-agent cleanup defaults", () => {
  it("archives automatically unless the user explicitly turned it off", () => {
    expect(DEFAULT_SETTINGS.autoArchiveSubagentThreads).toBe(true);
    expect(sanitizeAutoArchiveSubagentThreads(undefined)).toBe(true);
    expect(sanitizeAutoArchiveSubagentThreads("invalid")).toBe(true);
    expect(sanitizeAutoArchiveSubagentThreads(true)).toBe(true);
    expect(sanitizeAutoArchiveSubagentThreads(false)).toBe(false);
  });
});
