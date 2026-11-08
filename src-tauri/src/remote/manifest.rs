//! Exact parity operation manifest. Never a generic invoke/native proxy.
use super::{
    store::{DeviceGrant, GrantScope},
    wire::WireError,
};
use serde_json::Value;
fn invalid() -> WireError {
    WireError::new("invalid", "That action isn't valid.")
}
pub(super) const READS: &[&str] = &[
    "activity.read","review.diff","git.autoPublish.read","usage.prices.refresh","tools.mcp.list","agents.presets.read","git.context","agents.read","mail.read","workflows.view","actions.list","usage.thread.read","usage.thread.details","thread.handoff.lineage","git.suggestion.read","terminal.list","terminal.read","terminal.status",
    "queue.read",
    "schedules.read",
    "workflows.list",
    "workflows.read",
    "projects.settings.read",
    "projects.instructions.read",
    "models.list",
    "models.refresh",
    "models.search",
    "skills.list",
    "skills.read",
    "skills.analyze",
    "usage.account.read",
    "usage.account.refresh",
    "threads.search",
    "threads.archived",
    "parent.read",
    "thread.handoff.read",
    "checks.read",
    "checks.status",
    "run.status",
    "discovery.run.status",
    "discovery.check.status",
];
pub(super) fn mutation(op: &str) -> bool {
    matches!(
        op,
        "steer.deliver" | "attachment.reference" | "projects.clone" | "github.pr.create" | "github.pr.merge" | "github.pr.ready" | "github.pr.comment" | "draft.settings.set" | "prompt.cancel" | "git.write" | "checkpoint.create" | "checkpoint.complete" | "checkpoint.delete" | "checkpoint.restore" | "checkpoint.accept" | "agents.stop" | "worktree.create" | "worktree.recreate" | "worktree.baseline" | "worktree.merge" | "worktree.apply" | "worktree.remove" | "worktree.continueShared" | "worktree.returnShared" | "terminal.open" | "terminal.write" | "terminal.resize" | "terminal.close" | "attachment.put"
            | "queue.edit.begin"
            | "queue.edit.finish"
            | "queue.retry"
            | "queue.steer"
            | "queue.remove"
            | "prompt.schedule"
            | "prompt.scheduleNew"
            | "schedules.edit"
            | "schedules.reschedule"
            | "schedules.release"
            | "schedules.remove"
            | "thread.compact"
            | "thread.rollback"
            | "thread.handoff.prepare"
            | "thread.handoff.send"
            | "parent.continue"
            | "parent.dismiss"
            | "thread.archiveMany"
            | "thread.deleteMany"
            | "workflows.start"
            | "workflows.stop"
            | "projects.settings.set"
            | "projects.instructions.set"
            | "projects.profiles.save"
            | "projects.profiles.delete"
            | "projects.profiles.select"
            | "projects.run.set"
            | "projects.check.set"
            | "actions.run" | "review.start" | "git.suggestCommit" | "agents.accept" | "agents.replace"
            | "run.start"
            | "run.stop"
            | "checks.start"
            | "checks.stop"
            | "discovery.run.start"
            | "discovery.run.stop"
            | "discovery.check.start"
            | "discovery.check.stop"
            | "discovery.settings.set"
            | "thread.settings.set"
            | "thread.pullRequest.set"
            | "thread.rename"
            | "thread.archive"
            | "thread.restore"
            | "thread.fork"
            | "thread.delete"
            | "thread.pin"
            | "projects.pin"
            | "projects.remove"
            | "projects.reorder"
            | "projects.add"
    )
}
pub(super) fn fields(op: &str) -> Option<(&'static [&'static str], bool)> {
    Some(match op {
        "steer.list" => (&["workspaceId","threadId"],false),
        "steer.deliver" => (&["workspaceId","threadId","opId","opSeq","turnId","runtimeId"],true),
        "terminal.attach" => (&["workspaceId","terminalId","limit"],false),
        "git.context" => (&["workspaceId","threadId","limit"],false),
        "agents.read"|"mail.read" => (&["workspaceId","threadId","agentId","limit"],false),
        "workflows.view" => (&["workspaceId","threadId","workflowId","limit"],false),
        "usage.prices.refresh"|"tools.mcp.list"|"agents.presets.read"|"actions.list"|"usage.thread.read"|"usage.thread.details"|"thread.handoff.lineage"|"git.suggestion.read" => (&["workspaceId","threadId","limit"],false),
        "terminal.list" => (&["workspaceId","threadId","limit"],false),
        "terminal.read"|"terminal.status" => (&["workspaceId","threadId","terminalId","cursor","limit"],false),
        "actions.run" => (&["workspaceId","threadId","opId","opSeq","revision","actionId"],true),
        "review.start"|"git.suggestCommit" => (&["workspaceId","threadId","opId","opSeq","revision"],true),
        "agents.accept" => (&["workspaceId","threadId","opId","opSeq","revision","agentId","target"],true),
        "agents.replace" => (&["workspaceId","threadId","opId","opSeq","revision","agentId","targetId","target"],true),
        "thread.pullRequest.set" => (&["opId","opSeq","workspaceId","threadId","revision","reference"],true),
        "draft.settings.set" => (&["opId","opSeq","workspaceId","draftHandle","handoffHandle","provider","model","effort","permission","serviceTier","subagents","isolated"],true),
        "prompt.cancel" => (&["opId","opSeq","workspaceId","startTarget"],true),
        "github.pr.create" => (&["opId","opSeq","workspaceId","threadId","head","base","title","body","draft","commitMessage","commitAll","revision"],true),
        "github.pr.merge" => (&["opId","opSeq","workspaceId","threadId","number","method","auto","revision","confirmed"],true),
        "github.pr.ready" => (&["opId","opSeq","workspaceId","threadId","number","revision","confirmed"],true),
        "github.pr.comment" => (&["opId","opSeq","workspaceId","threadId","number","body","revision"],true),
        "github.comments.list"|"github.ci.status"|"github.pr.view" => (&["workspaceId","threadId","number"],false),
        "github.pr.list" => (&["workspaceId","search","state","limit"],false),
        "github.pr.find" => (&["workspaceId","threadId","branch"],false),
        "github.pr.context" => (&["workspaceId","threadId"],false),
        "git.write" => (&["opId","opSeq","workspaceId","threadId","action","resourceId","revision","message","name","create","stagedOnly","confirmed","base","url","visibility"],true),
        "checkpoint.list" | "worktree.status" | "agents.list" | "preview.links" => (&["workspaceId","threadId"],false),
        "checkpoint.diff" => (&["workspaceId","threadId","checkpointId"],false),
        "git.log" => (&["workspaceId","threadId","offset","limit","headOid"],false),
        "git.revert.preview" => (&["workspaceId","threadId","changeId"],false),
        "attachment.image" => (&["workspaceId","threadId","messageId","index","offset"],false),
        "checkpoint.accept" => (&["opId","opSeq","workspaceId","threadId","checkpointId","revision"],true),
        "agents.stop" => (&["opId","opSeq","workspaceId","threadId","agentId","target","revision"],true),
        "checkpoint.create"|"checkpoint.complete" => (&["opId","opSeq","workspaceId","threadId","checkpointId","label","revision"],true),
        "checkpoint.delete" => (&["opId","opSeq","workspaceId","threadId","checkpointId","revision","confirmed"],true),
        "checkpoint.restore" => (&["opId","opSeq","workspaceId","threadId","checkpointId","target","revision","confirmed"],true),
        "worktree.create" | "worktree.recreate" => (&["opId","opSeq","workspaceId","threadId","label","revision"],true),
        "worktree.remove"|"worktree.returnShared" => (&["opId","opSeq","workspaceId","threadId","revision","confirmed","force"],true),
        "worktree.apply"|"worktree.merge"|"worktree.baseline"|"worktree.continueShared" => (&["opId","opSeq","workspaceId","threadId","revision","confirmed"],true),
        "terminal.open" => (&["opId","opSeq","workspaceId","threadId","command","columns","rows"],true),
        "terminal.write" => (&["opId","opSeq","workspaceId","terminalId","data"],true),
        "terminal.resize" => (&["opId","opSeq","workspaceId","terminalId","columns","rows"],true),
        "terminal.close" => (&["opId","opSeq","workspaceId","terminalId"],true),
        "terminal.ack" => (&["workspaceId","terminalId","through"],false),
        "attachment.put" => (&["opId","opSeq","workspaceId","phase","name","kind","size","uploadId","offset","data","sha256"],true),
        "attachment.reference" => (&["opId","opSeq","workspaceId","threadId","revision","fileId"],true),
        "activity.read" => (&["workspaceId","threadId","activityId"],false),
        "review.diff" => (&["workspaceId","threadId"],false),
        "git.autoPublish.read" => (&["workspaceId","threadId"],false),
        "projects.clone" => (&["opId","opSeq","folderId","url"],true),
        "projects.clone.status" => (&["processHandle"],false),
        "queue.edit.begin" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "queueId",
            ],
            true,
        ),
        "queue.edit.finish" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "queueId",
                "editHandle",
                "text",
                "cancel",
            ],
            true,
        ),
        "queue.retry" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "queueId",
            ],
            true,
        ),
        "queue.steer" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "queueId",
                "target",
            ],
            true,
        ),
        "queue.remove" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "queueId",
            ],
            true,
        ),
        "prompt.schedule" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "text",
                "deliverAt",
            ],
            true,
        ),
        "prompt.scheduleNew" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "draftHandle",
                "text",
                "deliverAt",
            ],
            true,
        ),
        "schedules.edit" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "scheduleId",
                "text",
            ],
            true,
        ),
        "schedules.reschedule" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "scheduleId",
                "deliverAt",
            ],
            true,
        ),
        "schedules.release" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "scheduleId",
            ],
            true,
        ),
        "schedules.remove" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "scheduleId",
            ],
            true,
        ),
        "thread.compact" => (
            &["workspaceId", "threadId", "opId", "opSeq", "revision"],
            true,
        ),
        "thread.rollback" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "messageId",
                "confirmed",
            ],
            true,
        ),
        "thread.handoff.prepare" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "provider",
            ],
            true,
        ),
        "thread.handoff.send" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "handoffId",
                "text",
            ],
            true,
        ),
        "parent.continue" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "parentRunId",
            ],
            true,
        ),
        "parent.dismiss" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "parentRunId",
            ],
            true,
        ),
        "thread.archiveMany" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "threadIds",
            ],
            true,
        ),
        "thread.deleteMany" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "threadIds",
                "confirmed",
            ],
            true,
        ),
        "workflows.start" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "workflowId",
                "variables",
                "userPrompt",
                "digest",
            ],
            true,
        ),
        "workflows.stop" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "workflowId",
                "runId",
            ],
            true,
        ),
        "projects.settings.set" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "name",
                "provider",
                "model",
                "effort",
            ],
            true,
        ),
        "projects.instructions.set" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "prompt",
                "mode",
            ],
            true,
        ),
        "projects.profiles.save" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "profileId",
                "name",
                "prompt",
                "mode",
            ],
            true,
        ),
        "projects.profiles.delete" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "profileId",
            ],
            true,
        ),
        "projects.profiles.select" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "profileId",
            ],
            true,
        ),
        "projects.run.set" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "command",
                "setupCommand",
                "label",
            ],
            true,
        ),
        "projects.check.set" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "command",
            ],
            true,
        ),
        "run.start" => (
            &["workspaceId", "threadId", "opId", "opSeq", "revision"],
            true,
        ),
        "run.stop" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "processHandle",
            ],
            true,
        ),
        "checks.start" => (
            &["workspaceId", "threadId", "opId", "opSeq", "revision"],
            true,
        ),
        "checks.stop" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "processHandle",
            ],
            true,
        ),
        "discovery.run.start" => (
            &["workspaceId", "threadId", "opId", "opSeq", "revision"],
            true,
        ),
        "discovery.run.stop" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "runId",
            ],
            true,
        ),
        "discovery.check.start" => (
            &["workspaceId", "threadId", "opId", "opSeq", "revision"],
            true,
        ),
        "discovery.check.stop" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "runId",
            ],
            true,
        ),
        "discovery.settings.set" => (
            &[
                "workspaceId",
                "threadId",
                "opId",
                "opSeq",
                "revision",
                "provider",
                "model",
                "effort",
            ],
            true,
        ),
        "thread.settings.set" => (
            &["opId", "opSeq", "threadId", "model", "effort", "provider", "permission", "serviceTier", "subagents"],
            true,
        ),
        "thread.rename" => (&["opId", "opSeq", "threadId", "name"], true),
        "thread.archive" => (&["opId", "opSeq", "threadId"], true),
        "thread.restore" => (&["opId", "opSeq", "threadId"], true),
        "thread.fork" => (&["opId", "opSeq", "threadId", "checkpointId"], true),
        "thread.delete" => (&["opId", "opSeq", "threadId", "confirmed"], true),
        "thread.pin" => (&["opId", "opSeq", "threadId", "pinned"], true),
        "projects.pin" => (&["opId", "opSeq", "workspaceId", "pinned"], true),
        "projects.remove" => (&["opId", "opSeq", "workspaceId", "confirmed"], true),
        "projects.reorder" => (
            &["opId", "opSeq", "workspaceId", "relativeTo", "position"],
            true,
        ),
        "projects.add" => (&["opId", "opSeq", "folderId"], true),
        "host.context" => (&["workspaceId", "threadId"], false),
        "files.search" => (&["workspaceId", "threadId", "query"], false),
        "files.list" => (
            &["workspaceId", "threadId", "parentId", "cursor", "limit"],
            false,
        ),
        "files.preview" => (&["workspaceId", "threadId", "fileId"], false),
        "git.status" => (&["workspaceId", "threadId", "limit"], false),
        "git.diff" => (&["workspaceId", "threadId", "changeId"], false),
        "folders.browse" => (&["folderId", "cursor", "limit"], false),
        name if READS.contains(&name) => (
            &[
                "workspaceId",
                "threadId",
                "query",
                "cursor",
                "limit",
                "workflowId",
                "skillId",
                "processHandle",
            ],
            false,
        ),
        _ => return None,
    })
}
pub(super) fn access(op: &str, grant: &DeviceGrant) -> Result<(), WireError> {
    // Refuse even an old journal's native dispatch; these are host-only, not
    // merely absent from the renderer's menu or its accepted field table.
    if matches!(op, "git.autoPublish.set" | "git.autoPublish.retry") {
        return Err(WireError::new("unsupported", "Automatic publishing can only be changed on the host."));
    }
    let manage = matches!(
        op,
        "projects.add"
            | "projects.clone"
            | "projects.clone.status"
            | "projects.remove"
            | "folders.browse"
            | "projects.settings.set"
            | "projects.instructions.set"
            | "projects.profiles.save"
            | "projects.profiles.delete"
            | "projects.profiles.select"
            | "projects.run.set"
            | "projects.check.set"
    );
    let git_change=op=="git.write"||op=="git.revert.preview"||matches!(op,"github.pr.create"|"github.pr.merge"|"github.pr.ready"|"github.pr.comment");
    let domain=git_change||(op.starts_with("checkpoint.")&&!matches!(op,"checkpoint.list"|"checkpoint.diff"|"checkpoint.accept"))||(op.starts_with("worktree.")&&op!="worktree.status");
    let shell = domain || op=="projects.clone" || op=="engine.command" || op.starts_with("terminal.") || matches!(
        op,
        "actions.run" | "projects.run.set"
            | "projects.check.set"
            | "run.start"
            | "run.stop"
            | "checks.start"
            | "checks.stop"
            | "discovery.run.start"
            | "discovery.run.stop"
            | "discovery.check.start"
            | "discovery.check.stop"
            | "discovery.settings.set"
    );
    if (git_change&&!grant.capabilities.git_write)||(op=="checkpoint.restore"&&!grant.capabilities.checkpoint_restore){return Err(WireError::new("forbidden","This device doesn't have that access. To change it, open Settings → Connections → Devices on the other device."));}
    if !grant.view
        || (mutation(op)
            || manage
            || shell && !matches!(op,"terminal.list"|"terminal.read"|"terminal.status"|"terminal.attach")
            || op == "steer.deliver"
            || op == "work.inspect"
            || op == "preview.links"
            || super::work::MUTATIONS.contains(&op))
            && !grant.work
        || manage
            && (!matches!(grant.scope, GrantScope::All) || !grant.capabilities.manage_projects)
        || shell && !grant.capabilities.terminal
    {
        return Err(WireError::new(
            "forbidden",
            "This device doesn't have that access. To change it, open Settings → Connections → Devices on the other device.",
        ));
    }
    Ok(())
}
fn id(args: &Value, key: &str, required: bool) -> Result<(), WireError> {
    match args.get(key) {
        None if !required => Ok(()),
        Some(Value::String(value))
            if !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control) =>
        {
            Ok(())
        }
        _ => Err(invalid()),
    }
}
pub(super) fn validate(op: &str, args: &Value) -> Result<bool, WireError> {
    let Some((fields, mutation)) = fields(op) else {
        return Ok(false);
    };
    let object = args.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| !fields.contains(&key.as_str()))
        || serde_json::to_vec(args).map_or(true, |bytes| bytes.len() > 1024 * 1024)
    {
        return Err(invalid());
    }
    if mutation {
        id(args, "opId", true)?;
        if !args
            .get("opSeq")
            .and_then(Value::as_u64)
            .is_some_and(|seq| seq > 0 && seq <= super::timeline::MAX_SAFE_SEQ)
        {
            return Err(invalid());
        }
    }
    if !matches!(op, "folders.browse" | "projects.add" | "projects.clone" | "projects.clone.status") {
        let workspace = fields.contains(&"workspaceId");
        id(args, "workspaceId", workspace)?;
        id(args, "threadId", !workspace)?;
    }
    for key in [
        "queueId",
        "editHandle",
        "scheduleId",
        "workflowId",
        "runId",
        "parentRunId",
        "messageId",
        "handoffId",
        "processHandle",
        "profileId",
        "target",
        "skillId",
        "folderId",
        "parentId",
        "fileId",
        "changeId",
        "relativeTo", "agentId", "targetId", "draftHandle", "handoffHandle", "actionId",
    ] {
        id(args, key, false)?;
    }
    if matches!(op,"terminal.read"|"terminal.status") {
        if args.get("cursor").is_some_and(|v|!v.as_u64().is_some_and(|n|n<=super::timeline::MAX_SAFE_SEQ)) { return Err(invalid()); }
    } else { id(args,"cursor",false)?; }
    if op.starts_with("steer.") { id(args,"threadId",true)?; }
    if op=="steer.deliver" { id(args,"turnId",true)?; id(args,"runtimeId",true)?; }
    if matches!(op,"agents.accept"|"agents.stop"|"agents.replace"){id(args,"agentId",true)?;id(args,"target",true)?;}
    if op=="agents.replace"{id(args,"targetId",true)?;}
    if op=="actions.run"{id(args,"actionId",true)?;}
    if fields.contains(&"revision") {
        id(args, "revision", true)?;
    }
    for key in ["text", "prompt", "userPrompt"] {
        if args
            .get(key)
            .is_some_and(|value| !value.as_str().is_some_and(|value| value.len() <= 65536))
        {
            return Err(invalid());
        }
    }
    for key in ["command", "setupCommand"] {
        if args
            .get(key)
            .is_some_and(|value| !value.as_str().is_some_and(|value| value.len() <= 4000))
        {
            return Err(invalid());
        }
    }
    if args.get("url").is_some_and(|value| !value.as_str().is_some_and(|value| value.len() <= 2048)) {
        return Err(invalid());
    }
    if args.get("enabled").is_some_and(|value| !value.is_boolean()) {
        return Err(invalid());
    }
    for key in ["name", "label", "query", "model"] {
        if args
            .get(key)
            .is_some_and(|value| !value.as_str().is_some_and(|value| value.len() <= 512))
        {
            return Err(invalid());
        }
    }
    if args.get("provider").is_some_and(|value| {
        !matches!(
            value.as_str(),
            Some("openai" | "claude" | "cursor" | "openrouter" | "lmstudio")
        )
    }) || args.get("effort").is_some_and(|value| {
        !matches!(
            value.as_str(),
            Some("low" | "medium" | "high" | "xhigh" | "max")
        )
    }) || args
        .get("mode")
        .is_some_and(|value| !matches!(value.as_str(), Some("append" | "replace")))
    {
        return Err(invalid());
    }
    if args.get("limit").is_some_and(|value| {
        !value
            .as_u64()
            .is_some_and(|limit| (1..=if matches!(op,"terminal.read"|"terminal.status"|"terminal.attach") {65536} else {200}).contains(&limit))
    }) {
        return Err(invalid());
    }
    if args.get("pinned").is_some_and(|value| !value.is_boolean()) {
        return Err(invalid());
    }
    if matches!(
        op,
        "thread.delete" | "projects.remove" | "thread.rollback" | "thread.deleteMany"
    ) && args.get("confirmed") != Some(&Value::Bool(true))
    {
        return Err(invalid());
    }
    if let Some(values) = args.get("threadIds") {
        let ids = values.as_array().ok_or_else(invalid)?;
        let mut seen = std::collections::HashSet::new();
        if ids.is_empty()
            || ids.len() > 100
            || ids.iter().any(|value| {
                !value.as_str().is_some_and(|value| {
                    !value.is_empty() && value.len() <= 512 && seen.insert(value)
                })
            })
        {
            return Err(invalid());
        }
    }
    if let Some(variables) = args.get("variables") {
        let vars = variables.as_object().ok_or_else(invalid)?;
        if vars.len() > 64
            || vars.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 256
                    || !value.as_str().is_some_and(|value| value.len() <= 8192)
            })
        {
            return Err(invalid());
        }
    }
    if let Some(time) = args.get("deliverAt") {
        let now = crate::unix_timestamp_ms().max(0) as u64;
        if !time
            .as_u64()
            .is_some_and(|time| time > now && time <= now + 366 * 86400000)
        {
            return Err(invalid());
        }
    }
    if op == "projects.reorder" {
        id(args, "relativeTo", true)?;
        if !matches!(
            args.get("position").and_then(Value::as_str),
            Some("before" | "after")
        ) {
            return Err(invalid());
        }
    }
    if matches!(op, "files.preview" | "git.diff" | "projects.add") {
        id(
            args,
            match op {
                "files.preview" => "fileId",
                "git.diff" => "changeId",
                _ => "folderId",
            },
            true,
        )?;
    }
    if op.starts_with("github.") {
        if matches!(op,"github.pr.merge"|"github.pr.ready"|"github.pr.comment"|"github.comments.list"|"github.ci.status"|"github.pr.view")&&!args.get("number").and_then(Value::as_u64).is_some_and(|n|n>0&&n<=super::timeline::MAX_SAFE_SEQ){return Err(invalid());}
        for key in ["head","base","title","body","commitMessage","search","branch"] {if let Some(value)=args.get(key){if !value.as_str().is_some_and(|s|s.len()<=65536&&!s.contains('\0')){return Err(invalid());}}}
        for key in ["draft","commitAll","auto","confirmed"]{if args.get(key).is_some_and(|v|!v.is_boolean()){return Err(invalid());}}
        if op=="github.pr.merge"&&!matches!(args.get("method").and_then(Value::as_str),Some("squash"|"merge"|"rebase")){return Err(invalid());}
        if matches!(op,"github.pr.merge"|"github.pr.ready")&&args.get("confirmed")!=Some(&Value::Bool(true)){return Err(invalid());}
        if matches!(op,"github.pr.create"|"github.pr.comment")&&!args.get(if op=="github.pr.create"{"title"}else{"body"}).and_then(Value::as_str).is_some_and(|s|!s.trim().is_empty()){return Err(invalid());}
        if args.get("limit").is_some_and(|v|!v.as_u64().is_some_and(|n|n>0&&n<=50)){return Err(invalid());}
        if args.get("state").is_some_and(|v|!matches!(v.as_str(),Some("open"|"closed"|"merged"|"all"))){return Err(invalid());}
    }
    if op=="attachment.put"{super::attachments::validate(args).map_err(|_|invalid())?;}
    if matches!(op,"draft.settings.set"|"thread.settings.set"){
        if args.get("permission").is_some_and(|p|!matches!(p.as_str(),Some("read-only"|"ask"|"full")))||args.get("serviceTier").is_some_and(|tier|!tier.is_null()&&!matches!(tier.as_str(),Some("standard"|"fast"))){return Err(invalid());}
        if let Some(sub)=args.get("subagents"){let object=sub.as_object().ok_or_else(invalid)?;if object.keys().any(|key|!["enabled","engine","maxConcurrent","autoCompactTokens","nativeOptions","crew"].contains(&key.as_str()))||!sub.get("enabled").is_some_and(Value::is_boolean)||!matches!(sub.get("engine").and_then(Value::as_str),Some("mythra"|"native"))||!sub.get("maxConcurrent").and_then(Value::as_u64).is_some_and(|n|(1..=24).contains(&n))||serde_json::to_vec(sub).map_or(true,|b|b.len()>16384){return Err(invalid());}}
        if args.get("isolated").is_some_and(|value|!value.is_boolean()){return Err(invalid());}
    }
    if op=="workflows.start" && args.get("digest").is_some_and(|value| !value.as_str().is_some_and(|s| s.len()==64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))) { return Err(invalid()); }
    if op=="thread.fork"{id(args,"checkpointId",false)?;}
    if op=="thread.pullRequest.set"{id(args,"workspaceId",true)?;id(args,"threadId",true)?;}
    if op=="thread.pullRequest.set"&&!args.get("reference").is_some_and(|v|v.is_null()||v.as_str().is_some_and(|text|!text.trim().is_empty()&&text.len()<=2048&&!text.chars().any(char::is_control))){return Err(invalid());}
    if op=="prompt.cancel"{id(args,"startTarget",true)?;}
    if op=="git.write"&&!matches!(args.get("action").and_then(Value::as_str),Some("init"|"stage"|"unstage"|"commit"|"branch"|"push"|"pull"|"fetch"|"update"|"revert"|"revertAll"|"attachRemote"|"createRepository")){return Err(invalid());}
    if matches!(op,"checkpoint.restore"|"checkpoint.delete"|"worktree.apply"|"worktree.remove"|"worktree.continueShared"|"worktree.returnShared")&&args.get("confirmed")!=Some(&Value::Bool(true)){return Err(invalid());}
    if args.get("force").is_some_and(|value|!value.is_boolean()){return Err(invalid());}
    if op=="git.write"&&args.get("base").is_some_and(|base|!base.as_str().is_some_and(|text|!text.is_empty()&&text.len()<=256&&!text.contains('\0'))){return Err(invalid());}
    if op.starts_with("checkpoint.")&&op!="checkpoint.list"{id(args,"checkpointId",true)?;}
    if op.starts_with("terminal.") {
        if !matches!(op,"terminal.open"|"terminal.list"){id(args,"terminalId",true)?;}
        if op=="terminal.open"&&!args.get("command").and_then(Value::as_str).is_some_and(|s|!s.is_empty()&&s.len()<=32768&&!s.contains('\0')){return Err(invalid());}
        if matches!(op,"terminal.open"|"terminal.resize")&&["columns","rows"].iter().any(|key|!args.get(*key).and_then(Value::as_u64).is_some_and(|n|n>0&&n<=1000)){return Err(invalid());}
        if op=="terminal.write"&&!args.get("data").and_then(Value::as_str).is_some_and(|s|!s.is_empty()&&s.len()<=16384){return Err(invalid());}
        if op=="terminal.ack"&&!args.get("through").and_then(Value::as_u64).is_some_and(|s|s<=super::timeline::MAX_SAFE_SEQ){return Err(invalid());}
    }
    Ok(true)
}
#[cfg(test)]
mod round11_tests{
 use super::*;use serde_json::json;
 #[test]
 fn round11_strict_fields_and_terminal_capability_match_host_resources(){
  for op in ["usage.prices.refresh","tools.mcp.list","agents.presets.read","agents.read","mail.read","workflows.view","actions.list","usage.thread.read","usage.thread.details","thread.handoff.lineage","git.suggestion.read","terminal.list"]{assert!(validate(op,&json!({"workspaceId":"p","threadId":"t","limit":25})).unwrap(),"{op}");assert!(validate(op,&json!({"workspaceId":"p","arbitrary":"bad"})).is_err());}
  for op in ["agents.stop","agents.accept","agents.replace"]{let mut v=json!({"workspaceId":"p","threadId":"t","agentId":"c","target":"opaque","revision":"r","opId":"op","opSeq":1});if op=="agents.replace"{v["targetId"]=json!("approved");}assert!(validate(op,&v).unwrap(),"{op}");v["reviewToken"]=json!("viewer-supplied");assert!(validate(op,&v).is_err());}
  let mut grant=DeviceGrant::initial();assert!(access("terminal.list",&grant).is_err());grant.capabilities.terminal=true;assert!(access("terminal.list",&grant).is_ok());assert!(access("terminal.open",&grant).is_err());assert!(access("actions.run",&grant).is_err());grant.work=true;assert!(access("actions.run",&grant).is_ok());grant.capabilities.terminal=false;assert!(access("actions.run",&grant).is_err());assert!(access("review.start",&grant).is_ok());assert!(access("git.suggestCommit",&grant).is_ok());
 }
}

#[cfg(test)]
mod round13_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn publishing_changes_refuse_natively_even_with_every_capability() {
        let mut grant = DeviceGrant::initial();
        grant.work = true;
        grant.capabilities.git_write = true;
        grant.capabilities.terminal = true;
        grant.capabilities.manage_projects = true;
        grant.capabilities.full_access = true;
        for op in ["git.autoPublish.set", "git.autoPublish.retry"] {
            assert!(fields(op).is_none());
            assert!(!mutation(op));
            assert!(!validate(op, &json!({"workspaceId":"p","opId":"op","opSeq":1,"revision":"r"})).unwrap());
            assert_eq!(access(op, &grant).unwrap_err().code, "unsupported");
        }
        assert!(fields("git.autoPublish.read").is_some());
        assert!(access("git.autoPublish.read", &DeviceGrant::initial()).is_ok());
    }

    #[test]
    fn review_diff_is_a_strict_view_read_not_a_command_proxy() {
        assert!(READS.contains(&"review.diff"));
        assert!(!mutation("review.diff"));
        assert_eq!(fields("review.diff").unwrap(), (&["workspaceId", "threadId"][..], false));
        assert!(access("review.diff", &DeviceGrant::initial()).is_ok());
        let mut denied = DeviceGrant::initial();
        denied.view = false;
        assert!(access("review.diff", &denied).is_err());
        assert!(validate("review.diff", &json!({"workspaceId":"p","threadId":"t"})).unwrap());
        assert!(validate("review.diff", &json!({"workspaceId":"p","threadId":"t","path":"/private"})).is_err());
        assert!(validate("review.diff", &json!({"workspaceId":"p","threadId":"t","command":"anything"})).is_err());
        assert!(validate("review.diff", &json!({"threadId":"t"})).is_err());
    }
}
