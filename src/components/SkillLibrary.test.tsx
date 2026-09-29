import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../lib/skills";
import { SkillLibrary } from "./SkillLibrary";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";

const revealItemInDir = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));

const skill: LocalSkill = {
  path: "/skills/review.md",
  relativePath: "review.md",
  fileName: "review.md",
  defaultName: "review",
  name: "review",
  description: "Review code for correctness.",
  supportingMarkdownCount: 1,
  enabled: true,
};

const second: LocalSkill = {
  path: "/skills/release.md",
  relativePath: "release.md",
  fileName: "release.md",
  defaultName: "release",
  name: "release",
  description: "Cut a release.",
  supportingMarkdownCount: 0,
  enabled: false,
};

function renderLibrary(overrides: Partial<Parameters<typeof SkillLibrary>[0]> = {}) {
  const props: Parameters<typeof SkillLibrary>[0] = {
    folder: "/skills",
    skills: [skill],
    removedSkills: [],
    busy: false,
    error: "",
    onChooseFolder: vi.fn(),
    onRefresh: vi.fn(),
    onImport: vi.fn(),
    onCreate: vi.fn(async () => true),
    onRead: vi.fn(async () => "# Review\n\nReview code for correctness.\n"),
    onUpdate: vi.fn(async () => undefined),
    onRename: vi.fn(() => true),
    onToggle: vi.fn(),
    onRemove: vi.fn(async () => true),
    onRestore: vi.fn(async () => true),
    ...overrides,
  };
  return { props, ...render(<SkillLibrary {...props} />) };
}

const addButton = () => screen.getByRole("button", { name: "Add a new skill" });
const nameField = () => screen.getByLabelText("Skill name");
const instructionsField = () => screen.getByLabelText("Instructions");

async function openComposer() {
  fireEvent.click(addButton());
  return await screen.findByRole("button", { name: /Create skill/ });
}

function fillComposer(name = "release check", instructions = "Check the release notes.") {
  fireEvent.change(nameField(), { target: { value: name } });
  fireEvent.change(instructionsField(), { target: { value: instructions } });
}

describe("SkillLibrary", () => {
  it("checks unsaved Markdown and shows the failing nested reference in red diagnostics", async () => {
    const onAnalyzeSkill = vi.fn(async () => skillDependencyFixture(true));
    const view = renderLibrary({ onAnalyzeSkill, onRead: vi.fn(async () => "Use @tests") });
    fireEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    fireEvent.change(field, { target: { value: "Use @tests\n[Checklist](../references/checklist.md)" } });
    expect(await screen.findByText("Turn blocked by skill dependencies")).toBeInTheDocument();
    expect(onAnalyzeSkill).toHaveBeenLastCalledWith(skill.path, "Use @tests\n[Checklist](../references/checklist.md)");
    expect(view.container.querySelector(".skill-prompt-token.is-blocked")).toHaveTextContent("@tests");
    fireEvent.click(screen.getByText("Skill dependencies · 2 skills · 1 document · blocked"));
    expect(view.container.querySelector(".skill-dependency-edges .is-blocked")).toBeInTheDocument();
    expect(screen.getByText("@review → @tests → references/checklist.md", { selector: ".skill-dependency-issue small" })).toBeInTheDocument();
  });

  it("provides an accessible local reference guide with limits and stop behavior", async () => {
    renderLibrary();
    const guide = screen.getByText("How skill references work");
    fireEvent.click(guide);
    await waitFor(() => expect(guide.closest("details")).toHaveTextContent("120,000 Unicode characters"));
    expect(guide.closest("details")).toHaveTextContent("block the entire turn");
    expect(guide.closest("details")).toHaveTextContent("UTF-8 .md, .markdown, or .txt");
    expect(guide.closest("details")).toHaveTextContent("[Checklist](references/checklist.txt)");
    expect(guide.closest("details")).toHaveTextContent("PDF, Word, CSV, JSON");
    expect(guide.closest("details")).toHaveTextContent("do not extract");
    expect(guide.closest("details")?.querySelector("a")).toBeNull();
  });
  it("loads a requested editor under the application's StrictMode lifecycle", async () => {
    const setup = renderLibrary();
    setup.unmount();
    const onRead = vi.fn(async () => "# Review from source\n");
    render(<StrictMode><SkillLibrary {...setup.props} onRead={onRead} openSkillRequest={{ path: skill.path, nonce: 1 }} /></StrictMode>);
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    expect(field).toHaveValue("# Review from source\n");
    await waitFor(() => expect(field).toHaveFocus());
    expect(onRead).toHaveBeenCalledExactlyOnceWith(skill.path);
  });
  it("opens an exact requested skill, clears a hiding search, and focuses its Markdown", async () => {
    const consumed = vi.fn();
    const view = renderLibrary({ skills: [skill, second], onOpenSkillRequestConsumed: consumed });
    fireEvent.change(screen.getByRole("textbox", { name: "Search skills" }), { target: { value: "review" } });
    view.rerender(<SkillLibrary {...view.props} openSkillRequest={{ path: second.path, nonce: 1 }} />);
    const field = await screen.findByRole("textbox", { name: "Markdown for release" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Search skills" })).toHaveValue("");
    expect(view.props.onRead).toHaveBeenCalledWith(second.path);
    expect(consumed).toHaveBeenCalledWith(1);
    expect(view.container.querySelector(".skill-card-selected")).toHaveTextContent("@release");
  });

  it("reports a missing exact target without opening a same-name replacement", async () => {
    const view = renderLibrary({ openSkillRequest: { path: "/old/review.md", nonce: 1 } });
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer in the selected skills folder");
    expect(view.props.onRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores an earlier read when a newer exact navigation request selects another skill", async () => {
    let finishFirst!: (text: string) => void;
    const onRead = vi.fn((path: string) => path === skill.path
      ? new Promise<string>((resolve) => { finishFirst = resolve; })
      : Promise.resolve("# Release\n"));
    const view = renderLibrary({ skills: [skill, second], onRead, openSkillRequest: { path: skill.path, nonce: 1 } });
    expect(screen.getByRole("dialog", { name: "Edit @review" })).toBeInTheDocument();
    view.rerender(<SkillLibrary {...view.props} openSkillRequest={{ path: second.path, nonce: 2 }} />);
    expect(await screen.findByRole("textbox", { name: "Markdown for release" })).toHaveValue("# Release\n");
    finishFirst("# Stale review\n");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Markdown for release" })).toHaveValue("# Release\n"));
    expect(onRead.mock.calls.map(([path]) => path)).toEqual([skill.path, second.path]);
  });

  it("preserves an unsaved editor when an external request is declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const consumed = vi.fn();
    const view = renderLibrary({ skills: [skill, second], onOpenSkillRequestConsumed: consumed });
    fireEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const field = await screen.findByRole("textbox", { name: "Markdown for review" });
    fireEvent.change(field, { target: { value: "# Unsaved review\n" } });
    view.rerender(<SkillLibrary {...view.props} openSkillRequest={{ path: second.path, nonce: 1 }} />);
    await waitFor(() => expect(consumed).toHaveBeenCalledWith(1));
    expect(field).toHaveValue("# Unsaved review\n");
    expect(view.props.onRead).not.toHaveBeenCalledWith(second.path);
    confirm.mockRestore();
  });

  it("shows the existing filename-derived invocation name and app-only rename control", () => {
    const onRename = vi.fn(() => true);
    renderLibrary({ onRename });

    expect(screen.getByText("@review")).toBeInTheDocument();
    expect(screen.getByText(/1 supporting Markdown file/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename review" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Invocation name for review.md" }), { target: { value: "careful-review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill name" }));
    expect(onRename).toHaveBeenCalledWith("/skills/review.md", "careful-review");
  });

  it("keeps the rename editor open and the draft intact when the new name is rejected", () => {
    renderLibrary({ onRename: vi.fn(() => false), error: "Another skill already uses @taken." });

    fireEvent.click(screen.getByRole("button", { name: "Rename review" }));
    const field = screen.getByRole("textbox", { name: "Invocation name for review.md" });
    fireEvent.change(field, { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill name" }));

    expect(screen.getByRole("textbox", { name: "Invocation name for review.md" })).toHaveValue("taken");
    expect(screen.getByRole("alert")).toHaveTextContent("Another skill already uses @taken.");
  });

  it("toggles a skill without changing its source file", () => {
    const onToggle = vi.fn();
    renderLibrary({ onToggle });
    fireEvent.click(screen.getByRole("switch", { name: "Disable review" }));
    expect(onToggle).toHaveBeenCalledWith("/skills/review.md");
  });

  it("marks disabled skills and counts how many are enabled", () => {
    renderLibrary({ skills: [skill, second] });

    expect(screen.getByRole("switch", { name: "Enable release" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText(/of 2 enabled/)).toHaveTextContent("1 of 2 enabled");
  });

  it("reveals the folder and an individual skill source file", () => {
    renderLibrary();

    fireEvent.click(screen.getByRole("button", { name: "Show folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/skills");
    fireEvent.click(screen.getByRole("button", { name: "Show review in folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/skills/review.md");
  });

  it("loads and saves a skill's Markdown without leaving Mythra Code", async () => {
    const onRead = vi.fn(async () => "# Review\n\nReview code for correctness.\n");
    const onUpdate = vi.fn(async () => undefined);
    renderLibrary({ onRead, onUpdate });

    fireEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const editor = await screen.findByRole("dialog", { name: "Edit @review" });
    const markdown = await within(editor).findByRole("textbox", { name: "Markdown for review" });
    expect(onRead).toHaveBeenCalledWith("/skills/review.md");
    expect(markdown).toHaveValue("# Review\n\nReview code for correctness.\n");
    expect(markdown).toHaveFocus();

    fireEvent.change(markdown, { target: { value: "# Review\n\nCheck correctness and tests.\n" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save skill" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      "/skills/review.md",
      "# Review\n\nCheck correctness and tests.\n",
      "# Review\n\nReview code for correctness.\n",
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit @review" })).not.toBeInTheDocument());
  });

  it("keeps the skill editor and draft open when saving fails", async () => {
    renderLibrary({ onUpdate: vi.fn(async () => { throw new Error("permission denied"); }) });

    fireEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const markdown = await screen.findByRole("textbox", { name: "Markdown for review" });
    fireEvent.change(markdown, { target: { value: "# Revised\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("does not have permission");
    expect(markdown).toHaveValue("# Revised\n");
    expect(screen.getByRole("dialog", { name: "Edit @review" })).toBeInTheDocument();
  });

  it("asks before discarding unsaved skill Markdown", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderLibrary();

    fireEvent.click(screen.getByRole("button", { name: "Edit review skill" }));
    const markdown = await screen.findByRole("textbox", { name: "Markdown for review" });
    fireEvent.change(markdown, { target: { value: "# Unsaved\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Edit @review" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The confirmation now resolves through the async dialog helper.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit @review" })).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("asks whether to keep or delete the source when removing a skill", async () => {
    const onRemove = vi.fn(async () => true);
    renderLibrary({ onRemove });

    fireEvent.click(screen.getByRole("button", { name: "Remove review" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove @review?" });
    expect(dialog).toHaveTextContent("Choose whether to leave review.md in your skills folder or permanently delete that source file too. Other package and supporting files are always kept.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from Mythra Code" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("/skills/review.md", false));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("only deletes the source after the destructive confirmation", async () => {
    const onRemove = vi.fn(async () => true);
    renderLibrary({ onRemove });

    fireEvent.click(screen.getByRole("button", { name: "Remove review" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete source file too" }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("/skills/review.md", true));
  });

  it("keeps the removal choice open when the operation fails", async () => {
    renderLibrary({ onRemove: vi.fn(async () => false) });

    fireEvent.click(screen.getByRole("button", { name: "Remove review" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from Mythra Code" }));

    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Remove @review?" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows app-only removals and lets the user restore them", async () => {
    const onRestore = vi.fn(async () => true);
    renderLibrary({ skills: [], removedSkills: [skill], onRestore });

    expect(screen.getByText("Removed from Mythra Code")).toBeInTheDocument();
    expect(screen.getByText("1 kept on disk")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("/skills/review.md"));
  });

  it("traps focus inside the removal dialog", () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Remove review" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const destructive = screen.getByRole("button", { name: "Delete source file too" });
    expect(cancel).toHaveFocus();
    destructive.focus();
    fireEvent.keyDown(destructive, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });

  describe("creation editor", () => {
    it("stays collapsed behind a compact action until it is asked for", () => {
      renderLibrary();

      expect(addButton()).toBeInTheDocument();
      expect(screen.queryByLabelText("Skill name")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Create skill/ })).not.toBeInTheDocument();
    });

    it("opens on request, focuses the name field, and blocks creation until both fields are filled", async () => {
      renderLibrary();
      const create = await openComposer();

      expect(nameField()).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Add a new skill" })).not.toBeInTheDocument();
      expect(create).toBeDisabled();

      fireEvent.change(nameField(), { target: { value: "release check" } });
      expect(create).toBeDisabled();
      expect(screen.getByText("@release-check")).toBeInTheDocument();

      fireEvent.change(instructionsField(), { target: { value: "   " } });
      expect(create).toBeDisabled();

      fireEvent.change(instructionsField(), { target: { value: "Check the release notes." } });
      expect(create).toBeEnabled();
    });

    it("closes and clears the editor after a successful creation", async () => {
      const onCreate = vi.fn(async () => true);
      renderLibrary({ onCreate });

      const create = await openComposer();
      fillComposer();
      fireEvent.click(create);

      await waitFor(() => expect(addButton()).toBeInTheDocument());
      expect(onCreate).toHaveBeenCalledWith("release check", "Check the release notes.");
      expect(screen.queryByLabelText("Skill name")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Created “release check” in your skills folder.");
      await waitFor(() => expect(addButton()).toHaveFocus());

      // Reopening starts from a blank editor rather than the previous draft.
      await openComposer();
      expect(nameField()).toHaveValue("");
      expect(instructionsField()).toHaveValue("");
    });

    it("keeps the editor open with the typed values when creation fails", async () => {
      const onCreate = vi.fn(async () => false);
      const { rerender, props } = renderLibrary({ onCreate });

      const create = await openComposer();
      fillComposer();
      fireEvent.click(create);

      await waitFor(() => expect(onCreate).toHaveBeenCalled());
      expect(nameField()).toHaveValue("release check");
      expect(instructionsField()).toHaveValue("Check the release notes.");
      expect(screen.queryByRole("button", { name: "Add a new skill" })).not.toBeInTheDocument();

      // The reason reported by the host is shown inside the editor that failed.
      rerender(<SkillLibrary {...props} error="Could not create the skill: permission denied" />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Could not create the skill: permission denied");
      expect(within(screen.getByLabelText("New Markdown skill")).getByRole("alert")).toBe(alert);
    });

    it("does not mislabel a later library failure as a creation error", async () => {
      const onCreate = vi.fn(async () => false);
      const onRefresh = vi.fn();
      const { rerender, props } = renderLibrary({ onCreate, onRefresh });

      await openComposer();
      fillComposer();
      fireEvent.click(screen.getByRole("button", { name: /Create skill/ }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());

      rerender(<SkillLibrary {...props} error="Could not create the skill." />);
      expect(within(screen.getByLabelText("New Markdown skill")).getByRole("alert")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Rescan/ }));
      rerender(<SkillLibrary {...props} error="Could not rescan the skills folder." />);

      expect(onRefresh).toHaveBeenCalledOnce();
      expect(within(screen.getByLabelText("New Markdown skill")).queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Could not rescan the skills folder.");
      expect(nameField()).toHaveValue("release check");
    });

    it("keeps the editor open when the create call rejects outright", async () => {
      const onCreate = vi.fn(async () => { throw new Error("backend offline"); });
      renderLibrary({ onCreate });

      const create = await openComposer();
      fillComposer();
      fireEvent.click(create);

      await waitFor(() => expect(onCreate).toHaveBeenCalled());
      expect(nameField()).toHaveValue("release check");
      expect(screen.getByRole("button", { name: /Create skill/ })).toBeEnabled();
      expect(screen.getByRole("alert")).toHaveTextContent("Could not create this skill. Check the details and try again.");
    });

    it("clears and closes the editor on cancel without creating anything", async () => {
      const onCreate = vi.fn(async () => true);
      renderLibrary({ onCreate });

      await openComposer();
      fillComposer();
      const cancel = screen.getByRole("button", { name: "Cancel new skill" });
      expect(cancel).toHaveTextContent("Cancel");
      fireEvent.click(cancel);

      expect(onCreate).not.toHaveBeenCalled();
      expect(addButton()).toBeInTheDocument();
      expect(addButton()).toHaveFocus();

      await openComposer();
      expect(nameField()).toHaveValue("");
      expect(instructionsField()).toHaveValue("");
    });

    it("does not submit on a bare Enter in the instructions field but does on Ctrl+Enter", async () => {
      const onCreate = vi.fn(async () => true);
      renderLibrary({ onCreate });

      await openComposer();
      fillComposer();
      fireEvent.keyDown(instructionsField(), { key: "Enter" });
      expect(onCreate).not.toHaveBeenCalled();

      fireEvent.keyDown(instructionsField(), { key: "Enter", ctrlKey: true });
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    });

    it("ignores Ctrl+Enter while the form is incomplete", async () => {
      const onCreate = vi.fn(async () => true);
      renderLibrary({ onCreate });

      await openComposer();
      fireEvent.change(nameField(), { target: { value: "release check" } });
      fireEvent.keyDown(nameField(), { key: "Enter", ctrlKey: true });
      expect(onCreate).not.toHaveBeenCalled();
    });

    it("cancels on Escape without letting the surrounding dialog see the key", async () => {
      const onEscape = vi.fn();
      document.addEventListener("keydown", onEscape);
      try {
        renderLibrary();
        await openComposer();
        fillComposer();
        fireEvent.keyDown(nameField(), { key: "Escape" });

        expect(addButton()).toBeInTheDocument();
        expect(onEscape).not.toHaveBeenCalled();

        // Control: with the editor closed, Escape reaches the dialog as usual.
        fireEvent.keyDown(screen.getByLabelText("Search skills"), { key: "Escape" });
        expect(onEscape).toHaveBeenCalledOnce();
      } finally {
        document.removeEventListener("keydown", onEscape);
      }
    });

    it("clears an active search so a newly created skill is visible again", async () => {
      renderLibrary({ skills: [skill] });

      fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "nothing-matches" } });
      expect(screen.getByText(/No skills match/)).toBeInTheDocument();

      await openComposer();
      fillComposer();
      fireEvent.click(screen.getByRole("button", { name: /Create skill/ }));

      await waitFor(() => expect(screen.getByLabelText("Search skills")).toHaveValue(""));
      expect(screen.getByText("@review")).toBeInTheDocument();
    });
  });

  describe("library states", () => {
    it("filters by name, file, and description and offers a way back", () => {
      renderLibrary({ skills: [skill, second] });
      const search = screen.getByLabelText("Search skills");

      fireEvent.change(search, { target: { value: "release" } });
      expect(screen.getByText("@release")).toBeInTheDocument();
      expect(screen.queryByText("@review")).not.toBeInTheDocument();
      expect(screen.getByText("1 of 2 matching")).toBeInTheDocument();

      fireEvent.change(search, { target: { value: "correctness" } });
      expect(screen.getByText("@review")).toBeInTheDocument();

      fireEvent.change(search, { target: { value: "zzz" } });
      expect(screen.getByText(/No skills match “zzz”/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(search).toHaveValue("");
      expect(screen.getByText("@review")).toBeInTheDocument();
      expect(screen.getByText("@release")).toBeInTheDocument();
    });

    it("explains an empty folder and still offers import and creation", () => {
      renderLibrary({ skills: [] });

      expect(screen.getByText("No skills in this folder yet")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Import Markdown/ })).toBeInTheDocument();
      expect(addButton()).toBeInTheDocument();
    });

    it("reports an in-progress scan instead of claiming the folder is empty", () => {
      renderLibrary({ skills: [], busy: true });

      expect(screen.getByText("Scanning your skills folder…")).toBeInTheDocument();
      expect(screen.queryByText("No skills in this folder yet")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Rescan/ })).toBeDisabled();
    });

    it("still reports an unmatched search while a rescan is running", () => {
      renderLibrary({ skills: [skill], busy: true });

      fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "zzz" } });
      expect(screen.getByText(/No skills match “zzz”/)).toBeInTheDocument();
      expect(screen.queryByText("Scanning your skills folder…")).not.toBeInTheDocument();
    });

    it("asks for a folder before showing any library controls", () => {
      renderLibrary({ folder: "", skills: [] });

      expect(screen.getByRole("button", { name: "Choose folder" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Search skills")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add a new skill" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Rescan/ })).not.toBeInTheDocument();
    });

    it("announces a library-level failure once, outside the creation editor", () => {
      renderLibrary({ error: "Could not read the skills folder." });

      const alerts = screen.getAllByRole("alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent("Could not read the skills folder.");
    });

    it("keeps the reference and detection guarantees visible", () => {
      renderLibrary();

      expect(screen.getByText(/Renaming changes only the invocation name inside Mythra Code/)).toBeInTheDocument();
      expect(screen.getByText(/source changes only when you explicitly save it in the editor/)).toBeInTheDocument();
    });
  });
});
