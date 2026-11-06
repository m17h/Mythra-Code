//! Typed native Git/checkpoint/worktree adapters. Their local helpers and safety
//! order are retained; a thread-scoped fence covers each actual native spawn.
use super::{
    commit::{self, Stamp},
    fs_guard::Anchor,
    hostbridge, store, work, Inner, RemoteState,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, State, WebviewWindow};
thread_local! {static ACTIVE:RefCell<Option<Arc<Fence>>>=const{RefCell::new(None)};}
struct Fence {
    inner: Arc<Inner>,
    stamp: Stamp,
    operation: String,
    anchors: Vec<Anchor>,
    deadline: Instant,
}
struct Reset;
impl Drop for Reset {
    fn drop(&mut self) {
        ACTIVE.with(|slot| {
            slot.replace(None);
        });
    }
}
fn current() -> Option<Arc<Fence>> {
    ACTIVE.with(|slot| slot.borrow().clone())
}
fn stale() -> String {
    work::refused("stale_target")
}
fn uncertain() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: The host could not confirm this repository change. Inspect it before trying again.".into()
}
/// The None path calls the exact original local spawn, with no changed flags.
pub(crate) fn spawn_gate<T>(spawn: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let Some(fence) = current() else {
        return spawn();
    };
    if Instant::now() >= fence.deadline {
        return Err(uncertain());
    }
    let core = fence.inner.lock();
    fence.stamp.check(&core, &fence.operation)?;
    let grant = work::authorize(
        &core,
        &fence.stamp.meta(),
        fence.stamp.workspace_id.as_deref(),
    )
    .map_err(|_| stale())?;
    if !grant.capabilities.terminal {
        return Err(work::refused("forbidden"));
    }
    for anchor in &fence.anchors {
        anchor.validate()?;
    }
    spawn()
}
/// Only remote workers use this bounded replacement for old unbounded output.
pub(crate) fn output(
    command: &mut std::process::Command,
) -> Option<Result<std::process::Output, String>> {
    output_with_input(command, None)
}
pub(crate) fn output_with_input(
    command: &mut std::process::Command,
    input: Option<&[u8]>,
) -> Option<Result<std::process::Output, String>> {
    let fence = current()?;
    Some((|| {
        if input.is_some_and(|input| input.len() > 8 * 1024 * 1024) {
            return Err(uncertain());
        }
        command
            .stdin(if input.is_some() {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let (mut child, scope) = crate::git_workspace::spawn_scoped_git(command)?;
        let input_done = if let Some(input) = input {
            use std::io::Write;
            let mut stdin = child.stdin.take().ok_or_else(uncertain)?;
            let data = input.to_vec();
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send(stdin.write_all(&data));
            });
            Some(receiver)
        } else {
            None
        };
        let stdout = child.stdout.take().ok_or_else(uncertain)?;
        let stderr = child.stderr.take().ok_or_else(uncertain)?;
        let overflow = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = std::sync::mpsc::channel();
        for (mut pipe, kind) in [
            (Box::new(stdout) as Box<dyn Read + Send>, false),
            (Box::new(stderr) as Box<dyn Read + Send>, true),
        ] {
            let overflow = overflow.clone();
            let sender = sender.clone();
            std::thread::spawn(move || {
                let mut data = Vec::new();
                let mut buffer = [0u8; 16384];
                loop {
                    match pipe.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if data.len() + n <= 2 * 1024 * 1024 {
                                data.extend_from_slice(&buffer[..n]);
                            } else {
                                overflow.store(true, Ordering::Release);
                            }
                        }
                        Err(_) => {
                            overflow.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
                let _ = sender.send((kind, data));
            });
        }
        drop(sender);
        let status = loop {
            if overflow.load(Ordering::Acquire) || Instant::now() >= fence.deadline {
                return Err(scope.stop(&mut child, uncertain()));
            }
            if let Some(status) = child.try_wait().map_err(|_| uncertain())? {
                break status;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        for _ in 0..2 {
            let remaining = fence.deadline.saturating_duration_since(Instant::now());
            let (kind, data) = receiver
                .recv_timeout(remaining)
                .map_err(|_| scope.stop(&mut child, uncertain()))?;
            if kind {
                err = data;
            } else {
                out = data;
            }
        }
        if let Some(done) = input_done {
            let written = done
                .recv_timeout(fence.deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| uncertain())?;
            if written.is_err() && status.success() {
                return Err(uncertain());
            }
        }
        if overflow.load(Ordering::Acquire) {
            return Err(uncertain());
        }
        Ok(std::process::Output {
            status,
            stdout: out,
            stderr: err,
        })
    })())
}
/// File-removal boundaries in checkpoint restore use the same authority fence.
pub(crate) fn filesystem_gate<T>(change: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    spawn_gate(change)
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 32768 && !s.contains('\0'))
        .ok_or_else(stale)
}
fn optional<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}
fn flag(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| uncertain())
}
#[tauri::command]
pub(crate) async fn remote_domain_execute(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    root: String,
    action: String,
    args: Value,
    bookkeeping: Option<super::bookkeeping::Bookkeeping>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if serde_json::to_vec(&args).map_or(true, |b| b.len() > 64 * 1024) {
        return Err(stale());
    }
    let expected_op = if action.starts_with("git.") {
        "git.write".to_owned()
    } else {
        action.clone()
    };
    let inner = state.inner.clone();
    let stamp_for_read = stamp.clone();
    let op_for_read = expected_op.clone();
    let replay = state
        .inner
        .read_db(move |db| {
            if commit::operation(db, &stamp_for_read)? != op_for_read {
                return Err(stale());
            }
            commit::prior(db, &stamp_for_read)?.map(|result|Ok(json!({"result":result,"rows":super::bookkeeping::rows(db,&op_for_read)?,"replayed":true}))).transpose()
        })
        .await?;
    if let Some(result) = replay {
        return Ok(result);
    }
    let root_for_state = root.clone();
    let root_for_latch = root.clone();
    let args_for_latch = args.clone();
    let book_for_latch = bookkeeping.clone();
    let anchor = super::studio::blocking(move || Anchor::open(Path::new(&root))).await?;
    let project_lock = crate::git_workspace::repository_lock(&anchor.path).await?;
    let guard = project_lock.lock_owned().await;
    let stamp_for_latch = stamp.clone();
    let operation = expected_op.clone();
    let saved=state.inner.enqueue_write(false,move|db|{
        if commit::operation(db,&stamp_for_latch)?!=operation{return Err(stale());}
        if let Some(result)=commit::prior(db,&stamp_for_latch)?{return Ok(Some(json!({"result":result,"rows":super::bookkeeping::rows(db,&operation)?,"replayed":true})));}
        super::bookkeeping::verify(db,&operation,book_for_latch.as_ref())?;super::bookkeeping::preflight(&operation,&stamp_for_latch,&root_for_latch,&args_for_latch,book_for_latch.as_ref())?;
        let core=inner.lock();stamp_for_latch.check(&core,&operation)?;
        let receipt=json!({"generation":stamp_for_latch.generation,"device":stamp_for_latch.device,"opId":stamp_for_latch.op_id,"opSeq":stamp_for_latch.op_seq,"workspaceId":stamp_for_latch.workspace_id,"threadId":stamp_for_latch.thread_id,"disposition":"dispatched","domainStarted":true});
        // Receipt owner uniqueness is durable before entering a blocking helper.
        if store::delivery_receipt(db,&stamp_for_latch.device,&stamp_for_latch.op_id,stamp_for_latch.op_seq)?.is_some_and(|r|r.get("domainStarted").and_then(Value::as_bool)==Some(true)){return Err(stale());}
        store::save_delivery_receipt(db,&stamp_for_latch.device,&stamp_for_latch.op_id,stamp_for_latch.op_seq,&receipt)?;Ok(None)
    });
    if let Some(result) = super::finish_write(saved).await? {
        return Ok(result);
    }
    let worker = state.inner.clone();
    let stamp_worker = stamp.clone();
    let op_worker = expected_op.clone();
    let owned_thread = stamp.thread_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;let mut bookkeeping=bookkeeping;
        let payload=(||{
        anchor.validate()?;
        let root = anchor.path.to_string_lossy().into_owned();
        let mut anchors = vec![anchor];
        if let Some(path) = optional(&args, "worktreePath").filter(|_| action != "worktree.remove")
        {
            anchors.push(Anchor::open(Path::new(path))?);
        }
        let fence = Arc::new(Fence {
            inner: worker.clone(),
            stamp: stamp_worker.clone(),
            operation: op_worker.clone(),
            anchors,
            deadline: Instant::now() + Duration::from_secs(120),
        });
        ACTIVE.with(|slot| slot.replace(Some(fence)));
        let _reset = Reset;
        // Refuse the local helpers' implicit expansion to a parent repository.
        // Initialize is the one action with no repository to check yet.
        let repo = if action == "git.init" {
            std::fs::canonicalize(&root).map_err(|_| stale())?
        } else {
            crate::project_git::checkpoint_repo(&root)?
        };
        if repo != std::fs::canonicalize(&root).map_err(|_| stale())? {
            return Err(stale());
        }
        match action.as_str() {
            "git.init" => value(crate::project_git::initialize_workspace_git_sync(&root)?),
            "git.stage" | "git.unstage" => {
                if let Some(path) = optional(&args, "path") {
                    super::fs_guard::relative(path, false)?;
                }
                value(crate::git_workspace::stage_sync(
                    &root,
                    optional(&args, "path"),
                    action == "git.unstage",
                    optional(&args, "expectedHeadOid"),
                    optional(&args, "expectedBranch"),
                )?)
            }
            "git.commit" => value(crate::git_workspace::commit_sync(
                &root,
                string(&args, "message")?,
                flag(&args, "stagedOnly"),
                optional(&args, "expectedHeadOid"),
                optional(&args, "expectedBranch"),
            )?),
            "git.branch" => value(crate::git_workspace::branch_sync(
                &root,
                string(&args, "name")?,
                flag(&args, "create"),
                string(&args, "expectedHeadOid")?,
                string(&args, "expectedBranch")?,
            )?),
            "git.push" => value(crate::git_workspace::push_sync(
                &root,
                string(&args, "expectedHeadOid")?,
                string(&args, "expectedBranch")?,
                string(&args, "expectedRemoteUrl")?,
                string(&args, "expectedRepository")?,
            )?),
            "git.pull" => value(crate::git_workspace::pull_sync(
                &root,
                string(&args, "expectedHeadOid")?,
                string(&args, "expectedBranch")?,
                string(&args, "expectedRemoteUrl")?,
                string(&args, "expectedRepository")?,
            )?),
            "git.fetch" => value(crate::git_workspace::fetch_sync(&root)?),
            "git.update" => value(crate::git_workspace::update_sync(
                &root,
                string(&args, "expectedRepository")?,
                string(&args, "base")?,
                string(&args, "expectedHeadOid")?,
                string(&args, "expectedBranch")?,
            )?),
            "git.revert" => value(crate::git_workspace::revert_sync(
                &root,
                string(&args, "path")?,
                string(&args, "confirmationToken")?,
            )?),
            "git.revertAll" => value(crate::git_workspace::revert_all_sync(
                &root,
                string(&args, "confirmationToken")?,
            )?),
            "checkpoint.create" => value(crate::project_git::capture_checkpoint_snapshot(
                string(&args, "checkpointId")?,
                &root,
                "before",
                string(&args, "label")?,
            )?),
            "checkpoint.complete" => {
                let id = string(&args, "checkpointId")?;
                let snapshot = crate::project_git::capture_checkpoint_snapshot(
                    id,
                    &root,
                    "after",
                    string(&args, "label")?,
                )?;
                let before = crate::project_git::checkpoint_ref(id, "before")?;
                let after = crate::project_git::checkpoint_ref(id, "after")?;
                let (changed_files, additions, deletions) =
                    crate::project_git::checkpoint_diff_stats(&repo, &before, &after)?;
                value(crate::project_git::CheckpointCompleted {
                    snapshot,
                    changed_files,
                    additions,
                    deletions,
                })
            }
            "checkpoint.delete" => {
                let id = string(&args, "checkpointId")?;
                for phase in ["before", "after"] {
                    let reference = crate::project_git::checkpoint_ref(id, phase)?;
                    crate::project_git::git_stdout(&repo, &["update-ref", "-d", &reference], None)?;
                }
                Ok(Value::Null)
            }
            "checkpoint.restore" => {
                if !flag(&args, "confirmed") {
                    return Err(stale());
                }
                let id = string(&args, "checkpointId")?;
                let safety = format!("remote-safety-{}", uuid::Uuid::new_v4());
                capture_safety(&worker,&stamp_worker,&op_worker,&root_for_state,&root,&args,&mut bookkeeping,&safety,"Before remote restore")?;
                let mut restored=value(crate::project_git::restore_checkpoint_snapshot(id,&root,string(&args,"target")?,&safety)?)?;
                if let Some((thread,source,baseline))=super::bookkeeping::restore_baseline(&stamp_worker,bookkeeping.as_ref().ok_or_else(stale)?,&args)?{let tree=crate::project_git::set_worktree_applied_baseline_sync(&source,&thread,&baseline)?;restored["worktreeAppliedTree"]=json!(tree);}
                Ok(restored)
            }
            "worktree.create" => value(crate::project_git::worktree_create_sync(
                &app,
                &root,
                string(&args, "label")?,
            )?),
            "worktree.recreate" => value(crate::project_git::worktree_recreate_sync(
                &app,
                &root,
                string(&args, "branch")?,
                string(&args, "label")?,
            )?),
            "worktree.baseline" => value(crate::project_git::set_worktree_applied_baseline_sync(
                &root,
                owned_thread.as_deref().ok_or_else(stale)?,
                string(&args, "baseline")?,
            )?),
            "worktree.merge" => {
                if !flag(&args, "confirmed") {
                    return Err(stale());
                }
                let expected_branch = string(&args, "expectedSourceBranch")?;
                let expected_head = string(&args, "expectedSourceHeadOid")?;
                if crate::project_git::optional_git_stdout(
                    &repo,
                    &["symbolic-ref", "--short", "-q", "HEAD"],
                )
                .as_deref()
                    != Some(expected_branch)
                    || crate::project_git::optional_git_stdout(
                        &repo,
                        &["rev-parse", "--verify", "HEAD"],
                    )
                    .as_deref()
                        != Some(expected_head)
                {
                    return Err(stale());
                }
                let safety = format!("remote-safety-{}", uuid::Uuid::new_v4());
                capture_safety(&worker,&stamp_worker,&op_worker,&root_for_state,&root,&args,&mut bookkeeping,&safety,"Before remote worktree merge")?;
                let reference = crate::project_git::worktree_applied_ref(
                    owned_thread.as_deref().ok_or_else(stale)?,
                )?;
                value(crate::project_git::worktree_merge_branch_sync(
                    &root,
                    string(&args, "worktreePath")?,
                    string(&args, "branch")?,
                    &safety,
                    Some(&reference),
                )?)
            }
            "worktree.apply" => {
                if !flag(&args, "confirmed") {
                    return Err(stale());
                }
                let thread = owned_thread.as_deref().ok_or_else(stale)?;
                let reference = crate::project_git::worktree_applied_ref(thread)?;
                let baseline = crate::project_git::git_stdout(
                    &repo,
                    &["rev-parse", "--verify", &format!("{reference}^{{tree}}")],
                    None,
                )
                .unwrap_or(string(&args, "baseCommit")?.to_owned());
                let safety = format!("remote-safety-{}", uuid::Uuid::new_v4());
                capture_safety(&worker,&stamp_worker,&op_worker,&root_for_state,&root,&args,&mut bookkeeping,&safety,"Before remote worktree apply")?;
                value(crate::project_git::worktree_apply_to_source_sync(
                    &root,
                    string(&args, "worktreePath")?,
                    &baseline,
                    &safety,
                    Some(&reference),
                )?)
            }
            "worktree.remove" => {
                if !flag(&args, "confirmed") {
                    return Err(stale());
                }
                let managed = crate::release_qa::app_data_dir(&app)
                    .map_err(|_| stale())?
                    .join("worktrees");
                value(crate::project_git::remote_worktree_remove_sync(
                    &managed,
                    owned_thread.as_deref(),
                    &root,
                    string(&args, "worktreePath")?,
                    string(&args, "branch")?,
                    flag(&args, "force"),
                    flag(&args, "deleteBranch"),
                    optional(&args, "expectedRetainedBranchOid"),
                )?)
            }
            _ => Err(work::refused("unsupported")),
        }
        })()?;
        let result=json!({"opId":stamp_worker.op_id,"state":"accepted","workspaceId":stamp_worker.workspace_id,"threadId":stamp_worker.thread_id});let saved_result=result.clone();let payload_save=payload.clone();let stamp_save=stamp_worker.clone();
        let saved=worker.enqueue_write(false,move|db|{let tx=db.transaction().map_err(|_|uncertain())?;let rows=super::bookkeeping::finish(&tx,&stamp_save,&op_worker,&root_for_state,&args,&payload_save,bookkeeping.as_ref())?;commit::complete(&tx,&stamp_save,&op_worker,&saved_result,false)?;tx.commit().map_err(|_|uncertain())?;Ok(rows)});
        let rows=tauri::async_runtime::block_on(super::finish_write(saved))?;
        Ok::<_,String>(json!({"result":result,"payload":payload,"rows":rows,"replayed":false}))
    })
    .await
    .map_err(|_| uncertain())?;
    result.map_err(|_| uncertain())
}

fn capture_safety(
    inner: &Arc<Inner>,
    stamp: &Stamp,
    op: &str,
    root_for_state: &str,
    root: &str,
    args: &Value,
    book: &mut Option<super::bookkeeping::Bookkeeping>,
    id: &str,
    label: &str,
) -> Result<(), String> {
    let before = value(crate::project_git::capture_checkpoint_snapshot(
        id, root, "before", label,
    )?)?;
    let after = value(crate::project_git::capture_checkpoint_snapshot(
        id, root, "after", label,
    )?)?;
    let expected = book.clone().ok_or_else(stale)?;
    let (stamp, op, root, id, label, worker, args) = (
        stamp.clone(),
        op.to_owned(),
        root_for_state.to_owned(),
        id.to_owned(),
        label.to_owned(),
        inner.clone(),
        args.clone(),
    );
    let saved = inner.enqueue_write(false, move |db| {
        let tx = db.transaction().map_err(|_| uncertain())?;
        let core = worker.lock();
        stamp.check(&core, &op)?;
        let next = super::bookkeeping::save_safety(
            &tx, &stamp, &op, &root, &args, &expected, &id, &label, &before, &after,
        )?;
        tx.commit().map_err(|_| uncertain())?;
        drop(core);
        Ok(next)
    });
    *book = Some(tauri::async_runtime::block_on(super::finish_write(saved))?);
    Ok(())
}

pub(crate) fn limit_timeout(timeout: Duration) -> Duration {
    current().map_or(timeout, |fence| {
        timeout.min(fence.deadline.saturating_duration_since(Instant::now()))
    })
}
