//! Display-only host execution metadata. Roots come exclusively from host state.
use super::{
    commit::{self, Stamp},
    fs_guard::Anchor,
    github, hostbridge, RemoteState,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn header(
    db: &Connection,
    workspace: &str,
    thread: Option<&str>,
) -> Result<Value, String> {
    let projects = commit::state_row(db, "kiwi.projects")?["value"].clone();
    let project = projects
        .as_array()
        .and_then(|rows| rows.iter().find(|p| p["id"] == workspace))
        .ok_or_else(|| super::work::refused("stale_target"))?;
    let project_path = project["path"]
        .as_str()
        .ok_or_else(|| super::work::refused("stale_target"))?;
    let trees = commit::state_row(db, "kiwi.threadWorktrees")?["value"].clone();
    let tree = thread
        .and_then(|id| trees.get(id))
        .filter(|t| t["status"] != "removed");
    let root = tree
        .and_then(|t| t["path"].as_str())
        .unwrap_or(project_path);
    let stamp = Stamp {
        generation: 0,
        device: String::new(),
        grant_revision: 0,
        op_id: String::new(),
        op_seq: 0,
        workspace_id: Some(workspace.into()),
        thread_id: thread.map(str::to_owned),
    };
    // Validates a requested thread belongs to the project even when its retained
    // worktree is missing. Neither display path becomes a read capability.
    if thread.is_some() {
        let known = commit::state_row(db, "kiwi.knownThreads")?["value"].clone();
        let bindings = commit::state_row(db, "kiwi.threadProjects")?["value"].clone();
        let id = thread.unwrap();
        if known.get(id).is_none() {
            return Err(super::work::refused("stale_target"));
        }
        let bound = bindings[id]
            .as_str()
            .or_else(|| known[id]["cwd"].as_str())
            .ok_or_else(|| super::work::refused("stale_target"))?;
        if std::fs::canonicalize(bound)
            .ok()
            .filter(|p| Some(p) == std::fs::canonicalize(project_path).ok().as_ref())
            .is_none()
        {
            return Err(super::work::refused("forbidden"));
        }
    }
    let anchor = Anchor::open(Path::new(root)).ok();
    if anchor.is_some() {
        super::discovery_work::binding(db, &stamp, root)?;
    }
    let branch = anchor
        .as_ref()
        .and_then(|a| super::git_metadata::locations(&a.path).ok())
        .and_then(|loc| super::git_metadata::head(&loc).ok())
        .and_then(|(_, branch)| branch)
        .or_else(|| tree.and_then(|t| t["branch"].as_str()).map(str::to_owned));
    if let Some(anchor) = anchor {
        anchor.validate()?;
    }
    Ok(
        json!({"projectName":project["name"].as_str().unwrap_or("Project"),"projectPath":project_path,"executionPath":root,"branch":branch,"checkout":if tree.is_some(){"worktree"}else{"main"},"worktreeStatus":tree.and_then(|t|t["status"].as_str()),"exists":Path::new(root).is_dir()}),
    )
}
#[tauri::command]
pub(crate) async fn remote_host_execution_header(
    state: tauri::State<'_, RemoteState>,
    window: tauri::WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    workspace_id: String,
    thread_id: Option<String>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| super::work::refused("forbidden"))?;
    let stamp = Stamp {
        generation,
        device,
        grant_revision,
        workspace_id: Some(workspace_id.clone()),
        thread_id: thread_id.clone(),
        op_id: String::new(),
        op_seq: 0,
    };
    let inner = state.inner.clone();
    state
        .inner
        .read_db(move |db| {
            github::authorize_read(&inner.lock(), &stamp, "host.context")?;
            let result = header(db, &workspace_id, thread_id.as_deref())?;
            github::authorize_read(&inner.lock(), &stamp, "host.context")?;
            Ok(result)
        })
        .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_header_main_unborn_branch_and_host_worktree() {
        let f = super::super::threads::tests::fixture("git.write");
        let out = crate::process_launch::background_std_command("git")
            .current_dir(&f.path)
            .args(["init", "-q", "-b", "header-branch"])
            .output()
            .unwrap();
        assert!(out.status.success());
        commit::write_value(
            &f.db,
            "kiwi.projects",
            &json!([{"id":"p","name":"Host project","path":f.path}]),
        )
        .unwrap();
        let main = header(&f.db, "p", Some("t")).unwrap();
        assert_eq!(main["branch"], "header-branch");
        assert_eq!(main["checkout"], "main");
        assert_eq!(main["projectName"], "Host project");
        assert_eq!(
            std::fs::canonicalize(main["executionPath"].as_str().unwrap()).unwrap(),
            std::fs::canonicalize(&f.path).unwrap()
        );
        let missing = f.path.join("missing-tree");
        commit::write_value(&f.db,"kiwi.threadWorktrees",&json!({"t":{"projectId":"p","projectPath":f.path,"path":missing,"branch":"isolated","status":"missing"}})).unwrap();
        let tree = header(&f.db, "p", Some("t")).unwrap();
        assert_eq!(tree["checkout"], "worktree");
        assert_eq!(tree["branch"], "isolated");
        assert_eq!(tree["exists"], false);
        assert_eq!(tree["executionPath"], json!(missing));
        assert!(header(&f.db, "p", Some("unknown")).is_err());
    }
    #[test]
    fn header_read_accepts_view_only_but_refuses_a_different_project_grant() {
        let f = super::super::threads::tests::fixture("git.write");
        {
            let mut core = f.inner.lock();
            let grant = core
                .devices
                .get_mut("device")
                .unwrap()
                .grant
                .as_mut()
                .unwrap();
            grant.work = false;
            grant.capabilities.terminal = false;
            grant.capabilities.git_write = false;
        }
        assert!(github::authorize_read(&f.inner.lock(), &f.stamp, "host.context").is_ok());
        let mut outside = f.stamp.clone();
        outside.workspace_id = Some("outside".into());
        assert!(github::authorize_read(&f.inner.lock(), &outside, "host.context").is_err());
    }
}
