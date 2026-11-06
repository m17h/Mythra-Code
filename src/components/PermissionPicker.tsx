import type { RefObject } from "react";
import { Check, ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import type { PermissionMode } from "../types";

export function permissionLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "Read only";
  if (mode === "full") return "Full access";
  return "Ask to act";
}

function PermissionIcon({ mode, size = 15 }: { mode: PermissionMode; size?: number }) {
  if (mode === "read-only") return <Shield size={size} />;
  if (mode === "full") return <ShieldAlert size={size} />;
  return <ShieldCheck size={size} />;
}

const LOCAL_DESCRIPTION: Record<PermissionMode, string> = {
  "read-only": "Inspect without changing files",
  ask: "Work locally; ask for elevated actions",
  full: "Unrestricted local access",
};
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
  return <div className="permission-control" ref={rootRef}>
    <button className="toolbar-button" onClick={() => onOpenChange(!open)} aria-haspopup="menu" aria-expanded={open}>
      <PermissionIcon mode={value} />
      {permissionLabel(value)}
      <ChevronDown size={13} />
    </button>
    {open && (
      <div className="permission-menu" role="menu" aria-label="Permission mode">
        {MODES.map((mode) => {
          const reason = disabledReason?.(mode);
          return <button
            key={mode}
            className={value === mode ? "selected" : ""}
            disabled={Boolean(reason)}
            title={reason}
            onClick={() => {
              onChange(mode);
              onOpenChange(false);
            }}
          >
            <PermissionIcon mode={mode} size={17} />
            <span>
              <strong>{permissionLabel(mode)}</strong>
              <small>{description[mode]}</small>
            </span>
            {value === mode && <Check size={15} />}
          </button>;
        })}
      </div>
    )}
  </div>;
}
