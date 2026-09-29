import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type CSSProperties } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { Composer, resetDraftStoreForTests } from "./Composer";
import { ProjectPromptControl } from "./ProjectPromptControl";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import type { SkillDependencyReport } from "../types";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import "../styles.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
    setForcedColors(active: boolean): Promise<void>;
  }
}

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined), revealItemInDir: vi.fn(async () => undefined) }));

const skills = [
  { name: "review", path: "/skills/review/SKILL.md", description: "Review changes" },
  { name: "tests", path: "/skills/tests/SKILL.md", description: "Tests" },
  { name: "release", path: "/skills/release/SKILL.md", description: "Release" },
];
const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "Meta" : "Control";

function withRelease(report = skillDependencyFixture(true)): SkillDependencyReport {
  report.roots.push({ nodeId: "release", channel: "system", name: "release" });
  report.nodes.push({ id: "release", kind: "skill", name: "release", path: "/skills/release/SKILL.md", status: "loaded", characterCount: 12, depth: 0 });
  return report;
}

function Prompt({ initial, analyze, width = 520, zoom = 1, colorScheme = "dark" }: {
  initial: string; analyze: (text: string) => Promise<SkillDependencyReport>; width?: number; zoom?: number; colorScheme?: "light" | "dark";
}) {
  const [text, setText] = useState(initial);
  return <div className="app-shell" data-theme="mythra" data-color-scheme={colorScheme} style={{ width, height: "auto", overflow: "visible", display: "block", marginTop: 160, zoom }}>
    <SkillPromptEditor aria-label="Global prompt" value={text} skills={skills} rows={4} onAnalyze={analyze}
      onChange={(event) => setText(event.target.value)} />
    <input aria-label="Next control" />
    <span data-testid="theme-reference" style={{ background: "var(--panel-2)", color: "var(--red)" }}>Theme</span>
  </div>;
}

async function redToken(container: HTMLElement, name: string, selector = ".skill-prompt-token") {
  return vi.waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>(`${selector}.is-blocked`)].find((token) => token.textContent === `@${name}`);
    if (!found) throw new Error(`@${name} is not red yet`);
    return found;
  });
}

/** Keyboard-only specs must not inherit a resting pointer over a token. */
async function parkPointer() {
  await userEvent.hover(screen.getByTestId("theme-reference"));
}

async function hoverToken(token: HTMLElement, textarea: HTMLElement) {
  const rect = token.getClientRects()[0];
  const box = textarea.getBoundingClientRect();
  await userEvent.hover(textarea, { position: { x: rect.left - box.left + 6, y: rect.top - box.top + rect.height / 2 } });
}

/** Absence checks must outlast engine-queued selection and focus events. */
const frames = (count = 3) => new Promise<void>((resolve) => {
  const step = (left: number) => left ? requestAnimationFrame(() => step(left - 1)) : resolve();
  step(count);
});

/** Wait for a map and let its short entrance finish, so visibility checks
 * measure the settled layer instead of racing the fade. */
async function openMap(name: string | RegExp, scope: HTMLElement = document.body) {
  const map = await within(scope).findByRole("dialog", { name: typeof name === "string" ? new RegExp(`@${name}`) : name }, { timeout: 2000 });
  await Promise.all(map.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  expect(map).toBeVisible();
  return map;
}

const inspectors = () => document.querySelectorAll(".skill-reference-inspector");

type ModalProps = Parameters<typeof SettingsModal>[0];
const noop = () => {};
const asyncNoop = async () => {};
function settingsProps(overrides: Partial<ModalProps> = {}): ModalProps {
  return {
    open: true, initialSection: "prompts",
    settings: { ...DEFAULT_SETTINGS, systemPrompt: "Use @review", codexSystemPrompt: "Codex uses @release" },
    appUpdater: { phase: "idle", currentVersion: "1.19.0", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop },
    developerRuntimeUpdater: { status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop },
    account: null, runtimeStatus: null, openRouterReady: false,
    childAgentReadiness: { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false },
    githubStatus: { available: true, authenticated: false },
    onClose: noop, onSave: noop, onThemePreview: noop, onEffortSliderPreview: noop, onChatFontPreview: noop,
    onSignIn: asyncNoop, onRuntimeRequired: noop, onWorkspaceTools: noop, onOpenRouterChange: noop,
    onGitHubSignIn: asyncNoop, onGitHubRefresh: asyncNoop, onGitHubClone: async () => true, onError: noop,
    profiles: [], agents: [], actions: [], schedules: [], workflows: [], workflowRuns: [], projects: [],
    skillsFolder: "", skills: [], removedSkills: [], skillsBusy: false, skillsError: "", workspaceToolsAvailable: false,
    onProfiles: noop, onAgents: noop, onActions: noop, onSchedules: noop, onWorkflows: noop,
    onRunWorkflow: noop, onStopWorkflow: async () => true, onProjects: noop,
    onChooseSkillsFolder: noop, onRefreshSkills: noop, onImportSkills: noop, onCreateSkill: async () => true,
    onReadSkill: async () => "", onUpdateSkill: asyncNoop, onRenameSkill: () => true,
    onToggleSkill: noop, onRemoveSkill: async () => true, onRestoreSkill: async () => true,
    onOpenOnboarding: noop, ...overrides,
  };
}

afterEach(async () => {
  localStorage.clear();
  resetDraftStoreForTests();
  await commands.setForcedColors(false);
  await page.viewport(1400, 900);
});

describe("skill reference inspector", () => {
  it("opens the dependency map when a pointer rests on a red token over the native textarea", async () => {
    const view = render(<Prompt initial="Use @review now" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
    const token = await redToken(view.container, "review");
    const rect = token.getBoundingClientRect();
    const textarea = screen.getByRole("textbox", { name: "Global prompt" });
    // The mirror stays pointer-free: the native textarea owns every hit.
    expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)).toBe(textarea);
    expect(token).not.toHaveAttribute("title");
    await hoverToken(token, textarea);
    const map = await screen.findByRole("dialog", { name: /@review/ }, { timeout: 1500 });
    expect(map).toHaveTextContent("Missing file · @tests → checklist.md");
    expect(map).toHaveTextContent("Reference document was not found.");
    expect(map).toHaveTextContent("[Checklist](../references/checklist.md)");
    // Each row names its folder in text, not only in a hover title.
    const failed = map.querySelector<HTMLElement>(".sri-item.is-failed > .sri-row")!;
    expect(failed.querySelector(".sri-where")).toHaveTextContent("references");
    expect(failed).toHaveTextContent("checklist.md document in references");
    expect(token).toHaveClass("is-inspected");
    // Leaving the token (still over the textarea) closes the map.
    await userEvent.hover(textarea, { position: { x: 4, y: 4 } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("maps each reference's own graph instead of one global error", async () => {
    const view = render(<Prompt initial="Use @review and @release" analyze={vi.fn(async () => withRelease())} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" });
    await redToken(view.container, "review");
    const release = [...view.container.querySelectorAll<HTMLElement>(".skill-prompt-token")].find((token) => token.textContent === "@release")!;
    expect(release).not.toHaveClass("is-blocked");
    await hoverToken(release, textarea);
    const releaseMap = await screen.findByRole("dialog", { name: /@release/ });
    expect(releaseMap).toHaveTextContent("Resolves, but nothing is sent while @review is blocked.");
    expect(releaseMap).not.toHaveTextContent("checklist.md");
    expect(releaseMap.querySelector(".sri-item.is-held")).toHaveTextContent("Held");
    await hoverToken(await redToken(view.container, "review"), textarea);
    await waitFor(() => expect(screen.getByRole("dialog", { name: /@review/ })).toHaveTextContent("checklist.md"));
  });

  it("never shows an older graph for edited text", async () => {
    let finish: ((report: SkillDependencyReport) => void) | undefined;
    const analyze = vi.fn((text: string) => text === "Use @review"
      ? Promise.resolve(skillDependencyFixture(true))
      : new Promise<SkillDependencyReport>((resolve) => { finish = resolve; }));
    const view = render(<Prompt initial="Use @review" analyze={analyze} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" }) as HTMLTextAreaElement;
    await redToken(view.container, "review");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await userEvent.keyboard(" now");
    const token = view.container.querySelector<HTMLElement>(".skill-prompt-token")!;
    expect(token).not.toHaveClass("is-blocked");
    await hoverToken(token, textarea);
    const map = await screen.findByRole("dialog", { name: /@review/ });
    expect(map).toHaveTextContent("Checking");
    expect(map).not.toHaveTextContent("checklist.md");
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => finish!(skillDependencyFixture(false)));
    await waitFor(() => expect(map).toHaveTextContent("3 characters".replace("3", "103")));
    expect(map).not.toHaveTextContent("Missing file");
  });

  it("opens from caret navigation, inspects with the keyboard and returns to the same caret", async () => {
    const documentKeys = vi.fn();
    document.addEventListener("keydown", documentKeys);
    try {
      render(<Prompt initial="Use @review now" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
      const textarea = screen.getByRole("textbox", { name: "Global prompt" }) as HTMLTextAreaElement;
      await redToken(document.body, "review");
      await parkPointer();
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      // At the name's end the existing completion list owns the caret; one
      // step inside the name belongs to the inspector.
      await userEvent.keyboard("{End}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
      const map = await screen.findByRole("dialog", { name: /@review/ });
      expect(document.activeElement).toBe(textarea);
      const description = document.getElementById(textarea.getAttribute("aria-describedby")!.split(" ").at(-1)!)!;
      expect(description).toHaveTextContent("@review: blocked at @review → @tests → checklist.md. Reference document was not found.");
      await userEvent.keyboard(`{${mod}>}i{/${mod}}`);
      expect(map.contains(document.activeElement)).toBe(true);
      expect(textarea).toHaveValue("Use @review now");
      documentKeys.mockClear();
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(textarea);
      expect(documentKeys).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
      expect(textarea.selectionStart).toBe(9);
      // Returning focus restores the caret inside the token. WebKit reports
      // that restoration as a selection change; it must not reopen the map.
      await frames();
      expect(inspectors()).toHaveLength(0);
      await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
      const reopened = await openMap("review");
      expect(reopened).toHaveAttribute("data-origin", "caret");
      await userEvent.keyboard("{Escape}");
      await frames();
      expect(inspectors()).toHaveLength(0);
      expect(document.activeElement).toBe(textarea);
      expect(documentKeys).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
      await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
      await screen.findByRole("dialog", { name: /@review/ });
      // Tab stays native (to the existing dependency notice): the map is never a tab stop.
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(document.querySelector(".skill-dependency-notice"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      document.removeEventListener("keydown", documentKeys);
    }
  });

  it("does not open a map from the caret a refocused field restores", async () => {
    render(<Prompt initial="Use @review now" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" }) as HTMLTextAreaElement;
    await redToken(document.body, "review");
    await parkPointer();
    textarea.focus();
    textarea.setSelectionRange(15, 15);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    await openMap("review");
    screen.getByRole("textbox", { name: "Next control" }).focus();
    await waitFor(() => expect(inspectors()).toHaveLength(0));
    textarea.focus();
    await frames();
    expect(inspectors()).toHaveLength(0);
    expect(textarea.selectionStart).toBe(9);
    // Real navigation afterwards still opens it.
    await userEvent.keyboard("{ArrowLeft}");
    await openMap("review");
  });

  it("never resurfaces an older map when a completion list closes", async () => {
    const view = render(<Prompt initial="Use @review now" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" }) as HTMLTextAreaElement;
    // A hover map stays up while the pointer rests on its token...
    await hoverToken(await redToken(view.container, "review"), textarea);
    await openMap("review");
    textarea.focus();
    textarea.setSelectionRange(15, 15);
    // ...until a completion list takes over; closing that list must not
    // bring the hover map back without a fresh hover.
    await userEvent.keyboard(" @te");
    expect(await screen.findByRole("listbox", { name: "Skill suggestions" })).toBeVisible();
    expect(inspectors()).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await frames();
    expect(inspectors()).toHaveLength(0);
    // The same holds for the caret at a red name's end, which the list owns.
    await userEvent.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}");
    textarea.setSelectionRange(11, 11);
    await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
    expect(await screen.findByRole("listbox", { name: "Skill suggestions" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await frames();
    expect(inspectors()).toHaveLength(0);
    expect(textarea).toHaveValue("Use @review now");
  });

  it("marks a red token by shape, not only color, in forced colors", async () => {
    const view = render(<Prompt initial="Use @review now" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
    const token = await redToken(view.container, "review");
    await commands.setForcedColors(true);
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    const highlight = view.container.querySelector<HTMLElement>(".skill-prompt-highlight")!;
    expect(getComputedStyle(highlight).display).not.toBe("none");
    const style = getComputedStyle(token);
    // The native textarea keeps painting the text; the mirror adds only a wavy line.
    expect(style.color).toBe("rgba(0, 0, 0, 0)");
    expect(style.textDecorationLine).toBe("underline");
    expect(style.textDecorationStyle).toBe("wavy");
    expect(style.textDecorationColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("inspects from a finished name whose completion list is open", async () => {
    render(<Prompt initial="Use @review" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" }) as HTMLTextAreaElement;
    await redToken(document.body, "review");
    await parkPointer();
    textarea.focus();
    textarea.setSelectionRange(11, 11);
    await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
    expect(await screen.findByRole("listbox", { name: "Skill suggestions" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard(`{${mod}>}i{/${mod}}`);
    const map = await screen.findByRole("dialog", { name: /@review/ });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(map.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toHaveValue("Use @review");
    expect(textarea.selectionStart).toBe(11);
  });

  it("keeps native editing and Undo while a map is open", async () => {
    render(<Prompt initial="Use @review now" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" }) as HTMLTextAreaElement;
    await redToken(document.body, "review");
    await userEvent.click(textarea);
    textarea.setSelectionRange(15, 15);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    await screen.findByRole("dialog", { name: /@review/ });
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
    expect(textarea.selectionStart).toBe(9);
    expect(textarea.selectionEnd).toBe(11);
    await userEvent.keyboard("ew!");
    expect(textarea).toHaveValue("Use @review! now");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { expect(document.execCommand("undo")).toBe(true); });
    expect(textarea.value).not.toBe("Use @review! now");
  });

  it("opens from a click or tap that places the caret in a red token", async () => {
    const view = render(<Prompt initial="Use @review now" analyze={vi.fn(async () => skillDependencyFixture(true))} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" }) as HTMLTextAreaElement;
    const token = await redToken(view.container, "review");
    const rect = token.getClientRects()[0];
    const box = textarea.getBoundingClientRect();
    await userEvent.click(textarea, { position: { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 } });
    expect(textarea.selectionStart).toBeGreaterThan(4);
    expect(textarea.selectionStart).toBeLessThanOrEqual(11);
    await openMap("review");
    expect(document.activeElement).toBe(textarea);
  });

  it.each(["light", "dark"] as const)("keeps a long graph compact, scrollable and inside a narrow zoomed viewport in %s", async (colorScheme) => {
    await page.viewport(420, 560);
    const report = skillDependencyFixture(true);
    for (let index = 0; index < 48; index += 1) {
      const id = `missing-${index}`;
      report.nodes.push({ id, kind: "document", name: `${id}.txt`, path: `/skills/references/${id}.txt`, status: "blocked", characterCount: 0, depth: 2 });
      report.edges.push({ from: "tests", to: id, reference: `[Reference ${index}](../references/${id}.txt)` });
      report.issues.push({ code: "missing-file", rootName: "review", message: `Reference ${index} could not be read.`, chain: ["@review", "@tests", `../references/${id}.txt`], sourcePath: "/skills/tests/SKILL.md", reference: `[Reference ${index}](../references/${id}.txt)` });
    }
    const view = render(<Prompt initial={"Line\n".repeat(3) + "Use @review"} width={300} zoom={1.25} colorScheme={colorScheme} analyze={vi.fn(async () => report)} />);
    const textarea = screen.getByRole("textbox", { name: "Global prompt" });
    await hoverToken(await redToken(view.container, "review"), textarea);
    const map = await screen.findByRole("dialog", { name: /@review/ });
    const rect = map.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(innerWidth);
    expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
    expect(map).toHaveTextContent("48 more blocked");
    const body = map.querySelector<HTMLElement>(".sri-body")!;
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(map.scrollWidth).toBeLessThanOrEqual(map.clientWidth + 1);
    const reference = screen.getByTestId("theme-reference");
    expect(getComputedStyle(map).backgroundColor).toBe(getComputedStyle(reference).backgroundColor);
    expect(getComputedStyle(map.querySelector(".sri-reason")!).color).toBe(getComputedStyle(reference).color);
  });

  it("escapes clipped dialogs without top-layer support and keeps the live theme", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, writable: true, value: undefined });
    let view: ReturnType<typeof render> | undefined;
    try {
      await page.viewport(430, 640);
      view = render(<div style={{ height: 240, overflow: "hidden", transform: "translateY(0)" }}>
        <Prompt initial="Use @review" colorScheme="light" zoom={1.25} width={300} analyze={vi.fn(async () => skillDependencyFixture(true))} />
      </div>);
      const textarea = screen.getByRole("textbox", { name: "Global prompt" });
      await hoverToken(await redToken(view.container, "review"), textarea);
      const map = await screen.findByRole("dialog", { name: /@review/ });
      expect(map.parentElement).toBe(document.body);
      expect(map).not.toHaveAttribute("popover");
      expect(getComputedStyle(map).backgroundColor).toBe(getComputedStyle(screen.getByTestId("theme-reference")).backgroundColor);
      const rect = map.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
      expect(rect.right).toBeLessThanOrEqual(innerWidth);
    } finally {
      view?.unmount();
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "showPopover", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    }
  });

  it("uses the same inspector in the message composer", async () => {
    await page.viewport(430, 700);
    const onSend = vi.fn(async () => false);
    const view = render(<div className="app-shell" data-color-scheme="dark" style={{ width: 390, marginTop: 200 }}>
      <Composer threadKey="inspector" chatFont="system" running={false} queueing={false} canSteer={false}
        dropActive={false} placeholder="Ask anything" attachments={[]} controls={null}
        skills={skills.map((skill) => ({ ...skill, defaultName: skill.name, relativePath: "", fileName: "SKILL.md", supportingMarkdownCount: 0, enabled: true }))}
        onRemoveAttachment={() => {}} onPasteImages={() => {}} onSend={onSend} onSteer={async () => false}
        onStop={() => {}} onAnalyzeSkillDependencies={async () => {
          const report = skillDependencyFixture(true);
          report.roots[0].channel = "user";
          return report;
        }} />
    </div>);
    const textarea = screen.getByPlaceholderText("Ask anything");
    await userEvent.fill(textarea, "Use @review to inspect");
    const token = await redToken(view.container, "review", ".composer-skill-token");
    await hoverToken(token, textarea);
    const map = await screen.findByRole("dialog", { name: /@review/ });
    expect(map).toHaveTextContent("Missing file · @tests → checklist.md");
    expect(textarea).toHaveValue("Use @review to inspect");
    await userEvent.click(textarea);
    await userEvent.keyboard("{Escape}");
    expect(textarea).toHaveValue("Use @review to inspect");
  });
});

describe("skill reference inspector inside real owners", () => {
  const librarySkills = [...skills].map((skill) => ({ ...skill, defaultName: skill.name, relativePath: `${skill.name}/SKILL.md`, fileName: "SKILL.md", supportingMarkdownCount: 0, enabled: true }));

  it("closes before the project prompt popover on Escape", async () => {
    render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ paddingTop: 40 }}>
      <ProjectPromptControl projectName="Mythra" projectPrompt="Use @review now" promptMode="replace" appPrompt=""
        provider="openai" threadStarted={false} onSave={vi.fn()} onAppPromptSettings={vi.fn()} skills={skills}
        onAnalyzeSkillDependencies={vi.fn(async () => skillDependencyFixture(true))} />
    </div>);
    await userEvent.click(screen.getByRole("button", { name: /Project instructions:/ }));
    const popover = screen.getByRole("dialog", { name: "Project instructions for Mythra" });
    const textarea = within(popover).getByRole("textbox", { name: "Prompt for Mythra" }) as HTMLTextAreaElement;
    await redToken(popover, "review");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    textarea.setSelectionRange(15, 15);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    await openMap("review");
    await userEvent.keyboard("{Escape}");
    await frames();
    expect(inspectors()).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Project instructions for Mythra" })).toBe(popover);
    expect(document.activeElement).toBe(textarea);
    // From inside the map (keyboard inspection) too.
    await userEvent.keyboard("{ArrowLeft}");
    await openMap("review");
    await userEvent.keyboard(`{${mod}>}i{/${mod}}`);
    const map = await openMap("review");
    expect(map.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(inspectors()).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Project instructions for Mythra" })).toBe(popover);
    expect(document.activeElement).toBe(textarea);
    // With no map open, Escape belongs to the popover again.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project instructions for Mythra" })).toBeNull());
  });

  it("maps the composed provider prompt inside Settings without closing or clipping", async () => {
    await commands.setStreamTestReducedMotion(true);
    try {
      await page.viewport(900, 640);
      // Mirrors native resolution of the composed system prompt: the global
      // layer's broken @review blocks every provider layer that inherits it.
      const analyze = vi.fn(async (_message: string, system: string) => {
        const report = skillDependencyFixture(true);
        if (!system.includes("@review")) Object.assign(report, { roots: [], nodes: [], edges: [], issues: [] });
        return system.includes("@release") ? withRelease(report) : report;
      });
      const onClose = vi.fn();
      const modal = (open: boolean, scheme: "dark" | "light" = "dark", zoom = 1) =>
        <div className="app-shell" data-theme="mythra" data-color-scheme={scheme} style={{ zoom, "--ui-scale": zoom } as CSSProperties}>
          <SettingsModal {...settingsProps({ open, onClose, onAnalyzeSkillDependencies: analyze, skills: librarySkills })} />
          <span data-testid="theme-reference" style={{ background: "var(--panel-2)" }}>Theme</span>
        </div>;
      const view = render(modal(true));
      const settings = screen.getByRole("dialog", { name: "Settings" });
      const global = within(settings).getByRole("textbox", { name: "Global Mythra Code prompt" }) as HTMLTextAreaElement;
      const codex = within(settings).getByRole("textbox", { name: "Codex subscription prompt" }) as HTMLTextAreaElement;
      await redToken(settings, "review");
      await waitFor(() => expect(analyze).toHaveBeenCalledWith("", expect.stringMatching(/Use @review[\s\S]*Codex uses @release/)));

      // The provider layer's own reference resolves but is held upstream.
      const release = await vi.waitFor(() => {
        const found = [...settings.querySelectorAll<HTMLElement>(".skill-prompt-token")].find((token) => token.textContent === "@release");
        if (!found || !codex.parentElement!.contains(found)) throw new Error("no @release token yet");
        return found;
      });
      expect(release).not.toHaveClass("is-blocked");
      await hoverToken(release, codex);
      const held = await openMap("release");
      expect(held).toHaveTextContent("Resolves, but nothing is sent while @review is blocked.");
      expect(held).not.toHaveTextContent("checklist.md");
      // Not clipped by the modal's scrolling panes: the map is what is hit.
      const box = held.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(innerHeight);
      expect(held.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true);

      // Keyboard inspection in the global layer: focus and scrolling inside
      // the map never close Settings, and Escape peels one layer at a time.
      await userEvent.hover(settings, { position: { x: 12, y: 12 } });
      await waitFor(() => expect(inspectors()).toHaveLength(0));
      global.focus();
      global.setSelectionRange(9, 9);
      await userEvent.keyboard(`{${mod}>}i{/${mod}}`);
      const map = await openMap("review");
      expect(map.contains(document.activeElement)).toBe(true);
      const body = map.querySelector<HTMLElement>(".sri-body")!;
      body.scrollTop = body.scrollHeight;
      body.dispatchEvent(new Event("scroll"));
      await frames();
      expect(inspectors()).toHaveLength(1);
      // A theme and scale change while open keeps the live theme.
      view.rerender(modal(true, "light", 1.25));
      await frames();
      expect(getComputedStyle(map).backgroundColor).toBe(getComputedStyle(screen.getByTestId("theme-reference")).backgroundColor);
      const zoomed = map.getBoundingClientRect();
      expect(zoomed.right).toBeLessThanOrEqual(innerWidth);
      expect(zoomed.bottom).toBeLessThanOrEqual(innerHeight);
      await userEvent.keyboard("{Escape}");
      expect(inspectors()).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(global);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

      // Settings stays mounted while closed. A hover map open at close must
      // not survive it, nor reappear on reopen without a fresh hover.
      view.rerender(modal(true));
      await hoverToken(release, codex);
      await openMap("release");
      view.rerender(modal(false));
      await waitFor(() => expect(inspectors()).toHaveLength(0));
      view.rerender(modal(true));
      await frames(6);
      expect(inspectors()).toHaveLength(0);
    } finally {
      await commands.setStreamTestReducedMotion(false);
    }
  });
});
