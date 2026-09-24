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

function base64Utf16(value: string): string {
  let bytes = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    bytes += String.fromCharCode(unit & 0xff, unit >> 8);
  }
  return btoa(bytes);
}

/**
 * Use for saved project recipes passed as an argv array to Codex command/exec.
 * Its Windows process launcher escapes embedded quotes before CMD sees them:
 * `cd "folder with spaces"` then fails, and quoted setup can falsely succeed.
 * PowerShell transports the unchanged recipe and starts one CMD with a raw
 * command line, preserving its environment, output, and exit status.
 */
export function shellCommandWithWindowsQuotes(command: string, platform?: string): string[] {
  if (!isWindowsPlatform(platform)) return shellCommand(command, platform);
  if (command.includes("\0")) throw new Error("The command contains a null character.");
  const start = `;$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$env:ComSpec;$start.Arguments='/d /s /c "'+$command+'"';$start.UseShellExecute=$false;$process=[Diagnostics.Process]::Start($start);$process.WaitForExit();exit $process.ExitCode`;
  const direct = base64Utf16(`$ErrorActionPreference='Stop';$command='${command.replace(/'/g, "''")}'${start}`);
  // A quote-heavy recipe can make the direct string longer than its base64
  // form. Choose the shorter transport within Windows' process-argument cap.
  const utf8 = new TextEncoder().encode(command);
  let data = "";
  for (const byte of utf8) data += String.fromCharCode(byte);
  const encodedCommand = btoa(data);
  const nested = base64Utf16(`$ErrorActionPreference='Stop';$command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCommand}'))${start}`);
  const encoded = direct.length <= nested.length ? direct : nested;
  if (encoded.length > 30_000) throw new Error("The command is too long for Windows Command Prompt.");
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/** How the shell is named in UI copy, so labels match what actually runs. */
export function shellLabel(platform?: string): string {
  return isWindowsPlatform(platform) ? "Command Prompt" : "zsh";
}
