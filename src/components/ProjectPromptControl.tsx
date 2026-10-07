import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, NotebookPen, Settings } from "lucide-react";
import { usePopoverFade } from "../hooks/usePopoverFade";
import type { ProjectPromptMode, ProjectPromptProfile, Provider, SkillDependencyReport } from "../types";
import { MAX_PROJECT_PROMPT_PROFILES, MAX_PROJECT_PROMPT_PROFILE_NAME, MAX_PROJECT_PROFILE_PROMPT, sanitizeProjectPromptProfiles, type ProjectPromptProfileState } from "../lib/projectPromptProfiles";
import { resolveSystemPrompt } from "../lib/systemPrompt";
import type { SkillMentionSkill } from "../lib/skillMentions";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { skillEditorOwnsEscape } from "./SkillReferenceInspector";
import { effectiveZoom } from "../lib/floatingLayer";
import "./project-prompt-profiles.css";

export function ProjectPromptControl({
  projectName,
  projectPrompt,
  promptMode,
  profiles,
  selectedProfileId,
  appPrompt,
  threadStarted,
  onSave,
  onAppPromptSettings,
  openRequest,
  skills,
  onAnalyzeSkillDependencies,
}: {
  projectName: string;
  projectPrompt?: string;
  promptMode: ProjectPromptMode;
  profiles?: readonly ProjectPromptProfile[];
  selectedProfileId?: string;
  appPrompt: string;
  provider: Provider;
  threadStarted: boolean;
  onSave: (prompt: string | undefined, mode: ProjectPromptMode, profileState?: ProjectPromptProfileState) => void;
  onAppPromptSettings: () => void;
  openRequest?: { name: string; nonce: number } | null;
  skills?: readonly SkillMentionSkill[];
  onAnalyzeSkillDependencies?: (message: string, systemPrompt: string) => Promise<SkillDependencyReport>;
}) {
  const [open, setOpen] = useState(false);
  const { ref: panelRef, present } = usePopoverFade(open);
  const [custom, setCustom] = useState(Boolean(projectPrompt?.trim()));
  const [draft, setDraft] = useState(projectPrompt ?? "");
  const [mode, setMode] = useState<ProjectPromptMode>(promptMode);
  const savedProfiles = useMemo(() => sanitizeProjectPromptProfiles(profiles), [profiles]);
  const [draftProfiles, setDraftProfiles] = useState(savedProfiles);
  const [profileId, setProfileId] = useState(selectedProfileId ?? "");
  const [profileName, setProfileName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [availableHeight, setAvailableHeight] = useState<number>();
  const [availableWidth, setAvailableWidth] = useState<number>();
  const seenOpenRequest = useRef(openRequest?.nonce);
  const hasProjectPrompt = Boolean(projectPrompt?.trim());
  const analyzeDraft = useCallback((text: string) => onAnalyzeSkillDependencies!("", resolveSystemPrompt(appPrompt, text, mode)), [appPrompt, mode, onAnalyzeSkillDependencies]);

  useLayoutEffect(() => {
    if (!open || profiles === undefined || !rootRef.current) return;
    const root = rootRef.current;
    const update = () => {
      const rect = root.getBoundingClientRect();
      const zoom = effectiveZoom(root);
      setAvailableHeight(Math.max(0, (window.innerHeight - rect.bottom - 8) / zoom - 8));
      setAvailableWidth(Math.max(0, Math.min(430, (window.innerWidth - rect.left - 16) / zoom)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [open, profiles]);

  useEffect(() => {
    if (!openRequest || openRequest.nonce === seenOpenRequest.current) return;
    seenOpenRequest.current = openRequest.nonce;
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    setCustom(hasProjectPrompt);
    setDraft(projectPrompt ?? "");
    setMode(promptMode);
    setDraftProfiles(savedProfiles);
    const selected = savedProfiles.find((profile) => profile.id === selectedProfileId && profile.prompt === projectPrompt && profile.mode === promptMode);
    setProfileId(selected?.id ?? "");
    setProfileName(selected?.name ?? "");
  }, [hasProjectPrompt, open, projectPrompt, promptMode, savedProfiles, selectedProfileId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The editor's completion list or dependency map closes first.
        if (skillEditorOwnsEscape(event.target)) return;
        // Escape closes only this popover — never the app-level stop-turn handler.
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const inheritedSummary = appPrompt.trim() ? `Uses the ${appPrompt.trim().length}-character app-wide prompt` : "The app-wide prompt is currently empty";
  const saveDisabled = custom && !draft.trim();
  const selectedProfile = draftProfiles.find((profile) => profile.id === profileId);
  const name = profileName.trim();
  const nameTaken = draftProfiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase());
  const canSaveProfile = custom && !saveDisabled && draft.length <= MAX_PROJECT_PROFILE_PROMPT && Boolean(name) && name.length <= MAX_PROJECT_PROMPT_PROFILE_NAME;
  const profileModified = selectedProfile && (selectedProfile.prompt !== draft.trim() || selectedProfile.mode !== mode);
  const hasAppPrompt = Boolean(appPrompt.trim());
  const promptState = hasProjectPrompt ? (promptMode === "append" && hasAppPrompt ? "Layered" : "Custom") : "Inherited";

  return (
    <div className="project-prompt-control" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`project-prompt-trigger ${hasProjectPrompt ? "custom" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Project instructions: ${promptState}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <NotebookPen size={14} />
        <span>Project instructions</span>
        <small>{promptState}</small>
        <ChevronDown size={12} />
      </button>

      {present && (
        <div ref={panelRef} className="project-prompt-popover" style={{ opacity: 0, maxHeight: availableHeight, width: availableWidth }} aria-hidden={!open || undefined} inert={!open || undefined} role="dialog" aria-label={`Project instructions for ${projectName}`}>
          <div className="project-prompt-heading">
            <span className="project-prompt-icon"><NotebookPen size={16} /></span>
            <div>
              <strong>Project instructions</strong>
              <small>Instructions used by threads in {projectName}.</small>
            </div>
          </div>

          <div className="project-prompt-modes" role="radiogroup" aria-label="Project instruction source">
            <button className={!custom ? "selected" : ""} role="radio" aria-checked={!custom} onClick={() => { setCustom(false); setProfileId(""); }}>
              <span>
                <strong>Inherit app prompt</strong>
                <small>{inheritedSummary}</small>
              </span>
              {!custom && <Check size={15} />}
            </button>
            <button className={custom ? "selected" : ""} role="radio" aria-checked={custom} onClick={() => setCustom(true)}>
              <span>
                <strong>Use a project prompt</strong>
                <small>Replace the app prompt or layer on top of it</small>
              </span>
              {custom && <Check size={15} />}
            </button>
          </div>

          {profiles !== undefined && (
            <details className="project-prompt-profiles" open={draftProfiles.length ? true : undefined}>
              <summary>Saved project profiles{draftProfiles.length ? ` (${draftProfiles.length})` : ""}</summary>
              <small>Save named instructions for {projectName}. Changes apply when you save below.</small>
              <div className="inline-create">
                <select aria-label="Saved project profile" value={profileId} onChange={(event) => {
                  const profile = draftProfiles.find((entry) => entry.id === event.target.value);
                  setProfileId(profile?.id ?? "");
                  setProfileName(profile?.name ?? "");
                  if (profile) {
                    setCustom(true);
                    setDraft(profile.prompt);
                    setMode(profile.mode);
                  }
                }}>
                  <option value="">Unsaved instructions</option>
                  {draftProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
                <button type="button" disabled={!selectedProfile} onClick={() => {
                  setDraftProfiles((current) => current.filter((profile) => profile.id !== profileId));
                  setProfileId("");
                  setProfileName("");
                }}>Delete profile</button>
              </div>
              {profileModified && <small>These instructions differ from the saved profile.</small>}
              <div className="inline-create">
                <input aria-label="Project profile name" placeholder="Profile name" maxLength={MAX_PROJECT_PROMPT_PROFILE_NAME}
                  value={profileName} onChange={(event) => setProfileName(event.target.value)} />
                <button type="button" disabled={!canSaveProfile || nameTaken || draftProfiles.length >= MAX_PROJECT_PROMPT_PROFILES} onClick={() => {
                  if (!canSaveProfile || nameTaken || draftProfiles.length >= MAX_PROJECT_PROMPT_PROFILES) return;
                  const profile: ProjectPromptProfile = { id: crypto.randomUUID(), name, prompt: draft.trim(), mode };
                  setDraftProfiles((current) => [...current, profile]);
                  setProfileId(profile.id);
                  setProfileName(profile.name);
                }}>Save as profile</button>
              </div>
              {selectedProfile && <div className="project-prompt-profile-actions">
                <button className="secondary-button" type="button" disabled={!canSaveProfile || !profileModified} onClick={() => {
                  setDraftProfiles((current) => current.map((profile) => profile.id === profileId ? { ...profile, prompt: draft.trim(), mode } : profile));
                }}>Update profile</button>
                <button className="secondary-button" type="button" disabled={!name || name.length > MAX_PROJECT_PROMPT_PROFILE_NAME || name === selectedProfile.name || draftProfiles.some((profile) => profile.id !== profileId && profile.name.toLowerCase() === name.toLowerCase())} onClick={() => {
                  setDraftProfiles((current) => current.map((profile) => profile.id === profileId ? { ...profile, name } : profile));
                }}>Rename profile</button>
              </div>}
              <small>Deleting a profile keeps the current instructions. Cancel discards profile changes.</small>
            </details>
          )}

          {custom && (
            <div className="project-prompt-editor">
              <span>Prompt for {projectName}</span>
              <SkillPromptEditor
                value={draft}
                skills={skills}
                onAnalyze={open && onAnalyzeSkillDependencies ? analyzeDraft : undefined}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={`Prompt for ${projectName}`}
                placeholder="Describe how the model should work in this project"
                rows={7}
                autoFocus
              />
              <button
                type="button"
                className={`project-prompt-layer-toggle ${mode === "append" ? "enabled" : ""}`}
                role="switch"
                aria-checked={mode === "append"}
                aria-label="Run the app-wide prompt first"
                onClick={() => setMode((current) => (current === "append" ? "replace" : "append"))}
              >
                <span className="project-prompt-switch" aria-hidden="true"><i /></span>
                <span>
                  <strong>Run the app-wide prompt first</strong>
                  <small>
                    {mode === "append"
                      ? hasAppPrompt
                        ? "App instructions run first, followed by this project prompt."
                        : "No app-wide prompt is set, so only this project prompt runs."
                      : "This project prompt replaces the app-wide prompt."}
                  </small>
                </span>
              </button>
              <small>
                {threadStarted
                  ? "This update applies starting with your next message in this thread."
                  : "This will be the complete instruction for the next thread."}
              </small>
            </div>
          )}

          <button
            className="project-prompt-global-link"
            onClick={() => {
              setOpen(false);
              onAppPromptSettings();
            }}
          >
            <Settings size={13} />
            Edit the app-wide prompt in Settings
          </button>

          <div className="project-prompt-actions">
            <button className="secondary-button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>Cancel</button>
            <button
              className="primary-button"
              disabled={saveDisabled}
              onClick={() => {
                const prompt = custom ? draft.trim() : undefined;
                const nextMode = custom ? mode : "replace";
                if (profiles !== undefined) onSave(prompt, nextMode, { profiles: draftProfiles, selectedProfileId: custom ? profileId || undefined : undefined });
                else onSave(prompt, nextMode);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              {custom ? "Save project prompt" : "Use app prompt"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
