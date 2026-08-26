/**
 * How to read the `@` mentions Mythra Code's composer inserts. Kept apart from the
 * completion guidance below because it governs how a turn STARTS: buried at the
 * end of a paragraph about writing the final response, a skill request reads as
 * an afterthought.
 */
export const MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS = [
  "The user's message may contain @name mentions written in Mythra Code's composer.",
  "An exact @name token matching an available Mythra Code skill is an explicit instruction to load and follow that skill before doing the requested work.",
  "An @ mention naming a workspace path is a file reference, and any other @word is ordinary text: never invent a skill for one.",
].join(" ");

export const MYTHRA_CODE_COMPLETION_INSTRUCTIONS = [
  "Unless the user requests a specific output format, finish completed coding tasks with a concise, self-contained response.",
  "Lead with the outcome, then summarize meaningful changes, verification performed, and any remaining caveats or next steps.",
  "Do not repeat routine tool-by-tool narration in the final response.",
].join(" ");

/**
 * Codex can inject a native team runtime independently of the older feature
 * flags. Pinning a custom multi-agent mode keeps that second routing surface
 * out of Mythra Code threads; the MCP bridge remains the only authority that
 * can choose a provider/model destination.
 */
export const MYTHRA_CODE_NATIVE_DELEGATION_POLICY = [
  "Provider-native task, team, and agent spawning is disabled in Mythra Code.",
  "Never use collaboration.spawn_agent or another provider-native agent tool.",
  "When the mythra_agents MCP bridge exposes spawn_mythra_agent, use that uniquely named tool exclusively and obey its exact approved destination list; when it is absent, do not spawn sub-agents.",
].join(" ");

export const MYTHRA_CODE_DELEGATION_INSTRUCTIONS = [
  "Mythra Code-managed sub-agent delegation is active for this conversation.",
  "Always interpret a user request to spawn, use, or delegate work to sub-agents as a request for the Mythra Code-managed crew, and use only the mythra_agents MCP bridge tools (spawn_mythra_agent, agent_status, collect_agent, cancel_agent, and propose_agent_settings; provider runtimes may render them as mythra_agents.<tool> or mcp__mythra_agents__<tool>).",
  "The destinations configured in Mythra Code are the authoritative sub-agent crew.",
  "Provider-native task, team, and agent-spawning features are not allowed; Mythra Code is the only permitted delegation route.",
  "Read the spawn_mythra_agent tool description before delegating: it shows this thread's exact concurrent-agent limit and every approved destination ID, provider, model, and reasoning authority. Never assume or invent a destination that is not listed there.",
  "After spawning a child, always collect its result before finishing the task. If a child fails, read the returned error, recover by retrying with a corrected self-contained prompt or another approved destination, and do not silently abandon its assigned work.",
  "Retry a failed piece of delegated work at most twice; if it still fails, do that work yourself or report the failure and its error to the user instead of retrying again.",
  "If the user asks for a sub-agent destination or project crew change that is not already approved, submit propose_agent_settings, tell the user the project change is awaiting their approval in Mythra Code, and continue this turn only with the already-approved crew; never claim or use the proposed change in the current turn.",
].join(" ");

export const MYTHRA_CODE_SUBAGENT_SETTINGS_INSTRUCTIONS = [
  "This saved project exposes Mythra Code's user-approved sub-agent settings control.",
  "If the user asks to enable, disable, or change the project's sub-agent crew, models, reasoning, or parallel limit, use propose_agent_settings.",
  "The tool only queues an approval prompt: tell the user it is awaiting approval, and never claim or use the proposed settings in the current turn.",
].join(" ");

export function mythraCodeDeveloperInstructions(delegationEnabled = false, settingsProposalsEnabled = delegationEnabled): string {
  const sections = [MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS, MYTHRA_CODE_COMPLETION_INSTRUCTIONS];
  if (delegationEnabled) sections.push(MYTHRA_CODE_DELEGATION_INSTRUCTIONS);
  else if (settingsProposalsEnabled) sections.push(MYTHRA_CODE_SUBAGENT_SETTINGS_INSTRUCTIONS);
  return sections.join("\n\n");
}

export function withMythraCodeCompletionInstructions(systemPrompt: string, delegationEnabled = false, settingsProposalsEnabled = delegationEnabled): string {
  const prompt = systemPrompt.trim();
  const internalInstructions = mythraCodeDeveloperInstructions(delegationEnabled, settingsProposalsEnabled);
  return prompt
    ? `${prompt}\n\n${internalInstructions}`
    : internalInstructions;
}
