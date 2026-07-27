import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { onCodexEvent } from "./codex";

describe("Codex event subscriptions", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it("cleans up the first listener when the batched listener cannot subscribe", async () => {
    const stopSingle = vi.fn();
    listen
      .mockResolvedValueOnce(stopSingle)
      .mockRejectedValueOnce(new Error("batched listener unavailable"));

    await expect(onCodexEvent(vi.fn())).rejects.toThrow("batched listener unavailable");
    expect(stopSingle).toHaveBeenCalledOnce();
  });

  it("cleans up both listeners after a successful subscription", async () => {
    const stopSingle = vi.fn();
    const stopBatched = vi.fn();
    listen.mockResolvedValueOnce(stopSingle).mockResolvedValueOnce(stopBatched);

    const stop = await onCodexEvent(vi.fn());
    stop();

    expect(stopSingle).toHaveBeenCalledOnce();
    expect(stopBatched).toHaveBeenCalledOnce();
  });
});
