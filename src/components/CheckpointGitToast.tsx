import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { GitBranch, LoaderCircle, TriangleAlert } from "lucide-react";
import { CHECKPOINT_GIT_NOTICE_MS } from "../lib/checkpointGitNotice";
import type { CheckpointGitNotice } from "../hooks/useCheckpointGitNotice";
import "./CheckpointGitToast.css";

/**
 * Nonmodal notice that a folder has no Git, so automatic checkpoints cannot
 * revert its changes. Exactly two actions. An untouched notice leaves after
 * 30 seconds; hovering or focusing it pauses that countdown, and choosing
 * Initialize Git stops it (a failure stays until dismissed).
 */
export function CheckpointGitToast({ notice, onInitialize, onDismiss }: {
  notice: CheckpointGitNotice;
  onInitialize: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const titleId = useId();
  const detailId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remainingRef = useRef(CHECKPOINT_GIT_NOTICE_MS);
  const { key, phase } = notice;

  useEffect(() => {
    if (phase !== "idle" || hovered || focused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(key), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(1_000, remainingRef.current - (Date.now() - startedAt));
    };
  }, [focused, hovered, key, onDismiss, phase]);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onDismiss(key);
  };

  const failed = phase === "failed";
  const initializing = phase === "initializing";
  const title = failed ? `Git couldn’t be initialized for ${notice.projectName}` : `Git isn’t initialized for ${notice.projectName}`;
  const detail = failed
    ? notice.error || "Git could not be initialized. The thread and its work are unchanged."
    : "Checkpoints can’t be used to revert changes here. Initializing Git turns them on from the next run; it can’t restore work already done.";

  return (
    <div
      className={`checkpoint-git-toast ${phase}`}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <span className="checkpoint-git-toast-icon" aria-hidden="true">
        {failed ? <TriangleAlert size={15} /> : <GitBranch size={15} />}
      </span>
      <span className="checkpoint-git-toast-copy" aria-atomic="true">
        <strong id={titleId} title={title}>{title}</strong>
        <small id={detailId} tabIndex={failed ? 0 : undefined}>{detail}</small>
      </span>
      <span className="checkpoint-git-toast-actions">
        <button
          type="button"
          className="checkpoint-git-toast-primary"
          onClick={() => onInitialize(key)}
          disabled={initializing}
          aria-busy={initializing || undefined}
          title={notice.workspacePath}
        >
          {initializing && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
          <span>{initializing ? "Initializing…" : "Initialize Git"}</span>
        </button>
        <button type="button" className="checkpoint-git-toast-dismiss" onClick={() => onDismiss(key)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
