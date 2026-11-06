//! Capability-gated host folder navigation. Native tokens never cross LAN;
//! registration is a separate App-owned durable commit, not a folder dialog.
use super::{
    fs_guard::{self, Anchor},
    hostbridge, studio, Core, RemoteState,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State, WebviewWindow};
const MAX: usize = 2048;
const OWN: usize = 512;
#[derive(Clone)]
struct Folder {
    device: String,
    generation: u64,
    revision: u64,
    expires: Instant,
    root: PathBuf,
    root_file: Arc<File>,
    relative: String,
    file: Arc<File>,
    name: String,
    can_add: bool,
}
#[derive(Clone)]
struct Cursor {
    folder: String,
    after: String,
    expires: Instant,
    device: String,
    generation: u64,
    revision: u64,
}
#[derive(Default)]
pub(super) struct Registry {
    folders: HashMap<String, Folder>,
    cursors: HashMap<String, Cursor>,
}
fn failed() -> String {
    "This folder is no longer available. Open the folder list again.".into()
}
fn check(state: &RemoteState, generation: u64, device: &str, revision: u64) -> Result<(), String> {
    studio::check_scope(state, generation, device, revision, None, true)
}
pub(super) fn invalidate(core: &mut Core, device: Option<&str>) {
    core.folders
        .folders
        .retain(|_, folder| device.is_some_and(|device| folder.device != device));
    core.folders
        .cursors
        .retain(|_, cursor| device.is_some_and(|device| cursor.device != device));
}
fn sweep(registry: &mut Registry) {
    let now = Instant::now();
    registry.folders.retain(|_, folder| folder.expires > now);
    registry.cursors.retain(|_, cursor| cursor.expires > now);
}
fn remember(registry: &mut Registry, folder: Folder) -> Result<String, String> {
    sweep(registry);
    if registry.folders.len() + registry.cursors.len() >= MAX
        || registry
            .folders
            .values()
            .filter(|entry| entry.device == folder.device)
            .count()
            + registry
                .cursors
                .values()
                .filter(|entry| entry.device == folder.device)
                .count()
            >= OWN
    {
        return Err("Too many folders are open. Close this list and try again.".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    registry.folders.insert(token.clone(), folder);
    Ok(token)
}
fn lookup(
    state: &RemoteState,
    generation: u64,
    device: &str,
    revision: u64,
    token: &str,
) -> Result<Folder, String> {
    let mut core = state.inner.lock();
    sweep(&mut core.folders);
    core.folders
        .folders
        .get(token)
        .filter(|folder| {
            folder.device == device
                && folder.generation == generation
                && folder.revision == revision
        })
        .cloned()
        .ok_or_else(failed)
}
fn anchored(folder: &Folder) -> Result<Anchor, String> {
    let root = Anchor::open(&folder.root)?;
    if root.identity()? != fs_guard::identity(&folder.root_file)? {
        return Err(failed());
    }
    let selected = root.directory(&folder.relative)?;
    if selected.identity()? != fs_guard::identity(&folder.file)? {
        return Err(failed());
    }
    Ok(selected)
}
fn entry(
    parent: &Folder,
    relative: String,
    anchor: &Anchor,
    name: String,
) -> Result<Folder, String> {
    Ok(Folder {
        device: parent.device.clone(),
        generation: parent.generation,
        revision: parent.revision,
        expires: Instant::now() + Duration::from_secs(300),
        root: parent.root.clone(),
        root_file: parent.root_file.clone(),
        relative,
        file: Arc::new(anchor.retained()?),
        name,
        can_add: anchor.path.parent().is_some(),
    })
}
#[tauri::command]
pub(crate) async fn remote_folders_browse(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    folder_token: Option<String>,
    cursor: Option<String>,
    limit: usize,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| failed())?;
    check(&state, generation, &device, grant_revision)?;
    if !(1..=200).contains(&limit) {
        return Err(failed());
    }
    if folder_token.is_none() {
        if cursor.is_some() {
            return Err(failed());
        }
        let home = crate::release_qa::home_dir(&app).map_err(|_| failed())?;
        let owner = device.clone();
        let roots = studio::blocking(move || {
            let mut choices = vec![("Home".to_owned(), home)];
            #[cfg(unix)]
            choices.push(("System drive".to_owned(), PathBuf::from("/")));
            #[cfg(windows)]
            for drive in b'A'..=b'Z' {
                let path = PathBuf::from(format!("{}:\\", drive as char));
                if path.is_dir() {
                    choices.push((format!("{} drive", drive as char), path));
                }
            }
            let mut roots = Vec::new();
            for (name, path) in choices.into_iter().take(32) {
                if let Ok(anchor) = Anchor::open(&path) {
                    let file = Arc::new(anchor.retained()?);
                    roots.push(Folder {
                        device: owner.clone(),
                        generation,
                        revision: grant_revision,
                        expires: Instant::now() + Duration::from_secs(300),
                        root: anchor.path.clone(),
                        root_file: file.clone(),
                        relative: String::new(),
                        file,
                        name,
                        can_add: anchor.path.parent().is_some(),
                    });
                }
            }
            Ok(roots)
        })
        .await?;
        check(&state, generation, &device, grant_revision)?;
        let mut core = state.inner.lock();
        let mut rows = Vec::new();
        for folder in roots {
            let name = folder.name.clone();
            let can_add = folder.can_add;
            let token = remember(&mut core.folders, folder)?;
            rows.push(json!({"token":token,"name":name,"canAdd":can_add}));
        }
        return Ok(
            json!({"folder":null,"parent":null,"folders":rows,"next":null,"truncated":false}),
        );
    }
    let token = folder_token.ok_or_else(failed)?;
    let selected = lookup(&state, generation, &device, grant_revision, &token)?;
    let after = if let Some(cursor) = cursor {
        let core = state.inner.lock();
        let cursor = core
            .folders
            .cursors
            .get(&cursor)
            .filter(|entry| {
                entry.folder == token
                    && entry.device == device
                    && entry.generation == generation
                    && entry.revision == grant_revision
                    && entry.expires > Instant::now()
            })
            .ok_or_else(failed)?;
        Some(cursor.after.clone())
    } else {
        None
    };
    let (folder, parent, rows, next) = studio::blocking(move || {
        let current = anchored(&selected)?;
        let root = Anchor::open(&selected.root)?;
        let parent = if selected.relative.is_empty() {
            None
        } else {
            let relative = selected
                .relative
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or("")
                .to_owned();
            let anchor = root.directory(&relative)?;
            let name = if relative.is_empty() {
                if selected.root.parent().is_none() {
                    "System drive".into()
                } else {
                    selected
                        .root
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("Home")
                        .to_owned()
                }
            } else {
                relative.rsplit('/').next().unwrap_or("Folder").to_owned()
            };
            Some(entry(&selected, relative, &anchor, name)?)
        };
        let mut directories: Vec<_> = current
            .directories()?
            .into_iter()
            .filter(|name| after.as_ref().is_none_or(|after| name > after))
            .collect();
        let more = directories.len() > limit;
        directories.truncate(limit);
        let next = if more {
            directories.last().cloned()
        } else {
            None
        };
        let mut rows = Vec::new();
        for name in directories {
            let relative = if selected.relative.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", selected.relative, name)
            };
            let anchor = root.directory(&relative)?;
            rows.push(entry(&selected, relative, &anchor, name)?);
        }
        current.validate()?;
        Ok((selected, parent, rows, next))
    })
    .await?;
    check(&state, generation, &device, grant_revision)?;
    let mut core = state.inner.lock();
    let parent = parent
        .map(|folder| {
            let name = folder.name.clone();
            let can_add = folder.can_add;
            remember(&mut core.folders, folder)
                .map(|token| json!({"token":token,"name":name,"canAdd":can_add}))
        })
        .transpose()?;
    let mut output = Vec::new();
    for folder in rows {
        let name = folder.name.clone();
        let can_add = folder.can_add;
        let token = remember(&mut core.folders, folder)?;
        output.push(json!({"token":token,"name":name,"canAdd":can_add}));
    }
    let next = if let Some(after) = next {
        if core.folders.folders.len() + core.folders.cursors.len() >= MAX
            || core
                .folders
                .folders
                .values()
                .filter(|folder| folder.device == device)
                .count()
                + core
                    .folders
                    .cursors
                    .values()
                    .filter(|cursor| cursor.device == device)
                    .count()
                >= OWN
        {
            return Err(failed());
        }
        let next = uuid::Uuid::new_v4().to_string();
        core.folders.cursors.insert(
            next.clone(),
            Cursor {
                folder: token.clone(),
                after,
                expires: Instant::now() + Duration::from_secs(300),
                device,
                generation,
                revision: grant_revision,
            },
        );
        Some(next)
    } else {
        None
    };
    Ok(
        json!({"folder":{"token":token,"name":folder.name,"canAdd":folder.can_add},"parent":parent,"folders":output,"truncated":next.is_some(),"next":next}),
    )
}
#[tauri::command]
pub(crate) async fn remote_folders_select(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    folder_token: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| failed())?;
    check(&state, generation, &device, grant_revision)?;
    let folder = lookup(&state, generation, &device, grant_revision, &folder_token)?;
    if !folder.can_add {
        return Err("Choose a project folder, not the entire drive.".into());
    }
    let result = studio::blocking(move || {
        let selected = anchored(&folder)?;
        selected.validate()?;
        Ok(json!({"path":selected.path.to_str().ok_or_else(failed)?,"name":folder.name}))
    })
    .await?;
    check(&state, generation, &device, grant_revision)?;
    lookup(&state, generation, &device, grant_revision, &folder_token)?;
    let mut result = result;
    result["identity"] = json!(folder_token);
    result["token"] = json!(folder_token);
    Ok(result)
}
