//! Shared fixtures for Windows-native headless tests. No installed app/profile,
//! user project, real credential account or browser window is touched.
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

pub(super) struct TempRoot(pub(super) PathBuf);
impl TempRoot {
    pub(super) fn new(label: &str) -> Self {
        // Keep all filesystem fixtures inside the parent's approved checkout.
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("remote-windows-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create isolated Windows fixture");
        Self(path)
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn run(command: &mut Command) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start owned headless Windows fixture process");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if child.try_wait().expect("poll fixture child").is_some() {
            return child.wait_with_output().expect("reap fixture child");
        }
        if Instant::now() >= deadline {
            let _ = crate::kill_process_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned Windows fixture process exceeded 20 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn junction(link: &Path, target: &Path) {
    use std::os::windows::process::CommandExt;
    let line = format!(
        r#"/d /s /c "mklink /J "{}" "{}" >NUL""#,
        link.display(),
        target.display()
    );
    // Paths are test-owned, contain no quotes, and are quoted for CMD, not CRT.
    let output = run(crate::process_launch::background_std_command("cmd.exe").raw_arg(line));
    assert!(
        output.status.success(),
        "create test junction (no admin/symlink privilege needed)"
    );
}

pub(super) fn git(root: &Path, args: &[&str]) -> Output {
    let mut command = crate::process_launch::background_std_command("git");
    // A developer's exported Git environment must never redirect a fixture
    // write into a real checkout, index, object store, template or config.
    for key in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_TEMPLATE_DIR",
    ] {
        command.env_remove(key);
    }
    let output = run(command
        .current_dir(root)
        .env("GIT_CONFIG_GLOBAL", "NUL")
        .env("GIT_CONFIG_SYSTEM", "NUL")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .args(args));
    assert!(
        output.status.success(),
        "isolated Git fixture command failed"
    );
    output
}
