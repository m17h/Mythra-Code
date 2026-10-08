import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { installLanguageTool, languageToolsSnapshot, listenLanguageToolsChanged, refreshLanguageTools, setLanguageToolEnabled, setLanguageToolsAutoInstall } from "./languageTools";

describe("language tool IPC", () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.listen.mockReset(); });

  it("uses the native snapshot and exact command argument names", async () => {
    const snapshot = { autoInstall: true, tools: [] };
    mocks.invoke.mockResolvedValue(snapshot);
    expect(await languageToolsSnapshot()).toBe(snapshot);
    expect(mocks.invoke).toHaveBeenLastCalledWith("language_tools_snapshot");
    expect(await refreshLanguageTools()).toBe(snapshot);
    expect(mocks.invoke).toHaveBeenLastCalledWith("language_tools_refresh");
    expect(await setLanguageToolsAutoInstall(false)).toBe(snapshot);
    expect(mocks.invoke).toHaveBeenLastCalledWith("language_tools_set_auto_install", { enabled: false });
    expect(await installLanguageTool("typescript")).toBe(snapshot);
    expect(mocks.invoke).toHaveBeenLastCalledWith("language_tools_install", { id: "typescript" });
    expect(await setLanguageToolEnabled("python", false)).toBe(snapshot);
    expect(mocks.invoke).toHaveBeenLastCalledWith("language_tools_set_enabled", { id: "python", enabled: false });
  });

  it("subscribes to native changes and returns listener cleanup", async () => {
    const changed = vi.fn();
    const cleanup = vi.fn();
    mocks.listen.mockResolvedValue(cleanup);
    expect(await listenLanguageToolsChanged(changed)).toBe(cleanup);
    expect(mocks.listen).toHaveBeenCalledWith("language-tools-changed", expect.any(Function));
    const listener = mocks.listen.mock.calls[0][1];
    listener({ payload: { generation: 4 } });
    expect(changed).toHaveBeenLastCalledWith(4);
    listener({ payload: null });
    expect(changed).toHaveBeenLastCalledWith(undefined);
    listener({ payload: { generation: "4" } });
    expect(changed).toHaveBeenLastCalledWith(undefined);
  });
});
