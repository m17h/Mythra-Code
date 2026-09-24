import type { Project, ProjectRunCommand } from "../types";
import { isWindowsPlatform } from "./platform";
import { shellCommandWithWindowsQuotes } from "./shellCommand";

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
  const setupCommand = typeof raw.setupCommand === "string" ? raw.setupCommand.trim() : "";
  if (setupCommand.length > MAX_RUN_COMMAND_LENGTH) return undefined;
  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim().slice(0, MAX_RUN_LABEL_LENGTH) : "";
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now;
  return { command, ...(setupCommand ? { setupCommand } : {}), ...(label ? { label } : {}), updatedAt };
}

/** Run setup and launch in one shell, preserving any environment activated by setup. */
export function projectRunShellCommand(run: ProjectRunCommand, platform?: string): string {
  if (!run.setupCommand) return run.command;
  if (isWindowsPlatform(platform)) {
    // CMD groups are not subshells, but wrapping either arbitrary command in
    // parentheses breaks otherwise valid arguments such as process.cwd().
    // The IF owns the rest of the line, including a launch with || fallback.
    // Check both sides of zero: Windows tools can return a negative exit code.
    return `${run.setupCommand} & if not errorlevel 0 (exit /b) else if errorlevel 1 (exit /b) else ${run.command}`;
  }
  // In zsh the launch group inherits setup's environment. A failed setup
  // cannot enter a launch-side fallback such as `run || recovery`.
  return `${run.setupCommand} && (${run.command})`;
}

/** Run a project recipe while keeping the Terminal's displayed command readable. */
export function projectRunExecCommand(run: ProjectRunCommand, platform?: string): string[] {
  return shellCommandWithWindowsQuotes(projectRunShellCommand(run, platform), platform);
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
    ? `It is currently set to run \`${run.command}\`${run.setupCommand ? ` after setup \`${run.setupCommand}\` before each launch` : ""}${run.label ? ` (labelled “${run.label}”)` : ""}.`
    : "Nothing is set yet, so the button is greyed out.";
  return [
    "Mythra Code shows a Run button in the top bar of this project. Clicking it runs one saved shell command from the project folder in the app's Terminal panel, typically to build, start a dev server, or run the app.",
    current,
    `When the user asks you to set, change, or clear what the Run button does, call the mythra_agents tool ${RUN_COMMAND_TOOL} with the exact shell command (an empty command clears the button), an optional short label, and an optional setupCommand. Saving alone does not run anything. Setup runs before every launch in the same shell and launch proceeds only after setup succeeds; make it idempotent and project-relative so fresh isolated worktrees can run. A nonempty command replaces the whole recipe, so include setupCommand when it is needed; omitting it clears the old setup.`,
    `When the user asks you to run, start, launch, or serve the project (for example so they can test it), start it with ${RUN_COMMAND_TOOL} and run: true instead of your own shell, so it runs in the app's Terminal panel where the user can watch it and stop it. Reuse the saved recipe when one exists and fits (pass an empty command with run: true); otherwise pass the command and setupCommand you would use, which also saves them so the button works next time. One-off checks such as tests, linters, or builds you need to read still belong in your own shell.`,
    "The tool returns the first seconds of output; report a quick failure to the user, otherwise tell them it is running and how to stop it. If setup changes directory, restore the project root before launch, for example with pushd app && npm install && popd.",
  ].join(" ");
}
