import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { Check, Folder } from "lucide-react";
import { themeColorScheme, THEMES } from "../lib/appConfig";
import { EMPTY_REVIEW_DIFF } from "../lib/gitDiff";
import type { StudioTab } from "../lib/studioTabs";
import type { ThemeName } from "../types";
import { AnimatedMythraLogo } from "./AnimatedMythraLogo";
import { ModelPowerControl } from "./ModelPowerControl";
import { MythraMark } from "./MythraMark";
import { OnboardingModal } from "./OnboardingModal";
import { StudioDock } from "./StudioDock";
import { ThreadProviderControl } from "./ThreadProviderControl";
import "../styles.css";
import "../styles/lumen/index.css";
// Exercise component CSS arriving after the shell, as it does on lazy loading.
import "./git-workflow.css";
import "./Feedback.css";

// Focused checks for the Lumen redesign (docs/experiments/opus-ui-overhaul.md).
// Everything renders inside a fully attributed shell, which is the scope every
// Lumen rule requires.

vi.mock("./XtermPanel", () => ({ XtermPanel: () => null }));

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

function Shell({ theme = "mythra", children }: { theme?: ThemeName; children: React.ReactNode }) {
  return <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ display: "block", height: "auto" }}>{children}</div>;
}

function luminance(color: string) {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(first: string, second: string) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function composite(color: string, backdrop: string) {
  const values = color.match(/[\d.]+/g)!.map(Number);
  if (color.startsWith("color(srgb")) for (let i = 0; i < 3; i++) values[i] *= 255;
  const base = backdrop.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const alpha = values[3] ?? 1;
  return `rgb(${base.map((value, i) => values[i] * alpha + value * (1 - alpha)).join(", ")})`;
}

function renderedSurface(element: Element): string {
  const parent = element.parentElement ? renderedSurface(element.parentElement) : "rgb(255, 255, 255)";
  return composite(getComputedStyle(element).backgroundColor, parent);
}

const noop = () => undefined;

it("keeps lazy Git filter buttons and tags square-rounded without changing status dots", () => {
  const view = render(<Shell>
    <div className="git-remote-actions"><button>Push <b>2</b></button></div>
    <span className="git-change-chip">Untracked</span>
    <div className="git-pr-filters"><button className="active">Open</button></div>
    <span className="git-pr-row-tags"><em>Draft</em></span>
    <i className="feedback-chip-stale" />
    <i className="provider-dot" />
  </Shell>);
  for (const [selector, expectedRadius] of [[".git-remote-actions b", "6px"], [".git-change-chip", "6px"], [".git-pr-filters button", "10px"], [".git-pr-row-tags em", "6px"]]) {
    const element = view.container.querySelector(selector)!;
    expect(getComputedStyle(element).borderTopLeftRadius, selector).toBe(expectedRadius);
  }
  for (const selector of [".feedback-chip-stale", ".provider-dot"]) {
    expect(getComputedStyle(view.container.querySelector(selector)!).borderTopLeftRadius, selector).toBe("50%");
  }
});

it.each(THEMES.map((theme) => theme.id))("keeps New thread quiet when idle, hovered, focused and disabled in %s", async (theme) => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<Shell theme={theme}>
    <button className="new-thread-button"><span>New thread</span><kbd>⌘+N</kbd></button>
  </Shell>);
  const button = view.getByRole("button", { name: /New thread/ }) as HTMLButtonElement;
  const checkQuiet = () => {
    const style = getComputedStyle(button);
    expect(style.backgroundImage).toBe("none");
    expect(getComputedStyle(button, "::before").backgroundImage).toBe("none");
    expect(style.filter).toBe("none");
    const surface = renderedSurface(button);
    expect(contrast(composite(style.color, surface), surface)).toBeGreaterThanOrEqual(4.5);
  };
  checkQuiet();
  await userEvent.hover(button);
  checkQuiet();
  button.focus();
  expect(button).toHaveFocus();
  checkQuiet();
  button.disabled = true;
  expect(button).toBeDisabled();
  expect(Number(getComputedStyle(button).opacity)).toBeLessThan(1);
});

function Dock() {
  const [tab, setTab] = useState<StudioTab>("files");
  return (
    <Shell>
      <div style={{ display: "flex", height: 760 }}>
        <StudioDock
          open tab={tab} onTab={setTab} activeThread={false} reviewDiff={EMPTY_REVIEW_DIFF} agents={[]}
          terminalOutput={{} as never} terminalRunning={false} terminalRunningCommand="" terminalRunningElsewhere={[]}
          commandsReadOnly={false} checkpoints={[]} attachments={[]} usage={null}
          accountUsage={{ label: "Fixture account", summary: "Fixture usage" }} skills={[]} mcpServers={[]}
          gitOutput="" gitCommitSuccess="" gitCommitBusy={false} gitRepositoryState="ready" gitInitializing={false}
          githubAuthenticated={false} githubRepoStatus={null} githubRepoError="" gitActionsReadOnly={false}
          defaultRepositoryName="" promptAudit={[]} projectActions={[]} workflows={[]} workflowRuns={[]}
          onClose={noop} onRefreshDiff={noop} onReview={noop} onOpenAgent={noop} onStopAgent={noop} onRunTerminal={noop}
          onStopTerminal={noop} onClearTerminal={noop} onTerminalInput={noop} onTerminalResize={noop} onCheckpoint={noop}
          onFork={noop} onCheckpointRestore={noop} onCheckpointAccept={noop} onCheckpointPreview={noop} onCheckpointDelete={noop}
          onRollback={noop} onWorktreeReview={noop} onWorktreeApply={noop} onWorktreeMerge={noop} onWorktreeReveal={noop}
          onWorktreeRefresh={noop} onWorktreeRemove={noop} onWorktreeRecreate={noop} onWorktreeContinueShared={noop}
          onAddAttachment={noop} onRemoveAttachment={noop} onRefreshUsage={noop} onCompact={noop} onRefreshTools={noop}
          onGitAction={noop} onInitializeGit={noop} onGitHubAttach={noop} onGitHubCreate={noop} onOpenGitHubSettings={noop}
          onGitPathAction={noop} onAttachPath={noop} onProjectAction={noop} onRunWorkflow={noop} onStopWorkflow={noop}
          onOpenWorkflowRun={noop} onToggleSkill={noop} onConnectMcp={noop}
        />
      </div>
    </Shell>
  );
}

it("puts the workbench rail on the outer edge and slides the indicator onto the selected tab", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<Dock />);
  const tablist = screen.getByRole("tablist", { name: "Workspace tools" });
  const panel = screen.getByRole("tabpanel");
  expect(tablist.getBoundingClientRect().left).toBeGreaterThanOrEqual(panel.getBoundingClientRect().right - 1);
  const indicator = view.container.querySelector<HTMLElement>(".studio-tab-indicator")!;
  expect(indicator).toHaveAttribute("aria-hidden", "true");
  expect(["none", "normal"]).toContain(getComputedStyle(indicator, "::after").content);
  expect(getComputedStyle(indicator).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  // Keyboard navigation still works and the indicator lands on each tab.
  for (const name of ["Review", "Agents", "Terminal", "Checkpoints"]) {
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    const selected = screen.getByRole("tab", { name: `${name} workspace tool` });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(Math.abs(indicator.getBoundingClientRect().top - selected.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
  }
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  // Reduced motion: the indicator jumps rather than gliding.
  expect(getComputedStyle(indicator).transitionDuration).toMatch(/^0s/);
});

it("glides the indicator and deals panel content in when motion is allowed", async () => {
  const view = render(<Dock />);
  const indicator = view.container.querySelector<HTMLElement>(".studio-tab-indicator")!;
  expect(parseFloat(getComputedStyle(indicator).transitionDuration)).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("tab", { name: "Usage workspace tool" }));
  const header = view.container.querySelector<HTMLElement>(".studio-panel > .studio-header")!;
  expect(getComputedStyle(header).animationName).toBe("lm-rise-sm");
});

function Landing({ theme = "mythra", width = 1080, height = 700 }: { theme?: ThemeName; width?: number; height?: number }) {
  return (
    <Shell theme={theme}>
      <div style={{ width, height, display: "flex", flexDirection: "column" }}>
        <div className="conversation">
          <section className="thread-empty-state" data-testid="welcome">
            {/* Same order as App.tsx: the logo is a direct child, no backdrop. */}
            <AnimatedMythraLogo />
            <h1>What should we build?</h1>
            <p>This thread works inside Fixture project. Commands and file changes start in that project folder.</p>
            <div className="trust-strip"><span><Check size={13} /> No app-added system prompt</span><span><Check size={13} /> Local project access</span><span><Check size={13} /> Approval controls</span></div>
            <div className="isolation-choice"><button className="active"><Folder size={15} /><span><strong>Shared project</strong><small>Work directly in Fixture project</small></span></button><button><Folder size={15} /><span><strong>Isolated worktree</strong><small>Private branch; apply or<br />merge when ready</small></span></button></div>
            <div className="empty-state-actions"><button>Browse files</button><button>Terminal</button><button>Review changes</button></div>
          </section>
        </div>
      </div>
    </Shell>
  );
}

it.each(THEMES)("keeps the $id settings preview aligned with Opus's actual palette", ({ id, swatches }) => {
  const view = render(<Shell theme={id}>
    {["--lm-canvas", "--panel", "--green"].map((token, index) => <div key={token}>
      <span data-testid={`actual-${index}`} style={{ color: `var(${token})` }} />
      <span data-testid={`preview-${index}`} style={{ color: swatches[index] }} />
    </div>)}
  </Shell>);
  for (let i = 0; i < swatches.length; i++) {
    expect(getComputedStyle(view.getByTestId(`preview-${i}`)).color)
      .toBe(getComputedStyle(view.getByTestId(`actual-${i}`)).color);
  }
});

it("centres the Lumen landing without scrolling and shows the logo with nothing drawn behind it", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<Landing />);
  const panel = view.getByTestId("welcome");
  expect(panel.scrollHeight).toBe(panel.clientHeight);
  const rect = panel.getBoundingClientRect();
  const topGap = panel.firstElementChild!.getBoundingClientRect().top - rect.top;
  const bottomGap = rect.bottom - panel.lastElementChild!.getBoundingClientRect().bottom;
  expect(Math.abs(topGap - bottomGap)).toBeLessThan(1);
  // Morgan's feedback: the added halo/rings read as a bug. The logo is the
  // panel's first child, and neither it nor its container paints a backdrop.
  const logoRoot = view.container.querySelector<HTMLElement>(".mythra-logo")!;
  expect(logoRoot.parentElement).toBe(panel);
  expect(view.container.querySelector(".landing-halo, .landing-hero")).toBeNull();
  for (const element of [panel, logoRoot]) expect(getComputedStyle(element).backgroundImage).toBe("none");
  const logo = view.getByRole("button", { name: /Mythra/i });
  const box = logo.getBoundingClientRect();
  expect(logo.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true);
  // No context chip (Morgan: redundant) and no placeholder gap: the heading
  // follows directly under the logo.
  expect(view.container.querySelector(".landing-eyebrow")).toBeNull();
  const heading = view.getByRole("heading", { name: "What should we build?" });
  expect(heading.getBoundingClientRect().top - logoRoot.getBoundingClientRect().bottom).toBeLessThan(32);
});

it.each([
  { width: 710, height: 350 },
  { width: 510, height: 300 },
])("keeps every Lumen landing item reachable in a constrained $width x $height panel", async ({ width, height }) => {
  await page.viewport(980, 680);
  await commands.setStreamTestReducedMotion(true);
  const view = render(<Landing width={width} height={height} />);
  const panel = view.getByTestId("welcome");
  expect(getComputedStyle(panel).overflowY).toBe("auto");
  expect(panel.firstElementChild!.getBoundingClientRect().top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top);
  panel.scrollTop = panel.scrollHeight;
  await expect.poll(() => panel.lastElementChild!.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom);
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
});

it("stages the landing entrance only when motion is allowed and never animates the logo element", async () => {
  const view = render(<Landing />);
  const heading = view.getByRole("heading", { name: "What should we build?" });
  expect(getComputedStyle(heading).animationName).toBe("lm-rise");
  expect(getComputedStyle(view.container.querySelector(".mythra-logo")!).animationName).toBe("none");
  await commands.setStreamTestReducedMotion(true);
  expect(getComputedStyle(heading).animationName).toBe("none");
});

it("lights the active thread-type segment and keeps both labels on one line in a narrow navigator", () => {
  const view = render(<Shell>
    <aside className="sidebar open" style={{ width: 236 }}>
      <div className="sidebar-section threads-section">
        <div className="section-label-row">
          <span className="section-label">Threads</span>
          <div className="thread-kind-switch" role="group" aria-label="Thread type"><button className="active">Main <span>12</span></button><button>Sub-agents <span>30</span></button></div>
        </div>
      </div>
    </aside>
  </Shell>);
  const [main, subagents] = view.getAllByRole("button");
  expect(getComputedStyle(main).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(subagents).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(contrast(getComputedStyle(main).color, renderedSurface(main))).toBeGreaterThanOrEqual(4.5);
  for (const button of [main, subagents]) expect(button.getBoundingClientRect().height).toBeLessThanOrEqual(24);
  const row = view.container.querySelector(".section-label-row")!.getBoundingClientRect();
  expect(view.getByRole("group", { name: "Thread type" }).getBoundingClientRect().right).toBeLessThanOrEqual(row.right + 1);
});

it("keeps user bubbles full-width in their single column even in a narrow chat column", () => {
  // Regression: Lumen's two-column message grid must not leave a user turn
  // (whose avatar is hidden) squeezed into the 30px avatar track.
  const view = render(<Shell>
    <div style={{ width: 420 }}>
      <div className="timeline-entry timeline-entry-message"><article className="message user"><div className="message-avatar"><span>You</span></div><div className="message-body"><div className="message-text">Tidy the settings sheet and make the tests pass again.</div></div></article></div>
      <div className="timeline-entry timeline-entry-message"><article className="message assistant"><div className="message-avatar provider-openai"><span>AI</span></div><div className="message-body">A reply that runs flush beside its orb.</div></article></div>
    </div>
  </Shell>);
  const [userBody, assistantBody] = view.container.querySelectorAll<HTMLElement>(".message-body");
  expect(userBody.getBoundingClientRect().width).toBeGreaterThan(200);
  expect(userBody.getBoundingClientRect().height).toBeLessThan(90);
  expect(assistantBody.getBoundingClientRect().left).toBeGreaterThan(view.container.querySelector<HTMLElement>(".message.assistant .message-avatar")!.getBoundingClientRect().right);
});

it.each(["mythra", "atari", "daylight"] as const)("keeps disabled provider and model triggers on the same geometry in %s", (theme) => {
  // The disabled state is hard to reach in the real App (it follows a running
  // turn), so it is checked with the real controls inside a composer here; the
  // live idle/hover/focus/expanded/sign-in states are covered against the
  // real App in App.header.browser.test.tsx.
  const view = render(<Shell theme={theme}>
    <div className="composer">
      <ModelPowerControl model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} signedIn disabled onModel={noop} onEffort={noop} onFast={noop}
        providerControl={<ThreadProviderControl provider="openai" defaultProvider="openai" threadStarted={false} disabled onProvider={noop} onDefaultSettings={noop} />} />
    </div>
  </Shell>);
  const provider = view.container.querySelector<HTMLElement>(".provider-pill")!;
  const model = view.container.querySelector<HTMLElement>(".model-picker-trigger")!;
  expect(provider).toBeDisabled();
  expect(model).toBeDisabled();
  const read = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return [Math.round(element.getBoundingClientRect().height), style.borderTopLeftRadius, style.borderTopWidth, style.borderTopStyle, style.backgroundColor, style.opacity];
  };
  expect(read(provider)).toEqual(read(model));
  expect(Number(getComputedStyle(provider).opacity)).toBeLessThan(1);
});

/* ---- Onboarding provider tiles: logo and name only (Morgan) ---- */

it.each([
  { theme: "mythra" as ThemeName, width: 1400, height: 900 },
  { theme: "atari" as ThemeName, width: 760, height: 560 },
])("shows provider tiles as logo and name with a corner readiness dot ($theme, $width x $height)", async ({ theme, width, height }) => {
  await page.viewport(width, height);
  await commands.setStreamTestReducedMotion(true);
  const view = render(<Shell theme={theme}>
    <OnboardingModal open runtimeStatus={{ available: true, source: "Codex CLI", path: "/usr/local/bin/codex", version: "1.0.0", compatible: true, warning: null }}
      account={null} openRouterReady skillsFolder="" onComplete={noop} onThemeChange={noop} onOpenSettings={noop} onChooseSkillsFolder={noop}
      onAddProject={async () => false} onStartChat={noop} />
  </Shell>);
  const group = screen.getByRole("radiogroup", { name: "AI provider" });
  const tiles = [...group.querySelectorAll<HTMLElement>(".ob-tile")];
  expect(tiles).toHaveLength(5);
  expect(view.container.querySelector(".ob-tile-kind")).toBeNull();
  for (const tile of tiles) {
    const box = tile.getBoundingClientRect();
    const name = tile.querySelector<HTMLElement>(".ob-tile-name")!;
    const logo = tile.querySelector<HTMLElement>(".ob-tile-logo")!.getBoundingClientRect();
    const dot = tile.querySelector<HTMLElement>(".ob-tile-status")!.getBoundingClientRect();
    // One line of text: the name.
    expect(name.getBoundingClientRect().height).toBeLessThan(24);
    // The dot sits inside the tile's corner, clear of the logo and the name.
    expect(dot.left).toBeGreaterThanOrEqual(box.left);
    expect(dot.right).toBeLessThanOrEqual(box.right);
    expect(dot.top).toBeGreaterThanOrEqual(box.top);
    for (const other of [logo, name.getBoundingClientRect()]) {
      const overlap = Math.min(dot.right, other.right) > Math.max(dot.left, other.left) && Math.min(dot.bottom, other.bottom) > Math.max(dot.top, other.top);
      expect(overlap).toBe(false);
    }
  }
  // Readiness: OpenRouter (key present) and ChatGPT's runtime is installed but
  // not signed in, so only the ready provider's dot is filled.
  const dotFill = (name: string) => getComputedStyle(screen.getByRole("radio", { name }).querySelector(".ob-tile-status")!).backgroundColor;
  expect(dotFill("OpenRouter")).not.toBe("rgba(0, 0, 0, 0)");
  expect(dotFill("Claude")).toBe("rgba(0, 0, 0, 0)");
  // The kind and status remain available to assistive technology.
  expect(screen.getByRole("radio", { name: "OpenRouter" })).toHaveAccessibleDescription(/API credits/);
  // Keyboard selection still moves through the tiles, and the selected panel
  // keeps the connection instructions.
  screen.getByRole("radio", { name: "OpenRouter" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByRole("radio", { name: "LM Studio" })).toHaveAttribute("aria-checked", "true");
  expect(view.container.querySelector(".ob-panel-head strong")).toHaveTextContent("LM Studio");
  await page.screenshot({ path: `../../test-results/lumen/onboarding-tiles-${theme}-${width}.png` });
});

/* ---- Theme-aware Mythra mark (Morgan: match the logo to the active theme) ---- */

const STOPS = ["cyan-a", "cyan-b", "blue-a", "blue-b", "fold-a", "fold-b"] as const;
function stopColors(root: Element) {
  return Object.fromEntries(STOPS.map((stop) => [stop, getComputedStyle(root.querySelector(`.mythra-mark-stop--${stop}`)!).stopColor])) as Record<typeof STOPS[number], string>;
}
function average(first: string, second: string) {
  const a = first.match(/[\d.]+/g)!.map(Number), b = second.match(/[\d.]+/g)!.map(Number);
  return `rgb(${(a[0] + b[0]) / 2}, ${(a[1] + b[1]) / 2}, ${(a[2] + b[2]) / 2})`;
}

it("themes every in-app Mythra mark from the active shell, live, with brand fallbacks outside it", () => {
  const view = render(<>
    <div data-testid="outside"><MythraMark /></div>
    <Shell theme="mythra"><div data-testid="shell"><AnimatedMythraLogo /><MythraMark /></div></Shell>
  </>);
  // Outside a themed shell: the original brand colours.
  expect(stopColors(view.getByTestId("outside"))["cyan-a"]).toBe("rgb(53, 231, 242)");
  expect(stopColors(view.getByTestId("outside"))["fold-b"]).toBe("rgb(18, 71, 217)");
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  const [animated, mark] = [view.container.querySelector(".mythra-logo")!, view.getByTestId("shell").querySelector("svg.mythra-mark")!];
  expect(stopColors(animated)).toEqual(stopColors(mark));
  const mythra = stopColors(animated);
  // Live CSS inheritance: switching the shell's theme recolours the existing
  // marks with no React render (as a theme preview or project override does).
  shell.setAttribute("data-theme", "atari");
  shell.setAttribute("data-color-scheme", "light");
  const atari = stopColors(animated);
  expect(atari["cyan-a"]).not.toBe(mythra["cyan-a"]);
  expect(stopColors(mark)).toEqual(atari);
  // Instance-unique gradient ids, so marks never borrow each other's paint.
  const ids = [...view.container.querySelectorAll("linearGradient")].map((gradient) => gradient.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it.each(THEMES.map((theme) => theme.id))("gives the Mythra mark a readable palette of its own in %s", (theme) => {
  const view = render(<>{THEMES.map((entry) => (
    <Shell key={entry.id} theme={entry.id}><div data-testid={entry.id} style={{ background: "var(--bg)" }}><MythraMark /></div></Shell>
  ))}</>);
  const own = stopColors(view.getByTestId(theme));
  // Every theme's palette is distinct from every other theme's.
  for (const other of THEMES.filter((entry) => entry.id !== theme)) {
    expect(stopColors(view.getByTestId(other.id))["cyan-a"], `${theme} vs ${other.id}`).not.toBe(own["cyan-a"]);
  }
  const surface = getComputedStyle(view.getByTestId(theme)).backgroundColor;
  // The light outer pieces carry the silhouette: at least 3:1 on the theme's
  // surface. The centre and fold keep at least 2.5:1 (Mythra's original brand
  // fold sits at about 2.8:1 on its graphite and is kept as the brand colour).
  expect(contrast(average(own["cyan-a"], own["cyan-b"]), surface), `${theme} outer pieces`).toBeGreaterThanOrEqual(3);
  expect(contrast(average(own["blue-a"], own["blue-b"]), surface), `${theme} centre`).toBeGreaterThanOrEqual(2.5);
  expect(contrast(average(own["fold-a"], own["fold-b"]), surface), `${theme} fold`).toBeGreaterThanOrEqual(2.5);
});

it.each(THEMES.map((theme) => theme.id))("keeps action controls legible in %s", (theme) => {
  const view = render(<Shell theme={theme}>
    <button className="new-thread-button">New thread</button>
    <button className="primary-button">Open project</button>
    <button className="send-button" aria-label="Send">↑</button>
    <button className="workspace-tools-trigger active">Workspace</button>
    <div className="confirm-dialog-actions"><button className="primary-button confirm-danger">Delete forever</button></div>
  </Shell>);
  for (const selector of [".new-thread-button", ".primary-button", ".send-button", ".workspace-tools-trigger.active", ".confirm-danger"]) {
    const node = view.container.querySelector<HTMLElement>(selector)!;
    const style = getComputedStyle(node);
    // Measure text against the actual solid surface, including neutral
    // secondary actions and accent primary actions.
    expect(style.backgroundColor, selector).not.toBe("rgba(0, 0, 0, 0)");
    const surface = renderedSurface(node);
    expect(contrast(composite(style.color, surface), surface), `${selector} in ${theme}`).toBeGreaterThanOrEqual(4.5);
  }
});
