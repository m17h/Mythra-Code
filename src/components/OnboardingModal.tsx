import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  ExternalLink,
  FolderOpen,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  KeyRound,
  LoaderCircle,
  MessageCircleQuestionMark,
  MessageSquare,
  NotebookPen,
  Palette,
  Play,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Undo2,
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import "./OnboardingModal.css";
import type { CodexRuntimeStatus } from "../lib/codex";
import type { ClaudeRuntimeStatus } from "../lib/claude";
import type { CursorRuntimeStatus } from "../lib/cursor";
import { onboardingProviderReadiness, type OnboardingProviderStatus } from "../lib/onboardingReadiness";
import type { OnboardingSettingsDraft } from "../lib/onboardingSettings";
import { EFFORT_SLIDER_STYLES, THEMES, sanitizeChatFont, sanitizeEffortSlider, sanitizeTheme, themeColorScheme } from "../lib/appConfig";
import type { Account, ChatFont, EffortSliderStyle, Provider, SettingsSection, ThemeName } from "../types";
import { useModalFocus } from "../hooks/useModalFocus";
import { ClaudeLogo, CursorLogo, LmStudioLogo, OpenAILogo, OpenRouterLogo } from "./BrandLogos";
import { EffortSlider, effortFlairStyle } from "./effortFlair";

const CODEX_INSTALL_URL = "https://learn.chatgpt.com/docs/codex/cli";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";
const OPENROUTER_GUIDE_URL = "https://openrouter.ai/docs/quickstart";
const CLAUDE_INSTALL_URL = "https://docs.anthropic.com/en/docs/claude-code/setup";
const CURSOR_INSTALL_URL = "https://cursor.com/docs/cli/installation";
const LM_STUDIO_SERVER_URL = "https://lmstudio.ai/docs/developer/core/server";

const STEPS = [
  { id: "connect", label: "Connect AI" },
  { id: "projects", label: "Projects & chats" },
  { id: "direct", label: "Direct the work" },
  { id: "personalize", label: "Make it yours" },
  { id: "ready", label: "Ready" },
] as const;

/** Opens a Settings section while onboarding is suspended; `trigger` regains focus on resume.
    A draft seeds unsaved Settings values that only take effect on Save. */
type OpenSettings = (section: SettingsSection, trigger: HTMLElement, draft?: OnboardingSettingsDraft) => void;
type Readiness = Record<Provider, OnboardingProviderStatus>;
type RuntimeInputs = { runtimeStatus: CodexRuntimeStatus | null; claudeStatus: ClaudeRuntimeStatus | null; cursorStatus: CursorRuntimeStatus | null };
type ProviderStage = "checking" | "install" | "update" | "connect" | "ready";
type HeadingRef = RefObject<HTMLHeadingElement | null>;

type ProviderInfo = { id: Provider; name: string; kind: string; runtime: string; Logo: ComponentType<{ size?: number }>; guide: string };

const PROVIDERS: ProviderInfo[] = [
  { id: "openai", name: "ChatGPT", kind: "ChatGPT plan", runtime: "Codex CLI", Logo: OpenAILogo, guide: CODEX_INSTALL_URL },
  { id: "claude", name: "Claude", kind: "Claude plan", runtime: "Claude Code", Logo: ClaudeLogo, guide: CLAUDE_INSTALL_URL },
  { id: "cursor", name: "Cursor", kind: "Cursor plan", runtime: "Cursor Agent", Logo: CursorLogo, guide: CURSOR_INSTALL_URL },
  { id: "openrouter", name: "OpenRouter", kind: "API credits", runtime: "Codex CLI", Logo: OpenRouterLogo, guide: OPENROUTER_GUIDE_URL },
  { id: "lmstudio", name: "LM Studio", kind: "LM Studio server", runtime: "Codex CLI", Logo: LmStudioLogo, guide: LM_STUDIO_SERVER_URL },
];

/** Mirrors the readiness helper's order of checks so the next step never contradicts the status. */
function providerStage(provider: Provider, inputs: RuntimeInputs, status: OnboardingProviderStatus): ProviderStage {
  if (status.ready) return "ready";
  if (provider === "claude" || provider === "cursor") {
    const runtime = provider === "claude" ? inputs.claudeStatus : inputs.cursorStatus;
    if (!runtime) return "checking";
    return runtime.available ? "connect" : "install";
  }
  if (!inputs.runtimeStatus) return "checking";
  if (!inputs.runtimeStatus.available) return "install";
  if (!inputs.runtimeStatus.compatible) return "update";
  return "connect";
}

function providerNextStep(provider: ProviderInfo, stage: ProviderStage): string {
  if (stage === "ready") return "Connected. Pick a model under the composer and star the ones you use most.";
  if (stage === "checking") return `Checking this computer for ${provider.runtime}…`;
  if (stage === "install") {
    return provider.runtime === "Codex CLI" && provider.id !== "openai"
      ? `${provider.name} runs through the Codex CLI. Install it first; Mythra Code detects it automatically.`
      : `Install ${provider.runtime}. Mythra Code detects it automatically.`;
  }
  if (stage === "update") return "Update the Codex CLI to a compatible version, then check again in Models & accounts.";
  if (provider.id === "openrouter") return "Choose OpenRouter in Models & accounts, then add an API key. Paid models use your OpenRouter credits.";
  if (provider.id === "lmstudio") return "Start an LM Studio server with a model loaded. Choose LM Studio in Models & accounts and test the connection.";
  return provider.id === "openai"
    ? "Choose OpenAI in Models & accounts. Sign in opens your browser; you never enter your subscription password here."
    : `Choose ${provider.name} in Models & accounts. Sign in opens its command-line sign-in in a terminal; follow the prompts there.`;
}

function defaultProvider(readiness: Readiness, inputs: RuntimeInputs, preferredProvider?: Provider): Provider | null {
  if (preferredProvider) return preferredProvider;
  const ready = PROVIDERS.find((provider) => readiness[provider.id].ready);
  if (ready) return ready.id;
  if (inputs.runtimeStatus?.available) return "openai";
  if (inputs.claudeStatus?.available) return "claude";
  if (inputs.cursorStatus?.available) return "cursor";
  return null;
}

/** Roving radio keys: arrows and Home/End move the selection and focus together. */
function roveRadio(event: ReactKeyboardEvent<HTMLElement>, index: number, count: number, select: (next: number) => void) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
  const targets: Partial<Record<string, number>> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: count - 1 };
  const target = targets[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const next = (target + count) % count;
  select(next);
  event.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

/** `description` is read after the name via aria-describedby and never shown. */
type RadioOption<T extends string> = { id: T; label: string; description?: string; content: ReactNode; className?: string; style?: CSSProperties };

function RadioGroup<T extends string>({ label, value, options, onChange, className }: {
  label: string;
  value: T | null;
  options: RadioOption<T>[];
  onChange: (value: T) => void;
  className: string;
}) {
  const groupId = useId();
  const focusIndex = Math.max(0, options.findIndex((option) => option.id === value));
  return <div role="radiogroup" aria-label={label} className={className}>
    {options.map((option, index) => {
      const checked = option.id === value;
      const descriptionId = option.description ? `${groupId}-${option.id}-description` : undefined;
      return <button
        key={option.id}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={option.label}
        aria-describedby={descriptionId}
        tabIndex={index === focusIndex ? 0 : -1}
        className={`${option.className ?? ""} ${checked ? "checked" : ""}`}
        style={option.style}
        onClick={() => onChange(option.id)}
        onKeyDown={(event) => roveRadio(event, index, options.length, (next) => onChange(options[next].id))}
      >{option.content}{descriptionId && <span id={descriptionId} className="sr-only">{option.description}</span>}</button>;
    })}
  </div>;
}

/** Collapsed by default; Escape inside an open disclosure closes it before it can skip the tour. */
function Disclosure({ summary, hint, className = "", children }: { summary: string; hint?: string; className?: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  return <div
    className={`ob-disclosure ${expanded ? "expanded" : ""} ${className}`}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || !expanded || event.defaultPrevented) return;
      event.preventDefault();
      setExpanded(false);
      toggleRef.current?.focus();
    }}
  >
    <button ref={toggleRef} type="button" className="ob-disclosure-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(!expanded)}>
      <ChevronRight size={14} className="ob-chevron" aria-hidden="true" />
      <span>{summary}</span>
      {hint && <small>{hint}</small>}
    </button>
    <div id={bodyId} className="ob-disclosure-body" hidden={!expanded}>{children}</div>
  </div>;
}

function PageHeading({ headingRef, id, eyebrow, title, centered, children }: {
  headingRef: HeadingRef;
  id: string;
  eyebrow?: string;
  title: string;
  centered?: boolean;
  children?: ReactNode;
}) {
  return <header className={`ob-head ${centered ? "centered" : ""}`}>
    {eyebrow && <span className="ob-eyebrow">{eyebrow}</span>}
    <h2 ref={headingRef} id={id} tabIndex={-1} data-autofocus>{title}</h2>
    {children && <p>{children}</p>}
  </header>;
}

function useReadyPulse(readiness: Readiness): { id: Provider; key: number } | null {
  const previous = useRef(readiness);
  const [pulse, setPulse] = useState<{ id: Provider; key: number } | null>(null);
  useEffect(() => {
    const flipped = PROVIDERS.find((provider) => readiness[provider.id].ready && !previous.current[provider.id].ready);
    previous.current = readiness;
    if (flipped) setPulse((current) => ({ id: flipped.id, key: (current?.key ?? 0) + 1 }));
  }, [readiness]);
  return pulse;
}

function ConnectPage({ headingRef, readiness, inputs, onSettings, preferredProvider }: { headingRef: HeadingRef; readiness: Readiness; inputs: RuntimeInputs; onSettings: OpenSettings; preferredProvider?: Provider }) {
  const headingId = useId();
  const [picked, setPicked] = useState<Provider | null>(null);
  const pulse = useReadyPulse(readiness);
  const selectedId = picked ?? defaultProvider(readiness, inputs, preferredProvider);
  const selected = PROVIDERS.find((provider) => provider.id === selectedId) ?? null;
  const anyReady = PROVIDERS.some((provider) => readiness[provider.id].ready);

  let panel: ReactNode = <p className="ob-panel-empty">Choose a provider to see how to connect it.</p>;
  if (selected) {
    const status = readiness[selected.id];
    const stage = providerStage(selected.id, inputs, status);
    const installGuide = selected.runtime === "Codex CLI" ? CODEX_INSTALL_URL : selected.guide;
    // Settings opens with this provider in an unsaved draft; the default only changes on Save.
    const openModels = (event: { currentTarget: HTMLElement }) => onSettings("models", event.currentTarget, { provider: selected.id });
    panel = <div key={selected.id} className="ob-panel-body">
      <div className="ob-panel-head">
        <strong>{selected.name}</strong>
        <span className={`ob-status ${stage}`}><i aria-hidden="true" />{status.detail}</span>
      </div>
      <p>{providerNextStep(selected, stage)}</p>
      <div className="ob-panel-actions">
        {stage === "install" || stage === "update"
          ? <button type="button" className="primary-button" onClick={() => void openUrl(installGuide)}>{stage === "update" ? "Update guide" : `Install ${selected.runtime}`} <ExternalLink size={13} /></button>
          : stage === "connect" && <button type="button" className="primary-button" onClick={openModels}>Models & accounts <ArrowRight size={13} /></button>}
        {stage !== "connect" && <button type="button" className="secondary-button" onClick={openModels}>Models & accounts</button>}
        {selected.id === "openrouter" && stage !== "ready" && <button type="button" className="ob-link" onClick={() => void openUrl(OPENROUTER_KEYS_URL)}>Create API key <ExternalLink size={12} /></button>}
        {stage !== "install" && stage !== "update" && <button type="button" className="ob-link" onClick={() => void openUrl(selected.guide)}>Setup guide <ExternalLink size={12} /></button>}
      </div>
      <small className="ob-panel-note">Opens with {selected.name} selected. Your default provider changes only if you Save.</small>
    </div>;
  }

  return <section className="ob-page ob-connect" aria-labelledby={headingId}>
    <div className="ob-hero">
      <span className="ob-glyph" aria-hidden="true"><img src="/mythra-code-glyph.svg" alt="" /></span>
      <PageHeading headingRef={headingRef} id={headingId} title="Welcome to Mythra Code" centered>
        Connect one AI provider to start. You can add more anytime.
      </PageHeading>
    </div>
    <RadioGroup
      label="AI provider"
      className="ob-providers"
      value={selectedId}
      onChange={setPicked}
      options={PROVIDERS.map(({ id, name, kind, Logo }) => ({
        id,
        label: name,
        description: `${kind}. ${readiness[id].detail}`,
        className: "ob-tile",
        content: <>
          {pulse?.id === id && <i key={pulse.key} className="ob-tile-ring" aria-hidden="true" />}
          <span className="ob-tile-logo" aria-hidden="true"><Logo size={18} /></span>
          <span className="ob-tile-name" aria-hidden="true">{name}</span>
          <span className="ob-tile-kind" aria-hidden="true"><i className={`ob-dot ${readiness[id].ready ? "on" : ""}`} /><span>{kind}</span></span>
        </>,
      }))}
    />
    <div className="ob-provider-panel ob-plinth">{panel}</div>
    {/* Stays mounted so only the selected provider's status is announced, not the whole panel. */}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{selected ? `${selected.name}: ${readiness[selected.id].detail}` : ""}</p>
    {!anyReady && <p className="ob-caption centered">No provider is ready yet. You can keep exploring and connect one anytime.</p>}
  </section>;
}

const GIT_ROUTE = [
  { scope: "Local", Icon: GitBranch, title: "Git in your folder", detail: "No repository yet? Mythra Code can initialize one locally." },
  { scope: "Local", Icon: GitBranch, title: "Isolated worktree", detail: "Optional: gives one thread its own branch and folder. Choose it before the first message from a Git repository root with at least one commit." },
  { scope: "Local", Icon: GitCommitHorizontal, title: "Commit", detail: "Saved on this computer only." },
  { scope: "GitHub", Icon: GitPullRequest, title: "Push & pull request", detail: "Push the branch, then open and follow its pull request from the Git panel." },
  { scope: "GitHub → Local", Icon: GitMerge, title: "Merge, then pull", detail: "Merging on GitHub doesn’t change your local folder. Pull to bring the merged work down." },
] as const;

function ProjectsPage({ headingRef, onSettings }: { headingRef: HeadingRef; onSettings: OpenSettings }) {
  const headingId = useId();
  const [place, setPlace] = useState<"project" | "chat">("project");
  return <section className="ob-page" aria-labelledby={headingId}>
    <PageHeading headingRef={headingRef} id={headingId} eyebrow="Projects & chats" title="Work in a folder, or just talk.">
      Every thread belongs to a project folder or to Normal chats.
    </PageHeading>
    <RadioGroup
      label="Where a thread lives"
      className="ob-segmented"
      value={place}
      onChange={setPlace}
      options={[
        { id: "project", label: "Project", content: <><FolderOpen size={15} aria-hidden="true" />Project</> },
        { id: "chat", label: "Normal chat", content: <><MessageSquare size={15} aria-hidden="true" />Normal chat</> },
      ]}
    />
    <div className="ob-place ob-plinth">
      <span className="ob-place-icon" aria-hidden="true">{place === "project" ? <FolderOpen size={22} /> : <MessageSquare size={22} />}</span>
      <p key={place} aria-live="polite">{place === "project"
        ? "Threads run in a real folder on this computer: files, commands, Git, and the workspace panel. Edits follow the permission you choose."
        : "Saved under Normal chats with no folder attached. Good for questions and planning."}</p>
    </div>
    <Disclosure summary="Optional: Git, worktrees, and GitHub" hint="Local first">
      <ol className="ob-route">
        {GIT_ROUTE.map(({ scope, Icon, title, detail }) => <li key={title} className={scope === "Local" ? "local" : "github"}>
          <span className="ob-route-icon" aria-hidden="true"><Icon size={12} /></span>
          <span><strong>{title}</strong><small>{detail}</small></span>
          <span className={`ob-scope ${scope === "Local" ? "" : "github"}`}>{scope}</span>
        </li>)}
      </ol>
      <div className="ob-route-foot">
        <small>GitHub is optional for sharing code and pull requests.</small>
        <button type="button" className="ob-link" onClick={(event) => onSettings("github", event.currentTarget)}>Connect GitHub <ArrowRight size={12} /></button>
      </div>
    </Disclosure>
  </section>;
}

/** Explanations only; the real picker lives under the composer. */
const PERMISSIONS = [
  { id: "read-only", Icon: Shield, name: "Read only", detail: "Inspect without changing files." },
  { id: "ask", Icon: ShieldCheck, name: "Ask to act", detail: "Edits locally; asks before elevated actions." },
  { id: "full", Icon: ShieldAlert, name: "Full access", detail: "No approval prompts. Use for trusted work." },
] as const;

function DirectPage({ headingRef, onSettings }: { headingRef: HeadingRef; onSettings: OpenSettings }) {
  const headingId = useId();
  const permsId = useId();
  const crewId = useId();
  return <section className="ob-page" aria-labelledby={headingId}>
    <PageHeading headingRef={headingRef} id={headingId} eyebrow="Direct the work" title="You decide how far it goes.">
      Permission, sub-agents, and Stop sit under the composer.
    </PageHeading>
    <div className="ob-direct">
      <section className="ob-perms-block" aria-labelledby={permsId}>
        <h3 id={permsId} className="ob-field-label">Permission levels</h3>
        <ul className="ob-perms">
          {PERMISSIONS.map(({ id, Icon, name, detail }) => <li key={id} className={`ob-perm ${id}`}>
            <span className="ob-perm-icon" aria-hidden="true"><Icon size={15} /></span>
            <span><strong>{name}{id === "ask" && <em className="ob-chip">Recommended</em>}</strong><small>{detail}</small></span>
          </li>)}
        </ul>
        <p className="ob-caption">Shared across your chats; each provider enforces it its own way.</p>
      </section>
      <section className="ob-crew ob-plinth" aria-labelledby={crewId}>
        <div className="ob-crew-head">
          <span className="ob-crew-icon" aria-hidden="true"><UsersRound size={16} /></span>
          <h3 id={crewId}>Sub-agents</h3>
          <em className="ob-chip">Opt-in</em>
        </div>
        <ul>
          <li><Check size={13} aria-hidden="true" /><span><b>Your pick of model.</b> Any connected model per worker.</span></li>
          <li><Check size={13} aria-hidden="true" /><span><b>Same permission.</b> Workers inherit it.</span></li>
          <li><Check size={13} aria-hidden="true" /><span><b>Real usage.</b> Plan limits, API credits, or your LM Studio server.</span></li>
        </ul>
        <p>Setup shows if you’re editing this thread or new-thread defaults. <button type="button" className="ob-link" onClick={(event) => onSettings("agents", event.currentTarget)}>Crew presets</button></p>
      </section>
    </div>
    <div className="ob-aside-row">
      <div className="ob-aside">
        <span className="ob-perm-icon" aria-hidden="true"><MessageCircleQuestionMark size={15} /></span>
        <span><strong>Questions</strong><small>Some pause the turn until you answer; others arrive as work continues. Reply in the question card.</small></span>
      </div>
      <div className="ob-aside">
        <span className="ob-perm-icon" aria-hidden="true"><CircleStop size={15} /></span>
        <span><strong>Stop</strong><small>Ends the turn. Thinking and commands stay in the transcript.</small></span>
      </div>
    </div>
    <p className="ob-note"><NotebookPen size={13} aria-hidden="true" />Your instructions: <button type="button" className="ob-link" onClick={(event) => onSettings("prompts", event.currentTarget)}>Settings → Prompts</button>, or <b>Project instructions</b> beside the project name in a project chat.</p>
  </section>;
}

type AppearancePreview = { theme: ThemeName; chatFont: ChatFont; effortSlider: EffortSliderStyle; effortIndex: number };

const CHAT_FONT_OPTIONS: Array<{ id: ChatFont; name: string }> = [
  { id: "system", name: "Interface" },
  { id: "humanist", name: "Humanist" },
  { id: "serif", name: "Serif" },
  { id: "mono", name: "Mono" },
];
const PREVIEW_EFFORTS = [
  { label: "Light", short: "Light" },
  { label: "Medium", short: "Medium" },
  { label: "High", short: "High" },
  { label: "Extra high", short: "Extra" },
  { label: "Maximum", short: "Max" },
];

/** Starts the preview from whatever the app shell shows now; reading never writes back. */
function hostAppearance(node: HTMLElement | null): AppearancePreview {
  const shell = node?.closest<HTMLElement>(".app-shell");
  return {
    theme: sanitizeTheme(shell?.dataset.theme),
    chatFont: sanitizeChatFont(shell?.dataset.chatFont),
    effortSlider: sanitizeEffortSlider(shell?.dataset.onboardingEffortSlider ?? shell?.dataset.effortSlider),
    effortIndex: 2,
  };
}

function previewTokens(theme: ThemeName): CSSProperties {
  const entry = THEMES.find((candidate) => candidate.id === theme) ?? THEMES[0];
  const [bg, panel, accent] = entry.swatches;
  const light = themeColorScheme(theme) === "light";
  return {
    "--ob-pv-bg": bg,
    "--ob-pv-panel": panel,
    "--ob-pv-accent": accent,
    "--ob-pv-text": light ? "#1d272b" : "#eceeeb",
    "--ob-pv-muted": light ? "#5b686d" : "#8d9299",
    "--ob-pv-line": light ? "rgba(20, 30, 34, .13)" : "rgba(255, 255, 255, .09)",
  } as CSSProperties;
}

function PersonalizePage({ headingRef, open, preview, onPreview, onSettings }: {
  headingRef: HeadingRef;
  open: boolean;
  preview: AppearancePreview | null;
  onPreview: (preview: AppearancePreview) => void;
  onSettings: OpenSettings;
}) {
  const headingId = useId();
  const rootRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (open && !preview) onPreview(hostAppearance(rootRef.current));
  }, [onPreview, open, preview]);

  const current = preview ?? hostAppearance(null);
  const update = (patch: Partial<AppearancePreview>) => onPreview({ ...current, ...patch });
  const theme = THEMES.find((entry) => entry.id === current.theme) ?? THEMES[0];
  const styleIndex = Math.max(0, EFFORT_SLIDER_STYLES.findIndex((style) => style.id === current.effortSlider));
  const style = EFFORT_SLIDER_STYLES[styleIndex];
  const cycleStyle = (delta: number) => update({ effortSlider: EFFORT_SLIDER_STYLES[(styleIndex + delta + EFFORT_SLIDER_STYLES.length) % EFFORT_SLIDER_STYLES.length].id });
  const effortMax = current.effortIndex === PREVIEW_EFFORTS.length - 1;

  return <section ref={rootRef} className="ob-page" aria-labelledby={headingId}>
    <PageHeading headingRef={headingRef} id={headingId} eyebrow="Make it yours" title="Make it feel like yours.">
      Try a look here. Nothing is saved until you take it to Settings → Interface and press Save.
    </PageHeading>
    <div className="ob-personalize">
      <div className="ob-fields">
        <div className="ob-field">
          <span className="ob-field-label">Theme</span>
          <RadioGroup
            label="Preview theme"
            className="ob-swatches"
            value={current.theme}
            onChange={(next) => update({ theme: next })}
            options={THEMES.map((entry) => ({
              id: entry.id,
              label: entry.name,
              className: "ob-swatch-option",
              content: <span className="ob-swatch" aria-hidden="true" style={{ "--sw-a": entry.swatches[0], "--sw-b": entry.swatches[1], "--sw-c": entry.swatches[2] } as CSSProperties} />,
            }))}
          />
          <small><b>{theme.name}</b> · {theme.description}</small>
        </div>
        <div className="ob-field">
          <span className="ob-field-label">Chat font</span>
          <RadioGroup
            label="Preview chat font"
            className="ob-segmented ob-fonts"
            value={current.chatFont}
            onChange={(next) => update({ chatFont: next })}
            options={CHAT_FONT_OPTIONS.map((font) => ({ id: font.id, label: font.name, content: font.name, style: { fontFamily: `var(--chat-font-${font.id})` } }))}
          />
        </div>
        <div className="ob-field">
          <span className="ob-field-label">Effort slider</span>
          <div className="ob-style-stepper" role="group" aria-label="Preview effort slider style">
            <button type="button" className="ob-icon-button" aria-label="Previous slider style" onClick={() => cycleStyle(-1)}><ChevronLeft size={14} /></button>
            <span className="ob-style-name" aria-live="polite"><strong>{style.name}</strong><small>{styleIndex + 1} of {EFFORT_SLIDER_STYLES.length}</small></span>
            <button type="button" className="ob-icon-button" aria-label="Next slider style" onClick={() => cycleStyle(1)}><ChevronRight size={14} /></button>
          </div>
          <small>{style.description}</small>
        </div>
      </div>
      <div className="ob-preview" style={previewTokens(current.theme)}>
        <div className="ob-preview-bar">
          <span className="ob-preview-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="ob-preview-badge"><Sparkles size={11} aria-hidden="true" />Preview only · not saved</span>
        </div>
        <div className="ob-preview-chat" style={{ fontFamily: `var(--chat-font-${current.chatFont})` }}>
          <p className="ob-preview-user">Tidy up the settings panel.</p>
          <p className="ob-preview-reply">I’ll read it first, then propose a small diff you can review.</p>
        </div>
        {/* The slider looks are keyed off an app-shell attribute, so the real
            slider previews inside a local shell scope; the app shell itself is untouched. */}
        <div className="app-shell ob-effort-shell" data-effort-slider={current.effortSlider} data-color-scheme={themeColorScheme(current.theme)}>
          <div
            className={`model-power-control ob-effort-wrap ${effortMax ? "effort-max" : ""}`}
            style={{ ...effortFlairStyle(current.effortIndex, PREVIEW_EFFORTS.length), "--model-accent": "var(--ob-pv-accent)", "--reactor-live": "var(--reactor-effort-color, #f65db5)", "--dart-live": "var(--dart-effort-color, #43cb5c)" } as CSSProperties}
          >
            <div className="reasoning-control">
              <div className="reasoning-heading"><Gauge size={13} aria-hidden="true" /><span>Reasoning</span><strong key={current.effortIndex}>{PREVIEW_EFFORTS[current.effortIndex].label}</strong></div>
              <EffortSlider
                variant="codex"
                index={current.effortIndex}
                count={PREVIEW_EFFORTS.length}
                ariaLabel="Preview reasoning effort"
                valueText={PREVIEW_EFFORTS[current.effortIndex].label}
                onIndex={(next) => update({ effortIndex: next })}
              />
              <div className="reasoning-labels">
                {PREVIEW_EFFORTS.map((entry, index) => <span key={entry.label} className={index === current.effortIndex ? "active" : ""}>{entry.short}</span>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div className="ob-foot-row">
      <div className="ob-inline-note">
        <span className="ob-perm-icon" aria-hidden="true"><Sparkles size={14} /></span>
        <span><strong>Automatic thread titles</strong><small>Off by default. When on, your first message goes to the title model you choose and uses that provider’s subscription or credits. <button type="button" className="ob-link" onClick={(event) => onSettings("projects", event.currentTarget)}>Settings → Projects</button></small></span>
      </div>
      <button
        type="button"
        className="secondary-button"
        onClick={(event) => onSettings("general", event.currentTarget, { appearance: { theme: current.theme, chatFont: current.chatFont, effortSlider: current.effortSlider } })}
      ><Palette size={14} aria-hidden="true" />Review this look in Settings</button>
    </div>
  </section>;
}

function ReadyPage({ headingRef, readiness, skillsFolder, projectPending, projectError, onSettings, onChooseSkillsFolder, onOpenProject, onStartChat }: {
  headingRef: HeadingRef;
  readiness: Readiness;
  skillsFolder: string;
  projectPending: boolean;
  projectError: string;
  onSettings: OpenSettings;
  onChooseSkillsFolder: () => void;
  onOpenProject: () => void;
  onStartChat: () => void;
}) {
  const headingId = useId();
  const readyNames = PROVIDERS.filter((provider) => readiness[provider.id].ready).map((provider) => provider.name);
  const anyReady = readyNames.length > 0;
  return <section className="ob-page ob-ready" aria-labelledby={headingId}>
    <span className={`ob-ready-mark ${anyReady ? "" : "pending"}`} aria-hidden="true">{anyReady ? <Check size={24} strokeWidth={2.5} /> : <KeyRound size={22} />}</span>
    <PageHeading headingRef={headingRef} id={headingId} eyebrow={anyReady ? "All set" : "Almost there"} title={anyReady ? "You’re ready to build." : "Set up a provider to start."} centered>
      Replay this guide anytime from Settings → Runtime.
    </PageHeading>
    <div className="ob-status-line">
      {anyReady
        ? <span><i className="ob-dot on" aria-hidden="true" />Connected: {readyNames.join(", ")}</span>
        : <>
          <span><i className="ob-dot" aria-hidden="true" />No provider is connected yet.</span>
          <button type="button" className="primary-button" onClick={(event) => onSettings("models", event.currentTarget)}><KeyRound size={14} aria-hidden="true" />Set up in Models & accounts</button>
        </>}
    </div>
    {!anyReady && <p className="ob-caption centered">You can still open a project or a chat now; threads can’t run until a provider is connected.</p>}
    <div className="ob-destinations">
      <button type="button" className="ob-destination" disabled={projectPending} aria-busy={projectPending || undefined} onClick={onOpenProject}>
        <span className="ob-dest-icon" aria-hidden="true">{projectPending ? <LoaderCircle size={17} className="ob-spin" /> : <FolderOpen size={17} />}</span>
        <span><strong>{projectPending ? "Choosing a folder…" : "Open a project"}</strong><small>Work inside a folder</small></span>
        <ArrowRight size={14} className="ob-dest-arrow" aria-hidden="true" />
      </button>
      <button type="button" className="ob-destination" onClick={onStartChat}>
        <span className="ob-dest-icon" aria-hidden="true"><MessageSquare size={17} /></span>
        <span><strong>Start a normal chat</strong><small>No folder attached</small></span>
        <ArrowRight size={14} className="ob-dest-arrow" aria-hidden="true" />
      </button>
    </div>
    {projectError && <p className="ob-error" role="alert">{projectError}</p>}
    <Disclosure summary="Useful once you’re working" className="ob-tools-disclosure">
      <ul className="ob-tools">
        <li><span className="ob-perm-icon" aria-hidden="true"><Play size={13} /></span><span><strong>Run</strong><small>Find run command investigates the project and proposes a dev command for you to review and save. Nothing launches until you press Run.</small></span><em className="ob-scope">Top bar</em></li>
        <li><span className="ob-perm-icon" aria-hidden="true"><Sparkles size={13} /></span><span><strong>Review</strong><small>Inspect a thread’s changes. Inline AI review is available for supported providers.</small></span><em className="ob-scope">Workspace panel</em></li>
        <li><span className="ob-perm-icon" aria-hidden="true"><Undo2 size={13} /></span><span><strong>Checkpoints</strong><small>When a run records a checkpoint, you can restore its file changes.</small></span></li>
        <li><span className="ob-perm-icon" aria-hidden="true"><Boxes size={13} /></span><span><strong>Skills</strong><small>{skillsFolder ? `Markdown playbooks from ${skillsFolder}.` : "Markdown playbooks from one local folder, called by name."} <button type="button" className="ob-link" onClick={(event) => onSettings("skills", event.currentTarget)}>Settings → Skills</button></small></span><button type="button" className="secondary-button" onClick={onChooseSkillsFolder}>{skillsFolder ? "Change folder" : "Choose folder"}</button></li>
        <li><span className="ob-perm-icon" aria-hidden="true"><Workflow size={13} /></span><span><strong>Automation</strong><small>Workflows and scheduled tasks.</small></span><em className="ob-scope">Settings</em></li>
      </ul>
    </Disclosure>
  </section>;
}

export function OnboardingModal({
  open,
  preferredProvider,
  runtimeStatus,
  claudeStatus = null,
  cursorStatus = null,
  account,
  openRouterReady,
  lmStudioReady = false,
  skillsFolder,
  onComplete,
  onOpenSettings,
  onChooseSkillsFolder,
  onAddProject,
  onStartChat,
}: {
  open: boolean;
  /** Start from the saved default when replaying the tour; inspection never changes it. */
  preferredProvider?: Provider;
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus?: ClaudeRuntimeStatus | null;
  cursorStatus?: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
  lmStudioReady?: boolean;
  skillsFolder: string;
  onComplete: () => void;
  /** Suspends the tour (the caller sets `open` false) and reopens it on the same page afterwards.
      `draft` seeds unsaved Settings values; nothing is persisted unless the user saves. */
  onOpenSettings: (section: SettingsSection, draft?: OnboardingSettingsDraft) => void;
  onChooseSkillsFolder: () => void;
  /** Resolves true once a project was added; false when the folder picker was cancelled. */
  onAddProject: () => Promise<boolean>;
  onStartChat: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [appearance, setAppearance] = useState<AppearancePreview | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [projectError, setProjectError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const projectPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const completedRef = useRef(false);
  const complete = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete();
  };
  useModalFocus(dialogRef, open);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Step changes focus the new page heading. Resuming after Settings returns
  // focus to the control that opened it. The step itself is never reset here.
  useEffect(() => {
    if (!open) return;
    const trigger = returnFocusRef.current;
    returnFocusRef.current = null;
    if (trigger?.isConnected && dialogRef.current?.contains(trigger)) trigger.focus();
    else headingRef.current?.focus();
  }, [open, stepIndex]);

  // Only an Escape nothing else handled skips; arrow keys are left to the controls.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && target !== document && target !== document.body && !dialogRef.current?.contains(target)) return;
      if (!completedRef.current) { completedRef.current = true; onComplete(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onComplete, open]);

  const readiness = useMemo(
    () => onboardingProviderReadiness({ runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady, lmStudioReady }),
    [account, claudeStatus, cursorStatus, lmStudioReady, openRouterReady, runtimeStatus],
  );
  const inputs: RuntimeInputs = { runtimeStatus, claudeStatus, cursorStatus };

  const goTo = (index: number) => {
    const next = Math.min(STEPS.length - 1, Math.max(0, index));
    if (next === stepIndex) return;
    setDirection(next > stepIndex ? "forward" : "back");
    setStepIndex(next);
  };

  const openSettings: OpenSettings = (section, trigger, draft) => {
    returnFocusRef.current = trigger;
    // Settings receives any carried look as a draft and may change the real
    // appearance; the preview restarts from the app shell on resume.
    setAppearance(null);
    if (draft) onOpenSettings(section, draft);
    else onOpenSettings(section);
  };

  const openProject = async () => {
    if (projectPendingRef.current) return;
    projectPendingRef.current = true;
    setProjectPending(true);
    setProjectError("");
    try {
      const added = await onAddProject();
      if (!mountedRef.current) return;
      if (added) complete();
    } catch (error) {
      if (!mountedRef.current) return;
      setProjectError(`Couldn’t open a project. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      projectPendingRef.current = false;
      if (mountedRef.current) setProjectPending(false);
    }
  };

  const startChat = () => {
    complete();
    onStartChat();
  };

  const step = STEPS[stepIndex];
  let content: ReactNode;
  if (step.id === "connect") content = <ConnectPage headingRef={headingRef} readiness={readiness} inputs={inputs} onSettings={openSettings} preferredProvider={preferredProvider} />;
  else if (step.id === "projects") content = <ProjectsPage headingRef={headingRef} onSettings={openSettings} />;
  else if (step.id === "direct") content = <DirectPage headingRef={headingRef} onSettings={openSettings} />;
  else if (step.id === "personalize") content = <PersonalizePage headingRef={headingRef} open={open} preview={appearance} onPreview={setAppearance} onSettings={openSettings} />;
  else content = <ReadyPage headingRef={headingRef} readiness={readiness} skillsFolder={skillsFolder} projectPending={projectPending} projectError={projectError} onSettings={openSettings} onChooseSkillsFolder={onChooseSkillsFolder} onOpenProject={() => void openProject()} onStartChat={startChat} />;

  const last = stepIndex === STEPS.length - 1;
  // With nothing connected, Ready's setup button leads and Done steps back.
  const anyReady = PROVIDERS.some((provider) => readiness[provider.id].ready);
  return <div className={`modal-backdrop onboarding-backdrop ${open ? "open" : "closed"}`} aria-hidden={!open} inert={!open ? true : undefined}>
    <div ref={dialogRef} className="onboarding-modal" role="dialog" aria-modal="true" aria-label="Mythra Code onboarding">
      <div className="ob-header">
        <img className="ob-header-glyph" src="/mythra-code-glyph.svg" alt="" aria-hidden="true" />
        <nav className="ob-stepper" aria-label="Onboarding progress">
          <ol>
            {STEPS.map((entry, index) => <li key={entry.id} className={`${index === stepIndex ? "current" : ""} ${index < stepIndex ? "done" : ""}`}>
              <button type="button" aria-label={entry.label} aria-current={index === stepIndex ? "step" : undefined} onClick={() => goTo(index)}>
                <span className="ob-step-num" aria-hidden="true">{index < stepIndex ? <Check size={11} strokeWidth={3} /> : index + 1}</span>
                <span className="ob-step-label" aria-hidden="true">{entry.label}</span>
              </button>
            </li>)}
          </ol>
        </nav>
        <button type="button" className="ob-close" onClick={complete} aria-label="Skip onboarding"><X size={16} /></button>
        <span className="ob-progress" aria-hidden="true"><i style={{ transform: `scaleX(${(stepIndex + 1) / STEPS.length})` }} /></span>
      </div>
      <div className={`ob-stage ${direction}`} key={step.id}>{content}</div>
      <footer className="ob-footer">
        <button type="button" className="ob-skip" onClick={complete}>Skip tour</button>
        <div className="ob-footer-nav">
          <span className="ob-count">{stepIndex + 1} of {STEPS.length}</span>
          <button type="button" className="secondary-button" onClick={() => goTo(stepIndex - 1)} disabled={stepIndex === 0}><ChevronLeft size={13} /> Back</button>
          {last
            ? <button type="button" className={anyReady ? "primary-button" : "secondary-button"} onClick={complete}>Done <Check size={13} /></button>
            : <button type="button" className="primary-button" onClick={() => goTo(stepIndex + 1)}>Continue <ChevronRight size={13} /></button>}
        </div>
      </footer>
    </div>
  </div>;
}
