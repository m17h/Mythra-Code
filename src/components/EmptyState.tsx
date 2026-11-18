import type { ComponentType, ReactNode } from "react";

type IconComponent = ComponentType<{ size?: number | string; "aria-hidden"?: boolean | "true" | "false"; strokeWidth?: number }>;

/**
 * The one empty state (styles: `src/styles/lumen/primitives.css`).
 *
 * Icon, a short title, at most one sentence, and a button only when there is
 * something to do about it. Sentence case, no trailing full stop on the title.
 *
 * - `variant="panel"` (default): centred in a pane or a large list.
 * - `variant="compact"`: a section inside a panel or a popover list
 *   (model menus, the command palette, the sidebar).
 * - `variant="inline"`: one muted line with a small icon, for a row-sized gap
 *   inside a card.
 *
 * Pass `role="status"` when the empty state appears in answer to typing (a
 * search with no results) so screen readers hear it.
 */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  variant = "panel",
  role,
  className = "",
  children,
}: {
  icon?: IconComponent;
  title: ReactNode;
  text?: ReactNode;
  action?: { label: string; onClick: () => void; icon?: IconComponent };
  variant?: "panel" | "compact" | "inline";
  role?: "status";
  className?: string;
  children?: ReactNode;
}) {
  const ActionIcon = action?.icon;
  const iconSize = variant === "panel" ? 20 : variant === "compact" ? 16 : 13;
  return (
    <div className={`lm-empty lm-empty-${variant}${className ? ` ${className}` : ""}`} role={role} aria-live={role ? "polite" : undefined}>
      {Icon && <span className="lm-empty-icon"><Icon size={iconSize} aria-hidden="true" /></span>}
      <strong className="lm-empty-title">{title}</strong>
      {text && <span className="lm-empty-text">{text}</span>}
      {children}
      {action && (
        <button type="button" className="lm-empty-action" onClick={action.onClick}>
          {ActionIcon && <ActionIcon size={13} aria-hidden="true" />}
          {action.label}
        </button>
      )}
    </div>
  );
}
