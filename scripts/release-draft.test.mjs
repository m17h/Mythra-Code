import { describe, expect, it } from "vitest";
import { combinePlatformManifests } from "./release-draft.mjs";

const mac = {
  version: "1.8.1",
  notes: "Approved cross-platform release notes",
  pub_date: "2026-08-22T23:00:00.000Z",
  platforms: { "darwin-aarch64": { signature: "mac-signature", url: "mac-url" } },
};
const windows = {
  version: "1.8.1",
  notes: "OpenKiwi for Windows 1.8.1",
  pub_date: "2026-08-23T00:00:00.000Z",
  platforms: { "windows-x86_64": { signature: "windows-signature", url: "windows-url" } },
};

describe("combinePlatformManifests", () => {
  it("preserves approved macOS copy when Windows attaches second", () => {
    expect(combinePlatformManifests(mac, windows)).toEqual({
      ...windows,
      notes: mac.notes,
      pub_date: mac.pub_date,
      platforms: { ...mac.platforms, ...windows.platforms },
    });
  });

  it("uses approved macOS copy when macOS attaches second", () => {
    expect(combinePlatformManifests(windows, mac)).toEqual({
      ...mac,
      notes: mac.notes,
      pub_date: mac.pub_date,
      platforms: { ...windows.platforms, ...mac.platforms },
    });
  });
});
