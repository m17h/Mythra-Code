import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateDeveloperRuntime } from "../lib/runtimeUpdates";
import { useDeveloperRuntimeUpdater } from "./SettingsModal";

vi.mock("../lib/runtimeUpdates", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/runtimeUpdates")>();
  return {
    ...original,
    cachedDeveloperRuntimeUpdates: vi.fn(() => null),
    updateDeveloperRuntime: vi.fn(),
  };
});

const status = {
  checkedAt: 1,
  claude: {
    installed: true,
    currentVersion: "2.1.257",
    latestVersion: "2.1.257",
    updateAvailable: false,
    canUpdate: true,
    source: "Native installer",
    error: null,
  },
  codex: {
    installed: true,
    currentVersion: "0.152.0",
    latestVersion: "0.152.0",
    updateAvailable: false,
    canUpdate: true,
    source: "Codex CLI",
    error: null,
  },
};

describe("useDeveloperRuntimeUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a successful Claude update successful when the catalog refresh fails", async () => {
    vi.mocked(updateDeveloperRuntime).mockResolvedValue({
      status,
      message: "Claude Code updated successfully.",
      restartRequired: false,
    });
    const refresh = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    const { result } = renderHook(() => useDeveloperRuntimeUpdater(refresh, false));

    await act(async () => {
      await result.current.updateRuntime("claude");
    });

    await waitFor(() => expect(result.current.updating).toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.status).toEqual(status);
    expect(result.current.message).toContain("Claude Code updated successfully.");
    expect(result.current.message).toContain("could not refresh its account and model catalog yet");
    expect(refresh).toHaveBeenCalledOnce();
  });
});
