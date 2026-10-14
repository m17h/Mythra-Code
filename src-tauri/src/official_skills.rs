//! Reviewed, immutable public skill packages. Downloading never runs package code.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

const RECEIPT: &str = ".mythra-official-skill.json";
const MAX_FILES: usize = 1_200;
const MAX_FILE_BYTES: u64 = 8 * 1_048_576;
const MAX_PACKAGE_BYTES: u64 = 48 * 1_048_576;
const MAX_RECEIPT_BYTES: u64 = 512 * 1_024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageFile {
    path: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    executable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OfficialSkillCatalogEntry {
    id: String,
    publisher: String,
    title: String,
    description: String,
    repository: String,
    path: String,
    revision: String,
    license: String,
    notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    requirements: Option<String>,
    #[serde(skip_serializing)]
    files: Vec<PackageFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OfficialSkillSource {
    catalog_id: String,
    publisher: String,
    repository: String,
    url: String,
    revision: String,
    license: String,
    pub(super) modified: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema: u32,
    catalog_id: String,
    publisher: String,
    repository: String,
    path: String,
    revision: String,
    files: Vec<PackageFile>,
}

fn catalog() -> Result<Vec<OfficialSkillCatalogEntry>, String> {
    static CATALOG: OnceLock<Result<Vec<OfficialSkillCatalogEntry>, String>> = OnceLock::new();
    CATALOG.get_or_init(load_catalog).clone()
}

fn known_catalog() -> Result<Vec<OfficialSkillCatalogEntry>, String> {
    static KNOWN: OnceLock<Result<Vec<OfficialSkillCatalogEntry>, String>> = OnceLock::new();
    KNOWN
        .get_or_init(|| {
            let mut entries = catalog()?;
            let history: Vec<OfficialSkillCatalogEntry> =
                serde_json::from_str(include_str!("official-skills-catalog-history.json"))
                    .map_err(|e| e.to_string())?;
            for entry in &history {
                validate_entry(entry)?;
            }
            entries.extend(history);
            Ok(entries)
        })
        .clone()
}

fn load_catalog() -> Result<Vec<OfficialSkillCatalogEntry>, String> {
    let entries: Vec<OfficialSkillCatalogEntry> =
        serde_json::from_str(include_str!("official-skills-catalog.json"))
            .map_err(|error| format!("Could not load the official skills catalog: {error}"))?;
    let mut ids = HashSet::new();
    for entry in &entries {
        validate_entry(entry)?;
        if !ids.insert(&entry.id) {
            return Err("Duplicate official skill catalog ID.".into());
        }
    }
    Ok(entries)
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 512 || value.split('/').count() > 8 {
        return Err("Invalid official package path.".into());
    }
    for part in value.split('/') {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.starts_with('.')
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:< >\"|?*%#".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err(format!("Unsafe official package path: {value}"));
        }
    }
    Ok(PathBuf::from(value))
}

fn validate_entry(entry: &OfficialSkillCatalogEntry) -> Result<(), String> {
    if entry
        .requirements
        .as_ref()
        .is_some_and(|text| text.trim().is_empty() || text.len() > 2_000)
    {
        return Err("Invalid official skill requirements metadata.".into());
    }
    if !matches!(
        (entry.publisher.as_str(), entry.repository.as_str()),
        ("anthropic", "anthropics/skills")
            | ("openai", "openai/skills")
            | ("openai", "openai/plugins")
    ) {
        return Err("Official skill repository is not allowlisted.".into());
    }
    if entry.id.is_empty()
        || entry.id.len() > 80
        || !entry
            .id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || entry.revision.len() != 40
        || !entry.revision.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Official skill identity must have an immutable commit revision.".into());
    }
    // Repository paths may contain a single leading dot (OpenAI's .curated).
    safe_relative(
        &entry
            .path
            .replace("/.curated/", "/curated/")
            .replace("/.experimental/", "/experimental/"),
    )?;
    if entry.files.is_empty() || entry.files.len() > MAX_FILES {
        return Err("Official package file-count limit exceeded.".into());
    }
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for file in &entry.files {
        safe_relative(&file.path)?;
        if !paths.insert(file.path.to_ascii_lowercase())
            || file.size > MAX_FILE_BYTES
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Invalid official package file manifest.".into());
        }
        total = total.saturating_add(file.size);
        if total > MAX_PACKAGE_BYTES {
            return Err("Official package byte limit exceeded.".into());
        }
    }
    if !entry.files.iter().any(|file| file.path == "SKILL.md") {
        return Err("Official package has no SKILL.md.".into());
    }
    for file in &entry.files {
        for ancestor in Path::new(&file.path)
            .ancestors()
            .skip(1)
            .filter(|p| !p.as_os_str().is_empty())
        {
            if paths.contains(&ancestor.to_string_lossy().to_ascii_lowercase()) {
                return Err("Official package file/directory collision.".into());
            }
        }
    }
    Ok(())
}

fn redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn regular_tree_path(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Official skill path escapes its package.".to_string())?;
    let mut cursor = root.to_path_buf();
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            cursor.push(part);
        }
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|error| format!("Could not inspect {}: {error}", cursor.display()))?;
        if redirected(&metadata) {
            return Err(format!(
                "Official skill path contains a symbolic link or reparse point: {}",
                cursor.display()
            ));
        }
    }
    if path.canonicalize().map_err(|e| e.to_string())? != path {
        return Err("Official skill path changed while it was inspected.".into());
    }
    Ok(())
}

fn read_regular(root: &Path, path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    let _parents = windows_lock_parents(root, path, false)?;
    regular_tree_path(root, path)?;
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > limit {
        return Err(format!(
            "Official skill file exceeds its size limit: {}",
            path.display()
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    #[cfg(unix)]
    let file = {
        use std::os::fd::{AsRawFd, FromRawFd};
        let (parent, leaf) = unix_parent(root, path, false)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        unsafe { fs::File::from_raw_fd(fd) }
    };
    #[cfg(not(unix))]
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if redirected(&opened) || !opened.is_file() || !same_identity(&before, &opened) {
        return Err("Official skill file changed while opening.".into());
    }
    #[cfg(windows)]
    if windows_identity(&file)? != windows_path_identity(path)? {
        return Err("Official skill file changed while opening.".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Official skill file grew beyond its size limit.".into());
    }
    regular_tree_path(root, path)?;
    Ok(bytes)
}

fn same_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        left.creation_time() == right.creation_time()
            && left.file_attributes() == right.file_attributes()
    }
    #[cfg(not(any(unix, windows)))]
    {
        left.created().ok() == right.created().ok()
    }
}

fn matching_receipt(root: &Path) -> Option<OfficialSkillCatalogEntry> {
    let receipt: Receipt =
        serde_json::from_slice(&read_regular(root, &root.join(RECEIPT), MAX_RECEIPT_BYTES).ok()?)
            .ok()?;
    matching_receipt_from(receipt, &known_catalog().ok()?)
}

fn matching_receipt_from(
    receipt: Receipt,
    entries: &[OfficialSkillCatalogEntry],
) -> Option<OfficialSkillCatalogEntry> {
    let files = receipt
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<std::collections::HashMap<_, _>>();
    if files.len() != receipt.files.len() {
        return None;
    }
    entries
        .iter()
        .find(|entry| {
            receipt.schema == 1
                && receipt.catalog_id == entry.id
                && receipt.publisher == entry.publisher
                && receipt.repository == entry.repository
                && receipt.path == entry.path
                && receipt.revision == entry.revision
                && files.len() == entry.files.len()
                && entry
                    .files
                    .iter()
                    .all(|file| files.get(file.path.as_str()) == Some(&file))
        })
        .cloned()
}

fn package_for_source(
    folder: &Path,
    source: &Path,
) -> Option<(PathBuf, OfficialSkillCatalogEntry)> {
    for parent in source
        .ancestors()
        .skip(1)
        .take_while(|path| path.starts_with(folder))
    {
        if let Some(entry) = matching_receipt(parent) {
            return Some((parent.to_path_buf(), entry));
        }
    }
    None
}

fn unexpected_entries(
    root: &Path,
    directory: &Path,
    allowed: &HashSet<PathBuf>,
    remaining: &mut usize,
) -> Result<bool, String> {
    for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
        if *remaining == 0 {
            return Ok(true);
        }
        *remaining -= 1;
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if redirected(&metadata) {
            return Ok(true);
        }
        if path == root.join(RECEIPT) {
            continue;
        }
        // Finder and normal Python imports may create inert local metadata.
        // These files are never mirrored or accepted as package resources.
        if metadata.is_file() && item.file_name() == ".DS_Store" {
            continue;
        }
        if metadata.is_dir() && item.file_name() == "__pycache__" {
            for cache in fs::read_dir(&path).map_err(|e| e.to_string())? {
                if *remaining == 0 {
                    return Ok(true);
                }
                *remaining -= 1;
                let cache = cache.map_err(|e| e.to_string())?;
                let metadata = fs::symlink_metadata(cache.path()).map_err(|e| e.to_string())?;
                if redirected(&metadata)
                    || !metadata.is_file()
                    || cache
                        .path()
                        .extension()
                        .is_none_or(|extension| extension != "pyc")
                {
                    return Ok(true);
                }
            }
            continue;
        }
        if metadata.is_dir() {
            if !allowed.iter().any(|file| file.starts_with(&path))
                || unexpected_entries(root, &path, allowed, remaining)?
            {
                return Ok(true);
            }
        } else if !metadata.is_file() || !allowed.contains(&path) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn package_modified(root: &Path, entry: &OfficialSkillCatalogEntry) -> bool {
    for file in &entry.files {
        let Ok(bytes) = read_regular(root, &root.join(&file.path), file.size) else {
            return true;
        };
        if bytes.len() as u64 != file.size || format!("{:x}", Sha256::digest(&bytes)) != file.sha256
        {
            return true;
        }
    }
    let allowed = entry
        .files
        .iter()
        .map(|file| root.join(&file.path))
        .collect();
    unexpected_entries(root, root, &allowed, &mut (MAX_FILES * 9)).unwrap_or(true)
}

pub(super) fn source_for_skill(folder: &Path, source: &Path) -> Option<OfficialSkillSource> {
    let (root, entry) = package_for_source(folder, source)?;
    let modified = package_modified(&root, &entry);
    Some(OfficialSkillSource {
        catalog_id: entry.id,
        publisher: entry.publisher,
        repository: entry.repository.clone(),
        url: format!(
            "https://github.com/{}/tree/{}/{}",
            entry.repository, entry.revision, entry.path
        ),
        revision: entry.revision.clone(),
        license: entry.license.clone(),
        modified,
    })
}

pub(super) fn ensure_editable(folder: &Path, source: &Path) -> Result<(), String> {
    // Presence alone restricts edits, but never confers official attribution or resource authority.
    for parent in source
        .ancestors()
        .skip(1)
        .take_while(|path| path.starts_with(folder))
    {
        if fs::symlink_metadata(parent.join(RECEIPT)).is_ok() {
            return Err("Publisher skills are read-only. Create a custom skill to edit your own instructions.".into());
        }
        if parent == folder {
            break;
        }
    }
    Ok(())
}

pub(super) fn verify_invoked_source(
    folder: &Path,
    source: &Path,
    instructions: &str,
) -> Result<(), String> {
    let Some((root, entry)) = package_for_source(folder, source) else {
        if ensure_editable(folder, source).is_err() {
            return Err("This publisher skill's installation receipt is invalid. Install an original copy before using it.".into());
        }
        return Ok(());
    };
    let relative = source
        .strip_prefix(&root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let spec = entry.files.iter().find(|file| file.path == relative).ok_or_else(|| "This file was added to a publisher skill package. Install an original copy before using it.".to_string())?;
    verify_download(spec, instructions.as_bytes()).map_err(|_| {
        "This publisher skill has changed on disk. Install an original copy before using it."
            .to_string()
    })?;
    if package_modified(&root, &entry) {
        return Err(
            "This publisher skill has changed on disk. Install an original copy before using it."
                .into(),
        );
    }
    Ok(())
}

pub(super) fn package_fingerprint(folder: &Path, source: &Path) -> Option<String> {
    let (root, entry) = package_for_source(folder, source)?;
    let mut hash = Sha256::new();
    for file in &entry.files {
        hash.update(file.path.as_bytes());
        match read_regular(&root, &root.join(&file.path), MAX_FILE_BYTES) {
            Ok(bytes) => hash.update(Sha256::digest(&bytes)),
            Err(error) => hash.update(error.as_bytes()),
        }
    }
    Some(format!("{:x}", hash.finalize()))
}

pub(super) fn copy_official_support(
    folder: &Path,
    source: &Path,
    destination: &Path,
) -> Result<bool, String> {
    let Some((root, entry)) = package_for_source(folder, source) else {
        return Ok(false);
    };
    if package_modified(&root, &entry) {
        return Err("This publisher skill has changed on disk. Reinstall its original package before using it.".into());
    }
    for file in &entry.files {
        if file.path == "SKILL.md" {
            continue;
        }
        let bytes = read_regular(&root, &root.join(&file.path), file.size)?;
        if format!("{:x}", Sha256::digest(&bytes)) != file.sha256 {
            return Err("Publisher skill changed during runtime sync.".into());
        }
        write_package_file(destination, file, &bytes)?;
    }
    Ok(true)
}

pub(super) fn copy_official_snapshot(
    folder: &Path,
    source: &Path,
    snapshot: &Path,
    destination: &Path,
) -> Result<(), String> {
    let (_, entry) = package_for_source(folder, source)
        .ok_or_else(|| "Publisher skill identity changed during runtime sync.".to_string())?;
    for file in &entry.files {
        if file.path == "SKILL.md" {
            continue;
        }
        let bytes = read_regular(snapshot, &snapshot.join(&file.path), file.size)?;
        verify_download(file, &bytes)?;
        write_package_file(destination, file, &bytes)?;
    }
    Ok(())
}

fn write_package_file(root: &Path, spec: &PackageFile, bytes: &[u8]) -> Result<(), String> {
    let target = root.join(safe_relative(&spec.path)?);
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        let (parent, leaf) = unix_parent(root, &target, true)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                if spec.executable { 0o700 } else { 0o600 },
            )
        };
        if fd < 0 {
            return Err(format!(
                "Could not save {}: {}",
                spec.path,
                std::io::Error::last_os_error()
            ));
        }
        let mut file = unsafe { fs::File::from_raw_fd(fd) };
        file.write_all(bytes).map_err(|e| e.to_string())?;
        regular_tree_path(root, &target)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        let _parents = windows_lock_parents(root, &target, true)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            regular_tree_path(root, parent)?;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        options
            .open(&target)
            .and_then(|mut file| file.write_all(bytes))
            .map_err(|error| format!("Could not save {}: {error}", spec.path))
    }
}

#[cfg(windows)]
fn windows_directory(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .custom_flags(0x0220_0000)
        .open(path)
        .map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if redirected(&metadata) || !metadata.is_dir() {
        return Err("Official skill directory is a reparse point or not a folder.".into());
    }
    Ok(file)
}

#[cfg(windows)]
pub(super) fn canonical_runtime_directory(root: &Path) -> Result<(PathBuf, fs::File), String> {
    // Keep the original directory open without following reparse points or
    // allowing replacement while its canonical spelling is used by the builder.
    let directory = windows_directory(root)?;
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    if windows_identity(&directory)? != windows_path_identity(&canonical)? {
        return Err("The skill runtime directory changed while opening.".into());
    }
    Ok((canonical, directory))
}

#[cfg(windows)]
fn windows_lock_parents(root: &Path, target: &Path, create: bool) -> Result<Vec<fs::File>, String> {
    let relative = target
        .parent()
        .ok_or_else(|| "Missing package parent.".to_string())?
        .strip_prefix(root)
        .map_err(|e| e.to_string())?;
    let mut held = vec![windows_directory(root)?];
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err("Invalid package path component.".into());
        }
        cursor.push(part);
        if create {
            match fs::create_dir(&cursor) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        held.push(windows_directory(&cursor)?);
    }
    regular_tree_path(root, target.parent().unwrap())?;
    Ok(held)
}

#[cfg(windows)]
fn windows_identity(file: &fs::File) -> Result<(u32, u32, u32), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

#[cfg(windows)]
fn windows_path_identity(path: &Path) -> Result<(u32, u32, u32), String> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(0x0220_0000)
        .open(path)
        .map_err(|e| e.to_string())?;
    windows_identity(&file)
}

#[cfg(unix)]
fn unix_parent(
    root: &Path,
    path: &Path,
    create: bool,
) -> Result<(fs::File, std::ffi::CString), String> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    };
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Official skill path escapes its package.".to_string())?;
    let mut components = relative.components().collect::<Vec<_>>();
    let leaf = components
        .pop()
        .ok_or_else(|| "Missing official skill file name.".to_string())?;
    let leaf = CString::new(leaf.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut parent = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|e| e.to_string())?;
    for component in components {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Invalid package path component.".into());
        }
        let name = CString::new(component.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        if create {
            let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
            if result != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        parent = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok((parent, leaf))
}

fn raw_url(entry: &OfficialSkillCatalogEntry, file: &PackageFile) -> String {
    format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        entry.repository, entry.revision, entry.path, file.path
    )
}

async fn download_file(
    client: &reqwest::Client,
    url: &str,
    spec: &PackageFile,
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not download {}: {error}", spec.path))?;
    if !response.status().is_success() || response.url().as_str() != url {
        return Err(format!(
            "Publisher download failed for {} ({}).",
            spec.path,
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != spec.size)
    {
        return Err(format!(
            "Publisher download size does not match {}.",
            spec.path
        ));
    }
    let mut bytes = Vec::with_capacity(spec.size as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not download {}: {error}", spec.path))?
    {
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > spec.size {
            return Err(format!(
                "Publisher download exceeds the size of {}.",
                spec.path
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    verify_download(spec, &bytes)?;
    Ok(bytes)
}

fn verify_download(file: &PackageFile, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != file.size || format!("{:x}", Sha256::digest(bytes)) != file.sha256 {
        return Err(format!(
            "Publisher download integrity check failed for {}.",
            file.path
        ));
    }
    Ok(())
}

struct Staging {
    folder: PathBuf,
    folder_identity: fs::Metadata,
    path: PathBuf,
    identity: fs::Metadata,
    published: bool,
    #[cfg(unix)]
    folder_handle: fs::File,
    #[cfg(windows)]
    folder_handle: fs::File,
    #[cfg(windows)]
    stage_file_identity: (u32, u32, u32),
}

impl Staging {
    fn new(folder: &Path) -> Result<Self, String> {
        regular_tree_path(folder, folder)?;
        let folder_identity = fs::symlink_metadata(folder).map_err(|e| e.to_string())?;
        let path = folder.join(format!(".mythra-skill-install-{}", uuid::Uuid::new_v4()));
        #[cfg(windows)]
        let folder_handle = windows_directory(folder)?;
        #[cfg(unix)]
        let folder_handle = {
            use std::{
                ffi::CString,
                os::{
                    fd::AsRawFd,
                    unix::{ffi::OsStrExt, fs::OpenOptionsExt},
                },
            };
            let handle = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(folder)
                .map_err(|e| e.to_string())?;
            if !same_identity(
                &folder_identity,
                &handle.metadata().map_err(|e| e.to_string())?,
            ) {
                return Err("Skills folder changed while preparing installation.".into());
            }
            let name =
                CString::new(path.file_name().unwrap().as_bytes()).map_err(|e| e.to_string())?;
            if unsafe { libc::mkdirat(handle.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            handle
        };
        #[cfg(not(unix))]
        {
            let builder = fs::DirBuilder::new();
            builder
                .create(&path)
                .map_err(|e| format!("Could not prepare publisher download: {e}"))?;
        }
        let identity = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let stage_file_identity = windows_path_identity(&path)?;
        Ok(Self {
            folder: folder.to_path_buf(),
            folder_identity,
            path,
            identity,
            published: false,
            #[cfg(any(unix, windows))]
            folder_handle,
            #[cfg(windows)]
            stage_file_identity,
        })
    }
    fn validate(&self) -> Result<(), String> {
        regular_tree_path(&self.folder, &self.path)?;
        if !same_identity(
            &self.folder_identity,
            &fs::symlink_metadata(&self.folder).map_err(|e| e.to_string())?,
        ) || !same_identity(
            &self.identity,
            &fs::symlink_metadata(&self.path).map_err(|e| e.to_string())?,
        ) {
            return Err("The selected skills folder changed during installation.".into());
        }
        #[cfg(windows)]
        if windows_identity(&self.folder_handle)? != windows_path_identity(&self.folder)?
            || self.stage_file_identity != windows_path_identity(&self.path)?
        {
            return Err("The selected skills folder changed during installation.".into());
        }
        Ok(())
    }
    fn publish(&mut self, entry: &OfficialSkillCatalogEntry) -> Result<PathBuf, String> {
        self.validate()?;
        for index in 0..100 {
            let suffix = if index == 0 {
                String::new()
            } else {
                format!("-{}", index + 1)
            };
            let leaf = if entry.id.starts_with(&format!("{}-", entry.publisher)) {
                entry.id.clone()
            } else {
                format!("{}-{}", entry.publisher, entry.id)
            };
            let destination = self.folder.join(format!("{leaf}{suffix}"));
            self.validate()?;
            #[cfg(unix)]
            let published = rename_no_replace_at(&self.folder_handle, &self.path, &destination);
            #[cfg(not(unix))]
            let published = rename_no_replace(&self.path, &destination);
            match published {
                Ok(()) => {
                    self.published = true;
                    return Ok(destination.join("SKILL.md"));
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists
                        || fs::symlink_metadata(&destination).is_ok() =>
                {
                    continue
                }
                Err(error) => {
                    return Err(format!("Could not install the publisher skill: {error}"))
                }
            }
        }
        Err("Too many publisher skill packages share this name.".into())
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.published && self.validate().is_ok() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(unix)]
fn rename_no_replace_at(
    parent: &fs::File,
    source: &Path,
    destination: &Path,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
        };
        let source = CString::new(source.file_name().unwrap().as_bytes())?;
        let destination = CString::new(destination.file_name().unwrap().as_bytes())?;
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Atomic skill installation is unavailable on this platform.",
        ));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

#[cfg(not(unix))]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let source = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // std::fs::rename uses replacement semantics on Windows too. MoveFileW
        // refuses every existing destination, including an empty directory.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileW(
                source.as_ptr(),
                destination.as_ptr(),
            )
        } != 0
        {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(windows))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Atomic skill installation is unavailable on this platform.",
        ))
    }
}

#[tauri::command]
pub(super) async fn local_skills_catalog() -> Result<Vec<OfficialSkillCatalogEntry>, String> {
    catalog()
}

#[tauri::command]
pub(super) async fn local_skills_install_official(
    folder: String,
    id: String,
) -> Result<String, String> {
    static INSTALLS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = INSTALLS
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .try_lock()
        .map_err(|_| "Another publisher skill is installing. Wait for it to finish.".to_string())?;
    let entry = catalog()?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "This publisher skill is not in the reviewed catalog.".to_string())?;
    let folder = crate::skills::canonical_skill_folder(&folder)?;
    let mut staging = Staging::new(&folder)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Mythra-Code official skills installer")
        .build()
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(180), async {
        for file in &entry.files {
            let bytes = download_file(&client, &raw_url(&entry, file), file).await?;
            staging.validate()?;
            write_package_file(&staging.path, file, &bytes)?;
        }
        let receipt = Receipt {
            schema: 1,
            catalog_id: entry.id.clone(),
            publisher: entry.publisher.clone(),
            repository: entry.repository.clone(),
            path: entry.path.clone(),
            revision: entry.revision.clone(),
            files: entry.files.clone(),
        };
        staging.validate()?;
        let bytes = serde_json::to_vec(&receipt).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_RECEIPT_BYTES {
            return Err("Publisher installation receipt exceeds its size limit.".into());
        }
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let (parent, leaf) = unix_parent(&staging.path, &staging.path.join(RECEIPT), false)?;
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    leaf.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut file = unsafe { fs::File::from_raw_fd(fd) };
            file.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        {
            #[cfg(windows)]
            let _parents = windows_lock_parents(&staging.path, &staging.path.join(RECEIPT), false)?;
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            options
                .open(staging.path.join(RECEIPT))
                .and_then(|mut file| file.write_all(&bytes))
                .map_err(|e| e.to_string())?;
        }
        if package_modified(&staging.path, &entry) {
            return Err("Publisher package changed before installation finished.".into());
        }
        Ok::<_, String>(staging.publish(&entry)?.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Publisher download timed out. Please try again.".to_string())?
}
