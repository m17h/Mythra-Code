import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Eye, EyeOff, File, Folder, Home, LoaderCircle, Paperclip, Search, X } from "lucide-react";
import { rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import {
  basename,
  isAbsolutePath,
  joinPath,
  parentPath,
  pathSegments,
  relativeDisplayPath,
  stripTrailingSeparator,
} from "../lib/paths";

interface FileResult { root: string; path: string; file_name: string; score: number }
interface DirectoryEntry { fileName: string; isDirectory: boolean; isFile: boolean }

const IGNORED_NAMES = new Set([".git", ".DS_Store", ".next", ".nuxt", ".turbo", "build", "coverage", "dist", "node_modules", "target"]);

function decode(value: string): string {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "This file is binary or cannot be previewed as UTF-8 text.";
  }
}

function containsIgnoredSegment(relativePath: string): boolean {
  return pathSegments(relativePath).some((segment) => IGNORED_NAMES.has(segment));
}

export function FileBrowser({ root, onAttach }: { root: string; onAttach: (path: string) => void }) {
  const normalizedRoot = stripTrailingSeparator(root);
  const [currentDirectory, setCurrentDirectory] = useState(normalizedRoot);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [results, setResults] = useState<FileResult[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);
  // Only the newest preview request may publish. Selecting a large file and
  // then a small one used to render the large file's late response under the
  // small file's name.
  const previewRequestRef = useRef(0);

  useEffect(() => {
    setCurrentDirectory(normalizedRoot);
    setSelected(null);
    setPreview("");
    setQuery("");
    previewRequestRef.current += 1;
    setPreviewLoading(false);
  }, [normalizedRoot]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setDirectoryError("");
    void rpc<{ entries: DirectoryEntry[] }>("fs/readDirectory", { path: currentDirectory })
      .then((value) => {
        if (!active) return;
        setDirectory(value.entries ?? []);
      })
      .catch((reason) => {
        if (!active) return;
        setDirectory([]);
        setDirectoryError(`Couldn’t open this folder. ${friendlyError(reason)}`);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // `entries` is derived below and is not read by this directory request;
  // Babel's TypeScript parser currently reports it as a false dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDirectory]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let active = true;
    const token = window.setTimeout(() => {
      setLoading(true);
      void rpc<{ files: FileResult[] }>("fuzzyFileSearch", {
        query: query.trim(),
        roots: [normalizedRoot],
        cancellationToken: crypto.randomUUID(),
      }).then((value) => { if (active) setResults(value.files ?? []); })
        .catch(() => { if (active) setResults([]); })
        .finally(() => { if (active) setLoading(false); });
    }, 120);
    return () => { active = false; window.clearTimeout(token); };
  }, [normalizedRoot, query]);

  const entries = useMemo(() => {
    if (query.trim()) {
      return results
        .filter((entry) => showIgnored || !containsIgnoredSegment(entry.path))
        .slice(0, 150)
        .map((entry) => ({
          path: isAbsolutePath(entry.path) ? entry.path : joinPath(entry.root, entry.path),
          name: entry.path || entry.file_name,
          directory: false,
        }));
    }
    return directory
      .filter((entry) => showIgnored || !IGNORED_NAMES.has(entry.fileName))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName))
      .map((entry) => ({ path: joinPath(currentDirectory, entry.fileName), name: entry.fileName, directory: entry.isDirectory }));
  }, [currentDirectory, directory, query, results, showIgnored]);

  const relativeDirectory = relativeDisplayPath(normalizedRoot, currentDirectory);
  const breadcrumbParts = pathSegments(relativeDirectory);

  const navigate = (path: string) => {
    setCurrentDirectory(path);
    setSelected(null);
    setPreview("");
    setQuery("");
    previewRequestRef.current += 1;
    setPreviewLoading(false);
  };

  const openEntry = async (path: string, directoryEntry: boolean) => {
    if (directoryEntry) {
      navigate(path);
      return;
    }
    const request = ++previewRequestRef.current;
    setSelected(path);
    setPreview("");
    setPreviewLoading(true);
    try {
      const value = await rpc<{ dataBase64: string }>("fs/readFile", { path });
      if (previewRequestRef.current !== request) return;
      const decoded = decode(value.dataBase64);
      setPreview(decoded.length > 250_000 ? `${decoded.slice(0, 250_000)}\n\n… Preview truncated at 250,000 characters.` : decoded);
    } catch (reason) {
      if (previewRequestRef.current !== request) return;
      setPreview(`Couldn’t preview this file. ${friendlyError(reason)}`);
    } finally {
      // The loading indicator belongs to the newest selection only; a slow
      // earlier response must not clear it while the current file is loading.
      if (previewRequestRef.current === request) setPreviewLoading(false);
    }
  };

  const goUp = () => {
    if (currentDirectory === normalizedRoot) return;
    navigate(parentPath(currentDirectory) ?? normalizedRoot);
  };

  return (
    <div className="file-browser">
      <div className="file-browser-toolbar">
        <button className="file-nav-button" onClick={goUp} disabled={currentDirectory === normalizedRoot} aria-label="Go to parent folder"><ArrowLeft size={13} /></button>
        <nav className="file-breadcrumbs" aria-label="Current project folder">
          <button onClick={() => navigate(normalizedRoot)} title={normalizedRoot}><Home size={11} /><span>{basename(normalizedRoot)}</span></button>
          {breadcrumbParts.map((part, index) => {
            const path = breadcrumbParts.slice(0, index + 1).reduce(joinPath, normalizedRoot);
            return <span key={path}><ChevronRight size={10} /><button onClick={() => navigate(path)}>{part}</button></span>;
          })}
        </nav>
        <button className={`file-nav-button ${showIgnored ? "active" : ""}`} onClick={() => setShowIgnored((show) => !show)} aria-pressed={showIgnored} aria-label={showIgnored ? "Hide generated and ignored folders" : "Show generated and ignored folders"} title={showIgnored ? "Hide generated folders" : "Show generated folders"}>{showIgnored ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      </div>
      <label className="file-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the whole project…" />{loading || previewLoading ? <LoaderCircle className="spin" size={13} /> : query && <button onClick={() => setQuery("")} aria-label="Clear file search"><X size={12} /></button>}</label>
      <div className="file-browser-body">
        <div className="file-results" aria-label={query ? "Project search results" : "Folder contents"}>
          {entries.map((entry) => <button key={entry.path} className={selected === entry.path ? "selected" : ""} onClick={() => void openEntry(entry.path, entry.directory)} title={entry.path}>{entry.directory ? <Folder size={13} /> : <File size={13} />}<span>{entry.name}</span>{entry.directory && <ChevronRight size={11} />}</button>)}
          {!entries.length && !loading && <span className="file-empty">{directoryError || (query ? "No matching files" : "This folder is empty")}</span>}
        </div>
        <div className="file-preview">
          {selected ? <><div className="file-preview-bar"><span>{relativeDisplayPath(normalizedRoot, selected)}</span><button onClick={() => onAttach(selected)} aria-label={`Attach ${basename(selected)}`}><Paperclip size={11} /> Attach</button></div><pre>{previewLoading ? "Loading preview…" : preview}</pre></> : <div className="file-preview-empty"><File size={22} /><span>{query ? "Select a search result to preview it" : "Select a file to preview it"}</span></div>}
        </div>
      </div>
    </div>
  );
}
