import "./CustomThemesSettings.css";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Pencil, RotateCcw, Sparkles, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { CustomThemePreview } from "./CustomThemePreview";
import { RowMenu } from "./RowMenu";
import { EmptyState, rovingChoiceKeyDown, SettingInfo, Switch } from "./SettingsBits";
import { SmoothDisclosure } from "./SmoothDisclosure";
import { THEMES, customThemeIdOf, customThemeSetting } from "../lib/appConfig";
import { confirmDialog } from "../lib/confirmDialog";
import { formatShortcut } from "../lib/shortcuts";
import {
  canUndo,
  commitCustomThemeRevision,
  deleteCustomTheme,
  headSpec,
  providerName,
  renameCustomTheme,
  revisionAuthor,
  setThemeDisabled,
  undoCustomTheme,
  useCustomThemes,
  type CustomThemeRecord,
  type CustomThemeRevision,
  type ThemeDisabledReason,
} from "../lib/customThemes/store";
import { builtInScheme, type CustomThemeId, type EffectType } from "../lib/customThemes/spec";
import { effectMoves } from "../lib/customThemes/compile";
import type { AppSettings, Provider, ThemeId } from "../types";

/** What "Design a theme with AI" starts: a new chat on this model, ready for theming. */
export interface ThemeDesignerChoice {
  provider: Provider;
  model: string;
  targetThemeId?: CustomThemeId;
}

export interface DeletedCustomTheme {
  record: CustomThemeRecord;
  /** Whether it was the theme chosen here when it was deleted. */
  wasSelected: boolean;
  restore: () => boolean;
}

export interface ThemeDesignerOptions {
  providers: AppSelectOption[];
  models: (provider: Provider) => AppSelectOption[];
  /** Why a provider can't run a conversation right now (signed out), if it can't. */
  issue: (provider: Provider) => string | null;
  initial: { provider: Provider; model: string };
}

const USER = { kind: "user" } as const;

/** "just now", "3 min ago", "2 h ago", "4 days ago", then a date. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function hasMotion(record: CustomThemeRecord): boolean {
  const spec = headSpec(record);
  // Only effects that actually move (static grain or a vignette is not "Animated").
  return Object.entries(spec.effects ?? {}).some(([type, params]) => Boolean(params) && effectMoves(type as EffectType, (params ?? {}) as Record<string, unknown>))
    || /animation/i.test(spec.customCss ?? "");
}

function tileMeta(record: CustomThemeRecord): string {
  const spec = headSpec(record);
  const parts: string[] = [];
  if (record.disabledReason) parts.push("Turned off");
  else if (hasMotion(record) && spec.motion?.enabled !== false) parts.push("Animated");
  parts.push(builtInScheme(spec.base) === "light" ? "Light" : "Dark");
  return parts.join(" · ");
}

function authorPhrase(record: CustomThemeRecord): string {
  return record.createdBy.kind === "user" ? "Made by you" : `Made by ${providerName(record.createdBy.provider)}`;
}

const SAFE_MODE_COPY: Record<ThemeDisabledReason, (name: string) => string> = {
  "boot-failure": (name) => `“${name}” was turned off because Mythra Code didn't start cleanly with it.`,
  "render-error": (name) => `“${name}” was turned off after part of the app failed to draw with it.`,
  invalid: (name) => `“${name}” no longer passes the theme checks in this version, so Mythra Code is using its base theme instead.`,
};

export function CustomThemesSettings({
  selectedTheme,
  onSelectTheme,
  settings,
  onSettingsChange,
  active,
  designer,
  onDesign,
  onDeleted,
}: {
  /** The theme chosen in Settings (the draft). */
  selectedTheme: ThemeId;
  onSelectTheme: (theme: ThemeId) => void;
  settings: Pick<AppSettings, "themeMotion" | "themePauseInBackground" | "customThemeTools">;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  /** Settings is open on Appearance: previews may animate. */
  active: boolean;
  designer: ThemeDesignerOptions;
  onDesign: (choice: ThemeDesignerChoice) => void;
  onDeleted: (deleted: DeletedCustomTheme) => void;
}) {
  const library = useCustomThemes();
  const themes = library.themes;
  const selectedId = customThemeIdOf(selectedTheme);
  const [detailId, setDetailId] = useState<CustomThemeId | null>(null);
  const shownId = selectedId && themes.some((record) => record.id === selectedId) ? (detailId ?? selectedId) : detailId;
  const detail = themes.find((record) => record.id === shownId) ?? null;
  const [designOpen, setDesignOpen] = useState(false);
  const [designTarget, setDesignTarget] = useState<CustomThemeId | undefined>(undefined);
  const [hovered, setHovered] = useState<CustomThemeId | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const designId = useId();
  const reducedMotion = useReducedMotion();
  const motionPaused = settings.themeMotion === "paused";

  // A tile picked from the built-in grid closes a detail card opened from a menu.
  useEffect(() => { if (!selectedId) setDetailId(null); }, [selectedId]);
  useEffect(() => { if (detailId && !themes.some((record) => record.id === detailId)) setDetailId(null); }, [detailId, themes]);

  const disabledThemes = themes.filter((record) => record.disabledReason);
  const openDesigner = (target?: CustomThemeId) => {
    setDesignTarget(target);
    setDesignOpen(true);
  };

  const removeTheme = async (record: CustomThemeRecord) => {
    const spec = headSpec(record);
    const wasSelected = selectedId === record.id;
    const baseName = THEMES.find((theme) => theme.id === spec.base)?.name ?? spec.base;
    const confirmed = await confirmDialog(
      `Delete “${spec.name}”?\n\nThis removes the theme and all of its history.${wasSelected ? ` Mythra Code will switch to ${baseName}, its base theme.` : ""}`,
      { confirmLabel: "Delete theme", cancelLabel: "Keep theme" },
    );
    if (!confirmed) return;
    const { record: removed, restore } = deleteCustomTheme(record.id);
    if (!removed) return;
    if (wasSelected) onSelectTheme(spec.base);
    if (detailId === record.id) setDetailId(null);
    onDeleted({ record: removed, wasSelected, restore });
  };

  const tileMenu = (record: CustomThemeRecord) => [
    { label: "Rename", icon: <Pencil size={13} />, onSelect: () => {
      setDetailId(record.id);
      requestAnimationFrame(() => { nameInputRef.current?.focus(); nameInputRef.current?.select(); });
    } },
    { label: "Adjust with AI", icon: <Sparkles size={13} />, onSelect: () => openDesigner(record.id) },
    { label: "Delete…", icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void removeTheme(record) },
  ];

  return (
    <div className="set-group ct-settings" id="appearance-custom-themes">
      <div className="set-group-head">
        <h4 tabIndex={-1}>Custom themes</h4>
        {themes.length > 0 && !designOpen && (
          <button type="button" className="secondary-button" aria-expanded={designOpen} aria-controls={designId} onClick={() => openDesigner()}>
            <Sparkles size={12} aria-hidden="true" /> Design a theme with AI
          </button>
        )}
      </div>
      {disabledThemes.map((record) => (
        <div key={record.id} className="ct-safe-notice" role="status">
          <TriangleAlert size={15} aria-hidden="true" />
          <div className="ct-safe-notice-copy">
            <strong>{SAFE_MODE_COPY[record.disabledReason!](headSpec(record).name)}</strong>
            <small>Your theme and its history are kept. Turn it back on to try it again.</small>
          </div>
          <div className="ct-safe-notice-actions">
            <button type="button" className="secondary-button" onClick={() => openDesigner(record.id)}>Ask a model to fix it</button>
            <button type="button" className="secondary-button" onClick={() => {
              setThemeDisabled(record.id, null);
              onSelectTheme(customThemeSetting(record.id));
            }}>Turn it back on</button>
          </div>
        </div>
      ))}

      <SmoothDisclosure open={designOpen} id={designId} className="ct-design-disclosure">
        {designOpen && <DesignPanel
          options={designer}
          target={designTarget ? themes.find((record) => record.id === designTarget) ?? null : null}
          toolsOff={settings.customThemeTools === false}
          onCancel={() => setDesignOpen(false)}
          onStart={(choice) => {
            setDesignOpen(false);
            onDesign({ ...choice, ...(designTarget ? { targetThemeId: designTarget } : {}) });
          }}
        />}
      </SmoothDisclosure>

      {themes.length === 0 && !designOpen && (
        <EmptyState
          icon={Sparkles}
          title="No custom themes yet"
          detail="Describe a look and a model builds it: colours, fonts and optional animations."
          action={<button type="button" className="primary-button" aria-controls={designId} aria-expanded={designOpen} onClick={() => openDesigner()}><Sparkles size={13} aria-hidden="true" /> Design a theme with AI</button>}
        />
      )}

      {themes.length > 0 && (
        <div className="set-card bare"><div className="set-body">
          <div className="theme-grid ct-grid" role="radiogroup" aria-label="Custom themes" onKeyDown={rovingChoiceKeyDown}>
            {themes.map((record, index) => {
              const spec = headSpec(record);
              const selected = selectedId === record.id;
              const tabbable = selected || (!themes.some((entry) => entry.id === selectedId) && index === 0);
              const animate = active && !motionPaused && !reducedMotion && spec.motion?.enabled !== false
                && (selected || hovered === record.id) && !record.disabledReason;
              return (
                <div key={record.id} className={`ct-tile${selected ? " selected" : ""}`}
                  onPointerEnter={() => setHovered(record.id)} onPointerLeave={() => setHovered((current) => current === record.id ? null : current)}>
                  <button
                    type="button"
                    className={`theme-card ct-card${selected ? " selected" : ""}`}
                    role="radio"
                    aria-checked={selected}
                    tabIndex={tabbable ? 0 : -1}
                    title={spec.description || undefined}
                    onFocus={() => setHovered(record.id)}
                    onBlur={() => setHovered((current) => current === record.id ? null : current)}
                    onClick={() => { setDetailId(null); onSelectTheme(customThemeSetting(record.id)); }}
                  >
                    <span className="ct-preview-slot" aria-hidden="true">
                      <CustomThemePreview id={record.id} spec={spec} animate={animate} />
                    </span>
                    <span>
                      <strong>{spec.name}</strong>
                      <small>{tileMeta(record)}</small>
                    </span>
                    {selected && <Check size={14} />}
                  </button>
                  <span className="ct-tile-menu">
                    <RowMenu label={`More for ${spec.name}`} items={() => tileMenu(record)} />
                  </span>
                </div>
              );
            })}
          </div>
        </div></div>
      )}

      {detail && <ThemeDetail
        key={detail.id}
        record={detail}
        nameInputRef={nameInputRef}
        selected={selectedId === detail.id}
        onUse={() => { setDetailId(null); onSelectTheme(customThemeSetting(detail.id)); }}
      />}

      <div className="set-card ct-behaviour">
        <div className="set-row">
          <div className="set-copy">
            <strong id="ct-motion-label">Theme animations</strong>
            <small>{reducedMotion
              ? "Your system asks apps to reduce motion, so theme animations stay paused."
              : "Play animations in custom themes."}</small>
          </div>
          <div className="set-control">
            <Switch
              checked={!motionPaused && !reducedMotion}
              disabled={reducedMotion}
              labelledBy="ct-motion-label"
              onChange={(next) => onSettingsChange({ themeMotion: next ? "on" : "paused" })}
            />
          </div>
        </div>
        <div className="set-row">
          <div className="set-copy">
            <strong id="ct-background-label">Pause in the background</strong>
            <small>Stop animations when Mythra Code isn't the active window.</small>
          </div>
          <div className="set-control">
            <Switch
              checked={settings.themePauseInBackground !== false}
              disabled={motionPaused || reducedMotion}
              labelledBy="ct-background-label"
              onChange={(next) => onSettingsChange({ themePauseInBackground: next })}
            />
          </div>
        </div>
        <div className="set-row" data-settings-row="appearance-theme-tools">
          <div className="set-copy">
            <strong id="ct-tools-label">Theme tools in chats</strong>
            <small>Models can create, adjust and undo themes in any conversation, without asking. Only you can delete a theme.</small>
          </div>
          <div className="set-control">
            <SettingInfo label="About theme tools">
              <p>When this is on, every conversation can use a small set of theme tools. A model only uses them when you ask it to change how Mythra Code looks.</p>
              <p>Every change is saved as a new version, so you can undo it here or from the notice that appears. Sub-agents, workflows and scheduled tasks never get theme tools.</p>
            </SettingInfo>
            <Switch
              checked={settings.customThemeTools !== false}
              labelledBy="ct-tools-label"
              onChange={(next) => onSettingsChange({ customThemeTools: next })}
            />
          </div>
        </div>
        <div className="set-row">
          <div className="set-copy">
            <strong>Reset shortcut</strong>
            <small><kbd className="ct-kbd">{formatShortcut("resetTheme")}</kbd> switches back to the default theme at any time, even from a menu or a dialog.</small>
          </div>
        </div>
      </div>
    </div>
  );
}

function useReducedMotion(): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, setReduced] = useState(Boolean(query?.matches));
  useEffect(() => {
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [query]);
  return reduced;
}

function DesignPanel({ options, target, toolsOff, onCancel, onStart }: {
  options: ThemeDesignerOptions;
  target: CustomThemeRecord | null;
  toolsOff: boolean;
  onCancel: () => void;
  onStart: (choice: { provider: Provider; model: string }) => void;
}) {
  const [provider, setProvider] = useState<Provider>(options.initial.provider);
  const [model, setModel] = useState(options.initial.model);
  const models = useMemo(() => options.models(provider), [options, provider]);
  const issue = options.issue(provider);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  const switchProvider = (next: Provider) => {
    if (next === provider) return;
    setProvider(next);
    const fresh = options.models(next);
    setModel(fresh.find((option) => !option.disabled && option.value)?.value ?? "");
  };
  const name = target ? headSpec(target).name : "";
  return (
    <div className="set-card ct-design" role="group" aria-label={target ? `Adjust ${name} with AI` : "Design a theme with AI"}>
      <div className="ct-design-head">
        <h5 ref={headingRef} tabIndex={-1}>{target ? `Adjust “${name}” with AI` : "Design a theme with AI"}</h5>
        <p>Opens a new chat with the model you choose, ready for theming. Describe the look you want and it builds the theme while you watch.</p>
      </div>
      <div className="ct-design-fields">
        <div className="field-label">
          <span>Provider</span>
          <AppSelectMenu portal value={provider} options={options.providers} ariaLabel="Theme designer provider" onChange={(value) => switchProvider(value as Provider)} />
        </div>
        <div className="field-label">
          <span>Model</span>
          {models.length
            ? <AppSelectMenu portal value={model} options={models} ariaLabel="Theme designer model" placeholder="Choose a model…" searchable={models.length > 8}
              onChange={setModel} />
            : <input className="ct-model-input" aria-label="Theme designer model ID" maxLength={160} value={model} placeholder="vendor/model-name" spellCheck={false} onChange={(event) => setModel(event.target.value)} />}
        </div>
      </div>
      {issue && <p className="ct-design-note" role="note">{issue}</p>}
      {toolsOff && <p className="ct-design-note" role="note">Theme tools in chats is off, so the model can describe a theme but can't build it. Turn it on below first.</p>}
      <div className="ct-design-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" disabled={Boolean(issue) || !model.trim()} onClick={() => onStart({ provider, model: model.trim() })}>
          <Sparkles size={13} aria-hidden="true" /> Start
        </button>
      </div>
    </div>
  );
}

function ThemeDetail({ record, nameInputRef, selected, onUse }: {
  record: CustomThemeRecord;
  nameInputRef: RefObject<HTMLInputElement | null>;
  selected: boolean;
  onUse: () => void;
}) {
  const spec = headSpec(record);
  const [name, setName] = useState(spec.name);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const historyId = useId();
  const nameId = useId();
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setName(spec.name); }, [spec.name]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const commitName = () => {
    editing.current = false;
    const next = name.trim();
    if (!next) { setName(spec.name); return; }
    if (next !== spec.name) renameCustomTheme(record.id, next, USER);
  };
  // Typing autosaves after a pause, like the rest of Settings.
  useEffect(() => {
    if (!editing.current) return;
    const timer = window.setTimeout(() => {
      const next = name.trim();
      if (next && next !== headSpec(record).name) renameCustomTheme(record.id, next, USER);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [name, record]);

  const undo = canUndo(record);
  const baseTheme = THEMES.find((theme) => theme.id === spec.base);
  const scheme = builtInScheme(spec.base);
  const animated = hasMotion(record);
  const revisions = [...record.revisions].reverse();
  const adjusted = record.revisions.find((revision) => revision.n === record.head)?.adjustments?.length ?? 0;

  return (
    <div className="set-card ct-detail" aria-label={`${spec.name} details`} role="group">
      <div className="set-row">
        <label className="set-copy" htmlFor={nameId}><strong>Name</strong></label>
        <div className="set-control">
          <input
            id={nameId}
            ref={nameInputRef}
            className="ct-name-input"
            value={name}
            maxLength={40}
            spellCheck={false}
            onChange={(event) => { editing.current = true; setName(event.target.value); }}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commitName(); event.currentTarget.blur(); }
              if (event.key === "Escape" && name !== spec.name) { event.preventDefault(); event.stopPropagation(); editing.current = false; setName(spec.name); }
            }}
          />
        </div>
      </div>
      {spec.description && <div className="set-row">
        <div className="set-copy"><strong>Description</strong></div>
        <div className="set-control ct-detail-value"><span>{spec.description}</span></div>
      </div>}
      <div className="set-row">
        <div className="set-copy"><strong>Based on</strong></div>
        <div className="set-control ct-detail-value">
          <span>{baseTheme?.name ?? spec.base} ({scheme}) · {authorPhrase(record)} · Edited {ago(record.updatedAt, now)}</span>
          {!selected && <button type="button" className="secondary-button" onClick={onUse}>Use this theme</button>}
        </div>
      </div>
      {animated && <div className="set-row">
        <div className="set-copy">
          <strong id={`${nameId}-motion`}>Animations</strong>
          <small>Play this theme's animations.</small>
        </div>
        <div className="set-control">
          <Switch
            checked={spec.motion?.enabled !== false}
            labelledBy={`${nameId}-motion`}
            onChange={(next) => commitCustomThemeRevision(record.id, { ...spec, motion: { ...spec.motion, enabled: next } }, { by: USER, kind: "edit", summary: next ? "Animations on" : "Animations off" })}
          />
        </div>
      </div>}
      <div className="set-row ct-history-row">
        <button type="button" className="ct-history-toggle" aria-expanded={historyOpen} aria-controls={historyId} onClick={() => setHistoryOpen((open) => !open)}>
          <span className="ct-chevron" aria-hidden="true" />
          <strong>History</strong>
          <small>{record.revisions.length} version{record.revisions.length === 1 ? "" : "s"}{adjusted ? ` · ${adjusted} colour${adjusted === 1 ? "" : "s"} adjusted for readability` : ""}</small>
        </button>
        <div className="set-control">
          <button type="button" className="secondary-button" disabled={!undo.ok} title={undo.ok ? undefined : undo.reason}
            onClick={() => undoCustomTheme(record.id, { by: USER })}>
            <Undo2 size={13} aria-hidden="true" /> Undo last change
          </button>
        </div>
      </div>
      <SmoothDisclosure open={historyOpen} id={historyId} className="ct-history-disclosure">
        <ol className="ct-history" aria-label={`${spec.name} history`}>
          {revisions.map((revision) => <HistoryRow key={revision.n} record={record} revision={revision} now={now} />)}
          {record.revisions[0]!.n > 1 && <li className="ct-history-pruned">Earlier versions were cleared to save space.</li>}
        </ol>
      </SmoothDisclosure>
    </div>
  );
}

function HistoryRow({ record, revision, now }: { record: CustomThemeRecord; revision: CustomThemeRevision; now: number }) {
  const current = revision.n === record.head;
  const author = revisionAuthor(revision);
  return (
    <li className={current ? "current" : undefined} aria-current={current ? "true" : undefined}>
      <span className="ct-rev">r{revision.n}</span>
      <span className="ct-rev-copy">
        <span className="ct-rev-summary">{revision.summary}</span>
        <small>{author === "you" ? "You" : author} · {ago(revision.at, now)}{revision.adjustments?.length ? ` · ${revision.adjustments.length} colour${revision.adjustments.length === 1 ? "" : "s"} adjusted for readability` : ""}</small>
      </span>
      {current
        ? <span className="ct-rev-current">Current</span>
        : <button type="button" className="secondary-button ct-rev-restore" onClick={() => undoCustomTheme(record.id, { by: USER, toRevision: revision.n })}><RotateCcw size={12} aria-hidden="true" /> Restore</button>}
    </li>
  );
}
