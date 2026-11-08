import type { Project } from "../../../types";
import { reorderProjects, toggleProjectPinned } from "../../projectOrdering";
import { commitHostState } from "./stateCommit";
import { HostReadError, idArg } from "./scope";
import type { HostMutationContext } from "./workActions";

/** Pure row state goes through the native CAS/adopt lane, not App's local setter. */
export async function executeRowState(op: string, args: Readonly<Record<string, unknown>>, operation: HostMutationContext): Promise<{ state: "accepted"; threadId?: string; workspaceId?: string } | undefined> {
  if (op !== "thread.pin" && op !== "projects.pin" && op !== "projects.reorder") return undefined;
  const threadId = operation.context.activeThread?.id, workspace = operation.context.activeWorkspace!;
  if (op === "thread.pin") {
    if (!threadId || typeof args.pinned !== "boolean") throw new HostReadError("unsupported", "A thread and pin choice are required.");
    await commitHostState(operation, ["kiwi.pinnedThreads"], (rows) => {
      const current = Array.isArray(rows[0].value) ? rows[0].value.filter((id): id is string => typeof id === "string") : [];
      const next = args.pinned ? current.includes(threadId) ? current : [...current, threadId] : current.filter((id) => id !== threadId);
      return { "kiwi.pinnedThreads": next };
    });
    return { state: "accepted", threadId };
  }
  await commitHostState(operation, ["kiwi.projects"], (rows) => {
    const projects = Array.isArray(rows[0].value) ? rows[0].value as Project[] : [];
    const target = projects.find((project) => project.id === workspace.id);
    if (!target || target.path !== workspace.path) throw new HostReadError("stale_target", "This project moved or was removed.");
    if (op === "projects.pin") {
      if (typeof args.pinned !== "boolean") throw new HostReadError("unsupported", "A pin choice is required.");
      return { "kiwi.projects": Boolean(target.pinned) === args.pinned ? projects : toggleProjectPinned(projects, target.id) };
    }
    const relativeTo = idArg(args.relativeTo), other = projects.find((project) => project.id === relativeTo);
    if (!other || other.isChat || other.id === target.id || Boolean(other.pinned) !== Boolean(target.pinned)
      || args.position !== "before" && args.position !== "after") throw new HostReadError("stale_target", "The target project order changed. Refresh the list.");
    return { "kiwi.projects": reorderProjects(projects, target.id, relativeTo, args.position) };
  });
  return { state: "accepted", workspaceId: workspace.id };
}
