//! Remote reads never load working-tree commands from a live repository config.
//! Status/diff/history operate on a private metadata snapshot with NO filter,
//! diff-driver, fsmonitor, credential, signing or include configuration. Merely
//! enumerating filter names then overriding them leaves a new-driver TOCTOU.
use super::fs_guard::Anchor;
use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
thread_local! {static POLICY:RefCell<Option<Arc<Mutex<Policy>>>>=const{RefCell::new(None)};}
#[derive(Default)]
struct Policy {
    snapshots: HashMap<PathBuf, Snapshot>,
    preparing: bool,
}
struct Snapshot {
    // Hold the original cwd handle through every probe and final spawn.
    _root_pin: Anchor,
    objects: PathBuf,
    path: PathBuf,
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
pub(super) struct Guard {
    previous: Option<Arc<Mutex<Policy>>>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        POLICY.with(|p| {
            p.replace(self.previous.take());
        });
    }
}
pub(crate) fn active() -> bool {
    POLICY.with(|p| p.borrow().is_some())
}
pub(super) fn enter() -> Guard {
    let previous = POLICY.with(|p| p.replace(Some(Arc::new(Mutex::new(Policy::default())))));
    Guard { previous }
}
fn failure() -> String {
    "Remote Git could not safely inspect this repository. Refresh and try again.".into()
}
fn command_name(args: &[&str]) -> Option<usize> {
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-c" | "-C" | "--git-dir" | "--work-tree" => i += 2,
            s if s.starts_with('-') => i += 1,
            _ => return Some(i),
        }
    }
    None
}
fn environment(command: &mut Command) {
    for key in [
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_ATTR_SOURCE",
    ] {
        command.env_remove(key);
    }
    command
        .env("GIT_CONFIG_COUNT", "5")
        .env("GIT_CONFIG_KEY_0", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_0", "false")
        .env("GIT_CONFIG_KEY_1", "core.untrackedCache")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "diff.external")
        .env("GIT_CONFIG_VALUE_2", "")
        .env("GIT_CONFIG_KEY_3", "log.showSignature")
        .env("GIT_CONFIG_VALUE_3", "false")
        .env("GIT_CONFIG_KEY_4", "core.pager")
        .env("GIT_CONFIG_VALUE_4", "cat");
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never");
}
/// Called only by bounded Git reads. Local callers take this exact no-op path.
pub(crate) fn configure(command: &mut Command, repo: &Path, args: &[&str]) -> Result<(), String> {
    let Some(policy) = POLICY.with(|p| p.borrow().clone()) else {
        return Ok(());
    };
    let mut policy = policy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if policy.preparing {
        return Ok(());
    }
    let index = command_name(args).ok_or_else(failure)?;
    let name = args[index];
    environment(command);
    // These builtins only read metadata/config; none converts worktree content.
    // Keep real common-dir/worktree/symbolic-ref identities for scope validation.
    if matches!(name, "rev-parse" | "symbolic-ref" | "config" | "worktree") {
        if name == "worktree" && args.get(index + 1) != Some(&"list") {
            return Err(failure());
        }
        if name == "config"
            && !args[index + 1..].iter().any(|a| {
                matches!(
                    *a,
                    "--get" | "--get-regexp" | "--get-all" | "--list" | "--get-urlmatch"
                )
            })
        {
            return Err(failure());
        }
        return Ok(());
    }
    if !matches!(
        name,
        "status"
            | "diff"
            | "log"
            | "show"
            | "cat-file"
            | "ls-tree"
            | "ls-files"
            | "rev-list"
            | "for-each-ref"
            | "diff-tree"
            | "diff-index"
            | "diff-files"
            | "hash-object"
            | "merge-base"
            | "check-ref-format"
            | "describe"
            | "name-rev"
            | "check-attr"
    ) {
        return Err(failure());
    }
    let key = fs::canonicalize(repo).map_err(|_| failure())?;
    if !policy.snapshots.contains_key(&key) {
        policy.preparing = true;
        let snapshot = Snapshot::create(repo);
        policy.preparing = false;
        policy.snapshots.insert(key.clone(), snapshot?);
    }
    let snapshot = policy.snapshots.get(&key).ok_or_else(failure)?;
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    command
        .env("GIT_CONFIG_GLOBAL", null)
        .env("GIT_CONFIG_SYSTEM", null)
        .env("GIT_DIR", git_env_path(&snapshot.path)?)
        .env("GIT_COMMON_DIR", git_env_path(&snapshot.path)?)
        .env("GIT_WORK_TREE", ".")
        .env(
            "GIT_INDEX_FILE",
            git_env_path(&snapshot.path.join("index"))?,
        )
        .env("GIT_OBJECT_DIRECTORY", git_env_path(&snapshot.objects)?);
    // Callers also use these flags explicitly. Put them after the builtin, not
    // after a path separator, even if a future read adapter forgets them.
    if matches!(name, "diff" | "show" | "log") {
        let mut owned: Vec<_> = args.iter().map(|s| s.to_string()).collect();
        owned.insert(index + 1, "--no-textconv".into());
        owned.insert(index + 1, "--no-ext-diff".into());
        let program = command.get_program().to_owned();
        let cwd = command.get_current_dir().map(Path::to_path_buf);
        let env: Vec<_> = command
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(std::ffi::OsStr::to_owned)))
            .collect();
        let mut safe = crate::process_launch::background_std_command(program);
        safe.args(owned)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            safe.current_dir(cwd);
        }
        for (key, value) in env {
            if let Some(value) = value {
                safe.env(key, value);
            } else {
                safe.env_remove(key);
            }
        }
        *command = safe;
    }
    Ok(())
}
// Rust canonicalization emits Windows verbatim paths. Git's own path parsing
// needs normal drive/UNC syntax in environment variables; this is one path,
// NOT an alternate-object-directory list (do not split a drive colon or quote).
fn git_env_path(path: &Path) -> Result<std::ffi::OsString, String> {
    #[cfg(windows)]
    {
        Ok(windows_git_path(path.to_str().ok_or_else(failure)?)?.into())
    }
    #[cfg(not(windows))]
    {
        Ok(path.as_os_str().to_owned())
    }
}
#[cfg(any(windows, test))]
fn windows_git_path(path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");
    if let Some(unc) = normalized.strip_prefix("//?/UNC/") {
        return Ok(format!("//{unc}"));
    }
    if let Some(drive) = normalized.strip_prefix("//?/") {
        let bytes = drive.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || bytes[2] != b'/'
        {
            return Err(failure());
        }
        return Ok(drive.to_owned());
    }
    Ok(normalized)
}
fn probe(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut command = crate::project_git::git_command_for(
        repo,
        std::env::var_os("PATH").as_deref(),
        home.as_deref(),
    );
    environment(&mut command);
    command
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let (mut child, scope) = crate::git_workspace::spawn_scoped_git(&mut command)?;
    let mut out = child.stdout.take().ok_or_else(failure)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = out.by_ref().take(65537).read_to_end(&mut bytes);
        let _ = sender.send((result, bytes));
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if Instant::now() >= deadline {
            return Err(scope.stop(&mut child, failure()));
        }
        if let Some(status) = child.try_wait().map_err(|_| failure())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let (result, bytes) = receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| scope.stop(&mut child, failure()))?;
    result.map_err(|_| failure())?;
    if bytes.len() > 65536 || !status.success() {
        return Err(failure());
    }
    Ok(bytes)
}
fn path(repo: &Path, bytes: Vec<u8>) -> Result<PathBuf, String> {
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| failure())?
        .trim_end_matches(['\r', '\n']);
    let p = PathBuf::from(text);
    fs::canonicalize(if p.is_absolute() { p } else { repo.join(p) }).map_err(|_| failure())
}
fn copy(
    anchor: &Anchor,
    name: &str,
    to: &Path,
    total: &mut usize,
    limit: usize,
) -> Result<(), String> {
    let mut file = anchor.regular(name)?;
    let metadata = file.metadata().map_err(|_| failure())?;
    let modified = metadata.modified().map_err(|_| failure())?;
    let size = metadata.len();
    if size > limit as u64 || *total + size as usize > 64 * 1024 * 1024 {
        return Err(failure());
    }
    let mut data = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| failure())?;
    if data.len() > limit {
        return Err(failure());
    }
    anchor.validate()?;
    *total += data.len();
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(|_| failure())?;
    out.write_all(&data).map_err(|_| failure())?;
    // An index mtime is the cutoff for Git's racily-clean content check, not
    // just cosmetic metadata. Advancing it while copying the old stat cache
    // can hide same-size edits made in the original index's timestamp tick.
    // Preserve it from the SAME opened source as the bytes (also sharedindex).
    out.set_times(fs::FileTimes::new().set_modified(modified))
        .map_err(|_| failure())
}
fn refs(
    from: &Anchor,
    to: &Path,
    total: &mut usize,
    count: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err(failure());
    }
    for entry in from.entries()? {
        *count += 1;
        if *count > 10000 {
            return Err(failure());
        }
        let dest = to.join(&entry.name);
        if entry.kind == "directory" {
            fs::create_dir_all(&dest).map_err(|_| failure())?;
            refs(
                &from.directory(&entry.name)?,
                &dest,
                total,
                count,
                depth + 1,
            )?;
        } else {
            if dest.exists() {
                fs::remove_file(&dest).map_err(|_| failure())?;
            }
            copy(from, &entry.name, &dest, total, 2 * 1024 * 1024)?;
        }
    }
    from.validate()
}
impl Snapshot {
    fn create(repo: &Path) -> Result<Self, String> {
        let root_pin = Anchor::open(repo)?;
        let _root = path(repo, probe(repo, &["rev-parse", "--show-toplevel"])?)?;
        let git_dir = path(repo, probe(repo, &["rev-parse", "--absolute-git-dir"])?)?;
        let common = path(repo, probe(repo, &["rev-parse", "--git-common-dir"])?)?;
        let objects = path(repo, probe(repo, &["rev-parse", "--git-path", "objects"])?)?;
        let directory = std::env::temp_dir().join(format!("mythra-read-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder.create(&directory).map_err(|_| failure())?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&directory).map_err(|_| failure())?;
        let snapshot = Self {
            _root_pin: root_pin,
            objects,
            path: directory,
        };
        for name in ["objects", "refs", "info"] {
            fs::create_dir(snapshot.path.join(name)).map_err(|_| failure())?;
        }
        let own = Anchor::open(&git_dir)?;
        let shared = Anchor::open(&common)?;
        let mut total = 0;
        copy(&own, "HEAD", &snapshot.path.join("HEAD"), &mut total, 4096)?;
        // A detached HEAD preserves the exact commit even when a valid local
        // ref name cannot be represented by our cross-platform file policy.
        if let Ok(head) = probe(repo, &["rev-parse", "--verify", "HEAD"]) {
            let id = std::str::from_utf8(&head).map_err(|_| failure())?.trim();
            if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(failure());
            }
            fs::write(snapshot.path.join("HEAD"), format!("{id}\n")).map_err(|_| failure())?;
        }
        if git_dir.join("index").exists() {
            copy(
                &own,
                "index",
                &snapshot.path.join("index"),
                &mut total,
                32 * 1024 * 1024,
            )?;
        }
        for entry in own.entries()? {
            if entry.name.starts_with("sharedindex.") && entry.kind == "file" {
                copy(
                    &own,
                    &entry.name,
                    &snapshot.path.join(&entry.name),
                    &mut total,
                    32 * 1024 * 1024,
                )?;
            }
        }
        if common.join("packed-refs").exists() {
            copy(
                &shared,
                "packed-refs",
                &snapshot.path.join("packed-refs"),
                &mut total,
                8 * 1024 * 1024,
            )?;
        }
        let mut count = 0;
        if let Ok(source) = shared.directory("refs") {
            refs(
                &source,
                &snapshot.path.join("refs"),
                &mut total,
                &mut count,
                0,
            )?;
        }
        if git_dir != common {
            if let Ok(source) = own.directory("refs") {
                refs(
                    &source,
                    &snapshot.path.join("refs"),
                    &mut total,
                    &mut count,
                    0,
                )?;
            }
        }
        if let Ok(info) = shared.directory("info") {
            for name in ["exclude", "sparse-checkout"] {
                if info.path.join(name).exists() {
                    copy(
                        &info,
                        name,
                        &snapshot.path.join("info").join(name),
                        &mut total,
                        1024 * 1024,
                    )?;
                }
            }
        }
        let format = probe(repo, &["rev-parse", "--show-object-format"])?;
        let sha256 = std::str::from_utf8(&format).map_err(|_| failure())?.trim() == "sha256";
        let mut config=format!("[core]\n repositoryformatversion={}\n bare=false\n fsmonitor=false\n untrackedCache=false\n[diff]\n external=\n",if sha256{1}else{0});
        if sha256 {
            config.push_str("[extensions]\n objectformat=sha256\n");
        }
        // Only scalar comparison settings survive. No live includes, drivers,
        // attributes command, pager, signing, aliases, helpers or URLs do.
        for name in [
            "core.autocrlf",
            "core.eol",
            "core.ignorecase",
            "core.filemode",
            "core.symlinks",
            "core.ignorestat",
            "core.trustctime",
            "core.checkstat",
            "core.sparsecheckout",
            "core.sparsecheckoutcone",
            "index.sparse",
        ] {
            if let Ok(value) = probe(repo, &["config", "--get", name]) {
                let value = std::str::from_utf8(&value).map_err(|_| failure())?.trim();
                if value.len() > 32
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err(failure());
                }
                let (section, key) = name.split_once('.').ok_or_else(failure)?;
                config.push_str(&format!("[{section}]\n {key}={value}\n"));
            }
        }
        fs::write(snapshot.path.join("config"), config).map_err(|_| failure())?;
        own.validate()?;
        shared.validate()?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Repo(PathBuf);
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn git(root: &Path, args: &[&str]) {
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let out = crate::process_launch::background_std_command("git")
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", null)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    #[test]
    fn git_environment_paths_keep_windows_drives_unc_spaces_and_unicode() {
        for (native, git) in [
            (
                r"\\?\C:\Users\Native test\é repo\.git\objects",
                "C:/Users/Native test/é repo/.git/objects",
            ),
            (
                r"\\?\UNC\server\share\é repo\objects",
                "//server/share/é repo/objects",
            ),
            (r"C:\repo\objects", "C:/repo/objects"),
            (r"\\server\share\objects", "//server/share/objects"),
        ] {
            assert_eq!(windows_git_path(native).unwrap(), git);
        }
        assert!(windows_git_path(r"\\?\Volume{not-a-drive}\objects").is_err());
    }
    #[test]
    fn copied_index_keeps_racy_clean_detection_and_staging() {
        use std::time::{SystemTime, UNIX_EPOCH};
        for (split, version) in [(false, "2"), (true, "2"), (false, "4")] {
            let repo = Repo(
                std::env::temp_dir()
                    .join(format!("mythra-racy-index-é repo-{}", uuid::Uuid::new_v4())),
            );
            fs::create_dir(&repo.0).unwrap();
            git(&repo.0, &["init", "-q"]);
            git(&repo.0, &["config", "index.version", version]);
            if split {
                git(&repo.0, &["config", "core.splitIndex", "true"]);
            }
            git(&repo.0, &["config", "user.name", "Native test"]);
            git(&repo.0, &["config", "user.email", "native@example.invalid"]);
            // Model a coarse-stat filesystem deterministically: same size + cached
            // mtime, without ctime/nanoseconds rescuing Git's stat-cache shortcut.
            git(&repo.0, &["config", "core.trustctime", "false"]);
            git(&repo.0, &["config", "core.checkStat", "minimal"]);
            let timestamp = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
            let set_mtime = |path: &Path, time: SystemTime| {
                fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(time))
                    .unwrap()
            };
            let tracked = repo.0.join("tracked.txt");
            fs::write(&tracked, "old\n").unwrap();
            set_mtime(&tracked, timestamp);
            fs::write(repo.0.join("staged.txt"), "before\n").unwrap();
            git(&repo.0, &["add", "."]);
            git(&repo.0, &["commit", "-qm", "baseline"]);
            fs::write(repo.0.join("staged.txt"), "staged version\n").unwrap();
            git(&repo.0, &["add", "staged.txt"]);
            let index = repo.0.join(".git/index");
            set_mtime(&index, timestamp);
            fs::write(&tracked, "new\n").unwrap();
            set_mtime(&tracked, timestamp);
            let original = fs::read(&index).unwrap();
            let original_mtime = fs::metadata(&index).unwrap().modified().unwrap();
            let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
            let source = crate::process_launch::background_std_command("git")
                .current_dir(&repo.0)
                .env("GIT_CONFIG_GLOBAL", null)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args(["--no-optional-locks", "status", "--porcelain=v1"])
                .output()
                .unwrap();
            assert!(source.status.success());
            assert!(
                String::from_utf8_lossy(&source.stdout).contains(" M tracked.txt"),
                "fixture must be detected by the original index"
            );
            let _anchor = Anchor::open(&repo.0).unwrap();
            let _guard = enter();
            let read = crate::project_git::GitReadOperation::new();
            let status = read.output(&repo.0, &["status", "--porcelain=v1"]).unwrap();
            assert!(
                status.status.success(),
                "{}",
                String::from_utf8_lossy(&status.stderr)
            );
            assert!(
                String::from_utf8_lossy(&status.stdout).contains(" M tracked.txt"),
                "copying the index must not turn a racily-clean modified file into clean: {}",
                String::from_utf8_lossy(&status.stdout)
            );
            assert!(String::from_utf8_lossy(&status.stdout).contains("M  staged.txt"));
            let diff = read
                .output(&repo.0, &["diff", "--", "tracked.txt"])
                .unwrap();
            assert!(String::from_utf8_lossy(&diff.stdout).contains("+new"));
            let staged = read
                .output(&repo.0, &["diff", "--cached", "--", "staged.txt"])
                .unwrap();
            assert!(String::from_utf8_lossy(&staged.stdout).contains("+staged version"));
            assert_eq!(fs::read(&index).unwrap(), original);
            assert_eq!(
                fs::metadata(&index).unwrap().modified().unwrap(),
                original_mtime,
                "remote reads never refresh the real index"
            );
        }
    }
    #[test]
    fn real_repo_filters_lfs_and_fsmonitor_never_execute() {
        let repo = Repo(
            std::env::temp_dir().join(format!("mythra-safe-read-test-{}", uuid::Uuid::new_v4())),
        );
        fs::create_dir(&repo.0).unwrap();
        git(&repo.0, &["init", "-q"]);
        git(&repo.0, &["config", "user.name", "Native test"]);
        git(&repo.0, &["config", "user.email", "native@example.invalid"]);
        fs::write(
            repo.0.join(".gitattributes"),
            "*.bin filter=evil diff=evil\n*.lfs filter=lfs diff=lfs\n",
        )
        .unwrap();
        fs::write(repo.0.join("a.bin"), "old\n").unwrap();
        fs::write(repo.0.join("a.lfs"),"version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 12\n").unwrap();
        git(&repo.0, &["add", "."]);
        git(&repo.0, &["commit", "-qm", "baseline"]);
        let marker = repo.0.join("PROGRAM-RAN");
        let quoted = marker
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        let evil = format!("echo PROGRAM-RAN > '{quoted}'; cat");
        let broken = format!("echo PROGRAM-RAN > '{quoted}'; exit 1");
        for (driver, value) in [("evil", evil.as_str()), ("lfs", evil.as_str())] {
            git(
                &repo.0,
                &["config", &format!("filter.{driver}.clean"), value],
            );
            git(
                &repo.0,
                &["config", &format!("filter.{driver}.smudge"), value],
            );
            git(
                &repo.0,
                &["config", &format!("filter.{driver}.process"), &broken],
            );
            git(
                &repo.0,
                &["config", &format!("filter.{driver}.required"), "true"],
            );
            git(
                &repo.0,
                &["config", &format!("diff.{driver}.textconv"), &broken],
            );
        }
        git(&repo.0, &["config", "core.fsmonitor", &broken]);
        git(&repo.0, &["config", "diff.external", &broken]);
        fs::write(repo.0.join("a.bin"), "new bytes\n").unwrap();
        fs::write(repo.0.join("a.lfs"),"version https://git-lfs.github.com/spec/v1\noid sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsize 42\n").unwrap();
        let _root_anchor = Anchor::open(&repo.0).unwrap();
        let _guard = enter();
        let read = crate::project_git::GitReadOperation::new();
        let status = read
            .output(
                &repo.0,
                &["status", "--porcelain=v1", "--untracked-files=all"],
            )
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(String::from_utf8_lossy(&status.stdout).contains("a.bin"));
        assert!(String::from_utf8_lossy(&status.stdout).contains("a.lfs"));
        // Mutate live config/attributes AFTER the first snapshot. A newly named
        // driver cannot evade an earlier filter enumeration because no live config
        // is used for subsequent worktree conversions either.
        git(&repo.0, &["config", "filter.newdriver.clean", &evil]);
        git(&repo.0, &["config", "filter.newdriver.process", &broken]);
        fs::write(
            repo.0.join(".gitattributes"),
            "*.bin filter=newdriver diff=evil\n*.lfs filter=lfs diff=lfs\n",
        )
        .unwrap();
        let diff = read
            .output(&repo.0, &["diff", "--", "a.bin", "a.lfs"])
            .unwrap();
        assert!(
            diff.status.success(),
            "{}",
            String::from_utf8_lossy(&diff.stderr)
        );
        assert!(String::from_utf8_lossy(&diff.stdout).contains("git-lfs.github.com/spec/v1"));
        assert!(
            !marker.exists(),
            "a read executed a repository-configured program"
        );
        // Negative control: these same live settings really DO execute a
        // program on the ordinary path, so an inert/malformed trap cannot pass.
        let _ = crate::process_launch::background_std_command("git")
            .current_dir(&repo.0)
            .args(["status", "--porcelain=v1"])
            .output()
            .unwrap();
        assert!(
            marker.exists(),
            "the malicious-config negative control did not execute"
        );
    }
}

#[cfg(all(test, unix))]
mod cwd_tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    #[test]
    fn snapshot_worktree_stays_on_the_opened_root_during_aba() {
        let temp = std::env::temp_dir().join(format!("mythra-git-aba-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temp).unwrap();
        let temp = temp.canonicalize().unwrap();
        let a = temp.join("approved");
        let b = temp.join("outside");
        let held = temp.join("held");
        fs::create_dir(&a).unwrap();
        git(&a, &["init", "-q"]);
        git(&a, &["config", "user.name", "Test"]);
        git(&a, &["config", "user.email", "test@example.invalid"]);
        fs::write(a.join("a.txt"), "baseline\n").unwrap();
        git(&a, &["add", "a.txt"]);
        git(&a, &["commit", "-qm", "baseline"]);
        git(
            &temp,
            &[
                "clone",
                "-q",
                "--no-hardlinks",
                a.to_str().unwrap(),
                b.to_str().unwrap(),
            ],
        );
        fs::write(a.join("a.txt"), "APPROVED change\n").unwrap();
        fs::write(b.join("a.txt"), "OUTSIDE change\n").unwrap();
        let anchor = Anchor::open(&a).unwrap();
        let policy = enter();
        let read = crate::project_git::GitReadOperation::new();
        read.output(&anchor.git_cwd(), &["status", "--porcelain=v1"])
            .unwrap();
        let cwd = anchor.git_cwd();
        fs::rename(&a, &held).unwrap();
        fs::rename(&b, &a).unwrap();
        let result = read.output(&cwd, &["diff", "--", "a.txt"]);
        fs::rename(&a, &b).unwrap();
        fs::rename(&held, &a).unwrap();
        anchor.validate().unwrap();
        let output = result.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        drop(policy);
        drop(anchor);
        fs::remove_dir_all(temp).unwrap();
        assert!(text.contains("APPROVED change"), "{text}");
        assert!(
            !text.contains("OUTSIDE change"),
            "GIT_WORK_TREE bypassed the pinned cwd: {text}"
        );
    }
}
