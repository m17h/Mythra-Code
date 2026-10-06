//! Explicit, credential-free native package QA. Never infer QA from HOME or
//! silently fall back to a production profile when validation fails.

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Manager, WebviewWindow};
use uuid::Uuid;

pub(crate) const RELEASE_QA_CONTRACT_VERSION: u32 = 1;
pub(crate) const ENV: &str = "MYTHRA_RELEASE_QA_ROOT";
pub(crate) const DISPOSE_ARG: &str = "--release-qa-dispose-store";
const MARKER: &str = ".mythra-release-qa.json";
const PURPOSE: &str = "mythra-release-qa";
static PROFILE: OnceLock<Profile> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    schema_version: u32,
    purpose: String,
    profile_id: Uuid,
}

pub(crate) struct Profile {
    root: PathBuf,
    id: Uuid,
    store_id: Uuid,
    run_id: Uuid,
    dispose_requested: AtomicBool,
    _lock: File,
    events: Mutex<File>,
}

fn plain_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("QA profile paths must be absolute and normalized".into());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(path.components().next(),Some(Component::Prefix(prefix)) if matches!(prefix.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_)))
        {
            return Err("Windows QA requires a local absolute drive path".into());
        }
    }
    let mut ancestor = PathBuf::new();
    for component in path.components() {
        ancestor.push(component.as_os_str());
        // A bare Windows drive/verbatim prefix is not an absolute directory.
        // Inspect it only after RootDir has completed the drive root.
        #[cfg(windows)]
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata =
            fs::symlink_metadata(&ancestor).map_err(|_| "QA profile path does not exist")?;
        if metadata.file_type().is_symlink() {
            return Err("QA profile symlinks are forbidden".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("QA profile reparse points are forbidden".into());
            }
        }
    }
    Ok(())
}

fn private_owned(path: &Path, directory: bool) -> Result<(), String> {
    plain_path(path)?;
    let metadata = fs::metadata(path).map_err(|_| "QA profile metadata unavailable")?;
    if metadata.is_dir() != directory {
        return Err("Invalid QA profile path type".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("QA profile must be owned by the current user and private (0700 directories, 0600 files)".into());
        }
    }
    #[cfg(windows)]
    validate_windows_owner(path, directory, false)?;
    Ok(())
}

#[cfg(windows)]
fn validate_windows_owner(
    path: &Path,
    require_protected: bool,
    recursive: bool,
) -> Result<(), String> {
    // This is an OS-only ownership check, with no login profile or provider CLI.
    // Root provisioning must remove inherited access to keep profile data private.
    // Elevated Windows tokens create children owned by their default owner
    // (Administrators). Accept only that actual token owner or its user SID;
    // the protected root itself must remain owned by the user SID.
    let script = "$i=[System.Security.Principal.WindowsIdentity]::GetCurrent(); $u=$i.User.Value; $t=$i.Owner.Value; $paths=@($env:MYTHRA_QA_OWNER_PATH); if($env:MYTHRA_QA_CHECK_TREE -eq '1'){$paths+=@(Get-ChildItem -LiteralPath $env:MYTHRA_QA_OWNER_PATH -Recurse -Force -ErrorAction Stop | ForEach-Object {$_.FullName})}; foreach($p in $paths){$a=Get-Acl -LiteralPath $p -ErrorAction Stop; $o=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if(($o -ne $u -and (($env:MYTHRA_QA_REQUIRE_PROTECTED -eq '1' -and $p -eq $env:MYTHRA_QA_OWNER_PATH) -or $o -ne $t)) -or ($env:MYTHRA_QA_REQUIRE_PROTECTED -eq '1' -and $p -eq $env:MYTHRA_QA_OWNER_PATH -and -not $a.AreAccessRulesProtected)){exit 1}; foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($r.AccessControlType -eq 'Allow' -and $s -notin @($u,'S-1-5-18','S-1-5-32-544')){exit 1}}}";
    let system = env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?;
    let status = crate::process_launch::background_std_command(
        PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    )
    .args(["-NoProfile", "-NonInteractive", "-Command", script])
    .env("MYTHRA_QA_OWNER_PATH", path)
    .env("MYTHRA_QA_CHECK_TREE", if recursive { "1" } else { "0" })
    .env(
        "MYTHRA_QA_REQUIRE_PROTECTED",
        if require_protected { "1" } else { "0" },
    )
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map_err(|_| "Cannot verify private Windows QA ownership")?;
    let mut child = status;
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Cannot read Windows QA ownership check status")?
        {
            break status;
        }
        if started.elapsed() >= std::time::Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Windows QA ownership verification timed out".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    if !status.success() {
        return Err("QA profile requires a protected ACL owned by the current user, granting access only to that user, SYSTEM, or Administrators".into());
    }
    Ok(())
}

fn owned_directory(root: &Path, name: &str) -> Result<PathBuf, String> {
    let path = root.join(name);
    if !path.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .map_err(|_| "Cannot create QA directory")?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&path).map_err(|_| "Cannot create QA directory")?;
    }
    // Windows children inherit the already protected root ACL. Do not require
    // an independently protected DACL for those children.
    plain_path(&path)?;
    #[cfg(unix)]
    private_owned(&path, true)?;
    #[cfg(windows)]
    validate_windows_owner(&path, false, false)?;
    if !path.is_dir() {
        return Err("QA profile child must be a directory".into());
    }
    Ok(path)
}

fn open_owned_file(root: &Path, name: &str, append: bool) -> Result<File, String> {
    let path = root.join(name);
    if path.exists() {
        plain_path(&path)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).append(append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        if !append {
            options.share_mode(0);
        }
    }
    let file = options
        .open(&path)
        .map_err(|_| "Cannot open QA profile file (another process may own it)")?;
    #[cfg(unix)]
    private_owned(&path, false)?;
    #[cfg(windows)]
    validate_windows_owner(&path, false, false)?;
    Ok(file)
}

/// Existing profiles may be reused, but never follow a planted link into the
/// real profile. Hard-linked files are also shared writable storage.
fn validate_tree(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut count = 0;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|_| "Cannot inspect QA profile contents")? {
            count += 1;
            if count > 100_000 {
                return Err("QA profile contains too many entries to validate".into());
            }
            let path = entry.map_err(|_| "Cannot inspect QA profile entry")?.path();
            plain_path(&path)?;
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "Cannot inspect QA profile metadata")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.uid() != unsafe { libc::geteuid() }
                    || (metadata.is_file() && metadata.nlink() != 1)
                {
                    return Err("QA profile contains a foreign-owned or hard-linked entry".into());
                }
            }
            #[cfg(windows)]
            if metadata.is_file() {
                use std::os::windows::io::AsRawHandle;
                use windows_sys::Win32::Storage::FileSystem::{
                    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
                };
                let file = File::open(&path).map_err(|_| "Cannot inspect QA file links")?;
                let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
                if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) }
                    == 0
                    || unsafe { info.assume_init() }.nNumberOfLinks != 1
                {
                    return Err("QA profile contains a hard-linked or unreadable file".into());
                }
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if !metadata.is_file() {
                return Err("QA profile contains a non-file entry".into());
            }
        }
    }
    #[cfg(windows)]
    validate_windows_owner(root, true, true)?;
    Ok(())
}

fn lock_profile(file: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("QA profile is already in use".into());
        }
    }
    #[cfg(not(unix))]
    let _ = file; // Windows share_mode(0) owns the open file.
    Ok(())
}

fn supported_platform() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Wry silently uses the default store below macOS 14. Reject first.
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .map_err(|_| "Cannot verify macOS WebView isolation support")?;
        let major = String::from_utf8_lossy(&output.stdout)
            .trim()
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok());
        if !output.status.success() || major.is_none_or(|v| v < 14) {
            return Err(
                "Release QA requires macOS 14 or later for a separate persistent WebView store"
                    .into(),
            );
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Err("Release QA profile isolation is supported only on macOS and Windows".into())
    }
}

// WebKit store identifiers are application-global. Bind the persistent store
// to the canonical root as well as the marker so copying a QA directory cannot
// open the source profile's WebView store under an independent filesystem lock.
fn store_id_for(root: &Path, id: Uuid) -> Uuid {
    let mut hasher = Sha256::new();
    hasher.update(b"mythra-release-qa-webview-v1\0");
    hasher.update(root.as_os_str().as_encoded_bytes());
    hasher.update(b"\0");
    hasher.update(id.as_bytes());
    let hash = hasher.finalize();
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

#[cfg(windows)]
fn windows_local_path(path: PathBuf) -> Result<PathBuf, String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    // Canonical local paths have a verbatim prefix; normalize it before any
    // PowerShell ACL inspection, whose filesystem provider rejects that form.
    if encoded.starts_with(&[92, 92, 63, 92]) {
        if encoded.get(5) != Some(&58) || encoded.get(6) != Some(&92) {
            return Err("Windows QA requires a local absolute drive path".into());
        }
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&encoded[4..])))
    } else {
        Ok(path)
    }
}

impl Profile {
    fn open(root: PathBuf) -> Result<Self, String> {
        #[cfg(windows)]
        let root = windows_local_path(root)?;
        private_owned(&root, true)?;
        let root = fs::canonicalize(root).map_err(|_| "Cannot canonicalize QA root")?;
        #[cfg(windows)]
        let root = windows_local_path(root)?;
        private_owned(&root.join(MARKER), false)?;
        validate_tree(&root)?;
        if fs::metadata(root.join(MARKER))
            .map_err(|_| "Cannot read QA ownership marker")?
            .len()
            > 4096
        {
            return Err("QA ownership marker is too large".into());
        }
        let bytes = fs::read(root.join(MARKER)).map_err(|_| "Cannot read QA ownership marker")?;
        if bytes.len() > 4096 {
            return Err("QA ownership marker is too large".into());
        }
        let marker: Marker =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid QA ownership marker")?;
        if marker.schema_version != 1
            || marker.purpose != PURPOSE
            || marker.profile_id.get_version_num() != 4
            || marker.profile_id.is_nil()
        {
            return Err("QA ownership marker must have schemaVersion 1, purpose mythra-release-qa, and a UUID v4 profileId".into());
        }
        let lock = open_owned_file(&root, "profile.lock", false)?;
        lock_profile(&lock)?;
        for name in ["app-data", "home", "webview"] {
            owned_directory(&root, name)?;
        }
        let events = Mutex::new(open_owned_file(&root, "events.jsonl", true)?);
        let store_id = store_id_for(&root, marker.profile_id);
        Ok(Self {
            root,
            id: marker.profile_id,
            store_id,
            run_id: Uuid::new_v4(),
            dispose_requested: AtomicBool::new(false),
            _lock: lock,
            events,
        })
    }

    fn event(&self, kind: &str, details: Value) {
        if let Ok(mut file) = self.events.lock() {
            let value = json!({"schemaVersion":1,"profileId":self.id,"runId":self.run_id,"pid":std::process::id(),"kind":kind,"details":details});
            if serde_json::to_writer(&mut *file, &value)
                .and_then(|()| file.write_all(b"\n").map_err(serde_json::Error::io))
                .is_err()
                || file.flush().is_err()
            {
                // An unverifiable profile must never continue native QA.
                std::process::exit(78);
            }
        }
    }
}

pub(crate) fn initialize() -> Result<(), String> {
    let Some(root) = env::var_os(ENV) else {
        return Ok(());
    };
    if root.is_empty() {
        return Err("MYTHRA_RELEASE_QA_ROOT cannot be empty".into());
    }
    supported_platform()?;
    let profile = Profile::open(PathBuf::from(root))?;
    PROFILE
        .set(profile)
        .map_err(|_| "QA profile was initialized twice")?;
    let profile = PROFILE.get().expect("initialized QA profile");
    record(
        "profile-open",
        json!({"contractVersion":RELEASE_QA_CONTRACT_VERSION,"providers":"blocked","persistentWebview":true,"webviewStoreId":profile.store_id}),
    );
    Ok(())
}

pub(crate) fn active() -> bool {
    PROFILE.get().is_some()
}
pub(crate) fn record(kind: &str, details: Value) {
    if let Some(profile) = PROFILE.get() {
        profile.event(kind, details);
    }
}
pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, tauri::Error> {
    PROFILE
        .get()
        .map(|p| Ok(p.root.join("app-data")))
        .unwrap_or_else(|| app.path().app_data_dir())
}
pub(crate) fn home_dir(app: &AppHandle) -> Result<PathBuf, tauri::Error> {
    PROFILE
        .get()
        .map(|p| Ok(p.root.join("home")))
        .unwrap_or_else(|| app.path().home_dir())
}
pub(crate) fn require_providers() -> Result<(), String> {
    if active() {
        Err("Providers, authentication, credentials, and external commands are disabled in release QA".into())
    } else {
        Ok(())
    }
}

pub(crate) fn allowed_command(command: &str) -> bool {
    matches!(
        command,
        "state_read"
            | "state_read_raw"
            | "state_write"
            | "state_delete"
            | "local_transcript_list"
            | "local_transcript_metadata_write"
            | "local_transcript_page_read"
            | "local_transcript_full_read"
            | "local_transcript_snapshot_write"
            | "local_transcript_tail_write"
            | "local_transcript_write_state_read"
            | "local_transcript_rename"
            | "audit_append"
            | "audit_recent"
            | "startup_ready"
            | "startup_failed"
            | "close_guard_claim"
            | "close_guard_finish"
            | "release_qa_renderer_probe"
            | "normal_chat_workspace"
    )
}

/// Report the actual QA policy without resolving executables, reading login
/// homes, or opening Keychain/Credential Manager.
pub(crate) fn offline_status(command: &str) -> Option<Value> {
    let warning = "Providers and authentication are disabled in the release QA profile.";
    match command {
        "codex_runtime_status" | "codex_runtime_status_refresh" => Some(json!({
            "available":false,"source":null,"path":null,"runningPath":null,"dataHome":null,
            "version":null,"runningVersion":null,"runningCommands":0,"runtimeChanged":false,
            "compatible":false,"warning":warning
        })),
        "claude_runtime_status" => Some(
            json!({"available":false,"path":null,"version":null,"loggedIn":false,"authMethod":null,"email":null,"subscriptionType":null,"warning":warning}),
        ),
        "cursor_runtime_status" => Some(
            json!({"available":false,"path":null,"version":null,"loggedIn":false,"email":null,"subscriptionType":null,"warning":warning}),
        ),
        "has_openrouter_key" | "has_lmstudio_key" | "claude_turn_active" | "cursor_turn_active" => {
            Some(json!(false))
        }
        "claude_models" | "cursor_models" => Some(json!([])),
        _ => None,
    }
}

pub(crate) fn configure_context(context: &mut tauri::Context<tauri::Wry>) {
    if !active() {
        return;
    }
    // A fresh authority removes production plugin privileges. Tauri dispatches
    // plugins before the app invoke handler, so that handler cannot block them.
    *context.runtime_authority_mut() =
        tauri::runtime_authority!(Default::default(), Default::default());
    for command in [
        "plugin:event|listen",
        "plugin:event|unlisten",
        "plugin:event|emit",
        "plugin:event|emit_to",
        "plugin:window|get_all_windows",
        "plugin:window|is_focused",
        "plugin:window|is_visible",
        "plugin:window|is_maximized",
        "plugin:window|close",
        "plugin:window|destroy",
        "plugin:webview|get_all_webviews",
    ] {
        context
            .runtime_authority_mut()
            .__allow_command(command.into(), tauri::utils::acl::ExecutionContext::Local);
    }
    let profile = PROFILE.get().expect("active QA profile");
    // Tauri resolves $APPDATA separately from the app's storage helper. Bind
    // asset reads to the owned QA image directories, preserving normal CSP.
    context.config_mut().app.security.asset_protocol.scope = serde_json::from_value(json!([
        profile.root.join("app-data/pasted-images/**"),
        profile.root.join("app-data/message-images/**")
    ]))
    .expect("absolute QA asset paths");
}

pub(crate) fn configure_window<'a>(
    mut builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let Some(profile) = PROFILE.get() else {
        return builder;
    };
    #[cfg(windows)]
    {
        builder = builder.data_directory(profile.root.join("webview"));
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(*profile.store_id.as_bytes());
    }
    let id = profile.id.to_string();
    let script = format!(
        r#"(() => {{ const id={id:?}; const key='mythra.releaseQa.profile'; let previous=null,error=null; try {{ previous=localStorage.getItem(key); localStorage.setItem(key,id); }} catch(e) {{ error=String(e); }} window.addEventListener('DOMContentLoaded',()=>{{ window.__TAURI_INTERNALS__.invoke('release_qa_renderer_probe',{{profileId:id,previous,error}}).catch(()=>{{}}); }},{{once:true}}); }})();"#
    );
    builder
        .title(format!("Mythra Code — Release QA {}", profile.id))
        .incognito(false)
        .initialization_script(script)
        .on_navigation(|url| {
            matches!(url.scheme(), "tauri" | "http" | "https")
                && matches!(url.host_str(), Some("tauri.localhost" | "localhost"))
        })
}

#[tauri::command]
pub(crate) fn release_qa_renderer_probe(
    window: WebviewWindow,
    profile_id: String,
    previous: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let profile = PROFILE.get().ok_or("Release QA is not active")?;
    if profile_id != profile.id.to_string() || window.label() != "main" {
        return Err("QA renderer identity mismatch".into());
    }
    if error.is_some() || previous.as_deref().is_some_and(|v| v != profile_id) {
        profile.event("renderer-storage-failed", json!({"error":error.is_some(),"foreignIdentity":previous.as_deref().is_some_and(|v| v != profile_id)}));
        window.app_handle().exit(78);
        return Err("QA WebView storage is unavailable or contains another profile".into());
    }
    profile.event(
        "renderer-storage",
        json!({"previous":previous,"current":profile.id}),
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    profile_id: Uuid,
    nonce: Uuid,
    action: String,
}

pub(crate) fn install_control(app: &AppHandle) {
    let Some(profile) = PROFILE.get() else {
        return;
    };
    let app = app.clone();
    let request_path = profile.root.join("request.json");
    tauri::async_runtime::spawn(async move {
        // A durable close request belongs to its previous launch. A new
        // process requires a new nonce so reopening does not immediately close.
        let mut last_nonce = fs::read(&request_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Request>(&bytes).ok())
            .map(|request| request.nonce);
        // Hosts must wait for this launch's readiness before writing a fresh
        // request, otherwise a slow window setup could snapshot it as stale.
        record("control-ready", json!({}));
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if !request_path.exists() {
                continue;
            }
            if plain_path(&request_path).is_err() {
                app.exit(78);
                return;
            }
            let request = fs::read(&request_path)
                .ok()
                .filter(|bytes| bytes.len() <= 4096)
                .and_then(|bytes| serde_json::from_slice::<Request>(&bytes).ok());
            let Some(request) = request else {
                record("control-rejected", json!({"reason":"invalid-request"}));
                app.exit(78);
                return;
            };
            if last_nonce == Some(request.nonce) {
                continue;
            }
            if private_owned(&request_path, false).is_err() {
                app.exit(78);
                return;
            }
            if request.schema_version != 1
                || request.profile_id != profile.id
                || request.nonce.get_version_num() != 4
                || !matches!(
                    request.action.as_str(),
                    "focus" | "close" | "close-and-dispose"
                )
            {
                record("control-rejected", json!({"reason":"identity-or-action"}));
                app.exit(78);
                return;
            }
            last_nonce = Some(request.nonce);
            if request.action == "focus" {
                record("focus-request", json!({"nonce":request.nonce}));
                let focus_app = app.clone();
                let scheduled = app.run_on_main_thread(move || {
                    let result = focus_app
                        .get_webview_window("main")
                        .ok_or_else(|| "QA main window is unavailable".to_string())
                        .and_then(|window| {
                            let title = window.title().map_err(|error| error.to_string())?;
                            if title != format!("Mythra Code — Release QA {}", profile.id) {
                                return Err("QA window title identity mismatch".into());
                            }
                            window.show().map_err(|error| error.to_string())?;
                            window.set_focus().map_err(|error| error.to_string())?;
                            record("window-focused", json!({"title":title,"label":"main"}));
                            Ok(())
                        });
                    if let Err(error) = result {
                        record(
                            "control-rejected",
                            json!({"reason":"focus-failed","message":error}),
                        );
                        focus_app.exit(78);
                    }
                });
                if scheduled.is_err() {
                    record(
                        "control-rejected",
                        json!({"reason":"focus-dispatch-failed"}),
                    );
                    app.exit(78);
                    return;
                }
                continue;
            }
            if request.action == "close-and-dispose" {
                profile.dispose_requested.store(true, Ordering::Release);
            }
            record("close-request", json!({"nonce":request.nonce}));
            let close_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = close_app.get_webview_window("main") {
                    let _ = window.close();
                }
            });
        }
    });
}

/// Closing retains the profile until the coordinator runs the maintenance
/// pass after this process exits. Window destruction alone can retain native
/// WebView/data-store references, so never claim cleanup from close alone.
pub(crate) fn dispose_before_exit(app: &AppHandle, event: &tauri::RunEvent) -> bool {
    let Some(profile) = PROFILE.get() else {
        return false;
    };
    if matches!(
        event,
        tauri::RunEvent::ExitRequested {
            code: None | Some(0),
            ..
        }
    ) && app.get_webview_window("main").is_none()
        && profile.dispose_requested.swap(false, Ordering::AcqRel)
    {
        record(
            "webview-dispose-deferred",
            json!({"webviewStoreId":profile.store_id,"maintenancePassRequired":cfg!(target_os="macos"),"rootRemovalRequired":true}),
        );
    }
    false
}

/// Run only with an owned, exclusively locked QA profile, using the exact
/// candidate executable. Initialize WebKit with a hidden nonpersistent blank
/// WebView, touch no default store, and
/// preserve fixture data and diagnostic events on failure.
pub(crate) fn dispose_owned_store(app: &AppHandle) {
    let profile = PROFILE.get().expect("validated QA maintenance profile");
    record(
        "webview-dispose-started",
        json!({"webviewStoreId":profile.store_id,"headless":true}),
    );
    #[cfg(target_os = "macos")]
    {
        let blank = tauri::WebviewWindowBuilder::new(
            app,
            "release-qa-cleanup",
            tauri::WebviewUrl::External("about:blank".parse().expect("constant blank URL")),
        )
        .visible(false)
        .focused(false)
        .incognito(true)
        .on_navigation(|url| url.as_str() == "about:blank")
        .build();
        let blank = match blank {
            Ok(blank) => blank,
            Err(error) => {
                record(
                    "webview-dispose-failed",
                    json!({"verifiedAbsent":false,"stage":"initialize-error","message":error.to_string()}),
                );
                app.exit(78);
                return;
            }
        };
        let checked_app = app.clone();
        let checked = blank.with_webview(move |platform| {
            let main_thread = objc2::MainThreadMarker::new().is_some();
            if !main_thread {
                record(
                    "webview-dispose-failed",
                    json!({"verifiedAbsent":false,"stage":"maintenance-off-main-thread"}),
                );
                checked_app.exit(78);
                return;
            }
            // Tauri supplies the live WKWebView pointer on its owning thread.
            let persistent = unsafe {
                let view = &*(platform.inner() as *const objc2_web_kit::WKWebView);
                view.configuration().websiteDataStore().isPersistent()
            };
            record(
                "webview-maintenance-initialized",
                json!({"mainThread":main_thread,"persistent":persistent,"url":"about:blank"}),
            );
            if persistent {
                record(
                    "webview-dispose-failed",
                    json!({"verifiedAbsent":false,"stage":"unsafe-maintenance-store"}),
                );
                checked_app.exit(78);
                return;
            }
            remove_initialized_store(checked_app);
        });
        if let Err(error) = checked {
            record(
                "webview-dispose-failed",
                json!({"verifiedAbsent":false,"stage":"initialize-error","message":error.to_string()}),
            );
            app.exit(78);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        record(
            "webview-dispose-deferred",
            json!({"rootRemovalRequired":true,"maintenancePassRequired":false}),
        );
        app.exit(0);
    }
}

#[cfg(target_os = "macos")]
fn remove_initialized_store(app: AppHandle) {
    let profile = PROFILE.get().expect("validated QA maintenance profile");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let before = app
                .fetch_data_store_identifiers()
                .await
                .map_err(|error| ("enumerate-error", error.to_string()))?;
            if before.contains(profile.store_id.as_bytes()) {
                app.remove_data_store(*profile.store_id.as_bytes())
                    .await
                    .map_err(|error| ("remove-error", error.to_string()))?;
            }
            let ids = app
                .fetch_data_store_identifiers()
                .await
                .map_err(|error| ("enumerate-error", error.to_string()))?;
            if ids.contains(profile.store_id.as_bytes()) {
                Err(("still-enumerated", String::new()))
            } else {
                Ok(())
            }
        })
        .await;
        let (absent, stage, message) = match result {
            Ok(Ok(())) => (true, "complete", String::new()),
            Ok(Err((stage, message))) => (false, stage, message),
            Err(_) => (false, "timeout", String::new()),
        };
        record(
            if absent {
                "webview-dispose-complete"
            } else {
                "webview-dispose-failed"
            },
            json!({"webviewStoreId":profile.store_id,"verifiedAbsent":absent,"stage":stage,"message":message.chars().take(512).collect::<String>()}),
        );
        app.exit(if absent { 0 } else { 78 });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root = fs::canonicalize(env::temp_dir())
            .unwrap()
            .join(format!("mythra-release-qa-{}", Uuid::new_v4()));
        #[cfg(windows)]
        let root = windows_local_path(root).unwrap();
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(windows)]
        {
            let script = "$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($s); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -LiteralPath $env:MYTHRA_QA_TEST_ROOT -AclObject $a";
            assert!(
                crate::process_launch::background_std_command("powershell.exe")
                    .args(["-NoProfile", "-NonInteractive", "-Command", script])
                    .env("MYTHRA_QA_TEST_ROOT", &root)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        root
    }
    fn marker(root: &Path) {
        fs::write(
            root.join(MARKER),
            serde_json::to_vec(
                &json!({"schemaVersion":1,"purpose":PURPOSE,"profileId":Uuid::new_v4()}),
            )
            .unwrap(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join(MARKER), fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    #[test]
    fn qa_requires_owned_marker_and_exclusive_profile_lock() {
        let root = root();
        assert!(Profile::open(root.clone()).is_err());
        marker(&root);
        let profile = Profile::open(root.clone()).unwrap();
        assert!(Profile::open(root.clone()).is_err());
        assert!(root.join("app-data").is_dir());
        drop(profile);
        assert!(Profile::open(root.clone()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn qa_windows_reused_child_acl_must_remain_private() {
        let root = root();
        marker(&root);
        let profile = Profile::open(root.clone()).unwrap();
        drop(profile);
        let child = root.join("app-data");
        let script = "$a=Get-Acl -LiteralPath $env:MYTHRA_QA_TEST_ROOT; $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'Read','Allow'))); Set-Acl -LiteralPath $env:MYTHRA_QA_TEST_ROOT -AclObject $a";
        assert!(
            crate::process_launch::background_std_command("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("MYTHRA_QA_TEST_ROOT", child)
                .status()
                .unwrap()
                .success()
        );
        assert!(Profile::open(root.clone()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn qa_windows_rejects_hardlinked_preseed_and_binds_root_to_user_owner() {
        let root = root();
        marker(&root);
        fs::write(root.join("original"), b"preserve fixture bytes").unwrap();
        fs::hard_link(root.join("original"), root.join("shared")).unwrap();
        assert!(Profile::open(root.clone()).is_err());
        assert_eq!(
            fs::read(root.join("original")).unwrap(),
            b"preserve fixture bytes"
        );
        fs::remove_file(root.join("shared")).unwrap();
        let script = "$i=[System.Security.Principal.WindowsIdentity]::GetCurrent(); if($i.Owner.Value -ne $i.User.Value){$a=Get-Acl -LiteralPath $env:MYTHRA_QA_TEST_ROOT; $a.SetOwner($i.Owner); Set-Acl -LiteralPath $env:MYTHRA_QA_TEST_ROOT -AclObject $a; exit 2}";
        let result = crate::process_launch::background_std_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("MYTHRA_QA_TEST_ROOT", &root)
            .status()
            .unwrap();
        if result.code() == Some(2) {
            assert!(Profile::open(root.clone()).is_err());
        } else {
            assert!(result.success());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn qa_windows_tree_acl_check_is_batched_for_persisted_profiles() {
        let root = root();
        marker(&root);
        fs::create_dir(root.join("webview")).unwrap();
        for index in 0..500 {
            fs::write(
                root.join("webview").join(format!("fixture-{index}")),
                b"owned test fixture",
            )
            .unwrap();
        }
        let start = std::time::Instant::now();
        let profile = Profile::open(root.clone()).unwrap();
        eprintln!(
            "QA 500-file tree validation elapsed_ms={}",
            start.elapsed().as_millis()
        );
        drop(profile);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn qa_rejects_symlinked_children_and_nonprivate_markers() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = root();
        marker(&root);
        fs::set_permissions(root.join(MARKER), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Profile::open(root.clone()).is_err());
        fs::set_permissions(root.join(MARKER), fs::Permissions::from_mode(0o600)).unwrap();
        symlink(env::temp_dir(), root.join("app-data")).unwrap();
        assert!(Profile::open(root.clone()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn qa_copied_marker_roots_have_independent_persistent_webview_stores() {
        let one = root();
        let two = root();
        marker(&one);
        fs::copy(one.join(MARKER), two.join(MARKER)).unwrap();
        let a = Profile::open(one.clone()).unwrap();
        let b = Profile::open(two.clone()).unwrap();
        assert_eq!(a.id, b.id);
        assert_ne!(a.store_id, b.store_id);
        drop(a);
        drop(b);
        fs::remove_dir_all(one).unwrap();
        fs::remove_dir_all(two).unwrap();
    }
    #[test]
    fn qa_store_identity_is_bound_to_the_root_and_stable_for_reopen() {
        let id = Uuid::new_v4();
        let a = Path::new("/owned/qa/profile-a");
        let b = Path::new("/owned/qa/profile-b");
        assert_eq!(store_id_for(a, id), store_id_for(a, id));
        assert_ne!(store_id_for(a, id), store_id_for(b, id));
        assert_ne!(store_id_for(a, id), store_id_for(a, Uuid::new_v4()));
        assert_eq!(store_id_for(a, id).get_version_num(), 4);
    }
    #[cfg(unix)]
    #[test]
    fn qa_rejects_linked_database_and_unknown_marker_fields() {
        let root = root();
        marker(&root);
        fs::create_dir(root.join("app-data")).unwrap();
        let unrelated = root.join("unrelated.sqlite3");
        fs::write(&unrelated, b"unrelated").unwrap();
        fs::hard_link(&unrelated, root.join("app-data/openkiwi.sqlite3")).unwrap();
        assert!(Profile::open(root.clone()).is_err());
        fs::remove_file(root.join("app-data/openkiwi.sqlite3")).unwrap();
        let mut value: Value =
            serde_json::from_slice(&fs::read(root.join(MARKER)).unwrap()).unwrap();
        value["unknown"] = json!(true);
        fs::write(root.join(MARKER), serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(Profile::open(root.clone()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn qa_offline_status_never_advertises_provider_or_credentials_ready() {
        for command in [
            "codex_runtime_status",
            "codex_runtime_status_refresh",
            "claude_runtime_status",
            "cursor_runtime_status",
        ] {
            let status = offline_status(command).unwrap();
            assert_eq!(status["available"], false);
            assert!(status["warning"].as_str().unwrap().contains("release QA"));
            assert!(status["path"].is_null());
        }
        assert_eq!(offline_status("has_openrouter_key"), Some(json!(false)));
        assert_eq!(offline_status("has_lmstudio_key"), Some(json!(false)));
        assert!(offline_status("claude_login").is_none());
        assert!(offline_status("codex_rpc").is_none());
    }
    #[test]
    fn qa_allowlist_rejects_every_provider_auth_and_external_mutation() {
        for command in [
            "codex_runtime_status",
            "codex_rpc",
            "claude_login",
            "claude_usage",
            "claude_turn_start",
            "cursor_runtime_status",
            "github_status",
            "save_openrouter_key",
            "has_lmstudio_key",
            "run_discovery_start",
            "export_text_file",
            "worktree_create",
            "local_skills_scan",
            "plugin:updater|check",
        ] {
            assert!(!allowed_command(command), "{command}");
        }
        for command in [
            "state_read_raw",
            "state_write",
            "local_transcript_snapshot_write",
            "startup_ready",
            "close_guard_finish",
            "release_qa_renderer_probe",
        ] {
            assert!(allowed_command(command), "{command}");
        }
    }
}
