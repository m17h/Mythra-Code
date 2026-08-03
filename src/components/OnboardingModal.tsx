import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  KeyRound,
  MessageSquare,
  NotebookPen,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  WandSparkles,
  X,
} from "lucide-react";
import type { CodexRuntimeStatus } from "../lib/codex";
import type { ClaudeRuntimeStatus } from "../lib/claude";
import type { CursorRuntimeStatus } from "../lib/cursor";
import type { Account, SettingsSection } from "../types";
import { useModalFocus } from "../hooks/useModalFocus";
import { ClaudeLogo, CursorLogo, OpenAILogo } from "./BrandLogos";

const CODEX_INSTALL_URL = "https://learn.chatgpt.com/docs/codex/cli";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";
const OPENROUTER_GUIDE_URL = "https://openrouter.ai/docs/quickstart";
const CLAUDE_INSTALL_URL = "https://docs.anthropic.com/en/docs/claude-code/setup";
const CURSOR_INSTALL_URL = "https://cursor.com/docs/cli/installation";

const STEPS = [
  { id: "welcome", label: "Welcome", icon: Sparkles },
  { id: "providers", label: "Connect AI", icon: KeyRound },
  { id: "workspaces", label: "Projects & chats", icon: FolderOpen },
  { id: "controls", label: "Your controls", icon: ShieldCheck },
  { id: "skills", label: "Local skills", icon: Boxes },
  { id: "ready", label: "Ready to build", icon: WandSparkles },
] as const;

function StatusPill({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <span className={`onboarding-status ${ready ? "ready" : "waiting"}`}><i />{children}</span>;
}

function ProviderStep({ runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady }: {
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus: ClaudeRuntimeStatus | null;
  cursorStatus: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
}) {
  const runtimeReady = Boolean(runtimeStatus?.available);
  const chatGptReady = account?.type === "chatgpt";
  return <div className="onboarding-page providers-page">
    <div className="onboarding-copy">
      <span className="onboarding-eyebrow">Choose your provider</span>
      <h2>Connect the models you want to use.</h2>
      <p>Subscription providers use their official local coding runtime and browser login. OpenRouter uses the API key you provide through OpenKiwi.</p>
    </div>
    <div className="onboarding-provider-grid">
      <article className="onboarding-provider-card openai">
        <div className="onboarding-card-title"><span><OpenAILogo size={18} /></span><div><strong>ChatGPT subscription</strong><small>OpenAI authentication</small></div></div>
        <ol>
          <li><b>1</b><span>Install <strong>Codex CLI</strong> (recommended) or ChatGPT for macOS. OpenKiwi detects the runtime automatically.</span></li>
          <li><b>2</b><span>Open <strong>Settings → Models & accounts</strong> and choose OpenAI.</span></li>
          <li><b>3</b><span>Select <strong>Sign in</strong>. The official ChatGPT flow opens in your browser.</span></li>
        </ol>
        <div className="onboarding-card-footer">
          <StatusPill ready={runtimeReady}>{runtimeReady ? `${runtimeStatus?.source ?? "Codex"} detected` : "Codex runtime needed"}</StatusPill>
          <StatusPill ready={chatGptReady}>{chatGptReady ? "ChatGPT connected" : "Not signed in"}</StatusPill>
        </div>
        <button className="onboarding-link-button" onClick={() => void openUrl(CODEX_INSTALL_URL)}><ExternalLink size={12} /> Codex installation guide</button>
      </article>

      <article className="onboarding-provider-card claude">
        <div className="onboarding-card-title"><span><ClaudeLogo size={18} /></span><div><strong>Claude subscription</strong><small>Claude Code authentication</small></div></div>
        <ol>
          <li><b>1</b><span>Install <strong>Claude Code</strong>. OpenKiwi detects the local executable automatically.</span></li>
          <li><b>2</b><span>Run <strong>claude auth login</strong>, or select Sign in from Models & accounts.</span></li>
          <li><b>3</b><span>Choose Claude, then select Fable, Opus, Sonnet, or Haiku beneath the composer.</span></li>
        </ol>
        <div className="onboarding-card-footer">
          <StatusPill ready={Boolean(claudeStatus?.available)}>{claudeStatus?.available ? "Claude Code detected" : "Claude Code needed"}</StatusPill>
          <StatusPill ready={Boolean(claudeStatus?.loggedIn)}>{claudeStatus?.loggedIn ? "Claude connected" : "Not signed in"}</StatusPill>
        </div>
        <button className="onboarding-link-button" onClick={() => void openUrl(CLAUDE_INSTALL_URL)}><ExternalLink size={12} /> Claude Code setup</button>
      </article>

      <article className="onboarding-provider-card cursor">
        <div className="onboarding-card-title"><span><CursorLogo size={18} /></span><div><strong>Cursor subscription</strong><small>Cursor Agent authentication</small></div></div>
        <ol>
          <li><b>1</b><span>Install <strong>Cursor Agent</strong>. OpenKiwi detects the official local executable automatically.</span></li>
          <li><b>2</b><span>Choose Cursor in <strong>Models & accounts</strong>, then complete its official browser sign-in.</span></li>
          <li><b>3</b><span>Select Grok 4.5 or another model from the live catalog attached to your subscription.</span></li>
        </ol>
        <div className="onboarding-card-footer">
          <StatusPill ready={Boolean(cursorStatus?.available)}>{cursorStatus?.available ? "Cursor Agent detected" : "Cursor Agent needed"}</StatusPill>
          <StatusPill ready={Boolean(cursorStatus?.loggedIn)}>{cursorStatus?.loggedIn ? "Cursor connected" : "Not signed in"}</StatusPill>
        </div>
        <button className="onboarding-link-button" onClick={() => void openUrl(CURSOR_INSTALL_URL)}><ExternalLink size={12} /> Cursor Agent setup</button>
      </article>

      <article className="onboarding-provider-card openrouter">
        <div className="onboarding-card-title"><span><Bot size={18} /></span><div><strong>OpenRouter</strong><small>One key, broad model catalog</small></div></div>
        <ol>
          <li><b>1</b><span>Create or sign in to OpenRouter, add credits if your chosen model requires them, and create an <strong>API key</strong>.</span></li>
          <li><b>2</b><span>Paste the key in <strong>Settings → Models & accounts</strong>. It is stored in your OS credential store.</span></li>
          <li><b>3</b><span>Choose OpenRouter, then search its model picker beneath the composer.</span></li>
        </ol>
        <div className="onboarding-card-footer">
          <StatusPill ready={runtimeReady}>{runtimeReady ? "Runtime ready" : "Codex runtime needed"}</StatusPill>
          <StatusPill ready={openRouterReady}>{openRouterReady ? "API key stored" : "API key needed"}</StatusPill>
        </div>
        <div className="onboarding-card-links">
          <button className="onboarding-link-button" onClick={() => void openUrl(OPENROUTER_KEYS_URL)}><ExternalLink size={12} /> Create API key</button>
          <button className="onboarding-link-button" onClick={() => void openUrl(OPENROUTER_GUIDE_URL)}><ExternalLink size={12} /> Quickstart</button>
        </div>
      </article>
    </div>
    <div className="onboarding-note"><ShieldCheck size={14} /><span>OpenKiwi never asks you to paste a subscription password. ChatGPT, Claude, and Cursor use their official local login; OpenRouter uses the API key you provide.</span></div>
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
      <div><span className="control-icon prompt">Aa</span><span><strong>Your harness prompt</strong><small>OpenKiwi starts with an empty base instruction. Add your own in Settings → Prompts; the app does not add a hidden harness prompt.</small></span></div>
      <div><span className="control-icon agents"><Bot size={14} /></span><span><strong>Sub-agents are opt-in</strong><small>Enable them per new thread and choose a maximum of 1–24 direct child agents. They inherit the thread’s permissions.</small></span></div>
      <div><span className="control-icon stop"><X size={14} /></span><span><strong>You can stop and inspect</strong><small>Stop an active turn at any time. Thinking and executed commands stay compact and expandable in the conversation.</small></span></div>
    </div>
  </div>;
}

function SkillsStep({ skillsFolder, onChooseSkillsFolder }: { skillsFolder: string; onChooseSkillsFolder: () => void }) {
  return <div className="onboarding-page skills-page">
    <div className="onboarding-copy">
      <span className="onboarding-eyebrow">Reusable instructions you own</span>
      <h2>Skills are local Markdown playbooks.</h2>
      <p>Choose one folder as your skills library. OpenKiwi scans it and exposes enabled skills by their app name to OpenAI, Claude, and OpenRouter models.</p>
    </div>
    <div className="onboarding-skills-layout">
      <div className="onboarding-folder-tree">
        <div><FolderOpen size={15} /><strong>My Skills</strong></div>
        <span><i />review-code.md <em>$CodeReview</em></span>
        <span><i />release-app.md <em>$Release</em></span>
        <span><i />design/</span>
        <span className="nested"><i />SKILL.md <em>$Design</em></span>
        <span className="nested reference"><i />references.md</span>
      </div>
      <div className="onboarding-skill-rules">
        <div><b>1</b><span><strong>Import or create Markdown</strong><small>Top-level Markdown files and folders containing SKILL.md become skills.</small></span></div>
        <div><b>2</b><span><strong>Name them in the app</strong><small>Names start from the file, but you may rename a skill in OpenKiwi without renaming the file.</small></span></div>
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

function ReadyStep({ runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady, skillsFolder, onDestination }: {
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus: ClaudeRuntimeStatus | null;
  cursorStatus: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
  skillsFolder: string;
  onDestination: (destination: "models" | "project" | "chat") => void;
}) {
  const providerReady = account?.type === "chatgpt" || claudeStatus?.loggedIn || cursorStatus?.loggedIn || openRouterReady;
  const runtimeReady = runtimeStatus?.available || claudeStatus?.available || cursorStatus?.available;
  return <div className="onboarding-page ready-page">
    <div className="onboarding-ready-mark"><Check size={28} /></div>
    <div className="onboarding-copy centered">
      <span className="onboarding-eyebrow">Tour complete</span>
      <h2>OpenKiwi is yours to direct.</h2>
      <p>Connect a provider, choose where the thread belongs, set its permissions, and start building. You can rerun this guide from General Settings at any time.</p>
    </div>
    <div className="onboarding-checklist">
      <div className={runtimeReady ? "done" : ""}><span>{runtimeReady ? <Check size={13} /> : <TerminalSquare size={13} />}</span><strong>Local runtime</strong><small>{runtimeStatus?.available ? `${runtimeStatus.source ?? "Codex"} detected` : claudeStatus?.available ? "Claude Code detected" : cursorStatus?.available ? "Cursor Agent detected" : "Install a provider runtime"}</small></div>
      <div className={providerReady ? "done" : ""}><span>{providerReady ? <Check size={13} /> : <KeyRound size={13} />}</span><strong>Model provider</strong><small>{account?.type === "chatgpt" ? "ChatGPT connected" : claudeStatus?.loggedIn ? "Claude connected" : cursorStatus?.loggedIn ? "Cursor connected" : openRouterReady ? "OpenRouter connected" : "Connect in Settings"}</small></div>
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
    <div className="onboarding-hero-mark"><span>OK</span><i /><i /></div>
    <div className="onboarding-copy centered">
      <span className="onboarding-eyebrow">Welcome to OpenKiwi</span>
      <h2>A transparent AI coding harness, set up your way.</h2>
      <p>OpenKiwi brings models, local project work, normal chats, approvals, agents, and skills into one desktop app—without adding a hidden harness-level system prompt.</p>
    </div>
    <div className="onboarding-principles">
      <div><ShieldCheck size={16} /><span><strong>Your permissions</strong><small>Read only, ask first, or full access</small></span></div>
      <div><TerminalSquare size={16} /><span><strong>Your computer</strong><small>Projects and commands stay local</small></span></div>
      <div><NotebookPen size={16} /><span><strong>Your instructions</strong><small>The base prompt starts empty</small></span></div>
    </div>
    <div className="onboarding-time"><i /><span>About two minutes</span><i /></div>
  </div>;
  else if (step.id === "providers") content = <ProviderStep runtimeStatus={runtimeStatus} claudeStatus={claudeStatus} cursorStatus={cursorStatus} account={account} openRouterReady={openRouterReady} />;
  else if (step.id === "workspaces") content = <WorkspacesStep />;
  else if (step.id === "controls") content = <ControlsStep />;
  else if (step.id === "skills") content = <SkillsStep skillsFolder={skillsFolder} onChooseSkillsFolder={onChooseSkillsFolder} />;
  else content = <ReadyStep runtimeStatus={runtimeStatus} claudeStatus={claudeStatus} cursorStatus={cursorStatus} account={account} openRouterReady={openRouterReady} skillsFolder={skillsFolder} onDestination={destination} />;

  return <div className={`modal-backdrop onboarding-backdrop ${open ? "open" : "closed"}`} aria-hidden={!open} inert={!open ? true : undefined}>
    <div ref={dialogRef} className="onboarding-modal" role="dialog" aria-modal="true" aria-label="OpenKiwi onboarding">
      <aside className="onboarding-rail">
        <div className="onboarding-brand"><span>OK</span><div><strong>OpenKiwi</strong><small>Getting started</small></div></div>
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
