import { describe, expect, it } from "vitest";
import { primaryModifierLabel, primaryModifierPressed } from "./platform";

describe("platform shortcuts", () => {
  it("uses Command on macOS", () => {
    expect(primaryModifierLabel("MacIntel")).toBe("⌘");
    expect(primaryModifierPressed({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(primaryModifierPressed({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
  });

  it("uses Control on Windows", () => {
    expect(primaryModifierLabel("Win32")).toBe("Ctrl");
    expect(primaryModifierPressed({ metaKey: false, ctrlKey: true }, "Win32")).toBe(true);
    expect(primaryModifierPressed({ metaKey: true, ctrlKey: false }, "Win32")).toBe(false);
  });
});
