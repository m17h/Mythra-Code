//! Host-owned Git metadata, not executable configuration. No pack copies and no
//! subprocesses for checkout identity. Only sanitized inert config is cached.
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Instant, SystemTime},
};
fn failed() -> String {
    "Remote Git could not read this repository's metadata. Refresh and try again.".into()
}
#[derive(Clone)]
pub(super) struct Locations {
    pub git: PathBuf,
    pub common: PathBuf,
}
fn text(path: &Path, limit: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| failed())?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failed())?;
    if bytes.len() > limit {
        return Err(failed());
    }
    String::from_utf8(bytes).map_err(|_| failed())
}
pub(super) fn locations(root: &Path) -> Result<Locations, String> {
    let marker = root.join(".git");
    let git = if marker.is_dir() {
        marker
    } else {
        let value = text(&marker, 8192)?;
        let path = value
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("gitdir: ")
            .ok_or_else(failed)?;
        let path = Path::new(path);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        }
    };
    let git = fs::canonicalize(git).map_err(|_| failed())?;
    let common = if git.join("commondir").is_file() {
        let value = text(&git.join("commondir"), 8192)?;
        let path = Path::new(value.trim_end_matches(['\r', '\n']));
        fs::canonicalize(if path.is_absolute() {
            path.to_path_buf()
        } else {
            git.join(path)
        })
        .map_err(|_| failed())?
    } else {
        git.clone()
    };
    if !git.join("HEAD").is_file() || !common.join("objects").is_dir() {
        return Err(failed());
    }
    Ok(Locations { git, common })
}
fn oid(value: &str) -> Option<String> {
    let value = value.trim();
    (matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| value.to_owned())
}
pub(super) fn head(loc: &Locations) -> Result<(Option<String>, Option<String>), String> {
    let source = text(&loc.git.join("HEAD"), 8192)?;
    let source = source.trim();
    if let Some(id) = oid(source) {
        return Ok((Some(id), None));
    }
    let reference = source
        .strip_prefix("ref: ")
        .filter(|r| {
            r.starts_with("refs/")
                && !r.split('/').any(|p| p.is_empty() || p == "." || p == "..")
                && !r.contains(['\\', '\0', '\n', '\r'])
        })
        .ok_or_else(failed)?;
    let branch = reference.strip_prefix("refs/heads/").map(str::to_owned);
    for base in [&loc.git, &loc.common] {
        if let Ok(value) = text(&base.join(reference), 8192) {
            if let Some(id) = oid(&value) {
                return Ok((Some(id), branch));
            }
        }
    }
    if let Ok(refs) = text(&loc.common.join("packed-refs"), 32 * 1024 * 1024) {
        for line in refs.lines() {
            if let Some((id, name)) = line.split_once(' ') {
                if name == reference {
                    return Ok((Some(oid(id).ok_or_else(failed)?), branch));
                }
            }
        }
    }
    // Unborn branch has no object yet. No object-resolving command or pager.
    Ok((None, branch))
}
#[derive(Clone, PartialEq, Eq)]
struct Stat {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    exists: bool,
}
fn stat(path: PathBuf) -> Stat {
    match fs::metadata(&path) {
        Ok(m) => Stat {
            path,
            len: m.len(),
            modified: m.modified().ok(),
            exists: true,
        },
        Err(_) => Stat {
            path,
            len: 0,
            modified: None,
            exists: false,
        },
    }
}
struct Cached {
    stats: Vec<Stat>,
    text: Arc<String>,
    touched: Instant,
}
fn cache() -> &'static Mutex<HashMap<PathBuf, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn dependencies(loc: &Locations) -> Vec<PathBuf> {
    let mut paths = vec![
        loc.common.join("config"),
        loc.git.join("config.worktree"),
        loc.git.join("index"),
        loc.git.join("HEAD"),
    ];
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        paths.push(home.join(".gitconfig"));
        paths.push(home.join(".config/git/config"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(xdg).join("git/config"));
    }
    for key in ["GIT_CONFIG_GLOBAL","GIT_CONFIG_SYSTEM"]{if let Some(path)=std::env::var_os(key){paths.push(PathBuf::from(path));}}
    paths
}
pub(super) fn config(repo: &Path, loc: &Locations) -> Result<Arc<String>, String> {
    let key = fs::canonicalize(repo).map_err(|_| failed())?;
    {
        let mut cache = cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(old) = cache.get_mut(&key) {
            if old.stats.iter().all(|s| stat(s.path.clone()) == *s) {
                old.touched = Instant::now();
                return Ok(old.text.clone());
            }
        }
    }
    let mut paths = dependencies(loc);
    let bytes = super::safe_git::probe(
        repo,
        &[
            "config",
            "--null",
            "--show-origin",
            "--get-regexp",
            r"^(extensions\.objectformat|include\.path|includeif\..*\.path|core\.(autocrlf|eol|ignorecase|filemode|symlinks|ignorestat|trustctime|checkstat|sparsecheckout|sparsecheckoutcone)|index\.sparse|branch\..*\.(remote|merge)|remote\..*\.fetch)$",
        ],
    )?;
    let fields: Vec<_> = bytes.split(|b| *b == 0).filter(|b| !b.is_empty()).collect();
    if fields.len() % 2 != 0 {
        return Err(failed());
    }
    let mut records = Vec::new();
    for fields in fields.chunks_exact(2) {
        let origin = std::str::from_utf8(fields[0]).map_err(|_| failed())?;
        let value = std::str::from_utf8(fields[1]).map_err(|_| failed())?;
        let (key, value) = value.split_once('\n').ok_or_else(failed)?;
        let origin = origin.strip_prefix("file:").map(PathBuf::from);
        if let Some(origin) = origin.as_ref() {
            paths.push(if origin.is_absolute() {
                origin.clone()
            } else {
                repo.join(origin)
            });
        }
        if key == "include.path" || key.starts_with("includeif.") {
            if let Some(origin) = origin {
                let target = if let Some(tail) = value.strip_prefix("~/") {
                    std::env::var_os("HOME")
                        .or_else(|| std::env::var_os("USERPROFILE"))
                        .map(|h| PathBuf::from(h).join(tail))
                } else {
                    let p = PathBuf::from(value);
                    Some(if p.is_absolute() {
                        p
                    } else {
                        repo.join(origin).parent().unwrap_or(repo).join(p)
                    })
                };
                if let Some(target) = target {
                    paths.push(target);
                }
            }
            continue;
        }
        records.push((key.to_owned(), value.to_owned()));
    }
    let sha256 = records
        .iter()
        .any(|(k, v)| k == "extensions.objectformat" && v == "sha256");
    let mut config=format!("[core]\n repositoryformatversion={}\n bare=false\n fsmonitor=false\n untrackedCache=false\n[diff]\n external=\n",if sha256{1}else{0});
    if sha256 {
        config.push_str("[extensions]\n objectformat=sha256\n");
    }
    for (key, value) in records {
        if key == "extensions.objectformat" {
            continue;
        }
        if matches!(
            key.as_str(),
            "core.autocrlf"
                | "core.eol"
                | "core.ignorecase"
                | "core.filemode"
                | "core.symlinks"
                | "core.ignorestat"
                | "core.trustctime"
                | "core.checkstat"
                | "core.sparsecheckout"
                | "core.sparsecheckoutcone"
                | "index.sparse"
        ) {
            if value.len() > 32
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err(failed());
            }
            let (section, key) = key.split_once('.').ok_or_else(failed)?;
            config.push_str(&format!("[{section}]\n {key}={value}\n"));
            continue;
        }
        let (prefix, field) = key.rsplit_once('.').ok_or_else(failed)?;
        let (section, name) = prefix.split_once('.').ok_or_else(failed)?;
        if !matches!(
            (section, field),
            ("branch", "remote" | "merge") | ("remote", "fetch")
        ) || name.len() > 512
            || value.len() > 4096
            || name.chars().any(char::is_control)
            || value.chars().any(char::is_control)
        {
            return Err(failed());
        }
        let quote = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        config.push_str(&format!(
            "[{section} \"{}\"]\n {field}=\"{}\"\n",
            quote(name),
            quote(&value)
        ));
    }
    paths.sort();
    paths.dedup();
    let stats = paths.into_iter().map(stat).collect();
    let config = Arc::new(config);
    let mut cache = cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if cache.len() >= 64 && !cache.contains_key(&key) {
        if let Some(old) = cache
            .iter()
            .min_by_key(|(_, e)| e.touched)
            .map(|(k, _)| k.clone())
        {
            cache.remove(&old);
        }
    }
    cache.insert(
        key,
        Cached {
            stats,
            text: config.clone(),
            touched: Instant::now(),
        },
    );
    Ok(config)
}

#[cfg(test)]
pub(super) fn invalidate(repo: &Path) {
    if let Ok(key) = fs::canonicalize(repo) {
        cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&key);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn git(path: &Path, args: &[&str]) {
        let output = crate::process_launch::background_std_command("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn inert_cache_invalidates_on_config_index_and_included_file_stats() {
        let path =
            std::env::temp_dir().join(format!("mythra-git-config-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        git(&path, &["init", "-q"]);
        let loc = locations(&path).unwrap();
        let include = path.join("extra-config");
        fs::write(
            &include,
            "[core]\n filemode=false\n[filter \"evil\"]\n process=do-not-copy-me\n",
        )
        .unwrap();
        git(
            &path,
            &["config", "include.path", include.to_str().unwrap()],
        );
        let _root = super::super::fs_guard::Anchor::open(&path).unwrap();
        let _policy = super::super::safe_git::enter();
        let first = config(&path, &loc).unwrap();
        assert!(first.contains("filemode=false"), "{first}");
        assert!(!first.contains("do-not-copy-me"));
        let count = super::super::safe_git::spawn_count();
        assert_eq!(count, 1);
        assert_eq!(config(&path, &loc).unwrap(), first);
        assert_eq!(super::super::safe_git::spawn_count(), count);
        fs::write(&include, "[core]\n filemode=true\n").unwrap();
        assert!(config(&path, &loc).unwrap().contains("filemode=true"));
        assert_eq!(super::super::safe_git::spawn_count(), count + 1);
        fs::write(loc.git.join("index"), "new-index-stat").unwrap();
        config(&path, &loc).unwrap();
        assert_eq!(super::super::safe_git::spawn_count(), count + 2);
        git(&path, &["config", "core.ignorecase", "true"]);
        assert!(config(&path, &loc).unwrap().contains("ignorecase=true"));
        assert_eq!(super::super::safe_git::spawn_count(), count + 3);
        let source=loc.common.join("config");let before=stat(source.clone());let text=fs::read_to_string(&source).unwrap();let changed=text.replace("ignorecase = true","ignorecase = TRUE");assert_eq!(text.len(),changed.len());assert_ne!(text,changed);fs::write(&source,changed).unwrap();let file=fs::OpenOptions::new().write(true).open(&source).unwrap();file.set_times(fs::FileTimes::new().set_modified(before.modified.unwrap()+std::time::Duration::from_secs(2))).unwrap();config(&path,&loc).unwrap();assert_eq!(super::super::safe_git::spawn_count(),count+4);

        drop(file);
        drop(_policy);
        #[cfg(windows)]{
            // Causal positive control: this TEST-OWNED anchor intentionally denies
            // delete-sharing. The policy/cache cannot release somebody else's pin.
            let moved=path.with_extension("released");assert!(fs::rename(&path,&moved).is_err());drop(_root);
            // The cache and its returned Arc<String> are still alive here.
            fs::rename(&path,&moved).expect("dropping the exact test root releases its Windows delete lock");fs::rename(&moved,&path).unwrap();
        }
        #[cfg(not(windows))]drop(_root);
        invalidate(&path);
        fs::remove_dir_all(path).unwrap();
    }
}
