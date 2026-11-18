import { useId, useRef, type RefObject } from "react";
import { Check, ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import type { PermissionMode } from "../types";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";

export function permissionLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "Read only";
  if (mode === "full") return "Full access";
  return "Ask to act";
}

function PermissionIcon({ mode, size = 15 }: { mode: PermissionMode; size?: number }) {
  if (mode === "read-only") return <Shield size={size} aria-hidden="true" />;
  if (mode === "full") return <ShieldAlert size={size} aria-hidden="true" />;
  return <ShieldCheck size={size} aria-hidden="true" />;
}

const LOCAL_DESCRIPTION: Record<PermissionMode, string> = {
  "read-only": "Reads files; can’t change anything",
  ask: "Asks you before actions that need your OK",
  full: "Runs commands and edits without asking, anywhere on this computer",
};

/** What "Ask to act" means for each provider's own permission model (M03). */
export function permissionDescriptions(provider: string): Record<PermissionMode, string> {
  if (provider === "claude") return { ...LOCAL_DESCRIPTION, ask: "Asks before each file edit or command" };
  if (provider === "openai" || provider === "openrouter" || provider === "lmstudio") {
    return { ...LOCAL_DESCRIPTION, ask: "Edits in this project; asks before commands that need more access" };
  }
  return LOCAL_DESCRIPTION;
}
const MODES: PermissionMode[] = ["read-only", "ask", "full"];

export function PermissionPicker({ value, open, rootRef, description = LOCAL_DESCRIPTION, disabledReason, onOpenChange, onChange }: {
  value: PermissionMode;
  open: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  description?: Record<PermissionMode, string>;
  /** Says why a mode can't be chosen on the machine in use. */
  disabledReason?: (mode: PermissionMode) => string | undefined;
  onOpenChange: (open: boolean) => void;
  onChange: (mode: PermissionMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const keys = useMenuKeyboard({ open, setOpen: onOpenChange, menuRef, triggerRef });
  return <div className={`permission-control ${open ? "open" : ""}`} ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className={`toolbar-button permission-trigger mode-${value}`}
      onClick={() => onOpenChange(!open)}
      onPointerDown={keys.onTriggerPointerDown}
      onKeyDown={keys.onTriggerKeyDown}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      // The accessible name starts with the words on screen (voice control
      // users say what they see); "access" says which setting it is.
      aria-label={`${permissionLabel(value)}, access`}
      title={`Access: ${permissionLabel(value)}`}
    >
      <PermissionIcon mode={value} />
      {permissionLabel(value)}
      <ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && (
      <div ref={menuRef} id={menuId} className="permission-menu" role="menu" aria-label="Access" onKeyDown={keys.onMenuKeyDown}>
        <div className="composer-menu-heading" role="presentation">Access</div>
        {MODES.map((mode) => {
          const reason = disabledReason?.(mode);
          const reasonId = reason ? `${menuId}-${mode}-reason` : undefined;
          return <button
            type="button"
            key={mode}
            role="menuitemradio"
            aria-checked={value === mode}
            aria-disabled={reason ? true : undefined}
            aria-describedby={reasonId}
            className={`${value === mode ? "selected" : ""} ${reason ? "unavailable" : ""}`.trim()}
            tabIndex={-1}
            onClick={() => {
              if (reason) return;
              onChange(mode);
              onOpenChange(false);
              triggerRef.current?.focus();
            }}
          >
            <PermissionIcon mode={mode} size={15} />
            <span>
              <strong>{permissionLabel(mode)}</strong>
              <small id={reasonId}>{reason ?? description[mode]}</small>
            </span>
            {value === mode && <Check size={14} aria-hidden="true" />}
          </button>;
        })}
      </div>
    )}
  </div>;
}
