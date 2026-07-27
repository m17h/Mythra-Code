export const OPENKIWI_COMPLETION_INSTRUCTIONS = [
  "Unless the user requests a specific output format, finish completed coding tasks with a concise, self-contained response.",
  "Lead with the outcome, then summarize meaningful changes, verification performed, and any remaining caveats or next steps.",
  "Do not repeat routine tool-by-tool narration in the final response.",
].join(" ");

export function withOpenKiwiCompletionInstructions(systemPrompt: string): string {
  const prompt = systemPrompt.trim();
  return prompt
    ? `${prompt}\n\n${OPENKIWI_COMPLETION_INSTRUCTIONS}`
    : OPENKIWI_COMPLETION_INSTRUCTIONS;
}
