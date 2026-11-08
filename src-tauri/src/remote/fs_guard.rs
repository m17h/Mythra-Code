//! Handle-anchored, bounded directory reads. Filenames are data, not paths.
use serde::Serialize;
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
fn denied() -> String {
    "The other device couldn't safely open that folder or file.".into()
}
pub(super) fn leaf(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 512
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| c.is_control() || "\\/:<>\"|?*".contains(c))
        && !name.ends_with(['.', ' '])
        && !matches!(
            name.to_ascii_lowercase().as_str(),
            ".git" | ".kiwi" | ".mythra" | ".codex" | "codex-home" | ".ssh" | ".aws"
        )
        && !{
            let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
            matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                || (stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && stem.as_bytes()[3].is_ascii_digit())
        }
}
pub(super) fn relative(path: &str, empty: bool) -> Result<Vec<&str>, String> {
    if path.is_empty() && empty {
        return Ok(Vec::new());
    }
    let parts: Vec<_> = path.split('/').collect();
    if path.len() > 4096 || parts.len() > 32 || parts.iter().any(|name| !leaf(name)) {
        return Err(denied());
    }
    Ok(parts)
}
#[derive(Serialize)]
pub(super) struct Entry {
    pub(super) name: String,
    pub(super) kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) size: Option<u64>,
}
#[cfg(unix)]
type AnchorFile = std::sync::Arc<File>;
#[cfg(not(unix))]
type AnchorFile = File;
#[cfg(unix)]
thread_local! {static GIT_PINS:std::cell::RefCell<Vec<(PathBuf,std::sync::Weak<File>)>>=const{std::cell::RefCell::new(Vec::new())};}
/// Weak registrations cannot retain files beyond their owning read. Several
/// live anchors may name one inode; conflicting identities fail closed.
#[cfg(unix)]
fn track_git_anchor(anchor: &Anchor) -> Result<(), String> {
    GIT_PINS.with(|pins| {
        let mut pins = pins.borrow_mut();
        pins.retain(|(_, file)| file.strong_count() > 0);
        if pins.len() >= 128 {
            return Err(denied());
        }
        pins.push((anchor.path.clone(), std::sync::Arc::downgrade(&anchor.file)));
        Ok(())
    })
}
/// Last parent-side step before Git spawn. Command.current_dir is only a label;
/// the child changes to the already-opened directory, not whatever occupies
/// that pathname later. The closure owns the fd through fork/spawn/exec.
pub(crate) fn prepare_git_cwd(command: &mut std::process::Command) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        let Some(cwd) = command.get_current_dir() else {
            return Ok(());
        };
        let pins = GIT_PINS.with(|pins| {
            let mut pins = pins.borrow_mut();
            pins.retain(|(_, file)| file.strong_count() > 0);
            pins.iter()
                .filter_map(|(path, file)| file.upgrade().map(|file| (path.clone(), file)))
                .collect::<Vec<_>>()
        });
        let mut candidates: Vec<_> = pins
            .iter()
            .filter(|(path, _)| path == cwd)
            .map(|(_, file)| file.clone())
            .collect();
        if candidates.is_empty() && super::safe_git::active() {
            // Legacy helpers can canonicalize a renamed root into a new label.
            // Match its inode to a live pin, never reopen that label as authority.
            use std::os::unix::fs::MetadataExt;
            let meta = fs::metadata(cwd).map_err(|_| denied())?;
            for (_, file) in &pins {
                let open = file.metadata().map_err(|_| denied())?;
                if open.dev() == meta.dev() && open.ino() == meta.ino() {
                    candidates.push(file.clone());
                }
            }
            if candidates.is_empty() {
                return Err(denied());
            }
        }
        let Some(file) = candidates.first().cloned() else {
            return Ok(());
        };
        let expected = identity(&file)?;
        for other in &candidates {
            if identity(other)? != expected {
                return Err(denied());
            }
        }
        // std performs its pathname chdir BEFORE pre_exec. Use a stable initial
        // directory so removing/renaming the old name cannot select a new root.
        command.current_dir("/");
        unsafe {
            command.pre_exec(move || {
                if libc::fchdir(file.as_raw_fd()) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }
    #[cfg(not(unix))]
    let _ = command;
    Ok(())
}
pub(super) struct Anchor {
    pub(super) path: PathBuf,
    requested: PathBuf,
    file: AnchorFile,
    #[cfg(windows)]
    parents: Vec<File>,
}
#[cfg(unix)]
fn open_child(parent: &File, name: &str, directory: bool) -> Result<File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name).map_err(|_| denied())?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(denied());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
#[cfg(windows)]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut std::ffi::c_void,
            path: *mut u16,
            len: u32,
            flags: u32,
        ) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if count == 0 || count as usize >= buffer.len() {
        return Err(denied());
    }
    buffer.truncate(count as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
}
#[cfg(windows)]
fn windows_open(path: &Path, directory: bool, retained: bool) -> Result<File, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(if retained { 7 } else { 3 })
        .custom_flags(0x00200000 | if directory { 0x02000000 } else { 0 })
        .open(path)
        .map_err(|_| denied())?;
    let meta = file.metadata().map_err(|_| denied())?;
    if meta.file_attributes() & 0x400 != 0
        || directory && !meta.is_dir()
        || !directory && !meta.is_file()
    {
        return Err(denied());
    }
    Ok(file)
}
pub(super) fn identity(file: &File) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().map_err(|_| denied())?;
        return Ok(format!("{}:{}", meta.dev(), meta.ino()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(denied());
        }
        return Ok(format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ));
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err(denied())
    }
}
impl Anchor {
    pub(super) fn open(root: &Path) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err(denied());
        }
        let path = fs::canonicalize(root).map_err(|_| denied())?;
        let expected = fs::metadata(&path).map_err(|_| denied())?;
        if !expected.is_dir() {
            return Err(denied());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            let mut file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open("/")
                .map_err(|_| denied())?;
            for component in path.components() {
                match component {
                    Component::RootDir => {}
                    Component::Normal(name) => {
                        file = open_child(&file, name.to_str().ok_or_else(denied)?, true)?;
                    }
                    _ => return Err(denied()),
                }
            }
            let actual = file.metadata().map_err(|_| denied())?;
            if actual.dev() != expected.dev() || actual.ino() != expected.ino() {
                return Err(denied());
            }
            let anchor = Self {
                path,
                file: std::sync::Arc::new(file),
                requested: root.to_path_buf(),
            };
            track_git_anchor(&anchor)?;
            return Ok(anchor);
        }
        #[cfg(windows)]
        {
            let mut parents = Vec::new();
            let mut prefix = PathBuf::new();
            for component in path.components() {
                prefix.push(component.as_os_str());
                if matches!(component, Component::Prefix(_)) {
                    continue;
                }
                let file = windows_open(&prefix, true, false)?;
                if opened_path(&file)? != prefix {
                    return Err(denied());
                }
                parents.push(file);
            }
            let file = parents.pop().ok_or_else(denied)?;
            return Ok(Self {
                path,
                requested: root.to_path_buf(),
                file,
                parents,
            });
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err(denied())
        }
    }
    pub(super) fn identity(&self) -> Result<String, String> {
        identity(&self.file)
    }
    pub(super) fn retained(&self) -> Result<File, String> {
        #[cfg(windows)]
        {
            let file = windows_open(&self.path, true, true)?;
            if identity(&file)? != self.identity()? || opened_path(&file)? != self.path {
                return Err(denied());
            }
            Ok(file)
        }
        #[cfg(not(windows))]
        {
            self.file.try_clone().map_err(|_| denied())
        }
    }
    pub(super) fn validate(&self) -> Result<(), String> {
        let current = Self::open(&self.requested)?;
        if current.identity()? != self.identity()? {
            return Err(denied());
        }
        Ok(())
    }
    pub(super) fn directory(&self, path: &str) -> Result<Self, String> {
        let parts = relative(path, true)?;
        let mut current = Self::open(&self.requested)?;
        if current.identity()? != self.identity()? {
            return Err(denied());
        }
        for part in parts {
            current.validate()?;
            #[cfg(unix)]
            {
                let file = open_child(&current.file, part, true)?;
                current = Self {
                    path: current.path.join(part),
                    requested: current.requested.join(part),
                    file: std::sync::Arc::new(file),
                };
            }
            #[cfg(windows)]
            {
                let path = current.path.join(part);
                let file = windows_open(&path, true, false)?;
                if opened_path(&file)? != path {
                    return Err(denied());
                }
                let mut parents = current.parents;
                parents.push(current.file);
                current = Self {
                    path,
                    requested: current.requested.join(part),
                    file,
                    parents,
                };
            }
        }
        current.validate()?;
        #[cfg(unix)]
        track_git_anchor(&current)?;
        Ok(current)
    }
    pub(super) fn regular(&self, name: &str) -> Result<File, String> {
        if !leaf(name) {
            return Err(denied());
        }
        #[cfg(unix)]
        {
            let file = open_child(&self.file, name, false)?;
            if !file.metadata().map_err(|_| denied())?.is_file() {
                return Err(denied());
            }
            Ok(file)
        }
        #[cfg(windows)]
        {
            let path = self.path.join(name);
            let file = windows_open(&path, false, false)?;
            if opened_path(&file)? != path {
                return Err(denied());
            }
            Ok(file)
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err(denied())
        }
    }
    pub(super) fn read(&self, path: &str, maximum: usize) -> Result<(Vec<u8>, bool), String> {
        let parts = relative(path, false)?;
        let parent = self.directory(&parts[..parts.len() - 1].join("/"))?;
        parent.validate()?;
        let mut file = parent.regular(parts[parts.len() - 1])?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| denied())?;
        let truncated = bytes.len() > maximum;
        bytes.truncate(maximum);
        parent.validate()?;
        self.validate()?;
        Ok((bytes, truncated))
    }
    fn names(&self) -> Result<Vec<String>, String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut names = Vec::new();
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let fd = unsafe { libc::dup(self.file.as_raw_fd()) };
            if fd < 0 {
                return Err(denied());
            }
            let dir = unsafe { libc::fdopendir(fd) };
            if dir.is_null() {
                unsafe { libc::close(fd) };
                return Err(denied());
            }
            struct Close(*mut libc::DIR);
            impl Drop for Close {
                fn drop(&mut self) {
                    unsafe { libc::closedir(self.0) };
                }
            }
            let _close = Close(dir);
            unsafe { libc::rewinddir(dir) };
            let mut scanned = 0;
            loop {
                if Instant::now() > deadline || scanned >= 10000 {
                    return Err("This folder has too many entries to browse safely.".into());
                }
                let entry = unsafe { libc::readdir(dir) };
                if entry.is_null() {
                    break;
                }
                scanned += 1;
                let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
                if let Ok(name) = name.to_str() {
                    if leaf(name) {
                        names.push(name.to_owned());
                    }
                }
            }
        }
        #[cfg(windows)]
        {
            let mut scanned = 0;
            for entry in fs::read_dir(&self.path).map_err(|_| denied())? {
                if Instant::now() > deadline || scanned >= 10000 {
                    return Err("This folder has too many entries to browse safely.".into());
                }
                scanned += 1;
                if let Ok(entry) = entry {
                    if let Some(name) = entry.file_name().to_str() {
                        if leaf(name) {
                            names.push(name.to_owned());
                        }
                    }
                }
            }
        }
        names.sort();
        names.dedup();
        Ok(names)
    }
    pub(super) fn directories(&self) -> Result<Vec<String>, String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut result = Vec::new();
        for name in self.names()? {
            if Instant::now() > deadline {
                return Err(denied());
            }
            if self.directory(&name).is_ok() {
                result.push(name);
            }
        }
        self.validate()?;
        Ok(result)
    }
    pub(super) fn entries(&self) -> Result<Vec<Entry>, String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut entries = Vec::new();
        for name in self.names()? {
            if Instant::now() > deadline {
                return Err(denied());
            }
            if self.directory(&name).is_ok() {
                entries.push(Entry {
                    name,
                    kind: "directory",
                    size: None,
                });
            } else if let Ok(file) = self.regular(&name) {
                entries.push(Entry {
                    name,
                    kind: "file",
                    size: file.metadata().ok().map(|meta| meta.len()),
                });
            }
        }
        self.validate()?;
        Ok(entries)
    }
    pub(super) fn git_cwd(&self) -> PathBuf {
        // Only a lookup key. prepare_git_cwd pins the Unix child to self.file;
        // never turn a directory fd back into a racy F_GETPATH pathname.
        // On Windows self.file and every ancestor stay open without DELETE
        // sharing while this anchor lives, so replacement is prevented there.
        self.path.clone()
    }
}

/// Exclusive creation in an already-opened directory, used only by the host's
/// private upload store. The caller chooses an unpredictable leaf, never LAN data.
pub(super) fn create_new(anchor:&Anchor,name:&str)->Result<File,String>{
    if !leaf(name){return Err(denied());}anchor.validate()?;
    #[cfg(unix)] {use std::os::fd::{AsRawFd,FromRawFd};let name=std::ffi::CString::new(name).map_err(|_|denied())?;let fd=unsafe{libc::openat(anchor.file.as_raw_fd(),name.as_ptr(),libc::O_WRONLY|libc::O_CREAT|libc::O_EXCL|libc::O_NOFOLLOW|libc::O_CLOEXEC,0o600)};if fd<0{return Err(denied());}Ok(unsafe{File::from_raw_fd(fd)})}
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;fs::OpenOptions::new().write(true).create_new(true).share_mode(3).custom_flags(0x00200000).open(anchor.path.join(name)).map_err(|_|denied())}
    #[cfg(not(any(unix,windows)))] {Err(denied())}
}
pub(super) fn append_file(anchor:&Anchor,name:&str)->Result<File,String>{
    if !leaf(name){return Err(denied());}anchor.validate()?;
    #[cfg(unix)] {use std::os::fd::{AsRawFd,FromRawFd};let name=std::ffi::CString::new(name).map_err(|_|denied())?;let fd=unsafe{libc::openat(anchor.file.as_raw_fd(),name.as_ptr(),libc::O_WRONLY|libc::O_APPEND|libc::O_NOFOLLOW|libc::O_CLOEXEC|libc::O_NONBLOCK)};if fd<0{return Err(denied());}let file=unsafe{File::from_raw_fd(fd)};if !file.metadata().map_err(|_|denied())?.is_file(){return Err(denied());}Ok(file)}
    #[cfg(windows)] {use std::os::windows::fs::{OpenOptionsExt,MetadataExt};let file=fs::OpenOptions::new().append(true).share_mode(3).custom_flags(0x00200000).open(anchor.path.join(name)).map_err(|_|denied())?;let meta=file.metadata().map_err(|_|denied())?;if !meta.is_file()||meta.file_attributes()&0x400!=0{return Err(denied());}Ok(file)}
    #[cfg(not(any(unix,windows)))] {Err(denied())}
}

#[cfg(all(test, unix))]
mod spawn_tests {
    use super::*;
    #[test]
    fn git_spawn_pins_cwd_across_an_aba_directory_swap() {
        use std::process::{Command, Stdio};
        let temp = std::env::temp_dir().join(format!("mythra-cwd-aba-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temp).unwrap();
        let temp = temp.canonicalize().unwrap();
        let approved = temp.join("approved");
        let outside = temp.join("outside");
        let held = temp.join("held");
        fs::create_dir(&approved).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(approved.join("marker"), "APPROVED").unwrap();
        fs::write(outside.join("marker"), "OUTSIDE").unwrap();
        let anchor = Anchor::open(&approved).unwrap();
        let mut command = Command::new("/bin/cat");
        command
            .arg("marker")
            .current_dir(anchor.git_cwd())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // The attacker swaps AFTER cwd is derived, then restores before the
        // caller's identity check: this is exactly the failing ABA window.
        fs::rename(&approved, &held).unwrap();
        fs::rename(&outside, &approved).unwrap();
        // Negative control: the old pathname-based spawn reads the replacement,
        // despite the successful identity validation after restoration below.
        let unpinned = Command::new("/bin/cat")
            .arg("marker")
            .current_dir(&approved)
            .output()
            .unwrap();
        let (child, _scope) = crate::git_workspace::spawn_scoped_git(&mut command).unwrap();
        let output = child.wait_with_output().unwrap();
        fs::rename(&approved, &outside).unwrap();
        fs::rename(&held, &approved).unwrap();
        anchor.validate().unwrap();
        assert!(output.status.success());
        assert!(unpinned.status.success());
        assert_eq!(unpinned.stdout, b"OUTSIDE");
        let observed = String::from_utf8(output.stdout).unwrap();
        drop(command);
        drop(anchor);
        fs::remove_dir_all(temp).unwrap();
        assert_eq!(
            observed, "APPROVED",
            "post-validation alone allowed reading the replacement directory"
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::super::windows_tests::{git, junction, TempRoot};
    use super::*;

    #[test]
    fn windows_anchor_reads_unicode_bounds_and_blocks_ancestor_rename() {
        let temp = TempRoot::new("anchors");
        let parent = temp.0.join("é parent & spaces");
        let root = parent.join("project");
        fs::create_dir_all(root.join("child")).unwrap();
        fs::write(root.join("child").join("hello.txt"), b"approved").unwrap();
        let expected = git(&root, &["hash-object", "--no-filters", "child/hello.txt"]).stdout;
        let anchor = Anchor::open(&root).expect("open real Windows directory handles");
        let retained = anchor.retained().unwrap();
        assert_eq!(identity(&retained).unwrap(), anchor.identity().unwrap());
        assert!(anchor.git_cwd().is_absolute());
        anchor.validate().unwrap();
        assert_eq!(
            anchor.read("child/hello.txt", 4).unwrap(),
            (b"appr".to_vec(), true)
        );
        assert!(
            fs::rename(&root, parent.join("moved-project")).is_err(),
            "root is held without DELETE sharing"
        );
        assert!(
            fs::rename(&parent, temp.0.join("moved-parent")).is_err(),
            "every ancestor is held too"
        );
        let worker = std::thread::spawn(move || {
            let out = git(
                &anchor.git_cwd(),
                &["hash-object", "--no-filters", "child/hello.txt"],
            );
            assert!(out.status.success());
            assert_eq!(out.stdout, expected);
            anchor.validate().unwrap();
        });
        worker.join().unwrap();
        drop(retained);
        fs::rename(&root, parent.join("moved-project"))
            .expect("rename works once anchor lifetime ends");
    }

    #[test]
    fn windows_anchor_refuses_junction_children_and_alternate_data_streams() {
        let temp = TempRoot::new("junctions");
        let root = temp.0.join("project");
        let outside = temp.0.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"outside fixture").unwrap();
        let link = root.join("escape");
        junction(&link, &outside);
        let anchor = Anchor::open(&root).unwrap();
        assert!(anchor.directory("escape").is_err());
        assert!(anchor.read("escape/secret.txt", 1024).is_err());
        assert!(!anchor.entries().unwrap().iter().any(|e| e.name == "escape"));
        fs::write(root.join("base.txt"), b"base").unwrap();
        fs::write(root.join("base.txt:hidden"), b"hidden fixture").expect("NTFS ADS fixture");
        for path in [
            "../outside/secret.txt",
            "base.txt:hidden",
            r"C:\Windows\win.ini",
            r"\\server\share",
            r"\\?\C:\Windows",
            r"child\file",
            "NUL",
            "CON.txt",
            "com1.txt",
            "file.",
            "file ",
        ] {
            assert!(
                anchor.read(path, 1024).is_err(),
                "untrusted non-relative or special path accepted"
            );
        }
        drop(anchor);
        fs::remove_dir(&link).expect("remove only the junction, not its target");
        assert!(outside.join("secret.txt").exists());
    }

    #[test]
    fn windows_private_upload_creation_is_exclusive_and_pins_append_handles() {
        use std::io::Write;
        let temp = TempRoot::new("private-writes");
        let anchor = Anchor::open(&temp.0).unwrap();
        let mut created = create_new(&anchor, "chunk.bin").unwrap();
        created.write_all(b"one").unwrap();
        drop(created);
        assert!(create_new(&anchor, "chunk.bin").is_err());
        let mut append = append_file(&anchor, "chunk.bin").unwrap();
        append.write_all(b"two").unwrap();
        assert!(fs::rename(temp.0.join("chunk.bin"), temp.0.join("other.bin")).is_err());
        drop(append);
        assert_eq!(anchor.read("chunk.bin", 32).unwrap().0, b"onetwo");
        assert!(create_new(&anchor, "chunk.bin:ads").is_err());
        assert!(append_file(&anchor, "../outside").is_err());
    }

    #[test]
    fn windows_anchor_supports_verbatim_long_paths() {
        let temp = TempRoot::new("long-path");
        let mut path = fs::canonicalize(&temp.0).unwrap();
        for _ in 0..10 {
            path.push("long directory é segment");
        }
        fs::create_dir_all(&path).expect("create long path through Windows verbatim prefix");
        fs::write(path.join("test.txt"), b"long").unwrap();
        let anchor = Anchor::open(&path).expect("anchor long Windows path");
        assert_eq!(anchor.read("test.txt", 16).unwrap().0, b"long");
    }
}
