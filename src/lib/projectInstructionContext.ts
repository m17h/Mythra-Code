import { invoke } from "@tauri-apps/api/core";
import type { InstructionFileDescriptor } from "./instructionFiles";

export interface ProjectInstructionSelection {
  projectInstructionsEnabled: boolean;
  /** Older saved runs did not select CLAUDE.md. */
  projectClaudeInstructionsEnabled?: boolean;
}

/** Resolve fresh project guidance only after authored skill resolution. Never persist this envelope. */
export async function appendProjectInstructionContext(
  prompt: string,
  projectPath: string | null | undefined,
  selection: ProjectInstructionSelection,
  assertCurrent?: () => void,
): Promise<string> {
  // A thread can move from a project into ordinary Chats. An explicit empty
  // snapshot also clears its prior app-selected file guidance on resume.
  const agentsEnabled = Boolean(projectPath) && selection.projectInstructionsEnabled === true;
  const claudeEnabled = Boolean(projectPath) && selection.projectClaudeInstructionsEnabled === true;

  assertCurrent?.();
  let files: InstructionFileDescriptor[] = [];
  try {
    if (agentsEnabled || claudeEnabled) {
      files = await invoke<InstructionFileDescriptor[]>("instruction_files_read_project", {
        projectPath,
        agentsEnabled,
        claudeEnabled,
      });
    }
  } catch (reason) {
    // Stop owns a preparation that was revoked during disk work, even when
    // that disk operation also failed. Never replace it with a read error.
    assertCurrent?.();
    throw reason;
  }
  assertCurrent?.();
  const selectedProviders = [agentsEnabled ? "codex" : null, claudeEnabled ? "claude" : null]
    .filter((provider): provider is InstructionFileDescriptor["provider"] => provider !== null);
  const sections: string[] = [];
  for (const provider of selectedProviders) {
    const name = provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
    const matches = files.filter((file) => file.provider === provider);
    if (matches.length !== 1) throw new Error(`Could not prepare project ${name}: the instruction reader did not return one file result.`);
    const file = matches[0];
    if (file.status === "missing" || file.status === "empty") continue;
    if (file.status !== "ready" || typeof file.content !== "string") {
      const reason = file.status === "tooLarge"
        ? "the selected project instruction files exceed the combined 32 KB limit"
        : file.status === "invalidUtf8" ? "the file is not valid UTF-8 text"
          : file.status === "outsideProject" ? "the file resolves outside the project folder"
            : file.status === "notRegularFile" ? "the path is not a regular file"
              : file.status === "invalidPath" ? "the project path is invalid"
                : "the file could not be read";
      throw new Error(`Could not prepare project ${name}: ${reason}. Update the file or disable its discovery in Settings before starting this turn.`);
    }
    if (file.content.trim()) sections.push(`Project ${file.name} (${JSON.stringify(file.path)}):\n${file.content}`);
  }
  const guidance = [
    "Current app-selected project guidance for this turn; replaces all prior app-selected project-file snapshots, including omitted files. Authored instructions remain independent. Skill selection was resolved separately.",
    // Cursor carries these envelopes as historical user messages on resume.
    // Explicit clears must therefore replace deleted/empty/disabled files too.
    ...(sections.length ? sections : ["No project-file guidance is selected."]),
  ].join("\n\n");
  return prompt ? `${prompt}\n\n${guidance}` : guidance;
}
