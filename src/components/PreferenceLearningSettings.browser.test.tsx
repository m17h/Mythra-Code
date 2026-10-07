import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { preferenceLearningFixture } from "../test/preferenceLearningFixture";
import { clearPreferenceLearning, configurePreferenceLearning, editPreferenceLearning, getPreferenceLearningScope, loadPreferenceLearning } from "../lib/preferenceLearningStore";
import { ConfirmDialogModal } from "./ConfirmDialogModal";
import { PreferenceLearningSettings } from "./PreferenceLearningSettings";
import "./SettingsModal.css";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
const fixture = preferenceLearningFixture();
const props = {
  projects: [{ id: "browser-project", name: "Browser project", path: "/fixture/browser" }],
  modelCatalogs: { openai: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }, { id: "gpt-6.1-luna", label: "GPT-6.1 Luna" }] },
};
const mount = (onChanged = vi.fn()) => render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", minHeight: 900, padding: 24 }}>
  <div style={{ maxWidth: 750 }}><PreferenceLearningSettings {...props} onChanged={onChanged} /></div>
  <ConfirmDialogModal />
</div>);

beforeEach(async () => {
  fixture.reset();
  native.invoke.mockImplementation(fixture.invoke);
  await loadPreferenceLearning();
  // Only the in-app confirmation surface is enabled. All native persistence is
  // intercepted above, so the fixture never reads or writes a real profile.
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});
afterEach(async () => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; await page.viewport(1400, 900); await commands.setStreamTestReducedMotion(false); });

describe("preference learning in the browser", () => {
  it("shows readable experimental help on hover and keyboard focus at enlarged scale", async () => {
    await page.viewport(760, 750);
    const view = mount();
    view.container.querySelector<HTMLElement>(".app-shell")!.style.zoom = "1.5";
    const info = page.getByRole("button", { name: "About experimental preference learning" });
    await userEvent.hover(info);
    await expect.element(page.getByRole("tooltip")).toBeVisible();
    const tooltip = view.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("app or selected project");
    expect(tooltip.scrollWidth).toBeLessThanOrEqual(tooltip.clientWidth + 1);
    const helpRect = tooltip.getBoundingClientRect();
    expect(helpRect.left).toBeGreaterThanOrEqual(0);
    expect(helpRect.right).toBeLessThanOrEqual(760);
    await userEvent.hover(page.getByRole("button", { name: "Preference learning scope" }));
    await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
    view.getByRole("button", { name: "About experimental preference learning" }).focus();
    await expect.element(page.getByRole("tooltip")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
    expect(fixture.calls.some((call) => call.command === "preference_learning_save")).toBe(false);
  });
  it("dismisses hover help with Escape while keeping Settings focus and content", async () => {
    const view = mount();
    const closeSettings = vi.fn();
    document.addEventListener("keydown", closeSettings);
    try {
      view.getByRole("textbox").focus();
      await userEvent.hover(page.getByRole("button", { name: "About experimental preference learning" }));
      await expect.element(page.getByRole("tooltip")).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
      expect(closeSettings).not.toHaveBeenCalled();
      expect(view.getByRole("textbox")).toHaveFocus();
      expect(view.getByRole("heading", { name: "Learned preferences" })).toBeVisible();
    } finally { document.removeEventListener("keydown", closeSettings); }
  });
  it("shows a historical save receipt without claiming a later-cleared document was updated", async () => {
    await configurePreferenceLearning("app", { enabled: true, model: "gpt-6-luna" });
    await editPreferenceLearning("app", "- Earlier saved result");
    await clearPreferenceLearning("app", getPreferenceLearningScope("app").revision);
    const progress = { scopeKey: "app", runId: "browser-superseded", status: "complete" as const, changed: true, superseded: true,
      threads: 1, pages: 1, messages: 1, skipped: 0, limited: false, message: "History analysis was saved. Review the latest settings and preferences before continuing." };
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", padding: 24 }}>
      <PreferenceLearningSettings {...props} onLearnPastConversations={vi.fn()} historyProgress={progress} />
    </div>);
    await expect.element(page.getByRole("textbox")).toHaveValue("");
    await expect.element(page.getByText("Learning saved — review latest preferences")).toBeVisible();
    await expect.element(page.getByText(progress.message)).toBeVisible();
    expect(view.queryByText("Learning complete — preferences updated")).toBeNull();
    expect(view.container.querySelector(".preference-learning-history-state.complete .lucide-check")).not.toBeNull();
    await page.screenshot({ element: view.container.querySelector<HTMLElement>(".preference-learning-history-progress")!, path: "../../test-results/preference-history-superseded.png" });
  });

  it("keeps history visibly working through model analysis and native saving, then shows the completion check", async () => {
    await page.viewport(760, 750);
    await configurePreferenceLearning("app", { enabled: true, model: "gpt-6-luna" });
    const onLearn = vi.fn(async () => {});
    const onCancel = vi.fn();
    const progress = { scopeKey: "app", runId: "browser-history", provider: "openai" as const, model: "gpt-6-luna", threads: 8, pages: 24, messages: 40, skipped: 2, limited: true };
    const content = (status: "reading" | "queued" | "analyzing" | "saving" | "partial") => <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: 1.5, display: "block", padding: 16 }}>
      <PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} onCancelLearning={onCancel} historyProgress={{ ...progress, status, ...(status === "partial" ? { changed: true } : {}) }} />
    </div>;
    const view = render(content("reading"));
    for (const [status, text] of [
      ["reading", "Reading recent conversations…"],
      ["queued", "Waiting for preference analysis…"],
      ["analyzing", "Analyzing recent conversations with OpenAI · gpt-6-luna…"],
      ["saving", "Saving learned preferences…"],
    ] as const) {
      view.rerender(content(status));
      const state = view.getByText(text).closest<HTMLElement>(".preference-learning-history-state")!;
      expect(state.closest("[aria-live='polite']")).not.toBeNull();
      expect(state).toHaveAttribute("data-history-status", status);
      expect(state.querySelectorAll(".pixel-working-mark > i")).toHaveLength(9);
      expect(view.container.querySelector(".preference-learning-history-state.complete")).toBeNull();
      await expect.element(page.getByRole("button", { name: "Analyze recent past conversations" })).toBeDisabled();
      if (status === "saving") await expect.element(page.getByRole("button", { name: "Finishing save…" })).toBeDisabled();
      else await expect.element(page.getByRole("button", { name: "Cancel preference learning" })).not.toBeDisabled();
      const cell = state.querySelector<HTMLElement>(".pixel-working-mark > i")!;
      if (status === "reading") expect(getComputedStyle(cell).animationName).toBe("pixel-working-ring");
      await commands.setStreamTestReducedMotion(true);
      expect(getComputedStyle(cell).animationName).toBe("none");
    }
    view.rerender(content("partial"));
    await expect.element(page.getByText("Learning complete — preferences updated")).toBeVisible();
    expect(view.container.querySelector(".preference-learning-history-state.complete .lucide-check")).not.toBeNull();
    expect(view.container.querySelector(".preference-learning-history-state .pixel-working-mark")).toBeNull();
    await expect.element(page.getByRole("button", { name: "Analyze recent past conversations" })).not.toBeDisabled();
    expect(view.queryByRole("button", { name: "Cancel preference learning" })).toBeNull();
    expect(view.getByText(/40 authored messages · 2 skipped/)).toHaveTextContent("Limited");
    await page.screenshot({ element: view.container.querySelector<HTMLElement>(".preference-learning-history-progress")!, path: "../../test-results/preference-history-complete.png" });
    expect(onLearn).not.toHaveBeenCalled();
  });

  it("shows removed project preferences and forgets only after explicit confirmation", async () => {
    const scopeKey = "project:removed-browser";
    await configurePreferenceLearning(scopeKey, { enabled: true });
    await editPreferenceLearning(scopeKey, "- Retained project preferences");
    const onChanged = vi.fn();
    render(<div className="app-shell" data-theme="mythra" style={{ display: "block", padding: 24 }}>
      <PreferenceLearningSettings {...props} projects={[]} onLearnPastConversations={vi.fn()} onChanged={onChanged} />
      <ConfirmDialogModal />
    </div>);
    await page.getByRole("button", { name: "Preference learning scope" }).click();
    await page.getByRole("menuitemradio", { name: /Removed project · removed-browser/ }).click();
    await expect.element(page.getByRole("textbox")).toHaveValue("- Retained project preferences");
    await expect.element(page.getByRole("switch")).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Analyze recent past conversations" })).toBeDisabled();
    await page.getByRole("button", { name: "Forget removed project preferences" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toHaveTextContent("Conversations and authored prompts are preserved");
    expect(fixture.states.has(scopeKey)).toBe(true);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Forget removed project preferences" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Forget preferences", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Preference learning scope" })).toHaveTextContent("App");
    await expect.element(page.getByRole("button", { name: "Preference learning scope" })).toHaveFocus();
    expect(fixture.states.has(scopeKey)).toBe(false);
    expect(onChanged).toHaveBeenCalledWith("Saved preferences forgotten for Removed project · removed-browser.");
  });

  it("keeps the model menu above its clipping card at enlarged scale and narrow widths", async () => {
    await page.viewport(600, 750);
    const catalogs = { openai: Array.from({ length: 12 }, (_, index) => ({ id: `gpt-6.${index}-luna`, label: `GPT-6.${index} Luna` })) };
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: 1.5, display: "block", padding: 16 }}>
      <div style={{ width: 340 }}><PreferenceLearningSettings {...props} modelCatalogs={catalogs} /></div>
    </div>);
    await userEvent.click(view.getByRole("button", { name: "Preference learning model" }));
    const menu = document.querySelector<HTMLElement>(".app-select-menu")!;
    const automatic = view.getByRole("menuitemradio", { name: /Automatic/ });
    expect(automatic.querySelector("small")?.textContent).toBe("gpt-6.11-luna");
    const rect = menu.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(innerWidth);
    expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
    const option = view.getByRole("menuitemradio", { name: /GPT-6.0 Luna/ });
    const optionRect = option.getBoundingClientRect();
    expect(menu.contains(document.elementFromPoint(optionRect.left + 10, optionRect.top + 10))).toBe(true);
    await page.screenshot({ path: "../../test-results/preference-learning-menu-150.png" });
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Preference learning model" }));
  });

  it("uses real scope/model menus, persists controls, edits safely and confirms recoverable clear", async () => {
    const onChanged = vi.fn();
    const view = mount(onChanged);
    await page.getByRole("button", { name: "Preference learning model" }).click();
    const automatic = page.getByRole("menuitemradio", { name: /Automatic/ });
    await expect.element(automatic).toHaveTextContent("gpt-6.1-luna");
    await automatic.click();
    await page.getByRole("switch", { name: "Automatically learn preferences" }).click();
    await waitFor(() => expect(getPreferenceLearningScope("app").enabled).toBe(true));
    await page.getByRole("textbox", { name: "Learned instructions for App" }).fill("- Prefer brief answers\n- Keep changes focused");
    await page.getByRole("button", { name: "Save learned instructions" }).click();
    await waitFor(() => expect(getPreferenceLearningScope("app").markdown).toContain("Keep changes focused"));
    await page.getByRole("button", { name: "Clear learned preferences" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Clear the learned preferences for App?" });
    await expect.element(dialog).toBeVisible();
    expect(getPreferenceLearningScope("app").markdown).toContain("Keep changes focused");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await waitFor(() => expect(view.getByRole("button", { name: "Clear learned preferences" })).not.toBeDisabled());
    await page.getByRole("button", { name: "Clear learned preferences" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear preferences", exact: true }).click();
    await waitFor(() => expect(getPreferenceLearningScope("app").markdown).toBe(""));
    await page.getByRole("button", { name: "Undo clear" }).click();
    await waitFor(() => expect(getPreferenceLearningScope("app").markdown).toContain("Prefer brief answers"));
    await page.getByRole("button", { name: "Preference learning scope" }).click();
    await page.getByRole("menuitemradio", { name: /Browser project/ }).click();
    await expect.element(page.getByRole("textbox", { name: "Learned instructions for Browser project" })).toHaveValue("");
    await expect.element(page.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(onChanged).toHaveBeenCalledWith("Learned preferences restored for App.");
    expect(fixture.calls.every((call) => call.command.startsWith("preference_learning_"))).toBe(true);
    const editor = view.getByRole("textbox");
    expect(editor.getBoundingClientRect().width).toBeGreaterThan(300);
    expect(getComputedStyle(editor).resize).toBe("vertical");
  });

  it("keeps a real editing draft when a background preference update arrives", async () => {
    mount();
    await page.getByRole("textbox", { name: "Learned instructions for App" }).fill("<script>unsaved draft</script>");
    await act(async () => { await editPreferenceLearning("app", "- New background preference"); });
    await expect.element(page.getByRole("textbox")).toHaveValue("<script>unsaved draft</script>");
    await expect.element(page.getByRole("button", { name: "Save learned instructions" })).toBeDisabled();
    await page.getByRole("button", { name: "Load latest preferences" }).click();
    await expect.element(page.getByRole("textbox")).toHaveValue("- New background preference");
    expect(document.querySelector(".preference-learning-settings script")).toBeNull();
  });

  it("keeps enable controls available during history collection and lets the user cancel", async () => {
    let finish!: () => void;
    const onLearn = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onCancel = vi.fn(() => finish());
    const view = render(<div className="app-shell" data-theme="mythra" style={{ display: "block", padding: 24 }}><PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} onCancelLearning={onCancel} /></div>);
    await page.getByRole("switch").click();
    await waitFor(() => expect(getPreferenceLearningScope("app").enabled).toBe(true));
    await page.getByRole("button", { name: "Analyze recent past conversations" }).click();
    await expect.element(page.getByRole("switch")).not.toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Preference learning provider" })).not.toBeDisabled();
    await page.getByRole("button", { name: "Cancel preference learning" }).click();
    expect(onCancel).toHaveBeenCalledWith("app");
    await waitFor(() => expect(view.queryByRole("button", { name: "Cancel preference learning" })).not.toBeInTheDocument());
  });
});
