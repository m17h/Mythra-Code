import { useEffect, useState } from "react";
import type { SkillDependencyReport } from "../types";
import { friendlyError } from "../lib/errors";

export type AnalyzeSkillDependencies = (text: string) => Promise<SkillDependencyReport>;

/** Preview only: delivery resolves again. Superseded/closed previews cannot publish. */
export function useSkillDependencyPreview(text: string, analyze?: AnalyzeSkillDependencies, scope = "") {
  const [result, setResult] = useState<{
    text: string; analyze: AnalyzeSkillDependencies; scope: string;
    report: SkillDependencyReport | null; error: string;
  } | null>(null);
  useEffect(() => {
    if (!analyze) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve().then(() => analyze(text)).then(
        (report) => { if (current) setResult({ text, analyze, scope, report, error: "" }); },
        (reason) => { if (current) setResult({ text, analyze, scope, report: null, error: friendlyError(reason) }); },
      );
    }, 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [text, analyze, scope]);
  return result?.text === text && result.analyze === analyze && result.scope === scope
    ? { report: result.report, error: result.error }
    : { report: null, error: "" };
}
