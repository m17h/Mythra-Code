//! Bounded, read-only code navigation through the existing authenticated bridge.
//! The bridge supplies the trusted project root; callers only select a relative
//! file, a position and one of four fixed protocol operations.
use super::language_tools::{self, Launch, OwnedProcess};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
use tauri::AppHandle;
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStdout},
    sync::{Semaphore, SemaphorePermit},
    time::timeout,
};

const MAX_SOURCE: usize = 1024 * 1024;
const MAX_MESSAGE: usize = 1024 * 1024;
// The bridge nests compact JSON inside a JSON string. Reserve room for its
// escaping and envelope, then enforce the actual wrapper budget at that boundary.
const MAX_RESULT: usize = 96 * 1024;
pub(super) const MAX_BRIDGE_RESULT: usize = 256 * 1024;
const MAX_ITEMS: usize = 1000;
const DEFAULT_ITEMS: usize = 50;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum LanguageQueryOperation {
    Definition,
    References,
    Hover,
    Symbols,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LanguageToolQuery {
    pub operation: LanguageQueryOperation,
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub max_results: Option<usize>,
    pub path_filter: Option<String>,
    pub name_filter: Option<String>,
}
pub(super) fn validate_filters(query: &LanguageToolQuery) -> Result<usize, String> {
    let limit = query.max_results.unwrap_or(DEFAULT_ITEMS);
    if limit == 0 || limit > MAX_ITEMS {
        return Err("maxResults must be between 1 and 1000.".into());
    }
    if query.name_filter.is_some() && query.operation != LanguageQueryOperation::Symbols {
        return Err("nameFilter is supported only for symbol queries.".into());
    }
    if query.path_filter.is_some() && query.operation == LanguageQueryOperation::Hover {
        return Err("pathFilter is supported for definitions, references and symbols.".into());
    }
    for filter in [&query.path_filter, &query.name_filter]
        .into_iter()
        .flatten()
    {
        if filter.is_empty() || filter.len() > 256 || filter.chars().any(char::is_control) {
            return Err("Filters must contain 1 to 256 bytes without control characters.".into());
        }
    }
    Ok(limit)
}
fn slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(2))
}

fn redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}
fn contained(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalized = |p: &Path| {
            PathBuf::from(language_tools::child_path(p))
                .components()
                .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
                .collect::<Vec<_>>()
        };
        normalized(path).starts_with(&normalized(root))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}
fn scoped_path(project: &Path, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(
            "Use a project-relative file path without parent-directory or absolute components."
                .into(),
        );
    }
    let root =
        fs::canonicalize(project).map_err(|_| "The thread's project folder is unavailable.")?;
    if !root.is_dir() {
        return Err("The thread's project folder is unavailable.".into());
    }
    let mut candidate = root.clone();
    for part in relative.components() {
        candidate.push(part.as_os_str());
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|_| "The requested project file is unavailable.")?;
        if redirected(&metadata) {
            return Err(
                "Language queries cannot follow project symlinks or redirected files.".into(),
            );
        }
    }
    let file =
        fs::canonicalize(candidate).map_err(|_| "Could not resolve the requested project file.")?;
    if !contained(&file, &root) || !file.is_file() {
        return Err("Language queries require a file inside this thread's project.".into());
    }
    Ok((root, file))
}
fn scoped_file(project: &Path, relative: &str) -> Result<(PathBuf, PathBuf, String), String> {
    let (root, file) = scoped_path(project, relative)?;
    let mut source = String::new();
    fs::File::open(&file)
        .map_err(|_| "Could not read the requested project file.")?
        .take((MAX_SOURCE + 1) as u64)
        .read_to_string(&mut source)
        .map_err(|_| "Language queries require a UTF-8 source file.")?;
    if source.len() > MAX_SOURCE {
        return Err("This source file exceeds the 1 MiB language-query limit.".into());
    }
    Ok((root, file, source))
}
fn position(query: &LanguageToolQuery, source: &str) -> Result<Option<Value>, String> {
    if query.operation == LanguageQueryOperation::Symbols {
        return if query.line.is_none() && query.column.is_none() {
            Ok(None)
        } else {
            Err("Symbol queries do not accept a line or column.".into())
        };
    }
    let line = query
        .line
        .filter(|n| *n > 0)
        .ok_or("A one-based line is required.")?;
    let column = query
        .column
        .filter(|n| *n > 0)
        .ok_or("A one-based UTF-16 column is required.")?;
    let text = source
        .split('\n')
        .nth((line - 1) as usize)
        .ok_or("The requested line is outside the source file.")?
        .trim_end_matches('\r');
    let target = column - 1;
    let mut units = 0;
    for c in text.chars() {
        if units == target {
            break;
        }
        units += c.len_utf16() as u32;
    }
    if units != target {
        return Err(
            "The requested UTF-16 column is outside the line or splits a character.".into(),
        );
    }
    Ok(Some(json!({"line":line-1,"character":target})))
}
async fn send(child: &mut Child, message: Value) -> Result<(), String> {
    let body = serde_json::to_vec(&message).map_err(|_| "Could not encode the language query.")?;
    let input = child
        .stdin
        .as_mut()
        .ok_or("The language server input is unavailable.")?;
    input
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await
        .map_err(|_| "The language server closed its input.")?;
    input
        .write_all(&body)
        .await
        .map_err(|_| "The language server closed its input.".into())
}
async fn receive(output: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    super::language_framing::read_message(output, MAX_MESSAGE).await
}
fn configuration_item(item: &Value, configuration: &Value) -> Value {
    let section = item
        .get("section")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if section.is_empty() || section == "rust-analyzer" {
        return configuration.clone();
    }
    if let Some(section) = section.strip_prefix("rust-analyzer.") {
        let mut value = configuration;
        for key in section.split('.') {
            let Some(next) = value.get(key) else {
                return json!({});
            };
            value = next;
        }
        return value.clone();
    }
    json!({})
}
fn validate_capabilities(initialized: &Value, capability: &str) -> Result<(), String> {
    let capabilities = initialized
        .get("capabilities")
        .filter(|value| value.is_object())
        .ok_or("The language server refused initialization.")?;
    if capabilities
        .get("positionEncoding")
        .and_then(Value::as_str)
        .is_some_and(|encoding| encoding != "utf-16")
    {
        return Err(
            "This language server selected an unsupported position encoding; UTF-16 is required."
                .into(),
        );
    }
    if capabilities
        .get(capability)
        .is_none_or(|value| value.is_null() || value == &json!(false))
    {
        return Err("This installed server does not support the requested operation.".into());
    }
    Ok(())
}
async fn request(
    child: &mut Child,
    output: &mut BufReader<ChildStdout>,
    id: u32,
    method: &str,
    params: Value,
    root_uri: &str,
    configuration: &Value,
) -> Result<Value, String> {
    timeout(REQUEST_TIMEOUT, async {
        send(child, json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).await?;
        for _ in 0..128 {
            let message = receive(output).await?;
            if let Some(server_method) = message.get("method").and_then(Value::as_str) {
                if let Some(server_id) = message.get("id") {
                    // Answer safe client requests only; never apply edits or execute commands.
                    let result = match server_method {
                        "workspace/configuration" => Value::Array(message.pointer("/params/items").and_then(Value::as_array).map(|items| items.iter().map(|item| configuration_item(item, configuration)).collect()).unwrap_or_default()),
                        "workspace/workspaceFolders" => json!([{"uri":root_uri,"name":"project"}]),
                        "workspace/applyEdit" => json!({"applied":false,"failureReason":"Language queries are read-only."}),
                        _ => Value::Null,
                    };
                    send(child, json!({"jsonrpc":"2.0","id":server_id,"result":result})).await?;
                }
            } else if message.get("id") == Some(&json!(id)) {
                if let Some(error) = message.get("error") {
                    let detail = error.get("message").and_then(Value::as_str).unwrap_or("The server rejected the request.");
                    return Err(format!("Language query failed: {}", detail.chars().take(500).collect::<String>()));
                }
                return message.get("result").cloned().ok_or_else(|| "The language server returned no result.".into());
            }
        }
        Err("The language server emitted too many messages without answering.".into())
    }).await.map_err(|_| "The language query timed out.".to_string())?
}
fn relative_path(path: &Path, root: &Path) -> Option<String> {
    // Windows URI paths need the same verbatim-prefix/case normalization as the
    // containment guard before stripping the canonical root.
    let path = PathBuf::from(language_tools::child_path(path));
    let root = PathBuf::from(language_tools::child_path(root));
    if !contained(&path, &root) {
        return None;
    }
    Some(
        path.components()
            .skip(root.components().count())
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}
fn uri_path(value: &Value, root: &Path) -> Option<String> {
    value
        .as_str()
        .and_then(|uri| Url::parse(uri).ok())
        .and_then(|uri| uri.to_file_path().ok())
        .filter(|path| contained(path, root))
        .and_then(|path| fs::canonicalize(path).ok())
        .and_then(|path| relative_path(&path, root))
}
fn normalized_range(value: &Value) -> Option<Value> {
    let point = |point: &Value| -> Option<Value> {
        Some(json!({"line":point.get("line")?.as_u64()?.checked_add(1)?,
            "column":point.get("character")?.as_u64()?.checked_add(1)?}))
    };
    Some(json!({"start":point(value.get("start")?)?, "end":point(value.get("end")?)?}))
}
fn range_points(value: &Value) -> Option<((u64, u64), (u64, u64))> {
    let point = |value: &Value| -> Option<(u64, u64)> {
        let line = value.get("line")?.as_u64()?;
        let character = value.get("character")?.as_u64()?;
        (line <= u32::MAX as u64 && character <= u32::MAX as u64).then_some((line, character))
    };
    let start = point(value.get("start")?)?;
    let end = point(value.get("end")?)?;
    (start <= end).then_some((start, end))
}
fn valid_uri(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(|uri| Url::parse(uri).ok())
        .is_some()
}
fn valid_location(value: &Value, links: bool) -> bool {
    if !value.is_object() {
        return false;
    }
    if value.get("targetUri").is_some() {
        let Some(range) = value.get("targetRange").and_then(range_points) else {
            return false;
        };
        let Some(selection) = value.get("targetSelectionRange").and_then(range_points) else {
            return false;
        };
        links
            && valid_uri(value.get("targetUri"))
            && range.0 <= selection.0
            && selection.1 <= range.1
            && value
                .get("originSelectionRange")
                .is_none_or(|range| range_points(range).is_some())
    } else {
        valid_uri(value.get("uri")) && value.get("range").and_then(range_points).is_some()
    }
}
fn valid_symbol(value: &Value) -> bool {
    if !value.get("name").is_some_and(Value::is_string)
        || !value
            .get("kind")
            .and_then(Value::as_u64)
            .is_some_and(|kind| (1..=26).contains(&kind))
    {
        return false;
    }
    if let Some(location) = value.get("location") {
        return valid_location(location, false);
    }
    let Some(range) = value.get("range").and_then(range_points) else {
        return false;
    };
    let Some(selection) = value.get("selectionRange").and_then(range_points) else {
        return false;
    };
    range.0 <= selection.0
        && selection.1 <= range.1
        && value.get("children").is_none_or(|children| {
            children
                .as_array()
                .is_some_and(|children| children.iter().all(valid_symbol))
        })
}
fn valid_hover_contents(value: &Value) -> bool {
    match value {
        Value::String(_) => true,
        Value::Array(items) => items
            .iter()
            .all(|item| !item.is_array() && valid_hover_contents(item)),
        Value::Object(fields) => {
            fields.get("value").is_some_and(Value::is_string)
                && (fields.get("language").is_some_and(Value::is_string)
                    || fields
                        .get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| matches!(kind, "markdown" | "plaintext")))
        }
        _ => false,
    }
}
fn validate_result_shape(value: &Value, operation: LanguageQueryOperation) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let valid = match operation {
        LanguageQueryOperation::Definition => match value {
            Value::Array(items) => items.iter().all(|item| valid_location(item, true)),
            _ => valid_location(value, true),
        },
        LanguageQueryOperation::References => value
            .as_array()
            .is_some_and(|items| items.iter().all(|item| valid_location(item, false))),
        LanguageQueryOperation::Symbols => value
            .as_array()
            .is_some_and(|items| items.iter().all(valid_symbol)),
        LanguageQueryOperation::Hover => {
            value.is_object()
                && value.get("contents").is_some_and(valid_hover_contents)
                && value
                    .get("range")
                    .is_none_or(|range| range_points(range).is_some())
        }
    };
    if valid {
        Ok(())
    } else {
        Err("The language server returned a malformed result for this operation.".into())
    }
}
#[derive(Default)]
struct ResultCounts {
    omitted: usize,
    filtered: usize,
}
fn normalize_entry(
    value: Value,
    root: &Path,
    file_path: &str,
    query: &LanguageToolQuery,
    counts: &mut ResultCounts,
) -> Option<Value> {
    let fields = value.as_object()?;
    let uri = fields
        .get("targetUri")
        .or_else(|| fields.get("uri"))
        .or_else(|| fields.get("location").and_then(|v| v.get("uri")));
    let path = match uri {
        Some(uri) => match uri_path(uri, root) {
            Some(path) => path,
            None => {
                counts.omitted += 1;
                return None;
            }
        },
        None => file_path.to_owned(),
    };
    let mut output = serde_json::Map::new();
    output.insert("path".into(), json!(path));
    for (input, out) in [
        ("targetRange", "range"),
        ("range", "range"),
        ("targetSelectionRange", "selectionRange"),
        ("selectionRange", "selectionRange"),
        ("originSelectionRange", "originSelectionRange"),
    ] {
        if let Some(range) = fields.get(input).and_then(normalized_range) {
            output.insert(out.into(), range);
        }
    }
    if let Some(range) = fields
        .get("location")
        .and_then(|v| v.get("range"))
        .and_then(normalized_range)
    {
        output.insert("range".into(), range);
    }
    if query.operation == LanguageQueryOperation::Symbols {
        for name in [
            "name",
            "kind",
            "detail",
            "containerName",
            "tags",
            "deprecated",
            "contextOnly",
        ] {
            if let Some(value) = fields.get(name) {
                if name == "detail"
                    && value
                        .as_str()
                        .is_some_and(|detail| detail.len() > 16 * 1024)
                {
                    let mut detail = value.clone();
                    trim_strings(&mut detail, 16 * 1024);
                    output.insert(name.into(), detail);
                    output.insert("detailTruncated".into(), json!(true));
                } else {
                    output.insert(name.into(), value.clone());
                }
            }
        }
        let children = fields
            .get("children")
            .and_then(Value::as_array)
            .map(|children| {
                children
                    .iter()
                    .cloned()
                    .filter_map(|value| normalize_entry(value, root, file_path, query, counts))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !children.is_empty() {
            output.insert("children".into(), json!(children));
        }
    }
    Some(Value::Object(output))
}
// Filter the bounded raw structure first. Count and select before adding paths
// and converting ranges, so a large number of tiny raw symbols cannot expand
// into an unbounded number of repeated long project-relative paths.
fn filter_entry(
    value: Value,
    root: &Path,
    file_path: &str,
    query: &LanguageToolQuery,
    counts: &mut ResultCounts,
) -> Option<Value> {
    let Value::Object(mut fields) = value else {
        return None;
    };
    let uri = fields
        .get("targetUri")
        .or_else(|| fields.get("uri"))
        .or_else(|| fields.get("location").and_then(|v| v.get("uri")));
    let path = match uri {
        Some(uri) => match uri_path(uri, root) {
            Some(path) => path,
            None => {
                counts.omitted += 1;
                return None;
            }
        },
        None => file_path.to_owned(),
    };
    if query
        .path_filter
        .as_ref()
        .is_some_and(|filter| !path.contains(filter))
    {
        counts.filtered += 1;
        return None;
    }
    if query.operation == LanguageQueryOperation::Symbols {
        let children = match fields.remove("children") {
            Some(Value::Array(children)) => children,
            _ => vec![],
        };
        let children = children
            .into_iter()
            .filter_map(|child| filter_entry(child, root, file_path, query, counts))
            .collect::<Vec<_>>();
        let matches_name = query.name_filter.as_ref().is_none_or(|filter| {
            fields
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.contains(filter))
        });
        if !matches_name {
            if children.is_empty() {
                counts.filtered += 1;
                return None;
            }
            fields.insert("contextOnly".into(), json!(true));
        }
        if !children.is_empty() {
            fields.insert("children".into(), json!(children));
        }
    } else {
        fields.remove("children");
    }
    Some(Value::Object(fields))
}
fn result_count(value: &Value) -> usize {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| 1 + item.get("children").map(result_count).unwrap_or(0))
            .sum(),
        _ => 0,
    }
}
fn take_items(value: &mut Value, remaining: &mut usize) {
    if let Some(items) = value.as_array_mut() {
        let mut keep = 0;
        for item in items.iter_mut() {
            if *remaining == 0 {
                break;
            }
            *remaining -= 1;
            keep += 1;
            if let Some(children) = item.get_mut("children") {
                take_items(children, remaining);
            }
        }
        items.truncate(keep);
    }
}
fn remove_last_item(value: &mut Value) -> bool {
    let Some(items) = value.as_array_mut() else {
        return false;
    };
    let Some(last) = items.last_mut() else {
        return false;
    };
    if last.get_mut("children").is_some_and(remove_last_item) {
        return true;
    }
    items.pop();
    true
}
fn detail_truncated(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item.get("detailTruncated") == Some(&json!(true))
                || item.get("children").is_some_and(detail_truncated)
        })
    })
}
fn bounded_result(
    result: Value,
    root: &Path,
    file_path: &str,
    query: &LanguageToolQuery,
) -> Result<Value, String> {
    validate_result_shape(&result, query.operation)?;
    let limit = validate_filters(query)?;
    let mut counts = ResultCounts::default();
    let mut filtered = if query.operation == LanguageQueryOperation::Hover {
        if result.is_null() {
            Value::Null
        } else {
            let mut hover =
                json!({"contents":result.get("contents").cloned().unwrap_or(Value::Null)});
            if let Some(range) = result.get("range").and_then(normalized_range) {
                hover["range"] = range;
            }
            hover
        }
    } else {
        let entries = match result {
            Value::Array(entries) => entries,
            Value::Null => vec![],
            other => vec![other],
        };
        Value::Array(
            entries
                .into_iter()
                .filter_map(|entry| filter_entry(entry, root, file_path, query, &mut counts))
                .collect(),
        )
    };
    let total = if query.operation == LanguageQueryOperation::Hover {
        usize::from(!filtered.is_null())
    } else {
        result_count(&filtered)
    };
    let mut remaining = limit;
    take_items(&mut filtered, &mut remaining);
    if query.operation != LanguageQueryOperation::Hover {
        let entries = match filtered {
            Value::Array(entries) => entries,
            _ => unreachable!(),
        };
        filtered = Value::Array(
            entries
                .into_iter()
                .filter_map(|entry| normalize_entry(entry, root, file_path, query, &mut counts))
                .collect(),
        );
    }
    let returned = if query.operation == LanguageQueryOperation::Hover {
        total
    } else {
        result_count(&filtered)
    };
    let detail_truncated = detail_truncated(&filtered);
    Ok(
        json!({"result":filtered,"total":total,"returned":returned,"truncated":returned<total || detail_truncated,
        "truncatedReason":if returned<total { Some("maxResults") } else if detail_truncated {Some("detailBytes")} else { None },
        "omittedExternalLocations":counts.omitted,"filteredOut":counts.filtered,
        "positionEncoding":"UTF-16; ranges use one-based line and column",
        "freshness":"The source fingerprint describes only the requested file opened for this query; other project files can change during analysis."}),
    )
}
fn trim_strings(value: &mut Value, limit: usize) {
    match value {
        Value::String(text) => {
            let mut end = text.len().min(limit);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        Value::Array(items) => {
            for item in items {
                trim_strings(item, limit);
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields {
                if key != "path" {
                    trim_strings(item, limit);
                }
            }
        }
        _ => {}
    }
}
fn budget_payload(mut payload: Value, operation: LanguageQueryOperation) -> Result<Value, String> {
    let mut string_limit = 16 * 1024;
    while serde_json::to_vec(&payload)
        .map_err(|_| "Could not encode the language result.")?
        .len()
        > MAX_RESULT
    {
        payload["truncated"] = json!(true);
        payload["truncatedReason"] = json!("outputBytes");
        if operation != LanguageQueryOperation::Hover && remove_last_item(&mut payload["result"]) {
            payload["returned"] = json!(result_count(&payload["result"]));
        } else if !payload["result"].is_null() {
            // Preserve hover/signature structure, truncating strings on UTF-8
            // boundaries. Location and range fields are never shortened.
            trim_strings(&mut payload["result"], string_limit);
            if string_limit == 0 {
                return Err("The language result cannot fit within the output budget.".into());
            }
            string_limit /= 2;
        } else {
            return Err("The language result metadata exceeds the output budget.".into());
        }
    }
    Ok(payload)
}
async fn run(
    launch: &Launch,
    language: &str,
    root: &Path,
    file: &Path,
    arguments: &LanguageToolQuery,
    launch_proof: Option<&language_tools::QueryLaunchProof>,
) -> Result<Value, String> {
    #[cfg(test)]
    let session_started = std::time::Instant::now();
    let operation = arguments.operation;
    let root_uri = Url::from_directory_path(root)
        .map_err(|_| "Could not encode the project folder URI.")?
        .to_string();
    let file_uri = Url::from_file_path(file)
        .map_err(|_| "Could not encode the source file URI.")?
        .to_string();
    let mut owned = OwnedProcess::spawn(language_tools::command(launch, root))?;
    let mut output = BufReader::new(
        owned
            .child
            .stdout
            .take()
            .ok_or("The language server output is unavailable.")?,
    );
    let result = timeout(CALL_TIMEOUT, async {
        let initialization = if language == "rust" { json!({"cargo":{"buildScripts":{"enable":false}},"procMacro":{"enable":false},"checkOnSave":false,"check":{"enable":false}}) } else { launch.initialization_options.clone().unwrap_or(Value::Null) };
        let configuration = if language == "rust" { initialization.clone() } else { json!({}) };
        // Bash's initialized handler only parses documents after its async
        // configuration exchange. Use its app-owned defaults directly so an
        // immediately following cold query cannot race that exchange.
        let client_configuration = language != "shellscript";
        let initialized = request(&mut owned.child, &mut output, 1, "initialize", json!({"processId":std::process::id(),"rootUri":root_uri,"workspaceFolders":[{"uri":root_uri,"name":"project"}],"capabilities":{"general":{"positionEncodings":["utf-16"]},"workspace":{"configuration":client_configuration,"workspaceFolders":true},"textDocument":{"definition":{"linkSupport":true},"documentSymbol":{"hierarchicalDocumentSymbolSupport":true}}},"initializationOptions":initialization}), &root_uri, &configuration).await?;
        if !initialized.get("capabilities").is_some_and(Value::is_object) { return Err("The language server refused initialization.".into()); }
        #[cfg(test)]
        let initialize_ms = session_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(proof) = launch_proof { language_tools::record_query_initialization(proof, launch, root).await?; }
        send(&mut owned.child, json!({"jsonrpc":"2.0","method":"initialized","params":{}})).await?;
        let (method, capability) = match operation { LanguageQueryOperation::Definition => ("textDocument/definition","definitionProvider"), LanguageQueryOperation::References => ("textDocument/references","referencesProvider"), LanguageQueryOperation::Hover => ("textDocument/hover","hoverProvider"), LanguageQueryOperation::Symbols => ("textDocument/documentSymbol","documentSymbolProvider") };
        validate_capabilities(&initialized,capability)?;
        // Queue admission and server startup are both await boundaries. Resolve
        // containment again and derive the UTF-16 position from exactly the text
        // that will be opened, rather than the earlier selection-time read.
        let (fresh_root, fresh_file, source) = scoped_file(root, &arguments.path)?;
        if fresh_root != root || fresh_file != file { return Err("The requested source path changed while the language server started.".into()); }
        let position = position(arguments, &source)?;
        let fingerprint = format!("{:x}", Sha256::digest(source.as_bytes()));
        send(&mut owned.child, json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":file_uri,"languageId":language,"version":1,"text":source}}})).await?;
        let mut params = json!({"textDocument":{"uri":file_uri}});
        if let Some(position) = position { params["position"]=position; }
        if operation == LanguageQueryOperation::References { params["context"]=json!({"includeDeclaration":true}); }
        let result = request(&mut owned.child, &mut output, 2, method, params, &root_uri, &configuration).await?;
        let path = relative_path(file, root).ok_or("The source file is outside the project.")?;
        let mut result = bounded_result(result, root, &path, arguments)?;
        result["source"] = json!({"path":path,"sha256":fingerprint,"version":1});
        let result = budget_payload(result, operation)?;
        #[cfg(test)]
        if std::env::var_os("MYTHRA_LANGUAGE_QUERY_METRICS").is_some() {
            eprintln!("LANGUAGE_QUERY_METRICS={}", json!({"operation":format!("{operation:?}"),
                "wallMs":session_started.elapsed().as_secs_f64()*1000.0,"initializeMs":initialize_ms,
                "starts":1,"initializations":1,"compactPayloadBytes":serde_json::to_vec(&result).unwrap().len(),
                "returned":result["returned"],"total":result["total"]}));
        }
        // Shutdown is best effort and bounded independently of the query result.
        let _ = timeout(Duration::from_secs(1), request(&mut owned.child, &mut output, 3, "shutdown", Value::Null, &root_uri, &configuration)).await;
        let _ = send(&mut owned.child, json!({"jsonrpc":"2.0","method":"exit"})).await;
        Ok(result)
    }).await.map_err(|_| "The language-server session timed out.".to_string());
    owned.stop().await;
    result?
}
pub(super) async fn query(
    app: &AppHandle,
    project_path: &Path,
    arguments: LanguageToolQuery,
    permission: &str,
) -> Result<Value, String> {
    timeout(
        CALL_TIMEOUT,
        query_inner(app, project_path, arguments, permission),
    )
    .await
    .map_err(|_| "The complete language query timed out.".to_string())?
}
async fn admitted_source(
    project_path: &Path,
    arguments: &LanguageToolQuery,
) -> Result<(SemaphorePermit<'static>, PathBuf, PathBuf, String), String> {
    validate_filters(arguments)?;
    let (initial_root, initial_file) = scoped_path(project_path, &arguments.path)?;
    let permit = timeout(Duration::from_secs(10), slots().acquire())
        .await
        .map_err(|_| "Both language-query slots are busy. Try again shortly.")?
        .map_err(|_| "Language queries are unavailable.")?;
    let (root, file, source) = scoped_file(project_path, &arguments.path)?;
    if initial_root != root || initial_file != file {
        return Err(
            "The requested source path changed while waiting for a language-query slot.".into(),
        );
    }
    position(arguments, &source)?;
    Ok((permit, root, file, source))
}
async fn query_inner(
    app: &AppHandle,
    project_path: &Path,
    arguments: LanguageToolQuery,
    permission: &str,
) -> Result<Value, String> {
    let (_permit, root, file, source) = admitted_source(project_path, &arguments).await?;
    drop(source);
    let (language, launch, proof) =
        language_tools::query_launch(app, &file, &root, permission).await?;
    run(&launch, &language, &root, &file, &arguments, Some(&proof)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_slot_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }
    fn temporary() -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("mythra-language-query-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        fs::canonicalize(p).unwrap()
    }
    fn query(
        operation: LanguageQueryOperation,
        line: Option<u32>,
        column: Option<u32>,
    ) -> LanguageToolQuery {
        LanguageToolQuery {
            operation,
            path: "file.ts".into(),
            line,
            column,
            max_results: None,
            path_filter: None,
            name_filter: None,
        }
    }
    fn test_range() -> Value {
        json!({"start":{"line":0,"character":0},"end":{"line":0,"character":1}})
    }
    fn symbol_fixture(mut value: Value) -> Value {
        if let Some(items) = value.as_array_mut() {
            for item in items {
                item["kind"] = json!(12);
                if item.get("location").is_some() {
                    item["location"]["range"] = test_range();
                } else {
                    item["range"] = test_range();
                    item["selectionRange"] = test_range();
                }
                if let Some(children) = item.get_mut("children") {
                    *children = symbol_fixture(children.take());
                }
            }
        }
        value
    }
    #[test]
    fn utf16_positions_require_complete_characters_and_one_based_lines() {
        let source = "x😀z\r\nnext\n";
        assert_eq!(
            position(
                &query(LanguageQueryOperation::Hover, Some(1), Some(4)),
                source
            )
            .unwrap(),
            Some(json!({"line":0,"character":3}))
        );
        assert!(position(
            &query(LanguageQueryOperation::Hover, Some(1), Some(3)),
            source
        )
        .is_err());
        assert!(position(
            &query(LanguageQueryOperation::Hover, Some(0), Some(1)),
            source
        )
        .is_err());
        assert!(position(
            &query(LanguageQueryOperation::Hover, Some(1), Some(6)),
            source
        )
        .is_err());
        assert!(
            position(&query(LanguageQueryOperation::Symbols, None, None), source)
                .unwrap()
                .is_none()
        );
        assert!(position(
            &query(LanguageQueryOperation::Symbols, Some(1), None),
            source
        )
        .is_err());
    }
    #[test]
    fn server_configuration_cannot_reenable_rust_build_hooks() {
        let safe = json!({"cargo":{"buildScripts":{"enable":false}},"procMacro":{"enable":false}});
        assert_eq!(
            configuration_item(&json!({"section":"rust-analyzer"}), &safe),
            safe
        );
        assert_eq!(
            configuration_item(
                &json!({"section":"rust-analyzer.cargo.buildScripts.enable"}),
                &safe
            ),
            json!(false)
        );
        assert_eq!(
            configuration_item(&json!({"section":"unknown"}), &safe),
            json!({})
        );
    }
    #[test]
    fn servers_must_support_requested_operation_and_utf16() {
        assert!(validate_capabilities(
            &json!({"capabilities":{"definitionProvider":true}}),
            "definitionProvider"
        )
        .is_ok());
        assert!(validate_capabilities(
            &json!({"capabilities":{"definitionProvider":{},"positionEncoding":"utf-16"}}),
            "definitionProvider"
        )
        .is_ok());
        assert!(validate_capabilities(
            &json!({"capabilities":{"definitionProvider":true,"positionEncoding":"utf-8"}}),
            "definitionProvider"
        )
        .is_err());
        assert!(validate_capabilities(
            &json!({"capabilities":{"definitionProvider":false}}),
            "definitionProvider"
        )
        .is_err());
        assert!(validate_capabilities(&json!({"capabilities":{}}), "referencesProvider").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_uri_paths_match_canonical_verbatim_drive_and_unc_roots() {
        assert!(contained(
            Path::new(r"C:\Projects\Mixed Case\file.ts"),
            Path::new(r"\\?\c:\projects\mixed case")
        ));
        assert!(contained(
            Path::new(r"\\SERVER\Share\Project\file.ts"),
            Path::new(r"\\?\UNC\server\share\project")
        ));
        assert!(!contained(
            Path::new(r"C:\Projects\Sibling\file.ts"),
            Path::new(r"\\?\C:\Projects\Project")
        ));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_server_workers_and_releases_capacity() {
        let _guard = test_slot_lock().lock().await;
        let root = temporary();
        let launch = Launch {
            command: PathBuf::from("/bin/sh"),
            args: vec![
                "-c".into(),
                "sleep 20 & echo $! > owned-worker.pending; mv owned-worker.pending owned-worker; wait".into(),
            ],
            extensions: vec![],
            initialization_options: None,
        };
        let permit = slots().acquire().await.unwrap();
        let mut owned = OwnedProcess::new(language_tools::command(&launch, &root).spawn().unwrap());
        let started = tokio::time::Instant::now();
        while !root.join("owned-worker").exists() && started.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let worker: i32 = fs::read_to_string(root.join("owned-worker"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(worker, 0) }, 0);
        // Cancellation of an in-flight response drops the owning guard and permit.
        assert!(timeout(
            Duration::from_millis(20),
            receive(&mut BufReader::new(owned.child.stdout.take().unwrap()))
        )
        .await
        .is_err());
        drop(owned);
        drop(permit);
        let started = tokio::time::Instant::now();
        while unsafe { libc::kill(worker, 0) } == 0 && started.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(
            unsafe { libc::kill(worker, 0) },
            0,
            "owned descendant survived cancelled session"
        );
        assert_eq!(slots().available_permits(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn query_rejects_escape_directories_large_sources_and_unknown_fields() {
        let root = temporary();
        fs::write(root.join("file.ts"), "let n = 1;").unwrap();
        assert!(scoped_file(&root, "file.ts").is_ok());
        for p in ["../file.ts", "/etc/passwd", ".", ""] {
            assert!(scoped_file(&root, p).is_err());
        }
        assert!(scoped_file(&root, "missing.ts").is_err());
        fs::write(root.join("large.ts"), vec![b'x'; MAX_SOURCE + 1]).unwrap();
        assert!(scoped_file(&root, "large.ts").is_err());
        assert!(serde_json::from_value::<LanguageToolQuery>(
            json!({"operation":"executeCommand","path":"file.ts"})
        )
        .is_err());
        assert!(serde_json::from_value::<LanguageToolQuery>(
            json!({"operation":"hover","path":"file.ts","command":"node"})
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Requires explicitly provided trusted Node runtime; verifies native Windows cancellation"]
    async fn native_windows_cancellation_kills_job_workers_and_releases_capacity() {
        let _guard = test_slot_lock().lock().await;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        };
        let node = PathBuf::from(
            std::env::var_os("MYTHRA_LANGUAGE_QUERY_NODE").expect("set trusted Node executable"),
        );
        let root = temporary();
        let child_root = root.clone();
        let task = tokio::spawn(async move {
            let _permit = slots().acquire().await.unwrap();
            let launch = Launch { command:node,args:vec!["-e".into(),"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('owned-worker',String(c.pid));setInterval(()=>{},1000);".into()],extensions:vec![],initialization_options:None };
            let mut owned =
                OwnedProcess::spawn(language_tools::command(&launch, &child_root)).unwrap();
            let mut output = BufReader::new(owned.child.stdout.take().unwrap());
            receive(&mut output).await
        });
        timeout(Duration::from_secs(5), async {
            while !root.join("owned-worker").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let pid: u32 = fs::read_to_string(root.join("owned-worker"))
            .unwrap()
            .parse()
            .unwrap();
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        assert!(
            !raw.is_null(),
            "owned worker must exist before cancellation"
        );
        let worker = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert_eq!(
            unsafe { WaitForSingleObject(worker.as_raw_handle(), 0) },
            258
        );
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            unsafe { WaitForSingleObject(worker.as_raw_handle(), 2000) },
            0,
            "owned descendant survived cancellation"
        );
        assert_eq!(slots().available_permits(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_inputs_and_external_locations_are_excluded() {
        let root = temporary();
        let external = temporary();
        fs::write(external.join("file.ts"), "").unwrap();
        std::os::unix::fs::symlink(&external, root.join("link")).unwrap();
        assert!(scoped_file(&root, "link/file.ts").is_err());
        fs::write(root.join("file.ts"), "").unwrap();
        let inside = Url::from_file_path(root.join("file.ts"))
            .unwrap()
            .to_string();
        let outside = Url::from_file_path(external.join("file.ts"))
            .unwrap()
            .to_string();
        let value = bounded_result(
            json!([{"uri":inside,"range":test_range()},{"targetUri":outside,"targetRange":test_range(),"targetSelectionRange":test_range()}]),
            &root,
            "file.ts",
            &query(LanguageQueryOperation::Definition, Some(1), Some(1)),
        )
        .unwrap();
        assert_eq!(value["result"].as_array().unwrap().len(), 1);
        assert_eq!(value["result"][0]["path"], "file.ts");
        assert_eq!(value["omittedExternalLocations"], 1);
        let external_uri = Url::from_file_path(external.join("file.ts"))
            .unwrap()
            .to_string();
        let symbols=bounded_result(symbol_fixture(json!([{"name":"parent","children":[{"name":"outside","location":{"uri":external_uri}}]}])),&root,"file.ts",&query(LanguageQueryOperation::Symbols,None,None)).unwrap();
        assert!(symbols["result"][0].get("children").is_none());
        assert_eq!(symbols["omittedExternalLocations"], 1);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }
    #[test]
    fn malformed_navigation_hover_and_symbol_results_are_explicit_errors() {
        let root = temporary();
        let uri = Url::from_file_path(root.join("file.ts"))
            .unwrap()
            .to_string();
        for operation in [
            LanguageQueryOperation::Definition,
            LanguageQueryOperation::References,
        ] {
            let arguments = query(operation, Some(1), Some(1));
            for invalid in [
                json!([{"range":test_range()}]),
                json!([{}]),
                json!([{"uri":uri}]),
                json!([{"targetUri":uri,"targetRange":test_range()}]),
                json!("malformed"),
                json!(9),
            ] {
                assert!(bounded_result(invalid, &root, "file.ts", &arguments)
                    .unwrap_err()
                    .contains("malformed"));
            }
            assert_eq!(
                bounded_result(json!([]), &root, "file.ts", &arguments).unwrap()["returned"],
                0
            );
            assert_eq!(
                bounded_result(Value::Null, &root, "file.ts", &arguments).unwrap()["returned"],
                0
            );
        }
        let hover = query(LanguageQueryOperation::Hover, Some(1), Some(1));
        for invalid in [
            json!({}),
            json!({"contents":null}),
            json!("signature"),
            json!({"contents":{"value":"missing kind"}}),
        ] {
            assert!(bounded_result(invalid, &root, "file.ts", &hover).is_err());
        }
        assert_eq!(
            bounded_result(Value::Null, &root, "file.ts", &hover).unwrap()["returned"],
            0
        );
        let symbols = query(LanguageQueryOperation::Symbols, None, None);
        assert!(bounded_result(json!([{"name":"fake"}]), &root, "file.ts", &symbols).is_err());
        assert!(bounded_result(
            symbol_fixture(json!([{"name":"real"}])),
            &root,
            "file.ts",
            &symbols
        )
        .is_ok());
        assert!(!valid_location(
            &json!({"uri":uri,"range":{"start":{"line":5,"character":0},"end":{"line":1,"character":0}}}),
            false
        ));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symbol_and_hover_outputs_are_bounded() {
        let root = temporary();
        let symbols = symbol_fixture(json!([{ "name":"one", "children":[{"name":"nested"}]}]));
        assert!(bounded_result(
            symbols,
            &root,
            "file.ts",
            &query(LanguageQueryOperation::Symbols, None, None)
        )
        .is_ok());
        let large = bounded_result(
            symbol_fixture(json!(vec![json!({"name":"x"}); MAX_ITEMS + 1])),
            &root,
            "file.ts",
            &query(LanguageQueryOperation::Symbols, None, None),
        )
        .unwrap();
        assert_eq!(large["total"], MAX_ITEMS + 1);
        assert_eq!(large["returned"], DEFAULT_ITEMS);
        assert_eq!(large["truncated"], true);
        let hover = bounded_result(
            json!({"contents":"x".repeat(MAX_RESULT+1)}),
            &root,
            "file.ts",
            &query(LanguageQueryOperation::Hover, Some(1), Some(1)),
        )
        .unwrap();
        let hover = budget_payload(hover, LanguageQueryOperation::Hover).unwrap();
        assert_eq!(hover["truncatedReason"], "outputBytes");
        assert!(serde_json::to_vec(&hover).unwrap().len() <= MAX_RESULT);
        let symbol = bounded_result(
            symbol_fixture(json!([{"name":"useful", "detail":"x".repeat(MAX_RESULT+1)}])),
            &root,
            "file.ts",
            &query(LanguageQueryOperation::Symbols, None, None),
        )
        .unwrap();
        let symbol = budget_payload(symbol, LanguageQueryOperation::Symbols).unwrap();
        assert_eq!(symbol["result"][0]["name"], "useful");
        assert_eq!(symbol["result"][0]["detailTruncated"], true);
        assert_eq!(symbol["returned"], 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn queued_source_is_reread_after_admission() {
        let _guard = test_slot_lock().lock().await;
        let root = temporary();
        fs::write(root.join("file.ts"), "before queue").unwrap();
        let one = slots().acquire().await.unwrap();
        let two = slots().acquire().await.unwrap();
        let queued_root = root.clone();
        let task = tokio::spawn(async move {
            admitted_source(
                &queued_root,
                &query(LanguageQueryOperation::Symbols, None, None),
            )
            .await
        });
        tokio::task::yield_now().await;
        fs::write(root.join("file.ts"), "after admission").unwrap();
        drop(one);
        drop(two);
        let (permit, _, _, source) = task.await.unwrap().unwrap();
        assert_eq!(source, "after admission");
        drop(permit);
        assert_eq!(slots().available_permits(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn useful_locations_are_counted_after_external_filtering_and_real_filters() {
        let root = temporary();
        let external = temporary();
        fs::write(root.join("file.ts"), "").unwrap();
        fs::write(external.join("external.ts"), "").unwrap();
        let inside = Url::from_file_path(root.join("file.ts"))
            .unwrap()
            .to_string();
        let outside = Url::from_file_path(external.join("external.ts"))
            .unwrap()
            .to_string();
        let range = json!({"start":{"line":1,"character":2},"end":{"line":1,"character":4}});
        let mut entries = vec![json!({"uri":outside,"range":range}); MAX_ITEMS + 1];
        entries.push(json!({"targetUri":inside,"targetRange":range,"targetSelectionRange":range,"originSelectionRange":range}));
        let mut arguments = query(LanguageQueryOperation::Definition, Some(1), Some(1));
        arguments.path_filter = Some("file.ts".into());
        let result = bounded_result(json!(entries), &root, "file.ts", &arguments).unwrap();
        assert_eq!(result["total"], 1);
        assert_eq!(result["omittedExternalLocations"], MAX_ITEMS + 1);
        assert_eq!(
            result["result"][0]["selectionRange"]["start"],
            json!({"line":2,"column":3})
        );
        assert_eq!(
            result["result"][0]["originSelectionRange"],
            result["result"][0]["range"]
        );
        arguments.path_filter = Some("missing".into());
        let result = bounded_result(
            json!([{"uri":inside,"range":range}]),
            &root,
            "file.ts",
            &arguments,
        )
        .unwrap();
        assert_eq!(result["total"], 0);
        assert_eq!(result["filteredOut"], 1);
        let mut arguments = query(LanguageQueryOperation::Symbols, None, None);
        arguments.name_filter = Some("needle".into());
        let result = bounded_result(
            symbol_fixture(
                json!([{"name":"parent","children":[{"name":"other"},{"name":"needle"}]}]),
            ),
            &root,
            "file.ts",
            &arguments,
        )
        .unwrap();
        assert_eq!(result["result"][0]["contextOnly"], true);
        assert_eq!(result["result"][0]["children"][0]["name"], "needle");
        assert_eq!(result["total"], 2);
        assert_eq!(result["filteredOut"], 1);
        arguments.max_results = Some(1);
        let result = bounded_result(
            symbol_fixture(json!([{"name":"parent","children":[{"name":"needle"}]}])),
            &root,
            "file.ts",
            &arguments,
        )
        .unwrap();
        assert_eq!(result["returned"], 1);
        assert_eq!(result["truncated"], true);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }
    #[test]
    fn escaped_hover_and_nested_symbols_respect_payload_budget() {
        let root = temporary();
        let hover = bounded_result(
            json!({"contents":{"kind":"markdown","value":"\"\\😀".repeat(40000)}}),
            &root,
            "file.ts",
            &query(LanguageQueryOperation::Hover, Some(1), Some(1)),
        )
        .unwrap();
        let hover = budget_payload(hover, LanguageQueryOperation::Hover).unwrap();
        let wrapper = json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":serde_json::to_string(&hover).unwrap()}],"isError":false}});
        assert!(serde_json::to_vec(&wrapper).unwrap().len() + 1 <= MAX_BRIDGE_RESULT);
        assert_eq!(hover["truncated"], true);
        let mut arguments = query(LanguageQueryOperation::Symbols, None, None);
        arguments.max_results = Some(1000);
        let symbols = bounded_result(symbol_fixture(json!([{"name":"parent","children":vec![json!({"name":"child","detail":"x".repeat(3000)}); 100]}])),&root,"file.ts",&arguments).unwrap();
        let symbols = budget_payload(symbols, LanguageQueryOperation::Symbols).unwrap();
        assert_eq!(
            symbols["returned"].as_u64().unwrap() as usize,
            result_count(&symbols["result"])
        );
        assert_eq!(symbols["total"], 101);
        assert_eq!(symbols["truncatedReason"], "outputBytes");
        assert!(serde_json::to_vec(&symbols).unwrap().len() <= MAX_RESULT);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn initialization_wait_rereads_source_and_revalidates_utf16_and_containment() {
        let root = temporary();
        let file = root.join("file.ts");
        let script = r#"while IFS= read -r line; do
  length=$(printf '%s' "$line" | tr -d '\r' | sed -n 's/^Content-Length: //p')
  [ -n "$length" ] || continue
  IFS= read -r blank
  body=$(dd bs=1 count="$length" 2>/dev/null)
  case "$body" in
    *'"method":"initialize"'*)
      ACTION
      reply='{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"documentSymbolProvider":true,"hoverProvider":true}}}' ;;
    *'"method":"textDocument/didOpen"'*) printf '%s' "$body" > opened.json; continue ;;
    *'"method":"textDocument/documentSymbol"'*) reply='{"jsonrpc":"2.0","id":2,"result":[]}' ;;
    *'"method":"shutdown"'*) reply='{"jsonrpc":"2.0","id":3,"result":null}' ;;
    *) continue ;;
  esac
  printf 'Content-Length: %s\r\n\r\n%s' "${#reply}" "$reply"
done"#;
        let launch_for = |action: &str| Launch {
            command: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script.replace("ACTION", action)],
            extensions: vec![],
            initialization_options: None,
        };
        fs::write(&file, "before").unwrap();
        let arguments = query(LanguageQueryOperation::Symbols, None, None);
        let result = run(
            &launch_for("printf fresh > file.ts"),
            "typescript",
            &root,
            &file,
            &arguments,
            None,
        )
        .await
        .unwrap();
        let opened: Value =
            serde_json::from_slice(&fs::read(root.join("opened.json")).unwrap()).unwrap();
        assert_eq!(
            opened.pointer("/params/textDocument/text").unwrap(),
            "fresh"
        );
        assert_eq!(
            result["source"]["sha256"],
            format!("{:x}", Sha256::digest(b"fresh"))
        );
        fs::remove_file(root.join("opened.json")).unwrap();
        fs::write(&file, "long enough").unwrap();
        let arguments = query(LanguageQueryOperation::Hover, Some(1), Some(4));
        assert!(run(
            &launch_for("printf x > file.ts"),
            "typescript",
            &root,
            &file,
            &arguments,
            None
        )
        .await
        .unwrap_err()
        .contains("UTF-16"));
        assert!(!root.join("opened.json").exists());
        let arguments = query(LanguageQueryOperation::Symbols, None, None);
        assert!(run(
            &launch_for("rm file.ts; ln -s /etc/hosts file.ts"),
            "typescript",
            &root,
            &file,
            &arguments,
            None
        )
        .await
        .unwrap_err()
        .contains("symlinks"));
        assert!(!root.join("opened.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "Explicit opt-in isolated query measurements with a retained server; no downloads or model requests"]
    async fn native_query_efficiency_measurement() {
        let launch = Launch {
            command: PathBuf::from(
                std::env::var_os("MYTHRA_LANGUAGE_QUERY_BENCH_COMMAND")
                    .expect("set trusted retained server command"),
            ),
            args: serde_json::from_str(
                &std::env::var("MYTHRA_LANGUAGE_QUERY_BENCH_ARGS").expect("set JSON launch args"),
            )
            .unwrap(),
            extensions: vec![],
            initialization_options: std::env::var("MYTHRA_LANGUAGE_QUERY_BENCH_INITIALIZATION")
                .ok()
                .map(|value| serde_json::from_str(&value).unwrap()),
        };
        let root = temporary();
        fs::write(
            root.join("defs.ts"),
            "export function twice(value: number): number { return value * 2; }\n",
        )
        .unwrap();
        fs::write(
            root.join("file.ts"),
            "import { twice } from './defs';\nconst answer = twice(21);\n",
        )
        .unwrap();
        fs::write(
            root.join("tsconfig.json"),
            r#"{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}"#,
        )
        .unwrap();
        let mut measurements = vec![];
        for round in 0..3 {
            for operation in [
                LanguageQueryOperation::Definition,
                LanguageQueryOperation::References,
                LanguageQueryOperation::Hover,
                LanguageQueryOperation::Symbols,
            ] {
                let arguments = query(
                    operation,
                    (operation != LanguageQueryOperation::Symbols).then_some(2),
                    (operation != LanguageQueryOperation::Symbols).then_some(16),
                );
                let started = std::time::Instant::now();
                let result = run(
                    &launch,
                    "typescript",
                    &root,
                    &root.join("file.ts"),
                    &arguments,
                    None,
                )
                .await
                .unwrap();
                match operation {
                    LanguageQueryOperation::Definition => assert!(result["result"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["path"] == "defs.ts")),
                    LanguageQueryOperation::References => {
                        assert!(result["returned"].as_u64().unwrap() >= 3)
                    }
                    LanguageQueryOperation::Hover => {
                        assert!(!result["result"]["contents"].is_null())
                    }
                    LanguageQueryOperation::Symbols => assert!(result["result"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["name"] == "answer")),
                }
                let compact = serde_json::to_string(&result).unwrap();
                let wrapper = json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":compact}],"isError":false}});
                let wrapper_bytes = serde_json::to_vec(&wrapper).unwrap().len() + 1;
                assert!(wrapper_bytes <= MAX_BRIDGE_RESULT);
                measurements.push(json!({"round":round,"operation":format!("{operation:?}"),"wallMs":started.elapsed().as_secs_f64()*1000.0,"starts":1,"initializations":1,"compactPayloadBytes":compact.len(),"finalWrapperBytes":wrapper_bytes,"returned":result["returned"],"total":result["total"]}));
            }
        }
        eprintln!(
            "LANGUAGE_QUERY_EFFICIENCY_MEASUREMENTS={}",
            json!(measurements)
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "Uses an explicitly provided retained language-server installation; no downloads or model requests"]
    async fn native_protocol_query_smoke() {
        let install = PathBuf::from(
            std::env::var_os("MYTHRA_LANGUAGE_QUERY_INSTALL_ROOT")
                .expect("set retained installation root"),
        );
        let settings: Value =
            serde_json::from_slice(&fs::read(install.join("settings.json")).unwrap()).unwrap();
        let receipt = settings["installations"]["typescript"]
            .as_str()
            .expect("installed TypeScript");
        let node = PathBuf::from(
            std::env::var_os("MYTHRA_LANGUAGE_QUERY_NODE").expect("set trusted Node executable"),
        );
        let launch = Launch {
            command: node,
            args: vec![
                install
                    .join("tools/typescript")
                    .join(receipt)
                    .join("node_modules/typescript-language-server/lib/cli.mjs")
                    .to_string_lossy()
                    .into_owned(),
                "--stdio".into(),
            ],
            extensions: vec![(".ts".into(), "typescript".into())],
            initialization_options: Some(
                json!({"tsserver":{"path":install.join("tools/typescript").join(receipt).join("node_modules/typescript/lib/tsserver.js").to_string_lossy(),"useSyntaxServer":"never"},"disableAutomaticTypingAcquisition":true}),
            ),
        };
        let root = temporary();
        let source = "import { twice } from './defs';\nconst answer = twice(21);\nconst wrong: string = answer;\n";
        fs::write(
            root.join("defs.ts"),
            "export function twice(value: number): number { return value * 2; }\n",
        )
        .unwrap();
        fs::write(root.join("use.ts"), source).unwrap();
        fs::write(
            root.join("tsconfig.json"),
            r#"{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}"#,
        )
        .unwrap();
        let mut proofs = serde_json::Map::new();
        for operation in [
            LanguageQueryOperation::Definition,
            LanguageQueryOperation::References,
            LanguageQueryOperation::Hover,
            LanguageQueryOperation::Symbols,
        ] {
            let mut arguments = query(
                operation,
                (operation != LanguageQueryOperation::Symbols).then_some(2),
                (operation != LanguageQueryOperation::Symbols).then_some(16),
            );
            arguments.path = "use.ts".into();
            let proof = run(
                &launch,
                "typescript",
                &root,
                &root.join("use.ts"),
                &arguments,
                None,
            )
            .await
            .unwrap();
            eprintln!("LANGUAGE_QUERY_{operation:?}={proof}");
            match operation {
                LanguageQueryOperation::Definition => assert!(proof["result"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|location| location["path"]
                        .as_str()
                        .unwrap_or_default()
                        .ends_with("defs.ts"))),
                LanguageQueryOperation::References => {
                    assert!(proof["result"].as_array().unwrap().len() >= 3)
                }
                LanguageQueryOperation::Hover => assert!(
                    proof["result"]["contents"].is_object()
                        || proof["result"]["contents"].is_array()
                ),
                LanguageQueryOperation::Symbols => assert!(proof["result"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|symbol| symbol["name"] == "answer")),
            }
            proofs.insert(format!("{operation:?}"), proof);
        }
        fs::write(
            root.join("query-proof.json"),
            serde_json::to_vec_pretty(&proofs).unwrap(),
        )
        .unwrap();
        eprintln!("LANGUAGE_QUERY_SMOKE_ROOT={}", root.display());
        eprintln!("{}", Value::Object(proofs));
    }
    #[tokio::test]
    #[ignore = "Uses an explicitly provided retained Bash server; no downloads or model requests"]
    async fn native_bash_query_smoke() {
        let node = PathBuf::from(
            std::env::var_os("MYTHRA_LANGUAGE_QUERY_NODE").expect("set trusted Node executable"),
        );
        let server = std::env::var("MYTHRA_LANGUAGE_QUERY_BASH_SERVER")
            .expect("set retained Bash server script");
        let launch = Launch {
            command: node,
            args: vec![server, "start".into()],
            extensions: vec![(".sh".into(), "shellscript".into())],
            initialization_options: None,
        };
        let root = temporary();
        let source = "#!/bin/bash\ngreet() { echo hello; }\ngreet\n";
        let file = root.join("fixture.sh");
        fs::write(&file, source).unwrap();
        let mut arguments = query(LanguageQueryOperation::Symbols, None, None);
        arguments.path = "fixture.sh".into();
        let proof = run(&launch, "shellscript", &root, &file, &arguments, None)
            .await
            .unwrap();
        eprintln!("LANGUAGE_BASH_QUERY_PROOF={proof}");
        assert!(proof["result"]
            .as_array()
            .unwrap()
            .iter()
            .any(|symbol| symbol["name"] == "greet"));
        fs::write(
            root.join("query-proof.json"),
            serde_json::to_vec_pretty(&proof).unwrap(),
        )
        .unwrap();
        eprintln!("LANGUAGE_BASH_QUERY_SMOKE_ROOT={}", root.display());
    }
}
