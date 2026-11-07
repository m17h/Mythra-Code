import type { GitHubAccountStatus, GitHubRepoStatus } from "../../github";
import type { RemoteWorkResult, HostRequest, RemoteOperationIdentity } from "../wire";
import type { WireGitHubAccess, WirePullRequest, WirePullRequestComment, WirePullRequestContext, WirePullRequestSummary } from "../wire-studio";
import type { HostTransport } from "./bridge";
import { loadStored } from "../../storage";
import { nativeRefusal } from "./nativeActions";
import { HostReadError } from "./scope";

const READS = new Set(["github.comments.list", "github.ci.status", "github.pr.view", "github.pr.list", "github.pr.find", "github.pr.context"]);
const WRITES = new Set(["github.pr.create", "github.pr.merge", "github.pr.ready", "github.pr.comment"]);
export const isGitHubRead = (op: string): boolean => READS.has(op);
export const isGitHubWrite = (op: string): boolean => WRITES.has(op);

const BASELINE_MS = 300_000;
const REPOSITORY_MS = 60_000;
const MAX_ENTRIES = 256;
const MAX_LIST = 50;
const MAX_CHECKS = 200;
const MAX_COMMENTS = 100;
const MAX_FILES = 200;
const STATES = new Set(["OPEN", "CLOSED", "MERGED"]);
const METHODS = new Set(["squash", "merge", "rebase"]);
const OUTCOMES = new Set(["created", "existing", "updated"]);

const stale = () => new HostReadError("stale_target", "This pull request changed. Refresh it and try again.");
const invalid = () => new HostReadError("unsupported", "This action is not valid.");
const noRepository = () => new HostReadError("unsupported", "This project isn't connected to a GitHub repository on the other device.");
const unconfirmed = () => new HostReadError("uncertain", "GitHub may have received this change. Refresh the pull request before trying again.");

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, maximum: number): string => typeof value === "string" ? value.slice(0, maximum) : "";
const flag = (value: unknown): boolean => value === true;
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Only GitHub's own pages, so nothing here can become a local or file link. */
const link = (value: unknown): string => { const url = text(value, 2048); return url.startsWith("https://github.com/") ? url : ""; };
const strings = (value: unknown, limit: number, maximum: number): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, limit).map((entry) => entry.slice(0, maximum)) : [];
const methods = (value: unknown): WirePullRequest["mergeMethods"] => strings(value, 3, 16).filter((method): method is WirePullRequest["mergeMethods"][number] => METHODS.has(method));
const prState = (value: unknown): WirePullRequest["state"] => { if (typeof value !== "string" || !STATES.has(value)) throw stale(); return value as WirePullRequest["state"]; };
function prNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw stale();
  return value;
}
const checks = (value: unknown): WirePullRequest["checks"] => (Array.isArray(value) ? value : []).slice(0, MAX_CHECKS).map((entry) => {
  const row = record(entry);
  return { name: text(row.name, 256), state: text(row.state, 64), url: link(row.url) };
});

/** Field by field, because anything GitHub returns goes on to another machine. */
export function wirePullRequest(value: unknown): WirePullRequest {
  const row = record(value);
  return {
    repository: text(row.repository, 256), number: prNumber(row.number), url: link(row.url), title: text(row.title, 1024), body: text(row.body, 65536),
    state: prState(row.state), isDraft: flag(row.isDraft), headRefName: text(row.headRefName, 256), baseRefName: text(row.baseRefName, 256), headOid: text(row.headOid, 64),
    mergeable: text(row.mergeable, 64), mergeStateStatus: text(row.mergeStateStatus, 64), reviewDecision: text(row.reviewDecision, 64), checks: checks(row.checks),
    updatedAt: text(row.updatedAt, 64), canMerge: flag(row.canMerge), viewerCanMerge: flag(row.viewerCanMerge), autoMergeAllowed: flag(row.autoMergeAllowed), mergeMethods: methods(row.mergeMethods),
  };
}
function wireSummary(value: unknown): WirePullRequestSummary {
  const row = record(value);
  return { repository: text(row.repository, 256), number: prNumber(row.number), url: link(row.url), title: text(row.title, 1024), state: prState(row.state), isDraft: flag(row.isDraft),
    headRefName: text(row.headRefName, 256), baseRefName: text(row.baseRefName, 256), updatedAt: text(row.updatedAt, 64), authorLogin: typeof row.authorLogin === "string" ? row.authorLogin.slice(0, 256) : null };
}
function wireContext(value: unknown): WirePullRequestContext {
  const row = record(value);
  return { repository: text(row.repository, 256), branch: text(row.branch, 256), defaultBranch: text(row.defaultBranch, 256), headOid: text(row.headOid, 64), dirty: flag(row.dirty),
    ahead: count(row.ahead), behind: count(row.behind), pushRemote: /^[\w.-]{1,128}$/.test(text(row.pushRemote, 128)) ? text(row.pushRemote, 128) : "", permission: text(row.permission, 64), mergeMethods: methods(row.mergeMethods),
    ...(Array.isArray(row.changedFiles) ? { changedFiles: strings(row.changedFiles, MAX_FILES, 1024) } : {}), ...(typeof row.changedFileCount === "number" ? { changedFileCount: count(row.changedFileCount) } : {}),
    ...(Array.isArray(row.commits) ? { commits: strings(row.commits, MAX_FILES, 1024) } : {}) };
}
function wireComment(value: unknown): WirePullRequestComment {
  const row = record(value);
  return { id: typeof row.id === "number" || typeof row.id === "string" ? String(row.id).slice(0, 64) : "", author: text(row.author, 256), body: text(row.body, 65536), url: link(row.url), createdAt: text(row.createdAt, 64), updatedAt: text(row.updatedAt, 64) };
}

interface Target { workspaceId: string; threadId?: string; root: string; isolated: boolean }
interface Baseline { head: string; grantRevision: number; expires: number }
interface Stamp { workspaceId?: string | null; threadId?: string | null }

/** Typed GitHub operations. The host chooses the repository and the head a change
 * is measured against: a viewer names a pull request, and nothing more. */
export class HostGitHub {
  private repositories = new Map<string, { repository: string | null; expires: number }>();
  private heads = new Map<string, Baseline>();
  /** Branches GitHub named to this device, the only ones an update may follow. */
  private bases = new Map<string, Set<string>>();
  private disposed = false;
  constructor(private readonly generation: number, private readonly transport: HostTransport, private readonly canArchive: () => boolean = () => false) {}
  /** The link saved with this thread on the host, as identities only. */
  private savedLink(threadId: string | undefined, repository: string | null): WireGitHubAccess["savedLink"] {
    const link = threadId ? record(loadStored<Record<string, unknown>>("kiwi.threadPullRequests", {})[threadId]) : {};
    return typeof link.repository === "string" && link.repository.toLowerCase() === repository?.toLowerCase() && typeof link.number === "number" && Number.isSafeInteger(link.number) && link.number > 0
      ? { repository: link.repository, number: link.number } : null;
  }
  dispose(): void { this.disposed = true; this.repositories.clear(); this.heads.clear(); this.bases.clear(); }
  private rememberBase(request: HostRequest, target: Target, base: string): void {
    if (!base) return;
    const key = JSON.stringify([request.device, target.workspaceId]);
    const known = this.bases.get(key) ?? new Set<string>();
    if (known.size >= MAX_ENTRIES) known.clear();
    known.add(base);
    this.bases.delete(key);
    while (this.bases.size >= MAX_ENTRIES) this.bases.delete(this.bases.keys().next().value!);
    this.bases.set(key, known);
  }
  /** Update local follows a branch the host learned from GitHub, never a viewer's word. */
  verifiedBase(request: HostRequest, workspaceId: string, base: unknown): string {
    if (typeof base !== "string" || !this.bases.get(JSON.stringify([request.device, workspaceId]))?.has(base)) throw stale();
    return base;
  }
  repositoryFor(root: string): Promise<string | null> { return this.repository(root); }

  private async repository(root: string): Promise<string | null> {
    const known = this.repositories.get(root);
    if (known && known.expires > Date.now()) return known.repository;
    const status = await this.transport.invoke<GitHubRepoStatus>("remote_studio_git_metadata", { root });
    while (this.repositories.size >= MAX_ENTRIES) this.repositories.delete(this.repositories.keys().next().value!);
    const repository = typeof status?.repository === "string" ? status.repository : null;
    this.repositories.set(root, { repository, expires: Date.now() + REPOSITORY_MS });
    return repository;
  }
  private headKey(device: string, target: { workspaceId?: string | null; threadId?: string | null }, number: number | "checkout"): string {
    return JSON.stringify([device, target.workspaceId ?? null, target.threadId ?? null, number]);
  }
  private remember(request: HostRequest, target: Target, number: number | "checkout", head: string): void {
    if (!/^[0-9a-f]{40,64}$/.test(head)) return;
    const key = this.headKey(request.device, target, number);
    this.heads.delete(key);
    while (this.heads.size >= MAX_ENTRIES) this.heads.delete(this.heads.keys().next().value!);
    this.heads.set(key, { head, grantRevision: request.grant.revision, expires: Date.now() + BASELINE_MS });
  }
  /** The head this device was last shown. A change is never measured against anything newer. */
  private baseline(request: HostRequest, stamp: Stamp, number: number | "checkout"): string {
    const seen = this.heads.get(this.headKey(request.device, stamp, number));
    if (!seen || seen.expires < Date.now() || seen.grantRevision !== request.grant.revision) throw stale();
    return seen.head;
  }
  private call(request: HostRequest, target: Target, action: string, args: Record<string, unknown>): Promise<unknown> {
    return this.transport.invoke<unknown>("remote_github_read", { generation: this.generation, device: request.device, grantRevision: request.grant.revision, workspaceId: target.workspaceId, root: target.root, action, args });
  }

  async read(request: HostRequest, args: Record<string, unknown>, target: Target, assertCurrent: () => void): Promise<unknown> {
    if (this.disposed) throw new HostReadError("host_unavailable", "The other device is recovering. Try again shortly.");
    let repository: string | null;
    try { repository = await this.repository(target.root); } catch { repository = null; }
    assertCurrent();
    if (request.op === "github.pr.context") {
      let authenticated = false;
      try { authenticated = (await this.transport.invoke<GitHubAccountStatus>("github_status")).authenticated === true; } catch { /* No GitHub CLI there. */ }
      assertCurrent();
      const access: WireGitHubAccess = { authenticated, repository, isolated: target.isolated, context: null, canArchive: this.canArchive(), savedLink: this.savedLink(target.threadId, repository) };
      if (!repository || !authenticated) return access;
      try { access.context = wireContext(await this.call(request, target, request.op, { repository })); } catch (reason) { throw nativeRefusal(reason); }
      assertCurrent();
      this.remember(request, target, "checkout", access.context.headOid);
      this.rememberBase(request, target, access.context.defaultBranch);
      return access;
    }
    if (!repository) throw noRepository();
    try {
      if (request.op === "github.pr.list") {
        const rows = await this.call(request, target, request.op, { repository, ...(typeof args.search === "string" ? { search: args.search } : {}), ...(typeof args.state === "string" ? { state: args.state } : {}), limit: typeof args.limit === "number" ? args.limit : MAX_LIST });
        assertCurrent();
        return { pullRequests: (Array.isArray(rows) ? rows : []).slice(0, MAX_LIST).map(wireSummary) };
      }
      if (request.op === "github.pr.find") {
        const found = await this.call(request, target, request.op, { repository, branch: args.branch });
        assertCurrent();
        const pullRequest = found ? wirePullRequest(found) : null;
        if (pullRequest) { this.remember(request, target, pullRequest.number, pullRequest.headOid); this.rememberBase(request, target, pullRequest.baseRefName); }
        return { pullRequest };
      }
      const number = prNumber(args.number), raw = await this.call(request, target, request.op, { repository, number });
      assertCurrent();
      if (request.op === "github.pr.view") {
        const pullRequest = wirePullRequest(raw);
        this.remember(request, target, number, pullRequest.headOid);
        this.rememberBase(request, target, pullRequest.baseRefName);
        return { pullRequest };
      }
      const row = record(raw);
      if (request.op === "github.ci.status") return { checks: checks(row.checks), headOid: text(row.headOid, 64), mergeStateStatus: text(row.mergeStateStatus, 64) };
      return { comments: (Array.isArray(row.comments) ? row.comments : []).slice(0, MAX_COMMENTS).map(wireComment), hasMore: flag(row.hasMore) };
    } catch (reason) {
      if (reason instanceof HostReadError) throw reason;
      throw nativeRefusal(reason);
    }
  }

  async write(request: HostRequest, args: Record<string, unknown>, identity: RemoteOperationIdentity, stamp: Stamp & object, root: string, assertAllowed: () => void): Promise<RemoteWorkResult> {
    if (this.disposed) throw new HostReadError("host_unavailable", "The other device is recovering. Try again shortly.");
    const repository = await this.repository(root);
    if (!repository) throw noRepository();
    let nativeArgs: Record<string, unknown>;
    if (request.op === "github.pr.create") {
      if (typeof args.head !== "string" || typeof args.base !== "string" || typeof args.title !== "string" || typeof args.commitAll !== "boolean" || typeof args.draft !== "boolean") throw invalid();
      nativeArgs = { repository, head: args.head, base: args.base, title: args.title, body: typeof args.body === "string" ? args.body : "", draft: args.draft, commitAll: args.commitAll,
        ...(typeof args.commitMessage === "string" && args.commitMessage ? { commitMessage: args.commitMessage } : {}), expectedHeadOid: this.baseline(request, stamp, "checkout") };
    } else {
      const number = prNumber(args.number), expectedHeadOid = this.baseline(request, stamp, number);
      if (request.op === "github.pr.merge") nativeArgs = { repository, number, method: args.method, auto: args.auto === true, expectedHeadOid };
      else if (request.op === "github.pr.ready") nativeArgs = { repository, number, expectedHeadOid };
      else nativeArgs = { repository, number, expectedHeadOid, body: args.body };
    }
    assertAllowed();
    let raw: { result?: RemoteWorkResult; payload?: unknown };
    try { raw = await this.transport.invoke("remote_github_execute", { stamp, root, action: request.op, args: nativeArgs }); } catch (reason) { throw nativeRefusal(reason); }
    if (raw.result?.opId !== identity.opId || raw.result.state !== "accepted") throw unconfirmed();
    const payload = record(raw.payload);
    const number = typeof payload.number === "number" ? payload.number : undefined;
    const creationOutcome = typeof payload.creationOutcome === "string" && OUTCOMES.has(payload.creationOutcome) ? payload.creationOutcome : undefined;
    return { opId: identity.opId, state: "accepted", workspaceId: stamp.workspaceId ?? undefined, threadId: stamp.threadId ?? undefined,
      ...(number ? { number } : {}), ...(creationOutcome ? { creationOutcome } : {}) } as RemoteWorkResult;
  }
}
