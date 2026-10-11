import { normalizedProjectPath } from "./paths";
import type { Provider } from "../types";

/** Renderer-only acknowledgement; never transcript or skill provenance. */
export interface PendingFirstPrompt {
  id: string;
  workspacePath: string;
  threadId?: string;
  provider: Provider;
  model: string;
  isolated: boolean;
  text: string;
  attachmentNames?: string[];
  status: "starting" | "stopping";
}

export function pendingFirstPromptForView(prompts: readonly PendingFirstPrompt[], threadId: string | null, workspacePath?: string, selectedAttemptId?: string | null): PendingFirstPrompt | undefined {
  return prompts.find((prompt) => prompt.workspacePath === normalizedProjectPath(workspacePath ?? "") && (threadId
    ? prompt.threadId === threadId
    : !prompt.threadId && prompt.id === selectedAttemptId));
}
