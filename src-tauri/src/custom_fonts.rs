//! Custom chat fonts that users add from a font file.
//!
//! The chosen file is validated and copied into app data (`custom-fonts/`),
//! so the font keeps working if the original is moved or deleted. The
//! renderer reads the bytes back over IPC and registers them with the
//! FontFace API; no file path or asset-protocol scope is exposed.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{ipc::Response, AppHandle};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_FONT_BYTES: u64 = 20 * 1024 * 1024;
const FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedFont {
    /// Stored file name inside `custom-fonts/` (`<uuid>.<ext>`).
    file: String,
    /// A readable default name, taken from the original file name.
    name: String,
}

fn fonts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::release_qa::app_data_dir(app)
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?
        .join("custom-fonts"))
}

fn font_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    FONT_EXTENSIONS.contains(&extension.as_str()).then_some(extension)
}

/// TrueType, OpenType, WOFF and WOFF2 files start with a known signature.
fn has_font_signature(bytes: &[u8]) -> bool {
    matches!(bytes.get(..4), Some([0, 1, 0, 0]) | Some(b"true") | Some(b"OTTO") | Some(b"wOFF") | Some(b"wOF2"))
}

/// Only names this module created: `<uuid>.<font extension>`, no paths.
fn stored_font_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let valid = file.split_once('.').is_some_and(|(id, extension)| {
        FONT_EXTENSIONS.contains(&extension)
            && uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
    });
    if !valid {
        return Err("That custom font file name is not valid.".into());
    }
    Ok(fonts_dir(app)?.join(file))
}

fn validate_font_metadata(metadata: &std::fs::Metadata) -> Result<(), String> {
    if !metadata.is_file() {
        return Err("Choose a font file, not a folder or another type of file.".into());
    }
    if metadata.len() > MAX_FONT_BYTES {
        return Err("That font file is larger than 20 MB.".into());
    }
    Ok(())
}

async fn read_font_bytes(path: &Path, context: &str) -> Result<Vec<u8>, String> {
    // Reject special files before opening them (a pipe could otherwise wait
    // indefinitely), then validate the actual opened file as well.
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("{context}: {error}"))?;
    validate_font_metadata(&metadata)?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("{context}: {error}"))?;
    let metadata = file.metadata()
        .await
        .map_err(|error| format!("{context}: {error}"))?;
    validate_font_metadata(&metadata)?;
    // Metadata alone does not limit allocation if the file grows while read.
    // The extra byte lets us distinguish a 20 MB font from an oversized one.
    let mut bytes = Vec::new();
    file.take(MAX_FONT_BYTES + 1).read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("{context}: {error}"))?;
    if bytes.len() as u64 > MAX_FONT_BYTES {
        return Err("That font file is larger than 20 MB.".into());
    }
    if !has_font_signature(&bytes) {
        return Err("That file does not look like a font Mythra Code can use.".into());
    }
    Ok(bytes)
}

fn readable_font_name(path: &Path) -> String {
    let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("Custom font");
    let name = stem.replace(['-', '_'], " ").split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() { "Custom font".into() } else { name.chars().take(60).collect() }
}

#[tauri::command]
pub(crate) async fn custom_font_import(app: AppHandle, path: String) -> Result<ImportedFont, String> {
    let source = PathBuf::from(&path);
    let extension = font_extension(&source)
        .ok_or_else(|| "Choose a .ttf, .otf, .woff or .woff2 font file.".to_string())?;
    let bytes = read_font_bytes(&source, "Could not read the font file").await?;
    let directory = fonts_dir(&app)?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("Could not create the custom fonts folder: {error}"))?;
    let file = format!("{}.{extension}", uuid::Uuid::new_v4());
    let destination_path = directory.join(&file);
    let mut destination = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination_path)
        .await
        .map_err(|error| format!("Could not save the font: {error}"))?;
    let saved = async {
        destination.write_all(&bytes).await?;
        destination.flush().await
    }.await;
    drop(destination);
    if let Err(error) = saved {
        let _ = tokio::fs::remove_file(&destination_path).await;
        return Err(format!("Could not save the font: {error}"));
    }
    Ok(ImportedFont { file, name: readable_font_name(&source) })
}

#[tauri::command]
pub(crate) async fn custom_font_read(app: AppHandle, file: String) -> Result<Response, String> {
    let path = stored_font_path(&app, &file)?;
    let bytes = read_font_bytes(&path, "Could not load the custom font").await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub(crate) async fn custom_font_remove(app: AppHandle, file: String) -> Result<(), String> {
    let path = stored_font_path(&app, &file)?;
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the custom font: {error}")),
    }
}
