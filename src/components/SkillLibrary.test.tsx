import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../lib/skills";
import { SkillLibrary } from "./SkillLibrary";

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
    busy: false,
    error: "",
    onChooseFolder: vi.fn(),
    onRefresh: vi.fn(),
    onImport: vi.fn(),
    onCreate: vi.fn(async () => true),
    onRename: vi.fn(() => true),
    onToggle: vi.fn(),
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

      expect(screen.getByText(/Renaming changes only the invocation name inside OpenKiwi/)).toBeInTheDocument();
      expect(screen.getByText(/Source files are never rewritten/)).toBeInTheDocument();
    });
  });
});
