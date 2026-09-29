import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, NotebookPen, Settings } from "lucide-react";
import { usePopoverFade } from "../hooks/usePopoverFade";
import type { ProjectPromptMode, Provider, SkillDependencyReport } from "../types";
import { resolveSystemPrompt } from "../lib/systemPrompt";
import type { SkillMentionSkill } from "../lib/skillMentions";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { skillEditorOwnsEscape } from "./SkillReferenceInspector";

export function ProjectPromptControl({
  projectName,
  projectPrompt,
  promptMode,
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
  appPrompt: string;
  provider: Provider;
  threadStarted: boolean;
  onSave: (prompt: string | undefined, mode: ProjectPromptMode) => void;
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
  const rootRef = useRef<HTMLDivElement>(null);
  const seenOpenRequest = useRef(openRequest?.nonce);
  const hasProjectPrompt = Boolean(projectPrompt?.trim());
  const analyzeDraft = useCallback((text: string) => onAnalyzeSkillDependencies!("", resolveSystemPrompt(appPrompt, text, mode)), [appPrompt, mode, onAnalyzeSkillDependencies]);

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
  }, [hasProjectPrompt, open, projectPrompt, promptMode]);

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
  const hasAppPrompt = Boolean(appPrompt.trim());
  const promptState = hasProjectPrompt ? (promptMode === "append" && hasAppPrompt ? "Layered" : "Custom") : "Inherited";

  return (
    <div className="project-prompt-control" ref={rootRef}>
      <button
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
        <div ref={panelRef} className="project-prompt-popover" style={{ opacity: 0 }} aria-hidden={!open || undefined} inert={!open || undefined} role="dialog" aria-label={`Project instructions for ${projectName}`}>
          <div className="project-prompt-heading">
            <span className="project-prompt-icon"><NotebookPen size={16} /></span>
            <div>
              <strong>Project instructions</strong>
              <small>Instructions used by threads in {projectName}.</small>
            </div>
          </div>

          <div className="project-prompt-modes" role="radiogroup" aria-label="Project instruction source">
            <button className={!custom ? "selected" : ""} role="radio" aria-checked={!custom} onClick={() => setCustom(false)}>
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
            <button className="secondary-button" onClick={() => setOpen(false)}>Cancel</button>
            <button
              className="primary-button"
              disabled={saveDisabled}
              onClick={() => {
                onSave(custom ? draft.trim() : undefined, custom ? mode : "replace");
                setOpen(false);
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
