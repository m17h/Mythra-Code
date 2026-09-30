import type { ElementContent } from "hast";
import type { Nodes, Root, RootContent } from "mdast";
import type { LocalSkill } from "./skills";
import type { SkillReference } from "../types";
import { skillMentionRanges } from "./skillMentions";
import { validSkillReferences } from "./skillReferences";
import { decodeHtmlEntities } from "./text";

function markdownText(value: string): string {
  return decodeHtmlEntities(value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1"));
}

/** Keep invocation boundaries in the authored source, before Markdown removes
 * delimiters or decodes entities. Only generated AST properties create app links. */
export function remarkSkillMentions({ text, skills, references }: { text: string; skills: readonly LocalSkill[]; references?: readonly SkillReference[] }) {
  const ranges = references !== undefined
    ? validSkillReferences(text, references).map((reference) => ({ start: reference.start, end: reference.end, skill: { name: reference.name, path: reference.path } }))
    : skillMentionRanges(text, skills.map((skill) => ({ ...skill, enabled: true })));
  return (tree: Root) => {
    if (!ranges.length) return;
    const visit = (node: Nodes) => {
      // Authored links retain their destination and never receive nested links.
      if (node.type === "link" || node.type === "linkReference" || node.type === "image" || node.type === "imageReference") return;
      if ("children" in node) {
        node.children.forEach((child) => visit(child));
        return;
      }
      if (node.type !== "text" && node.type !== "code" && node.type !== "inlineCode") return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const raw = text.slice(start, end);
      let offsetFor: (offset: number) => number;
      if (node.type === "text") {
        // Text positions span the indentation and quote prefixes on continued
        // lines even though Markdown removes those prefixes from the value.
        const continuedText = (value: string) => markdownText(value.replace(/(\r\n|\r|\n)[ \t]*(?:>[ \t]*)*/g, "$1"));
        const normalize = markdownText(raw) === node.value ? markdownText : continuedText;
        if (normalize(raw) !== node.value) return;
        offsetFor = (offset) => normalize(raw.slice(0, offset)).length;
      } else if (node.type === "inlineCode") {
        const fence = raw.match(/^`+/)?.[0].length ?? 0;
        const content = raw.slice(fence, -fence).replace(/\r\n|\r|\n/g, " ");
        const trimmed = content.startsWith(" ") && content.endsWith(" ") && /\S/.test(content) ? 1 : 0;
        if (content.slice(trimmed, trimmed ? -trimmed : undefined) !== node.value) return;
        offsetFor = (offset) => raw.slice(fence, offset).replace(/\r\n|\r|\n/g, " ").length - trimmed;
      } else {
        // Fenced code keeps its original text. Restrict matching to its content,
        // not the language or metadata on the opening fence.
        const contentStart = /^\s*(`{3,}|~{3,})/.test(raw) ? raw.indexOf("\n") + 1 : 0;
        const valueStart = raw.indexOf(node.value, contentStart);
        if (valueStart < 0) return;
        offsetFor = (offset) => offset - valueStart;
      }
      const children: ElementContent[] = [];
      let cursor = 0;
      for (const range of ranges) {
        if (range.start < start || range.end > end) continue;
        const valueStart = offsetFor(range.start - start);
        const valueEnd = offsetFor(range.end - start);
        if (valueStart < cursor || node.value.slice(valueStart, valueEnd) !== text.slice(range.start, range.end)) continue;
        if (valueStart > cursor) children.push({ type: "text", value: node.value.slice(cursor, valueStart) });
        children.push({ type: "element", tagName: "a", properties: {
          href: "#skills", className: ["message-skill-mention"],
          "data-skill-path": range.skill.path, "data-skill-name": range.skill.name,
          "data-skill-disabled": !skills.find((skill) => skill.path === range.skill.path)?.enabled,
          "data-skill-missing": !skills.some((skill) => skill.path === range.skill.path),
        }, children: [{ type: "text", value: node.value.slice(valueStart, valueEnd) }] });
        cursor = valueEnd;
      }
      if (!children.length) return;
      if (cursor < node.value.length) children.push({ type: "text", value: node.value.slice(cursor) });
      if (node.type === "code") children.push({ type: "text", value: "\n" });
      node.data = { ...node.data, hChildren: children };
      // A text node with hChildren needs an inline wrapper; code retains its
      // normal <code> element and pre/copy behavior.
      if (node.type === "text") node.data.hName = "span";
    };
    tree.children.forEach((node: RootContent) => visit(node));
  };
}
