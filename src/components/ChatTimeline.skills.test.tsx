import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTimeline, CompletedWorkDisclosure } from "./ChatTimeline";
import type { LocalSkill } from "../lib/skills";
import type { SkillReference } from "../types";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const skill: LocalSkill = {
  path: "/skills/review/SKILL.md", relativePath: "review/SKILL.md", fileName: "SKILL.md",
  defaultName: "review", name: "review", description: "Review changes", supportingMarkdownCount: 0, enabled: true,
};

describe("history skill links", () => {
  it("retains collapsed system-only dependency details through streaming and exact-path navigation", () => {
    const user = { id: "user", role: "user" as const, text: "Please inspect the change.", skillDependencies: skillDependencyFixture() };
    const skills = [skill];
    const onOpenSkill = vi.fn();
    const props = { activities: [], running: true, thinkingLabel: "Thinking", skills, onOpenSkill };
    const view = render(<ChatTimeline {...props} messages={[user, { id: "answer", role: "assistant", text: "Checking", streaming: true }]} />);
    const summary = screen.getByText("Skill context · 2 skills · 1 document");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    const link = screen.getByRole("link", { name: "@review" });
    fireEvent.click(link);
    expect(onOpenSkill).toHaveBeenCalledWith(skill.path);
    expect(screen.getByText("System: @review")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "checklist.md" })).toBeNull();
    view.rerender(<ChatTimeline {...props} messages={[user, { id: "answer", role: "assistant", text: "Checking the changes", streaming: true }]} />);
    expect(screen.getByText("Skill context · 2 skills · 1 document")).toBe(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("link", { name: "@review" })).toBe(link);
    expect(view.container.querySelector(".message.assistant .skill-dependency-details")).toBeNull();
  });
  it("links exact user references and preserves Markdown, original edit text, and assistant prose", () => {
    const onOpenSkill = vi.fn();
    const onEditMessage = vi.fn();
    const text = "Use @review, then **check tests**. Unknown @missing email x@review.test and @review/file stay plain.";
    const view = render(<ChatTimeline messages={[
      { id: "user", role: "user", text }, { id: "assistant", role: "assistant", text: "I used @review." },
    ]} activities={[]} running={false} thinkingLabel="Thinking" skills={[skill]} onOpenSkill={onOpenSkill} onEditMessage={onEditMessage} />);

    const link = screen.getByRole("link", { name: "@review" });
    fireEvent.click(link);
    expect(onOpenSkill).toHaveBeenCalledWith(skill.path);
    expect(view.container.querySelector("strong")).toHaveTextContent("check tests");
    expect(view.container.querySelector(".message.assistant .message-skill-mention")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEditMessage).toHaveBeenCalledWith(text);
  });

  it("retains code formatting for invoked references without nesting links in authored Markdown links", () => {
    const text = "Use @review\n\n```text\nTry @review\n```\n\n`Try @review` and [Try @review](https://example.com). **@review**";
    const view = render(<ChatTimeline messages={[{ id: "user", role: "user", text }]} activities={[]} running={false} thinkingLabel="Thinking" skills={[skill]} onOpenSkill={vi.fn()} />);
    expect(view.container.querySelectorAll(".message-skill-mention")).toHaveLength(3);
    expect(view.container.querySelector("pre code .message-skill-mention")).toHaveTextContent("@review");
    expect(view.container.querySelector("p > code .message-skill-mention")).toHaveTextContent("@review");
    expect(view.container.querySelector("a a")).toBeNull();
    expect(view.container.querySelector("strong .message-skill-mention")).toBeNull();
    expect(view.container.querySelector("pre code")).toHaveTextContent("Try @review");
    expect(view.container.querySelector("pre code")?.textContent).toBe("Try @review\n");
  });

  it("preserves escaped text and does not turn decoded entities or fabricated markup into app links", () => {
    const view = render(<ChatTimeline messages={[{ id: "user", role: "user", text: "Escaped \\* text &amp; then @review. Entity &#64;review and \\@review stay plain. <a data-skill-path='/evil'>@review</a>" }]} activities={[]} running={false} thinkingLabel="Thinking" skills={[skill]} onOpenSkill={vi.fn()} />);
    expect(view.container.querySelectorAll(".message-skill-mention")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "@review" })).toHaveAttribute("title", "Open @review in Settings · Skills");
    expect(view.container.querySelector("[data-skill-path='/evil']")).toBeNull();
  });

  it("retains mentions in continued Markdown lists and blockquotes", () => {
    const view = render(<ChatTimeline messages={[{ id: "user", role: "user", text: "- First line\n  use @review.\n\n> First quote line\n> use @review." }]} activities={[]} running={false} thinkingLabel="Thinking" skills={[skill]} onOpenSkill={vi.fn()} />);
    expect(view.container.querySelectorAll(".message-skill-mention")).toHaveLength(2);
    expect(view.container.querySelector("li .message-skill-mention")).toHaveTextContent("@review");
    expect(view.container.querySelector("blockquote .message-skill-mention")).toHaveTextContent("@review");
  });

  it("keeps source text unchanged when copying a message or a highlighted code block", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const text = "Use @review\n\n```\nTry @review\n```";
    render(<ChatTimeline messages={[{ id: "user", role: "user", text }]} activities={[]} running={false} thinkingLabel="Thinking" skills={[skill]} onOpenSkill={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Copy message"));
    expect(writeText).toHaveBeenLastCalledWith(text);
    fireEvent.click(screen.getByTitle("Copy code"));
    expect(writeText).toHaveBeenLastCalledWith("Try @review");
  });

  it("can inspect a disabled known skill, and removes the link when the library no longer knows it", () => {
    const props = { messages: [{ id: "user", role: "user" as const, text: "Use @review" }], activities: [], running: false, thinkingLabel: "Thinking", onOpenSkill: vi.fn() };
    const view = render(<ChatTimeline {...props} skills={[{ ...skill, enabled: false }]} />);
    const link = screen.getByRole("link", { name: "@review" });
    expect(link).toHaveAttribute("title", "Open @review in Settings · Skills (disabled)");
    fireEvent.click(link);
    expect(props.onOpenSkill).toHaveBeenCalledWith(skill.path);
    view.rerender(<ChatTimeline {...props} skills={[]} />);
    expect(screen.queryByRole("link", { name: "@review" })).toBeNull();
  });

  it("keeps captured references on their original path through alias reuse and selected-folder changes", () => {
    const onOpenSkill = vi.fn();
    const message = { id: "user", role: "user" as const, text: "Use @review", skillReferences: [{ start: 4, end: 11, name: "review", path: skill.path }], skillsFolder: "/skills" };
    const props = { messages: [message], activities: [], running: false, thinkingLabel: "Thinking", onOpenSkill };
    const view = render(<ChatTimeline {...props} skills={[{ ...skill, name: "renamed" }]} />);
    fireEvent.click(screen.getByRole("link", { name: "@review" }));
    expect(onOpenSkill).toHaveBeenCalledExactlyOnceWith(skill.path);
    view.rerender(<ChatTimeline {...props} skills={[{ ...skill, path: "/different/review/SKILL.md" }]} />);
    expect(screen.queryByRole("link", { name: "@review" })).toBeNull();
    expect(screen.getByTitle("@review is unavailable in the selected skills folder")).toHaveClass("message-skill-mention", "unavailable");
    expect(onOpenSkill).toHaveBeenCalledTimes(1);
  });

  it("does not retroactively invoke previously unknown references captured as an empty snapshot", () => {
    render(<ChatTimeline messages={[{ id: "user", role: "user", text: "Use @review", skillReferences: [] }]} activities={[]} running={false} thinkingLabel="Thinking" skills={[skill]} onOpenSkill={vi.fn()} />);
    expect(screen.queryByRole("link", { name: "@review" })).toBeNull();
    expect(document.querySelector(".message-skill-mention")).toBeNull();
  });

  it.each([null, "corrupt", {}, [null], [{ start: 4, end: 11, name: "review_", path: skill.path }]])("renders corrupt persisted metadata conservatively without fabricated links: %j", (metadata) => {
    const view = render(<ChatTimeline messages={[{ id: "user", role: "user", text: "Use @review", skillReferences: metadata as unknown as SkillReference[] }]} activities={[]} running={false} thinkingLabel="Thinking" skills={[skill]} onOpenSkill={vi.fn()} />);
    expect(screen.queryByRole("link", { name: "@review" })).toBeNull();
    expect(view.container).toHaveTextContent("Use @review");
    expect(view.container.querySelector(".message-skill-mention")).toBeNull();
  });

  it("keeps the same user link through assistant streaming and supports expanded historical user updates", () => {
    const user = { id: "user", role: "user" as const, text: "Use @review" };
    const skills = [skill];
    const onOpenSkill = vi.fn();
    const view = render(<ChatTimeline messages={[user, { id: "answer", role: "assistant", text: "Checking", streaming: true }]} activities={[]} running thinkingLabel="Thinking" skills={skills} onOpenSkill={onOpenSkill} />);
    const link = screen.getByRole("link", { name: "@review" });
    view.rerender(<ChatTimeline messages={[user, { id: "answer", role: "assistant", text: "Checking changes", streaming: true }]} activities={[]} running thinkingLabel="Thinking" skills={skills} onOpenSkill={onOpenSkill} />);
    expect(screen.getByRole("link", { name: "@review" })).toBe(link);
    view.unmount();
    render(<CompletedWorkDisclosure entries={[{ kind: "message", value: user }]} reveal skills={skills} onOpenSkill={onOpenSkill} />);
    fireEvent.click(screen.getByRole("link", { name: "@review" }));
    expect(onOpenSkill).toHaveBeenCalledWith(skill.path);
  });
});
