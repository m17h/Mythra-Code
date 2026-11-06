//! Reads a file the user just dropped on this window, so it can be sent to
//! another device. Only a path the operating system handed over in a real drop
//! can be read, once, soon after the drop, and only up to the upload limit.
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{ipc::Response, DragDropEvent, WebviewWindow, Window, WindowEvent};

const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_REMEMBERED: usize = 64;
const DROP_LIFETIME: Duration = Duration::from_secs(60);
const READ_WAIT: Duration = Duration::from_secs(60);

struct Dropped {
    window: String,
    path: PathBuf,
    at: Instant,
}

static DROPPED: Mutex<Vec<Dropped>> = Mutex::new(Vec::new());

/// Runs on the native event, before the page hears about the drop.
pub(crate) fn note_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event else {
        return;
    };
    let mut dropped = DROPPED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    dropped.retain(|entry| entry.at.elapsed() < DROP_LIFETIME);
    for path in paths.iter().take(MAX_REMEMBERED) {
        dropped.push(Dropped {
            window: window.label().to_owned(),
            path: path.clone(),
            at: Instant::now(),
        });
    }
    let excess = dropped.len().saturating_sub(MAX_REMEMBERED);
    dropped.drain(..excess);
}

fn claim(window: &str, path: &Path) -> bool {
    let mut dropped = DROPPED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    dropped.retain(|entry| entry.at.elapsed() < DROP_LIFETIME);
    let Some(index) = dropped
        .iter()
        .position(|entry| entry.window == window && entry.path == path)
    else {
        return false;
    };
    dropped.remove(index);
    true
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    const UNREADABLE: &str = "Mythra Code couldn't read that file. Check that it still exists and try again.";
    const TOO_LARGE: &str = "That file is over 50 MB, which is too large to send.";
    // Checked first: opening something that isn't a file can wait forever.
    let kind = std::fs::metadata(path).map_err(|_| UNREADABLE.to_owned())?;
    if !kind.is_file() {
        return Err("Only files can be sent. Drop the files inside that folder instead.".to_owned());
    }
    if kind.len() > MAX_FILE_BYTES {
        return Err(TOO_LARGE.to_owned());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| UNREADABLE.to_owned())?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNREADABLE.to_owned())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(TOO_LARGE.to_owned());
    }
    Ok(bytes)
}

#[tauri::command]
pub(crate) async fn remote_upload_read_dropped(
    window: WebviewWindow,
    path: String,
) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !claim(window.label(), &path) {
        return Err("That file is no longer available. Drop it again.".to_owned());
    }
    let read = tauri::async_runtime::spawn_blocking(move || read_bounded(&path));
    match tokio::time::timeout(READ_WAIT, read).await {
        Ok(Ok(result)) => result.map(Response::new),
        _ => Err("Reading that file took too long. Try again.".to_owned()),
    }
}
