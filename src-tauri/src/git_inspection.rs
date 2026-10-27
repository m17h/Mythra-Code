//! Bounded, read-only Git inspection owned by the project, not an AI runtime.
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Output,
};

use serde::Serialize;

use crate::project_git::GitReadOperation;
const STATUS_BYTES: usize = 2 * 1024 * 1024;
const DIFF_BYTES: usize = 512 * 1024;
const HISTORY_BYTES: usize = 256 * 1024;
const MAX_ROWS: usize = 2000;
const MAX_HISTORY_PAGE: usize = 100;
const MAX_HISTORY_OFFSET: usize = 100_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitChange {
    path: String,
    original_path: Option<String>,
    area: String,
    status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectGitChanges {
    root_path: String,
    rows: Vec<GitChange>,
    staged_files: usize,
    unstaged_files: usize,
    untracked_files: usize,
    changed_files: usize,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectGitDiff {
    text: String,
    source: &'static str,
    baseline: &'static str,
    untracked_paths: Vec<String>,
    untracked_truncated: bool,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectGitFileDiff {
    path: String,
    area: String,
    text: String,
    binary: bool,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectGitCommit {
    oid: String,
    short_oid: String,
    subject: String,
    author_name: String,
    authored_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectGitHistory {
    entries: Vec<ProjectGitCommit>,
    has_more: bool,
    next_offset: usize,
    head_oid: Option<String>,
    truncated: bool,
}

struct BoundedOutput {
    output: Output,
    truncated: bool,
}

fn run_bounded(
    read: &GitReadOperation,
    repo: &Path,
    args: &[&str],
    limit: usize,
) -> Result<BoundedOutput, String> {
    let mut readonly_args = vec![
        "--no-pager",
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "color.ui=false",
        "-c",
        "core.fsmonitor=false",
    ];
    readonly_args.extend_from_slice(args);
    // Reuse the native PATH, bounded pipe draining, and Unix/Windows process
    // tree cleanup. Prompt suppression also applies to any configured filter.
    let (output, truncated) = read.bounded_output(repo, &readonly_args, limit)?;
    Ok(BoundedOutput { output, truncated })
}

fn checked(
    read: &GitReadOperation,
    repo: &Path,
    args: &[&str],
    limit: usize,
) -> Result<BoundedOutput, String> {
    let result = run_bounded(read, repo, args, limit)?;
    if result.output.status.success() {
        Ok(result)
    } else {
        let detail = String::from_utf8_lossy(&result.output.stderr);
        Err(if detail.trim().is_empty() {
            "Could not inspect Git repository".into()
        } else {
            detail.trim().into()
        })
    }
}

pub(super) fn repository(read: &GitReadOperation, cwd: &str) -> Result<PathBuf, String> {
    let selected = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let result = checked(
        read,
        &selected,
        &["rev-parse", "--show-toplevel"],
        32 * 1024,
    )
    .map_err(|error| format!("Could not find this project's Git repository: {error}"))?;
    if result.truncated {
        return Err("Git repository root is too long".into());
    }
    // Remove Git's one output terminator, not spaces or filename line breaks.
    let raw = result
        .output
        .stdout
        .strip_suffix(b"\n")
        .unwrap_or(&result.output.stdout);
    #[cfg(windows)]
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    let root = std::str::from_utf8(raw).map_err(|_| "Repository root is not valid UTF-8")?;
    Path::new(root)
        .canonicalize()
        .map_err(|error| format!("Could not open the Git root: {error}"))
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 32 * 1024
        || path.contains('\0')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(path)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Git filename must be a literal repository-relative path".into());
    }
    Ok(())
}

fn filename(bytes: &[u8]) -> Result<String, String> {
    let name = std::str::from_utf8(bytes)
        .map_err(|_| "A Git filename is not valid UTF-8 and cannot be selected safely")?;
    validate_path(name)?;
    Ok(name.to_string())
}

fn parse_status(bytes: &[u8], truncated: bool) -> Result<Vec<GitChange>, String> {
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    let mut rows = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() && records.peek().is_none() {
            break;
        }
        if records.peek().is_none() && truncated {
            break;
        }
        if record.len() < 4 || record[2] != b' ' || !bytes.ends_with(&[0]) && !truncated {
            return Err("Git returned an unreadable status list".into());
        }
        let x = record[0];
        let y = record[1];
        if !b" MADRCUT?!".contains(&x) || !b" MADRCUT?!".contains(&y) {
            return Err("Git returned an invalid status code".into());
        }
        let path = filename(&record[3..])?;
        let original_path = if x == b'R' || x == b'C' || y == b'R' || y == b'C' {
            let Some(original) = records.next() else {
                if truncated {
                    break;
                }
                return Err("Git returned a rename without its source filename".into());
            };
            if records.peek().is_none() && truncated {
                break;
            }
            Some(filename(original)?)
        } else {
            None
        };
        if x == b'?' && y == b'?' {
            rows.push(GitChange {
                path,
                original_path,
                area: "untracked".into(),
                status: "?".into(),
            });
            continue;
        }
        if x == b'!' && y == b'!' {
            continue;
        }
        if matches!(
            &record[..2],
            b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU"
        ) {
            rows.push(GitChange {
                path,
                original_path,
                area: "unstaged".into(),
                status: "U".into(),
            });
            continue;
        }
        if x != b' ' {
            rows.push(GitChange {
                path: path.clone(),
                original_path: original_path.clone(),
                area: "staged".into(),
                status: (x as char).to_string(),
            });
        }
        if y != b' ' {
            rows.push(GitChange {
                path,
                original_path,
                area: "unstaged".into(),
                status: (y as char).to_string(),
            });
        }
    }
    Ok(rows)
}

fn read_status(read: &GitReadOperation, repo: &Path) -> Result<(Vec<GitChange>, bool), String> {
    let result = checked(
        read,
        repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        STATUS_BYTES,
    )?;
    Ok((
        parse_status(&result.output.stdout, result.truncated)?,
        result.truncated,
    ))
}

fn changes_sync(cwd: &str, limit: usize) -> Result<ProjectGitChanges, String> {
    let read = GitReadOperation::new();
    if !(1..=MAX_ROWS).contains(&limit) {
        return Err("Changes limit must be between 1 and 2000".into());
    }
    let root = repository(&read, cwd)?;
    let (mut rows, status_truncated) = read_status(&read, &root)?;
    changes_from_rows(&root, &mut rows, status_truncated, limit)
}

pub(super) fn changes_from_status(
    root: &Path,
    bytes: &[u8],
    truncated: bool,
    limit: usize,
) -> Result<ProjectGitChanges, String> {
    let mut rows = parse_status(bytes, truncated)?;
    changes_from_rows(root, &mut rows, truncated, limit)
}

fn changes_from_rows(
    root: &Path,
    rows: &mut Vec<GitChange>,
    status_truncated: bool,
    limit: usize,
) -> Result<ProjectGitChanges, String> {
    let staged_files = rows.iter().filter(|row| row.area == "staged").count();
    let unstaged_files = rows.iter().filter(|row| row.area == "unstaged").count();
    let untracked_files = rows.iter().filter(|row| row.area == "untracked").count();
    let changed_files = rows
        .iter()
        .map(|row| &row.path)
        .collect::<HashSet<_>>()
        .len();
    let truncated = status_truncated || rows.len() > limit;
    rows.truncate(limit);
    Ok(ProjectGitChanges {
        root_path: root.to_string_lossy().into(),
        rows: std::mem::take(rows),
        staged_files,
        unstaged_files,
        untracked_files,
        changed_files,
        truncated,
    })
}

fn head(read: &GitReadOperation, repo: &Path) -> Result<Option<String>, String> {
    let result = run_bounded(
        read,
        repo,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        256,
    )?;
    if !result.output.status.success() {
        return Ok(None);
    }
    let oid = String::from_utf8_lossy(&result.output.stdout)
        .trim()
        .to_string();
    validate_oid(&oid)?;
    Ok(Some(oid))
}

fn validate_oid(oid: &str) -> Result<(), String> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Git history requires a full hexadecimal commit ID".into());
    }
    Ok(())
}

fn bounded_text(bytes: &[u8], limit: usize) -> (String, bool) {
    let capped = bytes.len().min(limit);
    (
        String::from_utf8_lossy(&bytes[..capped]).into_owned(),
        bytes.len() > limit,
    )
}

fn project_diff_sync(cwd: &str) -> Result<ProjectGitDiff, String> {
    let read = GitReadOperation::new();
    let root = repository(&read, cwd)?;
    let has_head = head(&read, &root)?.is_some();
    let mut bytes = Vec::new();
    let mut truncated = false;
    let commands: Vec<Vec<&str>> = if has_head {
        vec![vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "HEAD",
            "--",
        ]]
    } else {
        vec![
            vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--cached",
                "--",
            ],
            vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"],
        ]
    };
    for args in commands {
        let result = checked(&read, &root, &args, DIFF_BYTES)?;
        truncated |= result.truncated;
        bytes.extend_from_slice(&result.output.stdout);
    }
    let (mut text, text_truncated) = bounded_text(&bytes, DIFF_BYTES);
    truncated |= text_truncated;
    if truncated {
        text.push_str(
            "\n\n[Diff preview truncated at 512 KiB. Select a file in Changes to inspect it.]\n",
        );
    }
    let (rows, status_truncated) = read_status(&read, &root)?;
    let mut untracked_paths: Vec<_> = rows
        .into_iter()
        .filter(|row| row.area == "untracked")
        .map(|row| row.path)
        .collect();
    let untracked_truncated = status_truncated || untracked_paths.len() > 500;
    untracked_paths.truncate(500);
    Ok(ProjectGitDiff {
        text,
        source: "repository",
        baseline: if has_head {
            "HEAD"
        } else {
            "the empty repository"
        },
        untracked_paths,
        untracked_truncated,
        truncated,
    })
}

fn binary_diff(text: &str) -> bool {
    text.lines()
        .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch")
}

pub(crate) fn safe_untracked_preview(root: &Path, path: &str) -> Result<(Vec<u8>, bool), String> {
    safe_untracked_preview_after_parent_check(root, path, || {})
}

fn safe_untracked_preview_after_parent_check(
    root: &Path,
    path: &str,
    after_parent_check: impl FnOnce(),
) -> Result<(Vec<u8>, bool), String> {
    validate_path(path)?;
    anchored_untracked_preview(root, Path::new(path), after_parent_check)
}

fn regular_file_preview(file: fs::File) -> Result<(Vec<u8>, bool), String> {
    if !file
        .metadata()
        .map_err(|error| format!("Could not inspect opened file: {error}"))?
        .is_file()
    {
        return Err("Only regular untracked files can be previewed".into());
    }
    let mut bytes = Vec::new();
    file.take((DIFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read untracked file: {error}"))?;
    let truncated = bytes.len() > DIFF_BYTES;
    bytes.truncate(DIFF_BYTES);
    Ok((bytes, truncated))
}

#[cfg(unix)]
fn unix_open_relative(
    parent: &fs::File,
    name: &std::ffi::OsStr,
    flags: i32,
) -> Result<fs::File, std::io::Error> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };
    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid filename"))?;
    // The directory descriptor remains alive through openat. Each successful
    // descriptor is transferred exactly once into File for automatic closure.
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if descriptor < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
fn unix_symlink_preview(
    parent: &fs::File,
    name: &std::ffi::OsStr,
) -> Result<(Vec<u8>, bool), String> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStrExt};
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| "Invalid symlink filename")?;
    let mut target = vec![0u8; 4096];
    loop {
        // readlinkat reads the link text itself relative to the anchored
        // parent. It never opens or follows the target, including on a race.
        let count = unsafe {
            libc::readlinkat(
                parent.as_raw_fd(),
                name.as_ptr(),
                target.as_mut_ptr().cast(),
                target.len(),
            )
        };
        if count < 0 {
            return Err(format!(
                "Could not inspect symbolic link: {}",
                std::io::Error::last_os_error()
            ));
        }
        let count = count as usize;
        if count < target.len() {
            target.truncate(count);
            return Ok((
                format!(
                    "Symbolic link target: {}\n",
                    String::from_utf8_lossy(&target)
                )
                .into_bytes(),
                false,
            ));
        }
        if target.len() >= DIFF_BYTES {
            return Err("Symbolic link target exceeds the preview limit".into());
        }
        target.resize((target.len() * 2).min(DIFF_BYTES), 0);
    }
}

#[cfg(unix)]
fn anchored_untracked_preview(
    root: &Path,
    path: &Path,
    after_parent_check: impl FnOnce(),
) -> Result<(Vec<u8>, bool), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let directory_flags = libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    let mut parent = fs::OpenOptions::new()
        .read(true)
        .custom_flags(directory_flags)
        .open(root)
        .map_err(|error| format!("Could not open the project folder for preview: {error}"))?;
    for component in path
        .parent()
        .ok_or("Git filename has no parent folder")?
        .components()
    {
        parent = unix_open_relative(
            &parent,
            component.as_os_str(),
            libc::O_RDONLY | directory_flags,
        )
        .map_err(|error| {
            format!("Cannot preview through a symbolic-link or unavailable parent folder: {error}")
        })?;
    }
    after_parent_check();
    let name = path.file_name().ok_or("Git filename is invalid")?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    match unix_open_relative(&parent, name, flags) {
        Ok(file) => regular_file_preview(file),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            unix_symlink_preview(&parent, name)
        }
        Err(error) => Err(format!("Could not preview untracked file: {error}")),
    }
}

#[cfg(windows)]
fn windows_handle_path(file: &fs::File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "GetFinalPathNameByHandleW"]
        fn get_final_path_name_by_handle_w(
            handle: *mut std::ffi::c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let mut buffer = vec![0u16; 512];
    loop {
        // Normalized DOS-volume names retain the verbatim drive/UNC prefix.
        // Compare these paths exactly: case folding can confuse directories
        // with per-directory case sensitivity enabled.
        let count = unsafe {
            get_final_path_name_by_handle_w(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if count == 0 {
            return Err(format!(
                "Could not identify opened preview file: {}",
                std::io::Error::last_os_error()
            ));
        }
        if count as usize >= buffer.len() {
            if count > 32768 {
                return Err("Opened preview path exceeds the Windows path limit".into());
            }
            buffer.resize(count as usize + 1, 0);
            continue;
        }
        buffer.truncate(count as usize);
        return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
    }
}

#[cfg(windows)]
fn windows_directory_handle(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    // OPEN_REPARSE_POINT | BACKUP_SEMANTICS, with sharing that permits safe
    // rename testing while retaining the directory's actual handle identity.
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(7)
        .custom_flags(0x00200000 | 0x02000000)
        .open(path)
        .map_err(|error| format!("Could not open preview parent folder: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect preview parent: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Cannot preview through a symbolic-link parent folder".into());
    }
    Ok(file)
}

#[cfg(windows)]
fn anchored_untracked_preview(
    root: &Path,
    path: &Path,
    after_parent_check: impl FnOnce(),
) -> Result<(Vec<u8>, bool), String> {
    use std::os::windows::fs::OpenOptionsExt;
    let root_handle = windows_directory_handle(root)?;
    let mut parent = root_handle
        .try_clone()
        .map_err(|error| format!("Could not retain preview folder: {error}"))?;
    let mut selected = root.to_path_buf();
    for component in path
        .parent()
        .ok_or("Git filename has no parent folder")?
        .components()
    {
        selected.push(component.as_os_str());
        let directory = windows_directory_handle(&selected)?;
        let actual = windows_handle_path(&directory)?;
        if actual != windows_handle_path(&parent)?.join(component.as_os_str())
            || !actual.starts_with(windows_handle_path(&root_handle)?)
        {
            return Err("The preview parent changed or left the project folder".into());
        }
        parent = directory;
    }
    after_parent_check();
    let name = path.file_name().ok_or("Git filename is invalid")?;
    selected.push(name);
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(7)
        .custom_flags(0x00200000)
        .open(&selected)
        .map_err(|error| format!("Could not open untracked preview: {error}"))?;
    let actual = windows_handle_path(&file)?;
    if actual != windows_handle_path(&parent)?.join(name)
        || !actual.starts_with(windows_handle_path(&root_handle)?)
    {
        return Err("The preview file changed or left the project folder".into());
    }
    if file
        .metadata()
        .map_err(|error| format!("Could not inspect preview file: {error}"))?
        .file_type()
        .is_symlink()
    {
        // Even if the link is replaced after inspection, read_link only reads
        // link text and cannot expose a target's file contents.
        let target = fs::read_link(selected)
            .map_err(|error| format!("Could not inspect symbolic link: {error}"))?;
        return Ok((
            format!("Symbolic link target: {}\n", target.to_string_lossy()).into_bytes(),
            false,
        ));
    }
    regular_file_preview(file)
}

fn file_diff_sync(cwd: &str, path: &str, area: &str) -> Result<ProjectGitFileDiff, String> {
    let read = GitReadOperation::new();
    validate_path(path)?;
    if !["staged", "unstaged", "untracked"].contains(&area) {
        return Err("Git change area is invalid".into());
    }
    let root = repository(&read, cwd)?;
    let (rows, _) = read_status(&read, &root)?;
    let row = rows
        .iter()
        .find(|row| row.path == path && row.area == area)
        .ok_or("This file is no longer present in the selected Changes group; refresh Changes")?;
    let (bytes, truncated) = if area == "untracked" {
        safe_untracked_preview(&root, path)?
    } else {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
        if area == "staged" {
            args.push("--cached");
        }
        args.extend(["--", path]);
        if let Some(original) = row.original_path.as_deref() {
            args.push(original);
        }
        let result = checked(&read, &root, &args, DIFF_BYTES)?;
        (result.output.stdout, result.truncated)
    };
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() && !truncated;
    let mut text = if binary {
        "Binary file: text preview unavailable.\n".into()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let binary = binary || binary_diff(&text);
    if truncated {
        text.push_str("\n\n[File preview truncated at 512 KiB.]\n");
    }
    Ok(ProjectGitFileDiff {
        path: path.into(),
        area: area.into(),
        text,
        binary,
        truncated,
    })
}

fn parse_history(bytes: &[u8], truncated: bool) -> Result<Vec<ProjectGitCommit>, String> {
    if !bytes.is_empty() && !bytes.ends_with(&[0]) && !truncated {
        return Err("Git returned an incomplete commit history".into());
    }
    let mut fields: Vec<_> = bytes.split(|byte| *byte == 0).collect();
    // The final field is either the empty terminator or a capped partial field.
    fields.pop();
    let mut entries = Vec::new();
    for chunk in fields.chunks(5) {
        if chunk.len() < 5 {
            if truncated {
                break;
            }
            return Err("Git returned an unreadable commit history".into());
        }
        let oid = std::str::from_utf8(chunk[0])
            .map_err(|_| "Git returned an invalid commit ID")?
            .to_string();
        validate_oid(&oid)?;
        let short_oid = String::from_utf8_lossy(chunk[1]).into_owned();
        if !short_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !oid.starts_with(&short_oid)
            || short_oid.is_empty()
        {
            return Err("Git returned an invalid abbreviated commit ID".into());
        }
        entries.push(ProjectGitCommit {
            oid,
            short_oid,
            author_name: String::from_utf8_lossy(chunk[2]).into_owned(),
            authored_at: String::from_utf8_lossy(chunk[3]).into_owned(),
            subject: String::from_utf8_lossy(chunk[4]).into_owned(),
        });
    }
    Ok(entries)
}

fn history_sync(
    cwd: &str,
    offset: usize,
    limit: usize,
    head_oid: Option<&str>,
) -> Result<ProjectGitHistory, String> {
    let read = GitReadOperation::new();
    if !(1..=MAX_HISTORY_PAGE).contains(&limit) || offset > MAX_HISTORY_OFFSET {
        return Err("History requires a page of 1–100 commits and an offset up to 100000".into());
    }
    if let Some(oid) = head_oid {
        validate_oid(oid)?;
    }
    let root = repository(&read, cwd)?;
    let head_oid = match head_oid {
        Some(oid) => Some(oid.into()),
        None => head(&read, &root)?,
    };
    let Some(oid) = head_oid.as_deref() else {
        return Ok(ProjectGitHistory {
            entries: Vec::new(),
            has_more: false,
            next_offset: offset,
            head_oid: None,
            truncated: false,
        });
    };
    let skip = format!("--skip={offset}");
    let count = format!("--max-count={}", limit + 1);
    let result = checked(
        &read,
        &root,
        &[
            "log",
            "-z",
            "--no-show-signature",
            "--format=%H%x00%h%x00%an%x00%aI%x00%s",
            &skip,
            &count,
            oid,
            "--",
        ],
        HISTORY_BYTES,
    )?;
    let mut entries = parse_history(&result.output.stdout, result.truncated)?;
    if entries.is_empty() && result.truncated {
        return Err(
            "A commit exceeds the 256 KiB history preview limit; inspect this history with Git"
                .into(),
        );
    }
    let has_more = entries.len() > limit || result.truncated;
    entries.truncate(limit);
    let next_offset = offset + entries.len();
    Ok(ProjectGitHistory {
        entries,
        has_more,
        next_offset,
        head_oid,
        truncated: result.truncated,
    })
}

#[tauri::command]
pub(super) async fn git_project_changes(
    cwd: String,
    limit: Option<usize>,
) -> Result<ProjectGitChanges, String> {
    tauri::async_runtime::spawn_blocking(move || changes_sync(&cwd, limit.unwrap_or(500)))
        .await
        .map_err(|error| format!("Git Changes inspection failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_project_diff(cwd: String) -> Result<ProjectGitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || project_diff_sync(&cwd))
        .await
        .map_err(|error| format!("Project Git diff inspection failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_project_file_diff(
    cwd: String,
    path: String,
    area: String,
) -> Result<ProjectGitFileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || file_diff_sync(&cwd, &path, &area))
        .await
        .map_err(|error| format!("Git file inspection failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_project_history(
    cwd: String,
    offset: Option<usize>,
    limit: Option<usize>,
    head_oid: Option<String>,
) -> Result<ProjectGitHistory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_sync(
            &cwd,
            offset.unwrap_or(0),
            limit.unwrap_or(30),
            head_oid.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Git history inspection failed: {error}"))?
}
