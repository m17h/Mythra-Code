import "./CustomThemesSettings.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Pencil, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { CustomThemePreview } from "./CustomThemePreview";
import { RowMenu } from "./RowMenu";
import { EmptyState, rovingChoiceKeyDown, SettingInfo, Switch } from "./SettingsBits";
import { SmoothDisclosure } from "./SmoothDisclosure";
import { ThemeLibraryDialog, type ThemeLibraryFocus } from "./ThemeLibraryDialog";
import { tileMeta, useReducedMotion } from "./customThemeBits";
import { THEMES, customThemeIdOf, customThemeSetting } from "../lib/appConfig";
import { confirmDialog } from "../lib/confirmDialog";
import { formatShortcut } from "../lib/shortcuts";
import {
  deleteCustomTheme,
  headSpec,
  setThemeDisabled,
  useCustomThemes,
  type CustomThemeRecord,
  type ThemeDisabledReason,
} from "../lib/customThemes/store";
import { settingsTiles } from "../lib/customThemes/library";
import type { CustomThemeId } from "../lib/customThemes/spec";
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

/** The newest palette request already answered (see `libraryRequest`). */
let handledLibraryRequest = 0;

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
  libraryRequest = 0,
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
  /** Changes (to a new non-zero value) to open the Theme library, e.g. from the command palette. */
  libraryRequest?: number;
}) {
  const library = useCustomThemes();
  const themes = library.themes;
  const selectedId = customThemeIdOf(selectedTheme);
  const tiles = useMemo(() => settingsTiles(themes, selectedId), [themes, selectedId]);
  const [designOpen, setDesignOpen] = useState(false);
  const [designTarget, setDesignTarget] = useState<CustomThemeId | undefined>(undefined);
  const [hovered, setHovered] = useState<CustomThemeId | null>(null);
  // Open with an optional theme to land on; null while closed.
  const [libraryOpen, setLibraryOpen] = useState<{ focus: ThemeLibraryFocus | null } | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const libraryOpenerRef = useRef<HTMLElement | null>(null);
  const designId = useId();
  const reducedMotion = useReducedMotion();
  const motionPaused = settings.themeMotion === "paused";
  const motionAllowed = active && !motionPaused && !reducedMotion;

  const openLibrary = useCallback((focus: ThemeLibraryFocus | null = null, opener?: HTMLElement | null) => {
    libraryOpenerRef.current = opener ?? libraryButtonRef.current;
    setLibraryOpen({ focus });
  }, []);
  // The palette's "Open theme library" arrives as a new request number. It is
  // remembered outside the component: switching panes remounts this section.
  useEffect(() => {
    if (!libraryRequest || !active || libraryRequest <= handledLibraryRequest) return;
    handledLibraryRequest = libraryRequest;
    if (themes.length) openLibrary();
  }, [libraryRequest, active, themes.length, openLibrary]);

  const disabledThemes = themes.filter((record) => record.disabledReason);
  const openDesigner = (target?: CustomThemeId) => {
    setDesignTarget(target);
    setDesignOpen(true);
  };

  const removeTheme = async (record: CustomThemeRecord): Promise<boolean> => {
    const spec = headSpec(record);
    const wasSelected = selectedId === record.id;
    const baseName = THEMES.find((theme) => theme.id === spec.base)?.name ?? spec.base;
    const confirmed = await confirmDialog(
      `Delete “${spec.name}”?\n\nThis removes the theme and all of its history.${wasSelected ? ` Mythra Code will switch to ${baseName}, its base theme.` : ""}`,
      { confirmLabel: "Delete theme", cancelLabel: "Keep theme" },
    );
    if (!confirmed) return false;
    const { record: removed, restore } = deleteCustomTheme(record.id);
    if (!removed) return false;
    if (wasSelected) onSelectTheme(spec.base);
    onDeleted({ record: removed, wasSelected, restore });
    return true;
  };

  const tileMenu = (record: CustomThemeRecord) => [
    { label: "Rename", icon: <Pencil size={13} />, onSelect: () => {
      const trigger = sectionRef.current?.querySelector<HTMLElement>(`[data-ct-tile="${record.id}"] .row-menu-trigger`);
      openLibrary({ id: record.id, field: "name" }, trigger);
    } },
    { label: "Adjust with AI", icon: <Sparkles size={13} />, onSelect: () => openDesigner(record.id) },
    { label: "Delete…", icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void removeTheme(record) },
  ];

  const hiddenCount = themes.length - tiles.length;

  return (
    <div ref={sectionRef} className="set-group ct-settings" id="appearance-custom-themes">
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
            {tiles.map((record, index) => {
              const spec = headSpec(record);
              const selected = selectedId === record.id;
              const tabbable = selected || (!tiles.some((entry) => entry.id === selectedId) && index === 0);
              const animate = motionAllowed && spec.motion?.enabled !== false
                && (selected || hovered === record.id) && !record.disabledReason && !libraryOpen;
              return (
                <div key={record.id} data-ct-tile={record.id} className={`ct-tile${selected ? " selected" : ""}`}
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
                    onClick={() => onSelectTheme(customThemeSetting(record.id))}
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
          <div className="ct-library-link-row">
            <button ref={libraryButtonRef} type="button" className="ct-library-link" aria-haspopup="dialog" onClick={(event) => openLibrary(null, event.currentTarget)}>
              {hiddenCount > 0 ? `See all ${themes.length} themes` : "Manage themes"}
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div></div>
      )}

      {libraryOpen && <ThemeLibraryDialog
        themes={themes}
        selectedId={selectedId && themes.some((record) => record.id === selectedId) ? selectedId : null}
        initialFocus={libraryOpen.focus}
        motionAllowed={motionAllowed}
        host={sectionRef.current?.closest<HTMLElement>(".settings-backdrop") ?? null}
        returnFocus={() => {
          const opener = libraryOpenerRef.current;
          return opener && opener.isConnected ? opener : libraryButtonRef.current;
        }}
        onUse={(id) => onSelectTheme(customThemeSetting(id))}
        onDesign={(target) => {
          // One design flow: close the library and open the panel here.
          setLibraryOpen(null);
          openDesigner(target);
          requestAnimationFrame(() => document.getElementById(designId)?.scrollIntoView?.({ block: "nearest" }));
        }}
        onDelete={removeTheme}
        onClose={() => {
          setLibraryOpen(null);
          // Opened from the palette, the link may be below the fold: bring it into view with its focus.
          if (libraryOpenerRef.current === libraryButtonRef.current) requestAnimationFrame(() => libraryButtonRef.current?.scrollIntoView?.({ block: "nearest" }));
        }}
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
