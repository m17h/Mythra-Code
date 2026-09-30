import type { SkillReference } from "../types";
import { skillMentionRanges } from "./skillMentions";
import type { LocalSkill } from "./skills";

export function captureSkillReferences(text: string, skills: readonly LocalSkill[]): SkillReference[] {
  return skillMentionRanges(text, skills).map(({ start, end, skill }) => ({ start, end, name: skill.name, path: skill.path }));
}

/** Treat persisted metadata as data, and never turn a mismatched offset into a link. */
export function validSkillReferences(text: string, references: unknown): SkillReference[] {
  if (!Array.isArray(references)) return [];
  let previousEnd = 0;
  const candidates = references.filter((reference): reference is SkillReference => {
    if (!reference || typeof reference !== "object" || !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end)
      || reference.start < previousEnd || reference.end > text.length || reference.end <= reference.start
      || typeof reference.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(reference.name)
      || typeof reference.path !== "string" || !reference.path.trim() || reference.path.includes("\0")
      || text.slice(reference.start, reference.end).toLowerCase() !== `@${reference.name.toLowerCase()}`) return false;
    previousEnd = reference.end;
    return true;
  });
  const recognized = new Set(skillMentionRanges(text, candidates).map(({ start, end }) => `${start}:${end}`));
  return candidates.filter((reference) => recognized.has(`${reference.start}:${reference.end}`));
}
