import type { ArchivedThread, Provider } from "../types";

/**
 * Archives created before provider metadata was added can still be identified
 * by the presence of OpenKiwi's locally persisted Claude transcript.
 */
export function providerForArchivedThread(
  record: Pick<ArchivedThread, "provider">,
  hasClaudeTranscript: boolean,
): Provider {
  return record.provider ?? (hasClaudeTranscript ? "claude" : "openai");
}
