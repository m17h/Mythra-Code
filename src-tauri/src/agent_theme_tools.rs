//! Mythra Code custom-theme tools on the `mythra_agents` bridge.
//!
//! These tools change only how the app looks. They touch no project file, run
//! no process and use no network; every change is an append-only revision the
//! user can undo, and only the user can delete a theme. That is why they are
//! offered in plain chats (an always-on app-tool scope, independent of
//! delegation and of a project) and why they are auto-approved in every
//! permission mode, including Read-only.
//!
//! The always-present tool descriptions are deliberately short: every turn of
//! every conversation pays for them. The full design documentation is the
//! result of `get_theme_design_kit`, paid for only when a model designs.
//!
//! Rust checks only shape and size. Colour parsing, contrast, effects and the
//! CSS sanitizer run in the webview, which owns the browser CSS parser.
//!
//! `capture_app_screenshot` is the one tool whose result can carry a picture:
//! the webview takes it natively (window_capture.rs) only while the user
//! allows it, and the bridge turns it into an MCP image content block.

use base64::Engine;
use serde_json::{json, Map, Value};

pub(super) const TOOL_THEME_KIT: &str = "get_theme_design_kit";
pub(super) const TOOL_THEME_LIST: &str = "list_custom_themes";
pub(super) const TOOL_THEME_GET: &str = "get_custom_theme";
pub(super) const TOOL_THEME_CREATE: &str = "create_custom_theme";
pub(super) const TOOL_THEME_UPDATE: &str = "update_custom_theme";
pub(super) const TOOL_THEME_UNDO: &str = "undo_custom_theme";
pub(super) const TOOL_THEME_APPLY: &str = "apply_custom_theme";
pub(super) const TOOL_THEME_CAPTURE: &str = "capture_app_screenshot";

pub(super) const THEME_TOOLS: [&str; 8] = [
    TOOL_THEME_KIT,
    TOOL_THEME_LIST,
    TOOL_THEME_GET,
    TOOL_THEME_CREATE,
    TOOL_THEME_UPDATE,
    TOOL_THEME_UNDO,
    TOOL_THEME_APPLY,
    TOOL_THEME_CAPTURE,
];

pub(super) const BUILT_IN_THEMES: [&str; 6] =
    ["mythra", "light-mythra", "kiwi", "daylight", "synthwave", "atari"];

const SPEC_KEYS: [&str; 11] = [
    "name",
    "description",
    "base",
    "tokens",
    "shape",
    "elevation",
    "typography",
    "surfaces",
    "effects",
    "motion",
    "customCss",
];
const SHAPES: [&str; 3] = ["crisp", "standard", "soft"];
const ELEVATIONS: [&str; 3] = ["flat", "soft", "deep"];

const MAX_NAME_BYTES: usize = 120;
const MAX_DESCRIPTION_BYTES: usize = 480;
const MAX_CUSTOM_CSS_BYTES: usize = 16_384;
const MAX_SUMMARY_BYTES: usize = 360;
const MAX_ARGUMENT_BYTES: usize = 65_536;
const MAX_REVISION: u64 = 100_000;
const MAX_UNDO_STEPS: u64 = 10;

/// Largest base64 picture the bridge forwards (about 1.2 MB of PNG).
const MAX_IMAGE_BASE64_BYTES: usize = 1_650_000;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Exactly one of the app's eight theme tools.
pub(super) fn is_theme_tool(tool: &str) -> bool {
    THEME_TOOLS.contains(&tool)
}

/// The Claude Code spelling of a bridge theme tool, if it is one.
pub(super) fn claude_theme_tool(name: &str) -> Option<&'static str> {
    let tool = name.strip_prefix("mcp__mythra_agents__")?;
    THEME_TOOLS.iter().copied().find(|candidate| *candidate == tool)
}

/// A provider-rendered title such as `mythra_agents: create_custom_theme`,
/// `mythra_agents.create_custom_theme` or `mcp__mythra_agents__…`. The match
/// is exact and anchored; the caller still re-validates the arguments.
pub(super) fn titled_theme_tool(title: &str) -> Option<&'static str> {
    let title = title.trim();
    if let Some(tool) = claude_theme_tool(title) {
        return Some(tool);
    }
    let rest = title.strip_prefix("mythra_agents")?;
    let rest = rest
        .strip_prefix("__")
        .or_else(|| {
            let trimmed = rest.trim_start();
            ['.', ':', '/']
                .iter()
                .find_map(|separator| trimmed.strip_prefix(*separator))
                .map(str::trim_start)
        })?;
    THEME_TOOLS.iter().copied().find(|candidate| *candidate == rest)
}

fn built_in_enum() -> Value {
    json!(BUILT_IN_THEMES)
}

fn theme_id() -> Value {
    json!({ "type": "string" })
}

/// Eight short tool definitions, about 3.2 KB of JSON (roughly 850 tokens):
/// every turn of every conversation pays for these, so the details live in
/// `get_theme_design_kit`'s result and shapes are checked here and in the app.
pub(super) fn theme_tool_catalog() -> Vec<Value> {
    let empty = json!({ "type": "object", "properties": {}, "additionalProperties": false });
    let object = json!({ "type": "object" });
    let flag = json!({ "type": "boolean" });
    let revision = json!({ "type": "integer", "minimum": 1 });
    vec![
        json!({
            "name": TOOL_THEME_KIT,
            "description": "How to design a Mythra Code theme: tokens and base values, contrast rules, effects and limits, fonts, customCss rules, design advice. Read once before your first theme change.",
            "inputSchema": empty,
        }),
        json!({
            "name": TOOL_THEME_LIST,
            "description": "List custom and built-in themes, the active one, and this conversation's theme. Only the user can delete themes.",
            "inputSchema": empty,
        }),
        json!({
            "name": TOOL_THEME_GET,
            "description": "Read a custom theme's spec, revision and optional history. Omit themeId for this conversation's theme.",
            "inputSchema": {
                "type": "object",
                "properties": { "themeId": theme_id(), "includeHistory": flag },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": TOOL_THEME_CREATE,
            "description": "Create a NEW app theme and apply it. Needs name, base, tokens.bg/text/accent. To change an existing theme, use update_custom_theme. The result's layout shows what your CSS hit.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "base": { "type": "string", "enum": built_in_enum() },
                    "tokens": object,
                    "shape": { "type": "string" },
                    "elevation": { "type": "string" },
                    "typography": object,
                    "surfaces": object,
                    "effects": object,
                    "motion": object,
                    "customCss": { "type": "string" },
                    "summary": { "type": "string" },
                    "apply": flag,
                    "asNewTheme": { "type": "boolean", "description": "Only if the user asked for another, separate theme." },
                },
                "required": ["name", "base", "tokens"],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": TOOL_THEME_UPDATE,
            "description": "Patch a theme: a new undoable revision of the SAME theme, applied; read layout in the result. Omit themeId for this chat's theme. tokens, effects, typography, surfaces, motion merge per key (null removes).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "themeId": theme_id(),
                    "patch": object,
                    "summary": { "type": "string" },
                    "expectedRevision": revision,
                    "apply": flag,
                },
                "required": ["patch", "summary"],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": TOOL_THEME_UNDO,
            "description": "Revert a theme by steps (default 1) or toRevision (also redo). Saves a new revision; nothing is lost.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "themeId": theme_id(),
                    "steps": { "type": "integer", "minimum": 1, "maximum": MAX_UNDO_STEPS },
                    "toRevision": revision,
                    "expectedRevision": revision,
                    "apply": flag,
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": TOOL_THEME_APPLY,
            "description": "Switch the active look to a custom theme (themeId) or a built-in one (builtInTheme). The user can undo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "themeId": theme_id(),
                    "builtInTheme": { "type": "string" },
                },
                "additionalProperties": false,
            },
        }),
        json!({
            "name": TOOL_THEME_CAPTURE,
            "description": "Picture of the Mythra Code window plus the layout report, to check a theme. The picture goes to your provider and may show chats; the user can turn it off.",
            "inputSchema": empty,
        }),
    ]
}

/// One bridge-instruction line, present only when the theme tools are.
pub(super) const THEME_BRIDGE_INSTRUCTIONS: &str = "Use the theme tools when the user asks to create, change, restyle, animate or undo how Mythra Code looks. Read get_theme_design_kit first. Adjust an existing theme with update_custom_theme instead of creating a duplicate. After each change read the result's layout; call capture_app_screenshot when you need to see the window. Only the user can delete themes.";

/// A valid PNG content block from a capture result's `image`, or None.
fn png_image_block(image: &Value) -> Option<Value> {
    let image = image.as_object()?;
    if image.get("mimeType")?.as_str()? != "image/png" {
        return None;
    }
    let data = image.get("data")?.as_str()?;
    if data.is_empty() || data.len() > MAX_IMAGE_BASE64_BYTES {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return None;
    }
    Some(json!({ "type": "image", "data": data, "mimeType": "image/png" }))
}

/// The MCP result for a theme tool whose answer may carry a picture: the
/// text payload (without the base64) followed by one image content block.
/// None for every other tool and for errors, which use the plain text result.
pub(super) fn theme_tool_mcp_result(tool: &str, payload: &Value, is_error: bool) -> Option<Value> {
    if tool != TOOL_THEME_CAPTURE || is_error {
        return None;
    }
    let mut text = payload.as_object()?.clone();
    let image = text.remove("image");
    let block = image.as_ref().and_then(png_image_block);
    if image.is_some() && block.is_none() {
        text.insert("captured".into(), json!(false));
        text.insert(
            "note".into(),
            json!("The picture was dropped because it was not a PNG within the size limit. Use the layout report."),
        );
    }
    let text = Value::Object(text);
    let mut content = vec![json!({
        "type": "text",
        "text": serde_json::to_string_pretty(&text).unwrap_or_else(|_| text.to_string()),
    })];
    content.extend(block);
    Some(json!({ "content": content, "isError": false }))
}

fn valid_theme_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| {
        id.len() == 13
            && id.starts_with("ct_")
            && id[3..]
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

fn only_keys(object: &Map<String, Value>, allowed: &[&str], tool: &str) -> Result<(), String> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        let list = if allowed.is_empty() {
            "no arguments".to_string()
        } else {
            allowed
                .iter()
                .map(|key| format!("`{key}`"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        return Err(format!("`{tool}` does not accept `{key}`; it accepts {list}."));
    }
    Ok(())
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<(), String> {
    if object.get(key).is_some_and(|value| !value.is_boolean()) {
        return Err(format!("`{key}` must be true or false."));
    }
    Ok(())
}

fn optional_theme_id(object: &Map<String, Value>) -> Result<(), String> {
    if object.get("themeId").is_some_and(|value| !valid_theme_id(value)) {
        return Err("`themeId` must be a custom theme id such as ct_a1b2c3d4e5 (see list_custom_themes).".into());
    }
    Ok(())
}

fn optional_integer(object: &Map<String, Value>, key: &str, max: u64) -> Result<(), String> {
    if object
        .get(key)
        .is_some_and(|value| !value.as_u64().is_some_and(|number| (1..=max).contains(&number)))
    {
        return Err(format!("`{key}` must be a whole number from 1 to {max}."));
    }
    Ok(())
}

fn bounded_text(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
    required: bool,
    nonempty: bool,
) -> Result<(), String> {
    match object.get(key) {
        None if required => Err(format!("`{key}` is required.")),
        None => Ok(()),
        Some(value) => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("`{key}` must be a string."))?;
            if nonempty && text.trim().is_empty() {
                return Err(format!("`{key}` cannot be empty."));
            }
            if text.len() > max {
                return Err(format!(
                    "`{key}` is too long ({} UTF-8 bytes); the limit is {max}.",
                    text.len()
                ));
            }
            if text.chars().any(|c| c.is_control() && c != '\n' && c != '\t' && key != "customCss") {
                return Err(format!("`{key}` cannot contain control characters."));
            }
            Ok(())
        }
    }
}

/// The shape shared by create arguments and an update patch. `required`
/// applies create's mandatory fields; a patch may name any subset.
fn validate_spec_fields(
    object: &Map<String, Value>,
    required: bool,
    prefix: &str,
) -> Result<(), String> {
    let at = |key: &str| format!("{prefix}{key}");
    if required && !object.contains_key("name") {
        return Err("`name` is required.".into());
    }
    bounded_text(object, "name", MAX_NAME_BYTES, false, true)
        .map_err(|error| error.replace("`name`", &format!("`{}`", at("name"))))?;
    bounded_text(object, "description", MAX_DESCRIPTION_BYTES, false, false)
        .map_err(|error| error.replace("`description`", &format!("`{}`", at("description"))))?;
    match object.get("base") {
        None if required => {
            return Err(format!(
                "`base` is required: one of {}. Its light or dark scheme is kept.",
                BUILT_IN_THEMES.join(", ")
            ))
        }
        Some(value) if !value.as_str().is_some_and(|base| BUILT_IN_THEMES.contains(&base)) => {
            return Err(format!(
                "`{}` must be one of {}.",
                at("base"),
                BUILT_IN_THEMES.join(", ")
            ))
        }
        _ => {}
    }
    match object.get("tokens") {
        None if required => {
            return Err("`tokens` is required and needs at least bg, text and accent colours.".into())
        }
        Some(value) if !value.is_object() => {
            return Err(format!("`{}` must be an object of colour tokens.", at("tokens")))
        }
        _ => {}
    }
    for (key, choices) in [("shape", &SHAPES[..]), ("elevation", &ELEVATIONS[..])] {
        if object
            .get(key)
            .is_some_and(|value| !value.as_str().is_some_and(|text| choices.contains(&text)))
        {
            return Err(format!("`{}` must be one of {}.", at(key), choices.join(", ")));
        }
    }
    for key in ["typography", "surfaces", "effects", "motion"] {
        if object.get(key).is_some_and(|value| !value.is_object()) {
            return Err(format!("`{}` must be an object (see get_theme_design_kit).", at(key)));
        }
    }
    bounded_text(object, "customCss", MAX_CUSTOM_CSS_BYTES, false, false)
        .map_err(|error| error.replace("`customCss`", &format!("`{}`", at("customCss"))))?;
    Ok(())
}

fn total_size(arguments: &Value) -> Result<(), String> {
    let size = serde_json::to_vec(arguments).map(|bytes| bytes.len()).unwrap_or(usize::MAX);
    if size > MAX_ARGUMENT_BYTES {
        return Err(format!(
            "The theme arguments are too large ({size} bytes); the limit is {MAX_ARGUMENT_BYTES}. Send fewer tokens or a shorter customCss."
        ));
    }
    Ok(())
}

/// Shape and size checks for a theme tool call. Deep checks run in the app.
pub(super) fn validate_theme_tool_call(tool: &str, arguments: &Value) -> Result<(), String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| "Tool arguments must be an object.".to_string())?;
    total_size(arguments)?;
    match tool {
        TOOL_THEME_KIT | TOOL_THEME_LIST | TOOL_THEME_CAPTURE => only_keys(object, &[], tool),
        TOOL_THEME_GET => {
            only_keys(object, &["themeId", "includeHistory"], tool)?;
            optional_theme_id(object)?;
            optional_bool(object, "includeHistory")
        }
        TOOL_THEME_CREATE => {
            let mut allowed = SPEC_KEYS.to_vec();
            allowed.extend(["summary", "apply", "asNewTheme"]);
            only_keys(object, &allowed, tool)?;
            validate_spec_fields(object, true, "")?;
            bounded_text(object, "summary", MAX_SUMMARY_BYTES, false, false)?;
            optional_bool(object, "apply")?;
            optional_bool(object, "asNewTheme")
        }
        TOOL_THEME_UPDATE => {
            only_keys(object, &["themeId", "patch", "summary", "apply", "expectedRevision"], tool)?;
            optional_theme_id(object)?;
            let patch = object
                .get("patch")
                .ok_or_else(|| "`patch` is required: an object with only the fields that change.".to_string())?
                .as_object()
                .ok_or_else(|| "`patch` must be an object with only the fields that change.".to_string())?;
            if patch.is_empty() {
                return Err("`patch` is empty; include at least one field to change.".into());
            }
            if let Some(key) = patch.keys().find(|key| !SPEC_KEYS.contains(&key.as_str())) {
                return Err(format!(
                    "`patch.{key}` is not a theme field. A patch may contain {}.",
                    SPEC_KEYS.join(", ")
                ));
            }
            validate_spec_fields(patch, false, "patch.")?;
            bounded_text(object, "summary", MAX_SUMMARY_BYTES, true, true)?;
            optional_integer(object, "expectedRevision", MAX_REVISION)?;
            optional_bool(object, "apply")
        }
        TOOL_THEME_UNDO => {
            only_keys(object, &["themeId", "steps", "toRevision", "apply", "expectedRevision"], tool)?;
            optional_theme_id(object)?;
            if object.contains_key("steps") && object.contains_key("toRevision") {
                return Err("Use `steps` to go back a number of changes, or `toRevision` to restore one revision, not both.".into());
            }
            optional_integer(object, "steps", MAX_UNDO_STEPS)?;
            optional_integer(object, "toRevision", MAX_REVISION)?;
            optional_integer(object, "expectedRevision", MAX_REVISION)?;
            optional_bool(object, "apply")
        }
        TOOL_THEME_APPLY => {
            only_keys(object, &["themeId", "builtInTheme"], tool)?;
            match (object.get("themeId"), object.get("builtInTheme")) {
                (Some(_), Some(_)) | (None, None) => Err(format!(
                    "Pass exactly one of `themeId` (a custom theme) or `builtInTheme` ({}).",
                    BUILT_IN_THEMES.join(", ")
                )),
                (Some(_), None) => optional_theme_id(object),
                (None, Some(value)) => {
                    if value.as_str().is_some_and(|theme| BUILT_IN_THEMES.contains(&theme)) {
                        Ok(())
                    } else {
                        Err(format!("`builtInTheme` must be one of {}.", BUILT_IN_THEMES.join(", ")))
                    }
                }
            }
        }
        other => Err(format!("`{other}` is not a theme tool.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(tool: &str, arguments: Value) {
        assert_eq!(validate_theme_tool_call(tool, &arguments), Ok(()), "{tool} {arguments}");
    }

    fn err(tool: &str, arguments: Value) -> String {
        validate_theme_tool_call(tool, &arguments).expect_err(&format!("{tool} {arguments} should fail"))
    }

    fn create() -> Value {
        json!({ "name": "Nebula", "base": "mythra", "tokens": { "bg": "#16131f", "text": "#ece8f6", "accent": "#b794ff" } })
    }

    #[test]
    fn catalog_lists_the_eight_tools_with_closed_schemas() {
        let catalog = theme_tool_catalog();
        let names: Vec<_> = catalog.iter().filter_map(|tool| tool["name"].as_str()).collect();
        assert_eq!(names, THEME_TOOLS.to_vec());
        for tool in &catalog {
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert_eq!(tool["inputSchema"]["additionalProperties"], false, "{}", tool["name"]);
            let description = tool["description"].as_str().unwrap();
            assert!(description.len() < 220, "{} description is {} bytes", tool["name"], description.len());
        }
        // The whole always-on surface stays small: under 3.3 KB of JSON
        // (roughly 850 tokens), inside the 1k-token budget.
        let bytes = serde_json::to_string(&catalog).unwrap().len();
        assert!(bytes <= 3_300, "theme catalog is {bytes} bytes");
    }

    #[test]
    fn capture_result_carries_one_validated_png() {
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest-of-file");
        let payload = json!({ "captured": true, "width": 1280, "height": 800, "layout": { "regions": [] }, "image": { "data": png, "mimeType": "image/png" } });
        let result = theme_tool_mcp_result(TOOL_THEME_CAPTURE, &payload, false).expect("capture result");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        let text = content[0]["text"].as_str().unwrap();
        assert!(text.contains("\"layout\"") && !text.contains(&png), "the base64 stays out of the text");
        assert_eq!(content[1], json!({ "type": "image", "data": png, "mimeType": "image/png" }));
        assert_eq!(result["isError"], false);
        // Not a PNG, the wrong type, or too large: dropped with a note.
        for image in [
            json!({ "data": base64::engine::general_purpose::STANDARD.encode(b"GIF89a"), "mimeType": "image/png" }),
            json!({ "data": png, "mimeType": "image/svg+xml" }),
            json!({ "data": "%%%", "mimeType": "image/png" }),
            json!({ "data": "A".repeat(MAX_IMAGE_BASE64_BYTES + 4), "mimeType": "image/png" }),
        ] {
            let result = theme_tool_mcp_result(TOOL_THEME_CAPTURE, &json!({ "captured": true, "image": image }), false).unwrap();
            let content = result["content"].as_array().unwrap();
            assert_eq!(content.len(), 1);
            assert!(content[0]["text"].as_str().unwrap().contains("dropped"));
        }
        // Text-only answers (switch off, runtime without images) stay text.
        let plain = theme_tool_mcp_result(TOOL_THEME_CAPTURE, &json!({ "captured": false, "note": "no" }), false).unwrap();
        assert_eq!(plain["content"].as_array().unwrap().len(), 1);
        assert!(theme_tool_mcp_result(TOOL_THEME_CAPTURE, &json!({ "error": "off" }), true).is_none());
        assert!(theme_tool_mcp_result(TOOL_THEME_UPDATE, &payload, false).is_none());
    }

    #[test]
    fn empty_argument_tools_take_nothing() {
        ok(TOOL_THEME_KIT, json!({}));
        ok(TOOL_THEME_LIST, json!({}));
        ok(TOOL_THEME_CAPTURE, json!({}));
        assert!(err(TOOL_THEME_CAPTURE, json!({ "region": "sidebar" })).contains("no arguments"));
        assert!(err(TOOL_THEME_KIT, json!({ "verbose": true })).contains("no arguments"));
        assert!(err(TOOL_THEME_LIST, json!([])).contains("object"));
    }

    #[test]
    fn get_checks_id_and_history_flag() {
        ok(TOOL_THEME_GET, json!({}));
        ok(TOOL_THEME_GET, json!({ "themeId": "ct_a1b2c3d4e5", "includeHistory": true }));
        err(TOOL_THEME_GET, json!({ "themeId": "ct_A1B2C3D4E5" }));
        err(TOOL_THEME_GET, json!({ "themeId": "nebula" }));
        err(TOOL_THEME_GET, json!({ "themeId": "ct_a1b2c3d4e5x" }));
        err(TOOL_THEME_GET, json!({ "includeHistory": "yes" }));
        err(TOOL_THEME_GET, json!({ "id": "ct_a1b2c3d4e5" }));
    }

    #[test]
    fn create_requires_name_base_and_tokens() {
        ok(TOOL_THEME_CREATE, create());
        let mut full = create();
        full.as_object_mut().unwrap().extend([
            ("description".into(), json!("Indigo night")),
            ("shape".into(), json!("soft")),
            ("elevation".into(), json!("deep")),
            ("typography".into(), json!({ "ui": "rounded" })),
            ("surfaces".into(), json!({ "translucency": 0.1 })),
            ("effects".into(), json!({ "aurora": { "intensity": 0.3 } })),
            ("motion".into(), json!({ "enabled": true })),
            ("customCss".into(), json!(".composer { border-color: var(--accent-line); }")),
            ("summary".into(), json!("First version")),
            ("apply".into(), json!(false)),
            ("asNewTheme".into(), json!(true)),
        ]);
        ok(TOOL_THEME_CREATE, full);
        for missing in ["name", "base", "tokens"] {
            let mut arguments = create();
            arguments.as_object_mut().unwrap().remove(missing);
            assert!(err(TOOL_THEME_CREATE, arguments).contains(missing));
        }
        let mut wrong = create();
        wrong["base"] = json!("dracula");
        assert!(err(TOOL_THEME_CREATE, wrong).contains("mythra"));
        let mut blank = create();
        blank["name"] = json!("   ");
        err(TOOL_THEME_CREATE, blank);
        let mut long = create();
        long["name"] = json!("n".repeat(121));
        err(TOOL_THEME_CREATE, long);
        let mut tokens = create();
        tokens["tokens"] = json!("#000");
        err(TOOL_THEME_CREATE, tokens);
        let mut shape = create();
        shape["shape"] = json!("round");
        err(TOOL_THEME_CREATE, shape);
        let mut effects = create();
        effects["effects"] = json!(["aurora"]);
        err(TOOL_THEME_CREATE, effects);
        let mut extra = create();
        extra["delete"] = json!(true);
        assert!(err(TOOL_THEME_CREATE, extra).contains("delete"));
        let mut flag = create();
        flag["apply"] = json!("true");
        err(TOOL_THEME_CREATE, flag);
        let mut control = create();
        control["name"] = json!("Neb\u{0007}ula");
        err(TOOL_THEME_CREATE, control);
    }

    #[test]
    fn create_bounds_css_summary_and_total_size() {
        let mut css = create();
        css["customCss"] = json!("a".repeat(MAX_CUSTOM_CSS_BYTES));
        ok(TOOL_THEME_CREATE, css.clone());
        css["customCss"] = json!("a".repeat(MAX_CUSTOM_CSS_BYTES + 1));
        assert!(err(TOOL_THEME_CREATE, css).contains("customCss"));
        let mut summary = create();
        summary["summary"] = json!("s".repeat(MAX_SUMMARY_BYTES + 1));
        err(TOOL_THEME_CREATE, summary);
        let mut huge = create();
        huge["tokens"]["padding"] = json!("x".repeat(MAX_ARGUMENT_BYTES));
        assert!(err(TOOL_THEME_CREATE, huge).contains("too large"));
    }

    #[test]
    fn update_needs_a_nonempty_spec_patch_and_summary() {
        ok(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": { "accent": "#ff8fd1", "muted": null } }, "summary": "Pinker accent" }));
        ok(TOOL_THEME_UPDATE, json!({ "themeId": "ct_a1b2c3d4e5", "patch": { "effects": { "aurora": null } }, "summary": "No aurora", "expectedRevision": 7, "apply": false }));
        ok(TOOL_THEME_UPDATE, json!({ "patch": { "customCss": "" }, "summary": "Remove CSS" }));
        assert!(err(TOOL_THEME_UPDATE, json!({ "summary": "x" })).contains("patch"));
        assert!(err(TOOL_THEME_UPDATE, json!({ "patch": {}, "summary": "x" })).contains("empty"));
        assert!(err(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": {} } })).contains("summary"));
        err(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": {} }, "summary": " " }));
        assert!(err(TOOL_THEME_UPDATE, json!({ "patch": { "summary": "x" }, "summary": "x" })).contains("patch.summary"));
        assert!(err(TOOL_THEME_UPDATE, json!({ "patch": { "asNewTheme": true }, "summary": "x" })).contains("patch.asNewTheme"));
        assert!(err(TOOL_THEME_UPDATE, json!({ "patch": { "base": "nope" }, "summary": "x" })).contains("patch.base"));
        assert!(err(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": [] }, "summary": "x" })).contains("patch.tokens"));
        err(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": {} }, "summary": "x", "expectedRevision": 0 }));
        err(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": {} }, "summary": "x", "expectedRevision": 100_001 }));
        err(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": {} }, "summary": "x", "expectedRevision": 2.5 }));
        err(TOOL_THEME_UPDATE, json!({ "patch": { "tokens": {} }, "summary": "x", "themeId": "Nebula" }));
    }

    #[test]
    fn undo_takes_steps_or_a_revision() {
        ok(TOOL_THEME_UNDO, json!({}));
        ok(TOOL_THEME_UNDO, json!({ "steps": 3, "expectedRevision": 9 }));
        ok(TOOL_THEME_UNDO, json!({ "themeId": "ct_a1b2c3d4e5", "toRevision": 2, "apply": true }));
        err(TOOL_THEME_UNDO, json!({ "steps": 1, "toRevision": 2 }));
        err(TOOL_THEME_UNDO, json!({ "steps": 0 }));
        err(TOOL_THEME_UNDO, json!({ "steps": 11 }));
        err(TOOL_THEME_UNDO, json!({ "toRevision": -1 }));
        err(TOOL_THEME_UNDO, json!({ "revision": 2 }));
    }

    #[test]
    fn apply_takes_exactly_one_target() {
        ok(TOOL_THEME_APPLY, json!({ "themeId": "ct_a1b2c3d4e5" }));
        for theme in BUILT_IN_THEMES {
            ok(TOOL_THEME_APPLY, json!({ "builtInTheme": theme }));
        }
        err(TOOL_THEME_APPLY, json!({}));
        err(TOOL_THEME_APPLY, json!({ "themeId": "ct_a1b2c3d4e5", "builtInTheme": "kiwi" }));
        err(TOOL_THEME_APPLY, json!({ "builtInTheme": "custom:ct_a1b2c3d4e5" }));
        err(TOOL_THEME_APPLY, json!({ "themeId": "mythra" }));
    }

    #[test]
    fn unknown_tools_are_not_theme_tools() {
        assert!(err("delete_custom_theme", json!({})).contains("not a theme tool"));
        assert!(!is_theme_tool("delete_custom_theme"));
        assert!(is_theme_tool(TOOL_THEME_UNDO));
    }

    #[test]
    fn provider_tool_names_match_exactly() {
        assert_eq!(claude_theme_tool("mcp__mythra_agents__create_custom_theme"), Some(TOOL_THEME_CREATE));
        assert_eq!(claude_theme_tool("mcp__mythra_agents__spawn_mythra_agent"), None);
        assert_eq!(claude_theme_tool("mcp__other__create_custom_theme"), None);
        assert_eq!(claude_theme_tool("mcp__mythra_agents__create_custom_theme_x"), None);
        for title in [
            "mythra_agents: update_custom_theme",
            "mythra_agents.update_custom_theme",
            "mythra_agents/update_custom_theme",
            "mythra_agents__update_custom_theme",
            "mcp__mythra_agents__update_custom_theme",
            "  mythra_agents : update_custom_theme ",
        ] {
            assert_eq!(titled_theme_tool(title), Some(TOOL_THEME_UPDATE), "{title}");
        }
        for title in [
            "Run mythra_agents.update_custom_theme",
            "mythra_agents.update_custom_theme && rm -rf /",
            "other_server.update_custom_theme",
            "mythra_agentsupdate_custom_theme",
            "update_custom_theme",
            "mythra_agents: spawn_mythra_agent",
        ] {
            assert_eq!(titled_theme_tool(title), None, "{title}");
        }
    }
}
