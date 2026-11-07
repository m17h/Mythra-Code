//! Typed GitHub operations; no arbitrary CLI/URL, token or authentication proxy.
use super::{
    commit::{self, Stamp},
    domain,
    fs_guard::Anchor,
    hostbridge, store, work, RemoteState,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tauri::{AppHandle, State, WebviewWindow};
#[derive(Clone)]
pub(crate) struct Context {
    fence: Arc<domain::Fence>,
    read: bool,
}
tokio::task_local! {static CONTEXT:Context;}
pub(crate) fn context() -> Option<Context> {
    CONTEXT.try_with(Clone::clone).ok()
}
pub(crate) fn blocking<T>(
    context: Context,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _safe = context.read.then(super::safe_git::enter);
    domain::with_context(context.fence, operation)
}
fn stale() -> String {
    work::refused("stale_target")
}
fn uncertain() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: GitHub may have received this change. Refresh the pull request before trying again.".into()
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 65536 && !s.contains('\0'))
        .ok_or_else(stale)
}
fn string(args: &Value, key: &str) -> Result<String, String> {
    text(args, key).map(str::to_owned)
}
fn optional(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn flag(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool) == Some(true)
}
fn number(args: &Value) -> Result<u64, String> {
    args.get("number")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= super::timeline::MAX_SAFE_SEQ)
        .ok_or_else(stale)
}
fn value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| stale())
}
fn validate(action: &str, args: &Value) -> Result<(), String> {
    let fields: &[&str] = match action {
        "github.pr.create" => &[
            "repository",
            "head",
            "base",
            "title",
            "body",
            "draft",
            "commitMessage",
            "commitAll",
            "expectedHeadOid",
        ],
        "github.pr.merge" => &["repository", "number", "method", "expectedHeadOid", "auto"],
        "github.pr.ready" => &["repository", "number", "expectedHeadOid"],
        "github.pr.comment" => &["repository", "number", "expectedHeadOid", "body"],
        "github.comments.list" | "github.ci.status" | "github.pr.view" => &["repository", "number"],
        "github.pr.list" => &["repository", "search", "state", "limit"],
        "github.pr.find" => &["repository", "branch"],
        "github.pr.context" => &["repository"],
        _ => return Err(work::refused("unsupported")),
    };
    if !args
        .as_object()
        .is_some_and(|o| o.keys().all(|k| fields.contains(&k.as_str())))
        || serde_json::to_vec(args).map_or(true, |b| b.len() > 96 * 1024)
    {
        return Err(stale());
    }
    let repo = text(args, "repository")?;
    let mut parts = repo.split('/');
    for _ in 0..2 {
        let s = parts.next().ok_or_else(stale)?;
        if s.is_empty()
            || s.len() > 100
            || matches!(s, "." | "..")
            || s.starts_with('-')
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return Err(stale());
        }
    }
    if parts.next().is_some() {
        return Err(stale());
    }
    Ok(())
}
async fn setup(
    inner: Arc<super::Inner>,
    stamp: &Stamp,
    root: String,
    action: &str,
    args: &Value,
    read: bool,
) -> Result<(String, Context), String> {
    validate(action, args)?;
    {
        let core = inner.lock();
        if read {
            authorize_read(&core, stamp, action)?;
        } else {
            stamp.check(&core, action)?;
        }
    }
    let expected = string(args, "repository")?;
    let anchor = super::studio::blocking(move || {
        let anchor = Anchor::open(Path::new(&root))?;
        let read = crate::project_git::GitReadOperation::new();
        super::studio::git_root(&read, &anchor)?;
        let output = read.output(&anchor.path, &["config", "--get", "remote.origin.url"])?;
        if !output.status.success() {
            return Err(stale());
        }
        let origin = std::str::from_utf8(&output.stdout)
            .map_err(|_| stale())?
            .trim();
        if !crate::github::parse_github_repository(origin)
            .is_some_and(|actual| actual.eq_ignore_ascii_case(&expected))
        {
            return Err(stale());
        }
        anchor.validate()?;
        Ok(anchor)
    })
    .await?;
    let root = anchor.path.to_string_lossy().into_owned();
    let fence = domain::make_context(inner, stamp.clone(), action.to_owned(), anchor, read);
    Ok((root, Context { fence, read }))
}
#[tauri::command]
pub(crate) async fn remote_github_read(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    workspace_id: String,
    root: String,
    action: String,
    args: Value,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if !matches!(
        action.as_str(),
        "github.comments.list"
            | "github.ci.status"
            | "github.pr.view"
            | "github.pr.list"
            | "github.pr.find"
            | "github.pr.context"
    ) {
        return Err(stale());
    }
    let stamp = Stamp {
        generation,
        device,
        grant_revision,
        workspace_id: Some(workspace_id),
        thread_id: None,
        op_id: String::new(),
        op_seq: 0,
    };
    let (root, context) = setup(state.inner.clone(), &stamp, root, &action, &args, true).await?;
    CONTEXT
        .scope(context, execute(app, root, &action, &args))
        .await
}
#[tauri::command]
pub(crate) async fn remote_github_execute(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    root: String,
    action: String,
    args: Value,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if !matches!(
        action.as_str(),
        "github.pr.create" | "github.pr.merge" | "github.pr.ready" | "github.pr.comment"
    ) {
        return Err(stale());
    }
    let (root, context) = setup(state.inner.clone(), &stamp, root, &action, &args, false).await?;
    let worker = state.inner.clone();
    let copy = stamp.clone();
    let op = action.clone();
    let prior=super::finish_write(state.inner.enqueue_write(false,move|db|{
        if commit::operation(db,&copy)?!=op{return Err(stale());}
        if let Some(result)=commit::prior(db,&copy)?{return Ok(Some(result));}
        let core=worker.lock();copy.check(&core,&op)?;
        if store::delivery_receipt(db,&copy.device,&copy.op_id,copy.op_seq)?.is_some_and(|r|r.get("githubStarted")==Some(&json!(true))){return Err(uncertain());}
        store::save_delivery_receipt(db,&copy.device,&copy.op_id,copy.op_seq,&json!({"disposition":"dispatched","githubStarted":true,"workspaceId":copy.workspace_id,"threadId":copy.thread_id}))?;Ok(None)
    })).await?;
    if let Some(result) = prior {
        return Ok(json!({"payload":result["payload"],"result":result,"replayed":true}));
    }
    let payload = CONTEXT
        .scope(context, execute(app, root, &action, &args))
        .await
        .map_err(|_| uncertain())?;
    let worker = state.inner.clone();
    super::finish_write(state.inner.enqueue_write(false,move|db|{
        let tx=db.transaction().map_err(|_|uncertain())?;let core=worker.lock();stamp.check(&core,&action)?;
        let result=json!({"opId":stamp.op_id,"state":"accepted","workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"payload":durable_payload(&payload)});commit::complete(&tx,&stamp,&action,&result,false)?;tx.commit().map_err(|_|uncertain())?;Ok(json!({"payload":payload,"result":result,"replayed":false}))
    })).await
}
async fn execute(
    app: AppHandle,
    root: String,
    action: &str,
    args: &Value,
) -> Result<Value, String> {
    let repo = string(args, "repository")?;
    match action {
        "github.pr.create" => value(
            crate::github_pr::github_pr_create(
                app,
                root,
                repo,
                string(args, "head")?,
                string(args, "base")?,
                string(args, "title")?,
                args.get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                flag(args, "draft"),
                optional(args, "commitMessage"),
                flag(args, "commitAll"),
                string(args, "expectedHeadOid")?,
            )
            .await?,
        ),
        "github.pr.merge" => value(
            crate::github_pr::github_pr_merge(
                app,
                root,
                repo,
                number(args)?,
                string(args, "method")?,
                string(args, "expectedHeadOid")?,
                flag(args, "auto"),
            )
            .await?,
        ),
        "github.pr.ready" => value(
            crate::github_pr::github_pr_ready(
                app,
                root,
                repo,
                number(args)?,
                string(args, "expectedHeadOid")?,
            )
            .await?,
        ),
        "github.pr.comment" => {
            crate::github_pr::remote_comment(
                app,
                root,
                repo,
                number(args)?,
                string(args, "expectedHeadOid")?,
                string(args, "body")?,
            )
            .await
        }
        "github.comments.list" => crate::github_pr::remote_comments(app, repo, number(args)?).await,
        "github.ci.status" => {
            let pr =
                value(crate::github_pr::github_pr_view(app, root, repo, number(args)?).await?)?;
            Ok(
                json!({"checks":pr["checks"],"headOid":pr["headOid"],"mergeStateStatus":pr["mergeStateStatus"]}),
            )
        }
        "github.pr.view" => {
            value(crate::github_pr::github_pr_view(app, root, repo, number(args)?).await?)
        }
        "github.pr.list" => value(
            crate::github_pr::github_pr_list(
                app,
                root,
                repo,
                optional(args, "search"),
                optional(args, "state"),
                args.get("limit")
                    .and_then(Value::as_u64)
                    .map(|n| n.min(50) as usize),
            )
            .await?,
        ),
        "github.pr.find" => {
            value(crate::github_pr::github_pr_find(app, root, repo, string(args, "branch")?).await?)
        }
        // Local context may fetch a missing base. Remote read policy refuses that
        // write instead of silently changing the host from a read surface.
        "github.pr.context" => value(crate::github_pr::github_pr_context(app, root).await?),
        _ => Err(work::refused("unsupported")),
    }
}

// Journal identities/outcomes only, never PR/comment bodies, credentials or
// arbitrary GitHub text. Replayed replies prompt a fresh read for full details.
fn durable_payload(payload: &Value) -> Value {
    let mut kept = serde_json::Map::new();
    for key in [
        "repository",
        "number",
        "id",
        "url",
        "state",
        "headOid",
        "creationOutcome",
        "createdAt",
    ] {
        if let Some(value) = payload.get(key) {
            if serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= 1024) {
                kept.insert(key.into(), value.clone());
            }
        }
    }
    Value::Object(kept)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_github_has_no_command_url_auth_or_path_proxy() {
        assert!(validate("github.pr.comment",&json!({"repository":"owner/repo","number":1,"expectedHeadOid":"a".repeat(40),"body":"comment"})).is_ok());
        for args in [
            json!({"repository":"--evil/repo"}),
            json!({"repository":"owner/repo","command":"evil"}),
            json!({"repository":"owner/repo","cwd":"/outside"}),
            json!({"repository":"owner/repo","token":"secret"}),
            json!({"repository":"owner/repo","endpoint":"/user"}),
        ] {
            assert!(validate("github.pr.comment", &args).is_err());
        }
        assert!(validate("github.raw", &json!({"repository":"owner/repo"})).is_err());
        let saved = durable_payload(
            &json!({"body":"secret text","title":"private title","number":3,"repository":"owner/repo","url":"https://github.com/owner/repo/pull/3"}),
        );
        assert_eq!(saved["number"], 3);
        assert!(saved.get("body").is_none());
        assert!(saved.get("title").is_none());
    }
    #[test]
    fn github_writes_need_work_git_write_and_terminal_but_reads_need_only_view() {
        let mut grant = store::DeviceGrant::initial();
        grant.work = true;
        for op in [
            "github.pr.create",
            "github.pr.merge",
            "github.pr.ready",
            "github.pr.comment",
        ] {
            grant.capabilities.git_write = false;
            grant.capabilities.terminal = true;
            assert!(super::super::manifest::access(op, &grant).is_err());
            grant.capabilities.git_write = true;
            grant.capabilities.terminal = false;
            assert!(super::super::manifest::access(op, &grant).is_err());
            grant.capabilities.terminal = true;
            assert!(super::super::manifest::access(op, &grant).is_ok());
        }
        grant.work = false;
        grant.capabilities.git_write = false;
        grant.capabilities.terminal = false;
        for op in [
            "github.comments.list",
            "github.ci.status",
            "github.pr.view",
            "github.pr.context",
        ] {
            assert!(super::super::manifest::access(op, &grant).is_ok());
        }
    }
}

pub(super) fn authorize_read(
    core: &super::Core,
    stamp: &Stamp,
    action: &str,
) -> Result<(), String> {
    hostbridge::check_generation(core, stamp.generation).map_err(|_| stale())?;
    let grant = work::grant_locked(core, &stamp.device)
        .filter(|g| g.view && g.revision == stamp.grant_revision)
        .ok_or_else(|| work::refused("forbidden"))?;
    if let store::GrantScope::Projects { project_ids } = &grant.scope {
        if !stamp
            .workspace_id
            .as_ref()
            .is_some_and(|id| project_ids.contains(id))
        {
            return Err(work::refused("forbidden"));
        }
    }
    super::manifest::access(action, &grant).map_err(|_| work::refused("forbidden"))
}
