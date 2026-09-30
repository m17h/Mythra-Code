import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { SkillLibrary } from "./SkillLibrary";
import { PullRequestChecks } from "./ThreadPullRequestPanel";
import { ConfirmDialogModal } from "./ConfirmDialogModal";
import { settleConfirm, useConfirmStore } from "../lib/confirmDialog";
import type { LocalSkill } from "../lib/skills";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import "../styles.css";

const skills: LocalSkill[] = ["review", "release"].map((name) => ({
  name, defaultName: name, path: `/review-fixture/${name}.md`, relativePath: `${name}.md`, fileName: `${name}.md`,
  description: name, supportingMarkdownCount: 0, enabled: true,
}));

function PromptFixture({ changed = () => {} }: { changed?: (text: string) => void }) {
  const [text, setText] = useState("");
  return <div className="app-shell" style={{ width: 520, display: "block", marginTop: 200 }}>
    <input aria-label="Previous control" />
    <SkillPromptEditor aria-label="Prompt" value={text} skills={skills} onChange={(event) => { setText(event.target.value); changed(event.target.value); }} />
  </div>;
}

afterEach(async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  useConfirmStore.setState({ queue: [] });
  await page.viewport(1400, 900);
});

describe("frontend branch review regressions", () => {
  it("keeps an unsaved skill draft through a missing-file rescan and recovery", async () => {
    const onUpdate = vi.fn(async () => {});
    const props: Parameters<typeof SkillLibrary>[0] = {
      folder: "/review-fixture", skills, removedSkills: [], busy: false, error: "",
      onChooseFolder: () => {}, onRefresh: () => {}, onImport: () => {}, onCreate: async () => true,
      onRead: async () => "Original", onUpdate, onRename: () => true, onToggle: () => {},
      onRemove: async () => true, onRestore: async () => true,
    };
    const view = render(<div className="app-shell"><SkillLibrary {...props} /></div>);
    await userEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    await waitFor(() => expect(field).toHaveValue("Original"));
    await userEvent.fill(field, "Unsaved instructions");
    view.rerender(<div className="app-shell"><SkillLibrary {...props} skills={[]} /></div>);
    expect(field).toHaveValue("Unsaved instructions");
    expect(screen.getByRole("button", { name: "Save skill" })).toBeDisabled();
    expect(screen.getByText(/Your draft is still here/)).toBeVisible();
    view.rerender(<div className="app-shell"><SkillLibrary {...props} /></div>);
    await userEvent.click(screen.getByRole("button", { name: "Save skill" }));
    expect(onUpdate).toHaveBeenCalledWith(skills[0].path, "Unsaved instructions", "Original");
  });

  it("expands passed checks even with a full page of pending checks", async () => {
    render(<div className="app-shell"><PullRequestChecks checks={[
      ...Array.from({ length: 24 }, (_, i) => ({ name: `Pending ${i}`, state: "PENDING", url: "" })),
      { name: "Successful build", state: "SUCCESS", url: "" },
    ]} /></div>);
    await userEvent.click(screen.getByRole("button", { name: "Show 1 passed check" }));
    expect(screen.getByText("Successful build")).toBeVisible();
  });

  it.each(["native", "fallback"] as const)("preserves suffix, caret and a single React input update during %s completion", async (editing) => {
    const changed = vi.fn();
    render(<PromptFixture changed={changed} />);
    const field = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    await userEvent.fill(field, "Use @rev then continue");
    field.setSelectionRange(8, 8);
    fireEvent.select(field);
    changed.mockClear();
    if (editing === "fallback") vi.spyOn(document, "execCommand").mockReturnValue(false);
    await userEvent.keyboard("{Enter}");
    expect(field).toHaveValue("Use @review  then continue");
    expect(changed).toHaveBeenCalledExactlyOnceWith("Use @review  then continue");
    expect(field.selectionStart).toBe(12);
    expect(field.selectionEnd).toBe(12);
    expect(field).toHaveFocus();
    expect(screen.queryByRole("listbox", { name: "Skill suggestions" })).toBeNull();
  });
  it("keeps source Markdown and actions within the native minimum window while a blocked preview is expanded", async () => {
    await page.viewport(980, 680);
    render(<div className="app-shell" style={{ zoom: 1.25 }}>
      <div className="modal-backdrop settings-backdrop open"><div className="settings-modal" role="dialog" aria-label="Settings">
        <div className="settings-layout"><div className="settings-nav" /><div className="settings-pane">
          <header className="settings-pane-heading"><h3>Skills</h3></header><div className="settings-content">
            <SkillLibrary folder="/review-fixture" skills={skills} removedSkills={[]} busy={false} error=""
              onChooseFolder={() => {}} onRefresh={() => {}} onImport={() => {}} onCreate={async () => true}
              onRead={async () => "Use @review"} onUpdate={async () => {}} onRename={() => true} onToggle={() => {}}
              onRemove={async () => true} onRestore={async () => true} onAnalyzeSkill={async () => skillDependencyFixture(true)} />
          </div>
        </div></div>
      </div></div>
    </div>);
    await userEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    await screen.findByText("Turn blocked by skill dependencies");
    await userEvent.click(screen.getByText("Skill dependencies · 2 skills · 1 document · blocked"));
    const editor = screen.getByRole("dialog", { name: "Edit @review" });
    const rect = editor.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
    const close = screen.getByRole("button", { name: "Close skill editor" });
    const save = screen.getByRole("button", { name: "Save skill" });
    for (const control of [close, save]) {
      const bounds = control.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
    }
  });
  it("preserves the prompt and moves backward when Shift+Tab leaves an active skill query", async () => {
    render(<PromptFixture />);
    const field = screen.getByRole("textbox", { name: "Prompt" });
    await userEvent.fill(field, "Use @rev");
    expect(screen.getByRole("listbox", { name: "Skill suggestions" })).toBeVisible();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(field).toHaveValue("Use @rev");
    expect(screen.getByRole("textbox", { name: "Previous control" })).toHaveFocus();
  });

  it("keeps native Undo available after completing a skill", async () => {
    render(<PromptFixture />);
    const field = screen.getByRole("textbox", { name: "Prompt" });
    await userEvent.click(field);
    await userEvent.keyboard("Authored instructions. @rev");
    expect(document.queryCommandEnabled("undo")).toBe(true);
    await userEvent.keyboard("{Enter}");
    expect(field).toHaveValue("Authored instructions. @review ");
    document.execCommand("undo");
    expect((field as HTMLTextAreaElement).value).not.toBe("Authored instructions. @review ");
    document.execCommand("redo");
    expect(field).toHaveValue("Authored instructions. @review ");
  });

  it("honors accepted navigation if a skill rescan finishes while discard confirmation is open", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const onRead = vi.fn(async (path: string) => `# ${path}\n`);
    const consumed = vi.fn();
    const props: Parameters<typeof SkillLibrary>[0] = {
      folder: "/review-fixture", skills, removedSkills: [], busy: false, error: "",
      onChooseFolder: () => {}, onRefresh: () => {}, onImport: () => {}, onCreate: async () => true,
      onRead, onUpdate: async () => {}, onRename: () => true, onToggle: () => {}, onRemove: async () => true,
      onRestore: async () => true, onOpenSkillRequestConsumed: consumed,
    };
    const request = { path: skills[1].path, nonce: 1 };
    const tree = (next: typeof props) => <div className="app-shell"><SkillLibrary {...next} /><ConfirmDialogModal /></div>;
    const view = render(tree(props));
    await userEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    await userEvent.fill(field, "# Unsaved work\n");
    view.rerender(tree({ ...props, openSkillRequest: request }));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Discard your unsaved skill changes?" })).toBeVisible());
    view.rerender(tree({ ...props, openSkillRequest: request, skills: skills.map((skill) => ({ ...skill })) }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Markdown for release" })).toHaveValue(`# ${skills[1].path}\n`));
    expect(consumed).toHaveBeenCalledWith(1);
  });

  it.each(["request", "folder", "unmount"] as const)("ignores a discard result superseded by a changed %s", async (change) => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const onRead = vi.fn(async () => "# Original\n");
    const consumed = vi.fn();
    const props: Parameters<typeof SkillLibrary>[0] = {
      folder: "/review-fixture", skills, removedSkills: [], busy: false, error: "",
      onChooseFolder: () => {}, onRefresh: () => {}, onImport: () => {}, onCreate: async () => true,
      onRead, onUpdate: async () => {}, onRename: () => true, onToggle: () => {}, onRemove: async () => true,
      onRestore: async () => true, onOpenSkillRequestConsumed: consumed,
    };
    const view = render(<div className="app-shell"><SkillLibrary {...props} /></div>);
    await userEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    await userEvent.fill(field, "# Unsaved work\n");
    const request = { path: skills[1].path, nonce: 1 };
    const next = { ...props, openSkillRequest: request };
    view.rerender(<div className="app-shell"><SkillLibrary {...next} /></div>);
    await waitFor(() => expect(useConfirmStore.getState().queue).toHaveLength(1));
    const confirmId = useConfirmStore.getState().queue[0].id;
    if (change === "unmount") view.unmount();
    else view.rerender(<div className="app-shell"><SkillLibrary {...next}
      folder={change === "folder" ? "/other-fixture" : props.folder}
      openSkillRequest={change === "request" ? { path: skills[0].path, nonce: 2 } : request} /></div>);
    settleConfirm(confirmId, true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(consumed).not.toHaveBeenCalledWith(1);
    if (change !== "unmount") expect(field).toHaveValue("# Unsaved work\n");
  });
});
