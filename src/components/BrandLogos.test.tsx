import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClaudeLogo, ProviderLogo } from "./BrandLogos";

describe("BrandLogos", () => {
  it("keeps the Claude glyph white regardless of inherited theme color", () => {
    const { container } = render(
      <div style={{ color: "black" }}>
        <ClaudeLogo />
      </div>,
    );

    expect(container.querySelector("svg")).toHaveAttribute("fill", "#fff");
  });

  it("uses a routing mark for OpenRouter instead of an unrelated sparkle", () => {
    const { container } = render(<ProviderLogo provider="openrouter" />);
    expect(container.querySelector(".lucide-route")).toBeInTheDocument();
    expect(container.querySelector(".lucide-sparkles")).not.toBeInTheDocument();
  });
});
