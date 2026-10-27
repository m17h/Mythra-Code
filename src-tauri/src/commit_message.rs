//! Read-only context for drafts written by the model already doing the work.
use std::{fs, path::Path, time::{Duration, UNIX_EPOCH}};
use serde::Serialize;
use sha2::{Digest, Sha256};
use crate::project_git::GitReadOperation;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommitMessageContext {
    pub root_path: String,
    pub head_oid: Option<String>,
    pub branch: Option<String>,
    pub token: String,
    pub staged_token: String,
    pub changes_token: String,
    pub has_changes: bool,
    pub has_staged: bool,
    pub status: String,
    pub diff: String,
    pub staged_diff: String,
    pub untracked_paths: Vec<String>,
    pub preview_truncated: bool,
}

fn digest(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}

fn preview(text: &str) -> String {
    let mut end = text.len().min(12 * 1024);
    while !text.is_char_boundary(end) { end -= 1; }
    text[..end].to_owned()
}

fn read_context(cwd: &str) -> Result<CommitMessageContext, String> {
    // No index writes, external diff helpers, textconv filters or network.
    // Overflow is a refusal, never a token for partially inspected changes.
    let read = GitReadOperation::with_limits(Duration::from_secs(15), 2 * 1024 * 1024);
    let requested = fs::canonicalize(cwd).map_err(|e| format!("Cannot open the project folder: {e}"))?;
    let root = crate::git_inspection::repository(&read, cwd)?;
    if root != requested { return Err("Open the repository root before preparing a commit message.".into()); }
    let head_oid = read.optional_stdout(&root, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
    let branch = read.optional_stdout(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let status = read.stdout(&root, &["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"])?;
    let staged = read.stdout(&root, &["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--full-index", "--cached", "--"])?;
    let working = read.stdout(&root, &["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--full-index", "--"])?;
    let all = if head_oid.is_some() {
        read.stdout(&root, &["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--full-index", "HEAD", "--"])?
    } else { format!("Staged changes:\n{staged}\nWorking changes:\n{working}") };
    let output = read.output(&root, &["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z"])?;
    if !output.status.success() { return Err("Cannot inspect new files for a commit draft.".into()); }
    let paths = String::from_utf8(output.stdout).map_err(|_| "A new filename cannot be represented in the commit draft.")?;
    let untracked_paths: Vec<String> = paths.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect();
    if untracked_paths.len() > 500 { return Err("There are too many new files to prepare an automatic commit draft. Write the message manually.".into()); }
    let mut new_files = String::new();
    for path in &untracked_paths {
        // Do not follow a new symlink or read arbitrarily large new files.
        let metadata = fs::symlink_metadata(root.join(Path::new(path)))
            .map_err(|_| "New files changed while the commit draft was being prepared.")?;
        let modified = metadata.modified().map_err(|_| "Cannot inspect new file timestamps.")?
            .duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        new_files.push_str(&format!("{}:{path}:{}:{modified}\n", path.len(), metadata.len()));
    }
    // Guard common commit/checkout/staging races during this bounded read.
    if head_oid != read.optional_stdout(&root, &["rev-parse", "--verify", "--quiet", "HEAD"])?
        || branch != read.optional_stdout(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
        || status != read.stdout(&root, &["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"])? {
        return Err("Git changed while the commit draft was being prepared. Read the context again.".into());
    }
    let identity = format!("{head_oid:?}:{branch:?}");
    // The model's token covers the staged/unstaged split so its stagedMessage
    // cannot go stale. Commit-all only needs the combined content, so staging
    // a file afterwards does not invalidate the all-changes draft.
    let staged_token = digest(&[identity.as_bytes(), staged.as_bytes()]);
    let changes_token = digest(&[identity.as_bytes(), all.as_bytes(), new_files.as_bytes()]);
    let token = digest(&[identity.as_bytes(), status.as_bytes(), staged.as_bytes(), working.as_bytes(), new_files.as_bytes()]);
    // Keep the listed names within the bridge's response budget.
    let total_paths = untracked_paths.len();
    let mut listed = 0;
    let untracked_paths: Vec<String> = untracked_paths.into_iter()
        .take_while(|path| { listed += path.len() + 4; listed <= 32 * 1024 }).collect();
    Ok(CommitMessageContext {
        root_path: root.to_string_lossy().into_owned(), head_oid, branch,
        token, staged_token, changes_token, has_changes: !status.is_empty(), has_staged: !staged.is_empty(),
        preview_truncated: status.len() > 12 * 1024 || all.len() > 12 * 1024 || staged.len() > 12 * 1024
            || untracked_paths.len() < total_paths,
        status: preview(&status), diff: preview(&all), staged_diff: preview(&staged), untracked_paths,
    })
}

#[tauri::command]
pub(super) async fn git_commit_message_context(cwd: String) -> Result<CommitMessageContext, String> {
    tauri::async_runtime::spawn_blocking(move || read_context(&cwd)).await
        .map_err(|e| format!("Commit draft inspection failed: {e}"))?
}
