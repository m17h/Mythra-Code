import { useEffect, useRef, type RefObject } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { TransitionInput } from "./TransitionInput";
import { formatKeys } from "../lib/shortcuts";
import { primaryModifierPressed } from "../lib/platform";

/**
 * Find in the open conversation. Each machine supplies its own matches.
 *
 * Keys: ⏎ / ⇧⏎ in the field, and ⌘G / ⇧⌘G (Ctrl+G elsewhere) anywhere while
 * the bar is open, step through matches. Escape closes it and puts focus back
 * where it was before ⌘F (or the message box when that is gone).
 */
export function ConversationSearchBar({ inputRef, query, index, count, onQuery, onIndex, onClose }: {
  inputRef?: RefObject<HTMLInputElement | null>;
  query: string;
  index: number;
  count: number;
  onQuery: (query: string) => void;
  onIndex: (update: (current: number) => number) => void;
  onClose: () => void;
}) {
  // Captured during the first render, before the field takes focus.
  const returnTo = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const onIndexRef = useRef(onIndex);
  onIndexRef.current = onIndex;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "g" || event.altKey || !primaryModifierPressed(event)) return;
      event.preventDefault();
      onIndexRef.current((current) => current + (event.shiftKey ? -1 : 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => {
    onClose();
    const previous = returnTo.current;
    requestAnimationFrame(() => {
      if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) previous.focus();
      else document.querySelector<HTMLTextAreaElement>(".composer-zone .composer textarea:not([disabled])")?.focus();
    });
  };

  const position = query.trim() ? (count ? `${(((index % count) + count) % count) + 1} of ${count}` : "No matches") : "";
  return (
    <div className="conv-search-bar" role="search">
      <Search size={12} aria-hidden="true" />
      <TransitionInput
        ref={inputRef}
        value={query}
        onValueChange={onQuery}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onIndex((current) => current + (event.shiftKey ? -1 : 1));
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        placeholder="Search this conversation…"
        aria-label="Search this conversation"
      />
      <small aria-live="polite" aria-atomic="true">{position}</small>
      <button type="button" onClick={() => onIndex((current) => current - 1)} disabled={!count} title={`Previous match (⇧⏎ or ${formatKeys(["Mod", "Shift", "G"])})`} aria-label="Previous match" aria-keyshortcuts="Shift+Enter">
        <ChevronDown style={{ transform: "rotate(180deg)" }} size={13} aria-hidden="true" />
      </button>
      <button type="button" onClick={() => onIndex((current) => current + 1)} disabled={!count} title={`Next match (⏎ or ${formatKeys(["Mod", "G"])})`} aria-label="Next match" aria-keyshortcuts="Enter">
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <button type="button" onClick={close} title="Close search (Esc)" aria-label="Close conversation search">
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
