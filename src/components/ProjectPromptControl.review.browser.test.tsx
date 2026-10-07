import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { ProjectPromptControl } from "./ProjectPromptControl";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); await page.viewport(1400, 900); });

it("returns keyboard focus to the trigger after Escape and Cancel", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<ProjectPromptControl projectName="Project" appPrompt="" projectPrompt="Current instructions"
    promptMode="replace" provider="openai" threadStarted profiles={[]} onSave={vi.fn()} onAppPromptSettings={vi.fn()} />);
  const trigger = view.getByRole("button", { name: /Project instructions:/ });
  await userEvent.click(trigger);
  expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Prompt for Project" }));
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(trigger);
  await userEvent.keyboard("{Enter}");
  await userEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(trigger);
});

it("keeps all project profile actions within the viewport at supported UI scales", async () => {
  await commands.setStreamTestReducedMotion(true);
  for (const zoom of [1, 1.5]) {
    const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom, display: "block" }}>
      <header className="topbar"><div className="topbar-left"><ProjectPromptControl projectName="Project" appPrompt="Global"
        projectPrompt="Use @review" promptMode="append" provider="openai" threadStarted onSave={vi.fn()} onAppPromptSettings={vi.fn()}
        skills={[{ name: "review" }]} profiles={[{ id: "review", name: "Review", prompt: "Use @review", mode: "append" }]} selectedProfileId="review" />
      </div></header>
    </div>);
    fireEvent.click(view.getByRole("button", { name: /Project instructions:/ }));
    const panel = view.getByRole("dialog");
    const editor = view.getByRole("textbox", { name: "Prompt for Project" });
    editor.style.height = "700px";
    const rect = panel.getBoundingClientRect();
    expect(rect.bottom, `zoom ${zoom}`).toBeLessThanOrEqual(innerHeight);
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
    panel.scrollTop = panel.scrollHeight;
    const save = view.getByRole("button", { name: "Save project prompt" });
    expect(save.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
    view.unmount();
  }
});

it("keeps skill suggestions and dependency maps usable above a scrolling profile editor", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: 1.5, display: "block" }}>
    <header className="topbar"><div className="topbar-left"><ProjectPromptControl projectName="Project" appPrompt=""
      projectPrompt="Use @review now" promptMode="replace" provider="openai" threadStarted onSave={vi.fn()} onAppPromptSettings={vi.fn()}
      onAnalyzeSkillDependencies={vi.fn(async () => skillDependencyFixture(true))}
      skills={[{ name: "review" }]} profiles={[{ id: "review", name: "Review", prompt: "Use @review now", mode: "replace" }]} selectedProfileId="review" />
    </div></header>
  </div>);
  await userEvent.click(view.getByRole("button", { name: /Project instructions:/ }));
  const editor = view.getByRole("textbox", { name: "Prompt for Project" }) as HTMLTextAreaElement;
  await waitFor(() => expect(view.container.querySelector(".skill-prompt-token.is-blocked")).not.toBeNull());
  editor.focus();
  editor.setSelectionRange(8, 8);
  fireEvent.select(editor);
  const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "Meta" : "Control";
  await userEvent.keyboard(`{${mod}>}i{/${mod}}`);
  const map = await view.findByRole("dialog", { name: /@review/ }, { timeout: 2000 });
  await Promise.all(map.getAnimations().map((animation) => animation.finished));
  const rect = map.getBoundingClientRect();
  expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 10);
  expect(map.contains(hit)).toBe(true);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog", { name: /@review/ })).toBeNull());
  await userEvent.click(editor);
  await userEvent.keyboard("{End} @rev");
  const list = await view.findByRole("listbox", { name: "Skill suggestions" });
  const option = view.getByRole("option", { name: /review/ });
  const optionRect = option.getBoundingClientRect();
  expect(list.contains(document.elementFromPoint(optionRect.left + 10, optionRect.top + 10))).toBe(true);
  await userEvent.click(option);
  expect(editor.value).toBe("Use @review now @review ");
  expect(view.getByRole("dialog", { name: "Project instructions for Project" })).toBeVisible();
});
