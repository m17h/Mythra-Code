import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../styles.css";
import { ThreadProviderControl } from "./ThreadProviderControl";

function providerMark(openAiLogo: "openai" | "codex", colorScheme: "light" | "dark") {
  const view = render(
    <div
      className="app-shell"
      data-theme={colorScheme === "light" ? "light-mythra" : "mythra"}
      data-color-scheme={colorScheme}
      data-openai-logo={openAiLogo}
    >
      <ThreadProviderControl
        provider="openai"
        defaultProvider="openai"
        threadStarted={false}
        onProvider={() => undefined}
        onDefaultSettings={() => undefined}
      />
    </div>,
  );

  return view.container.querySelector<HTMLElement>(".provider-pill .provider-mark.openai")!;
}

describe("ThreadProviderControl theme styling", () => {
  it("uses a white prompt-bar tile for the Codex logo in light themes", () => {
    expect(getComputedStyle(providerMark("codex", "light")).backgroundColor).toBe("rgb(255, 255, 255)");
  });

  it("keeps the standard OpenAI logo and dark themes on a dark tile", () => {
    expect(getComputedStyle(providerMark("openai", "light")).backgroundColor).toBe("rgb(26, 29, 24)");
    expect(getComputedStyle(providerMark("codex", "dark")).backgroundColor).toBe("rgb(26, 29, 24)");
  });
});
