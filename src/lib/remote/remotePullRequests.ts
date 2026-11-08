import type { PullRequestBackend } from "../../hooks/useThreadPullRequest";
import type { CreatePullRequestResult, PullRequest, PullRequestListQuery, PullRequestMergeMethod, PullRequestSummary } from "../pullRequests";
import { namingDevice } from "./devices";
import { hostRead, hostWrite } from "./remoteActions";
import type { StudioTarget, WireCiStatus, WireGitHubAccess, WirePullRequestComment } from "./wire-studio";

const MAX_LIST = 50;
export interface RemotePullRequestScope { device: string; name: string; target: StudioTarget; revision: () => string }
export interface RemotePullRequests extends PullRequestBackend {
  access: () => Promise<WireGitHubAccess>;
  list: (query: PullRequestListQuery) => Promise<PullRequestSummary[]>;
  ci: (number: number) => Promise<WireCiStatus>;
  comments: (number: number) => Promise<{ comments: WirePullRequestComment[]; hasMore: boolean }>;
  comment: (repository: string, number: number, body: string) => Promise<void>;
}

/** The real pull request screens, pointed at another machine. It picks the repository
 * and checkout, so every `cwd` and `repository` passed in here is only a label. */
export function remotePullRequests({ device, name, target, revision }: RemotePullRequestScope): RemotePullRequests {
  const plain = (reason: unknown, fallback: string) => {
    const message = (reason as { message?: unknown } | null)?.message;
    return new Error(namingDevice(typeof message === "string" && message ? message : fallback, name));
  };
  const read = async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
    try { return await hostRead<T>(device, op, args); } catch (reason) { throw plain(reason, `Mythra Code couldn't reach GitHub through ${name}. Try again.`); }
  };
  const write = async <T = Record<string, unknown>>(op: string, args: Record<string, unknown>) => {
    const outcome = await hostWrite<T>(device, name, op, { ...target, revision: revision(), ...args });
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.result;
  };
  const view = async (number: number) => {
    const { pullRequest } = await read<{ pullRequest: PullRequest }>("github.pr.view", { ...target, number });
    return pullRequest;
  };
  /** Reads first, so a change always answers the head the person was looking at. */
  const unchanged = async (number: number, expectedHeadOid: string) => {
    if ((await view(number)).headOid !== expectedHeadOid) throw new Error("This pull request changed. Refresh it before trying again.");
  };
  const access = () => read<WireGitHubAccess>("github.pr.context", { ...target });
  return {
    access,
    context: async () => {
      const { context } = await access();
      if (!context) throw new Error(`This project isn't connected to GitHub on ${name}.`);
      return context;
    },
    find: async (_cwd, _repository, branch) => (await read<{ pullRequest: PullRequest | null }>("github.pr.find", { ...target, branch })).pullRequest,
    view: (_cwd, _repository, number) => view(number),
    list: async (query) => (await read<{ pullRequests: PullRequestSummary[] }>("github.pr.list", {
      workspaceId: target.workspaceId, ...(query.search ? { search: query.search } : {}), ...(query.state ? { state: query.state } : {}), limit: Math.min(query.limit ?? MAX_LIST, MAX_LIST),
    })).pullRequests,
    create: async (_cwd, _repository, input): Promise<CreatePullRequestResult> => {
      const { context } = await access();
      if (context?.headOid !== input.expectedHeadOid) throw new Error("This checkout changed. Refresh it before trying again.");
      const created = await write<{ number?: number; creationOutcome?: CreatePullRequestResult["creationOutcome"] }>("github.pr.create", {
        head: input.head, base: input.base, title: input.title, body: input.body, draft: input.draft, commitAll: input.commitAll, ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
      });
      if (!created?.number) throw new Error(`${name} didn't say which pull request it made. Refresh to find it.`);
      return { ...await view(created.number), creationOutcome: created.creationOutcome ?? "created" };
    },
    merge: async (_cwd, _repository, number, method: PullRequestMergeMethod, expectedHeadOid, auto) => {
      await unchanged(number, expectedHeadOid);
      await write("github.pr.merge", { number, method, auto, confirmed: true });
      return view(number);
    },
    ready: async (_cwd, _repository, number, expectedHeadOid) => {
      await unchanged(number, expectedHeadOid);
      await write("github.pr.ready", { number, confirmed: true });
      return view(number);
    },
    createBranch: async (_cwd, branch) => { await write("git.write", { action: "branch", name: branch, create: true }); },
    ci: (number) => read<WireCiStatus>("github.ci.status", { ...target, number }),
    comments: (number) => read("github.comments.list", { ...target, number }),
    comment: async (_repository, number, body) => {
      await view(number);
      await write("github.pr.comment", { number, body });
    },
  };
}
