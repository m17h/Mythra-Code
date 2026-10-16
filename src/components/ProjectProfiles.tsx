import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { Copy, Download, FolderCog, Upload } from "lucide-react";
import type { Project, ProjectOverrides } from "../types";
import { exportTextFile } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { providerDisplayName } from "../lib/childAgents";
import {
  applyProjectProfile,
  exportProjectProfile,
  importProjectProfile,
  pickProjectProfile,
  PROJECT_PROFILE_COMMAND_PARTS,
  PROJECT_PROFILE_PARTS,
  projectProfileParts,
  type ProjectProfilePart,
} from "../lib/projectProfiles";
import { AppSelectMenu } from "./AppSelectMenu";
import "./ProjectProfiles.css";

interface PendingProfile {
  /** Where the settings came from, for the review heading. */
  sourceLabel: string;
  sourceProjectId?: string;
  fromFile: boolean;
  settings: ProjectOverrides;
  parts: ProjectProfilePart[];
  selected: Set<ProjectProfilePart>;
  targetId: string;
  dropped: ProjectProfilePart[];
}

function partSummary(part: ProjectProfilePart, overrides: ProjectOverrides): string {
  switch (part) {
    case "defaults": {
      const defaults = overrides.defaults;
      if (!defaults) return "";
      const look = [defaults.theme && "theme", defaults.effortSlider && "effort slider", defaults.chatFont && "chat font"].filter(Boolean);
      return `${providerDisplayName(defaults.provider)} · ${defaults.model}${look.length ? ` · own ${look.join(", ")}` : ""}`;
    }
    case "instructions": {
      const length = overrides.systemPrompt?.trim().length ?? 0;
      const saved = overrides.systemPromptProfiles?.length ?? 0;
      const text = length
        ? `${length.toLocaleString()} characters, ${overrides.systemPromptMode === "append" ? "added after" : "replacing"} your app instructions`
        : "No active text";
      return saved ? `${text} · ${saved} saved ${saved === 1 ? "version" : "versions"}` : text;
    }
    case "run": {
      const run = overrides.run;
      if (!run) return "";
      return run.setupCommand ? `${run.setupCommand} && ${run.command}` : run.command;
    }
    case "check":
      return overrides.check?.command ?? "";
    case "subagents": {
      const subagents = overrides.subagents;
      if (!subagents) return "";
      return subagents.enabled ? `On · up to ${subagents.maxConcurrent} at once` : "Off for this project";
    }
  }
}

const PART_LABEL = new Map(PROJECT_PROFILE_PARTS.map((part) => [part.id, part.label]));

/**
 * Settings → Projects → Project profiles. Every project that differs from the
 * app defaults, what it changes, and ways to reuse that: copy it to another
 * project or export it as a file someone else can import. Edits go into the
 * Settings draft like the rest of the pane, so Save and Cancel still apply.
 */
export function ProjectProfiles({ projects, onProjects, onAppliedToActive, activeProjectId }: {
  projects: Project[];
  activeProjectId: string | null;
  onProjects: (projects: Project[]) => void;
  /** Called after the open project's look may have changed, to refresh previews. */
  onAppliedToActive: (project: Project) => void;
}) {
  const [pending, setPending] = useState<PendingProfile | null>(null);
  const [status, setStatus] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const eligible = projects.filter((project) => !project.isChat);
  const customized = eligible.filter((project) => projectProfileParts(project.overrides).length > 0);

  const startCopy = (project: Project) => {
    const parts = projectProfileParts(project.overrides);
    const settings = pickProjectProfile(project.overrides, parts);
    setStatus("");
    setPending({
      sourceLabel: project.name,
      sourceProjectId: project.id,
      fromFile: false,
      settings,
      parts,
      selected: new Set(parts),
      targetId: "",
      dropped: [],
    });
  };

  const exportProfile = async (project: Project) => {
    try {
      const contents = exportProjectProfile(project, projectProfileParts(project.overrides));
      const fileName = `${project.name.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").slice(0, 60) || "project"}.mythra-project.json`;
      const path = await save({ title: "Export project profile", defaultPath: await join(await downloadDir(), fileName), filters: [{ name: "Project profile", extensions: ["json"] }] });
      if (!path) return;
      await exportTextFile(path, contents);
      setStatus(`Exported ${project.name}. The file includes its instructions and any Run or Check commands, but not the folder path, threads or account details.`);
    } catch (error) {
      setStatus(friendlyError(error).replace(/Diagnostics/g, "Project profiles"));
    }
  };

  const importFile = async (file: File) => {
    try {
      const imported = importProjectProfile(await file.text());
      const parts = projectProfileParts(imported.settings);
      setStatus("");
      setPending({
        sourceLabel: imported.name,
        fromFile: true,
        settings: imported.settings,
        parts,
        // Commands from a file run on this computer when clicked, so they are
        // left for the person to tick after reading them.
        selected: new Set(parts.filter((part) => !PROJECT_PROFILE_COMMAND_PARTS.has(part))),
        targetId: "",
        dropped: imported.dropped,
      });
    } catch (error) {
      setPending(null);
      setStatus(error instanceof Error ? error.message : "This file is not a valid project profile.");
    }
  };

  const apply = () => {
    if (!pending) return;
    const target = projects.find((project) => project.id === pending.targetId);
    if (!target || !pending.selected.size) return;
    const chosen = PROJECT_PROFILE_PARTS.map((part) => part.id).filter((part) => pending.selected.has(part));
    const next = applyProjectProfile(target, pending.settings, chosen);
    onProjects(projects.map((project) => project.id === target.id ? next : project));
    if (target.id === activeProjectId) onAppliedToActive(next);
    setStatus(`Applied to ${target.name}. Save Settings to keep it.`);
    setPending(null);
  };

  const targetOptions = eligible
    .filter((project) => project.id !== pending?.sourceProjectId)
    .map((project) => ({
      value: project.id,
      label: project.name,
      detail: projectProfileParts(project.overrides).length ? `${project.path} · has its own settings` : project.path,
      icon: <FolderCog size={14} />,
    }));
  const target = pending ? projects.find((project) => project.id === pending.targetId) : undefined;
  const targetParts = new Set(projectProfileParts(target?.overrides));
  const replacing = pending ? [...pending.selected].filter((part) => targetParts.has(part)) : [];

  return (
    <div className="set-group project-profiles">
      <div className="set-group-head">
        <h4>Project profiles</h4>
        <button type="button" className="secondary-button compact" disabled={!eligible.length} onClick={() => fileRef.current?.click()}><Upload size={12} /> Import…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="Import project profile" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }} />
      </div>
      <p>What each project changes from the app defaults, in one place. Copy a project&rsquo;s settings to another project, or export them as a file to share.</p>

      {customized.length ? <div className="set-card project-profile-list">
        {customized.map((project) => {
          const parts = projectProfileParts(project.overrides);
          return <div className="set-row project-profile-row" key={project.id}>
            <div className="set-copy">
              <strong>{project.name}</strong>
              <small className="project-profile-path">{project.path}</small>
              <span className="project-profile-chips" aria-label="Differs from app defaults">
                {parts.map((part) => <span key={part} className="project-profile-chip" title={partSummary(part, project.overrides!)}>{PART_LABEL.get(part)}</span>)}
              </span>
            </div>
            <div className="set-control project-profile-actions">
              <button type="button" className="secondary-button compact" disabled={eligible.length < 2} title={eligible.length < 2 ? "Add another project first" : undefined} onClick={() => startCopy(project)}><Copy size={12} /> Copy to…</button>
              <button type="button" className="secondary-button compact" onClick={() => void exportProfile(project)}><Download size={12} /> Export</button>
            </div>
          </div>;
        })}
      </div> : <div className="project-default-empty"><FolderCog size={18} /><span><strong>Every project uses the app defaults</strong><small>Projects show up here once they have their own provider, instructions, Run or Check command, or sub-agent settings.</small></span></div>}

      {pending && <div className="set-card project-profile-review" role="group" aria-label="Apply project profile">
        <div className="project-profile-review-head">
          <strong>Apply {pending.fromFile ? "profile" : "settings from"} &ldquo;{pending.sourceLabel}&rdquo;</strong>
          <small>Each ticked part replaces the target&rsquo;s own. Everything else on the target stays as it is.</small>
        </div>
        <div className="project-default-field">
          <span>Apply to</span>
          <AppSelectMenu value={pending.targetId} options={targetOptions} ariaLabel="Project to apply the profile to" placeholder="Choose a project…" searchable={targetOptions.length > 8} emptyMessage="There is no other project to apply this to." onChange={(targetId) => setPending({ ...pending, targetId })} />
        </div>
        <ul className="project-profile-parts">
          {pending.parts.map((part) => {
            const command = PROJECT_PROFILE_COMMAND_PARTS.has(part);
            const summary = partSummary(part, pending.settings);
            return <li key={part}>
              <label>
                <input type="checkbox" checked={pending.selected.has(part)} onChange={(event) => {
                  const selected = new Set(pending.selected);
                  if (event.target.checked) selected.add(part); else selected.delete(part);
                  setPending({ ...pending, selected });
                }} />
                <span>
                  <strong>{PART_LABEL.get(part)}</strong>
                  {command ? <code>{summary}</code> : <small>{summary}</small>}
                  {command && pending.fromFile && <small className="project-profile-caution">Runs on this computer, in the project folder, when you click {part === "run" ? "Run" : "Check"}. Tick it only if you trust this command.</small>}
                </span>
              </label>
            </li>;
          })}
        </ul>
        {pending.dropped.length > 0 && <p className="project-profile-note">Left out because they were not valid: {pending.dropped.map((part) => PART_LABEL.get(part)).join(", ")}.</p>}
        {replacing.length > 0 && <p className="project-profile-note">Replaces {target?.name}&rsquo;s {replacing.map((part) => PART_LABEL.get(part)!.toLowerCase()).join(", ")}.</p>}
        <div className="project-profile-review-actions">
          <button type="button" className="secondary-button compact" onClick={() => setPending(null)}>Cancel</button>
          <button type="button" className="primary-button compact" disabled={!pending.targetId || !pending.selected.size} onClick={apply}>Apply</button>
        </div>
      </div>}

      {status && <p className="project-profile-status" role="status">{status}</p>}
    </div>
  );
}
