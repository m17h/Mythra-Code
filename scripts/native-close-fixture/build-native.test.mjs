import { describe, expect, it } from "vitest";
import { assertCoreLockMatches } from "./build-native.mjs";
import { spawnSync } from "node:child_process";

const names = ["tauri", "tauri-runtime", "tauri-runtime-wry", "wry", "tauri-plugin-dialog", "webview2-com"];
const lock = names.map((name) => `[[package]]\nname = "${name}"\nversion = "1.2.3"\n`).join("\n");

describe("isolated native fixture lock provenance", () => {
  it("prints harmless help without building", () => {
    const result = spawnSync(process.execPath, ["scripts/native-close-fixture/build-native.mjs", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage:/);
    expect(result.stderr).toBe("");
  });
  it("accepts matching production core versions", () => {
    expect(() => assertCoreLockMatches(lock, lock, true)).not.toThrow();
  });
  it("rejects a newer fixture core dependency", () => {
    expect(() => assertCoreLockMatches(lock, lock.replace('name = "wry"\nversion = "1.2.3"', 'name = "wry"\nversion = "1.2.4"'), true)).toThrow(/wry/);
  });
  it("rejects missing core dependencies", () => {
    expect(() => assertCoreLockMatches(lock, "", true)).toThrow(/tauri/);
  });
});
