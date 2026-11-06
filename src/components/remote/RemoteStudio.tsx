import { useEffect, useMemo, useRef, useState, type PointerEvent, type KeyboardEvent, type Ref } from "react";
import { Bot, CodeXml, FilePlus2, FolderGit2, Gauge, GitBranch, GitFork, History, RefreshCw, SearchCode, TerminalSquare, UsersRound, Wrench } from "lucide-react";
import { DiffFileSections } from "../DiffView";
import { FileBrowser, type FileBrowserSource } from "../FileBrowser";
import { Empty, PanelHeader, StudioDockFrame, type StudioTab } from "../StudioDock";
import { parseDiffSections } from "../../lib/gitDiff";
import { joinPath } from "../../lib/paths";
import { remoteContextKey, useRemoteContext } from "../../lib/remote/remoteWork";
import { viewerRequest } from "../../lib/remote/viewerBridge";
import { useRemoteDevices } from "../../lib/remote/devices";
import { useRemoteStore } from "../../lib/remote/remoteStore";
import type { FilePreviewResult, FilesListResult, GitDiffResult, GitStatusResult, StudioTarget, WireGitChange } from "../../lib/remote/wire-studio";

const MAX_LIST_PAGES = 5;

/** The host hands out opaque handles. The browser thinks in paths, so this
 * remembers which handle each shown path came from. */
function hostFiles(device: string, target: StudioTarget): FileBrowserSource {
  const handles = new Map<string, string>();
  return {
    async list(path) {
      const parentId = handles.get(path);
      const entries = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result: FilesListResult = await viewerRequest(device, "files.list", { ...target, ...(parentId ? { parentId } : {}), ...(cursor ? { cursor } : {}) });
        for (const entry of result.entries) {
          handles.set(joinPath(path, entry.name), entry.id);
          entries.push({ fileName: entry.name, isDirectory: entry.kind === "directory", isFile: entry.kind === "file" });
        }
        cursor = result.cursor;
        if (!cursor) break;
      }
      return { entries };
    },
    async search(query, root) {
      const result = await viewerRequest<{ files: { id: string; name: string; relativePath: string }[] }>(device, "files.search", { workspaceId: target.workspaceId, query });
      return { files: result.files.map((file) => {
        handles.set(joinPath(root, file.relativePath), file.id);
        return { root, path: file.relativePath, file_name: file.name, score: 0 };
      }) };
    },
    async preview(_root, path) {
      const fileId = handles.get(path);
      if (!fileId) throw new Error("That file is no longer available.");
      const result = await viewerRequest<FilePreviewResult>(device, "files.preview", { ...target, fileId });
      return { text: result.text, truncated: result.truncated, binary: result.binary };
    },
  };
}

function HostChanges({ device, name, target, onClose }: { device: string; name: string; target: StudioTarget; onClose: () => void }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [selected, setSelected] = useState<WireGitChange | null>(null);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = () => {
    const current = ++request.current;
    setError("");
    viewerRequest<GitStatusResult>(device, "git.status", target)
      .then((next) => { if (current === request.current) setStatus(next); })
      .catch(() => { if (current === request.current) setError(`Mythra Code couldn't read changes on ${name}. Try again.`); });
  };
  useEffect(refresh, [device, name, target]);
  const open = (change: WireGitChange) => {
    setSelected(change);
    setDiff("");
    const current = ++request.current;
    viewerRequest<GitDiffResult>(device, "git.diff", { ...target, changeId: change.id })
      .then((result) => { if (current === request.current) setDiff(result.binary ? "This file is binary." : `${result.text}${result.truncated ? "\n… Diff shortened." : ""}`); })
      .catch(() => { if (current === request.current) setError(`Mythra Code couldn't read that change on ${name}. Try again.`); });
  };
  const sections = useMemo(() => parseDiffSections(diff), [diff]);
  return <>
    <PanelHeader icon={SearchCode} title="Review center" subtitle={`Inspect changes on ${name}`} onClose={onClose} />
    <div className="studio-actions wrap review-actions"><button onClick={refresh}><RefreshCw size={13} /> Refresh</button></div>
    <div className="diff-summary">
      <span><CodeXml size={13} /> Repository changes</span>
      <small>{status ? `${status.changedFiles} file${status.changedFiles === 1 ? "" : "s"} changed` : "Reading changes…"}</small>
    </div>
    {error && <p className="git-local-note bad" role="alert">{error}</p>}
    <div className="studio-list">{status?.changes.map((change) => <button key={change.id} className="studio-list-row remote-change-row" aria-pressed={selected?.id === change.id} onClick={() => open(change)}>
      <div><strong>{change.path}</strong><small>{change.status} · {change.area}</small></div>
    </button>)}</div>
    {sections.length ? <DiffFileSections sections={sections} readOnly readOnlyReason={`Stage and revert aren't available from here yet. Use ${name} to do this.`} onPathAction={() => undefined} />
      : diff && <pre className="diff-view">{diff}</pre>}
  </>;
}

const NOT_YET: Partial<Record<StudioTab, { icon: typeof Bot; title: string }>> = {
  agents: { icon: UsersRound, title: "Agent control" },
  terminal: { icon: TerminalSquare, title: "Terminal" },
  checkpoints: { icon: History, title: "Checkpoints" },
  worktrees: { icon: GitFork, title: "Worktrees" },
  git: { icon: GitBranch, title: "Git" },
};

/** The real dock, reading this machine's project through the host. */
export function RemoteStudio({ device, open, rootRef, onResizeStart, onResizeKeyDown, resizeValue, tab, onTab, onClose }: {
  device: string;
  open: boolean;
  rootRef?: Ref<HTMLElement>;
  onResizeStart?: (event: PointerEvent) => void;
  onResizeKeyDown?: (event: KeyboardEvent) => void;
  resizeValue?: number;
  tab: StudioTab;
  onTab: (tab: StudioTab) => void;
  onClose: () => void;
}) {
  const workspaceId = useRemoteStore((state) => state.devices[device]?.workspaceId ?? null);
  const threadId = useRemoteStore((state) => state.devices[device]?.threadId ?? undefined);
  const workspaceName = useRemoteStore((state) => state.devices[device]?.workspaces.find((entry) => entry.id === workspaceId)?.name);
  const name = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.name) ?? "this device";
  const context = useRemoteContext((state) => workspaceId ? state.contexts[device]?.get(remoteContextKey(workspaceId, threadId)) : undefined);
  const target = useMemo<StudioTarget | null>(() => workspaceId ? { workspaceId, ...(threadId ? { threadId } : {}) } : null, [threadId, workspaceId]);
  const files = useMemo(() => target ? hostFiles(device, target) : null, [device, target]);
  const missing = NOT_YET[tab];
  return <StudioDockFrame open={open} rootRef={rootRef} onResizeStart={onResizeStart} onResizeKeyDown={onResizeKeyDown} resizeValue={resizeValue} tab={tab} onTab={onTab}>
    {tab === "files" && <>
      <PanelHeader icon={FilePlus2} title="Project files" subtitle={`Search and preview files on ${name}`} onClose={onClose} />
      {files ? <FileBrowser root={`/${workspaceName ?? name}`} source={files} /> : <Empty icon={FilePlus2} title="No project selected" text={`Choose a project on ${name}.`} />}
    </>}
    {tab === "review" && (target ? <HostChanges device={device} name={name} target={target} onClose={onClose} />
      : <><PanelHeader icon={SearchCode} title="Review center" subtitle={name} onClose={onClose} /><Empty icon={FolderGit2} title="No project selected" text={`Choose a project on ${name}.`} /></>)}
    {tab === "usage" && <>
      <PanelHeader icon={Gauge} title="Thread usage" subtitle={`As reported by ${name}`} onClose={onClose} />
      {context?.usage ? <div className="metric-grid">
        <div><strong>{context.usage.totalTokens.toLocaleString()}</strong><span>Total tokens</span></div>
        <div><strong>{context.usage.inputTokens.toLocaleString()}</strong><span>Input</span></div>
        <div><strong>{context.usage.outputTokens.toLocaleString()}</strong><span>Output</span></div>
        <div><strong>{context.usage.cachedInputTokens.toLocaleString()}</strong><span>Cached</span></div>
      </div> : <Empty icon={Gauge} title="No usage yet" text="Usage appears after a turn finishes." />}
    </>}
    {tab === "tools" && <>
      <PanelHeader icon={Wrench} title="Tools & skills" subtitle={`Available on ${name}`} onClose={onClose} />
      <div className="studio-list">{context?.skills.map((skill) => <div className="studio-list-row" key={skill.id}>
        <div><strong>{skill.name}</strong><small>{skill.description}</small></div>
      </div>)}</div>
      {!context?.skills.length && <Empty icon={Wrench} title="No skills" text={`${name} has no skills to show here.`} />}
    </>}
    {missing && <>
      <PanelHeader icon={missing.icon} title={missing.title} subtitle={name} onClose={onClose} />
      <Empty icon={missing.icon} title="Not available here yet" text={`Use ${name} directly for this for now.`} />
    </>}
  </StudioDockFrame>;
}
