import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, Download, FolderOpen, Info, LoaderCircle, RotateCcw, Search, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { officialSkillsCatalog, skillPublisherLabel, type LocalSkill, type OfficialSkill, type OfficialSkillInstallFailure } from "../lib/skills";
import { friendlyError } from "../lib/errors";
import { InfoPopover } from "./InfoPopover";

type CardState = "available" | "installing" | "installed" | "modified" | "removed";

export function OfficialSkillDownloads({ folder, skills, removedSkills, busy, pendingInstallId, installFailure, onChooseFolder, onInstall, onRestore }: {
  folder: string;
  skills: LocalSkill[];
  removedSkills: LocalSkill[];
  busy: boolean;
  pendingInstallId?: string;
  installFailure?: OfficialSkillInstallFailure | null;
  onChooseFolder: () => void;
  onInstall: (id: string, folder: string) => Promise<string>;
  onRestore: (path: string) => Promise<boolean>;
}) {
  const [catalog, setCatalog] = useState<OfficialSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState("");
  // Install, restore and source failures belong to one card, so the message
  // sits beside the control that can retry it.
  const [installError, setInstallError] = useState<{ id: string; message: string } | null>(null);
  const scope = useRef({ folder, version: 0, mounted: false });
  // Update during render so a completion arriving before effects cannot land
  // in a newly selected folder's catalog.
  if (scope.current.folder !== folder) {
    scope.current.folder = folder;
    scope.current.version += 1;
  }
  useEffect(() => {
    const current = scope.current;
    current.mounted = true;
    return () => { current.mounted = false; current.version += 1; };
  }, []);
  useEffect(() => {
    setInstalling("");
    setInstallError(null);
  }, [folder]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setCatalogError("");
    void officialSkillsCatalog().then((entries) => {
      if (active) setCatalog(entries);
    }).catch((reason) => {
      if (active) setCatalogError(friendlyError(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.filter((entry) => `${entry.title} ${entry.description} ${entry.publisher} ${entry.notes} ${entry.requirements ?? ""}`.toLowerCase().includes(needle));
  }, [catalog, query]);
  // Derived from the live scan: a card is installed only while a healthy,
  // unmodified copy of its package is in the selected folder.
  const states = useMemo(() => new Map(catalog.map((entry) => {
    const installed = skills.some((skill) => skill.source?.catalogId === entry.id && !skill.source.modified);
    const modified = [...skills, ...removedSkills].some((skill) => skill.source?.catalogId === entry.id && skill.source.modified);
    const removed = removedSkills.find((skill) => skill.source?.catalogId === entry.id);
    return [entry.id, { installed, modified, removed }];
  })), [catalog, skills, removedSkills]);
  const installedCount = catalog.filter((entry) => states.get(entry.id)?.installed).length;
  const install = async (id: string) => {
    if (!folder || installing || busy) return;
    const version = scope.current.version;
    const current = () => scope.current.mounted && scope.current.version === version;
    setInstalling(id);
    setInstallError(null);
    try {
      await onInstall(id, folder);
    } catch (reason) {
      if (current() && installFailure === undefined) setInstallError({ id, message: friendlyError(reason) });
    } finally {
      if (current()) setInstalling("");
    }
  };
  const restore = async (id: string, path: string) => {
    if (busy || installing) return;
    const version = scope.current.version;
    setInstalling(path);
    setInstallError(null);
    try {
      if (!await onRestore(path) && scope.current.mounted && scope.current.version === version) {
        setInstallError({ id, message: "Could not restore this skill. Rescan your folder and try again." });
      }
    } catch (reason) {
      if (scope.current.mounted && scope.current.version === version) setInstallError({ id, message: friendlyError(reason) });
    } finally {
      if (scope.current.mounted && scope.current.version === version) setInstalling("");
    }
  };
  const openSource = async (entry: OfficialSkill) => {
    const version = scope.current.version;
    try {
      await openUrl(`https://github.com/${entry.repository}/tree/${entry.revision}/${entry.path}`);
    } catch (reason) {
      if (scope.current.mounted && scope.current.version === version) setInstallError({ id: entry.id, message: friendlyError(reason) });
    }
  };
  return <div className="official-skill-downloads">
    <p className="official-skill-intro">Pinned packages from public Anthropic and OpenAI repositories, installed complete into your skills folder. Tags show the distributing repository; notes name any third-party author and what a skill needs.</p>
    {!folder && <div className="official-skill-folder-notice">
      <FolderOpen size={14} aria-hidden="true" />
      <span>Choose a skills folder before installing.</span>
      <button className="secondary-button" type="button" onClick={onChooseFolder}>Choose folder to install skills</button>
    </div>}
    {loading ? <p className="official-skill-placeholder" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> Loading available skills…</p> : catalogError ? <div className="official-skill-catalog-error">
      <p className="skill-library-alert" role="alert">{catalogError}</p>
      <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}><RotateCcw size={12} aria-hidden="true" /> Retry skill catalog</button>
    </div> : <>
      <div className="official-skill-toolbar">
        <div className="skill-search">
          <Search size={14} aria-hidden="true" />
          <input aria-label="Search downloadable skills" placeholder="Search Anthropic and OpenAI skills" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear downloadable skill search"><X size={13} /></button>}
        </div>
        {catalog.length > 0 && <span className="official-skill-count">{query.trim() ? `${filtered.length} of ${catalog.length} shown` : `${installedCount} of ${catalog.length} in your folder`}</span>}
      </div>
      <ul className="official-skill-list" aria-label="Downloadable skills">
        {filtered.map((entry) => {
          const { installed = false, modified = false, removed } = states.get(entry.id) ?? {};
          const pending = pendingInstallId === entry.id || installing === entry.id || (removed !== undefined && installing === removed.path);
          const state: CardState = pending ? "installing" : installed ? "installed" : modified ? "modified" : removed ? "removed" : "available";
          const publisher = skillPublisherLabel(entry.publisher);
          const error = installError?.id === entry.id ? installError.message : installFailure?.id === entry.id ? installFailure.message : "";
          return <li key={entry.id} className="official-skill-card" data-state={state} aria-busy={pending || undefined}>
            <div className="official-skill-head">
              <strong>{entry.title}</strong>
              <span className="official-skill-head-meta">
                {entry.requirements?.trim() && <InfoPopover className="official-skill-requirements" triggerClassName="official-skill-requirements-trigger"
                  label={`Requirements for ${entry.title}`} trigger={<Info size={13} aria-hidden="true" />}>
                  <p className="official-skill-requirements-title">Requirements</p>
                  <p className="official-skill-requirements-text">{entry.requirements}</p>
                  <dl className="official-skill-requirements-kinds">
                    <div><dt>Tools</dt><dd>Installing adds only this skill’s files, not its tools. When you use it, the model can install the tools it needs if your permission settings allow.</dd></div>
                    <div><dt>Accounts</dt><dd>Sign-ins, API keys and other credentials are never set up for you. Connect them yourself.</dd></div>
                  </dl>
                </InfoPopover>}
                <span className={`skill-publisher-tag ${entry.publisher}`} title={`Distributed in ${publisher}'s public repository ${entry.repository}`}>{publisher}</span>
              </span>
            </div>
            <p className="official-skill-description">{entry.description}</p>
            {entry.notes && <p className="official-skill-note">{entry.notes}</p>}
            {modified && !installed && <p className="official-skill-note" data-tone="caution">Modified locally. Installing an original copy keeps your existing files and turns the modified skill off.</p>}
            {error && <p className="skill-library-alert official-skill-error" role="alert">{error}</p>}
            <div className="official-skill-footer">
              <span className="official-skill-provenance">
                <button type="button" className="official-skill-source" onClick={() => void openSource(entry)} aria-label={`${entry.repository} source for ${entry.title}`} title={`Open the pinned source on GitHub (${entry.revision.slice(0, 12)})`}>
                  <span>{entry.repository}</span><ArrowUpRight size={12} aria-hidden="true" />
                </button>
                <span className="official-skill-license" title="License">{entry.license}</span>
              </span>
              {installed ? <span className="official-skill-installed" role="status"><Check size={13} aria-hidden="true" />Installed</span>
                : removed && !modified ? <button type="button" className="secondary-button official-skill-action" disabled={busy || Boolean(installing)} onClick={() => void restore(entry.id, removed.path)}>
                  {pending ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />} Restore skill
                </button>
                : <button type="button" className="secondary-button official-skill-action" disabled={!folder || busy || Boolean(installing)} onClick={() => void install(entry.id)}
                  aria-label={pending ? `Installing ${entry.title}` : modified ? `Install original copy of ${entry.title}` : `Install ${entry.title}`}>
                  {pending ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : <Download size={12} aria-hidden="true" />} {pending ? "Installing…" : modified ? "Install original copy" : "Install"}
                </button>}
            </div>
          </li>;
        })}
      </ul>
      {!filtered.length && <p className="official-skill-placeholder" role="status">{query ? "No downloadable skills match your search." : "No downloadable skills are available."}</p>}
    </>}
  </div>;
}
