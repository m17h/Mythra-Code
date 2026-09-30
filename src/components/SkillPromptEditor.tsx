import {
  forwardRef, useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Boxes } from "lucide-react";
import type { SkillDependencyReport } from "../types";
import { useSkillDependencyPreview, type AnalyzeSkillDependencies } from "../hooks/useSkillDependencyPreview";
import { blockedSkillNames } from "./SkillDependencyDetails";
import { SkillDependencyNotice } from "./SkillDependencyNotice";
import { useSkillReferenceInspector } from "./SkillReferenceInspector";
import { adoptPortalTheme, effectiveZoom, supportsTopLayer } from "../lib/floatingLayer";
import {
  skillMentionQuery, skillMentionRanges, skillMentionSuggestions,
  type SkillMentionQuery, type SkillMentionSkill,
} from "../lib/skillMentions";
import "./skill-prompt-editor.css";

export interface SkillPromptEditorProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue"> {
  value: string;
  skills?: readonly SkillMentionSkill[];
  wrapperClassName?: string;
  onAnalyze?: AnalyzeSkillDependencies;
  dependencyReport?: SkillDependencyReport | null;
  showDependencyNotice?: boolean;
}

const MIRRORED_PROPERTIES = [
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "line-height",
  "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform", "tab-size",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-radius", "direction", "overflow-wrap", "word-break", "white-space",
] as const;

/** The mirror never owns input or selection; a native textarea remains editable. */
export function syncSkillPromptHighlight(textarea: HTMLTextAreaElement, highlight: HTMLDivElement | null): void {
  if (!highlight) return;
  const style = getComputedStyle(textarea);
  for (const property of MIRRORED_PROPERTIES) highlight.style.setProperty(property, style.getPropertyValue(property));
  const borders = parseFloat(style.borderLeftWidth || "0") + parseFloat(style.borderRightWidth || "0");
  const scrollbarGutter = Math.max(0, textarea.offsetWidth - textarea.clientWidth - borders);
  highlight.style.paddingRight = `${parseFloat(style.paddingRight || "0") + scrollbarGutter}px`;
  highlight.style.width = `${textarea.offsetWidth}px`;
  highlight.style.height = `${textarea.offsetHeight}px`;
  highlight.style.left = `${textarea.offsetLeft}px`;
  highlight.style.top = `${textarea.offsetTop}px`;
  highlight.scrollTop = textarea.scrollTop;
  highlight.scrollLeft = textarea.scrollLeft;
}

export const SkillPromptEditor = forwardRef<HTMLTextAreaElement, SkillPromptEditorProps>(function SkillPromptEditor({
  value, skills = [], wrapperClassName, className, onChange, onSelect, onScroll, onBlur, onKeyDown,
  onCompositionStart, onCompositionEnd, onFocus, onPointerMove, onPointerLeave, "aria-describedby": describedBy,
  disabled, readOnly, onAnalyze, dependencyReport, showDependencyNotice = true, ...textareaProps
}, forwardedRef) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const dismissedSelectionRef = useRef<{ value: string; start: number; end: number } | null>(null);
  const [query, setQuery] = useState<SkillMentionQuery | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listId = useId();
  useImperativeHandle(forwardedRef, () => textareaRef.current!, []);
  const preview = useSkillDependencyPreview(value, onAnalyze);
  const report = dependencyReport === undefined ? preview.report : dependencyReport;
  const blockedNames = useMemo(() => blockedSkillNames(report), [report]);
  const ranges = useMemo(() => skillMentionRanges(value, blockedNames.size
    ? [...skills.map((skill) => blockedNames.has(skill.name.toLowerCase()) ? { ...skill, enabled: true } : skill),
      ...[...blockedNames].filter((name) => !skills.some((skill) => skill.name.toLowerCase() === name)).map((name) => ({ name }))]
    : skills), [skills, value, blockedNames]);
  const suggestions = useMemo(() => query ? skillMentionSuggestions(skills, query.query) : [], [query, skills]);
  const menuOpen = Boolean(query && value.slice(query.start, query.end) === `@${query.query}`
    && suggestions.length && !disabled && !readOnly);
  const topLayer = supportsTopLayer();
  const activeIndex = Math.min(selectedIndex, Math.max(0, suggestions.length - 1));
  const inspector = useSkillReferenceInspector({
    textareaRef, highlightRef, ranges, report, channel: "system", suppressed: menuOpen,
    pending: dependencyReport === undefined && Boolean(onAnalyze) && !preview.report && !preview.error,
    error: dependencyReport === undefined ? preview.error : "",
  });
  const { flaggedNames, activeStart } = inspector;
  const highlighted = useMemo(() => {
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const range of ranges) {
      parts.push(value.slice(offset, range.start));
      // Reasons live in the inspector: the mirror is pointer-free and hidden
      // from assistive technology, so a title here could never be reached.
      const blocked = flaggedNames.has(range.skill.name.toLowerCase());
      parts.push(<span key={range.start} data-skill-start={range.start}
        className={`skill-prompt-token${blocked ? " is-blocked" : ""}${activeStart === range.start ? " is-inspected" : ""}`}>
        {value.slice(range.start, range.end)}</span>);
      offset = range.end;
    }
    parts.push(value.slice(offset), "\u200b");
    return parts;
  }, [ranges, value, flaggedNames, activeStart]);

  const syncHighlight = useCallback(() => {
    if (textareaRef.current) syncSkillPromptHighlight(textareaRef.current, highlightRef.current);
  }, []);
  // Remeasure every render: live font previews and surrounding settings can
  // change typography without changing the text or the textarea dimensions.
  useLayoutEffect(syncHighlight);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const observer = new ResizeObserver(syncHighlight);
    observer.observe(textarea);
    window.addEventListener("resize", syncHighlight);
    return () => { observer.disconnect(); window.removeEventListener("resize", syncHighlight); };
  }, [syncHighlight]);
  useLayoutEffect(() => {
    if (menuOpen) listRef.current?.querySelector<HTMLElement>(`[aria-selected="true"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, menuOpen]);
  const positionSuggestions = useCallback(() => {
    const menu = listRef.current;
    const textarea = textareaRef.current;
    if (!menu || !textarea) return;
    if (!topLayer) adoptPortalTheme(menu, textarea);
    const anchor = textarea.getBoundingClientRect();
    const zoom = effectiveZoom(menu);
    const width = Math.min(anchor.width, Math.max(1, window.innerWidth - 16));
    menu.style.width = `${width / zoom}px`;
    menu.style.maxHeight = `${Math.max(1, Math.min(190 * zoom, window.innerHeight - 16)) / zoom}px`;
    const height = menu.offsetHeight * zoom;
    const above = anchor.top - height - 6;
    const preferred = above >= 8 ? above : anchor.bottom + 6;
    const top = Math.max(8, Math.min(preferred, window.innerHeight - height - 8));
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    menu.style.top = `${top / zoom}px`;
    menu.style.left = `${left / zoom}px`;
    menu.style.visibility = "visible";
  }, [topLayer]);
  useLayoutEffect(positionSuggestions);
  useLayoutEffect(() => {
    const menu = listRef.current;
    const textarea = textareaRef.current;
    if (!menuOpen || !menu || !textarea) return;
    if (topLayer) menu.showPopover();
    positionSuggestions();
    const observer = new ResizeObserver(positionSuggestions);
    observer.observe(textarea);
    window.addEventListener("resize", positionSuggestions);
    window.addEventListener("scroll", positionSuggestions, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionSuggestions);
      window.removeEventListener("scroll", positionSuggestions, true);
    };
  }, [menuOpen, suggestions.length, topLayer, positionSuggestions]);

  const updateQuery = (textarea: HTMLTextAreaElement) => {
    const dismissed = dismissedSelectionRef.current;
    if (dismissed && dismissed.value === textarea.value && dismissed.start === textarea.selectionStart
      && dismissed.end === textarea.selectionEnd) return;
    dismissedSelectionRef.current = null;
    if (composingRef.current || disabled || readOnly || textarea.selectionStart !== textarea.selectionEnd) {
      setQuery(null);
      return;
    }
    setQuery(skillMentionQuery(textarea.value, textarea.selectionStart));
    setSelectedIndex(0);
  };
  const insertSkill = (skill: SkillMentionSkill) => {
    const textarea = textareaRef.current;
    if (!textarea || !query) return;
    const insertion = `@${skill.name} `;
    const expected = `${textarea.value.slice(0, query.start)}${insertion}${textarea.value.slice(query.end)}`;
    textarea.focus();
    textarea.setSelectionRange(query.start, query.end);
    // Native editing retains Undo/Redo and emits React's ordinary input
    // event. Programmatic range replacement clears that history in both
    // WebKit and Chromium, so it is only the unsupported-command fallback.
    try { document.execCommand?.("insertText", false, insertion); } catch { /* use the range fallback below */ }
    if (textarea.value !== expected) {
      textarea.setRangeText(insertion, query.start, query.end, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setQuery(null);
    textarea.focus();
    syncHighlight();
  };

  const suggestionMenu = menuOpen ? <div ref={listRef} id={listId} role="listbox" aria-label="Skill suggestions"
    className={`skill-prompt-suggestions${topLayer ? "" : " is-portaled"}`} popover={topLayer ? "manual" : undefined}
    // Portaled options remain attached to the editor in React's event tree.
    // Do not let document outside-click handlers close its owning popover.
    onPointerDown={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.preventDefault()}
  >
    {suggestions.map((skill, index) => <button
      key={skill.path ?? skill.name}
      id={`${listId}-${index}`}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={index === activeIndex}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => insertSkill(skill)}
    >
      <Boxes size={13} aria-hidden="true" />
      <span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}</span>
      <em>Skill</em>
    </button>)}
  </div> : null;

  return <div className={`skill-prompt-editor${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
    {ranges.length > 0 && <div ref={highlightRef} className="skill-prompt-highlight" aria-hidden="true">{highlighted}</div>}
    <textarea
      {...textareaProps}
      ref={textareaRef}
      value={value}
      disabled={disabled}
      readOnly={readOnly}
      data-skill-prompt-editor="true"
      data-skill-inspector-open={inspector.open || undefined}
      className={`skill-prompt-input${className ? ` ${className}` : ""}`}
      aria-autocomplete="list"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? listId : undefined}
      aria-activedescendant={menuOpen ? `${listId}-${activeIndex}` : undefined}
      aria-describedby={[describedBy, inspector.describedBy].filter(Boolean).join(" ") || undefined}
      onChange={(event) => { onChange?.(event); updateQuery(event.currentTarget); }}
      onSelect={(event) => { onSelect?.(event); updateQuery(event.currentTarget); inspector.handlers.onSelect(event.currentTarget); }}
      onScroll={(event) => { syncHighlight(); inspector.handlers.onScroll(); onScroll?.(event); }}
      onFocus={(event) => { inspector.handlers.onFocus(event.currentTarget); onFocus?.(event); }}
      onBlur={(event) => { setQuery(null); inspector.handlers.onBlur(event); onBlur?.(event); }}
      onPointerMove={(event) => { inspector.handlers.onPointerMove(event); onPointerMove?.(event); }}
      onPointerLeave={(event) => { inspector.handlers.onPointerLeave(); onPointerLeave?.(event); }}
      onCompositionStart={(event) => { composingRef.current = true; setQuery(null); onCompositionStart?.(event); }}
      onCompositionEnd={(event) => { composingRef.current = false; updateQuery(event.currentTarget); onCompositionEnd?.(event); }}
      onKeyDown={(event) => {
        if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          onKeyDown?.(event);
          return;
        }
        if (menuOpen) {
          if (event.key === "Tab" && event.shiftKey) {
            setQuery(null);
            onKeyDown?.(event);
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((activeIndex + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
            return;
          }
          if ((event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
            event.preventDefault();
            insertSkill(suggestions[activeIndex]);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            dismissedSelectionRef.current = { value: event.currentTarget.value, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
            setQuery(null);
            return;
          }
        }
        if (inspector.handlers.onKeyDown(event)) {
          if (menuOpen) {
            dismissedSelectionRef.current = { value: event.currentTarget.value, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
            setQuery(null);
          }
          return;
        }
        onKeyDown?.(event);
      }}
    />
    {topLayer ? suggestionMenu : suggestionMenu && createPortal(suggestionMenu, document.body)}
    {inspector.inspector}
    {showDependencyNotice && <SkillDependencyNotice report={report} error={preview.error} />}
  </div>;
});
