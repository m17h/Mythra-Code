//! Reads a file the user just dropped on this window, so it can be sent to
//! another device. The file is opened inside the native drop event, before the
//! page hears about it, and that open handle is what gets read, once, soon after,
//! up to the upload limit. The path is never opened again and links are refused,
//! so swapping it for a link at any later moment changes nothing.
use std::{
    fs::{File, OpenOptions},
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
const UNREADABLE: &str = "Mythra Code couldn't read that file. Check that it still exists and try again.";
const NOT_A_FILE: &str = "Only files can be sent. Drop the files inside that folder instead.";
const A_LINK: &str = "That's a shortcut to a file. Drop the file itself instead.";
const TOO_LARGE: &str = "That file is over 50 MB, which is too large to send.";

struct Dropped {
    window: String,
    path: PathBuf,
    at: Instant,
    /// Closed with this entry, so an unclaimed drop holds nothing for long.
    opened: Result<File, String>,
}

static DROPPED: Mutex<Vec<Dropped>> = Mutex::new(Vec::new());

/// Opens the path itself, never what it points at. `O_NONBLOCK` is there because a
/// named pipe would otherwise never finish opening on the event thread; a regular
/// file ignores it, and everything else is refused from the handle below.
fn open_regular(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| match std::fs::symlink_metadata(path) {
        // These look at the path only to word the refusal. Nothing is read through it.
        Ok(kind) if kind.file_type().is_symlink() => A_LINK.to_owned(),
        Ok(kind) if kind.is_dir() => NOT_A_FILE.to_owned(),
        _ => UNREADABLE.to_owned(),
    })?;
    let kind = file.metadata().map_err(|_| UNREADABLE.to_owned())?;
    if kind.file_type().is_symlink() {
        return Err(A_LINK.to_owned());
    }
    if !kind.is_file() {
        return Err(NOT_A_FILE.to_owned());
    }
    Ok(file)
}

/// Holds the open file for the page to claim. Everything is pinned by the time this returns.
fn remember(window: &str, paths: &[PathBuf]) {
    let mut dropped = DROPPED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    dropped.retain(|entry| entry.at.elapsed() < DROP_LIFETIME);
    for path in paths.iter().take(MAX_REMEMBERED) {
        dropped.push(Dropped {
            window: window.to_owned(),
            path: path.clone(),
            at: Instant::now(),
            opened: open_regular(path),
        });
    }
    let excess = dropped.len().saturating_sub(MAX_REMEMBERED);
    dropped.drain(..excess);
}

/// Runs on the native event, before the page hears about the drop. It opens here
/// and not on a worker, because a worker leaves a moment when no handle exists.
pub(crate) fn note_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
        remember(window.label(), paths);
    }
}

fn claim(window: &str, path: &Path) -> Option<Result<File, String>> {
    let mut dropped = DROPPED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    dropped.retain(|entry| entry.at.elapsed() < DROP_LIFETIME);
    let index = dropped
        .iter()
        .position(|entry| entry.window == window && entry.path == path)?;
    Some(dropped.remove(index).opened)
}

fn read_bounded(file: File) -> Result<Vec<u8>, String> {
    let kind = file.metadata().map_err(|_| UNREADABLE.to_owned())?;
    if kind.len() > MAX_FILE_BYTES {
        return Err(TOO_LARGE.to_owned());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
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
    let Some(opened) = claim(window.label(), Path::new(&path)) else {
        return Err("That file is no longer available. Drop it again.".to_owned());
    };
    let file = opened?;
    let read = tauri::async_runtime::spawn_blocking(move || read_bounded(file));
    match tokio::time::timeout(READ_WAIT, read).await {
        Ok(Ok(result)) => result.map(Response::new),
        _ => Err("Reading that file took too long. Try again.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mythra-drop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("folder");
        dir
    }

    #[cfg(unix)]
    #[test]
    fn swapping_the_path_for_a_link_after_the_drop_changes_nothing() {
        let dir = folder();
        let (dropped, secret) = (dir.join("dropped.txt"), dir.join("secret.txt"));
        fs::write(&dropped, "what was dropped").expect("file");
        fs::write(&secret, "not for sending").expect("file");
        let handle = open_regular(&dropped).expect("opens");
        fs::remove_file(&dropped).expect("remove");
        std::os::unix::fs::symlink(&secret, &dropped).expect("link");
        assert_eq!(read_bounded(handle).expect("reads"), b"what was dropped");
        let _ = fs::remove_dir_all(dir);
    }

    /// However long the page or a worker takes, the file was pinned inside the event.
    #[cfg(unix)]
    #[test]
    fn the_drop_itself_pins_the_file_so_a_delayed_read_cant_be_redirected() {
        let dir = folder();
        let (dropped, secret) = (dir.join("dropped.txt"), dir.join("secret.txt"));
        fs::write(&dropped, "what was dropped").expect("file");
        fs::write(&secret, "not for sending").expect("file");
        remember("delayed", &[dropped.clone()]);
        // Nothing has been scheduled or read yet when the path is swapped.
        fs::remove_file(&dropped).expect("remove");
        std::os::unix::fs::symlink(&secret, &dropped).expect("link");
        std::thread::sleep(Duration::from_millis(50));
        let handle = claim("delayed", &dropped).expect("claimed").expect("opened");
        assert_eq!(read_bounded(handle).expect("reads"), b"what was dropped");
        assert!(claim("delayed", &dropped).is_none(), "one read for one drop");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_refused_instead_of_followed() {
        let dir = folder();
        let (secret, link) = (dir.join("secret.txt"), dir.join("link.txt"));
        fs::write(&secret, "not for sending").expect("file");
        std::os::unix::fs::symlink(&secret, &link).expect("link");
        assert_eq!(open_regular(&link).expect_err("refused"), A_LINK);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_is_refused_with_a_useful_message() {
        let dir = folder();
        assert_eq!(open_regular(&dir).expect_err("refused"), NOT_A_FILE);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_named_pipe_never_hangs_the_open() {
        let dir = folder();
        let pipe = dir.join("pipe");
        let made = std::process::Command::new("mkfifo").arg(&pipe).status().expect("mkfifo");
        assert!(made.success());
        assert_eq!(open_regular(&pipe).expect_err("refused"), NOT_A_FILE);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_oversized_file_is_refused_without_reading_it() {
        let dir = folder();
        let path = dir.join("large.bin");
        let file = File::create(&path).expect("file");
        file.set_len(MAX_FILE_BYTES + 1).expect("size");
        assert_eq!(read_bounded(open_regular(&path).expect("opens")).expect_err("refused"), TOO_LARGE);
        let _ = fs::remove_dir_all(dir);
    }
}
