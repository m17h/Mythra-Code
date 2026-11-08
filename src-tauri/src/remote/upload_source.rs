//! Reads a file the user just dropped on this window, so it can be sent to
//! another device. The file is opened inside the native drop event, before the
//! page hears about it, and that open handle is what gets read, once, soon after,
//! up to the upload limit. The path is never opened again and links are refused,
//! so swapping it for a link at any later moment changes nothing.
//!
//! All of this only happens while a window is showing another device. A drop on a
//! window working locally is never looked at here.
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
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
/// Which windows are showing another device. A window's latest request wins, and
/// arm and disarm can arrive out of order, so each carries the page's own count.
static ARMED: Mutex<Option<HashMap<String, Arm>>> = Mutex::new(None);
/// At most one clearing timer exists, however many drops there are.
static CLEARING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
struct Arm {
    armed: bool,
    generation: u64,
}

fn drops() -> std::sync::MutexGuard<'static, Vec<Dropped>> {
    DROPPED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn is_armed(window: &str) -> bool {
    ARMED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(|windows| windows.get(window))
        .is_some_and(|arm| arm.armed)
}

/// Returns false when a newer request has already been seen.
fn set_armed(window: &str, armed: bool, generation: u64) -> bool {
    let mut windows = ARMED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let windows = windows.get_or_insert_with(HashMap::new);
    if windows
        .get(window)
        .is_some_and(|arm| arm.generation >= generation)
    {
        return false;
    }
    windows.insert(window.to_owned(), Arm { armed, generation });
    true
}

/// The window closed or its page started over, so nothing there can claim a file.
pub(crate) fn forget_window(window: &str) {
    if let Some(windows) = ARMED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_mut()
    {
        windows.remove(window);
    }
    drops().retain(|entry| entry.window != window);
}

/// Closes what has expired, and says how long until the next entry does.
fn sweep() -> Option<Duration> {
    let mut dropped = drops();
    dropped.retain(|entry| entry.at.elapsed() < DROP_LIFETIME);
    let next = dropped
        .iter()
        .map(|entry| DROP_LIFETIME.saturating_sub(entry.at.elapsed()))
        .min();
    // Cleared under the lock, so a drop added just after this starts a new timer.
    if next.is_none() {
        CLEARING.store(false, Ordering::SeqCst);
    }
    next
}

/// Unused handles close on time, whether or not anything else ever happens.
fn clear_when_expired() {
    if CLEARING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        let mut wait = DROP_LIFETIME;
        loop {
            tokio::time::sleep(wait).await;
            match sweep() {
                Some(next) => wait = next.max(Duration::from_millis(50)),
                None => return,
            }
        }
    });
}

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
    let mut dropped = drops();
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
    drop(dropped);
    clear_when_expired();
}

fn note_drop(window: &str, paths: &[PathBuf]) {
    if is_armed(window) {
        remember(window, paths);
    }
}

/// Runs on the native event, before the page hears about the drop. It opens here
/// and not on a worker, because a worker leaves a moment when no handle exists.
pub(crate) fn note_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            note_drop(window.label(), paths);
        }
        WindowEvent::Destroyed => forget_window(window.label()),
        _ => {}
    }
}

/// Turned on while this window shows another device, and off when it stops.
#[tauri::command]
pub(crate) fn remote_upload_arm(window: WebviewWindow, armed: bool, generation: u64) {
    if set_armed(window.label(), armed, generation) && !armed {
        let label = window.label();
        drops().retain(|entry| entry.window != label);
    }
}

fn claim(window: &str, path: &Path) -> Option<Result<File, String>> {
    let mut dropped = drops();
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

    #[test]
    fn a_window_working_locally_opens_and_keeps_nothing() {
        let dir = folder();
        let file = dir.join("local.txt");
        fs::write(&file, "local").expect("file");
        note_drop("never-armed", &[file.clone()]);
        assert!(claim("never-armed", &file).is_none());
        set_armed("was-remote", true, 1);
        set_armed("was-remote", false, 2);
        note_drop("was-remote", &[file.clone()]);
        assert!(claim("was-remote", &file).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_window_showing_a_device_captures_a_drop() {
        let dir = folder();
        let file = dir.join("sent.txt");
        fs::write(&file, "sent").expect("file");
        set_armed("viewer", true, 1);
        note_drop("viewer", &[file.clone()]);
        note_drop("other-window", &[file.clone()]);
        assert!(claim("other-window", &file).is_none());
        let handle = claim("viewer", &file).expect("claimed").expect("opened");
        assert_eq!(read_bounded(handle).expect("reads"), b"sent");
        forget_window("viewer");
        assert!(!is_armed("viewer"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_late_older_request_cant_undo_a_newer_one() {
        assert!(set_armed("order", true, 5));
        assert!(!set_armed("order", false, 4));
        assert!(is_armed("order"));
        forget_window("order");
        // A page that started over counts from the beginning again.
        assert!(set_armed("order", true, 1));
        forget_window("order");
    }

    #[test]
    fn leaving_the_device_or_closing_the_window_lets_go_of_the_files() {
        let dir = folder();
        let file = dir.join("kept.txt");
        fs::write(&file, "kept").expect("file");
        set_armed("leaving", true, 1);
        note_drop("leaving", &[file.clone()]);
        forget_window("leaving");
        assert!(claim("leaving", &file).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_timer_closes_a_handle_nobody_claimed() {
        let dir = folder();
        let file = dir.join("unclaimed.txt");
        fs::write(&file, "unclaimed").expect("file");
        let expired = Instant::now().checked_sub(DROP_LIFETIME + Duration::from_secs(1)).expect("time");
        let fresh = Instant::now();
        {
            let mut dropped = drops();
            dropped.push(Dropped { window: "sweep-old".into(), path: file.clone(), at: expired, opened: open_regular(&file) });
            dropped.push(Dropped { window: "sweep-new".into(), path: file.clone(), at: fresh, opened: open_regular(&file) });
        }
        let next = sweep().expect("one is still waiting");
        assert!(next <= DROP_LIFETIME);
        assert!(!drops().iter().any(|entry| entry.window == "sweep-old"), "gone without another drop or claim");
        assert!(claim("sweep-new", &file).is_some());
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

#[cfg(all(test, windows))]
mod windows_tests {
    use super::super::windows_tests::{junction, TempRoot};
    use super::*;

    #[test]
    fn windows_drop_handle_survives_path_replacement_and_is_window_scoped_once() {
        let temp = TempRoot::new("drops");
        let path = temp.0.join("é file & spaces.txt");
        let other = temp.0.join("different.txt");
        let old = temp.0.join("old.txt");
        std::fs::write(&path, b"native drop").unwrap();
        std::fs::write(&other, b"replacement fixture").unwrap();
        let window = format!("windows-drop-{}", uuid::Uuid::new_v4());
        assert!(set_armed(&window, true, 1));
        note_drop(&window, &[path.clone()]);
        std::fs::rename(&path, &old)
            .expect("default upload handle permits rename but preserves identity");
        std::fs::hard_link(&other, &path).unwrap();
        assert!(claim("another-window", &path).is_none());
        let file = claim(&window, &path)
            .expect("native drop ticket")
            .expect("held file");
        assert_eq!(read_bounded(file).unwrap(), b"native drop");
        assert!(claim(&window, &path).is_none());
        forget_window(&window);
    }

    #[test]
    fn windows_upload_refuses_directory_junction_and_bounds_real_file() {
        let temp = TempRoot::new("upload-types");
        let target = temp.0.join("folder");
        std::fs::create_dir(&target).unwrap();
        let link = temp.0.join("junction");
        junction(&link, &target);
        assert!(open_regular(&target).is_err());
        assert!(open_regular(&link).is_err());
        std::fs::remove_dir(&link).unwrap();
        let path = temp.0.join("too-large.bin");
        File::create(&path)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(
            matches!(read_bounded(open_regular(&path).unwrap()),Err(ref message) if message==TOO_LARGE)
        );
    }

    #[test]
    #[ignore = "requires Windows Developer Mode or symlink privilege; uses only owned fixture paths"]
    fn windows_upload_refuses_a_real_file_symlink() {
        let temp = TempRoot::new("file-symlink");
        let target = temp.0.join("target.txt");
        let link = temp.0.join("link.txt");
        std::fs::write(&target, b"not for upload through link").unwrap();
        std::os::windows::fs::symlink_file(&target, &link)
            .expect("symlink privilege needed for this opt-in test");
        assert!(open_regular(&link).is_err());
        std::fs::remove_file(&link).unwrap();
    }
}
