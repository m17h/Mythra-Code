/** What someone needs to be told the first time they look at another machine. Each
 * case says what's wrong and exactly what to do, in that order, without jargon. */
export type GuideAction = "addProject" | "openChats" | "checkAgain";
export interface RemoteGuide { kind: "opening" | "nothingShared" | "noProjects" | "noProviders" | "viewOnly" | "chooseProject"; title: string; body: string; actions: GuideAction[] }
const DEVICES = "Settings → Connections → Devices";

export function remoteGuide({ name, loading, workspaces, chosenWorkspace, providers, canWork, canAddProjects }: {
  name: string; loading: boolean;
  /** Null until the host has answered. */
  workspaces: readonly { isChat: boolean }[] | null;
  chosenWorkspace: boolean;
  /** Null until the host has answered for the chosen workspace. */
  providers: readonly { ready: boolean }[] | null;
  canWork: boolean; canAddProjects: boolean;
}): RemoteGuide | null {
  if (!workspaces || (loading && !workspaces.length)) return { kind: "opening", title: `Opening ${name}…`, body: "This usually takes a moment.", actions: [] };
  if (!workspaces.length) return { kind: "nothingShared", title: `Nothing on ${name} is shared with this device yet`,
    body: `On ${name}, open ${DEVICES}, choose this device, and pick what it can use. Then check again here.`, actions: ["checkAgain"] };
  const chats = workspaces.some((entry) => entry.isChat);
  if (!workspaces.some((entry) => !entry.isChat) && !chosenWorkspace) return { kind: "noProjects", title: `No projects on ${name} yet`,
    body: canAddProjects ? `Add a folder from ${name} to work on it from here.${chats ? " You can also start a normal chat." : ""}`
      : `Add a project on ${name} itself, or on ${name} turn on Work with all projects and Manage projects for this device in ${DEVICES}. Then check again here.`,
    actions: [...(canAddProjects ? ["addProject" as const] : []), ...(chats ? ["openChats" as const] : []), ...(canAddProjects ? [] : ["checkAgain" as const])] };
  if (!chosenWorkspace) return { kind: "chooseProject", title: `Choose a project on ${name}`, body: "Pick one on the left to see its threads.", actions: [] };
  if (providers && !providers.some((provider) => provider.ready)) return { kind: "noProviders", title: `${name} isn't signed in to an AI service yet`,
    body: `Work runs on ${name}, with its own accounts, so nothing can start until one is connected there. On ${name}, open Settings → Accounts & connections and sign in. Then check again here.`, actions: ["checkAgain"] };
  if (!canWork) return { kind: "viewOnly", title: `This device can look at ${name}, but not work on it`,
    body: `To send messages from here, on ${name} turn on Work for this device in ${DEVICES}.`, actions: ["checkAgain"] };
  return null;
}
