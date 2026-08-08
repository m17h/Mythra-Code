export const OPENKIWI_COMPLETION_INSTRUCTIONS = [
  "Unless the user requests a specific output format, finish completed coding tasks with a concise, self-contained response.",
  "Lead with the outcome, then summarize meaningful changes, verification performed, and any remaining caveats or next steps.",
  "Do not repeat routine tool-by-tool narration in the final response.",
].join(" ");

export const OPENKIWI_DELEGATION_INSTRUCTIONS = [
  "OpenKiwi-managed sub-agent delegation is active for this conversation.",
  "When the user asks to spawn, use, or delegate work to sub-agents, use only the delegation tools provided by the OpenKiwi agent bridge (spawn_agent, agent_status, collect_agent, and cancel_agent; provider runtimes may prefix these tool names).",
  "The destinations configured in OpenKiwi are the authoritative sub-agent crew.",
  "Do not use this provider's native task, team, or agent-spawning features while the OpenKiwi agent bridge is available.",
].join(" ");

export function openKiwiDeveloperInstructions(delegationEnabled = false): string {
  return delegationEnabled
    ? `${OPENKIWI_COMPLETION_INSTRUCTIONS}\n\n${OPENKIWI_DELEGATION_INSTRUCTIONS}`
    : OPENKIWI_COMPLETION_INSTRUCTIONS;
}

export function withOpenKiwiCompletionInstructions(systemPrompt: string, delegationEnabled = false): string {
  const prompt = systemPrompt.trim();
  const internalInstructions = openKiwiDeveloperInstructions(delegationEnabled);
  return prompt
    ? `${prompt}\n\n${internalInstructions}`
    : internalInstructions;
}
