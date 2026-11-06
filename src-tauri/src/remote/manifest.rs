//! Exact parity operation manifest. Never a generic invoke/native proxy.
use super::{
    store::{DeviceGrant, GrantScope},
    wire::WireError,
};
use serde_json::Value;
fn invalid() -> WireError {
    WireError::new("invalid", "That remote action is not valid.")
}
pub(super) const READS: &[&str] = &[
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
    "checks.read",
    "checks.status",
    "discovery.run.status",
    "discovery.check.status",
];
pub(super) fn mutation(op: &str) -> bool {
    matches!(
        op,
        "queue.edit.begin"
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
            &["opId", "opSeq", "threadId", "model", "effort", "provider"],
            true,
        ),
        "thread.rename" => (&["opId", "opSeq", "threadId", "name"], true),
        "thread.archive" => (&["opId", "opSeq", "threadId"], true),
        "thread.restore" => (&["opId", "opSeq", "threadId"], true),
        "thread.fork" => (&["opId", "opSeq", "threadId"], true),
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
        "files.search" => (&["workspaceId", "query"], false),
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
            ],
            false,
        ),
        _ => return None,
    })
}
pub(super) fn access(op: &str, grant: &DeviceGrant) -> Result<(), WireError> {
    let manage = matches!(
        op,
        "projects.add"
            | "projects.remove"
            | "folders.browse"
            | "projects.settings.set"
            | "projects.instructions.set"
            | "projects.profiles.save"
            | "projects.profiles.delete"
            | "projects.profiles.select"
    );
    let shell = matches!(
        op,
        "projects.run.set"
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
    if !grant.view
        || (mutation(op)
            || manage
            || shell
            || op == "work.inspect"
            || super::work::MUTATIONS.contains(&op))
            && !grant.work
        || manage
            && (!matches!(grant.scope, GrantScope::All) || !grant.capabilities.manage_projects)
        || shell && !grant.capabilities.terminal
    {
        return Err(WireError::new(
            "forbidden",
            "This device does not have the required access switch on the host.",
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
    if !matches!(op, "folders.browse" | "projects.add") {
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
        "cursor",
        "folderId",
        "parentId",
        "fileId",
        "changeId",
        "relativeTo",
    ] {
        id(args, key, false)?;
    }
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
            .is_some_and(|limit| (1..=200).contains(&limit))
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
    Ok(true)
}
