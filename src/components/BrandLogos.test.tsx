import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnthropicLogo, ClaudeLogo, CodexLogo, OpenAILogo, ProviderLogo } from "./BrandLogos";

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

  it("provides both selectable OpenAI and Codex marks for OpenAI providers", () => {
    const { container } = render(<ProviderLogo provider="openai" />);
    expect(container.querySelector(".openai-logo-option")).toBeInTheDocument();
    expect(container.querySelector(".codex-logo-option")).toBeInTheDocument();
  });

  it("keeps the standard OpenAI mark white", () => {
    const { container } = render(<OpenAILogo />);
    expect(container.querySelector("svg")).toHaveAttribute("fill", "#fff");
  });

  it("provides both selectable Claude and Anthropic marks for Claude providers", () => {
    const { container } = render(<ProviderLogo provider="claude" />);
    expect(container.querySelector(".claude-logo-option")).toBeInTheDocument();
    expect(container.querySelector(".anthropic-logo-option")).toBeInTheDocument();
  });

  it("provides both official Cursor cube and dark app-icon marks", () => {
    const { container } = render(<ProviderLogo provider="cursor" />);
    expect(container.querySelector(".cursor-cube-logo-option")).toBeInTheDocument();
    expect(container.querySelector(".cursor-dark-logo-option")).toHaveAttribute("src", "/cursor-app-icon-dark.png");
  });

  it("uses LM Studio's official app icon for its provider mark", () => {
    const { container } = render(<ProviderLogo provider="lmstudio" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/lm-studio-icon.svg");
  });

  it("renders the Anthropic AI monogram as a self-contained vector", () => {
    const { container } = render(<AnthropicLogo />);
    expect(container.querySelector("svg")).toHaveAttribute("fill", "currentColor");
    expect(container.querySelectorAll("path")).toHaveLength(2);
  });

  it("renders the Codex terminal-cloud mark as a self-contained vector", () => {
    const { container } = render(<CodexLogo />);
    expect(container.querySelector("linearGradient")).toBeInTheDocument();
    expect(container.querySelectorAll("path")).toHaveLength(2);
  });
});
