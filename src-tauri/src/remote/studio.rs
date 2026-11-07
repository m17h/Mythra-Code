//! Read-only Studio. Native paths never cross the LAN; no provider or shell
//! fallback. Git reads use anchored cwd, raw blobs and opened regular files.
use super::{
    fs_guard::{self, Anchor},
    hostbridge,
    store::GrantScope,
    RemoteState,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};
use tokio::sync::Semaphore;
pub(super) fn failed() -> String {
    "The other device couldn't safely read this Studio item.".into()
}
fn gate() -> Arc<Semaphore> {
    static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Semaphore::new(4))).clone()
}
pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = gate()
        .try_acquire_owned()
        .map_err(|_| "The other device is reading other Studio items. Try again shortly.".to_string())?;
    tokio::time::timeout(
        Duration::from_secs(20),
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let _read_policy=super::safe_git::enter();
            work()
        }),
    )
    .await
    .map_err(|_| failed())?
    .map_err(|_| failed())?
}
pub(super) fn main(window: &WebviewWindow) -> Result<(), String> {
    hostbridge::window_is_host(window).map_err(|_| failed())
}
#[tauri::command]
pub(crate) async fn remote_studio_files_list(
    window: WebviewWindow,
    root: String,
    relative_directory: String,
    after: Option<String>,
    limit: usize,
) -> Result<Value, String> {
    main(&window)?;
    if !(1..=200).contains(&limit) || after.as_ref().is_some_and(|name| !fs_guard::leaf(name)) {
        return Err(failed());
    }
    blocking(move || {
        let root = Anchor::open(Path::new(&root))?;
        let directory = root.directory(&relative_directory)?;
        let entries = directory.entries()?;
        let mut rows: Vec<_> = entries
            .into_iter()
            .filter(|entry| {
                after
                    .as_ref()
                    .is_none_or(|after| entry.name.as_str() > after.as_str())
            })
            .collect();
        let truncated = rows.len() > limit;
        rows.truncate(limit);
        let next = if truncated {
            rows.last().map(|row| row.name.clone())
        } else {
            None
        };
        root.validate()?;
        Ok(json!({"entries":rows,"next":next,"truncated":truncated}))
    })
    .await
}
pub(super) fn git(
    read: &crate::project_git::GitReadOperation,
    root: &Anchor,
    args: &[&str],
    limit: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut flags = vec![
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "diff.external=",
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.srcPrefix=a/",
        "-c",
        "diff.dstPrefix=b/",
    ];
    flags.extend_from_slice(args);
    let (output, truncated) = read
        .bounded_output(&root.git_cwd(), &flags, limit)
        .map_err(|_| failed())?;
    if !output.status.success() {
        return Err(failed());
    }
    Ok((output.stdout, truncated))
}
pub(super) fn git_root(read: &crate::project_git::GitReadOperation, root: &Anchor) -> Result<(), String> {
    let (bytes, truncated) = git(read, root, &["rev-parse", "--show-toplevel"], 8192)?;
    if truncated {
        return Err(failed());
    }
    let path = PathBuf::from(
        std::str::from_utf8(&bytes)
            .map_err(|_| failed())?
            .trim_end(),
    );
    let actual = Anchor::open(&path)?;
    if actual.identity()? != root.identity()? {
        return Err("Open the repository's own root folder to inspect Git remotely.".into());
    }
    // Every read is independently isolated from executable repository config;
    // LFS and custom drivers are never executed, including under config races.

    root.validate()
}
fn status(
    read: &crate::project_git::GitReadOperation,
    root: &Anchor,
    limit: usize,
) -> Result<Value, String> {
    let (bytes, truncated) = git(
        read,
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ],
        2 * 1024 * 1024,
    )?;
    let raw = crate::git_inspection::changes_from_status(&root.path, &bytes, truncated, 2000)
        .map_err(|_| failed())?;
    let raw = serde_json::to_value(raw).map_err(|_| failed())?;
    let mut rows = Vec::new();
    for row in raw
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(failed)?
    {
        let path = row.get("path").and_then(Value::as_str).ok_or_else(failed)?;
        if fs_guard::relative(path, false).is_err() {
            continue;
        }
        if row
            .get("originalPath")
            .filter(|value| !value.is_null())
            .is_some_and(|value| {
                !value
                    .as_str()
                    .is_some_and(|path| fs_guard::relative(path, false).is_ok())
            })
        {
            continue;
        }
        rows.push(row.clone());
    }
    let staged = rows.iter().filter(|row| row["area"] == "staged").count();
    let unstaged = rows.iter().filter(|row| row["area"] == "unstaged").count();
    let untracked = rows.iter().filter(|row| row["area"] == "untracked").count();
    let changed = rows
        .iter()
        .filter_map(|row| row["path"].as_str())
        .collect::<HashSet<_>>()
        .len();
    let more = rows.len() > limit || raw["truncated"] == true;
    rows.truncate(limit);
    root.validate()?;
    Ok(
        json!({"rows":rows,"stagedFiles":staged,"unstagedFiles":unstaged,"untrackedFiles":untracked,"changedFiles":changed,"truncated":more}),
    )
}
#[tauri::command]
pub(crate) async fn remote_studio_git_status(
    window: WebviewWindow,
    root: String,
    limit: usize,
) -> Result<Value, String> {
    main(&window)?;
    if !(1..=200).contains(&limit) {
        return Err(failed());
    }
    blocking(move || {
        let root = Anchor::open(Path::new(&root))?;
        let read = crate::project_git::GitReadOperation::new();
        git_root(&read, &root)?;
        status(&read, &root, limit)
    })
    .await
}
fn blob(
    read: &crate::project_git::GitReadOperation,
    root: &Anchor,
    path: &str,
    index: bool,
) -> Result<(Vec<u8>, bool), String> {
    fs_guard::relative(path, false)?;
    let (entry, truncated) = if index {
        git(
            read,
            root,
            &["ls-files", "--stage", "-z", "--", path],
            16384,
        )?
    } else {
        let args = [
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "rev-parse",
            "--verify",
            "--quiet",
            "HEAD^{commit}",
        ];
        let (output, truncated) = read
            .bounded_output(&root.git_cwd(), &args, 8192)
            .map_err(|_| failed())?;
        if output.status.code() == Some(1) {
            return Ok((Vec::new(), false));
        }
        if !output.status.success() || truncated {
            return Err(failed());
        }
        let oid = std::str::from_utf8(&output.stdout)
            .map_err(|_| failed())?
            .trim();
        if !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(failed());
        }
        git(read, root, &["ls-tree", "-z", oid, "--", path], 16384)?
    };
    if truncated {
        return Err(failed());
    }
    if entry.is_empty() {
        return Ok((Vec::new(), false));
    }
    let entry = std::str::from_utf8(&entry).map_err(|_| failed())?;
    let (meta, name) = entry.split_once('\t').ok_or_else(failed)?;
    if name.trim_end_matches('\0') != path {
        return Err(failed());
    }
    let words: Vec<_> = meta.split(' ').collect();
    if words.len() != 3
        || !["100644", "100755"].contains(&words[0])
        || index && words[2] != "0"
        || !index && words[1] != "blob"
    {
        return Err("This Git item is not a regular file preview.".into());
    }
    let oid = if index { words[1] } else { words[2] };
    if !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) || oid.len() > 64 {
        return Err(failed());
    }
    git(read, root, &["cat-file", "blob", oid], 128 * 1024)
}
#[tauri::command]
pub(crate) async fn remote_studio_git_diff(
    window: WebviewWindow,
    root: String,
    path: String,
    area: String,
) -> Result<Value, String> {
    main(&window)?;
    fs_guard::relative(&path, false)?;
    if !["staged", "unstaged", "untracked"].contains(&area.as_str()) {
        return Err(failed());
    }
    blocking(move||{let root=Anchor::open(Path::new(&root))?;let read=crate::project_git::GitReadOperation::new();git_root(&read,&root)?;let current=status(&read,&root,2000)?;let row=current["rows"].as_array().and_then(|rows|rows.iter().find(|row|row["path"]==path&&row["area"]==area)).ok_or_else(failed)?;
        let original=row.get("originalPath").and_then(Value::as_str).unwrap_or(&path);
        let (before,old_truncated)=if area=="untracked"{(Vec::new(),false)}else{blob(&read,&root,original,area!="staged")?};
        let (after,new_truncated)=if area=="staged"{blob(&read,&root,&path,true)?}else{
            // A deletion is a Git-owned fact, not any arbitrary failed open.
            if row["status"].as_str().is_some_and(|status|status.contains('D')){(Vec::new(),false)}else{root.read(&path,128*1024)?}
        };
        let binary=before.contains(&0)||after.contains(&0)||std::str::from_utf8(&before).is_err()||std::str::from_utf8(&after).is_err();let mut truncated=old_truncated||new_truncated;
        let mut text=String::new();if !binary{let old=std::str::from_utf8(&before).map_err(|_|failed())?;let new=std::str::from_utf8(&after).map_err(|_|failed())?;
            // Full-file unified hunks avoid invoking external diff/textconv or
            // Git's racy worktree/filter reads. Both inputs are already bounded.
            if old!=new || original!=path {text=format!("diff --git a/{original} b/{path}\n--- a/{original}\n+++ b/{path}\n@@ -1,{} +1,{} @@\n",old.lines().count(),new.lines().count());
            for (prefix,body)in[("-",old),("+",new)]{for line in body.lines(){if text.len()+line.len()+2>128*1024{truncated=true;break;}text.push_str(prefix);text.push_str(line);text.push('\n');}if !body.is_empty()&&!body.ends_with('\n'){text.push_str("\\ No newline at end of file\n");}}}
        }root.validate()?;Ok(json!({"path":path,"area":area,"text":text,"binary":binary,"truncated":truncated}))}).await
}
pub(super) fn check_scope(
    state: &RemoteState,
    generation: u64,
    device: &str,
    revision: u64,
    workspace: Option<&str>,
    manage: bool,
) -> Result<(), String> {
    let core = state.inner.lock();
    hostbridge::check_generation(&core, generation).map_err(|_| failed())?;
    let grant = super::work::grant_locked(&core, device)
        .filter(|grant| grant.view && grant.revision == revision)
        .ok_or_else(failed)?;
    if manage {
        super::manifest::access("folders.browse", &grant).map_err(|_| failed())?;
    } else if let GrantScope::Projects { project_ids } = &grant.scope {
        if !workspace.is_some_and(|id| project_ids.iter().any(|project| project == id)) {
            return Err(failed());
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn remote_work_files_search(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    workspace_id: String,
    root: String,
    query: String,
    limit: usize,
) -> Result<Value, String> {
    main(&window)?;
    check_scope(
        &state,
        generation,
        &device,
        grant_revision,
        Some(&workspace_id),
        false,
    )?;
    if query.trim().is_empty() || query.len() > 256 || limit == 0 || limit > 100 {
        return Err(failed());
    }
    let result=blocking(move||{let root=Anchor::open(Path::new(&root))?;let deadline=Instant::now()+Duration::from_secs(5);let query=query.to_lowercase();let mut pending=vec![String::new()];let mut files=Vec::new();let mut seen=0;let mut truncated=false;
        while let Some(path)=pending.pop(){if Instant::now()>deadline||seen>=10000{truncated=true;break;}let directory=root.directory(&path)?;let entries=directory.entries()?;for entry in entries{seen+=1;let relative=if path.is_empty(){entry.name.clone()}else{format!("{path}/{}",entry.name)};if relative.len()>2048||relative.split('/').count()>32{truncated=true;continue;}
            if entry.kind=="directory"{if pending.len()<1024{pending.push(relative);}else{truncated=true;}}else if relative.to_lowercase().contains(&query){files.push(json!({"id":uuid::Uuid::new_v4().to_string(),"name":entry.name,"relativePath":relative}));if files.len()>=limit{truncated=true;break;}}}if files.len()>=limit{break;}}
        root.validate()?;Ok(json!({"files":files,"truncated":truncated}))}).await?;
    check_scope(
        &state,
        generation,
        &device,
        grant_revision,
        Some(&workspace_id),
        false,
    )?;
    Ok(result)
}

/// Same host-only arguments as the local preview, but no symlink resolution or
/// link-target-text fallback, even if a listed file is replaced before opening.
#[tauri::command]
pub(crate) async fn remote_studio_file_preview(
    window: WebviewWindow,
    root: String,
    path: String,
) -> Result<Value, String> {
    main(&window)?;
    blocking(move || {
        let requested = Path::new(&root);
        let path = Path::new(&path);
        if !requested.is_absolute() || !path.is_absolute() {
            return Err(failed());
        }
        let relative = path
            .strip_prefix(requested)
            .map_err(|_| failed())?
            .to_str()
            .ok_or_else(failed)?
            .to_owned();
        #[cfg(windows)]
        let relative = relative.replace('\\', "/");
        fs_guard::relative(&relative, false)?;
        let root = Anchor::open(requested)?;
        let (mut bytes, truncated) = root.read(&relative, 128 * 1024)?;
        // A clipped final UTF-8 character is not a binary-file indication.
        if truncated {
            if let Err(error) = std::str::from_utf8(&bytes) {
                if error.error_len().is_none() {
                    bytes.truncate(error.valid_up_to());
                }
            }
        }
        let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
        let text = if binary {
            String::new()
        } else {
            String::from_utf8(bytes).map_err(|_| failed())?
        };
        root.validate()?;
        Ok(json!({"text":text,"binary":binary,"truncated":truncated}))
    })
    .await
}
