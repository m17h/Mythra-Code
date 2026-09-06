import type { Project, ProjectRunCommand } from "../types";

/** Bridge tool name a model uses to set or clear the Run button. */
export const RUN_COMMAND_TOOL = "set_project_run_command";

export const MAX_RUN_COMMAND_LENGTH = 4_000;
export const MAX_RUN_LABEL_LENGTH = 80;

/**
 * Normalizes one stored or proposed run command. Returns undefined for
 * anything that is not a non-empty command of a sane size, so a hand-edited
 * or model-supplied value can never leave the button half-configured.
 */
export function sanitizeProjectRunCommand(value: unknown, now = Date.now()): ProjectRunCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command || command.length > MAX_RUN_COMMAND_LENGTH) return undefined;
  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim().slice(0, MAX_RUN_LABEL_LENGTH) : "";
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now;
  return label ? { command, label, updatedAt } : { command, updatedAt };
}

/** Drops malformed run commands from persisted projects; everything else is untouched. */
export function sanitizeProjectRunOverrides(projects: Project[]): Project[] {
  return projects.map((project) => {
    if (!project.overrides || !("run" in project.overrides)) return project;
    const run = sanitizeProjectRunCommand(project.overrides.run);
    const overrides = { ...project.overrides };
    if (run) overrides.run = run;
    else delete overrides.run;
    return { ...project, overrides: Object.keys(overrides).length ? overrides : undefined };
  });
}

/** Short text for the button itself: the label when there is one, else the command. */
export function runCommandTitle(run: ProjectRunCommand | undefined, maxLength = 28): string {
  if (!run) return "";
  const text = run.label || run.command.replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * What a model is told about the Run button. Written once here so the Codex
 * developer instructions and the Claude/Cursor system prompt say the same
 * thing, including the current command, which the prompt is the only way to
 * learn (the bridge has no read tool on purpose: fewer round trips).
 */
export function runButtonInstructions(run: ProjectRunCommand | null | undefined): string {
  const current = run
    ? `It is currently set to run \`${run.command}\`${run.label ? ` (labelled “${run.label}”)` : ""}.`
    : "Nothing is set yet, so the button is greyed out.";
  return [
    "Mythra Code shows a Run button in the top bar of this project. Clicking it runs one saved shell command from the project folder in the app's Terminal panel, typically to build, start a dev server, or run the app.",
    current,
    `When the user asks you to set, change, or clear what the Run button does, call the mythra_agents tool ${RUN_COMMAND_TOOL} with the exact shell command (an empty command clears the button) and an optional short label.`,
    "The tool only saves the command; it does not run it. After saving, tell the user the Run button is ready and what it will run. Prefer one command that works from a fresh checkout, chaining steps with && when needed.",
  ].join(" ");
}
