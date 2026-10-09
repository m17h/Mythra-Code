import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SkillLibrary } from "./SkillLibrary";
import type { LocalSkill, OfficialSkill } from "../lib/skills";
import "../styles.css";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}), revealItemInDir: vi.fn(async () => {}) }));
const entry: OfficialSkill = { id: "anthropic-design", publisher: "anthropic", title: "Frontend design", description: "Build distinctive interfaces with thoughtful layout and typography.", repository: "anthropics/skills", path: "skills/frontend-design", revision: "1234567890abcdef1234567890abcdef12345678", license: "Apache-2.0", notes: "Requires file editing tools. This package contains Markdown instructions." };
const installed: LocalSkill = { path: "/skills/anthropic-design/SKILL.md", relativePath: "anthropic-design/SKILL.md", fileName: "SKILL.md", defaultName: "frontend-design", name: "frontend-design", description: entry.description, supportingMarkdownCount: 1, enabled: true, source: { catalogId: entry.id, publisher: "anthropic", repository: entry.repository, url: "https://github.com/anthropics/skills", revision: entry.revision, license: entry.license, modified: false } };
afterEach(async () => { await page.viewport(1400, 900); });
describe("download library in a browser", () => {
  it("supports keyboard install, vendor read-only preview, focus return and narrow layout", async () => {
    await page.viewport(430, 700);
    invoke.mockResolvedValue([entry]);
    const onInstall = vi.fn<(id: string, folder: string) => Promise<string>>(async () => installed.path);
    const onUpdate = vi.fn(async () => {});
    function Fixture() {
      const [skills, setSkills] = useState<LocalSkill[]>([]);
      return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 390, height: "auto", minHeight: 660, padding: 8 }}>
        <SkillLibrary folder="/skills" skills={skills} removedSkills={[]} busy={false} error=""
          onChooseFolder={() => {}} onRefresh={() => {}} onImport={() => {}} onCreate={async () => true}
          onRead={async () => "# Frontend design\n\nBuild a distinctive interface.\n"} onUpdate={onUpdate}
          onRename={() => true} onToggle={(path) => setSkills((current) => current.map((skill) => skill.path === path ? { ...skill, enabled: !skill.enabled } : skill))}
          onRemove={async () => true} onRestore={async () => true}
          onInstallOfficial={async (id, folder) => { await onInstall(id, folder); setSkills([installed]); return installed.path; }} />
      </div>;
    }
    const view = render(<Fixture />);
    const summary = screen.getByText("Download Anthropic & OpenAI skills");
    summary.focus();
    await userEvent.keyboard("{Enter}");
    const install = await screen.findByRole("button", { name: "Install Frontend design" });
    install.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onInstall).toHaveBeenCalledWith(entry.id, "/skills"));
    expect(await screen.findByText("Installed")).toBeVisible();
    const card = view.container.querySelector<HTMLElement>(".official-skill-card")!;
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    const open = screen.getByRole("button", { name: "View frontend-design skill" });
    await userEvent.click(open);
    const field = await screen.findByRole("textbox", { name: "Markdown for frontend-design" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute("readonly");
    await userEvent.keyboard("{Control>}a{/Control}Replacement text");
    expect(field).toHaveValue("# Frontend design\n\nBuild a distinctive interface.\n");
    expect(screen.queryByRole("button", { name: "Save skill" })).toBeNull();
    const modal = screen.getByRole("dialog", { name: "View @frontend-design" });
    expect(modal.scrollWidth).toBeLessThanOrEqual(modal.clientWidth + 1);
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(open).toHaveFocus());
    expect(onUpdate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("switch", { name: "Disable frontend-design" }));
    expect(screen.getByRole("switch", { name: "Enable frontend-design" })).toHaveAttribute("aria-checked", "false");
  });
});
