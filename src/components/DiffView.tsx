import { useMemo, useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import type { DiffSection } from "../lib/gitDiff";

/**
 * Lines rendered before a diff asks to be expanded further. A refactor that
 * touches a generated file can produce tens of thousands of lines, and every
 * one of them was previously a DOM node created up front — even inside a
 * collapsed file nobody opened.
 */
export const DIFF_INITIAL_LINES = 400;
/** How much more one "Show more" reveals. */
export const DIFF_LINE_STEP = 2_000;

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-line-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-line-del";
  if (line.startsWith("@@")) return "diff-line-hunk";
  return undefined;
}

/**
 * A diff body that reveals progressively instead of mounting every line. The
 * full text stays reachable — nothing is truncated away, it is just not in the
 * document until asked for.
 */
export function DiffText({ text, initialLines = DIFF_INITIAL_LINES }: { text: string; initialLines?: number }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const [visible, setVisible] = useState(() => Math.min(lines.length, initialLines));
  // A new diff replaces the old one during render, so a long expansion of the
  // previous file never carries over into the next one.
  const [renderedText, setRenderedText] = useState(text);
  if (renderedText !== text) {
    setRenderedText(text);
    setVisible(Math.min(lines.length, initialLines));
  }
  const hidden = lines.length - visible;
  return (
    <div className="diff-body">
      <pre className="diff-view">
        {lines.slice(0, visible).map((line, index) => (
          <span key={index} className={diffLineClass(line)}>{`${line}\n`}</span>
        ))}
      </pre>
      {hidden > 0 && (
        <div className="diff-more">
          <span>{hidden.toLocaleString()} more line{hidden === 1 ? "" : "s"} not shown</span>
          <button onClick={() => setVisible((current) => Math.min(lines.length, current + DIFF_LINE_STEP))}>
            Show {Math.min(hidden, DIFF_LINE_STEP).toLocaleString()} more
          </button>
          {hidden > DIFF_LINE_STEP && <button onClick={() => setVisible(lines.length)}>Show all</button>}
        </div>
      )}
    </div>
  );
}

/**
 * One collapsible file in the Review panel. The body is mounted only while the
 * file is expanded, and per-file Git actions appear only when the path was
 * recovered unambiguously — running `git add --`/`git restore --` on a guessed
 * path would stage or discard the wrong file.
 */
function DiffFile({ section, readOnly, readOnlyReason, defaultOpen, onPathAction }: {
  section: DiffSection;
  readOnly: boolean;
  readOnlyReason?: string;
  defaultOpen: boolean;
  onPathAction: (action: "stage" | "revert", path: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const path = section.path;
  return (
    <details className="diff-file" open={open}>
      {/* The open state is driven explicitly so the body can stay unmounted
          while collapsed; native toggling would mount it either way. */}
      <summary onClick={(event) => { event.preventDefault(); setOpen((current) => !current); }}>
        <code>{section.displayPath}</code>
        <span className="diff-file-stats"><em className="added">+{section.additions}</em> <em className="removed">−{section.deletions}</em></span>
        {path === null ? (
          <span className="diff-file-actions"><em title="Mythra Code could not decode this file's name from the diff header, so per-file Git actions are unavailable for it.">Name unavailable</em></span>
        ) : (
          <span className="diff-file-actions">
            <button
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onPathAction("stage", path);
              }}
              disabled={readOnly}
              title={readOnly ? readOnlyReason : `Stage ${path}`}
            >
              <Plus size={10} /> Stage
            </button>
            <button
              className="danger-action"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onPathAction("revert", path);
              }}
              disabled={readOnly}
              title={readOnly ? readOnlyReason : `Revert ${path}`}
              aria-label={`Revert ${path}`}
            >
              <RotateCcw size={10} />
            </button>
          </span>
        )}
      </summary>
      {open && <DiffText text={section.text} />}
    </details>
  );
}

export function DiffFileSections({ sections, readOnly, readOnlyReason, onPathAction }: {
  sections: DiffSection[];
  readOnly: boolean;
  readOnlyReason?: string;
  onPathAction: (action: "stage" | "revert", path: string) => void;
}) {
  return (
    <div className="diff-file-sections">
      {sections.map((section, index) => (
        <DiffFile
          key={`${section.path ?? section.displayPath}:${index}`}
          section={section}
          readOnly={readOnly}
          readOnlyReason={readOnlyReason}
          defaultOpen={sections.length === 1}
          onPathAction={onPathAction}
        />
      ))}
    </div>
  );
}
