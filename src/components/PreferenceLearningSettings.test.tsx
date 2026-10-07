import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preferenceLearningFixture } from "../test/preferenceLearningFixture";
import { clearPreferenceLearning, configurePreferenceLearning, editPreferenceLearning, getPreferenceLearningScope, loadPreferenceLearning, setPreferenceLearningJob } from "../lib/preferenceLearningStore";
import { confirmDialog } from "../lib/confirmDialog";
import { PreferenceLearningSettings } from "./PreferenceLearningSettings";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => false) }));
const fixture = preferenceLearningFixture();
const props = {
  projects: [{ id: "one", name: "Project one", path: "/fixture/one" }],
  modelCatalogs: { openai: [{ id: "gpt-6-luna", label: "Luna" }, { id: "gpt-6.1-luna", label: "Luna 6.1" }], claude: [{ id: "claude-current", label: "Claude current" }] },
};
const pick = (label: string, name: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
};
const saveCalls = () => fixture.calls.filter((call) => call.command === "preference_learning_save");

beforeEach(async () => {
  fixture.reset();
  native.invoke.mockImplementation(fixture.invoke);
  vi.mocked(confirmDialog).mockResolvedValue(false);
  await loadPreferenceLearning();
  setPreferenceLearningJob("app", { status: "idle" });
  setPreferenceLearningJob("project:one", { status: "idle" });
});

describe("learned preference controls", () => {
  it("explains experimental learning on hover, focus and click without changing settings", () => {
    render(<PreferenceLearningSettings {...props} />);
    const info = screen.getByRole("button", { name: "About experimental preference learning" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseEnter(info);
    expect(screen.getByRole("tooltip")).toHaveTextContent("does not overwrite your existing prompts or edit project files");
    expect(screen.getByRole("tooltip")).toHaveTextContent("can still affect answers");
    fireEvent.mouseLeave(info.parentElement!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(info);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(info, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(info);
    fireEvent.mouseLeave(info.parentElement!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("uses quota or credits");
    fireEvent.click(info);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(info);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(info);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Preference learning scope" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(saveCalls()).toHaveLength(0);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
  it("starts off, explains disclosure before enable, and saves immediately using the live automatic model", async () => {
    const onChanged = vi.fn();
    render(<PreferenceLearningSettings {...props} onChanged={onChanged} />);
    const toggle = screen.getByRole("switch", { name: "Automatically learn preferences" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/OpenAI receives conversation content/)).toBeInTheDocument();
    expect(screen.getByText(/quota or API credits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preference learning model" }));
    expect(screen.getByRole("menuitemradio", { name: /Automatic/ })).toHaveTextContent("gpt-6.1-luna");
    expect(screen.queryByText("gpt-5.6-luna")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Preference learning model" }), { key: "Escape" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(getPreferenceLearningScope("app").model).toBe("");
    expect(saveCalls()).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledWith("Preference learning enabled for App.");
    expect(screen.queryByRole("button", { name: /past conversations/i })).not.toBeInTheDocument();
  });

  it("waits for a GPT-6 Luna live catalog, without falling back to old Luna models", () => {
    render(<PreferenceLearningSettings {...props} modelCatalogs={{ openai: [{ id: "gpt-5.6-luna", label: "Old Luna" }] }} />);
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByText(/waiting for GPT-6 Luna/)).toBeInTheDocument();
    expect(saveCalls()).toHaveLength(0);
  });

  it("isolates app and project edits and retains saved preferences when a selected project disappears", async () => {
    const view = render(<PreferenceLearningSettings {...props} />);
    pick("Preference learning scope", /Project one/);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(getPreferenceLearningScope("project:one").enabled).toBe(true));
    fireEvent.change(screen.getByRole("textbox", { name: "Learned instructions for Project one" }), { target: { value: "Only this project" } });
    pick("Preference learning scope", /App/);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("textbox")).toHaveValue("");
    pick("Preference learning scope", /Project one/);
    expect(screen.getByRole("textbox")).toHaveValue("");
    view.rerender(<PreferenceLearningSettings {...props} projects={[]} />);
    expect(screen.getByRole("button", { name: "Preference learning scope" })).toHaveTextContent("Removed project · one");
    expect(screen.getByRole("textbox", { name: "Learned instructions for Removed project · one" })).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("preserves absent saved model IDs and requires an explicit model after switching provider", async () => {
    await configurePreferenceLearning("app", { model: "custom-runtime-id" });
    render(<PreferenceLearningSettings {...props} />);
    expect(screen.getByRole("button", { name: "Preference learning model" })).toHaveTextContent("custom-runtime-id");
    expect(screen.getByText(/exact ID is preserved/)).toBeInTheDocument();
    pick("Preference learning provider", /Claude/);
    await waitFor(() => expect(getPreferenceLearningScope("app").provider).toBe("claude"));
    expect(screen.getByRole("switch")).toBeDisabled();
    pick("Preference learning model", /Claude current/);
    await waitFor(() => expect(screen.getByRole("switch")).not.toBeDisabled());
    expect(getPreferenceLearningScope("app").model).toBe("claude-current");
  });

  it("disables controls during native writes and shows failure without manufacturing a saved change", async () => {
    let reject!: (reason: Error) => void;
    fixture.delay(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    render(<PreferenceLearningSettings {...props} />);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preference learning scope" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preference learning provider" })).toBeDisabled();
    await act(async () => reject(new Error("Native storage unavailable at /Users/private/profile token=secret")));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save learned preferences"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("/Users/private");
    expect(screen.getByRole("alert")).not.toHaveTextContent("token=secret");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch")).not.toBeDisabled();
  });

  it("does not leave App controls locked if a project disappears during its native write", async () => {
    let finish!: () => void;
    fixture.delay(() => new Promise<void>((resolve) => { finish = resolve; }));
    const project = { id: "removed-during-save", name: "Removed project", path: "/fixture/removed" };
    const onChanged = vi.fn();
    const view = render(<PreferenceLearningSettings {...props} projects={[project]} onChanged={onChanged} />);
    pick("Preference learning scope", /Removed project/);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Preference learning scope" })).toBeDisabled();
    view.rerender(<PreferenceLearningSettings {...props} projects={[]} onChanged={onChanged} />);
    expect(screen.getByRole("button", { name: "Preference learning scope" })).not.toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Learned instructions for App" })).not.toBeDisabled();
    await act(async () => finish());
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("protects an editing draft when automatic preferences update, then saves explicit edits", async () => {
    render(<PreferenceLearningSettings {...props} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My draft" } });
    await act(async () => { await editPreferenceLearning("app", "- Automatically learned preference"); });
    expect(screen.getByRole("textbox")).toHaveValue("My draft");
    expect(screen.getByRole("button", { name: "Save learned instructions" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Load latest preferences" }));
    expect(screen.getByRole("textbox")).toHaveValue("- Automatically learned preference");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "- My edited preference" } });
    fireEvent.click(screen.getByRole("button", { name: "Save learned instructions" }));
    await waitFor(() => expect(getPreferenceLearningScope("app").markdown).toBe("- My edited preference"));
  });

  it("confirms clear and provides recovery, retaining original text until confirmation", async () => {
    await editPreferenceLearning("app", "- Prefer concise replies");
    const onChanged = vi.fn();
    render(<PreferenceLearningSettings {...props} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear learned preferences" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear learned preferences" })).not.toBeDisabled());
    expect(getPreferenceLearningScope("app").markdown).toBe("- Prefer concise replies");
    vi.mocked(confirmDialog).mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear learned preferences" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    fireEvent.click(screen.getByRole("button", { name: "Undo clear" }));
    await waitFor(() => expect(getPreferenceLearningScope("app").markdown).toBe("- Prefer concise replies"));
    expect(onChanged).toHaveBeenCalledWith("Learned preferences restored for App.");
  });

  it("preserves a newer document that arrives while clear confirmation is open", async () => {
    await editPreferenceLearning("app", "- Original preference");
    let confirm!: (value: boolean) => void;
    vi.mocked(confirmDialog).mockImplementation(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    render(<PreferenceLearningSettings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear learned preferences" }));
    await act(async () => { await editPreferenceLearning("app", "- Newly learned preference"); });
    await act(async () => confirm(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear learned preferences" })).not.toBeDisabled());
    expect(getPreferenceLearningScope("app").markdown).toBe("- Newly learned preference");
    expect(screen.getByRole("alert")).toHaveTextContent("The learned preferences changed");
    expect(screen.queryByRole("button", { name: "Undo clear" })).not.toBeInTheDocument();
  });

  it("shows a bounded historical action only when a runner exists and reports its result", async () => {
    const onLearn = vi.fn(async (scopeKey: string) => { setPreferenceLearningJob(scopeKey, { status: "idle", message: "Analyzed 2 chats; skipped 1 unavailable chat." }); });
    render(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} />);
    const button = screen.getByRole("button", { name: "Analyze recent past conversations" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/up to eight chats and three pages/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(onLearn).toHaveBeenCalledWith("app"));
    expect(screen.getByText("Analyzed 2 chats; skipped 1 unavailable chat.")).toBeInTheDocument();
  });

  it("keeps disable and cancellation available while history is being read", async () => {
    let finish!: () => void;
    const onLearn = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onCancel = vi.fn(() => finish());
    await configurePreferenceLearning("app", { enabled: true });
    render(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} onCancelLearning={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze recent past conversations" }));
    expect(screen.getByRole("button", { name: "Analyze recent past conversations" })).toBeDisabled();
    expect(screen.getByRole("switch")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Preference learning provider" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel preference learning" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith("app"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel preference learning" })).not.toBeInTheDocument());
  });

  it("shows selected-scope history outcomes including skipped counts, limits and errors", () => {
    const history = { scopeKey: "app", runId: "completed-bounded-pass", status: "partial" as const, changed: true, threads: 8, pages: 24, messages: 40, skipped: 2, limited: true, message: "Examined recent conversations and saved learned preferences." };
    const view = render(<PreferenceLearningSettings {...props} historyProgress={history} />);
    expect(screen.getByText(/8 conversation attempts · 24 page attempts · 40 authored messages · 2 skipped/)).toHaveTextContent("Limited");
    expect(screen.getByText("Learning complete — preferences updated")).toBeInTheDocument();
    pick("Preference learning scope", /Project one/);
    expect(screen.queryByText(history.message)).not.toBeInTheDocument();
    view.rerender(<PreferenceLearningSettings {...props} historyProgress={{ ...history, scopeKey: "project:one", status: "error", message: "History is unavailable for this project." }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("History is unavailable for this project.");
  });

  it("shows working phases through analysis and saving, then a completion check after the saved result", async () => {
    await configurePreferenceLearning("app", { enabled: true });
    const onLearn = vi.fn(async () => {});
    const onCancel = vi.fn();
    const progress = { scopeKey: "app", runId: "history-phases", threads: 8, pages: 24, messages: 40, skipped: 2, limited: true };
    const view = render(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} onCancelLearning={onCancel} historyProgress={{ ...progress, status: "reading" }} />);
    for (const [status, label] of [
      ["reading", "Reading recent conversations…"],
      ["queued", "Waiting for preference analysis…"],
      ["analyzing", "Analyzing recent conversations with OpenAI · gpt-6-luna…"],
      ["saving", "Saving learned preferences…"],
    ] as const) {
      view.rerender(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} onCancelLearning={onCancel} historyProgress={{ ...progress, status, provider: "openai", model: "gpt-6-luna" }} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(view.container.querySelectorAll(".preference-learning-history-state .pixel-working-mark > i")).toHaveLength(9);
      expect(view.container.querySelector(".preference-learning-history-state.complete")).toBeNull();
      expect(screen.getByRole("button", { name: "Analyze recent past conversations" })).toBeDisabled();
      if (status === "saving") expect(screen.getByRole("button", { name: "Finishing save…" })).toBeDisabled();
      else expect(screen.getByRole("button", { name: "Cancel preference learning" })).not.toBeDisabled();
      expect(screen.getByRole("switch")).not.toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Analyze recent past conversations" }));
    }
    expect(onLearn).not.toHaveBeenCalled();
    view.rerender(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} onCancelLearning={onCancel} historyProgress={{ ...progress, status: "partial", changed: true }} />);
    expect(screen.getByText("Learning complete — preferences updated")).toBeInTheDocument();
    expect(view.container.querySelector(".preference-learning-history-state.complete .lucide-check")).not.toBeNull();
    expect(view.container.querySelector(".preference-learning-history-state .pixel-working-mark")).toBeNull();
    expect(screen.getByRole("button", { name: "Analyze recent past conversations" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel preference learning" })).not.toBeInTheDocument();
    expect(screen.getByText("This bounded history pass does not cover all history.")).toBeInTheDocument();
    expect(screen.getByText(/8 conversation attempts · 24 page attempts · 40 authored messages · 2 skipped/)).toHaveTextContent("Limited");
  });

  it("distinguishes successful no-change or empty results from errors and cancellation", () => {
    const progress = { scopeKey: "app", runId: "history-terminal", threads: 2, pages: 2, messages: 4, skipped: 0, limited: false };
    const view = render(<PreferenceLearningSettings {...props} historyProgress={{ ...progress, status: "complete", changed: false }} />);
    expect(screen.getByText("Learning complete — no changes needed")).toBeInTheDocument();
    view.rerender(<PreferenceLearningSettings {...props} historyProgress={{ ...progress, status: "complete", messages: 0, changed: false }} />);
    expect(screen.getByText("Learning complete — no eligible authored messages")).toBeInTheDocument();
    for (const status of ["error", "cancelled"] as const) {
      view.rerender(<PreferenceLearningSettings {...props} historyProgress={{ ...progress, status, message: status === "error" ? "Analysis failed; existing preferences were preserved." : "History analysis cancelled." }} />);
      expect(view.container.querySelector(".preference-learning-history-state.complete")).toBeNull();
      expect(view.container.querySelector(".preference-learning-history-state .pixel-working-mark")).toBeNull();
      expect(screen.queryByText(/Learning complete/)).not.toBeInTheDocument();
      if (status === "error") expect(screen.getByRole("alert")).toHaveTextContent("Analysis failed");
      else expect(screen.getByText("Preference learning cancelled.")).toBeInTheDocument();
    }
  });

  it("hides the previous checkmark on rerun and stays working after the history scan queues analysis", async () => {
    await configurePreferenceLearning("app", { enabled: true });
    let finish!: () => void;
    const onLearn = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const progress = { scopeKey: "app", runId: "old-history-run", threads: 1, pages: 1, messages: 4, skipped: 0, limited: false };
    const view = render(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} historyProgress={{ ...progress, status: "complete", changed: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze recent past conversations" }));
    expect(screen.queryByText(/Learning complete/)).not.toBeInTheDocument();
    expect(screen.getByText("Reading recent conversations…")).toBeInTheDocument();
    view.rerender(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} historyProgress={{ ...progress, runId: "new-history-run", status: "queued" }} />);
    await act(async () => finish());
    expect(screen.getByText("Waiting for preference analysis…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze recent past conversations" })).toBeDisabled();
    expect(screen.queryByText(/Learning complete/)).not.toBeInTheDocument();
  });

  it("labels unsuccessful page reads as attempts and formats singular coverage counts", () => {
    const progress = { scopeKey: "app", runId: "missing-page", status: "partial" as const, changed: false, threads: 1, pages: 1, messages: 0, skipped: 1, limited: false };
    const view = render(<PreferenceLearningSettings {...props} historyProgress={progress} />);
    expect(screen.getByText("1 conversation attempt · 1 page attempt · 0 authored messages · 1 skipped item")).toBeInTheDocument();
    expect(screen.getByText("This bounded history pass does not cover all history.")).toBeInTheDocument();
    expect(screen.queryByText(/conversations were reviewed/)).not.toBeInTheDocument();
    view.rerender(<PreferenceLearningSettings {...props} historyProgress={{ ...progress, messages: 1, skipped: 0 }} />);
    expect(screen.getByText("1 conversation attempt · 1 page attempt · 1 authored message · 0 skipped items")).toBeInTheDocument();
  });

  it.each(["clear", "disable", "model"] as const)("describes a saved result truthfully when a later %s supersedes it", async (change) => {
    await configurePreferenceLearning("app", { enabled: true, model: "gpt-6-luna" });
    await editPreferenceLearning("app", "- Saved result before later changes");
    const progress = { scopeKey: "app", runId: "superseded-save", threads: 1, pages: 1, messages: 1, skipped: 0, limited: false,
      status: "complete" as const, changed: true, superseded: true, message: "History analysis was saved. Review the latest settings and preferences before continuing." };
    if (change === "clear") await clearPreferenceLearning("app", getPreferenceLearningScope("app").revision);
    else if (change === "disable") await configurePreferenceLearning("app", { enabled: false });
    else await configurePreferenceLearning("app", { model: "gpt-6.1-luna" });
    const view = render(<PreferenceLearningSettings {...props} onLearnPastConversations={vi.fn()} historyProgress={progress} />);
    expect(screen.getByText("Learning saved — review latest preferences")).toBeInTheDocument();
    expect(screen.getByText(progress.message)).toBeInTheDocument();
    expect(screen.queryByText("Learning complete — preferences updated")).not.toBeInTheDocument();
    expect(view.container.querySelector(".preference-learning-history-state.complete .lucide-check")).not.toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue(change === "clear" ? "" : "- Saved result before later changes");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", change === "disable" ? "false" : "true");
    expect(screen.getByRole("button", { name: "Preference learning model" })).toHaveTextContent(change === "model" ? "Luna 6.1" : "Luna");
  });

  it("does not claim a requested settings change succeeded when its own native write failed", async () => {
    await configurePreferenceLearning("app", { enabled: true, model: "gpt-6-luna" });
    await editPreferenceLearning("app", "- Successful history save");
    fixture.delay(() => Promise.reject(new Error("settings write failed")));
    await expect(configurePreferenceLearning("app", { model: "gpt-6.1-luna" })).rejects.toThrow("settings write failed");
    const progress = { scopeKey: "app", runId: "superseded-failed-change", status: "complete" as const, changed: true, superseded: true,
      threads: 1, pages: 1, messages: 1, skipped: 0, limited: false, message: "History analysis was saved. Review the latest settings and preferences before continuing." };
    render(<PreferenceLearningSettings {...props} onLearnPastConversations={vi.fn()} historyProgress={progress} />);
    expect(screen.getByText("Learning saved — review latest preferences")).toBeInTheDocument();
    expect(screen.getByText(progress.message)).toBeInTheDocument();
    expect(screen.queryByText(/later changes kept|preferences updated/i)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("- Successful history save");
    expect(getPreferenceLearningScope("app").model).toBe("gpt-6-luna");
  });

  it("blocks another history run across scopes and explains how to view the active run", async () => {
    await configurePreferenceLearning("app", { enabled: true });
    await configurePreferenceLearning("project:one", { enabled: true });
    const onLearn = vi.fn(async () => {});
    const progress = { scopeKey: "app", runId: "global-active-history", threads: 1, pages: 1, messages: 4, skipped: 0, limited: false };
    const view = render(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} historyProgress={{ ...progress, status: "reading" }} />);
    pick("Preference learning scope", /Project one/);
    for (const status of ["reading", "queued", "analyzing", "saving"] as const) {
      view.rerender(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} historyProgress={{ ...progress, status }} />);
      expect(screen.getByText("Another history analysis is running. Select that scope to view its progress.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Analyze recent past conversations" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Analyze recent past conversations" }));
    }
    expect(onLearn).not.toHaveBeenCalled();
    view.rerender(<PreferenceLearningSettings {...props} onLearnPastConversations={onLearn} historyProgress={{ ...progress, status: "complete", changed: false }} />);
    expect(screen.getByRole("button", { name: "Analyze recent past conversations" })).not.toBeDisabled();
  });

  it("lets users inspect and explicitly forget a removed project's saved scope", async () => {
    const scopeKey = "project:removed-project";
    await configurePreferenceLearning(scopeKey, { enabled: true });
    await editPreferenceLearning(scopeKey, "- Retained preferences from a deleted project");
    const onChanged = vi.fn();
    render(<PreferenceLearningSettings {...props} projects={[]} onLearnPastConversations={vi.fn()} onChanged={onChanged} />);
    pick("Preference learning scope", /Removed project · removed-project/);
    expect(screen.getByRole("textbox")).toHaveValue("- Retained preferences from a deleted project");
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preference learning provider" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preference learning model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Analyze recent past conversations" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Forget removed project preferences" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Forget removed project preferences" })).not.toBeDisabled());
    expect(fixture.states.has(scopeKey)).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Forget removed project preferences" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preference learning scope" })).toHaveTextContent("App"));
    expect(fixture.states.has(scopeKey)).toBe(false);
    expect(onChanged).toHaveBeenCalledWith("Saved preferences forgotten for Removed project · removed-project.");
    expect(fixture.calls.filter((call) => call.command === "preference_learning_forget")).toHaveLength(1);
  });

  it("keeps a removed scope selected and preserves its latest document when forgetting conflicts", async () => {
    const scopeKey = "project:removed-conflict";
    await editPreferenceLearning(scopeKey, "- Original preference");
    const onChanged = vi.fn();
    let confirm!: (value: boolean) => void;
    vi.mocked(confirmDialog).mockImplementation(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    render(<PreferenceLearningSettings {...props} projects={[]} onChanged={onChanged} />);
    pick("Preference learning scope", /Removed project · removed-conflict/);
    fireEvent.click(screen.getByRole("button", { name: "Forget removed project preferences" }));
    await act(async () => { await editPreferenceLearning(scopeKey, "- Latest preference"); });
    await act(async () => confirm(true));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The learned preferences changed"));
    expect(screen.getByRole("button", { name: "Preference learning scope" })).toHaveTextContent("Removed project · removed-conflict");
    expect(screen.getByRole("textbox")).toHaveValue("- Latest preference");
    expect(fixture.states.has(scopeKey)).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps a removed scope and its document when native forgetting fails", async () => {
    const scopeKey = "project:removed-failure";
    await editPreferenceLearning(scopeKey, "- Retained preference");
    const onChanged = vi.fn();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    fixture.delay(() => Promise.reject(new Error("permission denied at /private/profile token=secret")));
    render(<PreferenceLearningSettings {...props} projects={[]} onChanged={onChanged} />);
    pick("Preference learning scope", /Removed project · removed-failure/);
    fireEvent.click(screen.getByRole("button", { name: "Forget removed project preferences" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("storage access was denied"));
    expect(screen.getByRole("button", { name: "Preference learning scope" })).toHaveTextContent("Removed project · removed-failure");
    expect(screen.getByRole("textbox")).toHaveValue("- Retained preference");
    expect(fixture.states.has(scopeKey)).toBe(true);
    expect(screen.getByRole("alert")).not.toHaveTextContent("/private/profile");
    expect(screen.getByRole("alert")).not.toHaveTextContent("token=secret");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
