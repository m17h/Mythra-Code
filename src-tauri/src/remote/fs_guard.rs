//! Handle-anchored, bounded directory reads. Filenames are data, not paths.
use serde::Serialize;
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
fn denied() -> String {
    "The host could not safely open that folder or file.".into()
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
pub(super) struct Anchor {
    pub(super) path: PathBuf,
    requested: PathBuf,
    file: File,
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
            return Ok(Self {
                path,
                file,
                requested: root.to_path_buf(),
            });
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
                    file,
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
        // macOS won't start a process inside /dev/fd/N. It can name what an open
        // folder is right now, which keeps the same "this exact folder" promise.
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            let mut name = [0u8; libc::PATH_MAX as usize];
            if unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_GETPATH, name.as_mut_ptr()) } == 0 {
                if let Ok(path) = std::ffi::CStr::from_bytes_until_nul(&name).map(|name| name.to_string_lossy()) {
                    return PathBuf::from(path.as_ref());
                }
            }
            self.path.clone()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            use std::os::fd::AsRawFd;
            PathBuf::from(format!("/dev/fd/{}", self.file.as_raw_fd()))
        }
        #[cfg(not(unix))]
        {
            self.path.clone()
        }
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
