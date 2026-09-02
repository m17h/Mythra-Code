import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: core.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { ChatTimeline } from "./ChatTimeline";

function renderImage(path = "/Users/morgan/Desktop/reference.png") {
  return render(<ChatTimeline
    messages={[{
      id: "image-prompt",
      role: "user",
      text: "Use this reference",
      attachments: [{ path, name: "reference.png", kind: "image" }],
    }]}
    activities={[]}
    running={false}
    thinkingLabel="Working"
    provider="claude"
  />);
}

describe("native historical image previews", () => {
  beforeEach(() => {
    core.invoke.mockReset();
  });

  it("authorizes a local path before exposing it to the asset protocol", async () => {
    core.invoke.mockResolvedValue(undefined);
    renderImage();

    expect(screen.getByRole("img", { name: "Loading attached image: reference.png" })).toBeInTheDocument();
    await waitFor(() => expect(core.invoke).toHaveBeenCalledWith("prepare_image_preview", {
      path: "/Users/morgan/Desktop/reference.png",
    }));
    expect(await screen.findByRole("img", { name: "Attached image: reference.png" }))
      .toHaveAttribute("src", "asset://localhost/%2FUsers%2Fmorgan%2FDesktop%2Freference.png");
  });

  it("shows the contained fallback when the original file no longer exists", async () => {
    core.invoke.mockRejectedValue(new Error("missing"));
    const view = renderImage();

    await waitFor(() => expect(view.container.querySelector(".message-image-preview.unavailable")).not.toBeNull());
    expect(view.container.querySelector(".message-image-preview.unavailable")).toHaveTextContent("reference.png");
  });
});
