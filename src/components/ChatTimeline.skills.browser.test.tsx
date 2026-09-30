import { StrictMode, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ChatTimeline } from "./ChatTimeline";
import { SkillLibrary, type OpenSkillRequest } from "./SkillLibrary";
import type { LocalSkill } from "../lib/skills";
import "../styles.css";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";

const skills: LocalSkill[] = ["first", "review"].map((name) => ({
  path: `/skills/${name}/SKILL.md`, relativePath: `${name}/SKILL.md`, fileName: "SKILL.md",
  name, defaultName: name, description: `Instructions for ${name}`, enabled: true, supportingMarkdownCount: 0,
}));

function Fixture({ opened, read }: { opened: (path: string) => void; read: (path: string) => Promise<string> }) {
  const [request, setRequest] = useState<OpenSkillRequest | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  return <div className="app-shell" style={{ height: 800 }}>
    <ChatTimeline messages={[{ id: "user", role: "user", text: "Please use @review." }]}
      activities={[]} running={false} thinkingLabel="Thinking" skills={skills}
      onOpenSkill={(path) => { opened(path); setRequest({ path, nonce: Date.now() }); setShowSettings(true); }} />
    {showSettings && <div className="modal-backdrop settings-backdrop open">
      <div className="settings-modal" role="dialog" aria-label="Settings">
        <SkillLibrary folder="/skills" skills={skills} removedSkills={[]} busy={false} error=""
          onChooseFolder={() => {}} onRefresh={() => {}} onImport={() => {}} onCreate={async () => true}
          onRead={read} onUpdate={async () => {}} onRename={() => true} onToggle={() => {}}
          onRemove={async () => true} onRestore={async () => true} openSkillRequest={request}
          onOpenSkillRequestConsumed={() => setRequest(null)} />
      </div>
    </div>}
  </div>;
}

describe("skill history navigation in the browser", () => {
  it.each(["light", "dark"] as const)("opens system-only dependency details by keyboard at narrow width in %s", async (colorScheme) => {
    await page.viewport(430, 800);
    const onOpenSkill = vi.fn();
    const report = skillDependencyFixture();
    const view = render(<div className="app-shell" data-color-scheme={colorScheme} style={{ width: 390, height: 650 }}>
      <ChatTimeline messages={[{ id: "user", role: "user", text: "Inspect the change.", skillDependencies: report }]}
        activities={[]} running={false} thinkingLabel="Thinking" skills={skills} onOpenSkill={onOpenSkill} />
    </div>);
    const summary = screen.getByText("Skill context · 2 skills · 1 document");
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    summary.focus();
    await userEvent.keyboard("{Enter}");
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("System: @review")).toBeVisible();
    expect(screen.getByText("/skills/references/checklist.md")).toBeVisible();
    expect(screen.queryByRole("link", { name: "checklist.md" })).toBeNull();
    const link = screen.getByRole("link", { name: "@review" });
    link.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenSkill).toHaveBeenCalledExactlyOnceWith(skills[1].path);
    const body = view.container.querySelector<HTMLElement>(".skill-dependency-detail-body")!;
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
    expect(body.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
    summary.focus();
    await userEvent.keyboard("{Enter}");
    expect(details).not.toHaveAttribute("open");
    await page.viewport(1400, 900);
  });
  it.each(["pointer", "keyboard"] as const)("opens the exact Markdown editor with %s and shows colored focusable references", async (input) => {
    const opened = vi.fn();
    const read = vi.fn(async (path: string) => `# ${path}\nExact selected instructions.\n`);
    const view = render(<StrictMode><Fixture opened={opened} read={read} /></StrictMode>);
    const link = screen.getByRole("link", { name: "@review" });
    expect(getComputedStyle(link).color).toBe("rgb(134, 205, 247)");
    if (input === "keyboard") {
      await userEvent.keyboard("{Tab}");
      link.focus();
      expect(link).toHaveFocus();
      expect(getComputedStyle(link).outlineStyle).toBe("solid");
      await userEvent.keyboard("{Enter}");
    } else await userEvent.click(link);

    expect(opened).toHaveBeenCalledExactlyOnceWith(skills[1].path);
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue(`# ${skills[1].path}\nExact selected instructions.\n`);
    expect(read).toHaveBeenCalledExactlyOnceWith(skills[1].path);
    expect(view.container.querySelector(".skill-card-selected")).toHaveTextContent("@review");
    const editor = screen.getByRole("dialog", { name: "Edit @review" });
    const rect = editor.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(100);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
  });
});
