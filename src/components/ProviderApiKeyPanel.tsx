import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ExternalLink, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { confirmDialog } from "../lib/confirmDialog";
import { safeErrorText } from "../lib/errors";
import {
  activateOpenAiApiKey,
  getProviderAuthStatus,
  PROVIDER_API_LINKS,
  removeProviderApiKey,
  saveProviderApiKey,
  saveAndConnectOpenAiApiKey,
  setClaudeBilling,
  setOpenAiBilling,
  type ApiKeyProvider,
  type ClaudeBilling,
  type ProviderAuthStatus,
  type ProviderKeyState,
} from "../lib/providerAuth";
import type { ClaudeRuntimeStatus } from "../lib/claude";
import type { Account } from "../types";
import "./ProviderApiKeyPanel.css";

type Busy = "saving" | "using" | "removing" | "billing" | "signingIn" | "signingOut" | "refreshing" | null;

/** Owned by Settings so changing panes cannot release an unfinished command. */
export function useProviderAuthOperation() {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const begin = useCallback((operation: Exclude<Busy, null>) => {
    if (pending.current) return null;
    pending.current = true;
    setBusy(operation);
    return () => {
      pending.current = false;
      setBusy(null);
    };
  }, []);
  return { busy, begin, error, setError, notice, setNotice };
}

type AuthOperation = ReturnType<typeof useProviderAuthOperation>;

function openExternal(url: string): void {
  void openUrl(url).catch(() => undefined);
}

function ExternalButton({ url, children }: { url: string; children: string }) {
  return <button type="button" className="provider-api-link" onClick={() => openExternal(url)}>{children} <ExternalLink size={11} aria-hidden="true" /></button>;
}

/** Key and billing state, read only while the pane is on screen. */
function useProviderAuthStatus(visible: boolean, busy: Busy) {
  const [status, setStatus] = useState<ProviderAuthStatus | null>(null);
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await getProviderAuthStatus();
      if (requestRef.current === request) setStatus(next);
    } catch {
      // An unanswered read is "can't check", never "no key".
      if (requestRef.current === request) setStatus({ openai: "unavailable", anthropic: "unavailable", openaiBilling: null, claudeBilling: null });
    }
  }, []);
  useEffect(() => {
    // A panel reopened during a command must re-read when that command ends;
    // its previous instance's refresh cannot update the new instance.
    if (visible && !busy) void refresh();
  }, [refresh, visible, busy]);
  return { status, refresh };
}

function keyStatusCopy(state: ProviderKeyState | undefined, saved: string): string {
  if (state === "saved") return saved;
  if (state === "missing") return "No key saved";
  if (state === "unavailable") return "The OS credential store didn't respond. Try again in a moment.";
  return "Checking…";
}

/**
 * Pasted keys leave the field on submit, mode changes and closing Settings;
 * a saved key is never read back into it, including after a failed save.
 */
function KeyInputRow({ provider, visible, billing, state, busy, disabled, saveLabel, onSave, onRemove }: {
  provider: ApiKeyProvider;
  visible: boolean;
  billing: ClaudeBilling | null;
  state: ProviderKeyState | undefined;
  busy: Busy;
  disabled: boolean;
  saveLabel: string;
  onSave: (key: string) => Promise<unknown>;
  onRemove: () => void;
}) {
  const [input, setInput] = useState("");
  useEffect(() => {
    setInput("");
  }, [visible, billing]);
  const label = provider === "openai" ? "OpenAI" : "Anthropic";
  const save = () => {
    const submitted = input.trim();
    if (!submitted || disabled) return;
    // Never retain a pasted credential while native work or a failed save is
    // pending. A retry requires pasting it again.
    setInput("");
    void onSave(submitted);
  };
  return (
    <div className="key-input-row">
      <input
        type="password"
        value={input}
        autoComplete="new-password"
        spellCheck={false}
        aria-label={`${label} API key`}
        placeholder={state === "saved" ? "Paste a new key to replace the saved one" : provider === "openai" ? "sk-proj-…" : "sk-ant-api…"}
        disabled={disabled}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      />
      <button type="button" className="secondary-button" onClick={save} disabled={!input.trim() || disabled}>
        {busy === "saving" && <LoaderCircle className="spin" size={13} />} {saveLabel}
      </button>
      {state === "saved" && (
        <button type="button" className="secondary-button" onClick={onRemove} disabled={disabled}>
          {busy === "removing" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />} Remove
        </button>
      )}
    </div>
  );
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  if (!error && !notice) return null;
  return <small className={error ? "provider-api-error" : "provider-api-notice"} role={error ? "alert" : "status"}>{error || notice}</small>;
}

function BillingOptions({ label, subscription, billing, disabled, onChoose }: {
  label: string;
  subscription: string;
  billing: ClaudeBilling | null;
  disabled: boolean;
  onChoose: (billing: ClaudeBilling) => void;
}) {
  return <div className="provider-billing-options" role="group" aria-label={`${label} billing`}>
    <button type="button" aria-pressed={billing === "subscription"} className={billing === "subscription" ? "selected" : ""} onClick={() => onChoose("subscription")} disabled={disabled}>
      <span><strong>Subscription</strong><small>{subscription} · plan limits</small></span>
      {billing === "subscription" && <Check size={13} />}
    </button>
    <button type="button" aria-pressed={billing === "apiKey"} className={billing === "apiKey" ? "selected" : ""} onClick={() => onChoose("apiKey")} disabled={disabled}>
      <span><strong>API key</strong><small>API billing · credits or pay per token</small></span>
      {billing === "apiKey" && <Check size={13} />}
    </button>
  </div>;
}

/**
 * OpenAI API key for Codex. Codex holds one sign-in in Mythra Code's private
 * profile, so using the key replaces a ChatGPT sign-in there; the key itself
 * stays saved here, so switching back to it later needs no re-entry.
 */
export function OpenAiApiKeyPanel({ visible, account, runtimeAvailable, operation, disabled = false, onChanged, onBillingRead }: {
  visible: boolean;
  account: Account | null;
  runtimeAvailable: boolean;
  operation: AuthOperation;
  disabled?: boolean;
  /** The Codex sign-in changed; re-read the account, catalog and quota. */
  onChanged: () => Promise<void>;
  onBillingRead: (billing: ClaudeBilling | null) => void;
}) {
  const { busy, begin, error, setError, notice, setNotice } = operation;
  const { status, refresh } = useProviderAuthStatus(visible, busy);
  const blocked = disabled || Boolean(busy);
  const billing = status?.openaiBilling ?? null;
  useEffect(() => { onBillingRead(billing); }, [billing, onBillingRead]);
  const inUse = billing === "apiKey" && account?.type === "apiKey";
  const state = status?.openai;

  const activate = async () => {
    if (billing !== "apiKey" || disabled) return;
    const finish = begin("using");
    if (!finish) return;
    setError("");
    setNotice("");
    try {
      await activateOpenAiApiKey();
      setNotice("Codex now bills this API key.");
    } catch (reason) {
      setError(safeErrorText(reason, "Codex could not use the API key."));
    } finally {
      await Promise.allSettled([refresh(), onChanged()]);
      finish();
    }
  };

  const save = async (key: string) => {
    if (!billing || disabled) return false;
    const finish = begin("saving");
    if (!finish) return false;
    setError("");
    setNotice("");
    try {
      // Hold one preparation exclusion for the whole labelled operation.
      // Saving alone never selects API billing.
      if (billing === "apiKey" && runtimeAvailable) {
        await saveAndConnectOpenAiApiKey(key);
        setNotice("Key saved and connected. OpenAI uses API billing only.");
      } else {
        await saveProviderApiKey("openai", key);
        setNotice("Key saved. The billing choice has not changed.");
      }
      return true;
    } catch (reason) {
      setError(safeErrorText(reason, "The key couldn't be saved."));
      return false;
    } finally {
      await Promise.allSettled([refresh(), onChanged()]);
      finish();
    }
  };

  const choose = async (next: ClaudeBilling) => {
    if (disabled || next === billing) return;
    const finish = begin("billing");
    if (!finish) return;
    let attempted = false;
    try {
      if (next === "apiKey" && !(await confirmDialog(
        "Use OpenAI API billing?\n\nNew OpenAI work will require an API key and will not use your ChatGPT plan, even if that key fails or runs out. Connecting the key replaces Codex's ChatGPT sign-in in Mythra Code. Returning to your plan may need browser sign-in again.",
        { confirmLabel: "Select API key" },
      ))) return;
      setError(""); setNotice("");
      attempted = true;
      await setOpenAiBilling(next);
      setNotice(next === "apiKey" ? "API key selected. Save or connect a key below to continue." : "Subscription selected. Sign in with ChatGPT if needed.");
    } catch (reason) {
      setError(safeErrorText(reason, "OpenAI's billing couldn't be changed."));
    } finally {
      // Even if restarting failed, the persisted selection may have changed.
      if (attempted) await Promise.allSettled([refresh(), onChanged()]);
      finish();
    }
  };

  const remove = async () => {
    if (disabled) return;
    const finish = begin("removing");
    if (!finish) return;
    let attempted = false;
    try {
      if (inUse && !(await confirmDialog(
        "Remove the OpenAI API key?\n\nCodex is using this key, so Mythra Code also signs Codex out. Add a key again or select Subscription and sign in with ChatGPT to keep using OpenAI.",
        { confirmLabel: "Remove key" },
      ))) return;
      setError("");
      setNotice("");
      attempted = true;
      const caveat = await removeProviderApiKey("openai");
      setNotice(caveat ?? "Key removed.");
    } catch (reason) {
      setError(safeErrorText(reason, "The key couldn't be removed."));
    } finally {
      if (attempted) await Promise.allSettled([refresh(), onChanged()]);
      finish();
    }
  };

  return (
    <div className="credential-panel stacked provider-api-key" data-settings-row="openai-api-key">
      <div className="credential-status"><div><strong>Bill OpenAI work to</strong><small>{status && billing === null ? "Choose again: the saved choice couldn't be read" : "Applies immediately to chats, sub-agents, titles and helpers"}</small></div>{busy === "billing" && <LoaderCircle className="spin" size={14} />}</div>
      <BillingOptions label="OpenAI" subscription="ChatGPT" billing={billing} disabled={blocked} onChoose={(next) => void choose(next)} />
      <small className="provider-api-help">Only the selected method is allowed. Mythra Code never switches automatically if sign-in fails, limits are reached, or API credits run out. Change this choice yourself to switch.</small>
      <div className="credential-status">
        <div>
          <strong>OpenAI API key</strong>
          <small>{inUse ? "In use · Codex bills this key per token" : keyStatusCopy(state, account?.type === "chatgpt" ? "Saved on this device · ChatGPT is in use" : "Saved on this device")}</small>
        </div>
        {inUse
          ? <span className="connected-badge"><Check size={12} /> In use</span>
          : billing === "apiKey" && state === "saved" && runtimeAvailable && (
            <button type="button" className="secondary-button" onClick={() => void activate()} disabled={blocked}>
              {busy === "using" ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />} Connect saved key
            </button>
          )}
      </div>
      <KeyInputRow provider="openai" visible={visible} billing={billing} state={state} busy={busy} disabled={blocked || billing === null} saveLabel={billing === "apiKey" && runtimeAvailable ? "Save and connect" : "Save key"} onSave={save} onRemove={() => void remove()} />
      <Feedback error={error} notice={notice} />
      <small className="provider-api-help">
        Billed per token to your OpenAI API account; ChatGPT plan limits and credits don’t cover it. Connecting the key replaces Codex’s ChatGPT sign-in in Mythra Code; switching back may need browser sign-in again. Billing choices and keys are saved immediately, apart from voice input keys; Cancel doesn’t undo them. Use a dedicated project/key and monitor spending, especially if someone else uses it.
        {" "}<ExternalButton url={PROVIDER_API_LINKS.openai.keys}>Create a key</ExternalButton>
        {" "}<ExternalButton url={PROVIDER_API_LINKS.openai.limits}>Limits</ExternalButton>
      </small>
    </div>
  );
}

/**
 * How Claude turns started by Mythra Code bill. Claude Code's own login is
 * never changed; API-key billing only adds the saved key to the processes
 * Mythra Code starts, and a missing key never falls back to the plan.
 */
export function ClaudeBillingPanel({ visible, claudeStatus, operation, disabled = false, onChanged }: {
  visible: boolean;
  claudeStatus: ClaudeRuntimeStatus | null;
  operation: AuthOperation;
  disabled?: boolean;
  /** Billing or key changed; re-read Claude status and its catalog. */
  onChanged: () => Promise<unknown>;
}) {
  const { busy, begin, error, setError, notice, setNotice } = operation;
  const { status, refresh } = useProviderAuthStatus(visible, busy);
  const blocked = disabled || Boolean(busy);
  const billing: ClaudeBilling | null = status ? status.claudeBilling : claudeStatus?.billing ?? null;
  const state = status?.anthropic;

  const run = async (operation: Busy, action: () => Promise<string | null | void | false>, fallback: string, billingChanged: boolean) => {
    if (disabled || !operation) return false;
    const finish = begin(operation);
    if (!finish) return false;
    setError("");
    setNotice("");
    let refreshAccount = billingChanged;
    try {
      const message = await action();
      if (message === false) {
        refreshAccount = false;
        return false;
      }
      if (message) setNotice(message);
      return true;
    } catch (reason) {
      setError(safeErrorText(reason, fallback));
      return false;
    } finally {
      await Promise.allSettled([refresh(), ...(refreshAccount ? [onChanged()] : [])]);
      finish();
    }
  };

  const choose = (next: ClaudeBilling) => {
    if (blocked || next === billing) return;
    void run("billing", async () => {
      if (next === "apiKey" && !(await confirmDialog(
        "Use Anthropic API billing?\n\nNew Claude turns, sub-agents, titles and helpers will bill your Anthropic API key per token instead of your Claude subscription, even if that key fails or runs out of credits. Your Claude Code login stays as it is, so you can switch back here.",
        { confirmLabel: "Select API key" },
      ))) return false;
      await setClaudeBilling(next);
      if (next === "subscription") return "New Claude turns use your Claude subscription.";
      return state === "saved" ? "New Claude turns bill your Anthropic API key." : "Add an Anthropic API key to start Claude turns.";
    }, "Claude's billing couldn't be changed.", true);
  };

  const remove = async () => {
    void run("removing", async () => {
      if (billing !== "subscription" && !(await confirmDialog(
        "Remove the Anthropic API key?\n\nClaude is set to bill this key, so new Claude turns stop until you add a key again or switch to your Claude subscription.",
        { confirmLabel: "Remove key" },
      ))) return false;
      await removeProviderApiKey("anthropic");
      return "Key removed.";
    }, "The key couldn't be removed.", billing !== "subscription");
  };

  return (
    <div className="credential-panel stacked provider-api-key" data-settings-row="claude-billing">
      <div className="credential-status">
        <div>
          <strong>Bill Claude turns to</strong>
          <small>{billing === null && status ? "Choose again: the saved choice couldn't be read" : "Applies now to new Claude turns, sub-agents, titles and helpers"}</small>
        </div>
        {busy === "billing" && <LoaderCircle className="spin" size={14} aria-label="Changing billing" />}
      </div>
      <BillingOptions label="Claude" subscription="Claude Code login" billing={billing} disabled={blocked} onChoose={choose} />
      <small className="provider-api-help">Only the selected method is allowed. Mythra Code never switches automatically if sign-in fails, limits are reached, or API credits run out. Change this choice yourself to switch.</small>
      <div className="credential-status">
        <div>
          <strong>Anthropic API key</strong>
          <small>{keyStatusCopy(state, billing === "apiKey" ? "In use · Claude turns bill this key" : "Saved on this device · not in use")}</small>
        </div>
        {state === "saved" && billing === "apiKey" && <span className="connected-badge"><Check size={12} /> In use</span>}
      </div>
      <KeyInputRow
        provider="anthropic"
        visible={visible}
        billing={billing}
        state={state}
        busy={busy}
        disabled={blocked || billing === null}
        saveLabel="Save key"
        onSave={(key) => run("saving", async () => {
          await saveProviderApiKey("anthropic", key);
          return billing === "apiKey" ? "Key saved. New Claude turns bill this key." : "Key saved. Billing is unchanged; choose API key above to use it.";
        }, "The key couldn't be saved.", billing !== "subscription")}
        onRemove={() => void remove()}
      />
      <Feedback error={error} notice={notice} />
      <small className="provider-api-help">
        API-key billing sends the turns Mythra Code starts to the Claude Console organization that owns the key; your Claude Code login stays as it is for switching back. Max and Team plans can include monthly API credits once linked to a Console organization; the Console decides whether they apply and shows what remains. Claude Code passes its environment to the commands it runs, so give Mythra Code a dedicated key with a spend limit, in its own workspace if someone else will use it. Billing choices and keys are saved immediately; Cancel doesn’t undo them.
        {" "}<ExternalButton url={PROVIDER_API_LINKS.anthropic.keys}>Create a key</ExternalButton>
        {" "}<ExternalButton url={PROVIDER_API_LINKS.anthropic.limits}>Spend limits</ExternalButton>
        {" "}<ExternalButton url={PROVIDER_API_LINKS.anthropic.credits}>About API credits</ExternalButton>
      </small>
    </div>
  );
}
