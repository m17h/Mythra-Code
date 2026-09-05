import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AnthropicLogo, ClaudeLogo, CodexLogo, CursorLogo, OpenAILogo, OpenRouterLogo } from "./BrandLogos";

it("renders every bundled SVG symbol with nonempty geometry", async () => {
  const view = render(<div><AnthropicLogo /><ClaudeLogo /><CodexLogo /><CursorLogo /><OpenAILogo /><OpenRouterLogo /></div>);
  const uses = [...view.container.querySelectorAll("use")];
  expect(uses).toHaveLength(5);
  await vi.waitFor(() => {
    for (const use of uses) {
      expect(use.getBBox().width).toBeGreaterThan(0);
      expect(use.getBBox().height).toBeGreaterThan(0);
    }
  });
  const response = await fetch("/provider-marks.svg");
  expect(response.ok).toBe(true);
  const sprite = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
  expect(sprite.querySelector("parsererror")).toBeNull();
  for (const use of uses) expect(sprite.getElementById(use.getAttribute("href")!.split("#")[1])).not.toBeNull();

  view.unmount();
});


it("paints both the Codex colored cloud and white terminal pixels", async () => {
  const view = render(<div><CodexLogo /><CodexLogo /></div>);
  for (const img of view.container.querySelectorAll("img")) {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0, 96, 96);
    const pixels = context.getImageData(0, 0, 96, 96).data;
    let colored = 0, white = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 200) continue;
      if (pixels[i + 2] > 180 && pixels[i + 2] - pixels[i + 1] > 25) colored++;
      if (pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) white++;
    }
    expect(colored).toBeGreaterThan(3000);
    expect(white).toBeGreaterThan(200);
  }
});
