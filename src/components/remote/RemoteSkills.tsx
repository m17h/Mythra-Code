import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, LoaderCircle, Lock, X } from "lucide-react";
import type { SkillDependencyReport } from "../../types";
import type { LocalSkill } from "../../lib/skills";
import type { WireHostSkill } from "../../lib/remote/wire";
import { hostRead, hostRows } from "../../lib/remote/remoteActions";
import { skillMentionRanges } from "../../lib/skillMentions";
import { validSkillDependencyReport } from "../../lib/skillDependencies";
import { SkillPromptEditor } from "../SkillPromptEditor";
import { SkillDependencyNotice } from "../SkillDependencyNotice";
import { SkillDependencyDetails } from "../SkillDependencyDetails";
import "../SettingsModal.legacy.css";
import "../SkillLibrary.navigation.css";

/** A host skill is named, never located: this id is not a path on either machine. */
const HOST_SKILL = "host-skill:";
export const hostSkillId = (name: string) => `${HOST_SKILL}${name}`;
export const hostSkillName = (id: string) => id.startsWith(HOST_SKILL) ? id.slice(HOST_SKILL.length) : null;

/** The host's skills in the shape the timeline's skill links read. */
export function hostSkillLinks(skills: readonly WireHostSkill[] | undefined): LocalSkill[] {
  return (skills ?? []).map((skill) => ({
    name: skill.name, enabled: skill.enabled !== false, description: skill.description ?? "",
    path: hostSkillId(skill.name), relativePath: "", fileName: "SKILL.md", defaultName: skill.name, supportingMarkdownCount: 0,
  }));
}

const EMPTY_REPORT: SkillDependencyReport = Object.freeze({
  version: 1, limits: { maxDepth: 4, maxSkills: 8, maxFiles: 24, maxCharacters: 120000, maxFileBytes: 1048576 },
  roots: [], nodes: [], edges: [], issues: [],
}) as SkillDependencyReport;

/** The composer's skill inspector, answered by the host. A draft with no host
 * skill in it has nothing to check, so it never asks. */
export function useRemoteSkillAnalyzer(device: string, name: string, target: { workspaceId?: string; threadId?: string }, skills: readonly WireHostSkill[] | undefined) {
  const known = useMemo(() => (skills ?? []).map((skill) => ({ name: skill.name })), [skills]);
  const { workspaceId, threadId } = target;
  return useCallback(async (text: string): Promise<SkillDependencyReport> => {
    if (!workspaceId || !skillMentionRanges(text, known).length) return EMPTY_REPORT;
    const result = await hostRead<{ report?: unknown; rows?: unknown[] }>(device, "skills.analyze", { workspaceId, ...(threadId ? { threadId } : {}), query: text });
    const report = validSkillDependencyReport(result?.report);
    if (!report) throw new Error(`Skill details from ${name} aren't available.`);
    return report;
  }, [device, known, name, threadId, workspaceId]);
}

/** The same skill dialog as Settings → Skills, showing the host's copy. It is
 * read-only here: the skill lives on the other machine and is changed there. */
export function RemoteSkillViewer({ device, name, skillName, target, skills, onClose }: {
  device: string;
  name: string;
  skillName: string;
  target: { workspaceId?: string; threadId?: string };
  skills: readonly WireHostSkill[] | undefined;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [state, setState] = useState<{ text: string | null; error: string; loading: boolean }>({ text: null, error: "", loading: true });
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const skill = skills?.find((entry) => entry.name === skillName);
  const { workspaceId, threadId } = target;
  useEffect(() => {
    let current = true;
    setState({ text: null, error: "", loading: true });
    if (!workspaceId) { setState({ text: null, error: `Choose a workspace on ${name} first.`, loading: false }); return; }
    hostRead(device, "skills.read", { workspaceId, ...(threadId ? { threadId } : {}), skillId: skillName }).then((result) => {
      if (!current) return;
      const text = hostRows(result as never)[0]?.text;
      setState(typeof text === "string" ? { text, error: "", loading: false } : { text: null, error: `${name} didn't share @${skillName}.`, loading: false });
    }, () => { if (current) setState({ text: null, error: `Mythra Code couldn't read @${skillName} on ${name}. Try again.`, loading: false }); });
    return () => { current = false; };
  }, [attempt, device, name, skillName, threadId, workspaceId]);
  useEffect(() => { dialogRef.current?.querySelector<HTMLElement>("[data-autofocus], button")?.focus(); }, [state.loading]);
  const analyze = useRemoteSkillAnalyzer(device, name, target, skills);
  const mentionSkills = useMemo(() => (skills ?? []).map((entry) => ({ name: entry.name, enabled: entry.enabled !== false, description: entry.description ?? "" })), [skills]);
  const [preview, setPreview] = useState<{ report: SkillDependencyReport | null; error: string }>({ report: null, error: "" });
  useEffect(() => {
    let current = true;
    setPreview({ report: null, error: "" });
    if (state.text === null) return;
    analyze(`@${skillName}`).then((report) => { if (current) setPreview({ report, error: "" }); },
      (reason: unknown) => { if (current) setPreview({ report: null, error: reason instanceof Error ? reason.message : String(reason) }); });
    return () => { current = false; };
  }, [analyze, skillName, state.text]);
  return createPortal(<div className="skill-editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="skill-editor-dialog is-read-only" role="dialog" aria-modal="true" aria-labelledby={`${fieldId}-title`} aria-describedby={`${fieldId}-description`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="skill-editor-head">
        <span className="skill-create-icon"><Eye size={15} aria-hidden="true" /></span>
        <span>
          <strong id={`${fieldId}-title`}>View @{skillName}</strong>
          <small id={`${fieldId}-description`}>{skill ? `${skill.description ? `${skill.description} · ` : ""}` : ""}The skill on {name} · read-only here. Edit it in Settings → Skills on {name}.</small>
        </span>
        <button type="button" onClick={onClose} aria-label="Close skill editor"><X size={15} /></button>
      </div>
      {state.loading ? <div className="skill-editor-loading"><LoaderCircle className="spin" size={18} aria-hidden="true" /> Loading skill Markdown from {name}…</div>
        : state.text !== null ? <label className="skill-editor-field">
          <span className="skill-editor-field-label">Skill Markdown<span className="skill-editor-read-only"><Lock size={11} aria-hidden="true" /> Read-only</span></span>
          <SkillPromptEditor data-autofocus value={state.text} readOnly onChange={() => undefined} spellCheck={false}
            aria-label={`Markdown for ${skillName} on ${name}`} skills={mentionSkills} dependencyReport={preview.report} showDependencyNotice={false} />
        </label> : null}
      {state.text !== null && <SkillDependencyNotice report={preview.report} error={preview.error} />}
      {state.text !== null && <SkillDependencyDetails report={preview.report} label="Skill dependencies" />}
      {skills && !skill && <p className="skill-create-error" role="alert">@{skillName} is no longer in the skills library on {name}.</p>}
      {state.error && <p className="skill-create-error" role="alert">{state.error}</p>}
      <div className="skill-editor-actions">
        {!state.loading && state.text === null && <button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
        <span>{state.text !== null ? `${state.text.length.toLocaleString()} characters · on ${name}` : ""}</span>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>, document.querySelector(".app-shell") ?? document.body);
}
