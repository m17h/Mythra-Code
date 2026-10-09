//! Bounded project-file previews. Full attachment reads remain independent.
use std::{fs, path::Path};

use serde::Serialize;

const PREVIEW_BYTES: usize = 250_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilePreview {
    text: String,
    truncated: bool,
    binary: bool,
}

fn preview_sync(root: &str, path: &str) -> Result<FilePreview, String> {
    let root = Path::new(root);
    let selected = Path::new(path);
    if !root.is_absolute() || !selected.is_absolute() {
        return Err("File previews require an absolute project folder and file path".into());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if !root.is_dir() {
        return Err("The project folder is not a directory".into());
    }
    // Resolve existing in-project links, then let the anchored reader reject
    // parent/file replacements. A selected link outside the project is never
    // read. Explicit attachment delivery still uses its original selected path.
    let selected = fs::canonicalize(selected)
        .map_err(|error| format!("Could not open the selected file: {error}"))?;
    let relative = selected
        .strip_prefix(&root)
        .map_err(|_| "The selected file is outside the project folder")?
        .to_str()
        .ok_or("The selected filename cannot be previewed")?;
    // Reuse the cross-platform opened-handle scope checks and nonregular-file
    // rejection already used by Git inspection. Disk reading is bounded to
    // 512 KiB + one sentinel byte; only this smaller text prefix crosses IPC.
    let (mut bytes, source_truncated) =
        crate::git_inspection::safe_untracked_preview(&root, relative)?;
    let truncated = source_truncated || bytes.len() > PREVIEW_BYTES;
    bytes.truncate(PREVIEW_BYTES);
    let binary = |truncated| FilePreview {
        text: String::new(),
        truncated,
        binary: true,
    };
    if bytes.contains(&0) {
        return Ok(binary(truncated));
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_owned(),
        // A clipped UTF-8 character is not evidence of a binary file. Retain
        // complete characters only; invalid bytes inside the prefix stay binary.
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|error| error.to_string())?
                .to_owned()
        }
        Err(_) => return Ok(binary(truncated)),
    };
    Ok(FilePreview {
        text,
        truncated,
        binary: false,
    })
}

#[tauri::command]
pub(super) async fn preview_project_file(
    root: String,
    path: String,
) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || preview_sync(&root, &path))
        .await
        .map_err(|error| format!("Could not finish the file preview: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("mythra-file-preview-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn preview(&self, name: &str) -> Result<FilePreview, String> {
            preview_sync(
                self.0.to_str().unwrap(),
                self.0.join(name).to_str().unwrap(),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn bounded_prefix_of_large_file_without_changing_original() {
        let fixture = Fixture::new();
        let path = fixture.0.join("large.txt");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(&vec![b'a'; 512 * 1024 + 1]).unwrap();
        file.set_len(64 * 1024 * 1024).unwrap();
        drop(file);
        let preview = fixture.preview("large.txt").unwrap();
        assert_eq!(preview.text, "a".repeat(PREVIEW_BYTES));
        assert!(preview.truncated && !preview.binary);
        assert_eq!(fs::metadata(path).unwrap().len(), 64 * 1024 * 1024);
    }

    #[test]
    fn complete_small_utf8_and_empty_files_are_unchanged() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("utf8.txt"), "hello café 🦀\n").unwrap();
        let preview = fixture.preview("utf8.txt").unwrap();
        assert_eq!(preview.text, "hello café 🦀\n");
        assert!(!preview.truncated && !preview.binary);
        fs::write(fixture.0.join("empty.txt"), "").unwrap();
        let preview = fixture.preview("empty.txt").unwrap();
        assert_eq!(preview.text, "");
        assert!(!preview.truncated && !preview.binary);
    }

    #[test]
    fn clipping_inside_utf8_character_keeps_only_complete_characters() {
        let fixture = Fixture::new();
        let text = format!("{}🦀tail", "a".repeat(PREVIEW_BYTES - 1));
        fs::write(fixture.0.join("boundary.txt"), text).unwrap();
        let preview = fixture.preview("boundary.txt").unwrap();
        assert_eq!(preview.text, "a".repeat(PREVIEW_BYTES - 1));
        assert!(preview.truncated && !preview.binary);
    }

    #[test]
    fn invalid_utf8_and_nul_are_binary() {
        let fixture = Fixture::new();
        for (name, bytes) in [
            ("invalid", vec![0xff]),
            ("nul-bytes.bin", vec![b'a', 0]),
            ("incomplete", vec![0xe2, 0x82]),
        ] {
            fs::write(fixture.0.join(name), bytes).unwrap();
            let preview = fixture.preview(name).unwrap();
            assert!(preview.binary && preview.text.is_empty() && !preview.truncated);
        }
    }

    #[test]
    fn exact_limit_is_not_truncated() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("exact.txt"), vec![b'a'; PREVIEW_BYTES]).unwrap();
        let preview = fixture.preview("exact.txt").unwrap();
        assert_eq!(preview.text.len(), PREVIEW_BYTES);
        assert!(!preview.truncated);
    }

    #[test]
    fn rejects_outside_missing_nonregular_and_relative_paths() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("secret.txt"), "PRIVATE CONTENT").unwrap();
        assert!(preview_sync(
            fixture.0.to_str().unwrap(),
            outside.0.join("secret.txt").to_str().unwrap()
        )
        .unwrap_err()
        .contains("outside"));
        assert!(fixture.preview("missing.txt").is_err());
        fs::create_dir(fixture.0.join("folder")).unwrap();
        assert!(fixture.preview("folder").is_err());
        assert!(preview_sync("relative", "relative/file").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn in_project_symlinks_work_and_outside_links_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::write(fixture.0.join("inside.txt"), "inside").unwrap();
        fs::write(outside.0.join("outside.txt"), "PRIVATE CONTENT").unwrap();
        symlink("inside.txt", fixture.0.join("inside-link.txt")).unwrap();
        symlink(
            outside.0.join("outside.txt"),
            fixture.0.join("outside-link.txt"),
        )
        .unwrap();
        assert_eq!(fixture.preview("inside-link.txt").unwrap().text, "inside");
        assert!(fixture
            .preview("outside-link.txt")
            .unwrap_err()
            .contains("outside"));
    }

    #[cfg(windows)]
    #[test]
    fn case_variant_selected_path_resolves_to_the_project_file() {
        let fixture = Fixture::new();
        let path = fixture.0.join("MixedCase.txt");
        fs::write(&path, "inside mixed-case file").unwrap();
        let preview = preview_sync(
            fixture.0.to_str().unwrap(),
            &path.to_str().unwrap().to_ascii_uppercase(),
        )
        .unwrap();
        assert_eq!(preview.text, "inside mixed-case file");
        assert!(!preview.binary && !preview.truncated);
    }
}
