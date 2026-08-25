import { Check, Download, ExternalLink, KeyRound, LoaderCircle, RotateCcw, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

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
    <div className={`modal-backdrop runtime-setup-backdrop ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="runtime-setup-modal" role="dialog" aria-modal="true" aria-labelledby="runtime-setup-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="runtime-setup-close" onClick={onClose} aria-label="Close Codex setup"><X size={17} /></button>
        <div className="runtime-setup-mark"><TerminalSquare size={25} /></div>
        <div className="runtime-setup-copy">
          <span className="runtime-eyebrow">One-time setup</span>
          <h2 id="runtime-setup-title">Connect the Codex runtime</h2>
          <p>Mythra Code uses Codex App Server locally for ChatGPT subscription sign-in, OpenRouter, tools, approvals, and threads. Install the official Codex CLI to continue.</p>
        </div>
        <div className="runtime-options">
          <div className="runtime-option recommended">
            <span className="runtime-option-icon"><Download size={17} /></span>
            <div><strong>Codex CLI <em>Recommended</em></strong><small>The dependable cross-platform option and easiest runtime to keep current.</small></div>
          </div>
        </div>
        <div className="runtime-note"><Check size={13} /> Your ChatGPT login still happens in the official browser flow and remains isolated to Mythra Code.</div>
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          <button className="secondary-button" onClick={() => void openUrl("https://learn.chatgpt.com/docs/codex/cli")}><ExternalLink size={13} /> Installation guide</button>
          <button className="primary-button" onClick={onRetry} disabled={checking}>{checking ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={13} />} Try again</button>
        </div>
      </div>
    </div>
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
    <div className={`modal-backdrop runtime-setup-backdrop auth-required-backdrop ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div className="runtime-setup-modal auth-required-modal" role="dialog" aria-modal="true" aria-labelledby="auth-required-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="runtime-setup-close" onClick={onClose} aria-label="Close sign-in prompt"><X size={17} /></button>
        <div className="runtime-setup-mark auth-mark"><KeyRound size={24} /></div>
        <div className="runtime-setup-copy">
          <span className="runtime-eyebrow">ChatGPT authentication</span>
          <h2 id="auth-required-title">Sign in before sending</h2>
          <p>OpenAI models cannot receive this prompt until a ChatGPT account is connected. Your draft is still waiting in the composer and has not been sent.</p>
        </div>
        <div className="auth-required-detail">
          <ShieldCheck size={17} />
          <div><strong>Official browser sign-in</strong><small>Codex opens ChatGPT in your default browser and stores the resulting session inside Mythra Code’s isolated credential store.</small></div>
        </div>
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          <button className="primary-button" onClick={onSignIn} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={13} />} Sign in with ChatGPT</button>
        </div>
      </div>
    </div>
  );
}
