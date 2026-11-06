import type { Project } from "../../../types";
import { withRemoteStateCommit, recoverRemoteStateRows } from "../../storage";
import { nativeHostTransport, type HostTransport } from "./bridge";
import type { HostProjectRegistration } from "./projectNavigation";
import { nativeRefusal } from "./nativeActions";
import { HostReadError } from "./scope";
import { registerRemoteStateRecovery, type StampedRow } from "./stateCommit";
/** The native owner canonicalizes/deduplicates and writes kiwi.projects. This
 * adapter only owns the shared local persistence lane and row adoption. */
export function createHostProjectRegistration(transport: HostTransport = nativeHostTransport): HostProjectRegistration {
  return { register(selection, operation) {
    return withRemoteStateCommit(["kiwi.projects"], async (adopt) => {
      operation.assertAllowed();
      const stamp = { generation: operation.generation, device: operation.device, opId: operation.opId, opSeq: operation.opSeq, grantRevision: operation.grantRevision };
      const snapshot = await transport.invoke<{ rows: StampedRow[] }>("remote_state_snapshot", { stamp, keys: ["kiwi.projects"] });
      operation.assertAllowed();
      const row = snapshot.rows.find((row) => row.key === "kiwi.projects");
      if (!row) throw new HostReadError("uncertain", "The host project snapshot was not confirmed.");
      const args = { stamp, folderToken: selection.token, expectedRevision: row.revision };
      type Result = { result: { state: string; workspaceId: string }; rows: StampedRow[] };
      try {
        const reply = await transport.invoke<Result>("remote_projects_add", args);
        const projects = reply.rows?.find((row) => row.key === "kiwi.projects")?.value as Project[] | undefined;
        const project = projects?.find((project) => project.id === reply.result.workspaceId);
        if (reply.result.state !== "accepted" || !project) throw new Error("Missing accepted project rows");
        adopt("kiwi.projects", projects);
        return { state: "accepted", project };
      } catch (reason) {
        const error = nativeRefusal(reason);
        if (error.code === "uncertain") {
          registerRemoteStateRecovery(`${stamp.device}:${stamp.opId}`, async () => {
            const replay = await transport.invoke<Result>("remote_projects_add", args);
            if (replay.result.state !== "accepted" || !replay.rows?.some((row) => row.key === "kiwi.projects")) throw new Error("Project commit unconfirmed");
            recoverRemoteStateRows(replay.rows);
          });
          Object.assign(error, { holdRemoteState: true });
        }
        throw error;
      }
    });
  } };
}
