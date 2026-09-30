//! Bounded, read-only Git inspection owned by the project, not an AI runtime.
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Output,
    time::Duration,
};

use serde::Serialize;

use crate::git_workspace::bounded_git_output;

const INSPECTION_TIMEOUT: Duration = Duration::from_secs(15);
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

#[derive(Debug, Serialize)]
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

fn run_bounded(repo: &Path, args: &[&str], limit: usize) -> Result<BoundedOutput, String> {
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
    let (output, truncated) =
        bounded_git_output(repo, &readonly_args, INSPECTION_TIMEOUT, limit, true)?;
    Ok(BoundedOutput { output, truncated })
}

fn checked(repo: &Path, args: &[&str], limit: usize) -> Result<BoundedOutput, String> {
    let result = run_bounded(repo, args, limit)?;
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

fn repository(cwd: &str) -> Result<PathBuf, String> {
    let selected = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let result = checked(&selected, &["rev-parse", "--show-toplevel"], 32 * 1024)
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

fn read_status(repo: &Path) -> Result<(Vec<GitChange>, bool), String> {
    let result = checked(
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
    if !(1..=MAX_ROWS).contains(&limit) {
        return Err("Changes limit must be between 1 and 2000".into());
    }
    let root = repository(cwd)?;
    let (mut rows, status_truncated) = read_status(&root)?;
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
        rows,
        staged_files,
        unstaged_files,
        untracked_files,
        changed_files,
        truncated,
    })
}

fn head(repo: &Path) -> Result<Option<String>, String> {
    let result = run_bounded(
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
    let root = repository(cwd)?;
    let has_head = head(&root)?.is_some();
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
        let result = checked(&root, &args, DIFF_BYTES)?;
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
    let (rows, status_truncated) = read_status(&root)?;
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

fn safe_untracked_preview(root: &Path, path: &str) -> Result<(Vec<u8>, bool), String> {
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
    validate_path(path)?;
    if !["staged", "unstaged", "untracked"].contains(&area) {
        return Err("Git change area is invalid".into());
    }
    let root = repository(cwd)?;
    let (rows, _) = read_status(&root)?;
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
        let result = checked(&root, &args, DIFF_BYTES)?;
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
    if !(1..=MAX_HISTORY_PAGE).contains(&limit) || offset > MAX_HISTORY_OFFSET {
        return Err("History requires a page of 1–100 commits and an offset up to 100000".into());
    }
    if let Some(oid) = head_oid {
        validate_oid(oid)?;
    }
    let root = repository(cwd)?;
    let head_oid = match head_oid {
        Some(oid) => Some(oid.into()),
        None => head(&root)?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_git::run_git;
    use std::env;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                env::temp_dir().join(format!("mythra-git-inspection-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q"]);
            git(&path, &["config", "user.name", "Inspection Test"]);
            git(&path, &["config", "core.autocrlf", "false"]);
            git(
                &path,
                &["config", "user.email", "inspection@example.invalid"],
            );
            Self(path)
        }
        fn cwd(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn write(&self, path: &str, value: impl AsRef<[u8]>) {
            fs::write(self.0.join(path), value).unwrap();
        }
        fn commit(&self, message: &str) {
            git(&self.0, &["add", "--all"]);
            git(&self.0, &["commit", "-qm", message]);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn git(root: &Path, args: &[&str]) {
        let output = run_git(root, args, None).unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn rejects_malformed_paths_limits_and_history_oids() {
        for path in [
            "",
            "../secret",
            "sub/../secret",
            "/absolute",
            "a//b",
            "a\0b",
            "./a",
        ] {
            assert!(validate_path(path).is_err(), "{path:?}");
        }
        for path in [
            "-filename",
            ":(glob)*.txt",
            "café\nwith tab\t.txt",
            "a/trailing ",
        ] {
            validate_path(path).unwrap();
        }
        assert!(changes_sync("/unused", 0).is_err());
        assert!(changes_sync("/unused", MAX_ROWS + 1).is_err());
        assert!(history_sync("/unused", 0, 0, None).is_err());
        assert!(history_sync("/unused", 0, 30, Some("--all")).is_err());
        assert!(parse_status(b"MM file", false).is_err());
        assert!(parse_status(b"R  target\0", false).is_err());
        assert!(parse_status(b"?? ../escape\0", false).is_err());
        let conflict = parse_status(b"UU conflict.txt\0", false).unwrap();
        assert_eq!(conflict.len(), 1);
        assert_eq!(conflict[0].area, "unstaged");
        assert_eq!(conflict[0].status, "U");
    }

    #[test]
    fn unborn_repository_and_partial_staging_have_both_diffs() {
        let fixture = Fixture::new();
        assert!(project_diff_sync(fixture.cwd()).unwrap().text.is_empty());
        assert!(history_sync(fixture.cwd(), 0, 30, None)
            .unwrap()
            .entries
            .is_empty());
        fixture.write("new.txt", "staged line\n");
        git(&fixture.0, &["add", "--", "new.txt"]);
        fixture.write("new.txt", "staged line\nworking line\n");
        fixture.write("untracked.txt", "untracked text\n");
        let changes = changes_sync(fixture.cwd(), 500).unwrap();
        assert_eq!(
            (
                changes.staged_files,
                changes.unstaged_files,
                changes.untracked_files,
                changes.changed_files
            ),
            (1, 1, 1, 2)
        );
        let diff = project_diff_sync(fixture.cwd()).unwrap();
        assert_eq!(diff.baseline, "the empty repository");
        assert!(diff.text.contains("+staged line") && diff.text.contains("+working line"));
        assert_eq!(diff.untracked_paths, ["untracked.txt"]);
        let staged = file_diff_sync(fixture.cwd(), "new.txt", "staged").unwrap();
        let working = file_diff_sync(fixture.cwd(), "new.txt", "unstaged").unwrap();
        assert!(staged.text.contains("+staged line") && !staged.text.contains("+working line"));
        assert!(working.text.contains("+working line"));
    }

    #[test]
    fn selected_diff_uses_literal_paths_and_handles_rename_and_nested_projects() {
        let fixture = Fixture::new();
        #[cfg(unix)]
        let name = ":(glob) café\nname.txt";
        #[cfg(windows)]
        let name = "café [literal].txt";
        fixture.write(name, "original\n");
        fixture.write("neighbor.txt", "neighbor\n");
        fs::create_dir(fixture.0.join("subfolder")).unwrap();
        fixture.commit("initial");
        fixture.write(name, "changed literal\n");
        fixture.write("neighbor.txt", "must not appear\n");
        let selected = file_diff_sync(
            fixture.0.join("subfolder").to_str().unwrap(),
            name,
            "unstaged",
        )
        .unwrap();
        assert!(selected.text.contains("+changed literal"));
        assert!(!selected.text.contains("must not appear"));
        git(
            &fixture.0,
            &["--literal-pathspecs", "mv", "--", name, "renamed.txt"],
        );
        let changes = changes_sync(fixture.cwd(), 500).unwrap();
        let renamed = changes.rows.iter().find(|row| row.status == "R").unwrap();
        assert_eq!(renamed.path, "renamed.txt");
        assert_eq!(renamed.original_path.as_deref(), Some(name));
        let staged = file_diff_sync(fixture.cwd(), "renamed.txt", "staged").unwrap();
        assert!(staged.text.contains("rename from"));
        assert!(!staged.text.contains("neighbor.txt"));
    }

    #[test]
    fn untracked_previews_are_bounded_binary_aware_and_not_clean_when_truncated() {
        let fixture = Fixture::new();
        fixture.write("binary.bin", b"hello\0world");
        fixture.write("huge.txt", vec![b'x'; DIFF_BYTES + 32]);
        let binary = file_diff_sync(fixture.cwd(), "binary.bin", "untracked").unwrap();
        assert!(binary.binary && !binary.text.contains("world"));
        let huge = file_diff_sync(fixture.cwd(), "huge.txt", "untracked").unwrap();
        assert!(huge.truncated && huge.text.contains("truncated"));
        let changes = changes_sync(fixture.cwd(), 1).unwrap();
        assert!(changes.truncated);
        assert_eq!(changes.changed_files, 2);
        assert_eq!(changes.rows.len(), 1);
        let parsed = parse_status(b"?? complete\0?? incomplete", true).unwrap();
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn tracked_diff_capping_is_explicit_and_inspection_does_not_write_index() {
        let fixture = Fixture::new();
        fixture.write("file.txt", "before\n");
        fixture.commit("initial");
        fixture.write("file.txt", vec![b'x'; DIFF_BYTES + 32]);
        let index_before = fs::read(fixture.0.join(".git/index")).unwrap();
        let index_modified = fs::metadata(fixture.0.join(".git/index"))
            .unwrap()
            .modified()
            .unwrap();
        let preview = project_diff_sync(fixture.cwd()).unwrap();
        assert!(preview.truncated && preview.text.contains("Diff preview truncated"));
        assert_eq!(
            fs::read(fixture.0.join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(
            fs::metadata(fixture.0.join(".git/index"))
                .unwrap()
                .modified()
                .unwrap(),
            index_modified
        );
        assert_eq!(
            fs::metadata(fixture.0.join("file.txt")).unwrap().len(),
            (DIFF_BYTES + 32) as u64
        );
    }

    #[test]
    fn capped_history_drops_partial_records_instead_of_accepting_partial_metadata() {
        let oid = "a".repeat(40);
        let raw = format!("{oid}\0aaaaaaa\0Author\02026-09-28T12:00:00Z\0partial subject");
        assert!(parse_history(raw.as_bytes(), false).is_err());
        assert!(parse_history(raw.as_bytes(), true).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn untracked_symlink_never_reads_its_target() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let secret = Fixture::new();
        secret.write("private.txt", "PRIVATE CONTENT MUST NOT LEAK\n");
        symlink(secret.0.join("private.txt"), fixture.0.join("link")).unwrap();
        let preview = file_diff_sync(fixture.cwd(), "link", "untracked").unwrap();
        assert!(preview.text.starts_with("Symbolic link target:"));
        assert!(!preview.text.contains("PRIVATE CONTENT"));
    }

    #[cfg(unix)]
    #[test]
    fn untracked_parent_replacement_cannot_preview_outside_the_project() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir(fixture.0.join("parent")).unwrap();
        fixture.write("parent/file.txt", "INSIDE PROJECT\n");
        outside.write("file.txt", "OUTSIDE CONTENT MUST NOT LEAK\n");
        let result =
            safe_untracked_preview_after_parent_check(&fixture.0, "parent/file.txt", || {
                fs::rename(fixture.0.join("parent"), fixture.0.join("retained-parent")).unwrap();
                symlink(&outside.0, fixture.0.join("parent")).unwrap();
            });
        if let Ok((bytes, _)) = result {
            assert!(!String::from_utf8_lossy(&bytes).contains("OUTSIDE CONTENT"));
            assert_eq!(bytes, b"INSIDE PROJECT\n");
        }
    }

    #[cfg(unix)]
    #[test]
    fn untracked_leaf_replacement_reads_only_link_text_and_fifo_never_blocks() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fixture.write("file.txt", "INSIDE\n");
        outside.write("file.txt", "OUTSIDE CONTENT MUST NOT LEAK\n");
        let (bytes, _) = safe_untracked_preview_after_parent_check(&fixture.0, "file.txt", || {
            fs::remove_file(fixture.0.join("file.txt")).unwrap();
            symlink(outside.0.join("file.txt"), fixture.0.join("file.txt")).unwrap();
        })
        .unwrap();
        assert!(String::from_utf8_lossy(&bytes).starts_with("Symbolic link target:"));
        assert!(!String::from_utf8_lossy(&bytes).contains("OUTSIDE CONTENT"));
        let fifo = std::ffi::CString::new(fixture.0.join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(safe_untracked_preview(&fixture.0, "pipe").is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(windows)]
    #[test]
    fn untracked_parent_junction_replacement_cannot_preview_outside_the_project() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir(fixture.0.join("parent")).unwrap();
        fixture.write("parent/file.txt", "INSIDE PROJECT\n");
        outside.write("file.txt", "OUTSIDE CONTENT MUST NOT LEAK\n");
        assert_eq!(
            safe_untracked_preview(&fixture.0, "parent/file.txt")
                .unwrap()
                .0,
            b"INSIDE PROJECT\n"
        );
        let swapped = std::cell::Cell::new(false);
        let result =
            safe_untracked_preview_after_parent_check(&fixture.0, "parent/file.txt", || {
                fs::rename(fixture.0.join("parent"), fixture.0.join("retained-parent")).unwrap();
                // Junction creation is available without a symlink privilege.
                let output = crate::process_launch::background_std_command("cmd.exe")
                    .args(["/D", "/C", "mklink", "/J"])
                    .arg(fixture.0.join("parent"))
                    .arg(&outside.0)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                swapped.set(true);
            });
        assert!(swapped.get());
        if let Ok((bytes, _)) = result {
            assert!(!String::from_utf8_lossy(&bytes).contains("OUTSIDE CONTENT"));
            assert_eq!(bytes, b"INSIDE PROJECT\n");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_untracked_preview_accepts_normal_nested_mixed_case_git_paths() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("MixedCaseFolder/InnerFolder")).unwrap();
        fixture.write(
            "MixedCaseFolder/InnerFolder/PreviewFile.txt",
            "nested preview\n",
        );
        let mixed_case_cwd = fixture.cwd().to_ascii_uppercase();
        let snapshot = changes_sync(&mixed_case_cwd, 500).unwrap();
        let row = snapshot
            .rows
            .iter()
            .find(|row| row.path.ends_with("PreviewFile.txt"))
            .unwrap();
        let preview = file_diff_sync(&mixed_case_cwd, &row.path, "untracked").unwrap();
        assert_eq!(preview.text, "nested preview\n");
    }

    #[cfg(windows)]
    #[test]
    fn windows_untracked_file_symlink_previews_link_text_without_target_contents() {
        use std::os::windows::fs::symlink_file;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        outside.write("file.txt", "OUTSIDE CONTENT MUST NOT LEAK\n");
        symlink_file(outside.0.join("file.txt"), fixture.0.join("link.txt")).unwrap();
        let (bytes, _) = safe_untracked_preview(&fixture.0, "link.txt").unwrap();
        assert!(String::from_utf8_lossy(&bytes).starts_with("Symbolic link target:"));
        assert!(!String::from_utf8_lossy(&bytes).contains("OUTSIDE CONTENT"));
    }

    #[test]
    fn history_reads_real_commits_pages_and_stays_pinned() {
        let fixture = Fixture::new();
        fixture.write("file.txt", "one\n");
        fixture.commit("one");
        fixture.write("file.txt", "two\n");
        fixture.commit("two");
        fixture.write("file.txt", "three\n");
        fixture.commit("three");
        let first = history_sync(fixture.cwd(), 0, 1, None).unwrap();
        assert_eq!(first.entries[0].subject, "three");
        assert!(first.has_more);
        assert_eq!(first.next_offset, 1);
        fixture.write("file.txt", "four\n");
        fixture.commit("four");
        let next = history_sync(
            fixture.cwd(),
            first.next_offset,
            1,
            first.head_oid.as_deref(),
        )
        .unwrap();
        assert_eq!(next.entries[0].subject, "two");
        assert_eq!(next.head_oid, first.head_oid);
        let last = history_sync(fixture.cwd(), 2, 1, first.head_oid.as_deref()).unwrap();
        assert_eq!(last.entries[0].subject, "one");
        assert!(!last.has_more);
    }
}
