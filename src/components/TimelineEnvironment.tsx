import { createContext, useContext, type ComponentType, type ContextType, type ReactNode } from "react";
import { useStore } from "zustand";
import type { ChatMessage } from "../types";
import type { ThreadTaskState } from "../lib/taskStore";
import type { ChildMailbox } from "../lib/childAgentMailbox";
import type { SubAgentControls } from "./SubAgentControls";
import type { ParentRunTurnLabel } from "./ParentRunLine";

export interface TimelineTaskSnapshot {
  activeThreadId: string | null;
  tasks: Readonly<Record<string, Pick<ThreadTaskState, "messages" | "status" | "activeTurnId" | "agents" | "approvals" | "error"> | undefined>>;
}
export interface TimelineTaskSource {
  getState: () => TimelineTaskSnapshot;
  getInitialState: () => TimelineTaskSnapshot;
  subscribe: (listener: (state: TimelineTaskSnapshot, previous: TimelineTaskSnapshot) => void) => () => void;
}
export type MessageFeedbackOpener = ((trigger: HTMLElement) => void) | null;
export interface TimelineEnvironment {
  tasks?: TimelineTaskSource;
  mailbox?: {
    get: (childId: string) => ChildMailbox | undefined;
    subscribe: (childId: string, listener: () => void) => () => void;
  };
  queuedSteerLabel?: string;
  deliverSteerNow?: (threadId: string, turnId: string, runtimeId: string) => Promise<unknown>;
  Questions?: ComponentType<{ message: ChatMessage }>;
  MessageExtras?: ComponentType<{ message: ChatMessage }>;
  Feedback?: ComponentType<{ message: ChatMessage; children: (open: MessageFeedbackOpener) => ReactNode }>;
  Image?: ComponentType<{ path: string; name: string }>;
  openExternalUrl?: (url: string) => Promise<unknown>;
  /** False keeps a link as readable text, for addresses that mean another machine. */
  canOpenLink?: (url: string) => boolean;
  canEdit?: boolean;
  canApprove?: boolean;
  canOpenSkills?: boolean;
}

// There is intentionally no local fallback. An unwrapped descendant can display
// transcript text, but cannot observe or operate on this installation's data.
const INERT: TimelineEnvironment = Object.freeze({});
const EMPTY_TASKS: TimelineTaskSnapshot = { activeThreadId: null, tasks: {} };
const EMPTY_SOURCE: TimelineTaskSource = {
  getState: () => EMPTY_TASKS,
  getInitialState: () => EMPTY_TASKS,
  subscribe: () => () => {},
};
export const TimelineEnvironmentContext = createContext<TimelineEnvironment>(INERT);
// Independent contexts preserve existing update granularity: the clock must not
// invalidate message rows, nor should a parent label invalidate the whole log.
export const TimelineSubAgentControls = createContext<ContextType<typeof SubAgentControls>>(null);
export const TimelineSubAgentClock = createContext(0);
export const TimelineParentTurnLabel = createContext<ContextType<typeof ParentRunTurnLabel>>(null);
export const useTimelineEnvironment = () => useContext(TimelineEnvironmentContext);
export function useTimelineTask<T>(selector: (state: TimelineTaskSnapshot) => T): T {
  const environment = useTimelineEnvironment();
  return useStore(environment.tasks ?? EMPTY_SOURCE, selector);
}
