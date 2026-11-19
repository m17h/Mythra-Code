import "./CustomThemesSettings.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, Sparkles, TriangleAlert } from "lucide-react";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { EmptyState, SettingInfo, Switch } from "./SettingsBits";
import { SmoothDisclosure } from "./SmoothDisclosure";
import { ThemeLibraryDialog, type ThemeLibraryFocus } from "./ThemeLibraryDialog";
import { useReducedMotion } from "./customThemeBits";
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
  onAccessChange,
  active,
  designer,
  onDesign,
  onDeleted,
  libraryRequest = 0,
}: {
  /** The theme chosen in Settings (the draft). */
  selectedTheme: ThemeId;
  onSelectTheme: (theme: ThemeId) => void;
  settings: Pick<AppSettings, "themeMotion" | "themePauseInBackground" | "customThemeTools" | "customThemeScreenshots">;
  onSettingsChange: (patch: Partial<Pick<AppSettings, "themeMotion" | "themePauseInBackground">>) => void;
  onAccessChange: (key: "customThemeTools" | "customThemeScreenshots", enabled: boolean) => void;
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
  const [designOpen, setDesignOpen] = useState(false);
  const [designTarget, setDesignTarget] = useState<CustomThemeId | undefined>(undefined);
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
  const inUse = selectedId ? themes.find((record) => record.id === selectedId) ?? null : null;
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
        <div className="set-card ct-library-card">
          <button ref={libraryButtonRef} type="button" className="ct-library-button" aria-haspopup="dialog" onClick={(event) => openLibrary(null, event.currentTarget)}>
            <span className="ct-library-button-copy">
              <strong>Custom themes<span className="ct-library-count"> · {themes.length}</span></strong>
              <small>{inUse ? `Using “${headSpec(inUse).name}”. ` : ""}Preview, use and manage your themes in the Theme library.</small>
            </span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
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
            <small>Models can create, adjust and undo themes without asking. Only you can delete a theme.</small>
          </div>
          <div className="set-control">
            <SettingInfo label="About theme tools">
              <p>Ask a model to change how Mythra Code looks from a chat or project conversation started on this device.</p>
              <p>Theme tools are unavailable to sub-agents, workflows, scheduled prompts and conversations with provider-native sub-agents enabled. Theme edits are saved as new versions you can undo.</p>
            </SettingInfo>
            <Switch
              checked={settings.customThemeTools !== false}
              labelledBy="ct-tools-label"
              onChange={(next) => onAccessChange("customThemeTools", next)}
            />
          </div>
        </div>
        <div className={`set-row${settings.customThemeTools === false ? " ct-row-off" : ""}`} data-settings-row="appearance-theme-screenshots">
          <div className="set-copy">
            <strong id="ct-see-label">Let models see theme previews</strong>
            <small>Models can check a hidden theme preview that uses sample chats and files. A picture goes to the requesting model's provider when it supports images.</small>
          </div>
          <div className="set-control">
            <Switch
              checked={settings.customThemeScreenshots !== false}
              disabled={settings.customThemeTools === false}
              labelledBy="ct-see-label"
              onChange={(next) => onAccessChange("customThemeScreenshots", next)}
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
