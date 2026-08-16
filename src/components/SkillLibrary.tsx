import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Boxes, Check, FilePlus2, FolderOpen, LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import { normalizeSkillName, type LocalSkill } from "../lib/skills";
import { useModalFocus } from "../hooks/useModalFocus";

export function SkillLibrary({
  folder,
  skills,
  removedSkills,
  busy,
  error,
  onChooseFolder,
  onRefresh,
  onImport,
  onCreate,
  onRename,
  onToggle,
  onRemove,
  onRestore,
}: {
  folder: string;
  skills: LocalSkill[];
  removedSkills: LocalSkill[];
  busy: boolean;
  error: string;
  onChooseFolder: () => void;
  onRefresh: () => void;
  onImport: () => void;
  onCreate: (name: string, instructions: string) => Promise<boolean>;
  onRename: (path: string, name: string) => boolean;
  onToggle: (path: string) => void;
  onRemove: (path: string, deleteSource: boolean) => Promise<boolean>;
  onRestore: (path: string) => Promise<boolean>;
}) {
  const fieldId = useId();
  const [query, setQuery] = useState("");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [created, setCreated] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<LocalSkill | null>(null);
  const [removing, setRemoving] = useState(false);
  const [restoringPath, setRestoringPath] = useState<string | null>(null);
  const createFormRef = useRef<HTMLFormElement>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const removeDialogRef = useRef<HTMLDivElement>(null);
  // Focus only moves back to the trigger for a composer the user actually
  // opened — never on the first render, which would steal focus from the
  // settings dialog's own entry point.
  const composerUsedRef = useRef(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.fileName} ${skill.description}`.toLowerCase().includes(needle));
  }, [query, skills]);
  const enabledCount = useMemo(() => skills.filter((skill) => skill.enabled).length, [skills]);

  useEffect(() => {
    if (composerOpen) {
      nameFieldRef.current?.focus();
      // The editor opens below the skill list, close to the modal's fixed
      // footer. Bring the whole surface into the scrollable pane instead of
      // leaving its instructions and actions hidden below the fold.
      createFormRef.current?.scrollIntoView?.({ block: "nearest" });
    }
    else if (composerUsedRef.current) addButtonRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    if (!pendingRemoval) return;
    if (!skills.some((candidate) => candidate.path === pendingRemoval.path)) {
      setPendingRemoval(null);
      setRemoving(false);
    }
  }, [pendingRemoval, skills]);
  useModalFocus(removeDialogRef, Boolean(pendingRemoval));

  const nameReady = Boolean(createName.trim());
  const instructionsReady = Boolean(createInstructions.trim());
  const canCreate = nameReady && instructionsReady && !creating;
  const previewName = normalizeSkillName(createName);

  const openComposer = () => {
    composerUsedRef.current = true;
    setCreated("");
    setCreateFailed(false);
    setComposerOpen(true);
  };

  const closeComposer = () => {
    setComposerOpen(false);
    setCreateName("");
    setCreateInstructions("");
    setCreateFailed(false);
    setCreating(false);
  };

  const submitCreate = async (event?: FormEvent) => {
    event?.preventDefault();
    const name = createName.trim();
    const instructions = createInstructions.trim();
    if (creating || !name || !instructions) return;
    setCreating(true);
    setCreateFailed(false);
    let ok = false;
    try {
      ok = await onCreate(name, instructions);
    } catch {
      ok = false;
    }
    if (!ok) {
      // A rejected creation keeps the editor and every typed character in
      // place so the reported reason can be acted on without retyping.
      setCreating(false);
      setCreateFailed(true);
      return;
    }
    setCreated(name);
    setQuery("");
    closeComposer();
  };

  // Escape belongs to the innermost open surface. Without this the settings
  // dialog's document-level handler would close the whole modal and discard
  // whatever was being typed.
  const composerKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeComposer();
      return;
    }
    if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      void submitCreate();
    }
  };

  const cancelRename = () => {
    setEditingPath(null);
    setNameDraft("");
  };

  // Once the user starts a different library operation, any following host
  // error belongs to that operation rather than the still-open create form.
  // Keep the editor open, but route the message back to the section-level
  // alert so unrelated scan, import, folder, or rename failures are not
  // presented as creation errors.
  const beginLibraryAction = (action: () => void) => {
    setCreateFailed(false);
    action();
  };

  const confirmRemoval = async (deleteSource: boolean) => {
    if (!pendingRemoval || removing) return;
    setRemoving(true);
    let removed = false;
    try {
      removed = await onRemove(pendingRemoval.path, deleteSource);
    } catch {
      removed = false;
    }
    if (removed) setPendingRemoval(null);
    setRemoving(false);
  };

  const restoreRemovedSkill = async (path: string) => {
    if (restoringPath) return;
    setRestoringPath(path);
    try {
      await onRestore(path);
    } finally {
      setRestoringPath(null);
    }
  };

  const inlineCreateError = composerOpen && createFailed
    ? error || "Could not create this skill. Check the details and try again."
    : "";
  const sectionError = inlineCreateError ? "" : error;

  return (
    <section className="settings-section skill-library-section">
      <div className="settings-section-heading settings-heading-with-action">
        <div className="settings-icon"><Boxes size={17} /></div>
        <div><h3>Local skill library</h3><p>Markdown workflows that OpenKiwi exposes by name to both OpenAI and OpenRouter models.</p></div>
        {folder && <button className="secondary-button" onClick={() => beginLibraryAction(onRefresh)} disabled={busy}>{busy ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />} Rescan</button>}
      </div>

      <div className={`skill-folder-card ${folder ? "selected" : "empty"}`}>
        <span className="skill-folder-icon"><FolderOpen size={19} /></span>
        <span className="skill-folder-copy">
          <strong>{folder ? "Skills folder" : "Choose a skills folder"}</strong>
          <small title={folder || undefined}>{folder || "Pick any local folder containing Markdown skill files."}</small>
        </span>
        <span className="skill-folder-actions">
          {folder && <button className="secondary-button" onClick={() => void revealItemInDir(folder)}><FolderOpen size={13} /> Show folder</button>}
          <button className={folder ? "secondary-button" : "primary-button"} onClick={() => beginLibraryAction(onChooseFolder)}>{folder ? "Change" : "Choose folder"}</button>
        </span>
      </div>

      {sectionError && <p className="skill-library-alert" role="alert">{sectionError}</p>}

      {folder && <>
        <div className="skill-library-toolbar">
          <div className="skill-search">
            <Search size={14} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" aria-label="Search skills" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear skill search"><X size={13} /></button>}
          </div>
          <button className="secondary-button" onClick={() => beginLibraryAction(onImport)}><FilePlus2 size={13} /> Import Markdown</button>
        </div>

        <div className="skill-library-group">
          <div className="skill-library-meta">
            <h4 id={`${fieldId}-list`}>Your skills</h4>
            {skills.length > 0 && <span>{query.trim()
              ? `${filtered.length} of ${skills.length} matching`
              : <><b>{enabledCount}</b> of {skills.length} enabled</>}</span>}
          </div>

          {filtered.length > 0 && <ul className="skill-card-list" aria-labelledby={`${fieldId}-list`}>
            {filtered.map((skill) => (
              <li className={`skill-card ${skill.enabled ? "enabled" : "disabled"}`} key={skill.path}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={skill.enabled}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  className={`mini-toggle ${skill.enabled ? "on" : ""}`}
                  onClick={() => onToggle(skill.path)}
                ><span /></button>
                <div className="skill-card-copy">
                  {editingPath === skill.path ? (
                    <form
                      className="skill-name-editor"
                      onSubmit={(event) => { event.preventDefault(); beginLibraryAction(() => { if (onRename(skill.path, nameDraft)) cancelRename(); }); }}
                      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancelRename(); } }}
                    >
                      <span aria-hidden="true">@</span>
                      <input autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} aria-label={`Invocation name for ${skill.fileName}`} />
                      <button type="submit" aria-label="Save skill name"><Check size={13} /></button>
                      <button type="button" onClick={cancelRename} aria-label="Cancel skill rename"><X size={13} /></button>
                    </form>
                  ) : (
                    <div className="skill-name-row">
                      <strong>@{skill.name}</strong>
                      {!skill.enabled && <span className="skill-off-tag">Off</span>}
                    </div>
                  )}
                  <p className={skill.description ? "" : "empty"} title={skill.description || undefined}>{skill.description || "No description in this file yet."}</p>
                  <small className="skill-card-path">{skill.relativePath}{skill.supportingMarkdownCount ? ` · ${skill.supportingMarkdownCount} supporting Markdown file${skill.supportingMarkdownCount === 1 ? "" : "s"}` : ""}</small>
                </div>
                <div className="skill-card-actions">
                  {editingPath !== skill.path && <button type="button" onClick={() => { setEditingPath(skill.path); setNameDraft(skill.name); }} aria-label={`Rename ${skill.name}`} title="Change the app-only invocation name"><Pencil size={13} /></button>}
                  <button type="button" onClick={() => void revealItemInDir(skill.path)} aria-label={`Show ${skill.name} in folder`} title="Show source file"><FolderOpen size={13} /></button>
                  <button type="button" className="danger-icon-button" onClick={() => setPendingRemoval(skill)} aria-label={`Remove ${skill.name}`} title="Remove skill"><Trash2 size={13} /></button>
                </div>
              </li>
            ))}
          </ul>}

          {/* A search that matches nothing is reported as such even mid-rescan;
              the scanning state is only for a library we know nothing about. */}
          {!filtered.length && (skills.length ? (
            <div className="skill-empty-state">
              <Search size={20} aria-hidden="true" />
              <strong>No skills match “{query.trim()}”</strong>
              <small>Try a shorter search, or clear it to see all {skills.length} detected skills.</small>
              <button type="button" className="secondary-button" onClick={() => setQuery("")}>Clear search</button>
            </div>
          ) : busy ? (
            <div className="skill-empty-state"><LoaderCircle className="spin" size={20} aria-hidden="true" /><strong>Scanning your skills folder…</strong></div>
          ) : (
            <div className="skill-empty-state">
              <Boxes size={20} aria-hidden="true" />
              <strong>No skills in this folder yet</strong>
              <small>Import an existing Markdown file, or add your first skill below. Top-level <code>.md</code> files and nested <code>SKILL.md</code> packages are both detected.</small>
            </div>
          ))}
        </div>

        {removedSkills.length > 0 && (
          <div className="skill-removed-group">
            <div className="skill-library-meta"><h4>Removed from OpenKiwi</h4><span>{removedSkills.length} kept on disk</span></div>
            <ul className="skill-removed-list">
              {removedSkills.map((skill) => (
                <li key={skill.path}>
                  <span><strong>@{skill.name}</strong><small>{skill.relativePath}</small></span>
                  <button type="button" className="secondary-button" onClick={() => void restoreRemovedSkill(skill.path)} disabled={Boolean(restoringPath)}>{restoringPath === skill.path ? <LoaderCircle className="spin" size={12} /> : <RotateCcw size={12} />} Restore</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="skill-composer">
          {composerOpen ? (
            <form ref={createFormRef} className="skill-create-card" onSubmit={(event) => void submitCreate(event)} onKeyDown={composerKeyDown} aria-labelledby={`${fieldId}-create`}>
              <div className="skill-create-head">
                <span className="skill-create-icon"><Plus size={15} aria-hidden="true" /></span>
                <span>
                  <strong id={`${fieldId}-create`}>New Markdown skill</strong>
                  <small>OpenKiwi writes the file into your skills folder. You can edit it in any Markdown editor afterward.</small>
                </span>
              </div>

              <div className="skill-field">
                <label htmlFor={`${fieldId}-name`}>Skill name</label>
                <input
                  ref={nameFieldRef}
                  id={`${fieldId}-name`}
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="release-check"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${fieldId}-name-hint`}
                />
                <small id={`${fieldId}-name-hint`}>{previewName ? <>Invoked as <code>@{previewName}</code></>: "Letters and numbers only — spaces become dashes."}</small>
              </div>

              <div className="skill-field">
                <label htmlFor={`${fieldId}-instructions`}>Instructions</label>
                <textarea
                  id={`${fieldId}-instructions`}
                  value={createInstructions}
                  onChange={(event) => setCreateInstructions(event.target.value)}
                  rows={5}
                  placeholder="Describe when to use this skill and the steps the model should follow…"
                  aria-describedby={`${fieldId}-instructions-hint`}
                />
                <small id={`${fieldId}-instructions-hint`}>Enter starts a new line. Press Ctrl+Enter to create.</small>
              </div>

              {inlineCreateError && <p className="skill-create-error" role="alert">{inlineCreateError}</p>}

              <div className="skill-create-actions">
                {/* The settings dialog already owns a "Cancel"; this one names
                    what it cancels so the two are never confused. */}
                <button type="button" className="secondary-button" aria-label="Cancel new skill" onClick={closeComposer}>Cancel</button>
                <button type="submit" className="primary-button" disabled={!canCreate}>{creating ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} Create skill</button>
              </div>
            </form>
          ) : (
            <>
              <button ref={addButtonRef} type="button" className="skill-add-button" onClick={openComposer}>
                <Plus size={14} aria-hidden="true" /> Add a new skill
              </button>
              {created && <p className="skill-created-note" role="status"><Check size={13} aria-hidden="true" /> Created “{created}” in your skills folder.</p>}
            </>
          )}
        </div>

        <ul className="skill-notes">
          <li><Check size={13} aria-hidden="true" /><span>Top-level <code>.md</code> files and nested <code>SKILL.md</code> packages are detected. Renaming changes only the invocation name inside OpenKiwi.</span></li>
          <li><Check size={13} aria-hidden="true" /><span>Relative <code>.md</code> references are mirrored with the skill when OpenKiwi prepares it for the model. Source files are never rewritten.</span></li>
        </ul>

        {pendingRemoval && (
          <div
            className="skill-remove-backdrop"
            onMouseDown={(event) => { if (event.target === event.currentTarget && !removing) setPendingRemoval(null); }}
          >
            <div
              ref={removeDialogRef}
              className="skill-remove-dialog"
              data-skill-remove-modal=""
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={`${fieldId}-remove-title`}
              aria-describedby={`${fieldId}-remove-description`}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                if (!removing) setPendingRemoval(null);
              }}
            >
              <span className="skill-remove-icon"><Trash2 size={17} aria-hidden="true" /></span>
              <div className="skill-remove-copy">
                <h4 id={`${fieldId}-remove-title`}>Remove @{pendingRemoval.name}?</h4>
                <p id={`${fieldId}-remove-description`}>Choose whether to leave <code>{pendingRemoval.relativePath}</code> in your skills folder or permanently delete that source file too. Other package and supporting files are always kept.</p>
              </div>
              <div className="skill-remove-actions">
                <button data-autofocus type="button" className="secondary-button" onClick={() => setPendingRemoval(null)} disabled={removing}>Cancel</button>
                <button type="button" className="secondary-button" onClick={() => void confirmRemoval(false)} disabled={removing}>Remove from OpenKiwi</button>
                <button type="button" className="danger-button" onClick={() => void confirmRemoval(true)} disabled={removing}>{removing ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />} Delete source file too</button>
              </div>
            </div>
          </div>
        )}
      </>}
    </section>
  );
}
