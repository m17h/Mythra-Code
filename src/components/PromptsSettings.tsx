import { useCallback, useEffect, useId, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Brain, Check, ChevronRight, Eye, Info, RotateCcw, Save, Trash2 } from "lucide-react";
import type { AppSettings, PromptProfile } from "../types";
import type { LocalSkill } from "../lib/skills";
import type { AnalyzeSkillDependencies } from "../hooks/useSkillDependencyPreview";
import { confirmDialog } from "../lib/confirmDialog";
import { resolveProviderSystemPrompt } from "../lib/systemPrompt";
import { applyPromptProfile, copyGlobalInstructionProfile, globalInstructionProfiles, instructionFileStatusLabel, promptProfileIsSelected, type InstructionFileDescriptor } from "../lib/instructionFiles";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { ProviderLogo } from "./BrandLogos";
import { InfoPopover } from "./InfoPopover";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { GlobalInstructionFileEditor, retainedGlobalInstructionEditorFiles, type GlobalInstructionEditorState } from "./GlobalInstructionFileEditor";
import "./PromptsSettings.css";

export type PromptLayer = "global" | "codex" | "claude";

const LAYERS: ReadonlyArray<{ id: PromptLayer; label: string; caption: string; placeholder: string }> = [
  { id: "global", label: "Every provider", caption: "Sent first, to every provider.", placeholder: "Empty. Add instructions every agent should follow, for example: Use pnpm. Explain risky changes before making them." },
  { id: "codex", label: "Codex", caption: "Added after the shared instructions in Codex threads, with subscription or API billing.", placeholder: "Optional Codex-only instructions" },
  { id: "claude", label: "Claude", caption: "Added after the shared instructions in Claude threads, with subscription or API billing.", placeholder: "Optional Claude-only instructions" },
];

const EMPTY_FILES: InstructionFileDescriptor[] = [];
const fileKey = (file: InstructionFileDescriptor) => `${file.provider}:${file.path}`;
const characters = (count: number) => `${count.toLocaleString()} character${count === 1 ? "" : "s"}`;

function layerText(settings: AppSettings, layer: PromptLayer): string {
  return layer === "global" ? settings.systemPrompt : layer === "codex" ? settings.codexSystemPrompt : settings.claudeSystemPrompt;
}

function withLayerText(settings: AppSettings, layer: PromptLayer, text: string): AppSettings {
  return layer === "global" ? { ...settings, systemPrompt: text }
    : layer === "codex" ? { ...settings, codexSystemPrompt: text }
      : { ...settings, claudeSystemPrompt: text };
}

/**
 * Settings → Prompts. One editor with provider tabs instead of three stacked
 * editors; profiles as a menu; global instruction files as one line in their
 * provider's tab. Every earlier capability stays reachable, and the saved
 * settings and profiles keep their shape.
 *
 * The global file editors stay mounted (hidden) while Settings is open so a
 * pending file draft keeps its owner and flushes when you navigate away.
 */
export function PromptsSettings({
  active,
  visible,
  layer,
  onLayer,
  settings,
  onSettings,
  profiles,
  onProfiles,
  skills,
  promptRefs,
  analyze,
  globalInstructionFiles = EMPTY_FILES,
  globalInstructionDiscoveryBusy = false,
  globalInstructionDiscoveryError = "",
  onRefreshGlobalInstructionFiles,
  onGlobalInstructionFileSaved,
  onOpenMemory,
}: {
  /** The Prompts pane is the one showing. */
  active: boolean;
  /** Settings is open. */
  visible: boolean;
  layer: PromptLayer;
  onLayer: (layer: PromptLayer) => void;
  settings: AppSettings;
  onSettings: Dispatch<SetStateAction<AppSettings>>;
  profiles: PromptProfile[];
  onProfiles: Dispatch<SetStateAction<PromptProfile[]>>;
  skills: LocalSkill[];
  promptRefs: Record<PromptLayer, RefObject<HTMLTextAreaElement | null>>;
  analyze?: Record<PromptLayer, AnalyzeSkillDependencies>;
  globalInstructionFiles?: InstructionFileDescriptor[];
  globalInstructionDiscoveryBusy?: boolean;
  globalInstructionDiscoveryError?: string;
  onRefreshGlobalInstructionFiles?: () => Promise<void> | void;
  onGlobalInstructionFileSaved?: (file: InstructionFileDescriptor) => void;
  onOpenMemory: () => void;
}) {
  const panelId = useId();
  const tabId = (id: PromptLayer) => `${panelId}-tab-${id}`;
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [managingProfiles, setManagingProfiles] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [savedCopyNotice, setSavedCopyNotice] = useState<string | null>(null);
  const [fullPreview, setFullPreview] = useState(false);

  // Earlier file paths with unresolved drafts keep their editor owner, exactly
  // as before: override discovery can change which file is the live source.
  const [retainedFiles, setRetainedFiles] = useState(() => {
    const files = new Map(retainedGlobalInstructionEditorFiles().map((file) => [fileKey(file), file]));
    for (const file of globalInstructionFiles) files.set(fileKey(file), file);
    return [...files.values()];
  });
  useEffect(() => {
    setRetainedFiles((current) => {
      const files = new Map(current.map((file) => [fileKey(file), file]));
      for (const file of globalInstructionFiles) files.set(fileKey(file), file);
      return [...files.values()];
    });
  }, [globalInstructionFiles]);
  const editorFiles = useMemo(() => {
    const files = new Map(retainedFiles.map((file) => [fileKey(file), file]));
    for (const file of globalInstructionFiles) files.set(fileKey(file), file);
    return [...files.values()];
  }, [globalInstructionFiles, retainedFiles]);
  const [editorStates, setEditorStates] = useState<Record<string, GlobalInstructionEditorState>>({});
  const recordEditorState = useCallback((key: string, value: GlobalInstructionEditorState) => {
    setEditorStates((current) => {
      const previous = current[key];
      return previous?.dirty === value.dirty && previous.saving === value.saving && previous.failed === value.failed ? current : { ...current, [key]: value };
    });
  }, []);
  const discoveredProfiles = useMemo(() => globalInstructionProfiles(globalInstructionFiles), [globalInstructionFiles]);
  const cachedSnapshots = Boolean((globalInstructionDiscoveryError || globalInstructionDiscoveryBusy) && globalInstructionFiles.length);

  useEffect(() => {
    // Leaving the pane or closing Settings resets previews and transient notes.
    if (!visible || !active) {
      setPreviewId(null);
      setSavedCopyNotice(null);
      setFullPreview(false);
      setSavingProfile(false);
    }
  }, [active, visible]);

  const selectedProfile = profiles.find((profile) => promptProfileIsSelected(settings, profile))
    ?? discoveredProfiles.find((profile) => promptProfileIsSelected(settings, profile));
  const profileOptions: AppSelectOption[] = profiles.map((profile) => {
    const total = profile.prompt.length + (profile.codexPrompt?.length ?? 0) + (profile.claudePrompt?.length ?? 0);
    return {
      value: profile.id,
      label: profile.name,
      icon: profile.source ? <ProviderLogo provider={profile.source.provider} size={14} /> : undefined,
      detail: profile.source
        ? `Saved file copy · ${profile.source.provider === "openai" ? "Codex" : "Claude"} only`
        : total ? characters(total) : "Empty prompt set",
    };
  });

  const saveProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    const profile: PromptProfile = {
      id: crypto.randomUUID(),
      name,
      prompt: settings.systemPrompt,
      codexPrompt: settings.codexSystemPrompt,
      claudePrompt: settings.claudeSystemPrompt,
    };
    onProfiles((current) => [...current, profile]);
    onSettings((current) => ({ ...current, promptProfileId: profile.id }));
    setProfileName("");
    setSavingProfile(false);
  };

  const applyFilePreset = async (profile: PromptProfile, providerLabel: string, path: string) => {
    // The review warning appears when it matters: before the file's contents
    // start going out with requests.
    const confirmed = await confirmDialog(
      `Use ${path} for ${providerLabel}?\n\nIts instructions will be sent with future ${providerLabel} requests after you save Settings. Review it first: instruction files can contain personal information or credentials.`,
      { confirmLabel: `Use for ${providerLabel}` },
    );
    if (confirmed) onSettings((current) => applyPromptProfile(current, profile));
  };

  const activeLayer = LAYERS.find((entry) => entry.id === layer) ?? LAYERS[0]!;
  const layerProvider = layer === "codex" ? "codex" : layer === "claude" ? "claude" : null;

  const fileRows = editorFiles.map((file) => {
    const key = fileKey(file);
    const currentSource = globalInstructionFiles.some((current) => current.provider === file.provider && current.path === file.path);
    const editorState = editorStates[key];
    const editorPending = Boolean(editorState?.dirty || editorState?.saving || editorState?.failed);
    const profile = discoveredProfiles.find((item) => item.source?.path === file.path && item.source.provider === (file.provider === "codex" ? "openai" : "claude"));
    const providerLabel = file.provider === "codex" ? "Codex" : "Claude";
    const filename = file.path.split(/[\\/]/).pop() || file.name;
    const previewOpen = Boolean(profile && profile.id === previewId);
    const selected = Boolean(profile && promptProfileIsSelected(settings, profile));
    const previewElementId = `${panelId}-file-${encodeURIComponent(key)}`;
    const shown = active && file.provider === layerProvider && (currentSource || editorPending);
    return <div key={key} className={`prompt-file-row${selected ? " selected" : ""}`} hidden={!shown}>
      <div className="prompt-file-line">
        <ProviderLogo provider={file.provider === "codex" ? "openai" : "claude"} size={15} />
        <span className="prompt-file-name">
          <strong>{!currentSource ? `Previous ${filename} · draft retained` : `Your global ${filename}`}</strong>
          <small title={file.path}>{cachedSnapshots ? "Cached snapshot · " : ""}{profile ? characters(file.content?.length ?? 0) : instructionFileStatusLabel(file)}</small>
        </span>
        {profile && <span className="prompt-file-actions">
          <button type="button" className="secondary-button" aria-expanded={previewOpen} aria-controls={previewElementId} onClick={() => setPreviewId(previewOpen ? null : profile.id)}><Eye size={12} /> {previewOpen ? "Hide" : "Preview"}</button>
          <button type="button" className="secondary-button" disabled={cachedSnapshots || editorPending || !currentSource || selected} aria-pressed={selected} onClick={() => { void applyFilePreset(profile, providerLabel, file.path); }}>{selected ? <><Check size={12} /> In use</> : `Use for ${providerLabel}`}</button>
          <button type="button" className="secondary-button" disabled={editorPending} title="Save a copy as a prompt profile" onClick={() => {
            onProfiles((current) => [...current, copyGlobalInstructionProfile(profile)]);
            setSavedCopyNotice(key);
          }}><Save size={12} /> Save copy</button>
        </span>}
      </div>
      {savedCopyNotice === key && <p className="prompt-file-note" role="status">Copy added to your profiles. Save Settings to keep it.</p>}
      {previewOpen && profile && <div className="instruction-file-preview" id={previewElementId}><label>{cachedSnapshots ? "Cached instructions" : "Instructions"} from {file.path}<textarea aria-label={`${profile.name} preview`} value={file.content ?? ""} readOnly rows={8} spellCheck={false} /></label></div>}
      <GlobalInstructionFileEditor
        file={file}
        visible={visible && shown}
        currentSource={currentSource}
        onSaved={onGlobalInstructionFileSaved}
        onStateChange={(value) => recordEditorState(key, value)}
        onSaveDraftCopy={(content) => {
          const draftProfile = globalInstructionProfiles([{ ...file, content, status: "ready" }], true)[0];
          if (!draftProfile) return;
          onProfiles((current) => [...current, { ...copyGlobalInstructionProfile(draftProfile), name: `Draft of ${draftProfile.name}` }]);
          setSavedCopyNotice(key);
        }}
      />
    </div>;
  });
  const visibleFileCount = layerProvider ? editorFiles.filter((file) => file.provider === layerProvider).length : 0;
  const expectedFile = layer === "codex" ? "AGENTS.md" : "CLAUDE.md";

  const fullPrompt = (provider: "openai" | "claude" | "other") => resolveProviderSystemPrompt(
    settings.systemPrompt,
    provider === "other" ? "cursor" : provider,
    settings.codexSystemPrompt,
    settings.claudeSystemPrompt,
  );
  const [previewProvider, setPreviewProvider] = useState<"openai" | "claude" | "other">("openai");

  return <div className="prompts-settings">
    {active && <section className="set-group">
      <div className="set-group-head prompts-head">
        <h4>Your instructions</h4>
        <div className="prompts-profile-controls">
          <AppSelectMenu
            ariaLabel="Prompt profile"
            value={selectedProfile?.id ?? ""}
            options={profileOptions}
            selectedDisplay={selectedProfile && !profiles.includes(selectedProfile) ? { label: selectedProfile.name, detail: "Global file preset" } : undefined}
            placeholder={profiles.length ? "Custom" : "No saved profiles"}
            emptyMessage="Save your instructions as a profile to switch between sets."
            portal
            onChange={(id) => {
              const profile = profiles.find((item) => item.id === id);
              if (profile) onSettings((current) => applyPromptProfile(current, profile));
            }}
          />
          <button type="button" className="secondary-button" aria-expanded={savingProfile} onClick={() => setSavingProfile((current) => !current)}><Save size={12} /> Save as profile</button>
        </div>
      </div>
      {savingProfile && <div className="inline-create prompts-save-profile">
        <input aria-label="New prompt profile name" autoFocus value={profileName} onChange={(event) => setProfileName(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); saveProfile(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSavingProfile(false); }
        }} placeholder="Profile name" />
        <button type="button" onClick={saveProfile} disabled={!profileName.trim()}><Save size={12} /> Save all three layers</button>
      </div>}
      <div className="set-card prompts-card">
        <div className="prompts-tabs" role="tablist" aria-label="Instruction layer">
          {LAYERS.map((entry) => {
            const filled = Boolean(layerText(settings, entry.id).trim());
            return <button
              key={entry.id}
              type="button"
              role="tab"
              id={tabId(entry.id)}
              aria-selected={layer === entry.id}
              aria-controls={panelId}
              tabIndex={layer === entry.id ? 0 : -1}
              className={layer === entry.id ? "selected" : ""}
              onClick={() => onLayer(entry.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault();
                const index = LAYERS.findIndex((item) => item.id === layer);
                const next = LAYERS[(index + (event.key === "ArrowRight" ? 1 : LAYERS.length - 1)) % LAYERS.length]!;
                onLayer(next.id);
                document.getElementById(tabId(next.id))?.focus();
              }}
            >
              {entry.id !== "global" && <ProviderLogo provider={entry.id === "codex" ? "openai" : "claude"} size={13} />}
              {entry.label}
              {filled && <span className="prompts-tab-dot" aria-label="has instructions" />}
            </button>;
          })}
        </div>
        <div className="prompts-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(layer)}>
          <p className="prompts-caption">{activeLayer.caption}{layer !== "global" && " Editing here never changes the original file."}</p>
          {LAYERS.map((entry) => <div key={entry.id} hidden={entry.id !== layer}>
            <SkillPromptEditor
              ref={promptRefs[entry.id]}
              skills={skills}
              aria-label={entry.id === "global" ? "Global Mythra Code prompt" : entry.id === "codex" ? "Codex prompt" : "Claude Code prompt"}
              onAnalyze={visible ? analyze?.[entry.id] : undefined}
              className="prompt-editor"
              value={layerText(settings, entry.id)}
              onChange={(event) => {
                const text = event.target.value;
                onSettings((current) => withLayerText(current, entry.id, text));
              }}
              placeholder={entry.placeholder}
              rows={entry.id === "global" ? 7 : 6}
            />
          </div>)}
          <p className="prompts-hint">Type @ to mention a skill from your Skills folder.</p>
        </div>
      </div>
    </section>}

    {/* File presets render here, mounted even while hidden; see the note above. */}
    <div className="prompts-files" hidden={!active || !layerProvider}>
      <div className="prompts-files-head">
        <span>Global {expectedFile} on this computer</span>
        {onRefreshGlobalInstructionFiles && <button type="button" className="prompts-icon-button" disabled={globalInstructionDiscoveryBusy} aria-label={globalInstructionDiscoveryBusy ? "Refreshing files" : "Refresh files"} title="Refresh files" onClick={() => { void onRefreshGlobalInstructionFiles(); }}><RotateCcw size={12} className={globalInstructionDiscoveryBusy ? "spin" : undefined} /></button>}
      </div>
      {globalInstructionDiscoveryError && <p className="instruction-discovery-error" role="alert">{globalInstructionDiscoveryError}{cachedSnapshots ? " Showing cached snapshots from the last successful discovery; refresh before using one." : ""}</p>}
      {fileRows}
      {active && layerProvider && !visibleFileCount && <p className="prompt-file-note" role="status">{globalInstructionDiscoveryBusy ? "Looking for your global instruction file…" : `No global ${expectedFile} found. Create one, then refresh.`}</p>}
    </div>

    {active && <section className="set-group">
      <div className="set-group-head"><h4>Project files</h4></div>
      <div className="set-card"><div className="set-row prompts-project-files">
        <div className="set-copy">
          <strong>Read instruction files from each project</strong>
          <small>Off by default. Applies to future turns.</small>
        </div>
        <div className="set-control prompts-file-toggles">
          <button type="button" role="switch" aria-label="Project AGENTS.md discovery" aria-checked={settings.projectInstructionsEnabled} className={`prompts-chip${settings.projectInstructionsEnabled ? " on" : ""}`} onClick={() => onSettings((current) => ({ ...current, projectInstructionsEnabled: !current.projectInstructionsEnabled }))}><span className="prompts-check" aria-hidden="true">{settings.projectInstructionsEnabled && <Check size={10} />}</span>AGENTS.md</button>
          <button type="button" role="switch" aria-label="Project CLAUDE.md discovery" aria-checked={settings.projectClaudeInstructionsEnabled} className={`prompts-chip${settings.projectClaudeInstructionsEnabled ? " on" : ""}`} onClick={() => onSettings((current) => ({ ...current, projectClaudeInstructionsEnabled: !current.projectClaudeInstructionsEnabled }))}><span className="prompts-check" aria-hidden="true">{settings.projectClaudeInstructionsEnabled && <Check size={10} />}</span>CLAUDE.md</button>
          <InfoPopover label="How project instruction files are read" triggerClassName="prompts-info" trigger={<Info size={14} aria-hidden="true" />}>
            <p className="prompts-info-text">Files are read fresh from the project root (or the thread&rsquo;s isolated worktree) for every provider. A non-empty AGENTS.override.md takes precedence over AGENTS.md. CLAUDE.md falls back to .claude/CLAUDE.md. The combined limit is 32&nbsp;KB. Nested folders and file imports are not read.</p>
          </InfoPopover>
        </div>
      </div></div>
    </section>}

    {active && <section className="set-group">
      <div className="set-group-head"><h4>What the agent receives</h4></div>
      <div className="set-card prompts-stack">
        <div className="prompts-layer">
          <span className="prompts-layer-name">Your instructions</span>
          <span className="prompts-layer-value">{settings.systemPrompt.trim() ? characters(settings.systemPrompt.trim().length) : "Empty"}{" · Codex "}{settings.codexSystemPrompt.trim() ? characters(settings.codexSystemPrompt.trim().length) : "none"}{" · Claude "}{settings.claudeSystemPrompt.trim() ? characters(settings.claudeSystemPrompt.trim().length) : "none"}</span>
        </div>
        <div className="prompts-layer">
          <span className="prompts-layer-name">Project instructions</span>
          <span className="prompts-layer-value">Set beside a project&rsquo;s name. They replace or add to yours.</span>
        </div>
        <div className="prompts-layer">
          <span className="prompts-layer-name">Project files</span>
          <span className="prompts-layer-value">{settings.projectInstructionsEnabled || settings.projectClaudeInstructionsEnabled
            ? [settings.projectInstructionsEnabled && "AGENTS.md", settings.projectClaudeInstructionsEnabled && "CLAUDE.md"].filter(Boolean).join(" and ")
            : "Off"}</span>
        </div>
        <div className="prompts-layer">
          <span className="prompts-layer-name">Memory</span>
          <button type="button" className="prompts-link" onClick={onOpenMemory}><Brain size={12} /> Learned preferences <ChevronRight size={12} /></button>
        </div>
        <div className="prompts-layer prompts-layer-actions">
          <button type="button" className="secondary-button" aria-expanded={fullPreview} onClick={() => setFullPreview((current) => !current)}><Eye size={12} /> {fullPreview ? "Hide preview" : "Preview your instructions"}</button>
          {(profiles.length > 0) && <button type="button" className="secondary-button" aria-expanded={managingProfiles} onClick={() => setManagingProfiles((current) => !current)}>{managingProfiles ? "Done" : `Manage profiles (${profiles.length})`}</button>}
        </div>
        {fullPreview && <div className="prompts-full-preview">
          <div className="prompts-tabs compact" role="radiogroup" aria-label="Preview for provider">
            {(["openai", "claude", "other"] as const).map((provider) => <button key={provider} type="button" role="radio" aria-checked={previewProvider === provider} className={previewProvider === provider ? "selected" : ""} onClick={() => setPreviewProvider(provider)}>{provider === "openai" ? "Codex" : provider === "claude" ? "Claude" : "Other providers"}</button>)}
          </div>
          <textarea aria-label="Your combined instructions" readOnly rows={8} spellCheck={false} value={fullPrompt(previewProvider) || ""} placeholder="Nothing yet. Your instructions are empty for this provider." />
          <small>Project instructions, project files and Memory are added per project when a turn starts. Mythra Code also sends its own operating guidance for tools and delegation.</small>
        </div>}
        {managingProfiles && <ul className="prompts-profile-list" aria-label="Saved prompt profiles">
          {profiles.map((profile) => {
            const open = previewId === `saved:${profile.id}`;
            const savedText = profile.source ? (profile.source.provider === "openai" ? profile.codexPrompt : profile.claudePrompt) ?? "" : "";
            return <li key={profile.id}>
              <span className="prompts-profile-name">{profile.source && <ProviderLogo provider={profile.source.provider} size={13} />}<strong>{profile.name}</strong>{promptProfileIsSelected(settings, profile) && <Check size={12} aria-label="In use" />}{profile.source && <small title={profile.source.path}>{profile.source.path}</small>}</span>
              {profile.source && <button type="button" className="secondary-button" aria-expanded={open} onClick={() => setPreviewId(open ? null : `saved:${profile.id}`)}><Eye size={12} /> {open ? "Hide" : "Preview"}</button>}
              <button type="button" className="prompts-icon-button" aria-label={`Delete ${profile.name}`} onClick={async () => {
                if (!await confirmDialog(`Delete the prompt profile “${profile.name}”?`)) return;
                onProfiles((current) => current.filter((item) => item.id !== profile.id));
                onSettings((current) => current.promptProfileId === profile.id ? { ...current, promptProfileId: "" } : current);
              }}><Trash2 size={12} /></button>
              {open && <textarea aria-label={`${profile.name} saved preview`} readOnly rows={6} spellCheck={false} value={savedText} />}
            </li>;
          })}
        </ul>}
      </div>
    </section>}
  </div>;
}
