import { memo, useMemo } from "react";
import { Boxes, FileText } from "lucide-react";
import type { SkillDependencyReport } from "../types";
import type { SkillMentionSkill } from "../lib/skillMentions";
import { hasBlockedSkillDependencies, isSkillDependencyPath, validSkillDependencyReport } from "../lib/skillDependencies";
import "./skill-dependencies.css";

/** Reverse reachability colors a root when any of its descendants is blocked. */
export function blockedDependencyIds(report?: SkillDependencyReport | null): Set<string> {
  const blocked = new Set(report?.nodes.filter((node) => node.status === "blocked").map((node) => node.id));
  if (!report) return blocked;
  for (const issue of report.issues) {
    for (const root of report.roots) {
      if ((!issue.rootName && !issue.chain.length) || issue.rootName === root.name || issue.chain[0] === root.name || issue.chain[0] === `@${root.name}`) blocked.add(root.nodeId);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of report.edges) if (blocked.has(edge.to) && !blocked.has(edge.from)) {
      blocked.add(edge.from);
      changed = true;
    }
  }
  return blocked;
}

export function blockedSkillNames(report?: SkillDependencyReport | null): Set<string> {
  const ids = blockedDependencyIds(report);
  const names = new Set(report?.nodes.filter((node) => node.kind === "skill" && ids.has(node.id)).map((node) => node.name.toLowerCase()));
  for (const root of report?.roots ?? []) if (ids.has(root.nodeId)) names.add(root.name.toLowerCase());
  // A report-limit diagnostic intentionally drops the graph to bound metadata.
  // Its named root still identifies the authored token that must turn red.
  for (const issue of report?.issues ?? []) {
    const name = issue.rootName?.match(/^@?([a-z0-9][a-z0-9-]{0,63})$/i)?.[1]
      ?? issue.chain[0]?.match(/^@([a-z0-9][a-z0-9-]{0,63})$/i)?.[1];
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

export const SkillDependencyDetails = memo(function SkillDependencyDetails({ report: rawReport, skills = [], onOpenSkill, label = "Skill context", mode = "preview" }: {
  report?: SkillDependencyReport | null;
  skills?: readonly SkillMentionSkill[];
  onOpenSkill?: (path: string) => void;
  label?: string;
  mode?: "preview" | "history";
}) {
  const report = useMemo(() => validSkillDependencyReport(rawReport), [rawReport]);
  const blocked = useMemo(() => blockedDependencyIds(report), [report]);
  const available = useMemo(() => new Set(skills.map((skill) => skill.path).filter(Boolean)), [skills]);
  const nodes = useMemo(() => new Map(report?.nodes.map((node) => [node.id, node])), [report]);
  if (!report || (!report.nodes.length && !report.issues.length)) return null;
  const turnBlocked = hasBlockedSkillDependencies(report);
  const skillCount = report.nodes.filter((node) => node.kind === "skill").length;
  const documentCount = report.nodes.filter((node) => node.kind === "document").length;
  const nodeLabel = (id: string) => {
    const node = nodes.get(id);
    return node ? `${node.kind === "skill" ? "@" : ""}${node.name}` : id;
  };
  return <details className={`skill-dependency-details${turnBlocked ? " is-blocked" : ""}`}>
    <summary>{label} · {skillCount} skill{skillCount === 1 ? "" : "s"}{documentCount > 0 && ` · ${documentCount} document${documentCount === 1 ? "" : "s"}`}{turnBlocked && " · blocked"}</summary>
    <div className="skill-dependency-detail-body" tabIndex={0} role="region" aria-label="Skill dependency graph">
      <p className="skill-dependency-roots">{report.roots.map((root, index) => <span key={`${root.channel}:${root.nodeId}:${index}`} className={blocked.has(root.nodeId) ? "is-blocked" : undefined}>{root.channel === "system" ? "System" : "Message"}: @{root.name}</span>)}</p>
      <ul className="skill-dependency-nodes">
        {report.nodes.map((node) => <li key={node.id} className={blocked.has(node.id) ? "is-blocked" : undefined}>
          {node.kind === "skill" ? <Boxes size={12} aria-hidden="true" /> : <FileText size={12} aria-hidden="true" />}
          <div>{node.kind === "skill" && onOpenSkill && isSkillDependencyPath(node.path) && available.has(node.path)
            ? <a href="#skills" onClick={(event) => { event.preventDefault(); onOpenSkill(node.path); }} title={`Open @${node.name} in Settings · Skills`}>@{node.name}</a>
            : <strong>{node.kind === "skill" ? "@" : ""}{node.name}</strong>}
            <code>{node.path}</code>
            <small>{node.status === "blocked" ? "Blocked" : turnBlocked ? "Prepared, not sent" : mode === "history" ? "Included" : "Ready to include"} · {node.characterCount.toLocaleString()} characters · depth {node.depth}</small>
          </div>
        </li>)}
      </ul>
      {report.edges.length > 0 && <ul className="skill-dependency-edges" aria-label="Nested references">
        {report.edges.map((edge, index) => <li key={`${edge.from}:${edge.to}:${index}`} className={blocked.has(edge.to) ? "is-blocked" : undefined}>
          <span>{nodeLabel(edge.from)} → {nodeLabel(edge.to)}</span><code>{edge.reference}</code>
        </li>)}
      </ul>}
      {report.issues.length > 0 && <ul className="skill-dependency-issues">
        {report.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>
          {issue.reference && <code>{issue.reference}</code>}<span>{issue.message}</span>
          {issue.chain.length > 0 && <small>{issue.chain.join(" → ")}</small>}
          {issue.sourcePath && <code>{issue.sourcePath}</code>}
        </li>)}
      </ul>}
    </div>
  </details>;
});
