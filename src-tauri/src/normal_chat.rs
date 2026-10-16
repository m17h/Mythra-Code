use std::path::Path;

use serde_json::{json, Value};
use tauri::AppHandle;

const INSTRUCTIONS: &str = "This is a normal Mythra Code conversation, with no project attached. Your runtime's working directory is private application infrastructure, NOT the user's project or an output folder. Do not introduce it as a workspace or mention its path in greetings. Do not inspect it for project context, initialize Git, create or edit files, install packages, build software, or start development servers in that internal folder or its descendants. You retain the user's selected permissions and tools: you may read, create, edit, move or delete files ELSEWHERE when the user requests it, without requiring a project. Use explicit user-selected destination paths, never the internal working directory as a default. If no destination is clear, ask where the file should go. For project-based development, offer to open the user's project folder. These boundaries also apply to delegated work.";

/// Match filesystem identity before lexical spelling, so a project reached
/// through a symlink or a backing-folder/../project path is not misclassified.
pub(crate) fn contains(app: &AppHandle, cwd: &str) -> Result<bool, String> {
    let root = crate::release_qa::app_data_dir(app)
        .map_err(|error| format!("Could not resolve normal-chat context: {error}"))?
        .join("normal-chats");
    let path = Path::new(cwd);
    Ok(match (path.canonicalize(), root.canonicalize()) {
        (Ok(path), Ok(root)) => path.starts_with(root),
        _ => !path.components().any(|part| matches!(part, std::path::Component::ParentDir))
            && path.starts_with(&root),
    })
}

pub(crate) fn instructions(prompt: &str) -> String {
    if prompt.contains(INSTRUCTIONS) { return prompt.to_owned(); }
    if prompt.trim().is_empty() { INSTRUCTIONS.to_owned() }
    else { format!("{prompt}\n\n{INSTRUCTIONS}") }
}

/// Conversation context is independent of access policy: do not override
/// sandbox, approval, MCP/app tools or the user's chosen permission mode.
pub(crate) fn annotate_codex(app: &AppHandle, method: &str, params: &mut Value) -> Result<(), String> {
    if !matches!(method, "thread/start" | "thread/resume" | "thread/fork" | "turn/start") { return Ok(()); }
    let Some(cwd) = params.get("cwd").and_then(Value::as_str) else { return Ok(()); };
    if !contains(app, cwd)? { return Ok(()); }
    if method == "turn/start" {
        // Managed turns replace startup developer instructions. Apply the
        // same context to loaded conversations on each new turn.
        if let Some(settings) = params.pointer_mut("/collaborationMode/settings").and_then(Value::as_object_mut) {
            let prior = settings.get("developer_instructions").and_then(Value::as_str).unwrap_or_default();
            settings.insert("developer_instructions".into(), json!(instructions(prior)));
        } else if let Some(input) = params.get_mut("input").and_then(Value::as_array_mut) {
            input.insert(0, json!({ "type": "text", "text": INSTRUCTIONS }));
        }
    } else {
        let prior = params["developerInstructions"].as_str().unwrap_or_default();
        params["developerInstructions"] = json!(instructions(prior));
    }
    Ok(())
}
