// The window chrome around the shared views, written once. App.tsx fills it
// with live state; the hidden theme preview (src/themePreview) fills it with
// sample content, so a theme preview always draws this exact markup.

import type { CSSProperties, ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRight, Paperclip, Plus, Search, Settings } from "lucide-react";
import { MythraMark } from "./MythraMark";
import { Odometer } from "./Odometer";
import { themeColorScheme } from "../lib/appConfig";
import { formatShortcut, withShortcut } from "../lib/shortcuts";
import { topbarStatusLabel, type TopbarStatusKind } from "../lib/topbarFit";
import { workspaceShortcutLabel } from "../hooks/useAppShortcuts";
import type { CustomThemeId, ThemeSpec } from "../lib/customThemes/spec";
import type { ChatFont, ClaudeLogoStyle, CursorLogoStyle, OpenAILogoStyle, Provider, ThemeName } from "../types";

/** The effects a custom theme switches on, as the shell's `data-ct-fx` list. */
export function themeEffectNames(spec: ThemeSpec | null): string {
  if (!spec) return "";
  return Object.keys(spec.effects ?? {}).filter((key) => (spec.effects as Record<string, unknown>)[key]).join(" ");
}

/** The `.app-shell` attributes every theme, font and scale rule keys off. */
export function shellThemeAttributes(options: {
  base: ThemeName;
  customThemeId?: CustomThemeId;
  motion: "on" | "paused";
  effects: string;
  provider: Provider;
  chatFont: ChatFont;
  /** A resolved font-family for a custom chat font. */
  chatFontFamily?: string;
  logos: { openai?: OpenAILogoStyle; claude?: ClaudeLogoStyle; cursor?: CursorLogoStyle };
  /** 1 = 100%. */
  uiScale: number;
}) {
  return {
    "data-theme": options.base,
    "data-color-scheme": themeColorScheme(options.base),
    "data-custom-theme": options.customThemeId,
    "data-theme-motion": options.customThemeId ? options.motion : undefined,
    "data-ct-fx": options.effects || undefined,
    "data-model-provider": options.provider,
    "data-chat-font": options.chatFont,
    "data-openai-logo": options.logos.openai,
    "data-claude-logo": options.logos.claude,
    "data-cursor-logo": options.logos.cursor,
    style: {
      zoom: options.uiScale,
      "--ui-scale": options.uiScale,
      ...(options.chatFontFamily ? { "--chat-font": options.chatFontFamily } : {}),
    } as CSSProperties,
  };
}

export function SidebarBrand({ machineSwitcher, onHide }: { machineSwitcher?: ReactNode; onHide: () => void }) {
  return <div className="sidebar-brand">
    <div className="brand-mark">
      <MythraMark />
    </div>
    <span>Mythra Code</span>
    {machineSwitcher}
    <button className="icon-button subtle collapse-button" onClick={onHide} title={withShortcut("Hide sidebar", "toggleSidebar")} aria-label="Hide sidebar" aria-keyshortcuts="Meta+Backslash Control+Backslash">
      <PanelLeftClose size={17} />
    </button>
  </div>;
}

export function ShowSidebarButton({ tucked, onShow }: { tucked: boolean; onShow: () => void }) {
  return <button className="icon-button sidebar-show-button" onClick={onShow} title={withShortcut(tucked ? "Show sidebar over the chat (Tools stays open)" : "Show sidebar", "toggleSidebar")} aria-label="Show sidebar" aria-keyshortcuts="Meta+Backslash Control+Backslash">
    <PanelLeftOpen size={18} />
  </button>;
}

export function NewThreadButton({ onClick, disabled, title }: { onClick: () => void; disabled?: boolean; title: string }) {
  return <button className="new-thread-button" onClick={onClick} disabled={disabled} title={title}>
    <Plus size={16} />
    <span>New thread</span>
    <kbd>{formatShortcut("newThread")}</kbd>
  </button>;
}

export function SidebarFooter({ label, onOpen, onPreload }: { label: string; onOpen: () => void; onPreload?: () => void }) {
  return <div className="sidebar-footer">
    <button className="sidebar-settings" aria-keyshortcuts="Meta+Comma Control+Comma" title={withShortcut("Settings", "settings")} onClick={onOpen} onMouseEnter={onPreload} onFocus={onPreload} onPointerDown={onPreload}>
      <Settings size={16} />
      <span>{label}</span>
      <kbd aria-hidden="true">{formatShortcut("settings")}</kbd>
    </button>
  </div>;
}

export function ProjectHeading({ name, detail, detailTitle }: { name: string; detail: ReactNode; detailTitle?: string }) {
  return <div className="project-heading">
    <span>{name}</span>
    <small title={detailTitle}>{detail}</small>
  </div>;
}

/** The status word, full and short (the bar sheds to the short one when tight). */
export function RuntimeStatusWords({ kind, word }: { kind: TopbarStatusKind; word: string }) {
  return <>
    <span className="runtime-status-word-full" aria-hidden="true">{word}</span>
    <span className="runtime-status-word-short" aria-hidden="true">{topbarStatusLabel(kind, word, true)}</span>
  </>;
}

/** One persistent status region carries the full state for assistive tech at every width. */
export function RuntimeStatusAnnouncement({ word, detail }: { word: string; detail?: string }) {
  return <span className="sr-only" role="status">Status: {word}.{detail && detail !== word ? ` ${detail}` : ""}</span>;
}

/** The top bar's status when it asks nothing of the person (not a button). */
export function RuntimeStatusIndicator({ kind, word, detail, icon, tone }: { kind: TopbarStatusKind; word: string; detail?: string; icon: ReactNode; tone?: "working" | "unavailable" }) {
  return <div className={`runtime-status ${tone ?? ""}`} data-status={kind} title={detail}>
    <RuntimeStatusAnnouncement word={word} detail={detail} />
    {icon}
    <RuntimeStatusWords kind={kind} word={word} />
  </div>;
}

export function PaletteTrigger({ onClick }: { onClick: () => void }) {
  return <button className="command-palette-trigger" onClick={onClick} aria-label="Search commands, projects and threads" aria-keyshortcuts="Meta+K Control+K" title={withShortcut("Search commands, projects and threads", "palette")}>
    <Search size={13} aria-hidden="true" />
    <span>Search</span>
    <kbd>{formatShortcut("palette")}</kbd>
  </button>;
}

/** The top bar's Tools toggle for this machine's project. */
export function ToolsToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return <button className={`workspace-tools-trigger studio-toggle ${open ? "active" : ""}`} onClick={onClick} title={`${open ? "Hide" : "Show"} Tools (${workspaceShortcutLabel()})`} aria-label={open ? "Hide Tools" : "Show Tools"} aria-keyshortcuts="Meta+B Control+B" aria-expanded={open}>
    <PanelRight size={17} />
    <span>Tools</span>
    <kbd>{workspaceShortcutLabel()}</kbd>
  </button>;
}

export function ComposerCaption({ contextPercent, costEstimate }: { contextPercent: number | null; costEstimate?: string | null }) {
  return <div className="composer-caption">
    Mythra Code can make mistakes. Review commands and changes before shipping.
    {contextPercent !== null ? (
      <span className={`context-meter ${contextPercent > 80 ? "warn" : ""}`} title="Context window used by this conversation, and its estimated API cost">
        {" "}
        · Context <Odometer value={String(Math.round(contextPercent))} label={`${Math.round(contextPercent)} percent`} />% used
        {costEstimate ? <> · <Odometer value={costEstimate} /></> : null}
      </span>
    ) : null}
  </div>;
}

export function AttachButton({ count, onClick }: { count: number; onClick: () => void }) {
  return <button type="button" className={`toolbar-button attach-button ${count ? "has-attachments" : ""}`} onClick={onClick} title="Attach files or images" aria-label={count ? `Attach, ${count} attached` : "Attach"}>
    <Paperclip size={14} aria-hidden="true" />
    {count ? count : "Attach"}
  </button>;
}
