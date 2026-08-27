import { isWindowsPlatform } from "./platform";

/**
 * The single place that decides how a free-form user command string is handed
 * to the operating system. Every surface that runs one — the Workspace
 * Terminal, project actions, and workflow command steps — goes through here so
 * a Windows install never receives a `/bin/zsh` argv it cannot execute.
 *
 * macOS keeps a login shell so a user's `PATH` additions (Homebrew, nvm, asdf)
 * are visible exactly as they are in Terminal.app. Windows uses `cmd.exe`
 * rather than PowerShell because it needs no execution-policy exemption and
 * runs the same `npm test`-shaped commands users type into a project.
 */
export function shellCommand(
  command: string,
  platform?: string,
): string[] {
  return isWindowsPlatform(platform)
    // `/d` skips AutoRun registry commands, `/s` keeps the rest of the line
    // verbatim so quotes inside the user's command survive, `/c` runs and exits.
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/zsh", "-lc", command];
}

/** How the shell is named in UI copy, so labels match what actually runs. */
export function shellLabel(platform?: string): string {
  return isWindowsPlatform(platform) ? "Command Prompt" : "zsh";
}
