import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const status = {
  checkedAt: 1,
  codex: { installed: true, currentVersion: "0.151.0", latestVersion: "0.152.0", updateAvailable: true, canUpdate: true, source: "Codex CLI", error: null },
  claude: { installed: true, currentVersion: "2.1.250", latestVersion: "2.1.257", updateAvailable: true, canUpdate: true, source: "Native installer", error: null },
};

describe("developer runtime update cache", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
  });

  it("shares the automatic launch check instead of issuing duplicate requests", async () => {
    invokeMock.mockResolvedValue(status);
    const runtimeUpdates = await import("./runtimeUpdates");

    const [first, second] = await Promise.all([
      runtimeUpdates.ensureDeveloperRuntimeUpdates(),
      runtimeUpdates.ensureDeveloperRuntimeUpdates(),
    ]);
    expect(first).toEqual(status);
    expect(second).toEqual(status);
    expect(invokeMock).toHaveBeenCalledOnce();
    await runtimeUpdates.ensureDeveloperRuntimeUpdates();
    expect(invokeMock).toHaveBeenCalledOnce();

    await runtimeUpdates.checkDeveloperRuntimeUpdates();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("publishes the status returned by a completed update", async () => {
    invokeMock.mockResolvedValue({ status, message: "Updated", restartRequired: true });
    const runtimeUpdates = await import("./runtimeUpdates");

    await runtimeUpdates.updateDeveloperRuntime("codex");
    expect(invokeMock).toHaveBeenCalledWith("developer_runtime_update", { target: "codex" });
    expect(runtimeUpdates.cachedDeveloperRuntimeUpdates()).toEqual(status);
  });
});
