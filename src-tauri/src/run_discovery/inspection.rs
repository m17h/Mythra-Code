//! App-owned read-only project inspection used by every discovery provider.
use super::*;
use std::io::{Seek, SeekFrom};

pub(super) const MAX_INSPECTION_ROUNDS: usize = 12;
const MAX_REQUESTS: usize = 8;
const ROUND_BYTES: usize = 16 * 1024;
const READ_BYTES: usize = 8 * 1024;
const MAX_OFFSET: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Operation {
    List,
    Read,
    Search,
    Locate,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Inspection {
    pub operation: Operation,
    pub path: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub offset: u64,
}

pub(super) fn validate(requests: &[Inspection]) -> Result<(), String> {
    if requests.len() > MAX_REQUESTS
        || requests.iter().any(|item| {
            item.path.len() > 512
                || item.path.chars().any(char::is_control)
                || item.query.len() > 200
                || item.query.chars().any(char::is_control)
                || item.offset > MAX_OFFSET
                || (item.operation == Operation::Search && item.query.trim().is_empty())
        })
    {
        return Err("The model returned an invalid project inspection request.".into());
    }
    Ok(())
}

fn omitted(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        ".venv"
            | "venv"
            | "env"
            | ".vscode"
            | ".github"
            | ".devcontainer"
            | ".gitignore"
            | ".tool-versions"
            | ".python-version"
            | ".node-version"
            | ".nvmrc"
    ) {
        return false;
    }
    is_skipped_directory(name)
        || matches!(
            lower.as_str(),
            "credentials.json"
                | "auth.json"
                | "id_rsa"
                | "id_ed25519"
                | "library"
                | "temp"
                | "obj"
                | "logs"
        )
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
}

fn project_path(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let normalized = requested.replace('\\', "/");
    let relative = Path::new(&normalized);
    if relative.is_absolute() || normalized.contains(':') {
        return Err("Use a path relative to the project folder.".into());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut path = root.clone();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(name) if !omitted(&name.to_string_lossy()) => {
                path.push(name)
            }
            _ => return Err("That path is outside the inspectable project files.".into()),
        }
        if fs::symlink_metadata(&path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Symbolic links are not followed during project inspection.".into());
        }
    }
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    if !resolved.starts_with(root) {
        return Err("That path is outside the project folder.".into());
    }
    Ok(resolved)
}

fn cancelled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Acquire) {
        Err("Run command discovery was cancelled.".into())
    } else {
        Ok(())
    }
}

fn bounded_text(path: &Path, offset: u64, bytes: usize) -> Result<(String, bool), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Choose a regular text file.".into());
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut body = Vec::new();
    file.take((bytes + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.contains(&0) {
        return Err("Binary files are not read during discovery.".into());
    }
    let more = body.len() > bytes;
    body.truncate(bytes);
    Ok((sanitize_text(&String::from_utf8_lossy(&body)), more))
}

fn entries(path: &Path, flag: &AtomicBool) -> Result<Vec<fs::DirEntry>, String> {
    cancelled(flag)?;
    let mut found = Vec::new();
    for entry in fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .take(2048)
    {
        cancelled(flag)?;
        let Ok(entry) = entry else { continue };
        if !omitted(&entry.file_name().to_string_lossy())
            && entry.file_type().is_ok_and(|kind| !kind.is_symlink())
        {
            found.push(entry);
        }
    }
    found.sort_unstable_by_key(|entry| entry.file_name());
    Ok(found)
}

fn locate_executable(name: &str, root: Option<&Path>) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 80
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || name.starts_with('.')
    {
        return Err(
            "Locate accepts only an executable name, such as python3, love or dotnet.".into(),
        );
    }
    let mut paths = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(root) = root {
        let mut project_paths = Vec::new();
        for environment in [".venv", "venv", "env"] {
            for directory in ["bin", "Scripts"] {
                let relative = format!("{environment}/{directory}");
                if let Ok(path) = project_path(root, &relative) {
                    project_paths.push(path);
                }
            }
        }
        project_paths.extend(paths);
        paths = project_paths;
    }
    #[cfg(unix)]
    paths.extend(["/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    #[cfg(target_os = "macos")]
    {
        paths.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
        for applications in [
            Some(PathBuf::from("/Applications")),
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications")),
        ]
        .into_iter()
        .flatten()
        {
            paths.push(applications.join(format!("{name}.app/Contents/MacOS")));
        }
    }
    #[cfg(windows)]
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(variable) {
            paths.push(PathBuf::from(base).join(name));
        }
    }
    let mut names = vec![name.to_string()];
    if cfg!(windows) && !name.contains('.') {
        names.extend([
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]);
    }
    let mut found = Vec::new();
    for folder in paths.into_iter().take(128) {
        for name in &names {
            let candidate = folder.join(name);
            if is_executable_file(&candidate) {
                let path = candidate.to_string_lossy().to_string();
                if !found.contains(&path) {
                    found.push(path);
                }
            }
        }
    }
    Ok(if found.is_empty() {
        format!("No installed {name} executable found in PATH or standard application locations. A bare command requires this runtime to be installed/on PATH.")
    } else {
        format!(
            "Installed executable paths (existence checked, not executed):\n{}",
            found.join("\n")
        )
    })
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn inspect_one(root: &Path, item: &Inspection, flag: &AtomicBool) -> Result<String, String> {
    cancelled(flag)?;
    if item.operation == Operation::Locate {
        return locate_executable(&item.path, Some(root));
    }
    let path = project_path(root, &item.path)?;
    match item.operation {
        Operation::Locate => unreachable!(),
        Operation::List => {
            let found = entries(&path, flag)?;
            let start = usize::try_from(item.offset).unwrap_or(usize::MAX);
            let mut result = String::new();
            for entry in found.iter().skip(start).take(128) {
                let suffix = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    "/"
                } else {
                    ""
                };
                result.push_str(&format!(
                    "{}{suffix}\n",
                    entry.file_name().to_string_lossy()
                ));
            }
            // State the scan bound even when filtering hid many entries.
            result.push_str(&format!("[Listed entries {start}..{}; at most 2048 directory entries scanned. Use list offset to continue.]\n", start.saturating_add(128).min(found.len())));
            Ok(result)
        }
        Operation::Read => {
            let (mut text, more) = bounded_text(&path, item.offset, READ_BYTES)?;
            if more {
                text.push_str(&format!(
                    "\n[More content: read this file with byte offset {}.]",
                    item.offset + READ_BYTES as u64
                ));
            }
            Ok(text)
        }
        Operation::Search => {
            let mut queue = VecDeque::from([path]);
            let query = item.query.to_lowercase();
            let mut directories = 0;
            let mut files = 0;
            let mut result = String::new();
            while let Some(path) = queue.pop_front() {
                cancelled(flag)?;
                // Recheck queued paths before traversal; a folder may have been
                // replaced since its parent was listed.
                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };
                let Ok(path) = project_path(root, &relative.to_string_lossy()) else {
                    continue;
                };
                if path.is_dir() {
                    if directories >= 32 {
                        continue;
                    }
                    directories += 1;
                    for entry in entries(&path, flag)? {
                        if queue.len() < 512 {
                            queue.push_back(entry.path());
                        }
                    }
                    continue;
                }
                if files >= 64 {
                    break;
                }
                files += 1;
                let Ok((text, _)) = bounded_text(&path, 0, 32 * 1024) else {
                    continue;
                };
                for (index, line) in text.lines().enumerate() {
                    if line.to_lowercase().contains(&query) {
                        result.push_str(&format!(
                            "{}:{}: {}\n",
                            path.strip_prefix(root).unwrap_or(&path).display(),
                            index + 1,
                            line
                        ));
                        if result.len() >= READ_BYTES {
                            break;
                        }
                    }
                }
                if result.len() >= READ_BYTES {
                    break;
                }
            }
            result.push_str("\n[Search is bounded to 32 folders, 64 files and 32 KiB per file. Narrow the path or read a file for more evidence.]");
            Ok(result)
        }
    }
}

pub(super) fn truncate(text: &mut String, limit: usize) {
    if text.len() <= limit {
        return;
    }
    let marker = "\n[Evidence truncated to the inspection byte limit.]\n";
    let mut end = limit.saturating_sub(marker.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str(marker);
}

pub(super) fn inspect(
    root: &Path,
    requests: &[Inspection],
    flag: &AtomicBool,
) -> Result<String, String> {
    validate(requests)?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut evidence = String::new();
    for item in requests {
        cancelled(flag)?;
        let mut body = match inspect_one(&root, item, flag) {
            Ok(body) => body,
            Err(error) => format!("Inspection unavailable: {error}"),
        };
        cancelled(flag)?;
        truncate(&mut body, READ_BYTES + 256);
        evidence.push_str(&format!(
            "\n--- inspection {} ---\n{body}\n",
            serde_json::to_string(item).unwrap_or_default()
        ));
        if evidence.len() >= ROUND_BYTES {
            break;
        }
    }
    truncate(&mut evidence, ROUND_BYTES);
    Ok(evidence)
}

pub(super) fn initial_context(root: &Path, flag: &AtomicBool) -> Result<String, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let listing = inspect(
        &root,
        &[Inspection {
            operation: Operation::List,
            path: ".".into(),
            query: String::new(),
            offset: 0,
        }],
        flag,
    )?;
    let metadata = collect_project_context_with_limits(
        &root,
        ScanLimits {
            context_bytes: 24 * 1024,
            ..SCAN_LIMITS
        },
        Some(flag),
    );
    cancelled(flag)?;
    // Missing documentation/manifests is a reason to investigate, not an error.
    let mut context = format!("Project root files and folders:\n{listing}\nInitial configuration/documentation (optional):\n{}", metadata.unwrap_or_else(|_| "No conventional metadata was found. Inspect the source and configuration files to determine how this project starts.".into()));
    truncate(&mut context, 32 * 1024);
    Ok(context)
}


pub(super) async fn investigate_with_purpose<F, Fut>(
    root: PathBuf,
    request: Arc<DiscoveryRequest>,
    purpose: DiscoveryPurpose,
    mut model: F,
) -> Result<RunDiscoveryResult, String>
where
    F: FnMut(Vec<Value>) -> Fut,
    Fut: Future<Output = Result<RunDiscoveryResult, String>>,
{
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let seed_root = root.clone();
    let seed_request = request.clone();
    let context =
        tokio::task::spawn_blocking(move || initial_context(&seed_root, &seed_request.cancelled))
            .await
            .map_err(|error| error.to_string())??;
    let prompt = match purpose {
        DiscoveryPurpose::Run => discovery_prompt(&context),
        DiscoveryPurpose::Checks => checks_discovery_prompt(&context),
    };
    let mut messages = vec![json!({"role":"user", "content":prompt})];
    for round in 0..=MAX_INSPECTION_ROUNDS {
        cancelled(&request.cancelled)?;
        let remaining = MAX_INSPECTION_ROUNDS - round;
        let result = model(messages.clone()).await?;
        cancelled(&request.cancelled)?;
        if result.inspect.is_empty() {
            return Ok(result);
        }
        if remaining == 0 {
            return Err("Discovery reached its project inspection limit. Try again with a more specific project folder or another model.".into());
        }
        messages.push(json!({"role":"assistant", "content":json!({
            "command":result.command, "label":result.label,
            "explanation":result.explanation, "inspect":result.inspect
        }).to_string()}));
        let inspection_root = root.clone();
        let inspection_request = request.clone();
        let evidence = tokio::task::spawn_blocking(move || {
            inspect(
                &inspection_root,
                &result.inspect,
                &inspection_request.cancelled,
            )
        })
        .await
        .map_err(|error| error.to_string())??;
        messages.push(json!({"role":"user", "content":format!(
            "UNTRUSTED INSPECTION RESULTS\n{evidence}\nInspection rounds remaining: {}. {}", remaining - 1,
            if remaining == 1 { "Return the final command now with inspect: []." } else { "Continue investigating as needed, or return the final command." }
        )}));
        // Preserve the ongoing conversation and recent evidence within a bounded
        // context. Drop complete old request/result pairs, never half a pair.
        while messages.len() > 3
            && messages
                .iter()
                .map(|message| message["content"].as_str().unwrap_or_default().len())
                .sum::<usize>()
                > MAX_CONTEXT_BYTES
        {
            messages.drain(1..3);
        }
    }
    unreachable!()
}
