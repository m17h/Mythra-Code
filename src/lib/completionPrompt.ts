export const OPENKIWI_COMPLETION_INSTRUCTIONS = [
  "Unless the user requests a specific output format, finish completed coding tasks with a concise, self-contained response.",
  "Lead with the outcome, then summarize meaningful changes, verification performed, and any remaining caveats or next steps.",
  "Do not repeat routine tool-by-tool narration in the final response.",
].join(" ");

export const OPENKIWI_DELEGATION_INSTRUCTIONS = [
  "OpenKiwi-managed sub-agent delegation is active for this conversation.",
  "When the user asks to spawn, use, or delegate work to sub-agents, use only the delegation tools provided by the OpenKiwi agent bridge (spawn_agent, agent_status, collect_agent, cancel_agent, and propose_agent_settings; provider runtimes may prefix these tool names).",
  "The destinations configured in OpenKiwi are the authoritative sub-agent crew.",
  "Do not use this provider's native task, team, or agent-spawning features while the OpenKiwi agent bridge is available.",
  "After spawning a child, always collect its result before finishing the task. If a child fails, read the returned error, recover by retrying with a corrected self-contained prompt or another approved destination, and do not silently abandon its assigned work.",
  "Retry a failed piece of delegated work at most twice; if it still fails, do that work yourself or report the failure and its error to the user instead of retrying again.",
  "If the user asks for a sub-agent destination or project crew change that is not already approved, submit propose_agent_settings, tell the user the project change is awaiting their approval in OpenKiwi, and continue this turn only with the already-approved crew; never claim or use the proposed change in the current turn.",
].join(" ");

export const OPENKIWI_SUBAGENT_SETTINGS_INSTRUCTIONS = [
  "This saved project exposes OpenKiwi's user-approved sub-agent settings control.",
  "If the user asks to enable, disable, or change the project's sub-agent crew, models, reasoning, or parallel limit, use propose_agent_settings.",
  "The tool only queues an approval prompt: tell the user it is awaiting approval, and never claim or use the proposed settings in the current turn.",
].join(" ");

export function openKiwiDeveloperInstructions(delegationEnabled = false, settingsProposalsEnabled = delegationEnabled): string {
  const sections = [OPENKIWI_COMPLETION_INSTRUCTIONS];
  if (delegationEnabled) sections.push(OPENKIWI_DELEGATION_INSTRUCTIONS);
  else if (settingsProposalsEnabled) sections.push(OPENKIWI_SUBAGENT_SETTINGS_INSTRUCTIONS);
  return sections.join("\n\n");
}

export function withOpenKiwiCompletionInstructions(systemPrompt: string, delegationEnabled = false, settingsProposalsEnabled = delegationEnabled): string {
  const prompt = systemPrompt.trim();
  const internalInstructions = openKiwiDeveloperInstructions(delegationEnabled, settingsProposalsEnabled);
  return prompt
    ? `${prompt}\n\n${internalInstructions}`
    : internalInstructions;
}
