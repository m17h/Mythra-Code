import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { SkillLibrary } from "./SkillLibrary";
import { ConfirmDialogModal } from "./ConfirmDialogModal";
import { useConfirmStore } from "../lib/confirmDialog";
import type { LocalSkill } from "../lib/skills";
import "../styles.css";

const skills: LocalSkill[] = ["review", "release"].map((name) => ({
  name, defaultName: name, path: `/sol-cross-review/${name}.md`, relativePath: `${name}.md`, fileName: `${name}.md`,
  description: name, supportingMarkdownCount: 0, enabled: true,
}));

function ControlledPrompt() {
  const [text, setText] = useState("Prefix @rev suffix");
  return <div className="app-shell" style={{ width: 520, display: "block", marginTop: 220 }}>
    <SkillPromptEditor aria-label="Review prompt" value={text} skills={skills}
      onChange={(event) => setText(event.target.value)} />
    <output data-testid="controlled-value">{text}</output>
  </div>;
}
afterEach(() => {
  vi.unstubAllGlobals();
  useConfirmStore.setState({ queue: [] });
});

it("preserves suffix, caret and controlled React state through native completion Undo and Redo", async () => {
  render(<ControlledPrompt />);
  const field = screen.getByRole("textbox", { name: "Review prompt" }) as HTMLTextAreaElement;
  field.focus();
  field.setSelectionRange(11, 11);
  fireEvent.select(field);
  await page.getByRole("option", { name: /review/ }).click();
  expect(field.value).toBe("Prefix @review  suffix");
  expect(field.selectionStart).toBe(15);
  expect(field.selectionEnd).toBe(15);
  expect(screen.getByTestId("controlled-value").textContent).toBe(field.value);
  await act(async () => { expect(document.execCommand("undo")).toBe(true); });
  expect(field.value).toBe("Prefix @rev suffix");
  expect(screen.getByTestId("controlled-value").textContent).toBe(field.value);
  await act(async () => { expect(document.execCommand("redo")).toBe(true); });
  expect(field.value).toBe("Prefix @review  suffix");
  expect(screen.getByTestId("controlled-value").textContent).toBe(field.value);
});

it("retains unsaved Markdown when a navigation target is removed during discard confirmation", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const read = vi.fn(async (path: string) => `Source ${path}`);
  const consumed = vi.fn();
  const props: Parameters<typeof SkillLibrary>[0] = {
    folder: "/sol-cross-review", skills, removedSkills: [], busy: false, error: "",
    onChooseFolder: () => {}, onRefresh: () => {}, onImport: () => {}, onCreate: async () => true,
    onRead: read, onUpdate: async () => {}, onRename: () => true, onToggle: () => {},
    onRemove: async () => true, onRestore: async () => true, onOpenSkillRequestConsumed: consumed,
  };
  const tree = (next: typeof props) => <div className="app-shell"><SkillLibrary {...next} /><ConfirmDialogModal /></div>;
  const view = render(tree(props));
  await userEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
  await userEvent.fill(await screen.findByRole("textbox", { name: "Markdown for review" }), "Authored unsaved Markdown");
  const request = { path: skills[1].path, nonce: 381 };
  view.rerender(tree({ ...props, openSkillRequest: request }));
  await expect.element(page.getByRole("alertdialog", { name: "Discard your unsaved skill changes?" })).toBeVisible();
  view.rerender(tree({ ...props, openSkillRequest: request, skills: [skills[0]] }));
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.element(page.getByRole("textbox", { name: "Markdown for review" })).toHaveValue("Authored unsaved Markdown");
  expect(read).toHaveBeenCalledTimes(1);
  expect(consumed).toHaveBeenCalledWith(381);
  await expect.element(page.getByRole("alert")).toHaveTextContent("This skill is no longer in the selected skills folder.");
});
