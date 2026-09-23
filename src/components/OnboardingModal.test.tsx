import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isEstablishedMythraCodeInstall } from "../lib/onboarding";
import { OnboardingModal } from "./OnboardingModal";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

type Props = Parameters<typeof OnboardingModal>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    runtimeStatus: { available: true, source: "Codex CLI", path: "/usr/local/bin/codex", version: "1.0.0", compatible: true, warning: null },
    account: null,
    openRouterReady: false,
    skillsFolder: "",
    onComplete: vi.fn(),
    onOpenSettings: vi.fn(),
    onChooseSkillsFolder: vi.fn(),
    onAddProject: vi.fn(async () => false),
    onStartChat: vi.fn(),
    ...overrides,
  };
}

function readyPage() {
  fireEvent.click(screen.getByRole("button", { name: "Ready" }));
}

describe("OnboardingModal", () => {
  it("starts from the saved provider even when another subscription is connected", () => {
    const input = props({ preferredProvider: "claude", account: { type: "chatgpt" } });
    render(<OnboardingModal {...input} />);
    expect(screen.getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(input.onOpenSettings).toHaveBeenCalledWith("models", { provider: "claude" });
  });

  it("carries the inspected provider into an unsaved Settings setup", () => {
    const input = props();
    render(<OnboardingModal {...input} />);
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    fireEvent.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(input.onOpenSettings).toHaveBeenCalledWith("models", { provider: "openrouter" });
    expect(input.onComplete).not.toHaveBeenCalled();
  });

  it("describes provider kind and readiness without requiring selection", () => {
    const input = props({ account: { type: "chatgpt" } });
    const { rerender } = render(<OnboardingModal {...input} />);
    expect(screen.getByRole("radio", { name: "ChatGPT" })).toHaveAccessibleDescription(/ChatGPT plan.*ChatGPT ready/);
    expect(screen.getByRole("radio", { name: "OpenRouter" })).toHaveAccessibleDescription(/API credits.*Add an OpenRouter API key/);
    rerender(<OnboardingModal {...input} openRouterReady />);
    expect(screen.getByRole("radio", { name: "OpenRouter" })).toHaveAccessibleDescription(/API credits.*OpenRouter ready/);
  });

  it("offers five steps and allows the tour to finish before a provider is ready", () => {
    const input = props();
    render(<OnboardingModal {...input} />);
    expect(screen.getByRole("heading", { name: "Welcome to Mythra Code" })).toBeInTheDocument();
    expect(screen.getByText("1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "AI provider" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Projects & chats" }));
    expect(screen.getByRole("heading", { name: "Work in a folder, or just talk." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Normal chat" }));
    expect(screen.getByText(/Saved under Normal chats with no folder attached/)).toBeInTheDocument();

    readyPage();
    expect(screen.getByRole("heading", { name: /provider to start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect a provider|Models & accounts/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    expect(input.onComplete).toHaveBeenCalledOnce();
  });

  it("shows checking and incompatible states before calling a saved key ready", () => {
    const input = props({ runtimeStatus: null, account: { type: "chatgpt" }, openRouterReady: true, lmStudioReady: true });
    const { rerender } = render(<OnboardingModal {...input} />);
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    expect(screen.getByText("Checking Codex runtime…")).toBeInTheDocument();

    rerender(<OnboardingModal {...input} runtimeStatus={{ available: true, source: "Codex CLI", path: "codex", version: "old", compatible: false, warning: "Update needed" }} />);
    expect(screen.getByText("Update Codex runtime")).toBeInTheDocument();

    rerender(<OnboardingModal {...input} runtimeStatus={{ available: true, source: "Codex CLI", path: "codex", version: "current", compatible: true, warning: null }} />);
    expect(screen.getByText("OpenRouter ready")).toBeInTheDocument();
    readyPage();
    expect(screen.getByRole("heading", { name: "You’re ready to build." })).toBeInTheDocument();
    expect(screen.getByText(/Connected: ChatGPT, OpenRouter, LM Studio/)).toBeInTheDocument();
  });

  it("resumes at the same page and focus after Settings without completing the tour", () => {
    const input = props();
    const { rerender } = render(<OnboardingModal {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Direct the work" }));
    const trigger = screen.getByRole("button", { name: "Crew presets" });
    fireEvent.click(trigger);
    expect(input.onOpenSettings).toHaveBeenCalledWith("agents");
    expect(input.onComplete).not.toHaveBeenCalled();

    rerender(<OnboardingModal {...input} open={false} />);
    rerender(<OnboardingModal {...input} open />);
    expect(screen.getByRole("heading", { name: "You decide how far it goes." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Direct the work" })).toHaveAttribute("aria-current", "step");
    expect(trigger).toHaveFocus();
    expect(input.onComplete).not.toHaveBeenCalled();
  });

  it("keeps Ready open after a cancelled project picker", async () => {
    const input = props({ onAddProject: vi.fn(async () => false) });
    render(<OnboardingModal {...input} />);
    readyPage();
    fireEvent.click(screen.getByRole("button", { name: /Open a project/ }));
    await waitFor(() => expect(input.onAddProject).toHaveBeenCalledOnce());
    expect(input.onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /provider to start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open a project/ })).toBeEnabled();
  });

  it("reports picker failure and completes once after a successful retry", async () => {
    let resolveProject: (added: boolean) => void = () => undefined;
    const onAddProject = vi.fn()
      .mockRejectedValueOnce(new Error("Folder unavailable"))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveProject = resolve; }));
    const input = props({ onAddProject });
    render(<OnboardingModal {...input} />);
    readyPage();

    fireEvent.click(screen.getByRole("button", { name: /Open a project/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder unavailable");
    expect(input.onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Open a project/ }));
    expect(screen.getByRole("button", { name: /Choosing a folder/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Choosing a folder/ }));
    expect(onAddProject).toHaveBeenCalledTimes(2);
    resolveProject(true);
    await waitFor(() => expect(input.onComplete).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("completes only once if the tour closes while the project picker is pending", async () => {
    let resolveProject: (added: boolean) => void = () => undefined;
    const onAddProject = vi.fn(() => new Promise<boolean>((resolve) => { resolveProject = resolve; }));
    const input = props({ onAddProject });
    const { rerender } = render(<OnboardingModal {...input} />);
    readyPage();

    fireEvent.click(screen.getByRole("button", { name: /Open a project/ }));
    expect(onAddProject).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    expect(input.onComplete).toHaveBeenCalledOnce();
    rerender(<OnboardingModal {...input} open={false} />);

    await act(async () => { resolveProject(true); });
    expect(input.onComplete).toHaveBeenCalledOnce();
  });

  it("leaves arrow keys to focused controls and consumes Escape in an open disclosure", () => {
    const input = props();
    render(<OnboardingModal {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Make it yours" }));
    const slider = screen.getByRole("slider", { name: "Preview reasoning effort" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Make it feel like yours." })).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuetext", "Extra high");
    expect(input.onComplete).not.toHaveBeenCalled();

    readyPage();
    const disclosure = screen.getByRole("button", { name: "Useful once you’re working" });
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(disclosure, { key: "Escape" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(input.onComplete).not.toHaveBeenCalled();
    const outside = document.createElement("button");
    document.body.append(outside);
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(input.onComplete).not.toHaveBeenCalled();
    outside.remove();
    fireEvent.keyDown(disclosure, { key: "Escape" });
    expect(input.onComplete).toHaveBeenCalledOnce();
  });

  it("keeps appearance changes in the preview and routes saved choices to Settings", () => {
    const input = props();
    const { container } = render(<div className="app-shell" data-theme="mythra" data-chat-font="system" data-effort-slider="classic"><OnboardingModal {...input} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Make it yours" }));
    fireEvent.click(screen.getByRole("radio", { name: "Light Kiwi" }));
    fireEvent.click(screen.getByRole("radio", { name: "Serif" }));
    fireEvent.click(screen.getByRole("button", { name: "Next slider style" }));
    expect(screen.getByText(/Preview only · not saved/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Light Kiwi" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Serif" })).toHaveAttribute("aria-checked", "true");
    expect(container.querySelector(".app-shell")?.getAttribute("data-theme")).toBe("mythra");
    expect(input.onOpenSettings).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector<HTMLButtonElement>(".ob-foot-row > button")!);
    expect(input.onOpenSettings).toHaveBeenCalledWith("general", { appearance: { theme: "daylight", chatFont: "serif", effortSlider: "neon" } });
    expect(input.onComplete).not.toHaveBeenCalled();
  });

  it("distinguishes empty and established installs", () => {
    expect(isEstablishedMythraCodeInstall({ projects: 0, knownThreads: 0, hasStoredSettings: false, hasSkillsFolder: false })).toBe(false);
    expect(isEstablishedMythraCodeInstall({ projects: 1, knownThreads: 0, hasStoredSettings: false, hasSkillsFolder: false })).toBe(true);
    expect(isEstablishedMythraCodeInstall({ projects: 0, knownThreads: 2, hasStoredSettings: false, hasSkillsFolder: false })).toBe(true);
    expect(isEstablishedMythraCodeInstall({ projects: 0, knownThreads: 0, hasStoredSettings: true, hasSkillsFolder: false })).toBe(true);
  });
});
