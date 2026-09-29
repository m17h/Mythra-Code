import { memo, useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { SkillDependencyReport } from "../types";
import { hasBlockedSkillDependencies } from "../lib/skillDependencies";
import "./skill-dependencies.css";

export const SkillDependencyNotice = memo(function SkillDependencyNotice({ report, error = "" }: {
  report?: SkillDependencyReport | null; error?: string;
}) {
  const blocked = Boolean(report && hasBlockedSkillDependencies(report));
  const signature = error || (blocked ? JSON.stringify(report?.issues.map(({ code, message, rootName, chain, reference }) => ({ code, message, rootName, chain, reference }))) : "");
  const prior = useRef("");
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!report && !error) { setAnnouncement(""); return; }
    if (signature === prior.current) return;
    const previouslyBlocked = Boolean(prior.current);
    prior.current = signature;
    setAnnouncement(error ? `Skill dependency preview unavailable: ${error}` : blocked && report
      ? `Turn blocked by skill dependencies. ${report.issues.slice(0, 3).map((issue) => {
        const reason = `${issue.message} ${issue.chain.join(" to ")}`;
        return reason.length > 200 ? `${reason.slice(0, 197)}…` : reason;
      }).join(". ")}${report.issues.length > 3 ? `. ${report.issues.length - 3} more errors; inspect the dependency notice.` : ""}`
      : previouslyBlocked ? "Skill dependencies ready." : "");
  }, [signature, report, error, blocked]);
  return <>
    {announcement && <span className="skill-dependency-announcement" role="alert" aria-atomic="true">{announcement}</span>}
    {(error || blocked) ? <div className="skill-dependency-notice" tabIndex={0} role="region" aria-label="Skill dependency errors">
      <AlertTriangle size={14} aria-hidden="true" />
      <div><strong>{error ? "Skill dependency preview unavailable" : "Turn blocked by skill dependencies"}</strong>
        <p>{error || "Fix every reference below before sending. No partial skill context will be sent."}</p>
        {report?.issues.some((issue) => issue.code === "unsupported-document") && <p>Only UTF-8 .md, .markdown, and .txt reference documents can be included by this dependency loader. Convert unsupported files to text; PDF or Word extraction is not available. Ordinary attachments are separate.</p>}
        {report?.issues.map((issue, index) => <div className="skill-dependency-issue" key={`${issue.code}:${index}`}>
          {issue.reference && <code>{issue.reference}</code>}<span>{issue.message}</span>
          {issue.chain.length > 0 && <small>{issue.chain.join(" → ")}</small>}
        </div>)}
      </div>
    </div> : null}
  </>;
});
