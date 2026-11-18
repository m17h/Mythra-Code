import { useRef, type ReactNode } from "react";
import { Download, ExternalLink, KeyRound, LoaderCircle, RotateCcw, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useModalFocus } from "../hooks/useModalFocus";

const CODEX_CLI_GUIDE = "https://learn.chatgpt.com/docs/codex/cli";

function RuntimeDialog({ open, onClose, auth = false, mark, eyebrow, title, description, children }: {
  open: boolean; onClose: () => void; auth?: boolean; mark: ReactNode;
  eyebrow: string; title: string; description: string; children: ReactNode;
}) {
  const prefix = auth ? "auth-required" : "runtime-setup";
  const dialogRef = useRef<HTMLDivElement>(null);
  // Shared modal contract: the app behind is inert, Tab stays inside,
  // Escape closes (same as "Not now"), focus returns to the opener.
  useModalFocus(dialogRef, open, { onEscape: onClose });
  return (
    <div className={`modal-backdrop runtime-setup-backdrop ${auth ? "auth-required-backdrop" : ""} ${open ? "open" : "closed"}`} onMouseDown={onClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div ref={dialogRef} className={`runtime-setup-modal ${auth ? "auth-required-modal" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${prefix}-title`} onMouseDown={(event) => event.stopPropagation()}>
        <button className="runtime-setup-close" onClick={onClose} aria-label={auth ? "Close sign-in prompt" : "Close Codex CLI setup"}><X size={17} /></button>
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
    <RuntimeDialog open={open} onClose={onClose} mark={<TerminalSquare size={25} />} eyebrow="One-time setup" title="Install the Codex CLI" description="Mythra Code uses the Codex CLI to run OpenAI, OpenRouter and LM Studio models. Install it, then check again here. Claude and Cursor don’t need it.">
        {/* The install guide is the step that fixes this, so it leads; the
            card is that same link, not a decorative option. */}
        <div className="runtime-options">
          <button type="button" className="runtime-option recommended" onClick={() => void openUrl(CODEX_CLI_GUIDE)}>
            <span className="runtime-option-icon"><Download size={17} /></span>
            <div><strong>Codex CLI installation guide</strong><small>Official instructions for macOS and Windows. Opens in your browser.</small></div>
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        </div>
        {/* D15/M13: one install-guide action (the card above). The sign-in
            note belonged to a different step, so it's gone from here. */}
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          <button className="secondary-button" onClick={onRetry} disabled={checking}>{checking ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={13} />} {checking ? "Checking…" : "Check again"}</button>
        </div>
    </RuntimeDialog>
  );
}

export function AuthRequiredModal({
  open,
  busy,
  apiKeyBilling = false,
  onClose,
  onSignIn,
  onUseApiKey,
}: {
  open: boolean;
  busy: boolean;
  apiKeyBilling?: boolean;
  onClose: () => void;
  onSignIn: () => void;
  /** Opens Models & accounts, where an OpenAI API key can be used instead. */
  onUseApiKey?: () => void;
}) {
  return (
    <RuntimeDialog open={open} onClose={onClose} auth mark={<KeyRound size={24} />} eyebrow="OpenAI authentication" title={apiKeyBilling ? "Connect an API key before sending" : "Sign in before sending"} description={apiKeyBilling ? "OpenAI is set to API billing. Connect your key in Models & accounts to continue." : "Sign in to reconnect your ChatGPT subscription, or use an OpenAI API key billed to your API account."}>
        <div className="auth-required-detail">
          <ShieldCheck size={17} />
          <div><strong>{apiKeyBilling ? "Your selected API billing" : "Official browser sign-in"}</strong><small>{apiKeyBilling ? "Your key stays in the OS credential store. Change billing in Models & accounts to use a subscription." : "Browser sign-in keeps credentials in Mythra Code’s isolated store."}</small></div>
        </div>
        <div className="runtime-setup-actions">
          <button className="secondary-button" onClick={onClose}>Not now</button>
          {onUseApiKey && <button className={apiKeyBilling ? "primary-button" : "secondary-button"} onClick={onUseApiKey} disabled={busy}>{apiKeyBilling ? "Models & accounts" : "Use an API key"}</button>}
          {!apiKeyBilling && <button className="primary-button" onClick={onSignIn} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={13} />} Sign in with ChatGPT</button>}
        </div>
    </RuntimeDialog>
  );
}
