//! Private, authoritative preference state. The registry is the sole commit point;
//! each committed revision references an immutable markdown mirror prepared first.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, State};

const MAX_REGISTRY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SCOPES: usize = 128;
const MAX_TIME: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(crate) struct PreferenceLearningState {
    lock: Mutex<()>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreferenceValue {
    enabled: bool,
    provider: String,
    model: String,
    enabled_at: Option<u64>,
    markdown: String,
    updated_at: u64,
    checkpoints: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    history_requested_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cleared_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rejected_instructions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    analysis_requests_at: Option<Vec<u64>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScopeState {
    scope_key: String,
    revision: u64,
    #[serde(flatten)]
    value: PreferenceValue,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    state: ScopeState,
    markdown_file: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u8,
    // Retained even when every project scope is forgotten. A recreated scope
    // must not reuse a revision that an old pending writer can still present.
    #[serde(default)]
    last_revision: u64,
    scopes: Vec<Entry>,
}

fn error() -> String {
    "Private preference storage could not be read or written safely. Existing preferences were kept.".into()
}
fn conflict() -> String {
    "Preference settings changed while this update was running. Reload preferences and try again."
        .into()
}
fn valid_scope(scope: &str) -> bool {
    if scope == "app" {
        return true;
    }
    let Some(id) = scope.strip_prefix("project:") else {
        return false;
    };
    !id.is_empty()
        && id.chars().count() <= 200
        && !id.contains(['/', '\\'])
        && id != "."
        && id != ".."
        && !id.chars().any(char::is_control)
        && id == id.trim()
}
fn bounded(text: &str, limit: usize) -> bool {
    text.chars().count() <= limit && !text.contains('\0')
}
fn validate_value(value: &PreferenceValue) -> Result<(), String> {
    if !matches!(
        value.provider.as_str(),
        "openai" | "claude" | "cursor" | "openrouter" | "lmstudio"
    ) || !bounded(&value.model, 160)
        || value.model.chars().any(char::is_control)
        || (value.enabled && value.enabled_at.is_none())
        || !bounded(&value.markdown, 8_000)
        || value.updated_at > MAX_TIME
        || [
            value.enabled_at,
            value.history_requested_at,
            value.cleared_at,
        ]
        .into_iter()
        .flatten()
        .any(|time| time > MAX_TIME)
        || value.checkpoints.len() > 1000
        || value.checkpoints.iter().any(|(key, checkpoint)| {
            key.is_empty() || !bounded(key, 300) || !bounded(checkpoint, 2000)
        })
        || value
            .rejected_instructions
            .as_ref()
            .is_some_and(|items| items.len() > 64 || items.iter().any(|item| !bounded(item, 400)))
        || value
            .analysis_requests_at
            .as_ref()
            .is_some_and(|items| items.len() > 12 || items.iter().any(|time| *time > MAX_TIME))
    {
        return Err("Invalid preference settings.".into());
    }
    Ok(())
}

fn safe_metadata(metadata: &fs::Metadata, directory: bool) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !directory && metadata.nlink() != 1 {
            return false;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points need not report is_symlink().
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
        && if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }
}

fn safe_file(file: &fs::File) -> Result<(), String> {
    if !safe_metadata(&file.metadata().map_err(|_| error())?, false) {
        return Err(error());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(error());
        }
        if unsafe { info.assume_init() }.nNumberOfLinks != 1 {
            return Err(error());
        }
    }
    Ok(())
}

fn safe_existing(path: &Path, directory: bool) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if safe_metadata(&metadata, directory) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        _ => Err(error()),
    }
}

fn prepare_root(app_data: &Path) -> Result<PathBuf, String> {
    // Refuse redirected parent directories as well as redirected storage files.
    for ancestor in app_data.ancestors() {
        safe_existing(ancestor, true)?;
    }
    if !safe_existing(app_data, true)? {
        fs::create_dir_all(app_data).map_err(|_| error())?;
    }
    let root = app_data.join("private-preferences");
    if !safe_existing(&root, true)? {
        fs::create_dir(&root).map_err(|_| error())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|_| error())?;
    }
    Ok(root)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    if !safe_existing(path, false)? {
        return Err(error());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A raced replacement by a FIFO must not block this native command.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| error())?;
    let metadata = file.metadata().map_err(|_| error())?;
    safe_file(&file)?;
    if metadata.len() > limit {
        return Err(error());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error())?;
    if bytes.len() as u64 > limit {
        return Err(error());
    }
    Ok(bytes)
}

fn scope_hash(scope: &str) -> String {
    format!("{:x}", Sha256::digest(scope.as_bytes()))
}
fn mirror_name(scope: &str, revision: u64) -> String {
    format!(
        "{}-{revision}-{}.md",
        scope_hash(scope),
        uuid::Uuid::new_v4()
    )
}
fn valid_mirror(entry: &Entry) -> bool {
    let prefix = format!("{}-", scope_hash(&entry.state.scope_key));
    entry
        .markdown_file
        .strip_prefix(&prefix)
        .and_then(|tail| tail.strip_suffix(".md"))
        .and_then(|tail| tail.split_once('-'))
        .is_some_and(|(revision, id)| {
            revision
                .parse::<u64>()
                .is_ok_and(|revision| revision > 0 && revision <= entry.state.revision)
                && uuid::Uuid::parse_str(id).is_ok()
        })
}

/// Delete only this store's generated regular files. Current mirrors, symlinks,
/// directories and unrelated names are always preserved. Preflight cleanup bounds
/// failed-save orphan retention before another revision can create more files.
fn prune_generated(root: &Path, registry: &Registry) -> Result<(), String> {
    let keep: HashSet<&str> = registry
        .scopes
        .iter()
        .map(|entry| entry.markdown_file.as_str())
        .collect();
    let entries = fs::read_dir(root).map_err(|_| error())?;
    for (index, item) in entries.enumerate() {
        if index >= 4096 {
            return Err(error());
        }
        let item = item.map_err(|_| error())?;
        if !item.file_type().map_err(|_| error())?.is_file() {
            continue;
        }
        let name = item.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if keep.contains(name) {
            continue;
        }
        let owned_mirror = name
            .strip_suffix(".md")
            .and_then(|name| name.split_once('-'))
            .is_some_and(|(hash, tail)| {
                hash.len() == 64
                    && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && tail.split_once('-').is_some_and(|(revision, id)| {
                        revision.parse::<u64>().is_ok() && uuid::Uuid::parse_str(id).is_ok()
                    })
            });
        let owned_temp = name
            .strip_prefix("registry-")
            .and_then(|name| name.strip_suffix(".tmp"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
        if owned_mirror || owned_temp {
            fs::remove_file(item.path()).map_err(|_| error())?;
        }
    }
    Ok(())
}

struct RegistryLock(fs::File);
impl Drop for RegistryLock {
    fn drop(&mut self) {
        // Closing our descriptor alone can leave a forked child's duplicate
        // holding the same flock until exec. Release at the transaction boundary.
        let _ = self.0.unlock();
    }
}

// Keep the inode in place permanently: unlinking a lock file could allow two
// processes to lock different inodes. OS locks release on exit, including a crash.
// Refuse contention promptly rather than blocking the app's event thread.
fn lock_registry(root: &Path) -> Result<RegistryLock, String> {
    for ancestor in root.ancestors() {
        if !safe_existing(ancestor, true)? {
            return Err(error());
        }
    }
    let path = root.join("registry.lock");
    safe_existing(&path, false)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|_| error())?;
    safe_file(&file)?;
    file.try_lock().map_err(|_| conflict())?;
    Ok(RegistryLock(file))
}

fn read_registry(root: &Path) -> Result<Registry, String> {
    let _lock = lock_registry(root)?;
    read_registry_unlocked(root)
}

fn read_registry_unlocked(root: &Path) -> Result<Registry, String> {
    let path = root.join("registry.json");
    if !safe_existing(&path, false)? {
        return Ok(Registry {
            version: 1,
            last_revision: 0,
            scopes: vec![],
        });
    }
    let mut registry: Registry =
        serde_json::from_slice(&read_bounded(&path, MAX_REGISTRY_BYTES)?).map_err(|_| error())?;
    if registry.version != 1
        || registry.scopes.len() > MAX_SCOPES
        || registry.last_revision > MAX_TIME
    {
        return Err(error());
    }
    let mut scopes = HashSet::new();
    for entry in &registry.scopes {
        if !valid_scope(&entry.state.scope_key)
            || !scopes.insert(&entry.state.scope_key)
            || entry.state.revision == 0
            || entry.state.revision > MAX_TIME
            || !valid_mirror(entry)
            || validate_value(&entry.state.value).is_err()
        {
            return Err(error());
        }
        let markdown = read_bounded(&root.join(&entry.markdown_file), 64_000)?;
        if markdown != entry.state.value.markdown.as_bytes() {
            return Err(error());
        }
        // Older registries did not store the watermark. Derive their starting
        // point without changing their current scope revisions.
        registry.last_revision = registry.last_revision.max(entry.state.revision);
    }
    Ok(registry)
}

fn write_new_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options.open(path).map_err(|_| error())?;
    safe_file(&file)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| error())
}

fn sync_directory(root: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| error())?;
    #[cfg(not(unix))]
    let _ = root; // Windows replacement uses MOVEFILE_WRITE_THROUGH below.
    Ok(())
}

#[cfg(not(windows))]
fn replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|_| error())
}
#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
fn save(
    root: &Path,
    scope_key: String,
    expected_revision: u64,
    value: PreferenceValue,
) -> Result<ScopeState, String> {
    save_with_commit(root, scope_key, expected_revision, value, replace)
}

#[cfg(test)]
fn save_with_commit(
    root: &Path,
    scope_key: String,
    expected_revision: u64,
    value: PreferenceValue,
    commit: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<ScopeState, String> {
    save_with_post_commit(
        root,
        scope_key,
        expected_revision,
        value,
        commit,
        prune_generated,
    )
}

#[cfg(test)]
fn save_with_post_commit(
    root: &Path,
    scope_key: String,
    expected_revision: u64,
    value: PreferenceValue,
    commit: impl FnOnce(&Path, &Path) -> Result<(), String>,
    post_commit: impl FnOnce(&Path, &Registry) -> Result<(), String>,
) -> Result<ScopeState, String> {
    // Test callers explicitly read a fresh creation snapshot. Production must
    // use the token captured by the renderer's earlier list operation.
    let creation_revision = read_registry(root)?.last_revision;
    save_with_snapshot(
        root,
        scope_key,
        expected_revision,
        Some(creation_revision),
        value,
        commit,
        post_commit,
    )
}

fn save_with_snapshot(
    root: &Path,
    scope_key: String,
    expected_revision: u64,
    expected_creation_revision: Option<u64>,
    value: PreferenceValue,
    commit: impl FnOnce(&Path, &Path) -> Result<(), String>,
    post_commit: impl FnOnce(&Path, &Registry) -> Result<(), String>,
) -> Result<ScopeState, String> {
    if !valid_scope(&scope_key) {
        return Err("Invalid preference scope.".into());
    }
    validate_value(&value)?;
    let _lock = lock_registry(root)?;
    let mut registry = read_registry_unlocked(root)?;
    let index = registry
        .scopes
        .iter()
        .position(|entry| entry.state.scope_key == scope_key);
    let current_revision = index.map_or(0, |index| registry.scopes[index].state.revision);
    if current_revision != expected_revision
        || (index.is_none() && expected_creation_revision != Some(registry.last_revision))
    {
        return Err(conflict());
    }
    if (index.is_none()
        && (registry.scopes.len() >= MAX_SCOPES || registry.last_revision >= MAX_TIME))
        || current_revision >= MAX_TIME
    {
        return Err(error());
    }
    prune_generated(root, &registry)?;
    let previous_mirror = index
        .filter(|index| registry.scopes[*index].state.value.markdown == value.markdown)
        .map(|index| registry.scopes[index].markdown_file.clone());
    let state = ScopeState {
        scope_key,
        revision: if index.is_none() {
            registry.last_revision + 1
        } else {
            current_revision + 1
        },
        value,
    };
    let markdown_file = previous_mirror
        .clone()
        .unwrap_or_else(|| mirror_name(&state.scope_key, state.revision));
    let mirror = root.join(&markdown_file);
    let entry = Entry {
        state: state.clone(),
        markdown_file,
    };
    match index {
        Some(index) => registry.scopes[index] = entry,
        None => registry.scopes.push(entry),
    }
    registry.last_revision = registry.last_revision.max(state.revision);
    let bytes = serde_json::to_vec(&registry).map_err(|_| error())?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(error());
    }
    // Prepare all revision data before changing the single authoritative pointer.
    // A failed commit may leave unreferenced private files, but never partial state.
    if previous_mirror.is_none() {
        write_new_private(&mirror, state.value.markdown.as_bytes())?;
    }
    let temporary = root.join(format!("registry-{}.tmp", uuid::Uuid::new_v4()));
    write_new_private(&temporary, &bytes)?;
    safe_existing(&root.join("registry.json"), false)?;
    sync_directory(root)?;
    commit(&temporary, &root.join("registry.json"))?;
    // The registry is already committed. Housekeeping must never report this as
    // a failed update: callers need the new revision to apply preferences and
    // notify correctly. A later save strictly retries orphan cleanup before
    // allocating files, bounding retention even when post-commit cleanup fails.
    finish_commit(root, &registry, sync_directory, post_commit);
    Ok(state)
}

fn forget(root: &Path, scope_key: &str, expected_revision: u64) -> Result<(), String> {
    forget_with_commit(root, scope_key, expected_revision, replace)
}

fn forget_with_commit(
    root: &Path,
    scope_key: &str,
    expected_revision: u64,
    commit: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if scope_key == "app" || !valid_scope(scope_key) {
        return Err("Only saved project preferences can be forgotten.".into());
    }
    let _lock = lock_registry(root)?;
    let mut registry = read_registry_unlocked(root)?;
    let Some(index) = registry
        .scopes
        .iter()
        .position(|entry| entry.state.scope_key == scope_key)
    else {
        return Err(conflict());
    };
    if registry.scopes[index].state.revision != expected_revision {
        return Err(conflict());
    }
    prune_generated(root, &registry)?;
    registry.scopes.remove(index);
    let bytes = serde_json::to_vec(&registry).map_err(|_| error())?;
    let temporary = root.join(format!("registry-{}.tmp", uuid::Uuid::new_v4()));
    write_new_private(&temporary, &bytes)?;
    safe_existing(&root.join("registry.json"), false)?;
    sync_directory(root)?;
    commit(&temporary, &root.join("registry.json"))?;
    // Return the committed registry result even if obsolete-mirror cleanup fails.
    // A later write retries bounded cleanup before preparing any new files.
    finish_commit(root, &registry, sync_directory, prune_generated);
    Ok(())
}

fn finish_commit(
    root: &Path,
    registry: &Registry,
    sync: impl FnOnce(&Path) -> Result<(), String>,
    prune: impl FnOnce(&Path, &Registry) -> Result<(), String>,
) {
    // If persisting the pointer change fails, a crash might restore the old
    // registry. Retain its mirror until a later operation can safely retry.
    if sync(root).is_ok() {
        let _ = prune(root, registry);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreferenceSnapshot {
    scopes: Vec<ScopeState>,
    creation_revision: u64,
}

#[tauri::command]
pub(crate) fn preference_learning_list(
    app: AppHandle,
    state: State<'_, PreferenceLearningState>,
) -> Result<PreferenceSnapshot, String> {
    let _guard = state.lock.lock().map_err(|_| error())?;
    let root = prepare_root(&crate::release_qa::app_data_dir(&app).map_err(|_| error())?)?;
    let registry = read_registry(&root)?;
    Ok(PreferenceSnapshot {
        creation_revision: registry.last_revision,
        scopes: registry
            .scopes
            .into_iter()
            .map(|entry| entry.state)
            .collect(),
    })
}

#[tauri::command]
pub(crate) fn preference_learning_save(
    app: AppHandle,
    state: State<'_, PreferenceLearningState>,
    scope_key: String,
    expected_revision: u64,
    expected_creation_revision: Option<u64>,
    value: PreferenceValue,
) -> Result<ScopeState, String> {
    let _guard = state.lock.lock().map_err(|_| error())?;
    let root = prepare_root(&crate::release_qa::app_data_dir(&app).map_err(|_| error())?)?;
    save_with_snapshot(
        &root,
        scope_key,
        expected_revision,
        expected_creation_revision,
        value,
        replace,
        prune_generated,
    )
}

#[tauri::command]
pub(crate) fn preference_learning_forget(
    app: AppHandle,
    state: State<'_, PreferenceLearningState>,
    scope_key: String,
    expected_revision: u64,
) -> Result<(), String> {
    let _guard = state.lock.lock().map_err(|_| error())?;
    let root = prepare_root(&crate::release_qa::app_data_dir(&app).map_err(|_| error())?)?;
    forget(&root, &scope_key, expected_revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("mythra-preferences-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn value() -> PreferenceValue {
        serde_json::from_value(serde_json::json!({"enabled":false,"provider":"openai","model":"","enabledAt":null,"markdown":"","updatedAt":0,"checkpoints":{}})).unwrap()
    }
    #[test]
    fn preference_registry_compare_and_swap_preserves_authoritative_mirror() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        assert!(read_registry(&root).unwrap().scopes.is_empty());
        let first = save(&root, "app".into(), 0, value()).unwrap();
        assert_eq!(first.revision, 1);
        let mut edited = value();
        edited.markdown = "Prefer concise answers.".into();
        assert!(save(&root, "app".into(), 0, edited.clone()).is_err());
        let second = save(&root, "app".into(), 1, edited).unwrap();
        assert_eq!(second.revision, 2);
        let registry = read_registry(&root).unwrap();
        assert_eq!(
            registry.scopes[0].state.value.markdown,
            "Prefer concise answers."
        );
        assert_eq!(
            fs::read_to_string(root.join(&registry.scopes[0].markdown_file)).unwrap(),
            second.value.markdown
        );
        assert!(save(&root, "project:../../outside".into(), 0, value()).is_err());
    }
    #[test]
    fn preference_registry_rejects_corruption_and_invalid_config_without_resetting() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "app".into(), 0, value()).unwrap();
        let registry = read_registry(&root).unwrap();
        fs::write(root.join(&registry.scopes[0].markdown_file), "tampered").unwrap();
        assert!(read_registry(&root).is_err());
        assert!(save(&root, "app".into(), 1, value()).is_err());
        fs::write(root.join("registry.json"), "{broken").unwrap();
        assert!(read_registry(&root).is_err());
        let mut invalid = value();
        invalid.enabled = true;
        assert!(validate_value(&invalid).is_err());
    }
    #[test]
    fn preference_registry_failed_commit_keeps_previous_revision() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "app".into(), 0, value()).unwrap();
        let registry = read_registry(&root).unwrap();
        let mut changed = value();
        changed.markdown = "Updated".into();
        // Oversized input is rejected before creating or committing revision files.
        changed
            .checkpoints
            .insert("thread".into(), "x".repeat(2001));
        assert!(save(&root, "app".into(), 1, changed).is_err());
        assert_eq!(read_registry(&root).unwrap().scopes[0].state.revision, 1);
        assert!(root.join(&registry.scopes[0].markdown_file).is_file());
        let before = fs::read(root.join("registry.json")).unwrap();
        let mut changed = value();
        changed.markdown = "New preferences".into();
        let failed = save_with_commit(
            &root,
            "app".into(),
            1,
            changed.clone(),
            |temporary, destination| {
                assert!(temporary.is_file());
                assert_eq!(fs::read(destination).unwrap(), before);
                Err("Simulated atomic replacement failure".into())
            },
        );
        assert!(failed.is_err());
        assert_eq!(read_registry(&root).unwrap().scopes[0].state.revision, 1);
        assert_eq!(fs::read(root.join("registry.json")).unwrap(), before);
        // A later successful save cleans failed-generation files first, then
        // commits exactly one new mirror, with no historical accumulation.
        save(&root, "app".into(), 1, changed).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
    }
    #[test]
    fn preference_registry_post_commit_cleanup_failure_returns_committed_state() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "app".into(), 0, value()).unwrap();
        for revision in 1..=2 {
            let mut changed = value();
            changed.markdown = format!("Preference revision {revision}");
            let committed = save_with_post_commit(
                &root,
                "app".into(),
                revision,
                changed.clone(),
                replace,
                |_, _| Err("Simulated post-commit cleanup failure".into()),
            )
            .unwrap();
            assert_eq!(committed.revision, revision + 1);
            assert_eq!(committed.value.markdown, changed.markdown);
            let restored = read_registry(&root).unwrap();
            assert_eq!(restored.scopes[0].state.revision, revision + 1);
            assert_eq!(restored.scopes[0].state.value.markdown, changed.markdown);
            // Strict preflight removes earlier obsolete files before the next
            // failed housekeeping pass, so only current + one old mirror remain.
            assert_eq!(fs::read_dir(&root).unwrap().count(), 4);
        }
        save(&root, "app".into(), 3, value()).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
    }
    #[test]
    fn preference_registry_reuses_unchanged_mirror_and_clear_prunes_only_generated_files() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        let mut enabled = value();
        enabled.enabled = true;
        enabled.enabled_at = Some(1);
        enabled.markdown = "- Prefer concise replies.".into();
        save(&root, "app".into(), 0, enabled.clone()).unwrap();
        let first_mirror = read_registry(&root).unwrap().scopes[0]
            .markdown_file
            .clone();
        save(&root, "app".into(), 1, enabled).unwrap();
        assert_eq!(
            read_registry(&root).unwrap().scopes[0].markdown_file,
            first_mirror
        );
        fs::write(root.join("user-owned.md"), "preserve").unwrap();
        save(&root, "app".into(), 2, value()).unwrap();
        assert!(!root.join(first_mirror).exists());
        assert_eq!(
            fs::read_to_string(root.join("user-owned.md")).unwrap(),
            "preserve"
        );
        let bytes = fs::read(root.join("registry.json")).unwrap();
        let restored: Registry = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored.scopes[0].state.revision, 3);
    }
    #[cfg(unix)]
    #[test]
    fn preference_registry_refuses_symlink_roots_and_mirrors() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "app".into(), 0, value()).unwrap();
        let registry = read_registry(&root).unwrap();
        let mirror = root.join(&registry.scopes[0].markdown_file);
        fs::remove_file(&mirror).unwrap();
        let unrelated = temp.0.join("outside.md");
        fs::write(&unrelated, "").unwrap();
        symlink(&unrelated, &mirror).unwrap();
        assert!(read_registry(&root).is_err());
        let other = Temp::new();
        symlink(&root, other.0.join("private-preferences")).unwrap();
        assert!(prepare_root(&other.0).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn preference_registry_releases_lock_with_an_inherited_descriptor() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        let lock = lock_registry(&root).unwrap();
        // A forked child shares this open-file description until it execs. A
        // duplicate makes that lifetime deterministic without spawning a child.
        let inherited = lock.0.try_clone().unwrap();
        assert!(lock_registry(&root).is_err());
        drop(lock);
        let next = lock_registry(&root)
            .expect("transaction releases its lock even while a child retains the descriptor");
        drop(next);
        drop(inherited);
    }
    #[test]
    fn preference_registry_respects_another_instance_lock() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "app".into(), 0, value()).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("registry.lock"))
            .unwrap();
        lock.lock().unwrap();
        let before = fs::read(root.join("registry.json")).unwrap();
        assert!(save(&root, "app".into(), 1, value()).is_err());
        assert!(read_registry(&root).is_err());
        assert_eq!(fs::read(root.join("registry.json")).unwrap(), before);
        drop(lock);
        assert_eq!(save(&root, "app".into(), 1, value()).unwrap().revision, 2);
    }
    #[test]
    fn preference_registry_refuses_hardlinked_owned_files() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "project:test".into(), 0, value()).unwrap();
        let mirror = read_registry(&root).unwrap().scopes[0]
            .markdown_file
            .clone();
        for name in [mirror.as_str(), "registry.json", "registry.lock"] {
            let outside = temp.0.join("outside");
            fs::hard_link(root.join(name), &outside).unwrap();
            let before = fs::read(root.join("registry.json")).unwrap();
            assert!(read_registry(&root).is_err(), "{name}");
            assert!(
                save(&root, "project:test".into(), 1, value()).is_err(),
                "{name}"
            );
            assert!(forget(&root, "project:test", 1).is_err(), "{name}");
            assert_eq!(fs::read(root.join("registry.json")).unwrap(), before);
            fs::remove_file(outside).unwrap();
        }
    }
    #[cfg(windows)]
    #[test]
    fn preference_registry_refuses_junction_roots() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "project:test".into(), 0, value()).unwrap();
        let other = Temp::new();
        let redirected = other.0.join("private-preferences");
        let status = crate::process_launch::background_std_command("cmd.exe")
            .args(["/c", "mklink", "/j"])
            .arg(&redirected)
            .arg(&root)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(prepare_root(&other.0).is_err());
        assert!(read_registry(&redirected).is_err());
        assert!(save(&redirected, "project:test".into(), 1, value()).is_err());
        assert!(forget(&redirected, "project:test", 1).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn preference_registry_refuses_root_redirected_after_preparation() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "app".into(), 0, value()).unwrap();
        let original = temp.0.join("original");
        fs::rename(&root, &original).unwrap();
        symlink(&original, &root).unwrap();
        let before = fs::read(original.join("registry.json")).unwrap();
        assert!(read_registry(&root).is_err());
        assert!(save(&root, "app".into(), 1, value()).is_err());
        assert!(forget(&root, "project:missing", 1).is_err());
        assert_eq!(fs::read(original.join("registry.json")).unwrap(), before);
    }
    #[test]
    fn preference_forget_requires_project_cas_and_preserves_failed_commit() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        let app = save(&root, "app".into(), 0, value()).unwrap();
        let project = save(&root, "project:removed".into(), 0, value()).unwrap();
        let before = fs::read(root.join("registry.json")).unwrap();
        assert!(forget(&root, "app", app.revision).is_err());
        assert!(forget(&root, "project:removed", project.revision - 1).is_err());
        assert!(forget(&root, "project:missing", 0).is_err());
        assert!(
            forget_with_commit(&root, "project:removed", project.revision, |_, _| {
                Err("Simulated replacement failure".into())
            })
            .is_err()
        );
        assert_eq!(fs::read(root.join("registry.json")).unwrap(), before);
        let mirror = read_registry(&root).unwrap().scopes[1]
            .markdown_file
            .clone();
        fs::write(root.join("user-owned.md"), "preserve").unwrap();
        forget(&root, "project:removed", project.revision).unwrap();
        assert!(!root.join(mirror).exists());
        assert_eq!(
            fs::read_to_string(root.join("user-owned.md")).unwrap(),
            "preserve"
        );
        assert_eq!(
            read_registry(&root).unwrap().scopes[0].state.revision,
            app.revision
        );
    }
    #[test]
    fn preference_forget_releases_capacity_without_reusing_revision_after_empty_registry() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        let first = save(&root, "project:0".into(), 0, value()).unwrap();
        for index in 1..MAX_SCOPES {
            save(&root, format!("project:{index}"), 0, value()).unwrap();
        }
        assert!(save(&root, "project:new".into(), 0, value()).is_err());
        forget(&root, "project:0", first.revision).unwrap();
        let recreated = save(&root, "project:0".into(), 0, value()).unwrap();
        assert!(recreated.revision > MAX_SCOPES as u64);
        assert!(save(&root, "project:0".into(), first.revision, value()).is_err());
        for entry in read_registry(&root).unwrap().scopes {
            forget(&root, &entry.state.scope_key, entry.state.revision).unwrap();
        }
        assert!(read_registry(&root).unwrap().scopes.is_empty());
        let after_empty = save(&root, "project:0".into(), 0, value()).unwrap();
        assert!(after_empty.revision > recreated.revision);
        assert!(save(&root, "project:0".into(), recreated.revision, value()).is_err());
    }
    #[test]
    fn preference_registry_rejects_stale_absence_after_create_and_forget() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        let captured = read_registry(&root).unwrap().last_revision;
        let first = save(&root, "project:removed".into(), 0, value()).unwrap();
        forget(&root, "project:removed", first.revision).unwrap();
        assert!(save_with_snapshot(
            &root,
            "project:removed".into(),
            0,
            Some(captured),
            value(),
            replace,
            prune_generated
        )
        .is_err());
        assert!(read_registry(&root).unwrap().scopes.is_empty());
        let fresh = read_registry(&root).unwrap().last_revision;
        let recreated = save_with_snapshot(
            &root,
            "project:removed".into(),
            0,
            Some(fresh),
            value(),
            replace,
            prune_generated,
        )
        .unwrap();
        assert!(recreated.revision > first.revision);
    }
    #[test]
    fn preference_registry_upgrade_derives_highwater_from_existing_states() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "project:first".into(), 0, value()).unwrap();
        let saved = save(&root, "project:first".into(), 1, value()).unwrap();
        let path = root.join("registry.json");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("last_revision");
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let next = save(&root, "project:next".into(), 0, value()).unwrap();
        assert!(next.revision > saved.revision);
        forget(&root, "project:first", saved.revision).unwrap();
        forget(&root, "project:next", next.revision).unwrap();
        let after_empty = save(&root, "project:first".into(), 0, value()).unwrap();
        assert!(after_empty.revision > next.revision);
    }
    #[test]
    fn preference_registry_failed_postrename_sync_keeps_recovery_mirror() {
        let temp = Temp::new();
        let root = prepare_root(&temp.0).unwrap();
        save(&root, "app".into(), 0, value()).unwrap();
        let old_mirror = read_registry(&root).unwrap().scopes[0]
            .markdown_file
            .clone();
        let mut changed = value();
        changed.markdown = "Updated preferences".into();
        let committed = save_with_post_commit(
            &root,
            "app".into(),
            1,
            changed,
            replace,
            |root, registry| {
                finish_commit(
                    root,
                    registry,
                    |_| Err("Simulated sync failure".into()),
                    prune_generated,
                );
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(committed.revision, 2);
        assert!(root.join(&old_mirror).is_file());
        assert_eq!(read_registry(&root).unwrap().scopes[0].state.revision, 2);
        save(&root, "app".into(), 2, value()).unwrap();
        assert!(!root.join(&old_mirror).exists());
    }
}
