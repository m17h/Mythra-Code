import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Composer, resetDraftStoreForTests } from "./Composer";
import { SkillLibrary } from "./SkillLibrary";
import type { LocalSkill } from "../lib/skills";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import { validSkillDependencyReport } from "../lib/skillDependencies";
import "../styles.css";

const skills: LocalSkill[] = ["review", "tests"].map((name) => ({
  name, defaultName: name, path: `/skills/${name}/SKILL.md`, relativePath: `${name}/SKILL.md`, fileName: "SKILL.md",
  description: `Instructions for ${name}`, supportingMarkdownCount: 1, enabled: true,
}));

afterEach(async () => {
  localStorage.clear();
  resetDraftStoreForTests();
  await page.viewport(1400, 900);
});

describe("nested dependencies across the editor and composer", () => {
  it.each(["light", "dark"] as const)("shows a nested unsupported Word reference with a red root and full reason in %s", async (colorScheme) => {
    await page.viewport(430, 700);
    const report = skillDependencyFixture(true);
    report.nodes[2] = { ...report.nodes[2], name: "manual.docx", path: "/skills/references/manual.docx" };
    report.edges[1].reference = "[Manual](../references/manual.docx)";
    report.issues = [{ code: "unsupported-document", message: "This local document format is not supported.", rootName: "review", chain: ["@review", "@tests", "references/manual.docx"], reference: report.edges[1].reference }];
    const view = render(<div className="app-shell" data-color-scheme={colorScheme} style={{ width: 390 }}>
      <Composer threadKey={`unsupported-${colorScheme}`} chatFont="system" running={false} queueing={false} canSteer={false}
        dropActive={false} placeholder="Ask anything" attachments={[]} controls={null} skills={skills}
        onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => false} onSteer={async () => false}
        onStop={() => {}} onAnalyzeSkillDependencies={async () => report} />
    </div>);
    await userEvent.fill(screen.getByPlaceholderText("Ask anything"), "Use @review to inspect the changes");
    expect(await screen.findByText("Turn blocked by skill dependencies")).toBeVisible();
    const token = view.container.querySelector<HTMLElement>(".composer-skill-token.is-blocked")!;
    expect(token).toHaveTextContent("@review");
    expect(getComputedStyle(token).color).not.toBe(getComputedStyle(view.container.querySelector("textarea")!).color);
    expect(screen.getByText("@review → @tests → references/manual.docx", { selector: ".skill-dependency-issue small" })).toBeVisible();
    expect(screen.getByText(/Only UTF-8/)).toBeVisible();
    expect(screen.getByText(/Only UTF-8/)).toHaveTextContent("PDF or Word extraction is not available");
    const summary = screen.getByText("Skill context · 2 skills · 1 document · blocked");
    summary.focus();
    await userEvent.keyboard("{Enter}");
    expect(view.container.querySelector(".skill-dependency-edges > li:last-child.is-blocked")).toHaveTextContent("[Manual](../references/manual.docx)");
    expect(screen.queryByRole("link", { name: "manual.docx" })).toBeNull();
  });
  it("contains a large blocked graph in scroll areas while keeping Send reachable at 480px height", async () => {
    await page.viewport(430, 480);
    const report = skillDependencyFixture(true);
    for (let index = 1; index < 128; index += 1) {
      const id = `missing-${index}`;
      const path = `/skills/references/${id}.txt`;
      report.nodes.push({ id, name: `${id}.txt`, kind: "document", path, status: "blocked", characterCount: 0, depth: 2 });
      report.edges.push({ from: "tests", to: id, reference: `[Reference ${index}](../references/${id}.txt)` });
      report.issues.push({ code: "missing-file", rootName: "review", message: `Reference document ${index} could not be read. Check the file and try again.`, chain: ["@review", "@tests", `references/${id}.txt`], sourcePath: "/skills/tests/SKILL.md", reference: `[Reference ${index}](../references/${id}.txt)` });
    }
    expect(validSkillDependencyReport(report)).toBeDefined();
    const view = render(<div className="app-shell" style={{ width: 390, height: 440, display: "flex", flexDirection: "column" }}>
      <Composer threadKey="large-blocked-preview" chatFont="system" running={false} queueing={false} canSteer={false}
        dropActive={false} placeholder="Ask anything" attachments={[]} controls={<button type="button">Model picker</button>} skills={skills}
        onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => false} onSteer={async () => false}
        onStop={() => {}} onAnalyzeSkillDependencies={async () => report} />
    </div>);
    await userEvent.fill(screen.getByPlaceholderText("Ask anything"), "Inspect the changes");
    expect(await screen.findByText("Turn blocked by skill dependencies")).toBeVisible();
    const notice = view.container.querySelector<HTMLElement>(".skill-dependency-notice")!;
    const assertContained = (element: HTMLElement, maximum: number) => {
      expect(element.getBoundingClientRect().height).toBeLessThanOrEqual(maximum + 1);
      expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
      expect(getComputedStyle(element).overflowY).toBe("auto");
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    };
    assertContained(notice, 144);
    const summary = screen.getByText("Skill context · 2 skills · 128 documents · blocked");
    summary.focus();
    await userEvent.keyboard("{Enter}");
    const body = view.container.querySelector<HTMLElement>(".skill-dependency-detail-body")!;
    assertContained(body, 154);
    expect(view.container.querySelectorAll(".skill-dependency-issue")).toHaveLength(128);
    expect(view.container.querySelectorAll(".skill-dependency-nodes > li")).toHaveLength(130);
    expect(screen.getByRole("region", { name: "Skill dependency errors" })).toBe(notice);
    expect(screen.getByRole("region", { name: "Skill dependency graph" })).toBe(body);
    notice.focus();
    expect(notice).toHaveFocus();
    expect(getComputedStyle(notice).outlineStyle).toBe("solid");
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(notice.scrollTop).toBeGreaterThan(0));
    body.focus();
    expect(body).toHaveFocus();
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(body.scrollTop).toBeGreaterThan(0));
    const send = screen.getByRole("button", { name: "Send" });
    const picker = screen.getByRole("button", { name: "Model picker" });
    expect(send.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
    expect(picker.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
    send.focus();
    expect(send).toHaveFocus();
    const rect = picker.getBoundingClientRect();
    expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(picker);
  });

  it.each(["light", "dark"] as const)("previews a failing unsaved local document in a usable narrow %s source dialog", async (colorScheme) => {
    await page.viewport(430, 800);
    const analyze = vi.fn(async () => skillDependencyFixture(true));
    const view = render(<div className="app-shell" data-color-scheme={colorScheme} style={{ width: 400, height: 750 }}>
      <div className="modal-backdrop settings-backdrop open"><div className="settings-modal" role="dialog" aria-label="Settings">
        <SkillLibrary folder="/skills" skills={skills} removedSkills={[]} busy={false} error=""
          onChooseFolder={() => {}} onRefresh={() => {}} onImport={() => {}} onCreate={async () => true}
          onRead={async () => "Use @tests"} onUpdate={async () => {}} onRename={() => true} onToggle={() => {}}
          onRemove={async () => true} onRestore={async () => true} onAnalyzeSkill={analyze} />
      </div></div>
    </div>);
    const guide = screen.getByText("How skill references work");
    guide.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText(/depth uses the shortest chain from a root/)).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    await userEvent.fill(field, "Use @tests\n[Checklist](../references/checklist.md)");
    expect(await screen.findByText("Turn blocked by skill dependencies")).toBeVisible();
    expect(analyze).toHaveBeenLastCalledWith(skills[0].path, "Use @tests\n[Checklist](../references/checklist.md)");
    expect(view.container.querySelector(".skill-prompt-token.is-blocked")).toHaveTextContent("@tests");
    const dialog = screen.getByRole("dialog", { name: "Edit @review" });
    const rect = dialog.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
    expect(rect.right).toBeLessThanOrEqual(innerWidth);
    expect(field.getBoundingClientRect().height).toBeGreaterThan(70);
    const save = screen.getByRole("button", { name: "Save skill" });
    expect(save.getBoundingClientRect().bottom).toBeLessThanOrEqual(rect.bottom);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
    await userEvent.click(screen.getByText("Skill dependencies · 2 skills · 1 document · blocked"));
    expect(screen.getByText("[Checklist](../references/checklist.md)", { selector: ".skill-dependency-edges code" })).toBeVisible();
  });

  it("shows system-only blocking context for an empty composer and keeps its notice within narrow bounds", async () => {
    await page.viewport(430, 800);
    const analyze = vi.fn(async () => skillDependencyFixture(true));
    const view = render(<div className="app-shell" style={{ width: 390, height: 650 }}>
      <Composer threadKey="system-only-preview" chatFont="system" running={false} queueing={false} canSteer={false}
        dropActive={false} placeholder="Ask anything" attachments={[]} controls={null} skills={skills}
        onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={async () => false} onSteer={async () => false}
        onStop={() => {}} onAnalyzeSkillDependencies={analyze} />
    </div>);
    expect(await screen.findByText("Turn blocked by skill dependencies")).toBeVisible();
    expect(analyze).toHaveBeenCalledExactlyOnceWith("");
    expect(screen.getByPlaceholderText("Ask anything")).toHaveValue("");
    const notice = view.container.querySelector<HTMLElement>(".skill-dependency-notice")!;
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth + 1);
    const summary = screen.getByText("Skill context · 2 skills · 1 document · blocked");
    summary.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("System: @review")).toBeVisible());
    expect(screen.getAllByText(/Prepared, not sent/)).toHaveLength(2);
  });
});
