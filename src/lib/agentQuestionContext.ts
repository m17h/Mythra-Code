import { createContext } from "react";
import type { ChatMessage } from "../types";

export interface AgentQuestionSubmission { message: ChatMessage; answers: Record<string, string[]> }
export const AgentQuestionDelivery = createContext<{ threadId: string; send: (threadId: string, text: string, submission?: AgentQuestionSubmission) => Promise<boolean> } | null>(null);
