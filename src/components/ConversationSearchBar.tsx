import type { RefObject } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { TransitionInput } from "./TransitionInput";

/** Find in the open conversation. Each machine supplies its own matches. */
export function ConversationSearchBar({ inputRef, query, index, count, onQuery, onIndex, onClose }: {
  inputRef?: RefObject<HTMLInputElement | null>;
  query: string;
  index: number;
  count: number;
  onQuery: (query: string) => void;
  onIndex: (update: (current: number) => number) => void;
  onClose: () => void;
}) {
  return (
    <div className="conv-search-bar" role="search">
      <Search size={12} />
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
            onClose();
          }
        }}
        placeholder="Search this conversation…"
        aria-label="Search this conversation"
      />
      <small>{query.trim() ? (count ? `${(((index % count) + count) % count) + 1} of ${count}` : "No matches") : ""}</small>
      <button onClick={() => onIndex((current) => current - 1)} disabled={!count} title="Previous match" aria-label="Previous match">
        <ChevronDown style={{ transform: "rotate(180deg)" }} size={13} />
      </button>
      <button onClick={() => onIndex((current) => current + 1)} disabled={!count} title="Next match" aria-label="Next match">
        <ChevronDown size={13} />
      </button>
      <button onClick={onClose} title="Close search" aria-label="Close conversation search">
        <X size={13} />
      </button>
    </div>
  );
}
