//! Explicit, bounded instruction-file imports. This does not reproduce native
//! provider discovery: no ancestor/nested search, fallback-name configuration,
//! imports, rules directories, or execution. Global instruction-file writes
//! happen only through the explicit save command, bound to a fresh revision.
use std::{
    env, fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const MAX_FILE_BYTES: usize = 32 * 1024;
const MAX_PROJECT_BYTES: usize = 32 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_ACL_BYTES: usize = 64 * 1024;

struct SaveState {
    // Keep an explicitly edited override bound to itself after the user empties
    // it. Discovery may now prefer AGENTS.md, but saving must never switch files.
    emptied_codex_override: Option<(String, String)>,
}

static GLOBAL_SAVE_STATE: tokio::sync::Mutex<SaveState> =
    tokio::sync::Mutex::const_new(SaveState { emptied_codex_override: None });

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum InstructionFileStatus {
    Ready,
    Missing,
    Empty,
    Unreadable,
    TooLarge,
    InvalidUtf8,
    InvalidPath,
    OutsideProject,
    NotRegularFile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InstructionFileDescriptor {
    pub(super) provider: &'static str,
    pub(super) path: String,
    pub(super) name: String,
    pub(super) content: Option<String>,
    pub(super) revision: Option<String>,
    pub(super) status: InstructionFileStatus,
    pub(super) error: Option<String>,
}

struct ReadFailure {
    status: InstructionFileStatus,
    message: &'static str,
}

impl ReadFailure {
    fn new(status: InstructionFileStatus, message: &'static str) -> Self {
        Self { status, message }
    }

    fn from_io(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::new(
                InstructionFileStatus::Missing,
                "The instruction file does not exist.",
            ),
            io::ErrorKind::PermissionDenied => Self::new(
                InstructionFileStatus::Unreadable,
                "Permission was denied while reading the instruction file.",
            ),
            _ => Self::new(
                InstructionFileStatus::Unreadable,
                "The instruction file could not be opened or read.",
            ),
        }
    }
}

fn descriptor(provider: &'static str, path: &Path, global: bool) -> InstructionFileDescriptor {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(if provider == "codex" {
            "AGENTS.md"
        } else {
            "CLAUDE.md"
        });
    let display = path.to_string_lossy();
    InstructionFileDescriptor {
        provider,
        path: if display.len() <= MAX_PATH_BYTES {
            display.into_owned()
        } else {
            String::new()
        },
        name: if global {
            format!("Global {filename}")
        } else {
            filename.to_owned()
        },
        content: None,
        revision: None,
        status: InstructionFileStatus::Missing,
        error: None,
    }
}

fn fail(mut item: InstructionFileDescriptor, failure: ReadFailure) -> InstructionFileDescriptor {
    item.content = None;
    item.revision = None;
    item.status = failure.status;
    item.error = Some(failure.message.to_owned());
    item
}

fn check_path(path: &Path) -> Result<(), ReadFailure> {
    if !path.is_absolute() || path.as_os_str().len() > MAX_PATH_BYTES || path.to_str().is_none() {
        return Err(ReadFailure::new(
            InstructionFileStatus::InvalidPath,
            "The instruction-file path must be an absolute UTF-8 path within the path limit.",
        ));
    }
    Ok(())
}

fn ensure_regular(metadata: &fs::Metadata) -> Result<(), ReadFailure> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ReadFailure::new(
            InstructionFileStatus::NotRegularFile,
            "Only regular instruction files can be read.",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Reject every reparse-point kind, including junctions and other kinds
        // that are not reported as ordinary symbolic links.
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(ReadFailure::new(
                InstructionFileStatus::NotRegularFile,
                "Only regular instruction files can be read.",
            ));
        }
    }
    Ok(())
}

struct FileSnapshot {
    content: String,
    revision: String,
    resolved: PathBuf,
    metadata: fs::Metadata,
}

fn snapshot_identity(file: &fs::File, metadata: &fs::Metadata) -> Result<Vec<u8>, ReadFailure> {
    let mut identity = Vec::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        for value in [metadata.dev(), metadata.ino(), metadata.len(), metadata.mode() as u64,
            metadata.uid() as u64, metadata.gid() as u64, metadata.nlink(),
            metadata.mtime() as u64, metadata.mtime_nsec() as u64,
            metadata.ctime() as u64, metadata.ctime_nsec() as u64] {
            identity.extend_from_slice(&value.to_le_bytes());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(ReadFailure::from_io(io::Error::last_os_error()));
        }
        for value in [info.dwVolumeSerialNumber as u64, info.nFileIndexHigh as u64,
            info.nFileIndexLow as u64, info.nNumberOfLinks as u64, metadata.file_size(),
            metadata.file_attributes() as u64, metadata.creation_time(), metadata.last_write_time()] {
            identity.extend_from_slice(&value.to_le_bytes());
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (file, metadata);
        return Err(ReadFailure::new(InstructionFileStatus::Unreadable,
            "Safe instruction-file revisions are unavailable on this platform."));
    }
    Ok(identity)
}

fn read_handle_snapshot(file: &mut fs::File, resolved: &Path) -> Result<FileSnapshot, ReadFailure> {
    let metadata = file.metadata().map_err(ReadFailure::from_io)?;
    ensure_regular(&metadata)?;
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(ReadFailure::new(
            InstructionFileStatus::TooLarge,
            "The instruction file exceeds the 32 KiB limit; no content was imported.",
        ));
    }
    let identity = snapshot_identity(file, &metadata)?;
    file.seek(SeekFrom::Start(0)).map_err(ReadFailure::from_io)?;
    let mut bytes = vec![0u8; MAX_FILE_BYTES + 1];
    let mut count = 0;
    while count < bytes.len() {
        match file.read(&mut bytes[count..]) {
            Ok(0) => break,
            Ok(read) => count += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(ReadFailure::from_io(error)),
        }
    }
    if count > MAX_FILE_BYTES {
        return Err(ReadFailure::new(
            InstructionFileStatus::TooLarge,
            "The instruction file exceeds the 32 KiB limit; no content was imported.",
        ));
    }
    bytes.truncate(count);
    let after = file.metadata().map_err(ReadFailure::from_io)?;
    if snapshot_identity(file, &after)? != identity {
        return Err(ReadFailure::new(InstructionFileStatus::Unreadable,
            "The instruction file changed while it was being read. Reload it before editing."));
    }
    let mut hash = Sha256::new();
    hash.update(b"mythra-global-instruction-revision-v1\0");
    let path = resolved.to_str().ok_or_else(|| ReadFailure::new(
        InstructionFileStatus::InvalidPath, "The instruction-file path is not valid UTF-8."))?;
    hash.update((path.len() as u64).to_le_bytes());
    hash.update(path.as_bytes());
    hash.update(identity);
    hash.update(&bytes);
    let revision = format!("{:x}", hash.finalize());
    let content = String::from_utf8(bytes).map_err(|_| {
        ReadFailure::new(InstructionFileStatus::InvalidUtf8,
            "The instruction file is not valid UTF-8; no content was imported.")
    })?;
    Ok(FileSnapshot { content, revision, resolved: resolved.to_path_buf(), metadata: after })
}

fn read_snapshot(path: &Path, root: Option<&Path>) -> Result<FileSnapshot, ReadFailure> {
    check_path(path)?;
    // Resolve a selected symlink once, then open its resolved target without
    // following replacement links. Project scope is checked before any read.
    let resolved = fs::canonicalize(path).map_err(ReadFailure::from_io)?;
    check_path(&resolved)?;
    if let Some(root) = root {
        if !resolved.starts_with(root) {
            return Err(ReadFailure::new(
                InstructionFileStatus::OutsideProject,
                "The instruction file resolves outside the selected project folder.",
            ));
        }
    }
    let metadata = fs::symlink_metadata(&resolved).map_err(ReadFailure::from_io)?;
    ensure_regular(&metadata)?;
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(ReadFailure::new(
            InstructionFileStatus::TooLarge,
            "The instruction file exceeds the 32 KiB limit; no content was imported.",
        ));
    }
    let mut file = open_resolved_file(&resolved, root)?;
    read_handle_snapshot(&mut file, &resolved)
}

#[cfg(unix)]
fn open_resolved_file(path: &Path, root: Option<&Path>) -> Result<fs::File, ReadFailure> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    };
    use std::path::Component;

    let file_flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    if let Some(root) = root {
        path.strip_prefix(root).map_err(|_| {
            ReadFailure::new(
                InstructionFileStatus::OutsideProject,
                "The instruction file resolves outside the selected project folder.",
            )
        })?;
    }
    let relative = path.strip_prefix(Path::new("/")).map_err(|_| {
        ReadFailure::new(
            InstructionFileStatus::InvalidPath,
            "The instruction-file path must be absolute.",
        )
    })?;
    // Directory traversal requires search permission, not permission to list
    // every ancestor's contents. Keep the handles usable by openat.
    #[cfg(target_os = "macos")]
    let directory_access = libc::O_SEARCH;
    #[cfg(target_os = "linux")]
    let directory_access = libc::O_PATH;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let directory_access = libc::O_RDONLY;
    let directory_flags = directory_access
        | libc::O_DIRECTORY
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC;
    // Anchor at the filesystem root and reject links in every resolved path
    // component, including ancestors of the project/configuration directory.
    // O_NOFOLLOW on a full root path alone does not protect its ancestors.
    let mut parent = fs::OpenOptions::new()
        .read(true)
        .custom_flags(directory_flags)
        .open(Path::new("/"))
        .map_err(ReadFailure::from_io)?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(ReadFailure::new(
                InstructionFileStatus::InvalidPath,
                "The instruction-file path is invalid.",
            ));
        };
        let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| {
            ReadFailure::new(
                InstructionFileStatus::InvalidPath,
                "The instruction-file path is invalid.",
            )
        })?;
        let flags = if components.peek().is_some() {
            directory_flags
        } else {
            file_flags
        };
        // Every component is relative to a retained directory handle. Neither
        // renamed parents nor replacement links can redirect the read.
        let handle = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if handle < 0 {
            return Err(ReadFailure::from_io(io::Error::last_os_error()));
        }
        let file = unsafe { fs::File::from_raw_fd(handle) };
        if components.peek().is_none() {
            return Ok(file);
        }
        parent = file;
    }
    Err(ReadFailure::new(
        InstructionFileStatus::NotRegularFile,
        "Only regular instruction files can be read.",
    ))
}

#[cfg(windows)]
fn windows_handle_path(file: &fs::File) -> Result<PathBuf, ReadFailure> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    let mut buffer = vec![0u16; 512];
    loop {
        let count = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if count == 0 {
            return Err(ReadFailure::from_io(io::Error::last_os_error()));
        }
        if count as usize >= buffer.len() {
            if count as usize > MAX_PATH_BYTES {
                return Err(ReadFailure::new(
                    InstructionFileStatus::InvalidPath,
                    "The instruction-file path exceeds the path limit.",
                ));
            }
            buffer.resize(count as usize + 1, 0);
            continue;
        }
        buffer.truncate(count as usize);
        return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
    }
}

#[cfg(windows)]
fn open_resolved_file(path: &Path, root: Option<&Path>) -> Result<fs::File, ReadFailure> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    let root_handle = match root {
        Some(root) => {
            let directory = fs::OpenOptions::new()
                .read(true)
                .share_mode(7)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(root)
                .map_err(ReadFailure::from_io)?;
            let metadata = directory.metadata().map_err(ReadFailure::from_io)?;
            if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
                return Err(ReadFailure::new(
                    InstructionFileStatus::InvalidPath,
                    "The selected project folder changed or could not be opened safely.",
                ));
            }
            if windows_handle_path(&directory)? != root {
                return Err(ReadFailure::new(
                    InstructionFileStatus::OutsideProject,
                    "The selected project folder changed or left its resolved location.",
                ));
            }
            Some(directory)
        }
        None => None,
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(7)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(ReadFailure::from_io)?;
    ensure_regular(&file.metadata().map_err(ReadFailure::from_io)?)?;
    let actual_file = windows_handle_path(&file)?;
    if root.is_none() && actual_file != path {
        return Err(ReadFailure::new(
            InstructionFileStatus::InvalidPath,
            "The instruction file changed or left its resolved location.",
        ));
    }
    if let (Some(root), Some(directory)) = (root, root_handle.as_ref()) {
        let actual_root = windows_handle_path(directory)?;
        let relative = path.strip_prefix(root).map_err(|_| {
            ReadFailure::new(
                InstructionFileStatus::OutsideProject,
                "The instruction file resolves outside the selected project folder.",
            )
        })?;
        if !actual_file.starts_with(&actual_root) || actual_file != actual_root.join(relative) {
            return Err(ReadFailure::new(
                InstructionFileStatus::OutsideProject,
                "The instruction file changed or left the selected project folder.",
            ));
        }
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_resolved_file(_path: &Path, _root: Option<&Path>) -> Result<fs::File, ReadFailure> {
    Err(ReadFailure::new(
        InstructionFileStatus::Unreadable,
        "Safe instruction-file reads are unavailable on this platform.",
    ))
}

fn read_descriptor(
    provider: &'static str,
    path: &Path,
    global: bool,
    root: Option<&Path>,
) -> InstructionFileDescriptor {
    let mut item = descriptor(provider, path, global);
    match read_snapshot(path, root) {
        Ok(snapshot) => {
            item.status = if snapshot.content.trim().is_empty() {
                InstructionFileStatus::Empty
            } else {
                InstructionFileStatus::Ready
            };
            item.content = Some(snapshot.content);
            item.revision = Some(snapshot.revision);
            item
        }
        Err(error) => fail(item, error),
    }
}

fn read_codex(directory: &Path, global: bool, root: Option<&Path>) -> InstructionFileDescriptor {
    let override_file = read_descriptor("codex", &directory.join("AGENTS.override.md"), global, root);
    if !matches!(
        override_file.status,
        InstructionFileStatus::Missing | InstructionFileStatus::Empty
    ) {
        return override_file;
    }
    let base = read_descriptor("codex", &directory.join("AGENTS.md"), global, root);
    if base.status == InstructionFileStatus::Missing
        && override_file.status == InstructionFileStatus::Empty
    {
        override_file
    } else {
        base
    }
}

fn config_directory(
    variable: &str,
    default: &str,
    home: Option<&Path>,
) -> Result<PathBuf, ReadFailure> {
    let configured = env::var_os(variable).filter(|value| !value.is_empty());
    let path = match configured {
        Some(value) => {
            if value.len() > MAX_PATH_BYTES {
                return Err(ReadFailure::new(
                    InstructionFileStatus::InvalidPath,
                    "The configured instruction directory exceeds the path limit.",
                ));
            }
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                env::current_dir().map_err(ReadFailure::from_io)?.join(path)
            }
        }
        None => home
            .ok_or_else(|| {
                ReadFailure::new(
                    InstructionFileStatus::InvalidPath,
                    "The home directory could not be determined.",
                )
            })?
            .join(default),
    };
    check_path(&path)?;
    Ok(path)
}

fn discover_globals_sync(app: &AppHandle) -> Vec<InstructionFileDescriptor> {
    // Tauri's home resolver handles native macOS/Windows home directories;
    // explicit provider environment directories do not depend on its success.
    let home = app.path().home_dir().ok();
    [
        ("codex", "CODEX_HOME", ".codex", "AGENTS.md"),
        ("claude", "CLAUDE_CONFIG_DIR", ".claude", "CLAUDE.md"),
    ]
    .into_iter()
    .map(|(provider, variable, default, filename)| {
        match config_directory(variable, default, home.as_deref()) {
            Ok(directory) if provider == "codex" => read_codex(&directory, true, None),
            Ok(directory) => read_descriptor(provider, &directory.join(filename), true, None),
            Err(error) => fail(descriptor(provider, Path::new(filename), true), error),
        }
    })
    .collect()
}

fn conflict() -> String {
    "GLOBAL_INSTRUCTION_CONFLICT: The original instruction file or selected source changed. Reload it before saving; your draft has not been written.".to_owned()
}

fn save_error() -> String {
    "The global instruction file could not be saved safely. Check its permissions and reload it before trying again.".to_owned()
}

fn saved_reload_error() -> String {
    "GLOBAL_INSTRUCTION_SAVED_RELOAD: The file was saved, but its new revision could not be confirmed. Reload before making further edits.".to_owned()
}

fn read_global_sync(
    app: &AppHandle,
    provider: &str,
    selected_path: &str,
    pinned: &mut Option<(String, String)>,
) -> Result<InstructionFileDescriptor, String> {
    let provider = match provider {
        "codex" => "codex",
        "claude" => "claude",
        _ => return Err("Unknown global instruction-file provider.".to_owned()),
    };
    let path = Path::new(selected_path);
    check_path(path).map_err(|_| "The selected global instruction-file path is invalid.".to_owned())?;
    let home = app.path().home_dir().ok();
    let (variable, default) = if provider == "codex" {
        ("CODEX_HOME", ".codex")
    } else {
        ("CLAUDE_CONFIG_DIR", ".claude")
    };
    let directory = config_directory(variable, default, home.as_deref())
        .map_err(|_| "The configured global instruction directory could not be resolved.".to_owned())?;
    let allowed = if provider == "codex" {
        path == directory.join("AGENTS.md") || path == directory.join("AGENTS.override.md")
    } else {
        path == directory.join("CLAUDE.md")
    };
    if !allowed {
        return Err("Only a configured provider's known global instruction file can be reloaded.".to_owned());
    }
    let snapshot = read_snapshot(path, None)
        .map_err(|_| "The selected global instruction file could not be reloaded safely.".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if snapshot.metadata.uid() != unsafe { libc::geteuid() } || snapshot.metadata.nlink() != 1 {
            return Err("Only instruction files owned by this user with a single file binding can be edited safely.".to_owned());
        }
    }
    let empty = snapshot.content.trim().is_empty();
    if provider == "codex" && path == directory.join("AGENTS.override.md") {
        *pinned = if empty { Some((selected_path.to_owned(), snapshot.revision.clone())) } else { None };
    }
    let mut result = descriptor(provider, path, true);
    result.status = if empty { InstructionFileStatus::Empty } else { InstructionFileStatus::Ready };
    result.content = Some(snapshot.content);
    result.revision = Some(snapshot.revision);
    Ok(result)
}

fn validate_global_binding(
    directory: &Path,
    provider: &'static str,
    path: &Path,
    expected_revision: &str,
    pinned: &Option<(String, String)>,
) -> Result<FileSnapshot, String> {
    let allowed = if provider == "codex" {
        path == directory.join("AGENTS.md") || path == directory.join("AGENTS.override.md")
    } else {
        path == directory.join("CLAUDE.md")
    };
    if !allowed {
        return Err("Only the selected provider's discovered global instruction file can be edited.".to_owned());
    }
    let effective = if provider == "codex" {
        read_codex(directory, true, None)
    } else {
        read_descriptor("claude", &directory.join("CLAUDE.md"), true, None)
    };
    let pinned_override = provider == "codex"
        && path == directory.join("AGENTS.override.md")
        && pinned.as_ref().is_some_and(|(selected, revision)| {
            Path::new(selected) == path && revision == expected_revision
        });
    if (Path::new(&effective.path) != path && !pinned_override)
        || (!pinned_override && !matches!(effective.status,
            InstructionFileStatus::Ready | InstructionFileStatus::Empty))
    {
        return Err(conflict());
    }
    let snapshot = read_snapshot(path, None).map_err(|_| conflict())?;
    if snapshot.revision != expected_revision {
        return Err(conflict());
    }
    if snapshot.metadata.permissions().readonly() {
        return Err("The original global instruction file is read-only; its permissions were not changed.".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if snapshot.metadata.uid() != unsafe { libc::geteuid() } || snapshot.metadata.nlink() != 1 {
            return Err("Only instruction files owned by this user with a single file binding can be edited safely.".to_owned());
        }
    }
    Ok(snapshot)
}

fn save_global_sync(
    app: &AppHandle,
    provider: &str,
    selected_path: &str,
    content: &str,
    expected_revision: &str,
    pinned: &mut Option<(String, String)>,
) -> Result<InstructionFileDescriptor, String> {
    let provider = match provider {
        "codex" => "codex",
        "claude" => "claude",
        _ => return Err("Unknown global instruction-file provider.".to_owned()),
    };
    if content.len() > MAX_FILE_BYTES {
        return Err("Global instruction files must be 32 KiB or smaller; the original file was not changed.".to_owned());
    }
    if expected_revision.len() != 64 || !expected_revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(conflict());
    }
    let path = Path::new(selected_path);
    check_path(path).map_err(|_| "The selected global instruction-file path is invalid.".to_owned())?;
    let home = app.path().home_dir().ok();
    let (variable, default) = if provider == "codex" {
        ("CODEX_HOME", ".codex")
    } else {
        ("CLAUDE_CONFIG_DIR", ".claude")
    };
    let directory = config_directory(variable, default, home.as_deref()).map_err(|_| save_error())?;
    let snapshot = validate_global_binding(&directory, provider, path, expected_revision, pinned)?;
    let validate = || {
        let current = validate_global_binding(&directory, provider, path, expected_revision, pinned)?;
        if current.resolved != snapshot.resolved {
            return Err(conflict());
        }
        Ok(())
    };
    // OS filesystems do not offer a portable conditional rename. This last
    // revision check catches observed external changes; non-cooperating writers
    // can still race the final check/replace. The async mutex serializes all
    // saves from this application, and retained parent handles prevent redirects.
    let saved = atomic_replace_global(&snapshot, content.as_bytes(), validate)?;
    if saved.content != content {
        return Err(saved_reload_error());
    }
    // Retained file handles survive moved parents, replaced symlinks and later
    // replacements. Confirm the configured provider path still names the saved
    // snapshot before returning its revision as the editor's next save base.
    let named = read_snapshot(path, None).map_err(|_| saved_reload_error())?;
    if named.resolved != saved.resolved || named.revision != saved.revision {
        return Err(saved_reload_error());
    }
    if provider == "codex" && path == directory.join("AGENTS.override.md") {
        *pinned = if saved.content.trim().is_empty() {
            Some((selected_path.to_owned(), saved.revision.clone()))
        } else {
            None
        };
    }
    let mut result = descriptor(provider, path, true);
    result.status = if saved.content.trim().is_empty() {
        InstructionFileStatus::Empty
    } else {
        InstructionFileStatus::Ready
    };
    result.content = Some(saved.content);
    result.revision = Some(saved.revision);
    Ok(result)
}

#[cfg(unix)]
fn unix_save_parent(path: &Path) -> Result<(fs::File, std::ffi::CString), String> {
    use std::os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::OpenOptionsExt}};
    let leaf = path.file_name().ok_or_else(save_error)?;
    let leaf = std::ffi::CString::new(leaf.as_bytes()).map_err(|_| save_error())?;
    let parent_path = path.parent().ok_or_else(save_error)?;
    let relative = parent_path.strip_prefix("/").map_err(|_| save_error())?;
    #[cfg(target_os = "macos")]
    let access = libc::O_SEARCH;
    #[cfg(target_os = "linux")]
    let access = libc::O_PATH;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let access = libc::O_RDONLY;
    let flags = access | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut parent = fs::OpenOptions::new().read(true).custom_flags(flags)
        .open("/").map_err(|_| save_error())?;
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(save_error());
        }
        let name = std::ffi::CString::new(part.as_os_str().as_bytes()).map_err(|_| save_error())?;
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 { return Err(save_error()); }
        parent = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok((parent, leaf))
}

#[cfg(unix)]
struct UnixTemporaryFile<'a> {
    parent: &'a fs::File,
    name: std::ffi::CString,
    identity: (u64, u64),
    committed: bool,
}

#[cfg(unix)]
impl Drop for UnixTemporaryFile<'_> {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        if self.committed { return; }
        let mut info: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(self.parent.as_raw_fd(), self.name.as_ptr(), &mut info,
            libc::AT_SYMLINK_NOFOLLOW) } == 0
            && (info.st_dev as u64, info.st_ino as u64) == self.identity
        {
            // Only unlink our newly created temporary file, never a raced-in
            // replacement or the selected instruction file.
            unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0); }
        }
    }
}

#[cfg(unix)]
fn preserve_unix_acl(original: &fs::File, temporary: &fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "macos")]
    {
        // fcopyfile(COPYFILE_ACL) merges destination-inherited entries and can
        // ignore ACL application failures. Set the original ACL exactly instead.
        extern "C" {
            fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
            fn acl_init(count: libc::c_int) -> *mut libc::c_void;
            fn acl_set_fd(fd: libc::c_int, acl: *mut libc::c_void) -> libc::c_int;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
            fn acl_size(acl: *mut libc::c_void) -> libc::ssize_t;
            fn acl_copy_ext(buffer: *mut libc::c_void, acl: *mut libc::c_void,
                size: libc::ssize_t) -> libc::ssize_t;
        }
        let mut acl = unsafe { acl_get_fd(original.as_raw_fd()) };
        if acl.is_null() && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            // An empty source ACL must also clear a temp file's inherited ACL.
            acl = unsafe { acl_init(0) };
        }
        if acl.is_null() { return Err(save_error()); }
        let size = unsafe { acl_size(acl) };
        let mut source = vec![0u8; if size > 0 && size as usize <= MAX_ACL_BYTES {
            size as usize
        } else { 0 }];
        let copied = !source.is_empty() && unsafe {
            acl_copy_ext(source.as_mut_ptr().cast(), acl, size)
        } == size;
        let applied = copied && unsafe { acl_set_fd(temporary.as_raw_fd(), acl) } == 0;
        unsafe { acl_free(acl); }
        if !applied { return Err(save_error()); }
        let mut actual = unsafe { acl_get_fd(temporary.as_raw_fd()) };
        if actual.is_null() && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            actual = unsafe { acl_init(0) };
        }
        if actual.is_null() { return Err(save_error()); }
        let actual_size = unsafe { acl_size(actual) };
        let mut destination = vec![0u8; source.len()];
        let confirmed = actual_size == size && unsafe {
            acl_copy_ext(destination.as_mut_ptr().cast(), actual, size)
        } == size && source == destination;
        unsafe { acl_free(actual); }
        if !confirmed { return Err(save_error()); }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let name = b"system.posix_acl_access\0";
        let mut acl = vec![0u8; MAX_ACL_BYTES];
        let count = unsafe { libc::fgetxattr(original.as_raw_fd(), name.as_ptr().cast(),
            acl.as_mut_ptr().cast(), acl.len()) };
        if count < 0 {
            let error = io::Error::last_os_error().raw_os_error();
            if error == Some(libc::ENOTSUP) { return Ok(()); }
            if error != Some(libc::ENODATA) { return Err(save_error()); }
            if unsafe { libc::fremovexattr(temporary.as_raw_fd(), name.as_ptr().cast()) } != 0 {
                let error = io::Error::last_os_error().raw_os_error();
                if error != Some(libc::ENODATA) && error != Some(libc::ENOTSUP) {
                    return Err(save_error());
                }
            }
            return Ok(());
        }
        acl.truncate(count as usize);
        if unsafe { libc::fsetxattr(temporary.as_raw_fd(), name.as_ptr().cast(),
            acl.as_ptr().cast(), acl.len(), 0) } != 0 { return Err(save_error()); }
        let mut confirmed = vec![0u8; MAX_ACL_BYTES];
        let count = unsafe { libc::fgetxattr(temporary.as_raw_fd(), name.as_ptr().cast(),
            confirmed.as_mut_ptr().cast(), confirmed.len()) };
        if count < 0 { return Err(save_error()); }
        confirmed.truncate(count as usize);
        if confirmed != acl { return Err(save_error()); }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (original, temporary);
        Err("Preserving instruction-file access controls is unavailable on this platform.".to_owned())
    }
}

#[cfg(unix)]
fn atomic_replace_global(
    snapshot: &FileSnapshot,
    bytes: &[u8],
    validate: impl FnOnce() -> Result<(), String>,
) -> Result<FileSnapshot, String> {
    use std::os::{fd::{AsRawFd, FromRawFd}, unix::fs::MetadataExt};
    let (parent, leaf) = unix_save_parent(&snapshot.resolved)?;
    // A writable parent permits rename even when the file's own mode or ACL
    // denies editing. Ask the OS for write access without truncating or writing
    // the original, rather than bypassing that protection through replacement.
    let source_fd = unsafe { libc::openat(parent.as_raw_fd(), leaf.as_ptr(),
        libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
    if source_fd < 0 { return Err(save_error()); }
    let mut original = unsafe { fs::File::from_raw_fd(source_fd) };
    if read_handle_snapshot(&mut original, &snapshot.resolved).map_err(|_| conflict())?.revision
        != snapshot.revision { return Err(conflict()); }
    let temp_name = std::ffi::CString::new(format!(".mythra-instructions-{}.tmp", uuid::Uuid::new_v4()))
        .map_err(|_| save_error())?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), temp_name.as_ptr(),
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
    if fd < 0 { return Err(save_error()); }
    let mut temp = unsafe { fs::File::from_raw_fd(fd) };
    let created = temp.metadata().map_err(|_| save_error())?;
    let mut cleanup = UnixTemporaryFile {
        parent: &parent,
        name: temp_name,
        identity: (created.dev(), created.ino()),
        committed: false,
    };
    // Preserve ownership/group and permission bits; refuse rather than relax
    // protection if the current user cannot reproduce the original metadata.
    if unsafe { libc::fchown(temp.as_raw_fd(), snapshot.metadata.uid(), snapshot.metadata.gid()) } != 0 {
        return Err(save_error());
    }
    temp.set_permissions(snapshot.metadata.permissions()).map_err(|_| save_error())?;
    preserve_unix_acl(&original, &temp)?;
    temp.write_all(bytes).map_err(|_| save_error())?;
    temp.set_permissions(snapshot.metadata.permissions()).map_err(|_| save_error())?;
    temp.sync_all().map_err(|_| save_error())?;
    validate()?;
    let (current_parent, _) = unix_save_parent(&snapshot.resolved)?;
    let original_parent = parent.metadata().map_err(|_| save_error())?;
    let current_parent = current_parent.metadata().map_err(|_| save_error())?;
    if (original_parent.dev(), original_parent.ino()) != (current_parent.dev(), current_parent.ino()) {
        return Err(conflict());
    }
    let fd = unsafe { libc::openat(parent.as_raw_fd(), leaf.as_ptr(),
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
    if fd < 0 { return Err(conflict()); }
    let mut named = unsafe { fs::File::from_raw_fd(fd) };
    let current = read_handle_snapshot(&mut named, &snapshot.resolved).map_err(|_| conflict())?;
    if current.revision != snapshot.revision { return Err(conflict()); }
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(parent.as_raw_fd(), cleanup.name.as_ptr(), &mut info,
        libc::AT_SYMLINK_NOFOLLOW) } != 0
        || (info.st_dev as u64, info.st_ino as u64) != cleanup.identity
    { return Err(save_error()); }
    // renameat is atomic within this retained directory; failures leave the
    // original name/content intact and the guard removes only our temporary.
    if unsafe { libc::renameat(parent.as_raw_fd(), cleanup.name.as_ptr(),
        parent.as_raw_fd(), leaf.as_ptr()) } != 0 { return Err(save_error()); }
    cleanup.committed = true;
    read_handle_snapshot(&mut temp, &snapshot.resolved).map_err(|_| saved_reload_error())
}

#[cfg(windows)]
fn preserve_windows_dacl(original: &fs::File, temporary: &fs::File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Security::{
        ACL, GetKernelObjectSecurity, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetSecurityDescriptorOwner, GetLengthSid, OWNER_SECURITY_INFORMATION,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        UNPROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    };
    // SetSecurityInfo is the documented filesystem ACL API. Declare its small
    // ABI here because this crate does not enable Security_Authorization.
    #[link(name = "advapi32")]
    extern "system" {
        fn SetSecurityInfo(handle: *mut std::ffi::c_void, object_type: i32, information: u32,
            owner: *mut std::ffi::c_void, group: *mut std::ffi::c_void,
            dacl: *const ACL, sacl: *const ACL) -> u32;
    }
    fn read(file: &fs::File) -> Result<Vec<u32>, String> {
        let mut descriptor = vec![0u32; MAX_ACL_BYTES / 4];
        let mut required = 0;
        if unsafe { GetKernelObjectSecurity(file.as_raw_handle(), DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
            descriptor.as_mut_ptr().cast(), MAX_ACL_BYTES as u32, &mut required) } == 0
            || required as usize > MAX_ACL_BYTES
        { return Err(save_error()); }
        Ok(descriptor)
    }
    fn parts(descriptor: &mut [u32]) -> Result<(bool, Vec<u8>, Vec<u8>, *mut ACL), String> {
        let pointer = descriptor.as_mut_ptr().cast();
        let mut control = 0;
        let mut revision = 0;
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = std::ptr::null_mut();
        let mut owner = std::ptr::null_mut();
        if unsafe { GetSecurityDescriptorControl(pointer, &mut control, &mut revision) } == 0
            || unsafe { GetSecurityDescriptorDacl(pointer, &mut present, &mut acl, &mut defaulted) } == 0
            || unsafe { GetSecurityDescriptorOwner(pointer, &mut owner, &mut defaulted) } == 0
        { return Err(save_error()); }
        let protected = control & SE_DACL_PROTECTED != 0;
        let start = descriptor.as_ptr() as usize;
        let end = start + descriptor.len() * 4;
        let owner_address = owner as usize;
        if owner_address < start || owner_address.saturating_add(8) > end {
            return Err(save_error());
        }
        let owner_length = unsafe { GetLengthSid(owner) } as usize;
        if owner_length < 8 || owner_address.saturating_add(owner_length) > end {
            return Err(save_error());
        }
        let owner_bytes = unsafe { std::slice::from_raw_parts(owner.cast::<u8>(), owner_length) }.to_vec();
        if present == 0 || acl.is_null() {
            return Ok((protected, owner_bytes, Vec::new(), std::ptr::null_mut()));
        }
        let address = acl as usize;
        if address < start || address.saturating_add(std::mem::size_of::<ACL>()) > end {
            return Err(save_error());
        }
        let length = unsafe { (*acl).AclSize } as usize;
        if length < std::mem::size_of::<ACL>() || address.saturating_add(length) > end {
            return Err(save_error());
        }
        let bytes = unsafe { std::slice::from_raw_parts(acl.cast::<u8>(), length) }.to_vec();
        Ok((protected, owner_bytes, bytes, acl))
    }
    let mut source = read(original)?;
    let (protected, source_owner, source_bytes, acl) = parts(&mut source)?;
    let flags = DACL_SECURITY_INFORMATION | if protected {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    // SE_FILE_OBJECT = 1. Preserve the original inheritance state and reject
    // any inherited destination ACEs that would change the source ACL.
    if unsafe { SetSecurityInfo(temporary.as_raw_handle(), 1, flags,
        std::ptr::null_mut(), std::ptr::null_mut(), acl, std::ptr::null_mut()) } != 0 {
        return Err(save_error());
    }
    let mut actual = read(temporary)?;
    let (actual_protected, actual_owner, actual_bytes, _) = parts(&mut actual)?;
    // An atomic replacement must not make this user the implicit ACL owner of
    // an instruction file previously owned by someone else.
    if actual_owner != source_owner || actual_protected != protected || actual_bytes != source_bytes {
        return Err(save_error());
    }
    Ok(())
}

#[cfg(windows)]
fn windows_file_identity(file: &fs::File) -> Result<(u32, u32, u32, u32), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(save_error());
    }
    Ok((info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow, info.nNumberOfLinks))
}

#[cfg(windows)]
fn windows_save_open(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new().read(true).share_mode(5)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path).map_err(|_| save_error())?;
    ensure_regular(&file.metadata().map_err(|_| save_error())?).map_err(|_| save_error())?;
    if windows_handle_path(&file).map_err(|_| save_error())? != path {
        return Err(conflict());
    }
    Ok(file)
}

#[cfg(windows)]
fn windows_save_parents(path: &Path) -> Result<Vec<fs::File>, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
    let parent = path.parent().ok_or_else(save_error)?;
    let ancestors: Vec<&Path> = parent.ancestors().collect();
    let mut held = Vec::with_capacity(ancestors.len());
    for cursor in ancestors.into_iter().rev() {
        let directory = fs::OpenOptions::new().read(true).share_mode(3)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(cursor).map_err(|_| save_error())?;
        let metadata = directory.metadata().map_err(|_| save_error())?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0
            || windows_handle_path(&directory).map_err(|_| save_error())? != cursor
        { return Err(conflict()); }
        // Omitting FILE_SHARE_DELETE retains every ancestor at this location
        // through the replacement and any required original-file recovery.
        held.push(directory);
    }
    Ok(held)
}

#[cfg(windows)]
fn windows_named_identity(path: &Path) -> Option<(u32, u32, u32, u32)> {
    windows_save_open(path).ok().and_then(|file| windows_file_identity(&file).ok())
}

#[cfg(windows)]
struct WindowsTemporaryFile {
    path: PathBuf,
    identity: (u32, u32, u32, u32),
    file: Option<fs::File>,
}

#[cfg(windows)]
impl Drop for WindowsTemporaryFile {
    fn drop(&mut self) {
        // Release any writing handle first, including on write/sync errors, so
        // the identity check and cleanup are not defeated by our own sharing.
        drop(self.file.take());
        if windows_named_identity(&self.path) == Some(self.identity) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(windows)]
fn windows_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn atomic_replace_global(
    snapshot: &FileSnapshot,
    bytes: &[u8],
    validate: impl FnOnce() -> Result<(), String>,
) -> Result<FileSnapshot, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Storage::FileSystem::{
        ReplaceFileW, MoveFileExW, FILE_FLAG_OPEN_REPARSE_POINT, MOVEFILE_WRITE_THROUGH, WRITE_DAC,
    };
    let _parents = windows_save_parents(&snapshot.resolved)?;
    // Keep source reads permitted and normal writes denied while its revision
    // is checked. Delete sharing permits the atomic Windows replace operation.
    let mut original = windows_save_open(&snapshot.resolved)?;
    let original_identity = windows_file_identity(&original)?;
    if original_identity.3 != 1 { return Err(save_error()); }
    let current = read_handle_snapshot(&mut original, &snapshot.resolved).map_err(|_| conflict())?;
    if current.revision != snapshot.revision { return Err(conflict()); }
    let folder = snapshot.resolved.parent().ok_or_else(save_error)?;
    let temp_path = folder.join(format!(".mythra-instructions-{}.tmp", uuid::Uuid::new_v4()));
    let backup_path = folder.join(format!(".mythra-instructions-{}.backup", uuid::Uuid::new_v4()));
    let temp = fs::OpenOptions::new().read(true).write(true).create_new(true).share_mode(7)
        .access_mode(GENERIC_READ | GENERIC_WRITE | WRITE_DAC)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&temp_path).map_err(|_| save_error())?;
    ensure_regular(&temp.metadata().map_err(|_| save_error())?).map_err(|_| save_error())?;
    let temporary_identity = windows_file_identity(&temp)?;
    let mut cleanup = WindowsTemporaryFile {
        path: temp_path.clone(), identity: temporary_identity, file: Some(temp),
    };
    let temp = cleanup.file.as_mut().ok_or_else(save_error)?;
    preserve_windows_dacl(&original, temp)?;
    temp.write_all(bytes).and_then(|()| temp.sync_all()).map_err(|_| save_error())?;
    // ReplaceFile preserves DACLs, creation time, streams and encryption from
    // the original. Do not opt into its flags that ignore ACL/merge failures.
    drop(cleanup.file.take());
    validate()?;
    let current = read_handle_snapshot(&mut original, &snapshot.resolved).map_err(|_| conflict())?;
    if current.revision != snapshot.revision
        || windows_named_identity(&snapshot.resolved) != Some(original_identity)
        || windows_named_identity(&temp_path) != Some(temporary_identity)
        || fs::symlink_metadata(&backup_path).is_ok()
    { return Err(conflict()); }
    let destination = windows_wide(&snapshot.resolved);
    let temporary = windows_wide(&temp_path);
    let backup = windows_wide(&backup_path);
    let succeeded = unsafe { ReplaceFileW(destination.as_ptr(), temporary.as_ptr(), backup.as_ptr(),
        0, std::ptr::null(), std::ptr::null()) } != 0;
    drop(original);
    if !succeeded {
        // Some documented ReplaceFile failure modes rename the original to its
        // backup. Restore it only when the destination is absent; never replace
        // a new external file during recovery. Keep the original backup if a
        // recovery operation fails instead of destroying the remaining copy.
        if windows_named_identity(&backup_path) == Some(original_identity)
            && matches!(fs::symlink_metadata(&snapshot.resolved), Err(error) if error.kind() == io::ErrorKind::NotFound)
        {
            unsafe { MoveFileExW(backup.as_ptr(), destination.as_ptr(), MOVEFILE_WRITE_THROUGH); }
        }
        if windows_named_identity(&snapshot.resolved) != Some(original_identity) {
            return Err(if windows_named_identity(&backup_path) == Some(original_identity) {
                format!("GLOBAL_INSTRUCTION_RECOVERY_REQUIRED: Saving failed. The original is preserved at {}. Reload before editing.", backup_path.display())
            } else {
                "GLOBAL_INSTRUCTION_RECOVERY_REQUIRED: Saving failed and the original file's location could not be confirmed. Reload and inspect retained backups before editing.".to_owned()
            });
        }
        return Err(save_error());
    }
    if windows_named_identity(&backup_path) == Some(original_identity) {
        let _ = fs::remove_file(&backup_path);
    }
    let mut saved = windows_save_open(&snapshot.resolved).map_err(|_| saved_reload_error())?;
    if windows_file_identity(&saved).map_err(|_| saved_reload_error())? != temporary_identity {
        return Err(saved_reload_error());
    }
    let receipt = read_handle_snapshot(&mut saved, &snapshot.resolved).map_err(|_| saved_reload_error());
    drop(cleanup);
    receipt
}

#[cfg(not(any(unix, windows)))]
fn atomic_replace_global(
    _snapshot: &FileSnapshot,
    _bytes: &[u8],
    _validate: impl FnOnce() -> Result<(), String>,
) -> Result<FileSnapshot, String> {
    Err("Safe instruction-file saving is unavailable on this platform.".to_owned())
}

fn read_project_sync(
    project_path: &str,
    agents_enabled: bool,
    claude_enabled: bool,
) -> Result<Vec<InstructionFileDescriptor>, String> {
    if !agents_enabled && !claude_enabled {
        return Ok(Vec::new());
    }
    if project_path.len() > MAX_PATH_BYTES {
        return Err("The project-folder path exceeds the path limit.".to_owned());
    }
    let requested_root = Path::new(project_path);
    let root = check_path(requested_root).and_then(|()| {
        let root = fs::canonicalize(requested_root).map_err(ReadFailure::from_io)?;
        check_path(&root)?;
        if !fs::metadata(&root).map_err(ReadFailure::from_io)?.is_dir() {
            return Err(ReadFailure::new(
                InstructionFileStatus::InvalidPath,
                "The selected project folder is not a directory.",
            ));
        }
        Ok(root)
    });
    let root = match root {
        Ok(root) => root,
        Err(error) => {
            return Ok([
                ("codex", "AGENTS.md", agents_enabled),
                ("claude", "CLAUDE.md", claude_enabled),
            ]
            .into_iter()
            .filter(|(_, _, enabled)| *enabled)
            .map(|(provider, filename, _)| {
                fail(
                    descriptor(provider, &requested_root.join(filename), false),
                    ReadFailure::new(
                        if error.status == InstructionFileStatus::Missing {
                            InstructionFileStatus::InvalidPath
                        } else {
                            error.status
                        },
                        "The selected project folder could not be opened safely.",
                    ),
                )
            })
            .collect());
        }
    };
    let mut files = Vec::with_capacity(2);
    if agents_enabled {
        files.push(read_codex(&root, false, Some(&root)));
    }
    if claude_enabled {
        let preferred = read_descriptor("claude", &root.join("CLAUDE.md"), false, Some(&root));
        files.push(if preferred.status == InstructionFileStatus::Missing {
            let fallback = read_descriptor(
                "claude",
                &root.join(".claude/CLAUDE.md"),
                false,
                Some(&root),
            );
            if fallback.status == InstructionFileStatus::Missing {
                preferred
            } else {
                fallback
            }
        } else {
            preferred
        });
    }
    let combined_bytes: usize = files
        .iter()
        .filter(|file| file.status == InstructionFileStatus::Ready)
        .filter_map(|file| file.content.as_ref())
        .map(String::len)
        .sum();
    if combined_bytes > MAX_PROJECT_BYTES {
        for item in &mut files {
            if item.status == InstructionFileStatus::Ready {
                item.content = None;
                item.revision = None;
                item.status = InstructionFileStatus::TooLarge;
                item.error = Some("The selected project instruction files together exceed 32 KiB; no project content was imported. Disable one file or reduce their size.".to_owned());
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub(super) async fn instruction_files_discover_globals(
    app: AppHandle,
) -> Result<Vec<InstructionFileDescriptor>, String> {
    tokio::task::spawn_blocking(move || discover_globals_sync(&app))
        .await
        .map_err(|_| "Could not finish discovering global instruction files.".to_owned())
}

#[tauri::command]
pub(super) async fn instruction_files_read_project(
    project_path: String,
    agents_enabled: bool,
    claude_enabled: bool,
) -> Result<Vec<InstructionFileDescriptor>, String> {
    tokio::task::spawn_blocking(move || {
        read_project_sync(&project_path, agents_enabled, claude_enabled)
    })
    .await
    .map_err(|_| "Could not finish reading project instruction files.".to_owned())?
}

#[tauri::command]
pub(super) async fn instruction_files_read_global(
    app: AppHandle,
    provider: String,
    path: String,
) -> Result<InstructionFileDescriptor, String> {
    let mut state = GLOBAL_SAVE_STATE.lock().await;
    tokio::task::spawn_blocking(move || {
        // Own serialization in the worker: cancelling the awaiting command
        // must not unlock a still-running filesystem operation. Acquire it
        // asynchronously first so waiting requests do not occupy workers.
        let mut pinned = state.emptied_codex_override.clone();
        let result = read_global_sync(&app, &provider, &path, &mut pinned);
        if result.is_ok() {
            state.emptied_codex_override = pinned;
        }
        result
    })
    .await
    .map_err(|_| "Could not finish reloading the global instruction file.".to_owned())?
}

#[tauri::command]
pub(super) async fn instruction_files_save_global(
    app: AppHandle,
    provider: String,
    path: String,
    content: String,
    expected_revision: String,
) -> Result<InstructionFileDescriptor, String> {
    // Reject oversized payloads before they occupy a worker or wait behind a
    // save. The synchronous operation retains its own defensive size check.
    if content.len() > MAX_FILE_BYTES {
        return Err("Global instruction files must be 32 KiB or smaller; the original file was not changed.".to_owned());
    }
    let mut state = GLOBAL_SAVE_STATE.lock().await;
    tokio::task::spawn_blocking(move || {
        let mut pinned = state.emptied_codex_override.clone();
        let saved = save_global_sync(&app, &provider, &path, &content, &expected_revision, &mut pinned)?;
        state.emptied_codex_override = pinned;
        Ok::<_, String>(saved)
    })
    .await
    .map_err(|_| "GLOBAL_INSTRUCTION_SAVE_UNCERTAIN: Saving could not be confirmed; the file may have changed. Reload before making further edits.".to_owned())?
}
