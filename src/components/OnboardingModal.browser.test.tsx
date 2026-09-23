import type { CSSProperties } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { OnboardingModal } from "./OnboardingModal";
import "../styles.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

function OnboardingFixture({ scheme = "dark", scale = 1, open = true, hostSliderStyle = "classic" }: { scheme?: "dark" | "light"; scale?: number; open?: boolean; hostSliderStyle?: "classic" | "coil" }) {
  return (
    <div
      className="app-shell"
      data-theme={scheme === "dark" ? "mythra" : "light-mythra"}
      data-color-scheme={scheme}
      data-chat-font="system"
      data-effort-slider={open ? undefined : hostSliderStyle}
      data-onboarding-effort-slider={open ? hostSliderStyle : undefined}
      style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}
    >
      <OnboardingModal
        open={open}
        runtimeStatus={{ available: true, source: "Codex CLI", path: "/usr/local/bin/codex", version: "1.0.0", compatible: true, warning: null }}
        account={null}
        openRouterReady={false}
        skillsFolder=""
        onComplete={vi.fn()}
        onOpenSettings={vi.fn()}
        onChooseSkillsFolder={vi.fn()}
        onAddProject={vi.fn(async () => false)}
        onStartChat={vi.fn()}
      />
    </div>
  );
}

function renderOnboarding(scheme: "dark" | "light" = "dark", scale = 1) {
  return render(<OnboardingFixture scheme={scheme} scale={scale} />);
}

beforeEach(async () => { await commands.setStreamTestReducedMotion(true); });
afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

describe("onboarding keyboard behavior in a real browser", () => {
  it("lets the appearance slider consume arrow keys without changing steps", async () => {
    renderOnboarding();
    await userEvent.click(screen.getByRole("button", { name: "Make it yours" }));

    const heading = screen.getByRole("heading", { name: "Make it feel like yours." });
    await waitFor(() => expect(heading).toHaveFocus());
    const slider = screen.getByRole("slider", { name: "Preview reasoning effort" }) as HTMLInputElement;
    slider.focus();
    const before = Number(slider.value);
    await userEvent.keyboard("{ArrowRight}");

    expect(screen.getByRole("slider", { name: "Preview reasoning effort" })).toBeInTheDocument();
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuetext", "Extra high"));
    await waitFor(() => expect(Number(slider.value)).toBeGreaterThan(before));
    expect(heading).toBeInTheDocument();
  });

  it("keeps provider radio arrows inside their group", async () => {
    renderOnboarding();
    const group = screen.getByRole("radiogroup", { name: "AI provider" });
    const chatgpt = group.querySelector<HTMLElement>('[role="radio"][aria-label="ChatGPT"]')!;
    chatgpt.focus();
    await userEvent.keyboard("{ArrowRight}");

    const claude = group.querySelector<HTMLElement>('[role="radio"][aria-label="Claude"]')!;
    expect(claude).toHaveFocus();
    expect(claude).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("heading", { name: "Welcome to Mythra Code" })).toBeInTheDocument();
  });

  it("keeps the preview slider style independent of the app shell style", async () => {
    const view = render(<OnboardingFixture hostSliderStyle="coil" />);
    await userEvent.click(screen.getByRole("button", { name: "Make it yours" }));
    await userEvent.click(screen.getByRole("button", { name: "Next slider style" }));

    const previewShell = view.container.querySelector<HTMLElement>(".ob-effort-shell")!;
    const slider = screen.getByRole("slider", { name: "Preview reasoning effort" });
    expect(previewShell).toHaveAttribute("data-effort-slider", "aurora");
    expect(Number.parseFloat(getComputedStyle(slider).height)).toBeLessThan(10);
  });

  it("keeps the selected theme accent inside the slider preview", async () => {
    const view = renderOnboarding();
    await userEvent.click(screen.getByRole("button", { name: "Make it yours" }));
    const preview = view.container.querySelector<HTMLElement>(".ob-preview")!;
    const previewShell = view.container.querySelector<HTMLElement>(".ob-effort-shell")!;
    const hostShell = view.container.firstElementChild as HTMLElement;
    const accents = new Set<string>();
    for (const name of ["Mythra", "Light Mythra", "Kiwi", "Light Kiwi", "Midnight", "Synthwave"]) {
      await userEvent.click(screen.getByRole("radio", { name }));
      const accent = getComputedStyle(preview).getPropertyValue("--ob-pv-accent").trim();
      accents.add(accent);
      expect(getComputedStyle(previewShell).getPropertyValue("--green").trim()).toBe(accent);
      expect(hostShell).toHaveAttribute("data-theme", "mythra");
    }
    expect(accents.size).toBe(6);
  });

  it("cycles through ten distinct slider looks without changing the host style", async () => {
    const view = render(<OnboardingFixture hostSliderStyle="coil" />);
    await userEvent.click(screen.getByRole("button", { name: "Make it yours" }));
    const previewShell = view.container.querySelector<HTMLElement>(".ob-effort-shell")!;
    const hostShell = view.container.firstElementChild as HTMLElement;
    const slider = screen.getByRole("slider", { name: "Preview reasoning effort" });
    const next = screen.getByRole("button", { name: "Next slider style" });
    const ids = new Set<string>();
    const looks = new Set<string>();

    for (let index = 0; index < 10; index++) {
      ids.add(previewShell.dataset.effortSlider ?? "");
      const inputStyle = getComputedStyle(slider);
      looks.add([inputStyle.height, inputStyle.borderRadius, inputStyle.backgroundImage, inputStyle.boxShadow].join("|"));
      await userEvent.click(next);
    }

    expect(ids.size).toBe(10);
    expect(looks.size).toBeGreaterThanOrEqual(7);
    expect(previewShell).toHaveAttribute("data-effort-slider", "coil");
    expect(hostShell).not.toHaveAttribute("data-effort-slider");
  });
});

describe("onboarding motion", () => {
  it("disables page, aurora, and slider motion when reduced motion is requested", async () => {
    const view = renderOnboarding();
    const dialog = screen.getByRole("dialog", { name: "Mythra Code onboarding" });
    expect(dialog.getAnimations({ subtree: true })).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Make it yours" }));
    expect(dialog.getAnimations({ subtree: true })).toHaveLength(0);
    expect(getComputedStyle(view.container.querySelector<HTMLElement>(".ob-page")!).animationName).toBe("none");
  });

  it("closes and reopens with a visible state change in normal motion", async () => {
    await commands.setStreamTestReducedMotion(false);
    const view = renderOnboarding();
    const backdrop = view.container.querySelector<HTMLElement>(".onboarding-backdrop")!;
    expect(getComputedStyle(backdrop).visibility).toBe("visible");

    view.rerender(<OnboardingFixture open={false} />);
    expect(backdrop.inert).toBe(true);
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(getComputedStyle(backdrop).visibility).toBe("hidden"), { timeout: 1200 });

    view.rerender(<OnboardingFixture open />);
    await waitFor(() => expect(getComputedStyle(backdrop).visibility).toBe("visible"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Welcome to Mythra Code" })).toHaveFocus());
  });
});

describe("onboarding layout in a real browser", () => {
  it("gives the welcome logo breathing room without repeating the greeting", () => {
    const view = renderOnboarding();
    const hero = view.container.querySelector<HTMLElement>(".ob-hero")!;
    const glyph = hero.querySelector<HTMLElement>(".ob-glyph")!;
    expect(glyph.getBoundingClientRect().top - hero.getBoundingClientRect().top).toBeGreaterThanOrEqual(12);
    expect(screen.queryByText("Welcome", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome to Mythra Code" })).toBeInTheDocument();
  });

  it.each(["dark", "light"] as const)("keeps every page and its footer reachable at 980×680 and 150%% scale in %s mode", async (scheme) => {
    await page.viewport(980, 680);
    const view = renderOnboarding(scheme, 1.5);
    const dialog = screen.getByRole("dialog", { name: "Mythra Code onboarding" });
    const stepper = screen.getByRole("navigation", { name: "Onboarding progress" });
    const stages = ["Connect AI", "Projects & chats", "Direct the work", "Make it yours", "Ready"];

    for (const [index, label] of stages.entries()) {
      if (index) await userEvent.click(screen.getByRole("button", { name: label }));
      const stage = dialog.querySelector<HTMLElement>(".ob-stage")!;
      const footer = dialog.querySelector<HTMLElement>(".ob-footer")!;
      const heading = stage.querySelector<HTMLHeadingElement>("h2")!;
      const dialogRect = dialog.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();

      await waitFor(() => expect(heading).toHaveFocus());
      expect(stepper.querySelectorAll("button")).toHaveLength(stages.length);
      expect(dialogRect.left).toBeGreaterThanOrEqual(-1);
      expect(dialogRect.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(dialogRect.top).toBeGreaterThanOrEqual(-1);
      expect(dialogRect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth + 1);
      expect(footerRect.top, `${label}: grid rows ${getComputedStyle(dialog).gridTemplateRows}`).toBeGreaterThanOrEqual(stageRect.bottom - 1);
      expect(footerRect.bottom).toBeLessThanOrEqual(dialogRect.bottom + 1);
      for (const button of footer.querySelectorAll<HTMLButtonElement>("button:not([disabled])")) {
        const rect = button.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(dialogRect.left - 1);
        expect(rect.right).toBeLessThanOrEqual(dialogRect.right + 1);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      }

      // Scrolling the page body must reveal its last row without moving the footer.
      stage.scrollTop = stage.scrollHeight;
      const last = stage.querySelector<HTMLElement>(".ob-page")!.lastElementChild as HTMLElement;
      expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(stageRect.bottom + 1);
      expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    }

    view.unmount();
  });
});
