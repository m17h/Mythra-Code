export interface SkillMentionSkill {
  name: string;
  path?: string;
  enabled?: boolean;
  description?: string;
}

export interface SkillMentionRange<T extends SkillMentionSkill = SkillMentionSkill> {
  /** UTF-16 offsets, matching String.slice and textarea selection positions. */
  start: number;
  end: number;
  skill: T;
}

const WHITESPACE = /\p{White_Space}/u;
const ALPHANUMERIC = /[\p{Alphabetic}\p{Number}]/u;
const ASCII_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const ASCII_NAME_CHARACTER = /^[a-z0-9-]$/i;

function mentionEndsAt(text: string, end: number): boolean {
  const nextCodePoint = text.codePointAt(end);
  const next = nextCodePoint === undefined ? undefined : String.fromCodePoint(nextCodePoint);
  return next === undefined || WHITESPACE.test(next)
    || (next !== "." && !ALPHANUMERIC.test(next) && !["_", "/", "\\", "-"].includes(next))
    || (next === "." && (end + 1 === text.length || WHITESPACE.test(text[end + 1])));
}

/** Keep these boundaries aligned with skills.rs::skill_mention_names. */
export function skillMentionRanges<T extends SkillMentionSkill>(
  text: string,
  skills: readonly T[],
): SkillMentionRange<T>[] {
  const available = new Map<string, T>();
  for (const skill of skills) {
    if (skill.enabled !== false && ASCII_NAME.test(skill.name)) {
      available.set(skill.name.toLowerCase(), skill);
    }
  }
  if (!available.size) return [];
  const ranges: SkillMentionRange<T>[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "@" || (index > 0 && !WHITESPACE.test(text[index - 1]))) {
      index += 1;
      continue;
    }
    const start = index + 1;
    let end = start;
    while (end < text.length && ASCII_NAME_CHARACTER.test(text[end])) end += 1;
    const name = text.slice(start, end);
    const skill = available.get(name.toLowerCase());
    if (ASCII_NAME.test(name) && mentionEndsAt(text, end) && skill) ranges.push({ start: index, end, skill });
    index = Math.max(end, index + 1);
  }
  return ranges;
}

export interface SkillMentionQuery { start: number; end: number; query: string }

/** Partial local skill name at the caret; files and email addresses are excluded. */
export function skillMentionQuery(text: string, caret: number): SkillMentionQuery | null {
  // Completion replaces only the authored prefix before the native caret.
  // Never split an existing name, file path, extension, or Unicode word.
  if (!Number.isSafeInteger(caret) || caret < 0 || caret > text.length || !mentionEndsAt(text, caret)) return null;
  const before = text.slice(0, caret);
  const match = /@([a-z0-9-]*)$/i.exec(before);
  if (!match || (match.index > 0 && !WHITESPACE.test(before[match.index - 1]))) return null;
  if (match[1].length > 64 || (match[1] && !/^[a-z0-9]/i.test(match[1]))) return null;
  return { start: match.index, end: caret, query: match[1] };
}

export function skillMentionSuggestions<T extends SkillMentionSkill>(skills: readonly T[], query: string): T[] {
  const normalized = query.toLowerCase();
  return skills.filter((skill) => skill.enabled !== false && ASCII_NAME.test(skill.name)
    && (!normalized || skill.name.toLowerCase().includes(normalized)
      || skill.description?.toLowerCase().includes(normalized)))
    .sort((left, right) => Number(right.name.toLowerCase().startsWith(normalized))
      - Number(left.name.toLowerCase().startsWith(normalized)) || left.name.localeCompare(right.name))
    .slice(0, 8);
}
