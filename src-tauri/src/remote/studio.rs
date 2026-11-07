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
    path::Path,
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
    let permit = gate().try_acquire_owned().map_err(|_| {
        "The other device is reading other Studio items. Try again shortly.".to_string()
    })?;
    tokio::time::timeout(
        Duration::from_secs(20),
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let _read_policy = super::safe_git::enter();
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
pub(super) fn git_root(
    _read: &crate::project_git::GitReadOperation,
    root: &Anchor,
) -> Result<(), String> {
    super::git_metadata::locations(&root.path).map_err(|_| {
        "Open the repository's own root folder to inspect Git remotely.".to_string()
    })?;
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
            "--ignore-submodules=dirty",
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
    blocking(move || git_diff(&root, &path, &area)).await
}
fn git_diff(root: &str, path: &str, area: &str) -> Result<Value, String> {
    let root = Anchor::open(Path::new(&root))?;
    let read = crate::project_git::GitReadOperation::new();
    git_root(&read, &root)?;
    let current = status(&read, &root, 2000)?;
    let row = current["rows"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["path"] == path && row["area"] == area)
        })
        .ok_or_else(failed)?;
    let original = row
        .get("originalPath")
        .and_then(Value::as_str)
        .unwrap_or(path);
    let (entry, _) = git(
        &read,
        &root,
        &["ls-files", "--stage", "-z", "--", path],
        16384,
    )?;
    if entry.starts_with(b"160000 ") {
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--submodule=short",
            "--ignore-submodules=dirty",
        ];
        if area == "staged" {
            args.push("--cached");
        }
        args.extend(["--", path]);
        let (bytes, truncated) = git(&read, &root, &args, 128 * 1024)?;
        root.validate()?;
        return Ok(
            json!({"path":path,"area":area,"text":String::from_utf8_lossy(&bytes),"binary":false,"truncated":truncated}),
        );
    }
    let (before, old_truncated) = if area == "untracked" {
        (Vec::new(), false)
    } else {
        blob(&read, &root, original, area != "staged")?
    };
    let (after, new_truncated) = if area == "staged" {
        blob(&read, &root, &path, true)?
    } else {
        // A deletion is a Git-owned fact, not any arbitrary failed open.
        if row["status"]
            .as_str()
            .is_some_and(|status| status.contains('D'))
        {
            (Vec::new(), false)
        } else {
            root.read(path, 128 * 1024)?
        }
    };
    let binary = before.contains(&0)
        || after.contains(&0)
        || std::str::from_utf8(&before).is_err()
        || std::str::from_utf8(&after).is_err();
    let mut truncated = old_truncated || new_truncated;
    let mut text = String::new();
    if !binary {
        let old = std::str::from_utf8(&before).map_err(|_| failed())?;
        let new = std::str::from_utf8(&after).map_err(|_| failed())?;
        // Full-file unified hunks avoid invoking external diff/textconv or
        // Git's racy worktree/filter reads. Both inputs are already bounded.
        if old != new || original != path {
            text=format!("diff --git a/{original} b/{path}\n--- a/{original}\n+++ b/{path}\n@@ -1,{} +1,{} @@\n",old.lines().count(),new.lines().count());
            for (prefix, body) in [("-", old), ("+", new)] {
                for line in body.lines() {
                    if text.len() + line.len() + 2 > 128 * 1024 {
                        truncated = true;
                        break;
                    }
                    text.push_str(prefix);
                    text.push_str(line);
                    text.push('\n');
                }
                if !body.is_empty() && !body.ends_with('\n') {
                    text.push_str("\\ No newline at end of file\n");
                }
            }
        }
    }
    root.validate()?;
    Ok(json!({"path":path,"area":area,"text":text,"binary":binary,"truncated":truncated}))
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

/// Identity checks around a status read must not scan/copy the full Git index
/// and branch list twice. Write previews still use the full guarded snapshot.
#[tauri::command]
pub(crate) async fn remote_studio_git_identity(
    window: WebviewWindow,
    root: String,
) -> Result<Value, String> {
    main(&window)?;
    blocking(move || git_identity(&root)).await
}
fn git_identity(path: &str) -> Result<Value, String> {
    let root = Anchor::open(Path::new(path))?;
    let read = crate::project_git::GitReadOperation::new();
    git_root(&read, &root)?;
    let (head, branch) = super::safe_git::live_head_identity(&root.git_cwd())?;
    root.validate()?;
    Ok(json!({"headOid":head,"branch":branch,"isRoot":true}))
}

/// Host-only baselines for remote writes. Never call the unrestricted local
/// snapshot/metadata commands from a View request.
#[tauri::command]
pub(crate) async fn remote_studio_git_snapshot(
    window: WebviewWindow,
    root: String,
) -> Result<Value, String> {
    main(&window)?;
    blocking(move || git_baseline(&root, false)).await
}
#[tauri::command]
pub(crate) async fn remote_studio_git_metadata(
    window: WebviewWindow,
    root: String,
) -> Result<Value, String> {
    main(&window)?;
    blocking(move || git_baseline(&root, true)).await
}
fn git_baseline(path: &str, metadata: bool) -> Result<Value, String> {
    let root = Anchor::open(Path::new(path))?;
    let read = crate::project_git::GitReadOperation::new();
    git_root(&read, &root)?;
    let cwd = root.git_cwd();
    let value = if metadata {
        serde_json::to_value(crate::github::github_repo_status_sync(
            cwd.to_str().ok_or_else(failed)?,
        )?)
        .map_err(|_| failed())?
    } else {
        serde_json::to_value(crate::git_workspace::snapshot_for_selection_with_read(
            &cwd,
            cwd.to_str().ok_or_else(failed)?,
            &read,
        )?)
        .map_err(|_| failed())?
    };
    root.validate()?;
    Ok(value)
}

#[cfg(test)]
mod baseline_tests {
    use super::*;
    #[test]
    fn remote_baseline_and_github_metadata_never_run_configured_programs() {
        let path =
            std::env::temp_dir().join(format!("mythra-safe-baseline-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let git = |args: &[&str]| {
            let output = crate::process_launch::background_std_command("git")
                .current_dir(&path)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Native test"]);
        git(&["config", "user.email", "native@example.invalid"]);
        std::fs::write(path.join("file"), "baseline\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "baseline"]);
        git(&[
            "remote",
            "add",
            "origin",
            "https://github.com/native-test/example.git",
        ]);
        git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(&["branch", "--set-upstream-to=origin/main", "main"]);
        std::fs::write(path.join("file"), "ahead\n").unwrap();
        git(&["commit", "-am", "ahead", "-q"]);
        std::fs::write(path.join("file"), "fresh context\n").unwrap();
        let local_context=crate::commit_message::read_context(path.to_str().unwrap()).unwrap();
        let marker = path.join("PROGRAM-RAN");
        let target = marker
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        let evil = format!("echo ran > '{target}'; exit 1");
        git(&["config", "core.fsmonitor", &evil]);
        git(&["config", "filter.evil.process", &evil]);
        git(&["config", "diff.external", &evil]);
        {
            let _policy = super::super::safe_git::enter();
            let snapshot = git_baseline(path.to_str().unwrap(), false).unwrap();
            assert_eq!(snapshot["isRoot"], true);
            assert_eq!(snapshot["branch"], "main");
            assert_eq!(snapshot["upstream"], "origin/main");
            assert_eq!(snapshot["upstreamRemote"], "origin");
            assert_eq!(snapshot["ahead"], 1);
            assert_eq!(snapshot["behind"], 0);
            let identity = git_identity(path.to_str().unwrap()).unwrap();
            assert_eq!(identity["branch"], snapshot["branch"]);
            assert_eq!(identity["headOid"], snapshot["headOid"]);
            let metadata = git_baseline(path.to_str().unwrap(), true).unwrap();
            assert_eq!(metadata["repository"], "native-test/example");
            let anchor=Anchor::open(&path).unwrap();let guarded_context=crate::commit_message::read_context(anchor.git_cwd().to_str().unwrap()).unwrap();assert_eq!(guarded_context.token,local_context.token);assert_eq!(guarded_context.staged_token,local_context.staged_token);assert_eq!(guarded_context.changes_token,local_context.changes_token);

            assert!(!marker.exists());
        }
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[cfg(test)]
mod performance_measurement {
    use super::*;
    fn read<T>(f: impl FnOnce() -> T) -> (T, u64) {
        let _p = super::super::safe_git::enter();
        let value = f();
        (value, super::super::safe_git::spawn_count())
    }
    fn changes(path: &str) -> Value {
        let root = Anchor::open(Path::new(path)).unwrap();
        let op = crate::project_git::GitReadOperation::new();
        git_root(&op, &root).unwrap();
        status(&op, &root, 200).unwrap()
    }
    /// Explicit real-data benchmark. Optional Git locks disabled: never updates the source index.
    #[test]
    #[ignore]
    fn real_repository_remote_git_latency() {
        let path = std::env::var("MYTHRA_GIT_BENCH_ROOT").expect("set MYTHRA_GIT_BENCH_ROOT");
        let diff = std::env::var("MYTHRA_GIT_BENCH_DIFF")
            .unwrap_or_else(|_| "src-tauri/src/remote/studio.rs".into());
        super::super::git_metadata::invalidate(Path::new(&path));
        let cold = Instant::now();
        let (_, count) = read(|| changes(&path));
        println!(
            "cold_studio_status: ms={:.2} git_spawns={count}",
            cold.elapsed().as_secs_f64() * 1000.
        );
        for name in [
            "plain_local_status_no_optional_locks",
            "wire_status_native_sequence",
            "identity_status_sequence",
            "studio_status",
            "guarded_baseline",
            "studio_diff",
        ] {
            let mut times = Vec::new();
            let mut counts = Vec::new();
            for _ in 0..10 {
                let start = Instant::now();
                let count = match name {
                    "plain_local_status_no_optional_locks" => {
                        let output = crate::process_launch::background_std_command("git")
                            .current_dir(&path)
                            .env("GIT_OPTIONAL_LOCKS", "0")
                            .args([
                                "status",
                                "--porcelain=v1",
                                "-z",
                                "--untracked-files=all",
                                "--ignore-submodules=dirty",
                            ])
                            .output()
                            .unwrap();
                        assert!(output.status.success(), "plain local status failed");
                        1
                    }
                    "wire_status_native_sequence" => {
                        let (a, n) = read(|| git_baseline(&path, false).unwrap());
                        let (_, m) = read(|| changes(&path));
                        let (b, p) = read(|| git_baseline(&path, false).unwrap());
                        assert_eq!(a["headOid"], b["headOid"]);
                        n + m + p
                    }
                    "identity_status_sequence" => {
                        let (a, n) = read(|| git_identity(&path).unwrap());
                        let (_, m) = read(|| changes(&path));
                        let (b, p) = read(|| git_identity(&path).unwrap());
                        assert_eq!(a, b);
                        n + m + p
                    }
                    "studio_status" => read(|| changes(&path)).1,
                    "guarded_baseline" => read(|| git_baseline(&path, false).unwrap()).1,
                    _ => read(|| git_diff(&path, &diff, "unstaged").unwrap()).1,
                };
                times.push(start.elapsed().as_secs_f64() * 1000.);
                counts.push(count);
            }
            times.sort_by(f64::total_cmp);
            counts.sort();
            println!(
                "{name}: median_ms={:.2} min_ms={:.2} max_ms={:.2} git_spawns={}..{}",
                times[5], times[0], times[9], counts[0], counts[9]
            );
        }
    }
}

#[tauri::command]
pub(crate) async fn remote_studio_commit_context(window:WebviewWindow,root:String)->Result<Value,String>{
 main(&window)?;blocking(move||{let anchor=Anchor::open(Path::new(&root))?;let read=crate::project_git::GitReadOperation::new();git_root(&read,&anchor)?;let result=crate::commit_message::read_context(anchor.git_cwd().to_str().ok_or_else(failed)?)?;anchor.validate()?;serde_json::to_value(result).map_err(|_|failed())}).await
}
#[cfg(all(test,windows))]
mod windows_release_tests{
 use super::*;
 use super::super::windows_tests::{git,TempRoot};
 #[tokio::test]
 async fn completed_studio_reads_release_repository_handles_while_config_cache_stays_warm(){
  let temp=TempRoot::new("completed reads release handles");let root=temp.0.join("repository");std::fs::create_dir(&root).unwrap();git(&root,&["init","-q","-b","main"]);std::fs::write(root.join("file"),"initial\n").unwrap();git(&root,&["add","file"]);git(&root,&["-c","user.name=Release test","-c","user.email=test@example.invalid","commit","-qm","initial"]);
  for iteration in 0..3{
   let path=root.to_string_lossy().into_owned();blocking(move||git_baseline(&path,false)).await.unwrap();
   // Use the SAME production wrapper as native Studio commands, with no
   // external Anchor and no cache invalidation, retry, sleep, or process kill.
   let moved=temp.0.join(format!("moved-{iteration}"));std::fs::rename(&root,&moved).expect("no completed remote read may retain a repository delete lock");std::fs::rename(&moved,&root).unwrap();
  }
  std::fs::remove_dir_all(&root).expect("warm inert config cache must contain no file handles");
 }
}
