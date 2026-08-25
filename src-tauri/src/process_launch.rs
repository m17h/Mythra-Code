use std::{ffi::OsStr, process::Command as StdCommand};

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Build an asynchronous child-process command that cannot create a console
/// window on Windows. Mythra Code is a GUI application, but most of the tools it
/// drives (Codex, Claude, Cursor, Git, and GitHub CLI) are console programs.
/// Without this flag, Windows is allowed to attach a new console to each child
/// even when Mythra Code's own executable uses the Windows GUI subsystem.
pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

/// Build a command for an interactive provider login. Windows GUI processes
/// do not own a console, so an OAuth-capable CLI needs a new visible console
/// for prompts and browser-flow diagnostics. Other platforms keep their
/// existing terminal-specific login launchers.
#[cfg(windows)]
pub(crate) fn interactive_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NEW_CONSOLE);
    command
}

/// Synchronous counterpart to [`background_command`] for Git and process-tree
/// cleanup operations.
pub(crate) fn background_std_command(program: impl AsRef<OsStr>) -> StdCommand {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = StdCommand::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        StdCommand::new(program)
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::background_std_command;

    #[test]
    fn child_process_has_no_console_window() {
        let script = r#"
Add-Type -Namespace MythraCode -Name NativeMethods -MemberDefinition '
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  public static extern System.IntPtr GetConsoleWindow();
';
if ([MythraCode.NativeMethods]::GetConsoleWindow() -ne [System.IntPtr]::Zero) {
  exit 37
}
"#;
        let output = background_std_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .expect("launch the Windows no-console probe");
        assert!(
            output.status.success(),
            "child received a console window (status {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
