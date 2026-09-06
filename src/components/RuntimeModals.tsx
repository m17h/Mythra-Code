import type { ReactNode } from "react";
import { Check, Download, ExternalLink, KeyRound, LoaderCircle, RotateCcw, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

function RuntimeDialog({ open, onClose, auth = false, mark, eyebrow, title, description, children }: {
  open: boolean; onClose: () => void; auth?: boolean; mark: ReactNode;
  eyebrow: string; title: string; description: string; children: ReactNode;
}) {
  const prefix = auth ? "auth-required" : "runtime-setup";
  return (
    <div className={`modal-backdrop runtime-setup-backdrop ${auth ? "auth-required-backdrop" : ""} ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className={`runtime-setup-modal ${auth ? "auth-required-modal" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${prefix}-title`} onMouseDown={(event) => event.stopPropagation()}>
        <button className="runtime-setup-close" onClick={onClose} aria-label={auth ? "Close sign-in prompt" : "Close Codex setup"}><X size={17} /></button>
        <div className={`runtime-setup-mark ${auth ? "auth-mark" : ""}`}>{mark}</div>
        <div className="runtime-setup-copy">
          <span className="runtime-eyebrow">{eyebrow}</span>
          <h2 id={`${prefix}-title`}>{title}</h2>
          <p>{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function RuntimeSetupModal({
  open,
  checking,
  onClose,
  onRetry,
}: {
  open: boolean;
  checking: boolean;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <RuntimeDialog open={open} onClose={onClose} mark={<TerminalSquare size={25} />} eyebrow="One-time setup" title="Connect the Codex runtime" description="Install the official Codex CLI for ChatGPT sign-in, OpenRouter, tools, approvals, and threads.">
        <div className="runtime-options">
          <div className="runtime-option recommended">
            <span className="runtime-option-icon"><Download size={17} /></span>
            <div><strong>Codex CLI <em>Recommended</em></strong><small>For macOS and Windows.</small></div>
          </div>
        </div>
        <div className="runtime-note"><Check size={13} /> ChatGPT sign-in uses your browser and Mythra Code’s isolated credential store.</div>
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          <button className="secondary-button" onClick={() => void openUrl("https://learn.chatgpt.com/docs/codex/cli")}><ExternalLink size={13} /> Installation guide</button>
          <button className="primary-button" onClick={onRetry} disabled={checking}>{checking ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={13} />} Try again</button>
        </div>
    </RuntimeDialog>
  );
}

export function AuthRequiredModal({
  open,
  busy,
  onClose,
  onSignIn,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSignIn: () => void;
}) {
  return (
    <RuntimeDialog open={open} onClose={onClose} auth mark={<KeyRound size={24} />} eyebrow="ChatGPT authentication" title="Sign in before sending" description="Sign in to reconnect your ChatGPT subscription.">
        <div className="auth-required-detail">
          <ShieldCheck size={17} />
          <div><strong>Official browser sign-in</strong><small>Browser sign-in keeps credentials in Mythra Code’s isolated store.</small></div>
        </div>
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          <button className="primary-button" onClick={onSignIn} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={13} />} Sign in with ChatGPT</button>
        </div>
    </RuntimeDialog>
  );
}
