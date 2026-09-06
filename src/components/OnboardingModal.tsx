import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  ExternalLink,
  FolderOpen,
  KeyRound,
  MessageSquare,
  NotebookPen,
  Rocket,
  Shield,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import "./OnboardingModal.css";
import type { CodexRuntimeStatus } from "../lib/codex";
import type { ClaudeRuntimeStatus } from "../lib/claude";
import type { CursorRuntimeStatus } from "../lib/cursor";
import type { Account, SettingsSection } from "../types";
import { useModalFocus } from "../hooks/useModalFocus";
import { ClaudeLogo, CursorLogo, LmStudioLogo, OpenAILogo, OpenRouterLogo } from "./BrandLogos";

const CODEX_INSTALL_URL = "https://learn.chatgpt.com/docs/codex/cli";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";
const OPENROUTER_GUIDE_URL = "https://openrouter.ai/docs/quickstart";
const CLAUDE_INSTALL_URL = "https://docs.anthropic.com/en/docs/claude-code/setup";
const CURSOR_INSTALL_URL = "https://cursor.com/docs/cli/installation";
const LM_STUDIO_SERVER_URL = "https://lmstudio.ai/docs/developer/core/server";

const STEPS = [
  { id: "welcome", label: "Welcome", icon: Compass },
  { id: "providers", label: "Connect AI", icon: KeyRound },
  { id: "workspaces", label: "Projects & chats", icon: FolderOpen },
  { id: "controls", label: "Your controls", icon: ShieldCheck },
  { id: "appearance", label: "Make it yours", icon: Compass },
  { id: "agents", label: "Build your crew", icon: Bot },
  { id: "tools", label: "Everyday tools", icon: TerminalSquare },
  { id: "skills", label: "Local skills", icon: Boxes },
  { id: "ready", label: "Ready to build", icon: Rocket },
] as const;

function StatusPill({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <span className={`onboarding-status ${ready ? "ready" : "waiting"}`}><i />{children}</span>;
}

function ProviderStep({ runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady, lmStudioReady }: {
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus: ClaudeRuntimeStatus | null;
  cursorStatus: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
  lmStudioReady: boolean;
}) {
  const runtimeReady = Boolean(runtimeStatus?.available);
  const providers = [
    { id: "openai", title: "ChatGPT subscription", Icon: OpenAILogo, runtime: runtimeReady, connected: account?.type === "chatgpt", guide: CODEX_INSTALL_URL,
      steps: ["Install the official Codex CLI; Mythra Code detects it automatically.", "Choose OpenAI in Settings → Models & accounts, then Sign in.", "Finish ChatGPT sign-in in your browser and pick a model beneath the composer."] },
    { id: "claude", title: "Claude subscription", Icon: ClaudeLogo, runtime: Boolean(claudeStatus?.available), connected: Boolean(claudeStatus?.loggedIn), guide: CLAUDE_INSTALL_URL,
      steps: ["Install Claude Code.", "Choose Claude in Models & accounts and Sign in, or run claude auth login.", "Pick an available model from your subscription beneath the composer."] },
    { id: "cursor", title: "Cursor subscription", Icon: CursorLogo, runtime: Boolean(cursorStatus?.available), connected: Boolean(cursorStatus?.loggedIn), guide: CURSOR_INSTALL_URL,
      steps: ["Install Cursor Agent.", "Choose Cursor in Models & accounts and complete browser sign-in.", "Choose from the live model catalog attached to your subscription."] },
    { id: "openrouter", title: "OpenRouter", Icon: OpenRouterLogo, runtime: runtimeReady, connected: openRouterReady, guide: OPENROUTER_GUIDE_URL,
      steps: ["Create or sign in to OpenRouter, add credits for paid models, and create an API key.", "Save the key in Models & accounts; it stays in your OS credential store.", "Install Codex CLI, then search the OpenRouter model picker."] },
    { id: "lmstudio", title: "LM Studio", Icon: LmStudioLogo, runtime: runtimeReady, connected: lmStudioReady, guide: LM_STUDIO_SERVER_URL,
      steps: ["Download a coding-capable model in LM Studio and start its Local Server.", "Choose LM Studio in Models & accounts. The default address is 127.0.0.1:1234.", "Install Codex CLI, test the server connection, and select a discovered model."] },
  ];
  return <div className="onboarding-page providers-page">
    <div className="onboarding-copy"><span className="onboarding-eyebrow">Choose your provider</span><h2>Connect the models you want to use.</h2><p>Connect one provider or mix several. Subscriptions use official browser sign-in, OpenRouter uses API credits, and LM Studio runs local models.</p></div>
    <div className="onboarding-provider-grid">{providers.map(({ id, title, Icon, runtime, connected, guide, steps }) => <article key={id} className={`onboarding-provider-card ${id}`}>
      <div className="onboarding-card-title"><span><Icon size={18} /></span><div><strong>{title}</strong></div></div>
      <ol>{steps.map((text, index) => <li key={text}><b>{index + 1}</b><span>{text}</span></li>)}</ol>
      <div className="onboarding-card-footer"><StatusPill ready={runtime}>{runtime ? "Runtime detected" : "Runtime needed"}</StatusPill><StatusPill ready={connected}>{connected ? "Connected" : "Not connected"}</StatusPill></div>
      <div className="onboarding-card-links"><button className="onboarding-link-button" onClick={() => void openUrl(guide)}><ExternalLink size={12} /> {title} setup guide</button>{id === "openrouter" && <button className="onboarding-link-button" onClick={() => void openUrl(OPENROUTER_KEYS_URL)}>Create API key</button>}</div>
    </article>)}</div>
    <div className="onboarding-note"><ShieldCheck size={14} /><span>Never paste a subscription password into Mythra Code. Connect accounts in Settings → Models & accounts.</span></div>
  </div>;
}

const TOUR_PAGES = {
  appearance: { eyebrow: "Make it yours", title: "Your workspace, your style.", intro: "Open Settings → Interface to preview your choices, then save the combination that feels right.", cards: [
    ["Themes", "Choose a light or dark theme and a color palette. Project defaults can give each workspace its own look."],
    ["Chat fonts & UI scale", "Pick a typeface for conversation text and adjust interface scale for comfortable reading. Code keeps its monospace font."],
    ["Animated effort sliders", "Try Reactor’s energy cells, Astra’s starlight, or a quieter style. The look changes; your selected reasoning effort keeps the same meaning."],
  ] },
  agents: { eyebrow: "Build your crew", title: "Different models. One team.", intro: "Open Sub-agents beneath the composer. Choose any available model from your connected providers for each worker, independently of the parent model.", cards: [
    ["Mix providers and roles", "Turn on Cross-provider to combine OpenAI, Claude, Cursor, OpenRouter, and LM Studio. Try one model for implementation and another for review; set each worker’s model and reasoning."],
    ["Your roster, your limits", "Choose how many may run at once, up to 24 and within your configured crew. Change or clear an idle thread’s crew; changes apply on its next message. Workers inherit the parent’s permissions."],
    ["Reuse and follow the work", "Save crews as presets in Settings → Sub-agents. Watch live workers in the Sub-agents panel. Connected subscriptions, API credits, and local compute still apply—model choice is yours."],
  ] },
  tools: { eyebrow: "Everyday tools", title: "More than a chat window.", intro: "Start with a conversation and reach for these tools as your project grows.", cards: [
    ["Instructions & organization", "Use Project instructions beside the project name to replace or add to your app-wide prompt. Pin workspaces for quick access and collapse the pinned group when you need space."],
    ["Usage & model favorites", "Hover over a subscription’s usage chip for a quick reading, or click to keep it open. Star models in the picker so favorites are easy to find."],
    ["Files, Git & automation", "Explore files, terminal, and Git in the workspace panel. Set up reusable workflows, scheduled tasks, and connected tools from Settings. Review changes before you commit."],
  ] },
} as const;

function TourStep({ page }: { page: keyof typeof TOUR_PAGES }) {
  const content = TOUR_PAGES[page];
  return <div className="onboarding-page"><div className="onboarding-copy"><span className="onboarding-eyebrow">{content.eyebrow}</span><h2>{content.title}</h2><p>{content.intro}</p></div>
    {page === "appearance" && <AppearancePreview />}
    <div className="onboarding-control-list">{content.cards.map(([title, detail], index) => <div key={title}><span className="control-icon prompt">{index + 1}</span><span><strong>{title}</strong><small>{detail}</small></span></div>)}</div>
  </div>;
}

function AppearancePreview() {
  const [effort, setEffort] = useState(50);
  return <div className="onboarding-style-demo" style={{ "--demo-speed": `${2.4 - effort / 65}s` } as React.CSSProperties}>
    <div><span className="onboarding-swatches" aria-hidden="true"><i /><i /><i /></span><strong>Your next great idea.</strong><small>Try the motion · preview only</small></div>
    <input type="range" min="0" max="100" value={effort} onChange={(event) => setEffort(Number(event.target.value))} aria-label="Preview slider animation speed" />
  </div>;
}

function WorkspacesStep() {
  return <div className="onboarding-page">
    <div className="onboarding-copy">
      <span className="onboarding-eyebrow">Two clear places to talk</span>
      <h2>Projects know your folder. Normal chats do not.</h2>
      <p>Choose based on whether the model should work inside a real folder on your computer. Every thread remains attached to the place where it was created.</p>
    </div>
    <div className="onboarding-workspace-grid">
      <article className="onboarding-workspace-card project">
        <div className="onboarding-workspace-visual"><FolderOpen size={28} /><span>MY APP</span><i /><i /><i /></div>
        <div><strong>Project threads</strong><p>Open a local folder, then start threads inside it. Commands, file reads, edits, Git, and the workspace panel all begin in that project folder.</p></div>
        <ul><li><Check size={12} /> Listed beneath that project</li><li><Check size={12} /> Can edit files with permission</li><li><Check size={12} /> Removing a project never deletes its folder</li></ul>
      </article>
      <article className="onboarding-workspace-card chat">
        <div className="onboarding-workspace-visual"><MessageSquare size={28} /><span>NORMAL CHAT</span><i /><i /></div>
        <div><strong>Normal chats</strong><p>Use the dedicated Chats section when you want a conversation without attaching one of your project folders.</p></div>
        <ul><li><Check size={12} /> Saved under Normal chats</li><li><Check size={12} /> No project folder attached</li><li><Check size={12} /> Great for questions and planning</li></ul>
      </article>
    </div>
    <div className="onboarding-flow-line"><span>Sidebar</span><ChevronRight size={12} /><span>Choose a project or Normal chats</span><ChevronRight size={12} /><span>New thread</span></div>
  </div>;
}

function ControlsStep() {
  return <div className="onboarding-page">
    <div className="onboarding-copy">
      <span className="onboarding-eyebrow">Nothing important is hidden</span>
      <h2>You decide what the harness may do.</h2>
      <p>The controls beneath the composer are part of every thread. Review them before sending work that can change your machine.</p>
    </div>
    <div className="onboarding-permission-row">
      <article><Shield size={17} /><strong>Read only</strong><small>Inspect and explain without changing files or using the network.</small></article>
      <article className="recommended"><ShieldCheck size={17} /><strong>Ask to act</strong><small>Work locally, but pause when an action needs your approval.</small><em>Recommended</em></article>
      <article><ShieldAlert size={17} /><strong>Full access</strong><small>Act without approval prompts. Use only for work you trust.</small></article>
    </div>
    <div className="onboarding-control-list">
      <div><span className="control-icon prompt">Aa</span><span><strong>Your harness prompt</strong><small>Mythra Code starts with an empty base instruction. Add your own in Settings → Prompts; the app does not add a hidden harness prompt.</small></span></div>
      <div><span className="control-icon agents"><Bot size={14} /></span><span><strong>Sub-agents are opt-in</strong><small>Enable them per new thread and build a crew from your connected models. They inherit the thread’s permissions.</small></span></div>
      <div><span className="control-icon stop"><X size={14} /></span><span><strong>You can stop and inspect</strong><small>Stop an active turn at any time. Thinking and executed commands stay compact and expandable in the conversation.</small></span></div>
    </div>
  </div>;
}

function SkillsStep({ skillsFolder, onChooseSkillsFolder }: { skillsFolder: string; onChooseSkillsFolder: () => void }) {
  return <div className="onboarding-page skills-page">
    <div className="onboarding-copy">
      <span className="onboarding-eyebrow">Reusable instructions you own</span>
      <h2>Skills are local Markdown playbooks.</h2>
      <p>Choose one folder as your skills library. Mythra Code scans it and makes enabled skills available by their app name.</p>
    </div>
    <div className="onboarding-skills-layout">
      <div className="onboarding-folder-tree">
        <div><FolderOpen size={15} /><strong>My Skills</strong></div>
        <span><i />review-code.md <em>@CodeReview</em></span>
        <span><i />release-app.md <em>@Release</em></span>
        <span><i />design/</span>
        <span className="nested"><i />SKILL.md <em>@Design</em></span>
        <span className="nested reference"><i />references.md</span>
      </div>
      <div className="onboarding-skill-rules">
        <div><b>1</b><span><strong>Import or create Markdown</strong><small>Top-level Markdown files and folders containing SKILL.md become skills.</small></span></div>
        <div><b>2</b><span><strong>Edit them in the app</strong><small>Update the Markdown or change its Mythra Code invocation name without leaving settings.</small></span></div>
        <div><b>3</b><span><strong>Reference supporting Markdown</strong><small>A skill can point to other Markdown files when its instructions need more detail.</small></span></div>
        <div><b>4</b><span><strong>The model calls the enabled skill</strong><small>It uses the app-facing name when the workflow matches your request.</small></span></div>
      </div>
    </div>
    <div className="onboarding-folder-action">
      <span><Boxes size={15} /><span><strong>{skillsFolder ? "Skills folder selected" : "Skills are optional"}</strong><small>{skillsFolder || "You can choose one now or return from Settings → Skills later."}</small></span></span>
      <button className="secondary-button" onClick={onChooseSkillsFolder}>{skillsFolder ? "Change folder" : "Choose folder"}</button>
    </div>
  </div>;
}

function ReadyStep({ runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady, lmStudioReady, skillsFolder, onDestination }: {
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus: ClaudeRuntimeStatus | null;
  cursorStatus: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
  lmStudioReady: boolean;
  skillsFolder: string;
  onDestination: (destination: "models" | "project" | "chat") => void;
}) {
  const providerReady = account?.type === "chatgpt" || claudeStatus?.loggedIn || cursorStatus?.loggedIn || openRouterReady || lmStudioReady;
  const runtimeReady = runtimeStatus?.available || claudeStatus?.available || cursorStatus?.available;
  return <div className="onboarding-page ready-page">
    <div className="onboarding-ready-mark"><Check size={28} /></div>
    <div className="onboarding-copy centered">
      <span className="onboarding-eyebrow">Tour complete</span>
      <h2>Mythra Code is yours to direct.</h2>
      <p>Connect a provider, choose where the thread belongs, set its permissions, and start building. You can rerun this guide from Interface Settings at any time.</p>
    </div>
    <div className="onboarding-checklist">
      <div className={runtimeReady ? "done" : ""}><span>{runtimeReady ? <Check size={13} /> : <TerminalSquare size={13} />}</span><strong>Local runtime</strong><small>{runtimeStatus?.available ? `${runtimeStatus.source ?? "Codex"} detected` : claudeStatus?.available ? "Claude Code detected" : cursorStatus?.available ? "Cursor Agent detected" : "Install a provider runtime"}</small></div>
      <div className={providerReady ? "done" : ""}><span>{providerReady ? <Check size={13} /> : <KeyRound size={13} />}</span><strong>Model provider</strong><small>{account?.type === "chatgpt" ? "ChatGPT connected" : claudeStatus?.loggedIn ? "Claude connected" : cursorStatus?.loggedIn ? "Cursor connected" : openRouterReady ? "OpenRouter connected" : lmStudioReady ? "LM Studio connected" : "Connect in Settings"}</small></div>
      <div className={skillsFolder ? "done" : "optional"}><span>{skillsFolder ? <Check size={13} /> : <Boxes size={13} />}</span><strong>Skills folder</strong><small>{skillsFolder ? "Ready" : "Optional · set up later"}</small></div>
    </div>
    <div className="onboarding-destinations">
      <button className="onboarding-destination models" onClick={() => onDestination("models")}><span><KeyRound size={17} /></span><div><strong>Connect a provider</strong><small>Models & accounts</small></div><ArrowRight size={14} /></button>
      <button className="onboarding-destination project" onClick={() => onDestination("project")}><span><FolderOpen size={17} /></span><div><strong>Open a project</strong><small>Work inside a folder</small></div><ArrowRight size={14} /></button>
      <button className="onboarding-destination chat" onClick={() => onDestination("chat")}><span><MessageSquare size={17} /></span><div><strong>Start a normal chat</strong><small>No project attached</small></div><ArrowRight size={14} /></button>
    </div>
  </div>;
}

export function OnboardingModal({
  open,
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
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus?: ClaudeRuntimeStatus | null;
  cursorStatus?: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
  lmStudioReady?: boolean;
  skillsFolder: string;
  onComplete: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  onChooseSkillsFolder: () => void;
  onAddProject: () => void;
  onStartChat: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const headingRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, open);
  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open, stepIndex]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onComplete();
      if (event.key === "ArrowRight" && stepIndex < STEPS.length - 1) setStepIndex((current) => current + 1);
      if (event.key === "ArrowLeft" && stepIndex > 0) setStepIndex((current) => current - 1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onComplete, open, stepIndex]);

  const step = STEPS[stepIndex];
  const destination = (target: "models" | "project" | "chat") => {
    onComplete();
    if (target === "models") onOpenSettings("models");
    else if (target === "project") onAddProject();
    else onStartChat();
  };
  let content: ReactNode;
  if (step.id === "welcome") content = <div className="onboarding-page welcome-page">
    <div className="onboarding-hero-mark"><img src="/mythra-code-logo.svg" alt="" /></div>
    <div className="onboarding-copy centered">
      <span className="onboarding-eyebrow">Welcome to Mythra Code</span>
      <h2>A transparent AI coding harness, set up your way.</h2>
      <p>Mythra Code brings models, local project work, normal chats, approvals, agents, and skills into one desktop app—without adding a hidden harness-level system prompt.</p>
    </div>
    <div className="onboarding-principles">
      <div><ShieldCheck size={16} /><span><strong>Your permissions</strong><small>Read only, ask first, or full access</small></span></div>
      <div><TerminalSquare size={16} /><span><strong>Your computer</strong><small>Projects and commands stay local</small></span></div>
      <div><NotebookPen size={16} /><span><strong>Your instructions</strong><small>The base prompt starts empty</small></span></div>
    </div>
    <div className="onboarding-time"><i /><span>Explore at your own pace</span><i /></div>
  </div>;
  else if (step.id === "providers") content = <ProviderStep runtimeStatus={runtimeStatus} claudeStatus={claudeStatus} cursorStatus={cursorStatus} account={account} openRouterReady={openRouterReady} lmStudioReady={lmStudioReady} />;
  else if (step.id === "workspaces") content = <WorkspacesStep />;
  else if (step.id === "controls") content = <ControlsStep />;
  else if (step.id === "appearance" || step.id === "agents" || step.id === "tools") content = <TourStep page={step.id} />;
  else if (step.id === "skills") content = <SkillsStep skillsFolder={skillsFolder} onChooseSkillsFolder={onChooseSkillsFolder} />;
  else content = <ReadyStep runtimeStatus={runtimeStatus} claudeStatus={claudeStatus} cursorStatus={cursorStatus} account={account} openRouterReady={openRouterReady} lmStudioReady={lmStudioReady} skillsFolder={skillsFolder} onDestination={destination} />;

  return <div className={`modal-backdrop onboarding-backdrop ${open ? "open" : "closed"}`} aria-hidden={!open} inert={!open ? true : undefined}>
    <div ref={dialogRef} className="onboarding-modal" role="dialog" aria-modal="true" aria-label="Mythra Code onboarding">
      <aside className="onboarding-rail">
        <div className="onboarding-brand"><span><img src="/mythra-code-glyph.svg" alt="" /></span><div><strong>Mythra Code</strong><small>Getting started</small></div></div>
        <nav aria-label="Onboarding progress">
          {STEPS.map(({ id, label, icon: Icon }, index) => <button key={id} className={`${index === stepIndex ? "active" : ""} ${index < stepIndex ? "complete" : ""}`} onClick={() => setStepIndex(index)} aria-current={index === stepIndex ? "step" : undefined}>
            <span>{index < stepIndex ? <Check size={12} /> : <Icon size={13} />}</span><em>{label}</em>
          </button>)}
        </nav>
        <div className="onboarding-rail-foot"><span>{stepIndex + 1} of {STEPS.length}</span><div><i style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }} /></div></div>
      </aside>
      <main className="onboarding-main">
        <button className="onboarding-close" onClick={onComplete} aria-label="Skip onboarding"><X size={17} /></button>
        <div ref={headingRef} tabIndex={-1} data-autofocus className="onboarding-stage" key={step.id}>{content}</div>
        <footer className="onboarding-footer">
          <button className="onboarding-skip" onClick={onComplete}>Skip tour</button>
          <div>
            <button className="secondary-button" onClick={() => setStepIndex((current) => Math.max(0, current - 1))} disabled={stepIndex === 0}><ChevronLeft size={13} /> Back</button>
            {stepIndex < STEPS.length - 1 ? <button className="primary-button" onClick={() => setStepIndex((current) => current + 1)}>Continue <ChevronRight size={13} /></button> : <button className="primary-button" onClick={onComplete}>Done <Check size={13} /></button>}
          </div>
        </footer>
      </main>
    </div>
  </div>;
}
