import { useEffect, useState } from "react";
import { CircleDashed, Folder, GitBranch, Pin } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import type { Provider } from "../types";
import { ProviderLogo } from "./BrandLogos";

export function formatWorkingDuration(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function compactDirectory(path: string, segments = 2): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return path || "No directory";
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return "/";
  return parts.slice(-Math.max(1, segments)).join("/");
}

function WorkingDuration({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  return <span className="thread-card-duration">{formatWorkingDuration(Date.now() - startedAt)}</span>;
}

function ThreadInboxStatus({ threadId }: { threadId: string }) {
  const status = useTaskStore((state) => state.statuses[threadId] ?? "idle");
  const startedAt = useTaskStore((state) => state.tasks[threadId]?.workingStartedAt);
  const approvalCount = useTaskStore((state) => state.tasks[threadId]?.approvals.length ?? 0);
  const unread = useTaskStore((state) => Boolean(state.tasks[threadId]?.unread));

  if (approvalCount > 0) {
    return (
      <span className="thread-card-status approval" role="status">
        Needs approval
      </span>
    );
  }
  if (status === "starting" || status === "running") {
    return (
      <span className="thread-card-status working" role="status">
        <CircleDashed className="thread-card-spinner" size={14} />
        <span>{status === "starting" ? "Starting" : "Working"}</span>
        {status === "running" && startedAt !== undefined && <WorkingDuration startedAt={startedAt} />}
      </span>
    );
  }
  if (status === "error") {
    return <span className="thread-card-status error" role="status">Failed</span>;
  }
  if (unread) {
    return <span className="thread-card-status done" role="status">Done</span>;
  }
  return null;
}

interface ThreadInboxCardProps {
  threadId: string;
  title: string;
  workspaceName: string;
  directory: string;
  provider: Provider;
  providerName: string;
  pinned: boolean;
  isolated?: boolean;
  branch?: string;
  onOpen: () => void;
}

export function ThreadInboxCard({
  threadId,
  title,
  workspaceName,
  directory,
  provider,
  providerName,
  pinned,
  isolated = false,
  branch,
  onOpen,
}: ThreadInboxCardProps) {
  return (
    <button className="thread-card" onClick={onOpen} aria-label={`Open ${title}`}>
      <span className="thread-card-context">
        <span className="thread-card-workspace" title={directory}>
          {isolated ? <GitBranch size={14} /> : <Folder size={14} />}
          <span>{isolated ? branch || "Isolated" : workspaceName}</span>
        </span>
        <ThreadInboxStatus threadId={threadId} />
      </span>
      <span className="thread-card-title">{title}</span>
      <span className="thread-card-meta">
        <span className="thread-card-directory" title={directory}>{compactDirectory(directory)}</span>
        {pinned && <Pin className="thread-card-pin" size={12} aria-label="Pinned" />}
        <span className={`thread-card-provider ${provider}`} title={`${providerName} thread`} aria-label={`${providerName} thread`}>
          <ProviderLogo provider={provider} size={13} />
        </span>
      </span>
    </button>
  );
}
