//! A private immutable object namespace. Never hand Git an original object path
//! or a live alternates file: directory validation after a read cannot undo a leak.
use super::fs_guard::Anchor;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};
const MAX_FILES: usize = 100_000;
const MAX_LOGICAL: u64 = 8 * 1024 * 1024 * 1024;
const MAX_COPIED: u64 = 512 * 1024 * 1024;
fn denied() -> String {
    "The host couldn't safely snapshot this project's Git data. Open the project on the host and try again.".into()
}
struct Budget {
    files: usize,
    logical: u64,
    copied: u64,
    deadline: Instant,
}
fn hex(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_hexdigit())
}
fn pack_file(name: &str) -> bool {
    let Some((base, extension)) = name.rsplit_once('.') else {
        return false;
    };
    let Some(hash) = base.strip_prefix("pack-") else {
        return false;
    };
    matches!(hash.len(), 40 | 64) && hex(hash) && matches!(extension, "pack" | "idx" | "rev")
}
/// Only the repository's own no-follow common-dir/objects is authorized. Borrowed
/// stores have no project authority proof; do not silently import another project.
pub(super) fn freeze(common: &Anchor, destination: &Path) -> Result<(), String> {
    let objects = common.directory("objects")?;
    if let Ok(info) = objects.directory("info") {
        if info
            .entries()?
            .iter()
            .any(|entry| entry.name == "alternates")
        {
            let mut file = info.regular("alternates")?;
            let mut bytes = Vec::new();
            std::io::Read::by_ref(&mut file)
                .take(65537)
                .read_to_end(&mut bytes)
                .map_err(|_| denied())?;
            if bytes.len() > 65536 || bytes.iter().any(|b| !b.is_ascii_whitespace()) {
                return Err("This project borrows Git data from another folder, which isn't shared by this permission. On the host, make a full, independent copy of the repository, then share that project instead.".into());
            }
        }
    }
    let mut budget = Budget {
        files: 0,
        logical: 0,
        copied: 0,
        deadline: Instant::now() + Duration::from_secs(8),
    };
    for entry in objects.entries()? {
        if entry.kind != "directory" {
            continue;
        }
        if entry.name.len() == 2 && hex(&entry.name) {
            let source = objects.directory(&entry.name)?;
            let dest = destination.join(&entry.name);
            fs::create_dir(&dest).map_err(|_| denied())?;
            for object in source.entries()? {
                if object.kind == "file"
                    && matches!(object.name.len(), 38 | 62)
                    && hex(&object.name)
                {
                    freeze_file(&source, &object.name, &dest, &mut budget)?;
                }
            }
            source.validate()?;
        } else if entry.name == "pack" {
            let source = objects.directory("pack")?;
            let dest = destination.join("pack");
            fs::create_dir(&dest).map_err(|_| denied())?;
            for object in source.entries()? {
                if object.kind == "file" && pack_file(&object.name) {
                    freeze_file(&source, &object.name, &dest, &mut budget)?;
                }
            }
            source.validate()?;
        }
    }
    objects.validate()?;
    common.validate()
}
fn freeze_file(
    source: &Anchor,
    name: &str,
    destination: &Path,
    budget: &mut Budget,
) -> Result<(), String> {
    if Instant::now() >= budget.deadline || budget.files >= MAX_FILES {
        return Err(denied());
    }
    let mut input = source.regular(name)?;
    let meta = input.metadata().map_err(|_| denied())?;
    let size = meta.len();
    budget.files += 1;
    budget.logical = budget
        .logical
        .checked_add(size)
        .filter(|n| *n <= MAX_LOGICAL)
        .ok_or_else(denied)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // Source fd, not its mutable pathname. APFS clone is a frozen CoW copy,
        // not a hard link whose contents could later change with the original.
        let dir = File::open(destination).map_err(|_| denied())?;
        let leaf = std::ffi::CString::new(name).map_err(|_| denied())?;
        if unsafe { libc::fclonefileat(input.as_raw_fd(), dir.as_raw_fd(), leaf.as_ptr(), 0) } == 0
        {
            return source.validate();
        }
    }
    budget.copied = budget
        .copied
        .checked_add(size)
        .filter(|n| *n <= MAX_COPIED)
        .ok_or_else(denied)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination.join(name))
        .map_err(|_| denied())?;
    let mut buffer = [0u8; 65536];
    let mut copied = 0u64;
    loop {
        if Instant::now() >= budget.deadline {
            return Err(denied());
        }
        let n = input.read(&mut buffer).map_err(|_| denied())?;
        if n == 0 {
            break;
        }
        copied = copied
            .checked_add(n as u64)
            .filter(|n| *n <= size)
            .ok_or_else(denied)?;
        output.write_all(&buffer[..n]).map_err(|_| denied())?;
    }
    if copied != size
        || input.metadata().map_err(|_| denied())?.modified().ok() != meta.modified().ok()
    {
        return Err(denied());
    }
    source.validate()
}
