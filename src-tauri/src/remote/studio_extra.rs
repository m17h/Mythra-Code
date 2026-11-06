//! More of the read-only Studio: history, checkpoint diffs, worktree status,
//! revert previews and transcript images. Each runs Git from an anchored folder
//! or reads through an opened regular file, and none falls back to a legacy
//! command. Nothing here writes, and nothing a viewer sent becomes a path: the
//! host renderer resolves every root from its own records.
use super::{
    fs_guard::{self, Anchor},
    studio::{blocking, failed, git, git_root, main},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use crate::project_git::GitReadOperation;
use serde_json::{json, Value};
use std::path::Path;
use tauri::WebviewWindow;

const DIFF_BYTES: usize = 128 * 1024;
const HISTORY_BYTES: usize = 256 * 1024;
const STATUS_BYTES: usize = 2 * 1024 * 1024;
const MAX_HISTORY_PAGE: usize = 100;
const MAX_HISTORY_OFFSET: usize = 100_000;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Stays under the host's 1 MiB reply limit once it is Base64 in JSON.
const IMAGE_CHUNK_BYTES: usize = 512 * 1024;

/// Output that was cut short ends with a killed process, which is not a failure.
fn bounded(
    read: &GitReadOperation,
    root: &Anchor,
    args: &[&str],
    limit: usize,
) -> Result<(Vec<u8>, bool), String> {
    let (output, truncated) = read
        .bounded_output(&root.git_cwd(), args, limit)
        .map_err(|_| failed())?;
    if !output.status.success() && !truncated {
        return Err(failed());
    }
    Ok((output.stdout, truncated))
}
fn line(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
fn plain_ref(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 512
        && !name.starts_with('-')
        && !name.contains("..")
        && !name.chars().any(|c| c.is_control() || c == ' ')
}

#[tauri::command]
pub(crate) async fn remote_studio_checkpoint_diff(
    window: WebviewWindow,
    root: String,
    id: String,
) -> Result<Value, String> {
    main(&window)?;
    let before = crate::project_git::checkpoint_ref(&id, "before").map_err(|_| failed())?;
    let after = crate::project_git::checkpoint_ref(&id, "after").map_err(|_| failed())?;
    blocking(move || checkpoint_diff(&root, &before, &after)).await
}
fn checkpoint_diff(root: &str, before: &str, after: &str) -> Result<Value, String> {
    let root = Anchor::open(Path::new(root))?;
    let read = GitReadOperation::new();
    git_root(&read, &root)?;
    // Two stored trees: no working-tree file is opened and no filter runs.
    let (bytes, truncated) = bounded(
        &read,
        &root,
        &["diff", "--no-ext-diff", "--no-textconv", before, after, "--"],
        DIFF_BYTES,
    )?;
    root.validate()?;
    Ok(json!({"text": String::from_utf8_lossy(&bytes), "truncated": truncated}))
}

#[tauri::command]
pub(crate) async fn remote_studio_git_log(
    window: WebviewWindow,
    root: String,
    offset: usize,
    limit: usize,
    head_oid: Option<String>,
) -> Result<Value, String> {
    main(&window)?;
    if !(1..=MAX_HISTORY_PAGE).contains(&limit) || offset > MAX_HISTORY_OFFSET {
        return Err(failed());
    }
    if let Some(oid) = &head_oid {
        crate::git_inspection::validate_oid(oid).map_err(|_| failed())?;
    }
    blocking(move || git_log(&root, offset, limit, head_oid)).await
}
fn git_log(root: &str, offset: usize, limit: usize, head_oid: Option<String>) -> Result<Value, String> {
    let root = Anchor::open(Path::new(root))?;
    let read = GitReadOperation::new();
    let empty = |repository: bool| {
        json!({"repository":repository,"entries":[],"hasMore":false,"nextOffset":offset,"headOid":null,"truncated":false})
    };
    // A folder without Git is an answer, and it's what offers Initialize.
    if git(&read, &root, &["rev-parse", "--is-inside-work-tree"], 64).is_err() {
        root.validate()?;
        return Ok(empty(false));
    }
    git_root(&read, &root)?;
    let head = match head_oid {
        Some(oid) => Some(oid),
        None => git(&read, &root, &["rev-parse", "--verify", "--quiet", "HEAD"], 256)
            .ok()
            .and_then(|(bytes, _)| line(&bytes)),
    };
    let Some(oid) = head else {
        root.validate()?;
        return Ok(empty(true));
    };
    let skip = format!("--skip={offset}");
    let count = format!("--max-count={}", limit + 1);
    let (bytes, truncated) = bounded(
        &read,
        &root,
        &[
            "log",
            "-z",
            "--no-show-signature",
            "--format=%H%x00%h%x00%an%x00%aI%x00%s",
            &skip,
            &count,
            &oid,
            "--",
        ],
        HISTORY_BYTES,
    )?;
    let mut entries =
        crate::git_inspection::parse_history(&bytes, truncated).map_err(|_| failed())?;
    if entries.is_empty() && truncated {
        return Err(failed());
    }
    let more = entries.len() > limit || truncated;
    entries.truncate(limit);
    let next = offset + entries.len();
    root.validate()?;
    Ok(json!({"repository":true,"entries":entries,"hasMore":more,"nextOffset":next,"headOid":oid,"truncated":truncated}))
}

#[tauri::command]
pub(crate) async fn remote_studio_worktree_status(
    window: WebviewWindow,
    project: String,
    worktree: String,
    branch: String,
    base_commit: String,
) -> Result<Value, String> {
    main(&window)?;
    if !plain_ref(&branch) {
        return Err(failed());
    }
    blocking(move || worktree_status(&project, &worktree, &branch, &base_commit)).await
}
fn worktree_status(project: &str, worktree: &str, branch: &str, base_commit: &str) -> Result<Value, String> {
    let source = Anchor::open(Path::new(project))?;
    let read = GitReadOperation::new();
    git_root(&read, &source)?;
    let source_branch = git(&read, &source, &["symbolic-ref", "--short", "-q", "HEAD"], 1024)
        .ok()
        .and_then(|(bytes, _)| line(&bytes));
    let missing = matches!(std::fs::symlink_metadata(worktree), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
    if missing {
        source.validate()?;
        return Ok(json!({"headOid":null,"sourceBranch":source_branch,"exists":false,"registered":false,"branch":null,"baseCommit":null,"changedFiles":0,"untrackedFiles":0,"ignoredFileCount":0,"ahead":0,"behind":0,"clean":false}));
    }
    let tree = Anchor::open(Path::new(worktree))?;
    git_root(&read, &tree)?;
    let common = |anchor: &Anchor| {
        read.common_dir(&anchor.path).map_err(|_| failed())
    };
    if common(&source)? != common(&tree)? {
        return Err(failed());
    }
    let identity = tree.identity()?;
    let registered = crate::git_workspace::worktree_paths_with_read(&source.path, &read)
        .map_err(|_| failed())?
        .into_iter()
        .any(|listed| {
            Anchor::open(Path::new(&listed))
                .and_then(|anchor| anchor.identity())
                .is_ok_and(|listed| listed == identity)
        });
    let (status, cut) = git(
        &read,
        &tree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        STATUS_BYTES,
    )?;
    if cut {
        return Err(failed());
    }
    let status = std::str::from_utf8(&status).map_err(|_| failed())?;
    let changed = status.lines().filter(|row| !row.is_empty()).count();
    let untracked = status.lines().filter(|row| row.starts_with("??")).count();
    let ignored = read
        .nul_path_count(&tree.git_cwd(), crate::project_git::IGNORED_FILES_ARGS)
        .map_err(|_| failed())?;
    let (counts, _) = git(
        &read,
        &source,
        &["rev-list", "--left-right", "--count", &format!("HEAD...{branch}")],
        128,
    )?;
    let counts = std::str::from_utf8(&counts).map_err(|_| failed())?;
    let mut counts = counts.split_whitespace().map(str::parse::<usize>);
    let (Some(Ok(behind)), Some(Ok(ahead)), None) = (counts.next(), counts.next(), counts.next()) else {
        return Err(failed());
    };
    let head = git(&read, &tree, &["rev-parse", "--verify", "--quiet", "HEAD"], 256)
        .ok()
        .and_then(|(bytes, _)| line(&bytes));
    let current = git(&read, &tree, &["symbolic-ref", "--short", "-q", "HEAD"], 1024)
        .ok()
        .and_then(|(bytes, _)| line(&bytes));
    source.validate()?;
    tree.validate()?;
    Ok(json!({"headOid":head,"sourceBranch":source_branch,"exists":true,"registered":registered,"branch":current,"baseCommit":base_commit,"changedFiles":changed,"untrackedFiles":untracked,"ignoredFileCount":ignored,"ahead":ahead,"behind":behind,"clean":changed==0}))
}

/// The preview only asks Git about its index and trees; it opens no working
/// file. The same token the revert itself checks is registered natively.
#[tauri::command]
pub(crate) async fn remote_studio_revert_preview(
    window: WebviewWindow,
    root: String,
    path: Option<String>,
) -> Result<Value, String> {
    main(&window)?;
    if let Some(path) = &path {
        fs_guard::relative(path, false)?;
    }
    blocking(move || {
        let root = Anchor::open(Path::new(&root))?;
        let read = GitReadOperation::new();
        git_root(&read, &root)?;
        let cwd = root.path.to_str().ok_or_else(failed)?;
        let preview = match &path {
            Some(path) => serde_json::to_value(
                crate::git_workspace::revert_preview_sync(cwd, path).map_err(|_| failed())?,
            ),
            None => serde_json::to_value(
                crate::git_workspace::revert_all_preview_sync(cwd).map_err(|_| failed())?,
            ),
        };
        root.validate()?;
        preview.map_err(|_| failed())
    })
    .await
}

fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// `path` comes from the host's own transcript. The bytes must really be an
/// image, so a message naming some other file gets nothing back.
#[tauri::command]
pub(crate) async fn remote_studio_attachment_image(
    window: WebviewWindow,
    path: String,
    offset: usize,
) -> Result<Value, String> {
    main(&window)?;
    blocking(move || attachment_image(&path, offset)).await
}
fn attachment_image(path: &str, offset: usize) -> Result<Value, String> {
    let path = Path::new(path);
    let parent = path.parent().ok_or_else(failed)?;
    let name = path.file_name().and_then(|name| name.to_str()).ok_or_else(failed)?;
    let folder = Anchor::open(parent)?;
    let (bytes, too_large) = folder.read(name, MAX_IMAGE_BYTES)?;
    if too_large {
        return Ok(json!({"tooLarge":true}));
    }
    let mime = image_type(&bytes).ok_or_else(failed)?;
    if offset >= bytes.len() {
        return Err(failed());
    }
    let end = (offset + IMAGE_CHUNK_BYTES).min(bytes.len());
    folder.validate()?;
    Ok(json!({"mime":mime,"size":bytes.len(),"data":STANDARD.encode(&bytes[offset..end]),"done":end==bytes.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, process::Command};

    fn git_in(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git runs");
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }
    /// A repository with two commits, in a folder that goes away with the test.
    fn repository() -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("mythra-studio-extra-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp folder");
        let dir = dir.canonicalize().expect("canonical temp folder");
        git_in(&dir, &["init", "-q", "-b", "main"]);
        git_in(&dir, &["config", "user.email", "test@example.com"]);
        git_in(&dir, &["config", "user.name", "Test Author"]);
        fs::write(dir.join("a.txt"), "one\n").expect("write");
        git_in(&dir, &["add", "."]);
        git_in(&dir, &["commit", "-q", "-m", "First"]);
        fs::write(dir.join("a.txt"), "two\n").expect("write");
        git_in(&dir, &["commit", "-q", "-am", "Second"]);
        let text = dir.to_string_lossy().into_owned();
        (dir, text)
    }

    #[test]
    fn history_reads_pages_and_says_when_a_folder_has_no_git() {
        let (dir, root) = repository();
        let page = git_log(&root, 0, 1, None).expect("history");
        assert_eq!(page["repository"], true);
        assert_eq!(page["entries"][0]["subject"], "Second");
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["nextOffset"], 1);
        let head = page["headOid"].as_str().map(str::to_owned);
        let next = git_log(&root, 1, 5, head).expect("second page");
        assert_eq!(next["entries"][0]["subject"], "First");
        assert_eq!(next["hasMore"], false);
        // Outside any repository, or this would find the one above it.
        let outside = std::env::temp_dir().join(format!("mythra-plain-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&outside).expect("folder");
        let none = git_log(outside.to_str().expect("utf-8"), 0, 1, None).expect("no repository is an answer");
        assert_eq!(none["repository"], false);
        let _ = fs::remove_dir_all(outside);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checkpoint_diff_compares_saved_refs_only() {
        let (dir, root) = repository();
        git_in(&dir, &["update-ref", "refs/openkiwi/checkpoints/c/before", "HEAD~1"]);
        git_in(&dir, &["update-ref", "refs/openkiwi/checkpoints/c/after", "HEAD"]);
        let before = crate::project_git::checkpoint_ref("c", "before").expect("ref");
        let after = crate::project_git::checkpoint_ref("c", "after").expect("ref");
        fs::write(dir.join("a.txt"), "not saved\n").expect("write");
        let diff = checkpoint_diff(&root, &before, &after).expect("diff");
        let text = diff["text"].as_str().expect("text");
        assert!(text.contains("-one") && text.contains("+two"), "{text}");
        assert!(!text.contains("not saved"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn worktree_status_counts_a_real_linked_worktree() {
        let (dir, root) = repository();
        let tree = dir.parent().expect("parent").join(format!("mythra-tree-{}", uuid::Uuid::new_v4()));
        let path = tree.to_string_lossy().into_owned();
        git_in(&dir, &["worktree", "add", "-q", "-b", "side", &path]);
        fs::write(tree.join("new.txt"), "x").expect("write");
        let status = worktree_status(&root, &path, "side", "base").expect("status");
        assert_eq!(status["exists"], true);
        assert_eq!(status["registered"], true);
        assert_eq!(status["branch"], "side");
        assert_eq!(status["sourceBranch"], "main");
        assert_eq!(status["changedFiles"], 1);
        assert_eq!(status["untrackedFiles"], 1);
        assert_eq!(status["clean"], false);
        git_in(&dir, &["worktree", "remove", "--force", &path]);
        let gone = worktree_status(&root, &path, "side", "base").expect("a missing folder is an answer");
        assert_eq!(gone["exists"], false);
        assert!(!plain_ref("-evil") && !plain_ref("a..b") && plain_ref("feature/one"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn images_must_be_images_and_stay_bounded() {
        let dir = std::env::temp_dir().join(format!("mythra-image-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("folder");
        let dir = dir.canonicalize().expect("canonical");
        let png = dir.join("a.png");
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(IMAGE_CHUNK_BYTES + 10, 1);
        fs::write(&png, &bytes).expect("write");
        let first = attachment_image(png.to_str().expect("utf-8"), 0).expect("first chunk");
        assert_eq!(first["mime"], "image/png");
        assert_eq!(first["done"], false);
        let last = attachment_image(png.to_str().expect("utf-8"), IMAGE_CHUNK_BYTES).expect("last chunk");
        assert_eq!(last["done"], true);
        assert!(attachment_image(png.to_str().expect("utf-8"), bytes.len()).is_err());
        let secret = dir.join("secret.png");
        fs::write(&secret, "password=hunter2").expect("write");
        assert!(attachment_image(secret.to_str().expect("utf-8"), 0).is_err(), "a name is not proof of an image");
        #[cfg(unix)]
        {
            let link = dir.join("link.png");
            std::os::unix::fs::symlink(&png, &link).expect("link");
            assert!(attachment_image(link.to_str().expect("utf-8"), 0).is_err(), "links are not followed");
        }
        let huge = dir.join("huge.png");
        let mut large = bytes;
        large.resize(MAX_IMAGE_BYTES + 1, 0);
        fs::write(&huge, &large).expect("write");
        assert_eq!(attachment_image(huge.to_str().expect("utf-8"), 0).expect("answer")["tooLarge"], true);
        let _ = fs::remove_dir_all(dir);
    }
}
