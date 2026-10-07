import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { ProjectPromptControl } from "./ProjectPromptControl";
import type { ProjectPromptProfile } from "../types";
import { updateProjectPromptOverrides } from "../lib/projectPromptProfiles";
import "../styles.css";

const props = { projectName: "Mythra", appPrompt: "", promptMode: "replace" as const, provider: "openai" as const, threadStarted: false, onSave: vi.fn(), onAppPromptSettings: vi.fn() };
afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

it("opens only on click, fades both ways and reverses without a flash", async () => {
  const view = render(<ProjectPromptControl {...props} />);
  const trigger = view.getByRole("button", { name: /Project instructions:/ });
  fireEvent.pointerOver(trigger, { pointerType: "mouse" });
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  const panel = view.getByRole("dialog");
  const entrance = panel.getAnimations()[0];
  entrance.pause(); entrance.currentTime = 110;
  expect(Number(getComputedStyle(panel).opacity)).toBeGreaterThan(0);
  expect(Number(getComputedStyle(panel).opacity)).toBeLessThan(1);
  act(() => entrance.finish());
  await waitFor(() => expect(getComputedStyle(panel).opacity).toBe("1"));
  fireEvent.click(view.getByText("Cancel"));
  expect(panel.isConnected).toBe(true);
  expect(panel.inert).toBe(true);
  expect(view.queryByRole("dialog")).toBeNull();
  expect(getComputedStyle(panel).pointerEvents).toBe("none");
  const exit = panel.getAnimations()[0];
  exit.pause(); exit.currentTime = 90;
  const reached = Number(getComputedStyle(panel).opacity);
  expect(reached).toBeGreaterThan(0);
  expect(reached).toBeLessThan(1);
  fireEvent.click(trigger);
  expect(view.getByRole("dialog")).toBe(panel);
  const reversal = panel.getAnimations()[0];
  reversal.pause(); reversal.currentTime = 0;
  expect(Number(getComputedStyle(panel).opacity)).toBeCloseTo(reached, 2);
  act(() => reversal.finish());
  await waitFor(() => expect(getComputedStyle(panel).opacity).toBe("1"));
  fireEvent.keyDown(document.body, { key: "Escape" });
  act(() => panel.getAnimations()[0].finish());
  await waitFor(() => expect(panel.isConnected).toBe(false));
});

it("honors reduced motion and still saves and dismisses on outside click", async () => {
  await commands.setStreamTestReducedMotion(true);
  const onSave = vi.fn();
  const view = render(<ProjectPromptControl {...props} onSave={onSave} />);
  const trigger = view.getByRole("button", { name: /Project instructions:/ });
  fireEvent.click(trigger);
  expect(view.getByRole("dialog").getAnimations()).toHaveLength(0);
  fireEvent.click(view.getByText("Use app prompt"));
  expect(onSave).toHaveBeenCalledWith(undefined, "replace");
  expect(view.container.querySelector(".project-prompt-popover")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(view.container.querySelector(".project-prompt-popover")).toBeNull();
});

it("opens the saved project prompt for a repair request and focuses its editor", async () => {
  await commands.setStreamTestReducedMotion(true);
  const profileProps = { profiles: [{ id: "review", name: "Review", prompt: "Use @review here.", mode: "replace" as const }], selectedProfileId: "review" };
  const view = render(<ProjectPromptControl {...props} {...profileProps} projectPrompt="Use @review here." openRequest={null} />);
  expect(view.queryByRole("dialog")).toBeNull();
  view.rerender(<ProjectPromptControl {...props} {...profileProps} projectPrompt="Use @review here." openRequest={{ name: "review", nonce: 1 }} />);
  const editor = await view.findByRole("textbox", { name: "Prompt for Mythra" });
  expect(view.getByRole("dialog", { name: "Project instructions for Mythra" })).toBeVisible();
  expect(editor).toBe(document.activeElement);
  expect(editor).toHaveValue("Use @review here.");
  expect(view.getByRole("combobox", { name: "Saved project profile" })).toHaveValue("review");
});

it("saves project profiles, switches their modes, updates them and cancels deletion in a real browser", async () => {
  await commands.setStreamTestReducedMotion(true);
  const initialProfiles: ProjectPromptProfile[] = [{ id: "review", name: "Review", prompt: "Use @review here.", mode: "append" }];
  function Harness() {
    const [overrides, setOverrides] = useState({ systemPrompt: "Existing", systemPromptProfiles: initialProfiles } as ReturnType<typeof updateProjectPromptOverrides>);
    return <ProjectPromptControl {...props} projectPrompt={overrides?.systemPrompt} promptMode={overrides?.systemPromptMode ?? "replace"}
      profiles={overrides?.systemPromptProfiles ?? []} selectedProfileId={overrides?.systemPromptProfileId}
      skills={[{ name: "review" }]} onSave={(prompt, mode, state) => setOverrides((previous) => updateProjectPromptOverrides(previous, prompt, mode, state))} />;
  }
  const view = render(<Harness />);
  const trigger = view.getByRole("button", { name: /Project instructions:/ });
  fireEvent.click(trigger);
  fireEvent.change(view.getByRole("combobox"), { target: { value: "review" } });
  expect(view.getByRole("textbox", { name: "Prompt for Mythra" })).toHaveValue("Use @review here.");
  expect(view.container.querySelector(".skill-prompt-token")).toHaveTextContent("@review");
  expect(view.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  fireEvent.click(view.getByRole("button", { name: "Save project prompt" }));
  fireEvent.click(trigger);
  expect(view.getByRole("combobox")).toHaveValue("review");
  fireEvent.change(view.getByRole("textbox", { name: "Prompt for Mythra" }), { target: { value: "Updated @review" } });
  fireEvent.click(view.getByRole("switch"));
  fireEvent.click(view.getByRole("button", { name: "Update profile" }));
  fireEvent.change(view.getByRole("textbox", { name: "Project profile name" }), { target: { value: "Revised review" } });
  fireEvent.click(view.getByRole("button", { name: "Rename profile" }));
  fireEvent.click(view.getByRole("button", { name: "Save project prompt" }));
  fireEvent.click(trigger);
  expect(view.getByRole("option", { name: "Revised review" })).toBeInTheDocument();
  expect(view.getByRole("textbox", { name: "Prompt for Mythra" })).toHaveValue("Updated @review");
  expect(view.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  fireEvent.click(view.getByRole("button", { name: "Delete profile" }));
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  fireEvent.click(trigger);
  expect(view.getByRole("option", { name: "Revised review" })).toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Delete profile" }));
  expect(view.getByRole("textbox", { name: "Prompt for Mythra" })).toHaveValue("Updated @review");
  fireEvent.click(view.getByRole("button", { name: "Save project prompt" }));
  fireEvent.click(trigger);
  expect(view.getByRole("textbox", { name: "Prompt for Mythra" })).toHaveValue("Updated @review");
  expect(view.getByRole("combobox")).toHaveValue("");
});

it("keeps profile actions reachable at 150% scale and preserves skill completion inside the scrollable panel", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ display: "block", height: "auto", overflow: "visible", width: 320, paddingTop: 120, zoom: 1.5 }}>
    <ProjectPromptControl {...props} projectPrompt="Use @review" profiles={[{ id: "review", name: "Review", prompt: "Use @review", mode: "replace" }]}
      selectedProfileId="review" skills={[{ name: "review" }]} />
  </div>);
  fireEvent.click(view.getByRole("button", { name: /Project instructions:/ }));
  const panel = view.getByRole("dialog");
  await waitFor(() => expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight));
  expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
  const editor = view.getByRole("textbox", { name: "Prompt for Mythra" });
  editor.scrollIntoView({ block: "nearest" });
  fireEvent.change(editor, { target: { value: "@rev" } });
  const completion = view.getByRole("listbox");
  expect(completion).toBeVisible();
  expect(completion.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(view.queryByRole("listbox")).toBeNull();
  expect(view.getByRole("dialog")).toBeVisible();
  const save = view.getByRole("button", { name: "Save project prompt" });
  save.scrollIntoView({ block: "nearest" });
  const rect = save.getBoundingClientRect();
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(rect.top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top);
  expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(save);
});

it("fits profile controls into a narrow available viewport beside a scaled trigger", async () => {
  await commands.setStreamTestReducedMotion(true);
  const zoom = 1.5;
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark"
    style={{ display: "block", height: "auto", overflow: "visible", paddingLeft: (window.innerWidth - 340) / zoom, width: 200, zoom }}>
    <ProjectPromptControl {...props} projectPrompt="Project instructions" profiles={[{ id: "a", name: "Review", prompt: "Project instructions", mode: "replace" }]}
      selectedProfileId="a" />
  </div>);
  fireEvent.click(view.getByRole("button", { name: /Project instructions:/ }));
  const panel = view.getByRole("dialog");
  await waitFor(() => expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth));
  expect(panel.getBoundingClientRect().width).toBeLessThan(340);
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  const save = view.getByRole("button", { name: "Save project prompt" });
  save.scrollIntoView({ block: "nearest" });
  const rect = save.getBoundingClientRect();
  expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(save);
});
