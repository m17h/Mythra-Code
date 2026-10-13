use std::path::{Path, PathBuf};

fn validate_folder(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("This thread does not have an absolute working folder.".into());
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("Could not access the thread's folder: {error}"))?;
    if !metadata.is_dir() {
        return Err("The thread's working path is not a folder.".into());
    }
    Ok(())
}

fn open_folder(path: &Path) -> Result<(), String> {
    validate_folder(path)?;
    // Opening the directory itself enters it in Finder/Explorer; revealing it
    // would only select it in its parent. Keep file/URL opening out of this IPC.
    #[cfg(windows)]
    {
        // The generic Windows shell opener can block on COM/DDE (notably in
        // remote sessions). Launch Explorer directly, without a shell, PATH
        // lookup, console window, or waiting for the Explorer window to close.
        let explorer = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("explorer.exe");
        super::process_launch::background_std_command(explorer)
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not open the thread's folder: {error}"))
    }
    #[cfg(not(windows))]
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("Could not open the thread's folder: {error}"))
}

#[tauri::command]
pub(super) async fn open_workspace_folder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_folder(&PathBuf::from(path)))
        .await
        .map_err(|error| format!("Could not open the thread's folder: {error}"))?
}
