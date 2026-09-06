import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isEstablishedMythraCodeInstall } from "../lib/onboarding";
import { OnboardingModal } from "./OnboardingModal";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

function onboardingProps(overrides: Partial<Parameters<typeof OnboardingModal>[0]> = {}): Parameters<typeof OnboardingModal>[0] {
  return {
    open: true,
    runtimeStatus: { available: true, source: "Codex CLI", path: "/usr/local/bin/codex", version: "1.0.0", compatible: true, warning: null },
    account: null,
    openRouterReady: false,
    skillsFolder: "",
    onComplete: vi.fn(),
    onOpenSettings: vi.fn(),
    onChooseSkillsFolder: vi.fn(),
    onAddProject: vi.fn(),
    onStartChat: vi.fn(),
    ...overrides,
  };
}

describe("OnboardingModal", () => {
  it("starts with the product principles and advances through setup", () => {
    const { container } = render(<OnboardingModal {...onboardingProps()} />);
    expect(screen.getByRole("heading", { name: /transparent AI coding harness/i })).toBeInTheDocument();
    expect(screen.getByText("The base prompt starts empty")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("heading", { name: /Connect the models/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Codex CLI/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Create or sign in to OpenRouter/)).toBeInTheDocument();
    expect(container.querySelector(".onboarding-provider-card.openrouter svg")).toHaveAttribute("viewBox", "0 0 401.4 293.7");
  });

  it("explains the difference between project threads and normal chats", () => {
    render(<OnboardingModal {...onboardingProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /Projects & chats/ }));

    expect(screen.getByRole("heading", { name: /Projects know your folder/ })).toBeInTheDocument();
    expect(screen.getByText("Project threads")).toBeInTheDocument();
    expect(screen.getByText("Normal chats")).toBeInTheDocument();
    expect(screen.getByText(/Removing a project never deletes its folder/)).toBeInTheDocument();
  });

  it("describes local Markdown skills and can choose their folder", () => {
    const onChooseSkillsFolder = vi.fn();
    render(<OnboardingModal {...onboardingProps({ onChooseSkillsFolder })} />);
    fireEvent.click(screen.getByRole("button", { name: /Local skills/ }));

    expect(screen.getByRole("heading", { name: /Skills are local Markdown playbooks/ })).toBeInTheDocument();
    expect(screen.getByText(/Update the Markdown or change its Mythra Code invocation name/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(onChooseSkillsFolder).toHaveBeenCalledOnce();
  });

  it("completes onboarding before opening a selected destination", () => {
    const onComplete = vi.fn();
    const onOpenSettings = vi.fn();
    render(<OnboardingModal {...onboardingProps({ onComplete, onOpenSettings })} />);
    fireEvent.click(screen.getByRole("button", { name: /Ready to build/ }));
    fireEvent.click(screen.getByRole("button", { name: /Connect a provider/ }));

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledWith("models");
  });

  it("previews appearance without changing settings and explains model flexibility", () => {
    const props = onboardingProps();
    render(<OnboardingModal {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Make it yours/ }));
    const slider = screen.getByRole("slider", { name: "Preview slider animation speed" });
    fireEvent.change(slider, { target: { value: "90" } });
    expect(slider).toHaveValue("90");
    expect(props.onOpenSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("heading", { name: "Different models. One team." })).toBeInTheDocument();
    expect(screen.getByText(/independently of the parent model/)).toBeInTheDocument();
    expect(screen.getByText(/Change or clear an idle thread/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("heading", { name: "More than a chat window." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("heading", { name: "Different models. One team." })).toBeInTheDocument();
  });

  it("does not treat a genuinely empty install as established", () => {
    expect(isEstablishedMythraCodeInstall({ projects: 0, knownThreads: 0, hasStoredSettings: false, hasSkillsFolder: false })).toBe(false);
    expect(isEstablishedMythraCodeInstall({ projects: 1, knownThreads: 0, hasStoredSettings: false, hasSkillsFolder: false })).toBe(true);
    expect(isEstablishedMythraCodeInstall({ projects: 0, knownThreads: 2, hasStoredSettings: false, hasSkillsFolder: false })).toBe(true);
    expect(isEstablishedMythraCodeInstall({ projects: 0, knownThreads: 0, hasStoredSettings: true, hasSkillsFolder: false })).toBe(true);
  });
});
