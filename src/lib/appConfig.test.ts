import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeTheme, themeColorScheme, THEMES } from "./appConfig";

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
