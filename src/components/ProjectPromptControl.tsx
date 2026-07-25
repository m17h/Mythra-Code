import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Settings, Sparkles } from "lucide-react";
import type { Provider } from "../types";

export function ProjectPromptControl({
  projectName,
  projectPrompt,
  appPrompt,
  provider,
  threadStarted,
  onSave,
  onAppPromptSettings,
}: {
  projectName: string;
  projectPrompt?: string;
  appPrompt: string;
  provider: Provider;
  threadStarted: boolean;
  onSave: (prompt: string | undefined) => void;
  onAppPromptSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(Boolean(projectPrompt?.trim()));
  const [draft, setDraft] = useState(projectPrompt ?? "");
  const rootRef = useRef<HTMLDivElement>(null);
  const hasProjectPrompt = Boolean(projectPrompt?.trim());

  useEffect(() => {
    if (!open) return;
    setCustom(hasProjectPrompt);
    setDraft(projectPrompt ?? "");
  }, [hasProjectPrompt, open, projectPrompt]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
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

  return (
    <div className="project-prompt-control" ref={rootRef}>
      <button
        className={`project-prompt-trigger ${hasProjectPrompt ? "custom" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Project instructions: ${hasProjectPrompt ? "Custom" : "Inherited"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Sparkles size={14} />
        <span>Project instructions</span>
        <small>{hasProjectPrompt ? "Custom" : "Inherited"}</small>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="project-prompt-popover" role="dialog" aria-label={`Project instructions for ${projectName}`}>
          <div className="project-prompt-heading">
            <span className="project-prompt-icon"><Sparkles size={16} /></span>
            <div>
              <strong>Project instructions</strong>
              <small>Instructions used by new threads in {projectName}.</small>
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
                <small>Replaces the app-wide prompt for this project</small>
              </span>
              {custom && <Check size={15} />}
            </button>
          </div>

          {custom && (
            <label className="project-prompt-editor">
              <span>Prompt for {projectName}</span>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={`Prompt for ${projectName}`}
                placeholder="Describe how the model should work in this project"
                rows={7}
                autoFocus
              />
              <small>
                {threadStarted
                  ? provider === "claude"
                    ? "Claude will use this update starting with your next message in this thread."
                    : "This applies when you start the next thread; the current conversation is unchanged."
                  : "This will be the complete base instruction for the next thread."}
              </small>
            </label>
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
                onSave(custom ? draft.trim() : undefined);
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
