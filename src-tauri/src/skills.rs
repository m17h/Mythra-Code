use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalSkillFile {
    pub(super) path: String,
    pub(super) relative_path: String,
    pub(super) file_name: String,
    pub(super) default_name: String,
    pub(super) description: String,
    pub(super) supporting_markdown_count: usize,
    pub(super) content_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillBridgeConfig {
    pub(super) source_path: String,
    pub(super) name: String,
    pub(super) enabled: bool,
}

const MAX_SKILL_FILE_BYTES: u64 = 1_048_576;
const MAX_SKILL_SCAN_DEPTH: usize = 8;
const MAX_SKILL_MARKDOWN_FILES: usize = 500;
const MAX_SKILL_MARKDOWN_BYTES: u64 = 16 * 1_048_576;

pub(super) fn canonical_skill_folder(folder: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(folder);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not open the skills folder: {error}"))?;
    if !canonical.is_dir() {
        return Err("The selected skills path is not a folder.".into());
    }
    Ok(canonical)
}

pub(super) fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")
        })
}

pub(super) fn collect_skill_candidates(
    root: &Path,
    directory: &Path,
    depth: usize,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_SKILL_SCAN_DEPTH {
        return Ok(());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not scan {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not scan {}: {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_file() && is_markdown(&path) {
            let top_level_markdown = directory == root;
            let packaged_skill = path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"));
            if top_level_markdown || packaged_skill {
                output.push(path);
            }
        } else if file_type.is_dir() {
            collect_skill_candidates(root, &path, depth + 1, output)?;
        }
    }
    Ok(())
}

pub(super) fn split_skill_markdown(content: &str) -> (Option<String>, &str) {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return (None, content);
    }
    let normalized = content.replace("\r\n", "\n");
    let Some(end) = normalized[4..].find("\n---\n").map(|index| index + 4) else {
        return (None, content);
    };
    let frontmatter = &normalized[4..end];
    let description = frontmatter.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("description") {
            return None;
        }
        let value = value.trim().trim_matches(['\'', '"']);
        (!value.is_empty()).then(|| value.to_string())
    });
    let body_offset = end + "\n---\n".len();
    let body = if content.contains("\r\n") {
        // Offset calculations above used normalized newlines. Find the second
        // delimiter in the original text instead so the returned slice is valid.
        let delimiter = "\r\n---\r\n";
        content
            .strip_prefix("---\r\n")
            .and_then(|rest| {
                rest.find(delimiter)
                    .map(|index| &rest[index + delimiter.len()..])
            })
            .unwrap_or(content)
    } else {
        content.get(body_offset..).unwrap_or(content)
    };
    (description, body)
}

pub(super) fn skill_description(content: &str, fallback: &str) -> String {
    let (declared, body) = split_skill_markdown(content);
    if let Some(description) = declared {
        return description.chars().take(240).collect();
    }
    let paragraph = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("<!--"))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    if paragraph.is_empty() {
        format!("Instructions from {fallback}")
    } else {
        paragraph.chars().take(240).collect()
    }
}

pub(super) fn skill_default_name(path: &Path) -> String {
    let is_package = path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"));
    let raw = if is_package {
        path.parent().and_then(Path::file_name)
    } else {
        path.file_stem()
    };
    normalize_skill_name(raw.and_then(|value| value.to_str()).unwrap_or("skill"))
}

pub(super) fn normalize_skill_name(value: &str) -> String {
    let mut output = String::new();
    let mut pending_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !output.is_empty() {
                output.push('-');
            }
            pending_dash = false;
            output.push(character);
        } else {
            pending_dash = true;
        }
        if output.len() >= 64 {
            break;
        }
    }
    output.trim_matches('-').to_string()
}

pub(super) fn count_markdown_references(content: &str, source: &Path, folder: &Path) -> usize {
    let source_directory = source.parent().unwrap_or(folder);
    let canonical_folder = folder
        .canonicalize()
        .unwrap_or_else(|_| folder.to_path_buf());
    let canonical_source = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    let mut remaining = content;
    let mut references = std::collections::HashSet::new();
    while let Some(start) = remaining.find("](") {
        remaining = &remaining[start + 2..];
        let Some(end) = remaining.find(')') else {
            break;
        };
        let target = remaining[..end].trim().trim_matches(['<', '>']);
        remaining = &remaining[end + 1..];
        let path_text = target.split(['#', '?']).next().unwrap_or_default().trim();
        if path_text.is_empty() || path_text.contains("://") || path_text.starts_with("mailto:") {
            continue;
        }
        let candidate = source_directory.join(path_text);
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        if candidate.starts_with(&canonical_folder)
            && candidate.is_file()
            && is_markdown(&candidate)
            && candidate != canonical_source
        {
            references.insert(candidate);
        }
    }
    references.len()
}

pub(super) fn scan_local_skills(folder: &Path) -> Result<Vec<LocalSkillFile>, String> {
    let mut candidates = Vec::new();
    collect_skill_candidates(folder, folder, 0, &mut candidates)?;
    let mut skills = Vec::new();
    for path in candidates.into_iter().take(MAX_SKILL_MARKDOWN_FILES) {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if metadata.len() > MAX_SKILL_FILE_BYTES {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill.md")
            .to_string();
        let supporting_markdown_count = count_markdown_references(&content, &path, folder);
        // This fingerprint is compared only within the running renderer; it
        // is deliberately not persisted because DefaultHasher is not a stable
        // cross-version file identity.
        let mut content_hasher = DefaultHasher::new();
        content.hash(&mut content_hasher);
        skills.push(LocalSkillFile {
            path: path.to_string_lossy().into_owned(),
            relative_path: path
                .strip_prefix(folder)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned(),
            file_name: file_name.clone(),
            default_name: skill_default_name(&path),
            description: skill_description(&content, &file_name),
            supporting_markdown_count,
            content_fingerprint: format!("{:016x}", content_hasher.finish()),
        });
    }
    skills.sort_by(|left, right| {
        left.default_name
            .cmp(&right.default_name)
            .then(left.path.cmp(&right.path))
    });
    Ok(skills)
}

pub(super) fn copy_markdown_tree(
    source_root: &Path,
    source_skill: &Path,
    destination: &Path,
    depth: usize,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    if depth > MAX_SKILL_SCAN_DEPTH
        || *count >= MAX_SKILL_MARKDOWN_FILES
        || *bytes >= MAX_SKILL_MARKDOWN_BYTES
    {
        return Ok(());
    }
    let mut entries = fs::read_dir(source_root)
        .map_err(|error| {
            format!(
                "Could not read skill references in {}: {error}",
                source_root.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Could not read skill references in {}: {error}",
                source_root.display()
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("Could not prepare skill references: {error}"))?;
            copy_markdown_tree(&path, source_skill, &target, depth + 1, count, bytes)?;
        } else if file_type.is_file() && is_markdown(&path) && path != source_skill {
            let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            if size > MAX_SKILL_FILE_BYTES
                || bytes.saturating_add(size) > MAX_SKILL_MARKDOWN_BYTES
                || *count >= MAX_SKILL_MARKDOWN_FILES
            {
                continue;
            }
            if target
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"))
            {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not prepare skill references: {error}"))?;
            }
            fs::copy(&path, &target)
                .map_err(|error| format!("Could not mirror {}: {error}", path.display()))?;
            *count += 1;
            *bytes += size;
        }
    }
    Ok(())
}

/// Serializes skill-runtime rebuilds so two concurrent syncs cannot tear
/// down each other's half-built trees.
static SKILL_SYNC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(super) fn sync_skill_runtime_at(
    runtime_root: &Path,
    folder: &Path,
    configs: Vec<SkillBridgeConfig>,
) -> Result<(), String> {
    let _guard = SKILL_SYNC_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let parent = runtime_root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "The skill runtime location is invalid.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not prepare the skill runtime folder: {error}"))?;
    let base_name = runtime_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill-runtime");
    let token = uuid::Uuid::new_v4().simple().to_string();

    // Build the complete new tree in a sibling staging directory first, then
    // swap it in via renames. A reader (or a failed sync) can therefore never
    // observe a half-built or deleted runtime.
    let staging = parent.join(format!("{base_name}.staging-{token}"));
    if let Err(error) = build_skill_runtime(&staging, folder, configs) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let trash = parent.join(format!("{base_name}.trash-{token}"));
    let had_previous = runtime_root.exists();
    if had_previous {
        if let Err(error) = fs::rename(runtime_root, &trash) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("Could not refresh the skill runtime: {error}"));
        }
    }
    if let Err(error) = fs::rename(&staging, runtime_root) {
        if had_previous {
            let _ = fs::rename(&trash, runtime_root);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Could not activate the skill runtime: {error}"));
    }
    if had_previous {
        let _ = fs::remove_dir_all(&trash);
    }
    Ok(())
}

pub(super) fn build_skill_runtime(
    runtime_root: &Path,
    folder: &Path,
    configs: Vec<SkillBridgeConfig>,
) -> Result<(), String> {
    let folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not open the skills folder: {error}"))?;
    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("Could not create the skill runtime: {error}"))?;
    fs::create_dir_all(runtime_root.join(".claude-plugin"))
        .map_err(|error| format!("Could not create the Claude skill plugin: {error}"))?;
    fs::create_dir_all(runtime_root.join("skills"))
        .map_err(|error| format!("Could not create the Claude skills directory: {error}"))?;
    fs::write(
        runtime_root.join(".claude-plugin/plugin.json"),
        r#"{"name":"openkiwi-skills","version":"1.0.0","description":"User-selected Mythra Code skills"}"#,
    )
    .map_err(|error| format!("Could not prepare the Claude skill plugin: {error}"))?;

    let mut used_names = std::collections::HashSet::new();
    for config in configs.into_iter().filter(|config| config.enabled) {
        let source = PathBuf::from(&config.source_path)
            .canonicalize()
            .map_err(|error| format!("Could not open skill {}: {error}", config.source_path))?;
        if !source.starts_with(&folder) || !source.is_file() || !is_markdown(&source) {
            return Err(format!(
                "Skill source is outside the selected folder: {}",
                config.source_path
            ));
        }
        let name = normalize_skill_name(&config.name);
        if name.is_empty() {
            return Err(format!(
                "{} does not have a valid invocation name",
                source.display()
            ));
        }
        if !used_names.insert(name.clone()) {
            return Err(format!(
                "Two enabled skills use the invocation name `{name}`"
            ));
        }

        let content = fs::read_to_string(&source)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        if content.len() as u64 > MAX_SKILL_FILE_BYTES {
            return Err(format!("{} is larger than 1 MB", source.display()));
        }
        let (declared_description, body) = split_skill_markdown(&content);
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill.md");
        let description =
            declared_description.unwrap_or_else(|| skill_description(body, file_name));
        let package = runtime_root.join(&name);
        fs::create_dir_all(&package)
            .map_err(|error| format!("Could not create skill `{name}`: {error}"))?;

        let reference_root = if file_name.eq_ignore_ascii_case("SKILL.md") {
            source.parent().unwrap_or(&folder)
        } else {
            &folder
        };
        let mut count = 0;
        let mut bytes = 0;
        copy_markdown_tree(reference_root, &source, &package, 0, &mut count, &mut bytes)?;

        let yaml_name = serde_json::to_string(&name).map_err(|error| error.to_string())?;
        let yaml_description =
            serde_json::to_string(&description.chars().take(500).collect::<String>())
                .map_err(|error| error.to_string())?;
        let bridge = format!(
            "---\nname: {yaml_name}\ndescription: {yaml_description}\n---\n\n<!-- Generated by Mythra Code from {}. Edit the source file, not this bridge. -->\n\n{}\n",
            source.display(),
            body.trim_start(),
        );
        fs::write(package.join("SKILL.md"), &bridge)
            .map_err(|error| format!("Could not prepare skill `{name}`: {error}"))?;

        let claude_package = runtime_root.join("skills").join(&name);
        fs::create_dir_all(&claude_package)
            .map_err(|error| format!("Could not create Claude skill `{name}`: {error}"))?;
        let mut claude_count = 0;
        let mut claude_bytes = 0;
        copy_markdown_tree(
            reference_root,
            &source,
            &claude_package,
            0,
            &mut claude_count,
            &mut claude_bytes,
        )?;
        fs::write(claude_package.join("SKILL.md"), &bridge)
            .map_err(|error| format!("Could not prepare Claude skill `{name}`: {error}"))?;
    }
    Ok(())
}

pub(super) fn sync_skill_runtime(
    app: &AppHandle,
    folder: &Path,
    configs: Vec<SkillBridgeConfig>,
) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?;
    let runtime_root = app_data.join("skill-runtime");
    sync_skill_runtime_at(&runtime_root, folder, configs)?;
    Ok(runtime_root)
}

#[tauri::command]
pub(super) async fn local_skills_scan(folder: String) -> Result<Vec<LocalSkillFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        scan_local_skills(&folder)
    })
    .await
    .map_err(|error| format!("Skill scan failed: {error}"))?
}

#[tauri::command]
pub(super) async fn local_skills_sync(
    app: AppHandle,
    folder: String,
    skills: Vec<SkillBridgeConfig>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        sync_skill_runtime(&app, &folder, skills).map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Skill preparation failed: {error}"))?
}

pub(super) fn available_import_path(folder: &Path, source_name: &str) -> PathBuf {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let extension = Path::new(source_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    let initial = folder.join(source_name);
    if !initial.exists() {
        return initial;
    }
    for index in 2..10_000 {
        let candidate = folder.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(format!("{stem}-imported.{extension}"))
}

#[tauri::command]
pub(super) async fn local_skills_import(
    folder: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        let mut imported = Vec::new();
        for raw in paths {
            let source = PathBuf::from(&raw)
                .canonicalize()
                .map_err(|error| format!("Could not open {raw}: {error}"))?;
            if !source.is_file() || !is_markdown(&source) {
                return Err(format!("Only Markdown files can be imported: {raw}"));
            }
            let size = fs::metadata(&source)
                .map(|metadata| metadata.len())
                .unwrap_or(MAX_SKILL_FILE_BYTES + 1);
            if size > MAX_SKILL_FILE_BYTES {
                return Err(format!("{} is larger than 1 MB", source.display()));
            }
            if source.parent().is_some_and(|parent| parent == folder) {
                imported.push(source.to_string_lossy().into_owned());
                continue;
            }
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill.md");
            let destination = available_import_path(&folder, name);
            fs::copy(&source, &destination)
                .map_err(|error| format!("Could not import {}: {error}", source.display()))?;
            imported.push(destination.to_string_lossy().into_owned());
        }
        Ok(imported)
    })
    .await
    .map_err(|error| format!("Skill import failed: {error}"))?
}

#[tauri::command]
pub(super) async fn local_skills_create(
    folder: String,
    name: String,
    instructions: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        let invocation_name = normalize_skill_name(&name);
        if invocation_name.is_empty() {
            return Err("Enter a skill name containing letters or numbers.".into());
        }
        if instructions.trim().is_empty() {
            return Err("Enter instructions for the skill.".into());
        }
        if instructions.len() as u64 > MAX_SKILL_FILE_BYTES {
            return Err("Skill instructions must be smaller than 1 MB.".into());
        }
        let destination = available_import_path(&folder, &format!("{invocation_name}.md"));
        let title = name.trim();
        let content = format!("# {title}\n\n{}\n", instructions.trim());
        fs::write(&destination, content)
            .map_err(|error| format!("Could not create the skill: {error}"))?;
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Skill creation failed: {error}"))?
}

pub(super) fn detected_local_skill_source(folder: &Path, source: &Path) -> Result<PathBuf, String> {
    let folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not open the skills folder: {error}"))?;
    let source = source
        .canonicalize()
        .map_err(|error| format!("Could not open the skill source: {error}"))?;
    if !source.starts_with(&folder) || !source.is_file() || !is_markdown(&source) {
        return Err(
            "The selected skill source is not a Markdown file in the skills folder.".into(),
        );
    }

    // Only files the scanner recognizes as actual skills may be deleted. This
    // prevents a forged renderer request from deleting arbitrary supporting
    // Markdown elsewhere in the selected tree.
    let recognized = scan_local_skills(&folder)?.into_iter().any(|skill| {
        PathBuf::from(skill.path)
            .canonicalize()
            .is_ok_and(|candidate| candidate == source)
    });
    if !recognized {
        return Err("The selected file is not a detected Mythra Code skill.".into());
    }

    Ok(source)
}

pub(super) fn read_local_skill_source(folder: &Path, source: &Path) -> Result<String, String> {
    let source = detected_local_skill_source(folder, source)?;
    let size = fs::metadata(&source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?
        .len();
    if size > MAX_SKILL_FILE_BYTES {
        return Err(format!("{} is larger than 1 MB", source.display()));
    }
    fs::read_to_string(&source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))
}

pub(super) fn update_local_skill_source(
    folder: &Path,
    source: &Path,
    content: &str,
    original: &str,
) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("Skill Markdown cannot be empty.".into());
    }
    if content.len() as u64 > MAX_SKILL_FILE_BYTES {
        return Err("Skill Markdown must be smaller than 1 MB.".into());
    }
    let source = detected_local_skill_source(folder, source)?;
    let current = fs::read_to_string(&source)
        .map_err(|error| format!("Could not read {} before saving: {error}", source.display()))?;
    if current != original {
        return Err("This skill changed on disk after you opened it. Reload it before saving so those changes are not overwritten.".into());
    }
    fs::write(&source, content)
        .map_err(|error| format!("Could not save {}: {error}", source.display()))
}

pub(super) fn delete_local_skill_source(folder: &Path, source: &Path) -> Result<(), String> {
    let source = detected_local_skill_source(folder, source)?;

    fs::remove_file(&source)
        .map_err(|error| format!("Could not delete {}: {error}", source.display()))
}

#[tauri::command]
pub(super) async fn local_skills_read(folder: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        read_local_skill_source(&folder, Path::new(&path))
    })
    .await
    .map_err(|error| format!("Skill read failed: {error}"))?
}

#[tauri::command]
pub(super) async fn local_skills_update(
    folder: String,
    path: String,
    content: String,
    original: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        update_local_skill_source(&folder, Path::new(&path), &content, &original)
    })
    .await
    .map_err(|error| format!("Skill update failed: {error}"))?
}

#[tauri::command]
pub(super) async fn local_skills_delete(folder: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        delete_local_skill_source(&folder, Path::new(&path))
    })
    .await
    .map_err(|error| format!("Skill deletion failed: {error}"))?
}
