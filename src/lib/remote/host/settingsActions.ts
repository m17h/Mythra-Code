import type { HostSettingsActions } from "./workActions";
import { commitHostState } from "./stateCommit";
import { EXECUTION_PREFERENCES_KEY } from "./executionPreferences";
/** Host-owned preferences shared with the local pickers through adoption. */
export function createHostSettingsActions(): HostSettingsActions {
  return { async set(threadId, values, operation) {
    const keys = ["kiwi.threadModels", "kiwi.threadReasoning", "kiwi.threadSubagentSettings", EXECUTION_PREFERENCES_KEY];
    await commitHostState(operation, keys, (rows) => {
      const maps = Object.fromEntries(rows.map((row) => [row.key, row.value && typeof row.value === "object" && !Array.isArray(row.value) ? row.value : {}])) as Record<string, Record<string, unknown>>;
      const writes: Record<string, unknown> = {};
      if (values.model) writes[keys[0]] = { ...maps[keys[0]], [threadId]: values.model };
      if (values.effort) writes[keys[1]] = { ...maps[keys[1]], [threadId]: { reasoningEffort: values.effort, ultra: false } };
      if (values.subagents) writes[keys[2]] = { ...maps[keys[2]], [threadId]: {
        enabled: values.subagents.enabled, engine: values.subagents.engine, nativeMaxConcurrent: values.subagents.maxConcurrent,
        nativeOptions: values.subagents.nativeOptions, autoCompactTokens: values.subagents.autoCompactTokens } };
      const prior = maps[EXECUTION_PREFERENCES_KEY][threadId];
      const prefs = prior && typeof prior === "object" ? prior as Record<string, unknown> : {};
      writes[EXECUTION_PREFERENCES_KEY] = { ...maps[EXECUTION_PREFERENCES_KEY], [threadId]: {
        ...(values.permission !== undefined ? { permission: values.permission } : prefs.permission !== undefined ? { permission: prefs.permission } : {}),
        ...(values.serviceTier !== undefined ? { serviceTier: values.serviceTier } : prefs.serviceTier !== undefined ? { serviceTier: prefs.serviceTier } : {}),
        ...(values.subagents?.crew !== undefined ? { crew: values.subagents.crew } : prefs.crew !== undefined ? { crew: prefs.crew } : {}) } };
      return writes;
    });
    return { state: "accepted" };
  } };
}
