//! Bounded project-file previews. Full attachment reads remain independent.
use std::{fs, path::Path};

use serde::Serialize;

const PREVIEW_BYTES: usize = 250_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilePreview {
    text: String,
    truncated: bool,
    binary: bool,
}

fn preview_sync(root: &str, path: &str) -> Result<FilePreview, String> {
    let root = Path::new(root);
    let selected = Path::new(path);
    if !root.is_absolute() || !selected.is_absolute() {
        return Err("File previews require an absolute project folder and file path".into());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if !root.is_dir() {
        return Err("The project folder is not a directory".into());
    }
    // Resolve existing in-project links, then let the anchored reader reject
    // parent/file replacements. A selected link outside the project is never
    // read. Explicit attachment delivery still uses its original selected path.
    let selected = fs::canonicalize(selected)
        .map_err(|error| format!("Could not open the selected file: {error}"))?;
    let relative = selected
        .strip_prefix(&root)
        .map_err(|_| "The selected file is outside the project folder")?
        .to_str()
        .ok_or("The selected filename cannot be previewed")?;
    // Reuse the cross-platform opened-handle scope checks and nonregular-file
    // rejection already used by Git inspection. Disk reading is bounded to
    // 512 KiB + one sentinel byte; only this smaller text prefix crosses IPC.
    let (mut bytes, source_truncated) =
        crate::git_inspection::safe_untracked_preview(&root, relative)?;
    let truncated = source_truncated || bytes.len() > PREVIEW_BYTES;
    bytes.truncate(PREVIEW_BYTES);
    let binary = |truncated| FilePreview {
        text: String::new(),
        truncated,
        binary: true,
    };
    if bytes.contains(&0) {
        return Ok(binary(truncated));
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_owned(),
        // A clipped UTF-8 character is not evidence of a binary file. Retain
        // complete characters only; invalid bytes inside the prefix stay binary.
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|error| error.to_string())?
                .to_owned()
        }
        Err(_) => return Ok(binary(truncated)),
    };
    Ok(FilePreview {
        text,
        truncated,
        binary: false,
    })
}

#[tauri::command]
pub(super) async fn preview_project_file(
    root: String,
    path: String,
) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || preview_sync(&root, &path))
        .await
        .map_err(|error| format!("Could not finish the file preview: {error}"))?
}
