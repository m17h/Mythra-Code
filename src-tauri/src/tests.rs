use super::*;
use std::process::Command as StdCommand;

#[test]
fn claude_always_uses_mythra_code_as_its_only_subagent_route() {
    let disallowed = claude_disallowed_tools("ask");
    assert!(disallowed.contains(&"Task"));
    assert!(disallowed.contains(&"SendMessage"));
    assert!(disallowed.contains(&"TaskCreate"));
    assert!(disallowed.contains(&"TaskUpdate"));
    assert!(disallowed.contains(&"TeamCreate"));
}

#[test]
fn worktree_branches_use_mythra_and_keep_legacy_branches_manageable() {
    assert!(is_managed_worktree_branch("mythra/new-thread"));
    assert!(is_managed_worktree_branch("openkiwi/existing-thread"));
    assert!(!is_managed_worktree_branch("feature/unmanaged"));
}

#[test]
fn claude_usage_normalizes_subscription_windows_without_credentials() {
    let usage = parse_claude_usage_result(
        "You are currently using your subscription to power your Claude Code usage\n\
         \n\
         Current session: 5% used · resets Aug 21 at 11:29pm (America/New_York)\n\
         Current week (all models): 29% used · resets Aug 23 at 5:59pm (America/New_York)\n\
         Current week (Fable): 120% used",
    );
    assert_eq!(
        usage,
        ClaudeUsageLimits {
            windows: vec![
                ClaudeUsageWindow {
                    label: "5h".into(),
                    used_percent: 5.0,
                    reset_label: Some("Aug 21 at 11:29pm (America/New_York)".into()),
                },
                ClaudeUsageWindow {
                    label: "Weekly".into(),
                    used_percent: 29.0,
                    reset_label: Some("Aug 23 at 5:59pm (America/New_York)".into()),
                },
                ClaudeUsageWindow {
                    label: "Weekly Fable".into(),
                    used_percent: 100.0,
                    reset_label: None,
                },
            ],
        }
    );
}

#[test]
fn claude_usage_skips_missing_or_malformed_windows() {
    assert!(parse_claude_usage_result(
        "Current session: unknown% used\nCurrent month: 20% used\nCurrent week (all models): unavailable"
    )
    .windows
    .is_empty());
}

#[test]
fn child_agent_completion_cannot_be_resurrected_by_a_late_spawn_response() {
    let mut runtime = super::agents::SessionRuntime::default();
    super::agents::record_finished_child(&mut runtime, "child-fast");
    super::agents::record_spawned_child(
        &mut runtime,
        &serde_json::json!({ "childId": "child-fast", "status": "running" }),
    );
    assert!(runtime.known.contains("child-fast"));
    assert!(!runtime.live.contains("child-fast"));
    assert!(!runtime.finished.contains("child-fast"));
}

#[test]
fn child_agent_terminal_spawn_response_never_takes_a_live_slot() {
    let mut runtime = super::agents::SessionRuntime::default();
    super::agents::record_spawned_child(
        &mut runtime,
        &serde_json::json!({ "childId": "child-done", "status": "completed" }),
    );
    assert!(runtime.known.contains("child-done"));
    assert!(runtime.live.is_empty());
}

#[test]
fn github_repository_parser_accepts_https_and_ssh_but_rejects_other_hosts() {
    assert_eq!(
        parse_github_repository("https://github.com/openai/codex.git"),
        Some("openai/codex".into())
    );
    assert_eq!(
        parse_github_repository("git@github.com:anthropics/claude-code.git"),
        Some("anthropics/claude-code".into())
    );
    assert_eq!(
        parse_github_repository("https://example.com/openai/codex.git"),
        None
    );
    assert_eq!(
        parse_github_repository("https://github.com/openai/codex/extra"),
        None
    );
}

#[test]
fn github_repository_names_cannot_be_interpreted_as_cli_flags_or_owner_paths() {
    assert!(validate_github_repository_name("openkiwi.app").is_ok());
    assert!(validate_github_repository_name("openkiwi_desktop-2").is_ok());
    assert!(validate_github_repository_name("--public").is_err());
    assert!(validate_github_repository_name("owner/repository").is_err());
    assert!(validate_github_repository_name("two words").is_err());
}

fn test_git(repo: &Path, args: &[&str]) -> String {
    let output = StdCommand::new("git")
        .current_dir(repo)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Mythra Code Tests")
        .env("GIT_AUTHOR_EMAIL", "tests@openkiwi.local")
        .env("GIT_COMMITTER_NAME", "Mythra Code Tests")
        .env("GIT_COMMITTER_EMAIL", "tests@openkiwi.local")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    if args.first() == Some(&"init") && repo.join(".git").exists() {
        let config = StdCommand::new("git")
            .current_dir(repo)
            .args(["config", "core.autocrlf", "false"])
            .output()
            .expect("configure test repository line endings");
        assert!(
            config.status.success(),
            "git config core.autocrlf false failed: {}",
            String::from_utf8_lossy(&config.stderr)
        );
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn git_runtime_path_preserves_inherited_entries_and_adds_filter_locations() {
    let inherited_dir = env::temp_dir().join("openkiwi-inherited-git-tools");
    let inherited = env::join_paths([&inherited_dir]).expect("inherited PATH");
    let home = env::temp_dir().join("openkiwi-git-runtime-home");
    let runtime =
        git_runtime_path(Some(inherited.as_os_str()), Some(&home)).expect("Git runtime PATH");
    let directories = env::split_paths(&runtime).collect::<Vec<_>>();

    assert_eq!(directories.first(), Some(&inherited_dir));
    #[cfg(unix)]
    {
        assert!(directories.contains(&home.join(".local/bin")));
        assert!(directories.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(directories.contains(&PathBuf::from("/usr/local/bin")));
        assert_eq!(
            directories
                .iter()
                .filter(|path| path.as_path() == Path::new("/usr/bin"))
                .count(),
            1,
        );
    }
}

#[cfg(unix)]
#[test]
fn git_runtime_path_finds_a_filter_outside_a_gui_style_minimal_path() {
    use std::os::unix::fs::PermissionsExt;

    let home = env::temp_dir().join(format!(
        "openkiwi-git-filter-path-test-{}",
        uuid::Uuid::new_v4()
    ));
    let user_bin = home.join(".local/bin");
    fs::create_dir_all(&user_bin).expect("create user bin");
    let filter = user_bin.join("openkiwi-test-git-filter");
    fs::write(&filter, "#!/bin/sh\nexit 0\n").expect("write fake filter");
    let mut permissions = fs::metadata(&filter)
        .expect("filter metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&filter, permissions).expect("make fake filter executable");

    let minimal = env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
        .expect("minimal GUI PATH");
    let runtime =
        git_runtime_path(Some(minimal.as_os_str()), Some(&home)).expect("augmented Git PATH");
    let output = StdCommand::new("openkiwi-test-git-filter")
        .env("PATH", runtime)
        .output()
        .expect("resolve fake Git filter through augmented PATH");

    assert!(output.status.success());
    fs::remove_dir_all(&home).expect("remove filter fixture");
}

#[cfg(unix)]
#[test]
fn checkpoint_git_command_runs_a_required_filter_with_a_gui_style_path() {
    use std::os::unix::fs::PermissionsExt;

    let root = env::temp_dir().join(format!(
        "openkiwi-checkpoint-filter-test-{}",
        uuid::Uuid::new_v4()
    ));
    let repo = root.join("project");
    let home = root.join("home");
    let user_bin = home.join(".local/bin");
    fs::create_dir_all(&repo).expect("create project");
    fs::create_dir_all(&user_bin).expect("create user bin");
    test_git(&repo, &["init", "-b", "main"]);
    test_git(
        &repo,
        &[
            "config",
            "filter.openkiwi-test.clean",
            "openkiwi-test-filter",
        ],
    );
    test_git(&repo, &["config", "filter.openkiwi-test.required", "true"]);
    fs::write(
        repo.join(".gitattributes"),
        "*.filtered filter=openkiwi-test\n",
    )
    .expect("write attributes");
    fs::write(repo.join("asset.filtered"), "checkpoint content\n").expect("write filtered file");
    let filter = user_bin.join("openkiwi-test-filter");
    fs::write(&filter, "#!/bin/sh\n/bin/cat\n").expect("write fake filter");
    let mut permissions = fs::metadata(&filter)
        .expect("filter metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&filter, permissions).expect("make fake filter executable");

    let minimal = env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
        .expect("minimal GUI PATH");
    let output = git_command_for(&repo, Some(minimal.as_os_str()), Some(&home))
        .args(["add", "-A", "--", "."])
        .output()
        .expect("run checkpoint Git command");

    assert!(
        output.status.success(),
        "required Git filter was not resolved: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        test_git(&repo, &["show", ":asset.filtered"]),
        "checkpoint content"
    );
    fs::remove_dir_all(&root).expect("remove checkpoint filter fixture");
}

#[test]
fn github_remote_attachment_validates_and_refuses_to_replace_origin() {
    let project = env::temp_dir().join(format!(
        "openkiwi-github-attach-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&project).expect("create project");
    test_git(&project, &["init", "-b", "main"]);
    fs::write(project.join("README.md"), "Mythra Code\n").expect("write source");
    test_git(&project, &["add", "."]);
    test_git(&project, &["commit", "-m", "Initial"]);

    let status = github_attach_remote_sync(
        project.to_str().unwrap(),
        "https://github.com/example/openkiwi.git",
    )
    .expect("attach GitHub origin");
    assert_eq!(status.repository.as_deref(), Some("example/openkiwi"));
    assert_eq!(
        test_git(&project, &["remote", "get-url", "origin"]),
        "https://github.com/example/openkiwi.git"
    );
    assert!(github_attach_remote_sync(
        project.to_str().unwrap(),
        "https://github.com/example/other.git",
    )
    .is_err());

    fs::remove_dir_all(project).expect("remove project");
}

#[test]
fn github_status_reports_named_branch_and_divergence() {
    let root = env::temp_dir().join(format!(
        "openkiwi-github-status-test-{}",
        uuid::Uuid::new_v4()
    ));
    let source = root.join("source");
    let remote = root.join("remote.git");
    let peer = root.join("peer");
    fs::create_dir_all(&source).expect("create source");
    test_git(&source, &["init", "-b", "main"]);
    fs::write(source.join("README.md"), "baseline\n").expect("write baseline");
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "Baseline"]);
    test_git(&root, &["init", "--bare", remote.to_str().unwrap()]);
    test_git(
        &source,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    test_git(&source, &["push", "--set-upstream", "origin", "main"]);

    test_git(
        &root,
        &[
            "clone",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            peer.to_str().unwrap(),
        ],
    );
    fs::write(peer.join("peer.txt"), "remote change\n").expect("write peer change");
    test_git(&peer, &["add", "."]);
    test_git(&peer, &["commit", "-m", "Remote change"]);
    test_git(&peer, &["push"]);

    fs::write(source.join("local.txt"), "local change\n").expect("write local change");
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "Local change"]);
    test_git(&source, &["fetch", "origin"]);
    test_git(
        &source,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/example/openkiwi.git",
        ],
    );

    let status = github_repo_status_sync(source.to_str().unwrap()).expect("inspect status");
    assert_eq!(status.repository.as_deref(), Some("example/openkiwi"));
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    assert_eq!(status.ahead, 1);
    assert_eq!(status.behind, 1);

    fs::remove_dir_all(root).expect("remove repositories");
}

#[test]
fn workspace_git_initialization_creates_a_local_ignored_aware_baseline() {
    let project = env::temp_dir().join(format!(
        "openkiwi-git-initialize-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&project).expect("create project");
    fs::write(project.join(".gitignore"), "private.txt\n").expect("gitignore");
    fs::write(project.join("tracked.txt"), "project source\n").expect("tracked source");
    fs::write(project.join("private.txt"), "do not commit\n").expect("ignored source");

    let result =
        initialize_workspace_git_sync(project.to_str().unwrap()).expect("initialize project");
    assert!(result.initialized);
    assert!(result.created_commit);
    assert_eq!(result.tracked_files, 2);
    assert!(result.info.is_repo);
    assert!(result.info.is_root);
    assert!(result.info.has_commit);

    let tracked = test_git(&project, &["ls-files"]);
    assert!(tracked.lines().any(|path| path == ".gitignore"));
    assert!(tracked.lines().any(|path| path == "tracked.txt"));
    assert!(!tracked.lines().any(|path| path == "private.txt"));
    assert_eq!(
        test_git(&project, &["log", "-1", "--pretty=%s"]),
        "Initial project snapshot"
    );
    let head = test_git(&project, &["rev-parse", "HEAD"]);

    let repeated = initialize_workspace_git_sync(project.to_str().unwrap()).expect("repeat safely");
    assert!(!repeated.initialized);
    assert!(!repeated.created_commit);
    assert_eq!(test_git(&project, &["rev-parse", "HEAD"]), head);

    fs::remove_dir_all(project).expect("remove project");
}

#[test]
fn checkpoints_restore_source_files_without_touching_git_history_index_or_ignored_files() {
    let repo = env::temp_dir().join(format!("openkiwi-checkpoint-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&repo).expect("create repo");
    test_git(&repo, &["init"]);
    fs::write(repo.join(".gitignore"), "ignored.txt\n").expect("gitignore");
    fs::write(repo.join("tracked.txt"), "base\n").expect("tracked");
    fs::write(repo.join("staged.txt"), "base\n").expect("staged base");
    test_git(&repo, &["add", "."]);
    test_git(&repo, &["commit", "-m", "base"]);
    let head = test_git(&repo, &["rev-parse", "HEAD"]);

    fs::write(repo.join("staged.txt"), "staged change\n").expect("staged change");
    test_git(&repo, &["add", "staged.txt"]);
    let staged_diff = test_git(&repo, &["diff", "--cached"]);
    fs::write(repo.join("staged.txt"), "checkpoint worktree\n").expect("worktree change");
    fs::write(repo.join("tracked.txt"), "checkpoint value\n").expect("checkpoint value");
    fs::write(repo.join("new.txt"), "new source\n").expect("untracked source");
    fs::write(repo.join("ignored.txt"), "do not snapshot\n").expect("ignored");

    let checkpoint = capture_checkpoint_snapshot(
        "test-checkpoint",
        repo.to_str().unwrap(),
        "before",
        "before test",
    )
    .expect("capture before");
    assert_eq!(checkpoint.head.as_deref(), Some(head.as_str()));

    fs::write(repo.join("tracked.txt"), "later value\n").expect("later value");
    fs::write(repo.join("staged.txt"), "later worktree\n").expect("later staged");
    fs::remove_file(repo.join("new.txt")).expect("remove source");
    fs::write(repo.join("later.txt"), "later source\n").expect("later source");
    fs::write(repo.join("ignored.txt"), "ignored later value\n").expect("ignored later");
    capture_checkpoint_snapshot(
        "test-checkpoint",
        repo.to_str().unwrap(),
        "after",
        "after test",
    )
    .expect("capture after");

    capture_checkpoint_snapshot(
        "safety-one",
        repo.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("capture first safety before");
    capture_checkpoint_snapshot(
        "safety-one",
        repo.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("capture first safety after");
    restore_checkpoint_snapshot(
        "test-checkpoint",
        repo.to_str().unwrap(),
        "before",
        "safety-one",
    )
    .expect("restore before");
    assert_eq!(
        fs::read_to_string(repo.join("tracked.txt")).unwrap(),
        "checkpoint value\n"
    );
    assert_eq!(
        fs::read_to_string(repo.join("staged.txt")).unwrap(),
        "checkpoint worktree\n"
    );
    assert_eq!(
        fs::read_to_string(repo.join("new.txt")).unwrap(),
        "new source\n"
    );
    assert!(!repo.join("later.txt").exists());
    assert_eq!(
        fs::read_to_string(repo.join("ignored.txt")).unwrap(),
        "ignored later value\n"
    );
    assert_eq!(test_git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(test_git(&repo, &["diff", "--cached"]), staged_diff);

    capture_checkpoint_snapshot(
        "safety-two",
        repo.to_str().unwrap(),
        "before",
        "safety before reapply",
    )
    .expect("capture second safety before");
    capture_checkpoint_snapshot(
        "safety-two",
        repo.to_str().unwrap(),
        "after",
        "safety after reapply",
    )
    .expect("capture second safety after");
    restore_checkpoint_snapshot(
        "test-checkpoint",
        repo.to_str().unwrap(),
        "after",
        "safety-two",
    )
    .expect("restore completed state");
    assert_eq!(
        fs::read_to_string(repo.join("tracked.txt")).unwrap(),
        "later value\n"
    );
    assert!(repo.join("later.txt").exists());
    assert!(!repo.join("new.txt").exists());
    assert_eq!(test_git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(test_git(&repo, &["diff", "--cached"]), staged_diff);

    fs::remove_dir_all(&repo).expect("remove test repo");
}

#[test]
fn checkpoint_restore_preserves_ignored_files_inside_removed_source_directories() {
    let repo = env::temp_dir().join(format!(
        "openkiwi-checkpoint-ignored-directory-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&repo).expect("create repo");
    test_git(&repo, &["init"]);
    fs::write(repo.join(".gitignore"), "*.secret\n").expect("gitignore");
    fs::write(repo.join("source.txt"), "target\n").expect("source");
    test_git(&repo, &["add", "."]);
    test_git(&repo, &["commit", "-m", "base"]);
    capture_checkpoint_snapshot(
        "ignored-directory-target",
        repo.to_str().unwrap(),
        "before",
        "target",
    )
    .expect("target checkpoint");

    fs::create_dir(repo.join("generated")).expect("generated directory");
    fs::write(repo.join("generated/source.txt"), "remove me\n").expect("source file");
    fs::write(repo.join("generated/private.secret"), "preserve me\n").expect("ignored file");
    capture_checkpoint_snapshot(
        "ignored-directory-safety",
        repo.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("safety before");
    capture_checkpoint_snapshot(
        "ignored-directory-safety",
        repo.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("safety after");

    restore_checkpoint_snapshot(
        "ignored-directory-target",
        repo.to_str().unwrap(),
        "before",
        "ignored-directory-safety",
    )
    .expect("restore target");
    assert!(!repo.join("generated/source.txt").exists());
    assert_eq!(
        fs::read_to_string(repo.join("generated/private.secret")).unwrap(),
        "preserve me\n"
    );
    fs::remove_dir_all(&repo).expect("remove test repo");
}

#[test]
fn checkpoint_restore_refuses_to_overwrite_an_ignored_target_file() {
    let repo = env::temp_dir().join(format!(
        "openkiwi-checkpoint-ignored-target-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&repo).expect("create repo");
    test_git(&repo, &["init"]);
    fs::write(repo.join("generated.txt"), "checkpoint value\n").expect("tracked source");
    test_git(&repo, &["add", "."]);
    test_git(&repo, &["commit", "-m", "base"]);
    capture_checkpoint_snapshot("ignored-target", repo.to_str().unwrap(), "before", "target")
        .expect("target checkpoint");

    test_git(&repo, &["rm", "generated.txt"]);
    fs::write(repo.join(".gitignore"), "generated.txt\n").expect("gitignore");
    test_git(&repo, &["add", ".gitignore"]);
    test_git(&repo, &["commit", "-m", "ignore generated file"]);
    fs::write(repo.join("generated.txt"), "private ignored value\n").expect("ignored file");
    capture_checkpoint_snapshot(
        "ignored-target-safety",
        repo.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("safety before");
    capture_checkpoint_snapshot(
        "ignored-target-safety",
        repo.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("safety after");

    let error = restore_checkpoint_snapshot(
        "ignored-target",
        repo.to_str().unwrap(),
        "before",
        "ignored-target-safety",
    )
    .expect_err("ignored target must block restore");
    assert!(error.contains("cannot overwrite the ignored file"));
    assert_eq!(
        fs::read_to_string(repo.join("generated.txt")).unwrap(),
        "private ignored value\n"
    );
    fs::remove_dir_all(&repo).expect("remove test repo");
}

#[cfg(unix)]
#[test]
fn checkpoint_restore_replaces_a_directory_symlink_without_following_it() {
    use std::os::unix::fs::symlink;

    let repo = env::temp_dir().join(format!(
        "openkiwi-checkpoint-symlink-test-{}",
        uuid::Uuid::new_v4()
    ));
    let external = env::temp_dir().join(format!(
        "openkiwi-checkpoint-external-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(repo.join("sub")).expect("repo directory");
    fs::create_dir_all(&external).expect("external directory");
    test_git(&repo, &["init"]);
    fs::write(repo.join("sub/file.txt"), "checkpoint value\n").expect("tracked source");
    test_git(&repo, &["add", "."]);
    test_git(&repo, &["commit", "-m", "base"]);
    capture_checkpoint_snapshot("symlink-target", repo.to_str().unwrap(), "before", "target")
        .expect("target checkpoint");

    fs::remove_dir_all(repo.join("sub")).expect("replace tracked directory");
    fs::write(external.join("file.txt"), "external value\n").expect("external source");
    symlink(&external, repo.join("sub")).expect("directory symlink");
    capture_checkpoint_snapshot(
        "symlink-safety",
        repo.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("safety before");
    capture_checkpoint_snapshot(
        "symlink-safety",
        repo.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("safety after");

    restore_checkpoint_snapshot(
        "symlink-target",
        repo.to_str().unwrap(),
        "before",
        "symlink-safety",
    )
    .expect("restore target");
    assert!(!fs::symlink_metadata(repo.join("sub"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_to_string(repo.join("sub/file.txt")).unwrap(),
        "checkpoint value\n"
    );
    assert_eq!(
        fs::read_to_string(external.join("file.txt")).unwrap(),
        "external value\n"
    );
    fs::remove_dir_all(&repo).expect("remove test repo");
    fs::remove_dir_all(&external).expect("remove external directory");
}

#[test]
fn checkpoint_restore_refuses_a_stale_safety_snapshot() {
    let repo = env::temp_dir().join(format!(
        "openkiwi-checkpoint-safety-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&repo).expect("create repo");
    test_git(&repo, &["init"]);
    fs::write(repo.join("source.txt"), "target\n").expect("source");
    test_git(&repo, &["add", "."]);
    test_git(&repo, &["commit", "-m", "base"]);
    capture_checkpoint_snapshot(
        "target-checkpoint",
        repo.to_str().unwrap(),
        "before",
        "target",
    )
    .expect("target checkpoint");

    fs::write(repo.join("source.txt"), "safety\n").expect("safety state");
    capture_checkpoint_snapshot(
        "stale-safety",
        repo.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("safety before");
    capture_checkpoint_snapshot(
        "stale-safety",
        repo.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("safety after");
    fs::write(repo.join("source.txt"), "changed after safety\n").expect("later change");

    let error = restore_checkpoint_snapshot(
        "target-checkpoint",
        repo.to_str().unwrap(),
        "before",
        "stale-safety",
    )
    .expect_err("stale safety must block restore");
    assert!(error.contains("changed after its safety checkpoint"));
    assert_eq!(
        fs::read_to_string(repo.join("source.txt")).unwrap(),
        "changed after safety\n"
    );
    fs::remove_dir_all(&repo).expect("remove test repo");
}

#[test]
fn worktree_apply_transfers_complete_delta_without_touching_source_index_or_ignored_files() {
    let source = env::temp_dir().join(format!(
        "openkiwi-worktree-apply-source-{}",
        uuid::Uuid::new_v4()
    ));
    let isolated = env::temp_dir().join(format!(
        "openkiwi-worktree-apply-isolated-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&source).expect("source repo");
    test_git(&source, &["init"]);
    fs::write(source.join(".gitignore"), "*.secret\n").expect("gitignore");
    fs::write(source.join("edited.txt"), "base\n").expect("edited");
    fs::write(source.join("deleted.txt"), "delete me\n").expect("deleted");
    fs::write(source.join("script.sh"), "#!/bin/sh\necho base\n").expect("script");
    fs::write(source.join("staged.txt"), "base staged\n").expect("staged");
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "base"]);
    let base = test_git(&source, &["rev-parse", "HEAD"]);
    test_git(
        &source,
        &[
            "worktree",
            "add",
            isolated.to_str().unwrap(),
            "-b",
            "openkiwi/test-apply",
            &base,
        ],
    );

    fs::write(source.join("staged.txt"), "index value\n").expect("index value");
    test_git(&source, &["add", "staged.txt"]);
    let staged_diff = test_git(&source, &["diff", "--cached"]);
    fs::write(source.join("staged.txt"), "working value\n").expect("working value");
    fs::write(source.join("local.secret"), "source private\n").expect("source ignored");

    fs::write(isolated.join("edited.txt"), "isolated edit\n").expect("isolated edit");
    fs::remove_file(isolated.join("deleted.txt")).expect("isolated delete");
    fs::create_dir(isolated.join("new")).expect("new directory");
    fs::write(isolated.join("new/file.txt"), "new source\n").expect("new source");
    fs::write(isolated.join("binary.bin"), [0, 159, 146, 150, 255]).expect("binary");
    fs::write(isolated.join("worktree.secret"), "isolated private\n").expect("ignored");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(isolated.join("script.sh"))
            .unwrap()
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(isolated.join("script.sh"), permissions).expect("executable");
    }
    let status = worktree_status_sync(
        source.to_str().unwrap(),
        isolated.to_str().unwrap(),
        "openkiwi/test-apply",
        &base,
    )
    .expect("worktree status");
    assert!(status.exists);
    assert!(status.registered);
    assert!(!status.clean);
    let expected_changed_files = if cfg!(unix) { 5 } else { 4 };
    assert!(status.changed_files >= expected_changed_files);
    assert!(status.untracked_files >= 2);
    assert!(status
        .ignored_files
        .iter()
        .any(|path| path == "worktree.secret"));

    capture_checkpoint_snapshot(
        "worktree-apply-safety",
        source.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("safety before");
    capture_checkpoint_snapshot(
        "worktree-apply-safety",
        source.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("safety after");
    let head = test_git(&source, &["rev-parse", "HEAD"]);

    let applied_reference = "refs/openkiwi/worktrees/test-thread/applied";
    let result = worktree_apply_to_source_sync(
        source.to_str().unwrap(),
        isolated.to_str().unwrap(),
        &base,
        "worktree-apply-safety",
        Some(applied_reference),
    )
    .expect("apply isolated delta");
    assert!(result.changed_files >= expected_changed_files);
    assert_eq!(
        test_git(&source, &["rev-parse", applied_reference]),
        result.isolated_tree
    );
    assert_eq!(
        fs::read_to_string(source.join("edited.txt")).unwrap(),
        "isolated edit\n"
    );
    assert!(!source.join("deleted.txt").exists());
    assert_eq!(
        fs::read_to_string(source.join("new/file.txt")).unwrap(),
        "new source\n"
    );
    assert_eq!(
        fs::read(source.join("binary.bin")).unwrap(),
        vec![0, 159, 146, 150, 255]
    );
    assert_eq!(
        fs::read_to_string(source.join("local.secret")).unwrap(),
        "source private\n"
    );
    assert!(!source.join("worktree.secret").exists());
    assert_eq!(
        fs::read_to_string(source.join("staged.txt")).unwrap(),
        "working value\n"
    );
    assert_eq!(test_git(&source, &["diff", "--cached"]), staged_diff);
    assert_eq!(test_git(&source, &["rev-parse", "HEAD"]), head);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(
            fs::metadata(source.join("script.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }

    test_git(
        &source,
        &["worktree", "remove", "--force", isolated.to_str().unwrap()],
    );
    fs::remove_dir_all(&source).expect("remove source");
}

#[test]
fn worktree_apply_conflict_leaves_source_unchanged() {
    let source = env::temp_dir().join(format!(
        "openkiwi-worktree-conflict-source-{}",
        uuid::Uuid::new_v4()
    ));
    let isolated = env::temp_dir().join(format!(
        "openkiwi-worktree-conflict-isolated-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&source).expect("source repo");
    test_git(&source, &["init"]);
    fs::write(source.join("source.txt"), "base\n").expect("base");
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "base"]);
    let base = test_git(&source, &["rev-parse", "HEAD"]);
    test_git(
        &source,
        &[
            "worktree",
            "add",
            isolated.to_str().unwrap(),
            "-b",
            "openkiwi/test-conflict",
            &base,
        ],
    );
    fs::write(source.join("source.txt"), "shared edit\n").expect("shared edit");
    fs::write(isolated.join("source.txt"), "isolated edit\n").expect("isolated edit");
    capture_checkpoint_snapshot(
        "worktree-conflict-safety",
        source.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("safety before");
    capture_checkpoint_snapshot(
        "worktree-conflict-safety",
        source.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("safety after");

    worktree_apply_to_source_sync(
        source.to_str().unwrap(),
        isolated.to_str().unwrap(),
        &base,
        "worktree-conflict-safety",
        None,
    )
    .expect_err("conflicting delta must fail");
    assert_eq!(
        fs::read_to_string(source.join("source.txt")).unwrap(),
        "shared edit\n"
    );
    test_git(
        &source,
        &["worktree", "remove", "--force", isolated.to_str().unwrap()],
    );
    fs::remove_dir_all(&source).expect("remove source");
}

#[test]
fn restoring_pre_apply_safety_can_rebaseline_and_reapply_the_worktree() {
    let source = env::temp_dir().join(format!(
        "openkiwi-worktree-reapply-source-{}",
        uuid::Uuid::new_v4()
    ));
    let isolated = env::temp_dir().join(format!(
        "openkiwi-worktree-reapply-isolated-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&source).expect("source repo");
    test_git(&source, &["init"]);
    fs::write(source.join("source.txt"), "base\n").expect("base");
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "base"]);
    let base = test_git(&source, &["rev-parse", "HEAD"]);
    test_git(
        &source,
        &[
            "worktree",
            "add",
            isolated.to_str().unwrap(),
            "-b",
            "openkiwi/test-reapply",
            &base,
        ],
    );
    fs::write(isolated.join("source.txt"), "isolated\n").expect("isolated edit");

    for phase in ["before", "after"] {
        capture_checkpoint_snapshot(
            "pre-apply-state",
            source.to_str().unwrap(),
            phase,
            "pre apply",
        )
        .expect("pre-apply checkpoint");
    }
    for phase in ["before", "after"] {
        capture_checkpoint_snapshot(
            "first-apply-safety",
            source.to_str().unwrap(),
            phase,
            "first apply safety",
        )
        .expect("first apply safety");
    }
    let reference = "refs/openkiwi/worktrees/reapply-thread/applied";
    worktree_apply_to_source_sync(
        source.to_str().unwrap(),
        isolated.to_str().unwrap(),
        &base,
        "first-apply-safety",
        Some(reference),
    )
    .expect("first apply");
    assert_eq!(
        fs::read_to_string(source.join("source.txt")).unwrap(),
        "isolated\n"
    );

    for phase in ["before", "after"] {
        capture_checkpoint_snapshot(
            "restore-safety",
            source.to_str().unwrap(),
            phase,
            "restore safety",
        )
        .expect("restore safety");
    }
    restore_checkpoint_snapshot(
        "pre-apply-state",
        source.to_str().unwrap(),
        "after",
        "restore-safety",
    )
    .expect("restore pre-apply files");
    assert_eq!(
        fs::read_to_string(source.join("source.txt")).unwrap(),
        "base\n"
    );

    let baseline_tree =
        set_worktree_applied_baseline_sync(source.to_str().unwrap(), "reapply-thread", &base)
            .expect("restore applied baseline");
    for phase in ["before", "after"] {
        capture_checkpoint_snapshot(
            "second-apply-safety",
            source.to_str().unwrap(),
            phase,
            "second apply safety",
        )
        .expect("second apply safety");
    }
    worktree_apply_to_source_sync(
        source.to_str().unwrap(),
        isolated.to_str().unwrap(),
        &baseline_tree,
        "second-apply-safety",
        Some(reference),
    )
    .expect("reapply");
    assert_eq!(
        fs::read_to_string(source.join("source.txt")).unwrap(),
        "isolated\n"
    );

    test_git(
        &source,
        &["worktree", "remove", "--force", isolated.to_str().unwrap()],
    );
    fs::remove_dir_all(&source).expect("remove source");
}

#[test]
fn worktree_merge_aborts_conflicts_and_refuses_dirty_source() {
    let source = env::temp_dir().join(format!(
        "openkiwi-worktree-merge-source-{}",
        uuid::Uuid::new_v4()
    ));
    let isolated = env::temp_dir().join(format!(
        "openkiwi-worktree-merge-isolated-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&source).expect("source repo");
    test_git(&source, &["init"]);
    fs::write(source.join("source.txt"), "base\n").expect("base");
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "base"]);
    let base = test_git(&source, &["rev-parse", "HEAD"]);
    test_git(
        &source,
        &[
            "worktree",
            "add",
            isolated.to_str().unwrap(),
            "-b",
            "openkiwi/test-merge-conflict",
            &base,
        ],
    );
    fs::write(isolated.join("source.txt"), "isolated commit\n").expect("isolated edit");
    test_git(&isolated, &["add", "."]);
    test_git(&isolated, &["commit", "-m", "isolated"]);
    fs::write(source.join("source.txt"), "source commit\n").expect("source edit");
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "source"]);
    let source_head = test_git(&source, &["rev-parse", "HEAD"]);

    capture_checkpoint_snapshot(
        "worktree-merge-conflict-safety",
        source.to_str().unwrap(),
        "before",
        "safety before",
    )
    .expect("safety before");
    capture_checkpoint_snapshot(
        "worktree-merge-conflict-safety",
        source.to_str().unwrap(),
        "after",
        "safety after",
    )
    .expect("safety after");
    let merge_reference = "refs/openkiwi/worktrees/merge-test-thread/applied";
    test_git(
        &source,
        &["update-ref", merge_reference, &format!("{base}^{{tree}}")],
    );
    worktree_merge_branch_sync(
        source.to_str().unwrap(),
        isolated.to_str().unwrap(),
        "openkiwi/test-merge-conflict",
        "worktree-merge-conflict-safety",
        Some(merge_reference),
    )
    .expect_err("conflicting merge must fail");
    assert_eq!(test_git(&source, &["rev-parse", "HEAD"]), source_head);
    assert_eq!(test_git(&source, &["status", "--porcelain"]), "");
    assert_eq!(
        fs::read_to_string(source.join("source.txt")).unwrap(),
        "source commit\n"
    );
    assert_eq!(
        test_git(&source, &["rev-parse", merge_reference]),
        test_git(&source, &["rev-parse", &format!("{base}^{{tree}}")])
    );

    fs::write(source.join("dirty.txt"), "not committed\n").expect("dirty source");
    capture_checkpoint_snapshot(
        "worktree-merge-dirty-safety",
        source.to_str().unwrap(),
        "before",
        "dirty safety before",
    )
    .expect("dirty safety before");
    capture_checkpoint_snapshot(
        "worktree-merge-dirty-safety",
        source.to_str().unwrap(),
        "after",
        "dirty safety after",
    )
    .expect("dirty safety after");
    let dirty_error = worktree_merge_branch_sync(
        source.to_str().unwrap(),
        isolated.to_str().unwrap(),
        "openkiwi/test-merge-conflict",
        "worktree-merge-dirty-safety",
        Some(merge_reference),
    )
    .expect_err("dirty source must block merge");
    assert!(dirty_error.contains("source project's working changes"));

    test_git(
        &source,
        &["worktree", "remove", "--force", isolated.to_str().unwrap()],
    );
    fs::remove_dir_all(&source).expect("remove source");
}

// Regression for the leaked-turn defect: claude_turn_start builds this
// message BEFORE spawning the CLI, so an unreadable attachment must fail
// here — never after the process is registered in the per-thread map.
#[tokio::test]
async fn claude_user_message_fails_for_an_unreadable_image_attachment() {
    let attachment = ClaudeAttachment {
        path: std::env::temp_dir()
            .join("openkiwi-test-missing-image.png")
            .to_string_lossy()
            .into_owned(),
        kind: "image".into(),
    };
    let result = claude_user_message("thread-1", "look at this", &[attachment]).await;
    let error = result.expect_err("missing image attachments must fail");
    assert!(
        error.contains("Could not read"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn claude_user_message_rejects_a_non_regular_image_attachment() {
    let attachment = ClaudeAttachment {
        path: std::env::temp_dir().to_string_lossy().into_owned(),
        kind: "image".into(),
    };
    let error = claude_user_message("thread-1", "look at this", &[attachment])
        .await
        .expect_err("directories must not be read as image attachments");
    assert!(
        error.contains("not a regular file"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn claude_user_message_references_file_attachments_without_reading_them() {
    let attachment = ClaudeAttachment {
        path: std::env::temp_dir()
            .join("openkiwi-test-missing-file.txt")
            .to_string_lossy()
            .into_owned(),
        kind: "file".into(),
    };
    let message = claude_user_message("thread-1", "check the file", &[attachment])
        .await
        .expect("file attachments are passed by reference and must not fail");
    let content = message
        .pointer("/message/content")
        .and_then(Value::as_array)
        .expect("user message content");
    assert_eq!(content.len(), 2);
    assert!(
        text_of(&content[1]).contains("openkiwi-test-missing-file.txt"),
        "file attachment should be referenced by path"
    );
}

#[tokio::test]
async fn claude_user_message_embeds_readable_images_as_base64() {
    let path = std::env::temp_dir().join("openkiwi-test-real-image.png");
    std::fs::write(&path, [0x89, 0x50, 0x4e, 0x47]).expect("write test image");
    let attachment = ClaudeAttachment {
        path: path.to_string_lossy().into_owned(),
        kind: "image".into(),
    };
    let message = claude_user_message("thread-1", "look", &[attachment])
        .await
        .expect("readable image attachments must succeed");
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        message
            .pointer("/message/content/1/source/media_type")
            .and_then(Value::as_str),
        Some("image/png")
    );
    assert!(message
        .pointer("/message/content/1/source/data")
        .and_then(Value::as_str)
        .is_some_and(|data| !data.is_empty()));
}

#[test]
fn attachment_add_dir_refuses_root_level_and_unverifiable_paths() {
    let directory = skill_test_directory("attachment-grant");
    fs::create_dir_all(&directory).unwrap();
    let file = directory.join("notes.txt");
    fs::write(&file, "attachment\n").unwrap();

    // A regular file in a nested folder grants exactly its parent.
    assert_eq!(
        attachment_add_dir(&file),
        Some(directory.canonicalize().unwrap())
    );
    // Missing files and directories get no grant.
    assert_eq!(attachment_add_dir(&directory.join("missing.txt")), None);
    assert_eq!(attachment_add_dir(&directory), None);
    #[cfg(unix)]
    {
        // Files directly under `/` or a top-level system folder would
        // grant far more than the attachment.
        assert_eq!(attachment_add_dir(Path::new("/etc/hosts")), None);
    }
    assert!(add_dir_is_too_broad(Path::new("/")));
    assert!(add_dir_is_too_broad(Path::new("/etc")));
    assert!(add_dir_is_too_broad(Path::new("/usr")));
    assert!(add_dir_is_too_broad(Path::new("/private/etc")));
    assert!(!add_dir_is_too_broad(Path::new("/Users/person/project")));
    assert!(!add_dir_is_too_broad(Path::new("/private/tmp/scratch")));

    fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn tail_buffer_keeps_only_the_newest_bytes() {
    let mut buffer = TailBuffer::new(16);
    buffer.push_line("first line");
    assert_eq!(buffer.contents(), "first line");
    buffer.push_line("second");
    buffer.push_line("third");
    assert!(buffer.contents().len() <= 16);
    assert!(buffer.contents().ends_with("second\nthird"));
    assert!(!buffer.contents().contains("first"));

    let mut unicode = TailBuffer::new(4);
    unicode.push_line("aééé");
    assert!(unicode.contents().len() <= 4);
    assert!(unicode.contents().chars().all(|character| character == 'é'));
}

#[test]
fn claude_result_is_the_terminal_boundary_for_one_process_per_turn() {
    assert!(claude_message_ends_turn(&json!({
        "type": "result",
        "subtype": "success"
    })));
    assert!(!claude_message_ends_turn(&json!({
        "type": "assistant",
        "message": { "content": [] }
    })));
    assert!(!claude_message_ends_turn(&json!({
        "type": "stream_event",
        "event": { "type": "message_stop" }
    })));
}

#[tokio::test]
async fn claiming_an_occupied_turn_slot_fails_instead_of_evicting_the_live_turn() {
    struct FakeTurn {
        live: AtomicBool,
    }
    let turns: Arc<Mutex<HashMap<String, Arc<FakeTurn>>>> = Arc::default();
    let first = Arc::new(FakeTurn {
        live: AtomicBool::new(true),
    });
    let second = Arc::new(FakeTurn {
        live: AtomicBool::new(true),
    });
    let is_live = |turn: &FakeTurn| turn.live.load(Ordering::Acquire);

    assert!(claim_turn_slot(&turns, "thread", &first, is_live).await);
    // A concurrent start that lost the race must not evict the live turn.
    assert!(!claim_turn_slot(&turns, "thread", &second, is_live).await);
    assert!(Arc::ptr_eq(
        turns.lock().await.get("thread").unwrap(),
        &first
    ));
    // Once the occupant is no longer live, the slot can be reclaimed.
    first.live.store(false, Ordering::Release);
    assert!(claim_turn_slot(&turns, "thread", &second, is_live).await);
    assert!(Arc::ptr_eq(
        turns.lock().await.get("thread").unwrap(),
        &second
    ));
}

#[test]
fn cli_values_that_look_like_flags_are_rejected() {
    assert!(validate_cli_value("claude-opus-4", "The model identity").is_ok());
    assert!(validate_cli_value("b7c9e3a0", "The thread identity").is_ok());
    assert!(validate_cli_value("--resume=other", "The thread identity").is_err());
    assert!(validate_cli_value("-p", "The model identity").is_err());
    assert!(validate_cli_value("  ", "The model identity").is_err());
}

#[test]
fn oversized_audit_payloads_are_truncated_into_valid_json() {
    let small = truncate_audit_payload("{\"ok\":true}".into());
    assert_eq!(small, "{\"ok\":true}");

    let big = serde_json::to_string(&json!({ "detail": "é".repeat(20_000) })).unwrap();
    let truncated = truncate_audit_payload(big);
    assert!(truncated.len() < 2 * MAX_AUDIT_PAYLOAD_BYTES);
    let parsed = serde_json::from_str::<Value>(&truncated).expect("truncated payload parses");
    assert_eq!(parsed.get("truncated"), Some(&Value::Bool(true)));
    assert!(parsed
        .get("detail")
        .and_then(Value::as_str)
        .is_some_and(|detail| !detail.is_empty()));
}

#[test]
fn runtime_config_reconcile_reasserts_managed_keys_and_preserves_user_content() {
    let existing = "\
model_provider = \"openrouter\"
project_doc_max_bytes = 4096

[mcp_servers.docs]
command = \"docs-server\"

[agents]
max_threads = 8
max_depth = 3

[model_providers.openrouter]
name = \"OpenRouter\"
base_url = \"https://openrouter.ai/api/v1\"
";
    let managed = managed_runtime_config("http://127.0.0.1:9999/secret-token");
    let updated =
        reconcile_config_toml(existing, &managed).expect("drifted managed keys must be rewritten");
    // Managed keys are re-asserted…
    assert!(updated.contains("project_doc_max_bytes = 0"));
    assert!(updated.contains("cli_auth_credentials_store = \"keyring\""));
    assert!(updated.contains(
        "multi_agent_mode = { custom = \"Provider-native task, team, and agent spawning is disabled in Mythra Code."
    ));
    assert!(updated.contains("Never use collaboration.spawn_agent"));
    assert!(updated.contains("max_threads = 1"));
    // The Mythra Code bridge is the only spawning authority, so a drifted native
    // depth is pulled back to one alongside the thread ceiling.
    assert!(updated.contains("max_depth = 1"));
    assert!(!updated.contains("max_depth = 3"));
    assert!(updated.contains("\n[features]\nmulti_agent = false\nmulti_agent_v2 = false"));
    assert!(updated.contains("base_url = \"http://127.0.0.1:9999/secret-token\""));
    // …while user content is preserved verbatim.
    assert!(updated.contains("model_provider = \"openrouter\""));
    assert!(updated.contains("[mcp_servers.docs]"));
    assert!(updated.contains("command = \"docs-server\""));
    assert!(updated.contains("name = \"OpenRouter\""));

    // A file that already matches is left untouched.
    assert_eq!(reconcile_config_toml(&updated, &managed), None);
}

#[test]
fn git_input_larger_than_the_pipe_buffer_completes() {
    let repo = env::temp_dir().join(format!("openkiwi-git-input-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&repo).expect("create repo");
    test_git(&repo, &["init"]);
    // Well past the 64KB pipe capacity that used to deadlock.
    let blob = vec![b'a'; 5 * 1024 * 1024];
    let output = run_git_with_input(&repo, &["hash-object", "-w", "--stdin"], None, &blob)
        .expect("hash large stdin");
    assert!(output.status.success());
    assert!(!output.stdout.is_empty());
    fs::remove_dir_all(&repo).expect("remove repo");
}

fn text_of(entry: &Value) -> &str {
    entry
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

#[test]
fn pasted_image_cleanup_expires_old_files_and_preserves_the_current_paste() {
    let current = PathBuf::from("current.png");
    let candidates = vec![
        PastedImageCandidate {
            path: PathBuf::from("expired.png"),
            modified_at_ms: 10,
            size: 2,
        },
        PastedImageCandidate {
            path: current.clone(),
            modified_at_ms: 10,
            size: 2,
        },
        PastedImageCandidate {
            path: PathBuf::from("recent.png"),
            modified_at_ms: 95,
            size: 2,
        },
    ];
    let removed = pasted_image_removal_plan(candidates, 100, 20, 100, Some(&current));
    assert_eq!(removed, vec![PathBuf::from("expired.png")]);
}

#[test]
fn pasted_image_cleanup_removes_oldest_files_until_under_the_size_cap() {
    let candidates = vec![
        PastedImageCandidate {
            path: PathBuf::from("oldest.png"),
            modified_at_ms: 80,
            size: 4,
        },
        PastedImageCandidate {
            path: PathBuf::from("middle.png"),
            modified_at_ms: 90,
            size: 4,
        },
        PastedImageCandidate {
            path: PathBuf::from("newest.png"),
            modified_at_ms: 100,
            size: 4,
        },
    ];
    let removed = pasted_image_removal_plan(candidates, 100, 1_000, 8, None);
    assert_eq!(removed, vec![PathBuf::from("oldest.png")]);
}

#[test]
fn initialize_negotiates_fields_used_by_project_threads() {
    let params = initialize_params();
    assert_eq!(
        params.pointer("/capabilities/experimentalApi"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        params.pointer("/capabilities/mcpServerOpenaiFormElicitation"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        params.pointer("/capabilities/requestAttestation"),
        Some(&Value::Bool(false))
    );
}

#[test]
fn runtime_compatibility_accepts_tested_contract() {
    assert!(runtime_is_compatible("codex-cli 0.145.0-alpha.18"));
    assert!(!runtime_is_compatible("codex-cli 0.144.9"));
}

#[cfg(windows)]
#[test]
fn codex_candidates_include_current_and_legacy_npm_layouts() {
    let app_data = PathBuf::from(r"C:\Users\Person\AppData\Roaming");
    let mut candidates = Vec::new();
    push_windows_npm_codex_candidates_at(&mut candidates, &app_data);

    let package = app_data.join(r"npm\node_modules\@openai\codex");
    assert!(candidates.contains(&package.join(
        r"node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
    )));
    assert!(candidates.contains(&package.join(
        r"node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe"
    )));
}

#[test]
fn claude_auth_status_tolerates_terminal_wrapping() {
    let wrapped = br#"{
          "loggedIn": true,
          "email": "a-very-long-address@
          example.com",
          "subscriptionType": "max"
        }"#;
    let parsed = parse_claude_auth_status(wrapped).unwrap();
    assert_eq!(parsed.get("loggedIn"), Some(&Value::Bool(true)));
    assert_eq!(
        parsed.get("email").and_then(Value::as_str),
        Some("a-very-long-address@example.com")
    );
}

#[test]
fn openrouter_schema_sanitizer_removes_only_missing_required_properties() {
    let mut request = json!({
        "tools": [{
            "type": "function",
            "name": "render_artifact",
            "parameters": {
                "type": "object",
                "properties": {
                    "snapshot": {
                        "type": "object",
                        "properties": { "path": { "type": "string" } },
                        "required": ["path", "manifest"]
                    }
                },
                "required": ["snapshot", "unknown"]
            }
        }]
    });

    assert_eq!(sanitize_json_schema(&mut request), 2);
    assert_eq!(
        request.pointer("/tools/0/parameters/required"),
        Some(&json!(["snapshot"]))
    );
    assert_eq!(
        request.pointer("/tools/0/parameters/properties/snapshot/required"),
        Some(&json!(["path"]))
    );
}

#[test]
fn openrouter_schema_sanitizer_drops_required_without_properties() {
    let mut schema = json!({ "type": "object", "required": ["ghost"] });
    assert_eq!(sanitize_json_schema(&mut schema), 1);
    assert!(schema.get("required").is_none());
}

#[test]
fn production_processes_use_the_no_console_command_builders() {
    let source_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in std::fs::read_dir(&source_directory).expect("read Rust source directory") {
        let path = entry.expect("read Rust source entry").path();
        if path.extension().and_then(|value| value.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().and_then(|value| value.to_str());
        if matches!(name, Some("process_launch.rs" | "tests.rs")) {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("read Rust source file");
        assert!(
            !source.contains("Command::new(") && !source.contains("StdCommand::new("),
            "{} bypasses the Windows no-console process builders",
            path.display()
        );
    }
}

#[test]
fn openrouter_proxy_is_injected_into_thread_config() {
    let mut params = json!({
        "modelProvider": "openrouter",
        "config": { "features": { "apps": false } }
    });
    inject_openrouter_proxy_config(&mut params, Some("http://127.0.0.1:3210/token"));
    assert_eq!(
        params.pointer("/config/model_providers/openrouter/base_url"),
        Some(&json!("http://127.0.0.1:3210/token"))
    );
    assert_eq!(params.pointer("/config/features/apps"), Some(&json!(false)));
}

#[test]
fn openrouter_proxy_is_not_injected_into_openai_threads() {
    let mut params = json!({ "modelProvider": "openai", "config": {} });
    inject_openrouter_proxy_config(&mut params, Some("http://127.0.0.1:3210/token"));
    assert!(params.pointer("/config/model_providers").is_none());
}

fn skill_test_directory(label: &str) -> PathBuf {
    env::temp_dir().join(format!(
        "openkiwi-{label}-{}-{}",
        std::process::id(),
        unix_timestamp_ms()
    ))
}

#[test]
fn local_skill_scan_uses_top_level_markdown_and_nested_skill_packages() {
    let root = skill_test_directory("skill-scan");
    fs::create_dir_all(root.join("references")).unwrap();
    fs::create_dir_all(root.join("packaged")).unwrap();
    fs::write(
        root.join("review.md"),
        "# Review\n\nReview changes carefully.\n\nRead [details](references/details.md).\n",
    )
    .unwrap();
    fs::write(
        root.join("references/details.md"),
        "# Details\n\nCheck edge cases.\n",
    )
    .unwrap();
    fs::write(root.join("packaged/SKILL.md"), "---\nname: ignored-source-name\ndescription: Package description\n---\n\nRun the package workflow.\n").unwrap();
    fs::write(root.join("packaged/guide.md"), "# Guide\n").unwrap();

    let skills = scan_local_skills(&root).unwrap();
    assert_eq!(skills.len(), 2);
    assert_eq!(
        skills
            .iter()
            .map(|skill| skill.default_name.as_str())
            .collect::<Vec<_>>(),
        vec!["packaged", "review"]
    );
    assert_eq!(skills[0].description, "Package description");
    assert!(
        skills
            .iter()
            .find(|skill| skill.default_name == "review")
            .unwrap()
            .supporting_markdown_count
            >= 1
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_skill_deletion_only_removes_a_detected_source_file() {
    let root = skill_test_directory("skill-delete");
    fs::create_dir_all(root.join("references")).unwrap();
    let source = root.join("review.md");
    let supporting = root.join("references/details.md");
    fs::write(&source, "# Review\n\nReview changes carefully.\n").unwrap();
    fs::write(&supporting, "# Details\n\nKeep this supporting file.\n").unwrap();

    delete_local_skill_source(&root, &source).unwrap();
    assert!(!source.exists());
    assert!(supporting.exists());

    let error = delete_local_skill_source(&root, &supporting).unwrap_err();
    assert!(error.contains("not a detected Mythra Code skill"));
    assert!(supporting.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_skill_deletion_rejects_other_folders_and_keeps_package_support_files() {
    let root = skill_test_directory("skill-delete-package");
    let outside = skill_test_directory("skill-delete-outside");
    fs::create_dir_all(root.join("packaged")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let package_source = root.join("packaged/SKILL.md");
    let package_support = root.join("packaged/guide.md");
    let outside_source = outside.join("outside.md");
    fs::write(&package_source, "# Package\n\nRun the package.\n").unwrap();
    fs::write(&package_support, "# Guide\n\nKeep this file.\n").unwrap();
    fs::write(&outside_source, "# Outside\n\nDo not delete.\n").unwrap();

    let error = delete_local_skill_source(&root, &outside_source).unwrap_err();
    assert!(error.contains("not a Markdown file in the skills folder"));
    assert!(outside_source.exists());

    delete_local_skill_source(&root, &package_source).unwrap();
    assert!(!package_source.exists());
    assert!(package_support.exists());
    assert!(root.join("packaged").is_dir());

    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn local_skill_scan_fingerprint_changes_when_instructions_change() {
    let root = skill_test_directory("skill-fingerprint");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("review.md");
    fs::write(&source, "# Review\n\nFirst instructions.\n").unwrap();
    let first = scan_local_skills(&root).unwrap()[0]
        .content_fingerprint
        .clone();

    fs::write(&source, "# Review\n\nSecond instructions.\n").unwrap();
    let second = scan_local_skills(&root).unwrap()[0]
        .content_fingerprint
        .clone();
    assert_ne!(first, second);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_skill_editor_reads_and_updates_only_detected_skill_sources() {
    let root = skill_test_directory("skill-editor");
    fs::create_dir_all(root.join("references")).unwrap();
    let source = root.join("review.md");
    let supporting = root.join("references/details.md");
    fs::write(&source, "# Review\n\nOriginal instructions.\n").unwrap();
    fs::write(&supporting, "# Details\n\nSupporting material.\n").unwrap();

    assert_eq!(
        read_local_skill_source(&root, &source).unwrap(),
        "# Review\n\nOriginal instructions.\n"
    );
    update_local_skill_source(
        &root,
        &source,
        "# Review\n\nUpdated in Mythra Code.\n",
        "# Review\n\nOriginal instructions.\n",
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(&source).unwrap(),
        "# Review\n\nUpdated in Mythra Code.\n"
    );

    let error = update_local_skill_source(
        &root,
        &supporting,
        "# Rewritten\n",
        "# Details\n\nSupporting material.\n",
    )
    .unwrap_err();
    assert!(error.contains("not a detected Mythra Code skill"));
    assert_eq!(
        fs::read_to_string(&supporting).unwrap(),
        "# Details\n\nSupporting material.\n"
    );

    let error =
        update_local_skill_source(&root, &source, "   ", "# Review\n\nUpdated in Mythra Code.\n")
            .unwrap_err();
    assert!(error.contains("cannot be empty"));
    assert_eq!(
        fs::read_to_string(&source).unwrap(),
        "# Review\n\nUpdated in Mythra Code.\n"
    );

    fs::write(&source, "# Review\n\nChanged outside Mythra Code.\n").unwrap();
    let error = update_local_skill_source(
        &root,
        &source,
        "# Review\n\nStale editor draft.\n",
        "# Review\n\nUpdated in Mythra Code.\n",
    )
    .unwrap_err();
    assert!(error.contains("changed on disk"));
    assert_eq!(
        fs::read_to_string(&source).unwrap(),
        "# Review\n\nChanged outside Mythra Code.\n"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn skill_runtime_bridge_preserves_app_name_body_and_markdown_references() {
    let root = skill_test_directory("skill-runtime-source");
    let runtime = skill_test_directory("skill-runtime-output");
    fs::create_dir_all(root.join("references")).unwrap();
    let source = root.join("Release Notes.md");
    fs::write(&source, "---\nname: source-name\ndescription: Publish a careful release.\n---\n\n# Release\n\nRead [checks](references/checks.md), then publish.\n").unwrap();
    fs::write(
        root.join("references/checks.md"),
        "# Checks\n\nRun the tests.\n",
    )
    .unwrap();

    sync_skill_runtime_at(
        &runtime,
        &root,
        vec![SkillBridgeConfig {
            source_path: source.to_string_lossy().into_owned(),
            name: "ship-release".into(),
            enabled: true,
        }],
    )
    .unwrap();

    let bridge = fs::read_to_string(runtime.join("ship-release/SKILL.md")).unwrap();
    assert!(bridge.contains("name: \"ship-release\""));
    assert!(bridge.contains("description: \"Publish a careful release.\""));
    assert!(bridge.contains("# Release"));
    assert!(!bridge.contains("name: source-name"));
    assert!(runtime.join("ship-release/references/checks.md").is_file());
    assert!(runtime.join(".claude-plugin/plugin.json").is_file());
    assert!(runtime.join("skills/ship-release/SKILL.md").is_file());
    assert!(runtime
        .join("skills/ship-release/references/checks.md")
        .is_file());

    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(runtime).unwrap();
}

#[test]
fn command_exec_bridge_requires_a_bounded_explicit_sandbox() {
    let root = skill_test_directory("rpc-command-sandbox");
    let sibling = skill_test_directory("rpc-command-sibling");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    let valid = json!({
        "command": ["echo", "safe"],
        "cwd": root,
        "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": [root] },
    });
    assert!(validate_rpc_params("command/exec", &valid).is_ok());

    let mut missing_sandbox = valid.clone();
    missing_sandbox
        .as_object_mut()
        .unwrap()
        .remove("sandboxPolicy");
    assert!(validate_rpc_params("command/exec", &missing_sandbox)
        .unwrap_err()
        .contains("explicit sandbox"));

    let overbroad = json!({
        "command": ["echo", "unsafe"],
        "cwd": root,
        "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": [std::path::MAIN_SEPARATOR.to_string()] },
    });
    assert!(validate_rpc_params("command/exec", &overbroad)
        .unwrap_err()
        .contains("filesystem root"));

    let sibling_grant = json!({
        "command": ["echo", "unsafe"],
        "cwd": root,
        "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": [root, sibling] },
    });
    assert!(validate_rpc_params("command/exec", &sibling_grant)
        .unwrap_err()
        .contains("inside the working directory"));

    let missing_cwd_grant = json!({
        "command": ["echo", "unsafe"],
        "cwd": root,
        "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": [root.join("nested")] },
    });
    fs::create_dir_all(root.join("nested")).unwrap();
    assert!(validate_rpc_params("command/exec", &missing_cwd_grant)
        .unwrap_err()
        .contains("must grant its working directory"));
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(sibling).unwrap();
}

#[test]
fn command_exec_bridge_allows_an_isolated_worktrees_shared_git_directory() {
    let source = skill_test_directory("rpc-command-source");
    let worktree = skill_test_directory("rpc-command-worktree");
    fs::create_dir_all(&source).unwrap();
    test_git(&source, &["init", "-b", "main"]);
    fs::write(source.join("README.md"), "Mythra Code\n").unwrap();
    test_git(&source, &["add", "."]);
    test_git(&source, &["commit", "-m", "Initial"]);
    test_git(
        &source,
        &[
            "worktree",
            "add",
            "-b",
            "openkiwi/rpc-test",
            worktree.to_str().unwrap(),
        ],
    );
    let shared_git_dir = git_common_dir(&worktree).unwrap();
    let valid = json!({
        "command": ["git", "status"],
        "cwd": worktree,
        "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": [worktree, shared_git_dir] },
    });
    assert!(validate_rpc_params("command/exec", &valid).is_ok());

    test_git(
        &source,
        &["worktree", "remove", "--force", worktree.to_str().unwrap()],
    );
    fs::remove_dir_all(source).unwrap();
}

#[test]
fn config_bridge_is_limited_to_mcp_server_settings() {
    assert!(validate_rpc_params(
        "config/value/write",
        &json!({ "keyPath": "mcp_servers.example", "value": null }),
    ).is_ok());
    assert!(validate_rpc_params(
        "config/value/write",
        &json!({ "keyPath": "approval_policy", "value": "never" }),
    ).is_err());
}

// --- Cross-provider sub-agents ---------------------------------------------

fn child_target(id: &str, provider: &str, model: &str) -> ChildAgentTarget {
    ChildAgentTarget {
        id: id.into(),
        provider: provider.into(),
        model: model.into(),
        label: id.into(),
        description: String::new(),
        reasoning_mode: "inherit".into(),
        reasoning_effort: "medium".into(),
        reasoning_max_effort: "high".into(),
    }
}

#[test]
fn child_agent_destinations_accept_every_supported_provider() {
    let targets = vec![
        child_target("terra", "openai", "gpt-5.6-terra"),
        child_target("grok", "openrouter", "x-ai/grok-4.5"),
        child_target("reviewer", "claude", "claude-fable-5"),
        child_target("fast", "cursor", "auto"),
    ];
    assert!(validate_targets(&targets).is_ok());
}

#[test]
fn child_agent_destinations_reject_names_a_tool_enum_cannot_carry() {
    for bad in [
        "",
        "-leading",
        "Terra",
        "has space",
        "emoji🎯",
        &"a".repeat(41),
    ] {
        assert!(
            validate_targets(&[child_target(bad, "openai", "gpt-5.6-terra")]).is_err(),
            "`{bad}` should not be a valid destination name"
        );
    }
}

#[test]
fn child_agent_destinations_reject_duplicates_unknown_providers_and_oversized_fields() {
    let duplicate = vec![
        child_target("terra", "openai", "gpt-5.6-terra"),
        child_target("terra", "claude", "claude-fable-5"),
    ];
    assert!(validate_targets(&duplicate)
        .unwrap_err()
        .contains("Duplicate"));
    assert!(validate_targets(&[child_target("g", "gemini", "pro")])
        .unwrap_err()
        .contains("not a provider"));
    assert!(
        validate_targets(&[child_target("terra", "openai", &"m".repeat(129))]).is_err(),
        "an oversized model must be refused when the thread starts"
    );
    let too_many: Vec<_> = (0..25)
        .map(|index| child_target(&format!("agent{index}"), "openai", "gpt-5.6-terra"))
        .collect();
    assert!(validate_targets(&too_many).is_err());
}

#[test]
fn child_agent_tool_catalog_offers_only_approved_destinations() {
    let targets = vec![
        child_target("terra", "openai", "gpt-5.6-terra"),
        child_target("grok", "openrouter", "x-ai/grok-4.5"),
    ];
    let catalog = tool_catalog(&targets, 2);
    let tools = catalog.as_array().expect("catalog is a list");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect();
    assert_eq!(names, AGENT_BRIDGE_TOOLS.to_vec());
    assert_eq!(names[0], "spawn_mythra_agent");
    assert!(!names.contains(&"spawn_agent"));

    let spawn = &tools[0];
    let enumeration = spawn["inputSchema"]["properties"]["target"]["enum"]
        .as_array()
        .expect("the destination is an enum");
    assert_eq!(
        enumeration
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["terra", "grok"]
    );
    assert_eq!(
        spawn["inputSchema"]["required"],
        json!(["target", "prompt"])
    );
    assert_eq!(spawn["inputSchema"]["additionalProperties"], json!(false));
    // The provider/model pair is described, never accepted as free text.
    assert!(spawn["inputSchema"]["properties"].get("model").is_none());
    assert!(spawn["description"]
        .as_str()
        .unwrap()
        .contains("x-ai/grok-4.5"));
    assert!(spawn["description"]
        .as_str()
        .unwrap()
        .contains("At most 2 child agents may run concurrently"));
    assert!(spawn["description"]
        .as_str()
        .unwrap()
        .contains("only permitted sub-agent system"));
}

#[test]
fn child_agent_empty_roster_exposes_only_project_settings_proposals() {
    let catalog = tool_catalog(&[], 1);
    let names = catalog
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["propose_agent_settings"]);
}

#[test]
fn child_agent_spawn_requires_an_approved_destination_and_a_prompt() {
    let targets = vec![child_target("terra", "openai", "gpt-5.6-terra")];
    let none = HashSet::new();

    assert!(validate_tool_call(
        &targets,
        &none,
        "spawn_mythra_agent",
        &json!({ "target": "terra", "prompt": "Refactor the parser." })
    )
    .is_ok());

    let rejected = validate_tool_call(
        &targets,
        &none,
        "spawn_mythra_agent",
        &json!({ "target": "gemini-pro", "prompt": "Refactor the parser." }),
    )
    .unwrap_err();
    assert!(rejected.contains("not an approved destination"));
    assert!(
        rejected.contains("terra"),
        "the refusal lists what is allowed"
    );

    for bad in [
        json!({ "prompt": "Do it." }),
        json!({ "target": "terra" }),
        json!({ "target": "terra", "prompt": "   " }),
    ] {
        assert!(validate_tool_call(&targets, &none, "spawn_mythra_agent", &bad).is_err());
    }
    assert!(validate_tool_call(
        &targets,
        &none,
        "spawn_mythra_agent",
        &json!({ "target": "terra", "prompt": "x".repeat(32_769) })
    )
    .is_err());
    assert!(validate_tool_call(
        &targets,
        &none,
        "spawn_mythra_agent",
        &json!("not an object")
    )
    .is_err());
}

#[test]
fn child_agent_settings_proposals_require_a_reason_and_validate_the_roster() {
    let targets = vec![child_target("terra", "openai", "gpt-5.6-terra")];
    let none = HashSet::new();
    assert!(validate_tool_call(
        &targets,
        &none,
        "propose_agent_settings",
        &json!({
            "reason": "Use a focused reviewer.",
            "maxConcurrent": 2,
            "crossProviderEnabled": true,
            "targets": [{
                "id": "reviewer", "provider": "claude", "model": "claude-fable-5",
                "label": "Reviewer", "description": "Review changes",
                "reasoningMode": "fixed", "reasoningEffort": "high",
                "reasoningMaxEffort": "high"
            }]
        })
    )
    .is_ok());
    assert!(validate_tool_call(&targets, &none, "propose_agent_settings", &json!({})).is_err());
    assert!(validate_tool_call(
        &targets,
        &none,
        "propose_agent_settings",
        &json!({ "reason": "Bad limit", "maxConcurrent": 25 })
    )
    .is_err());
}

#[test]
fn cursor_agent_prompt_uses_process_lifetime_instead_of_control_timeout() {
    use crate::cursor::cursor_request_timeout;
    use std::time::Duration;

    assert_eq!(cursor_request_timeout("session/prompt"), None);
    // Session setup cold-starts the delegation bridge as an MCP server, so it
    // needs far more headroom than a control handshake.
    assert_eq!(
        cursor_request_timeout("session/new"),
        Some(Duration::from_secs(180))
    );
    assert_eq!(
        cursor_request_timeout("session/load"),
        Some(Duration::from_secs(180))
    );
    assert_eq!(
        cursor_request_timeout("session/set_model"),
        Some(Duration::from_secs(45))
    );
    assert_eq!(
        cursor_request_timeout("initialize"),
        Some(Duration::from_secs(45))
    );
}

#[test]
fn child_agent_spawn_enforces_user_reasoning_authority_and_ceiling() {
    let none = HashSet::new();
    let inherited = child_target("terra", "openai", "gpt-5.6-terra");
    assert!(validate_tool_call(
        &[inherited],
        &none,
        "spawn_mythra_agent",
        &json!({ "target": "terra", "prompt": "Implement it.", "reasoningEffort": "high" })
    )
    .unwrap_err()
    .contains("Main agent decides"));

    let mut agent_controlled = child_target("reviewer", "claude", "claude-fable-5");
    agent_controlled.reasoning_mode = "agent".into();
    agent_controlled.reasoning_max_effort = "high".into();
    assert!(validate_tool_call(
        &[agent_controlled.clone()],
        &none,
        "spawn_mythra_agent",
        &json!({ "target": "reviewer", "prompt": "Review it.", "reasoningEffort": "high" })
    )
    .is_ok());
    assert!(validate_tool_call(
        &[agent_controlled],
        &none,
        "spawn_mythra_agent",
        &json!({ "target": "reviewer", "prompt": "Review it.", "reasoningEffort": "ultra" })
    )
    .unwrap_err()
    .contains("ceiling"));
}

#[test]
fn child_agent_lifecycle_tools_only_reach_this_thread_s_own_children() {
    let targets = vec![child_target("terra", "openai", "gpt-5.6-terra")];
    let mut known = HashSet::new();
    known.insert("child-1".to_string());

    for tool in ["collect_agent", "cancel_agent"] {
        assert!(
            validate_tool_call(&targets, &known, tool, &json!({ "childId": "child-1" })).is_ok()
        );
        assert!(validate_tool_call(
            &targets,
            &known,
            tool,
            &json!({ "childId": "someone-elses" })
        )
        .unwrap_err()
        .contains("not spawned from this thread"));
        assert!(validate_tool_call(&targets, &known, tool, &json!({})).is_err());
    }
    // A status call with no id is a request for every child of this thread.
    assert!(validate_tool_call(&targets, &known, "agent_status", &json!({})).is_ok());
    assert!(validate_tool_call(
        &targets,
        &known,
        "agent_status",
        &json!({ "childId": "nope" })
    )
    .is_err());

    assert!(validate_tool_call(
        &targets,
        &known,
        "collect_agent",
        &json!({ "childId": "child-1", "timeoutSeconds": 30 })
    )
    .is_ok());
    for bad in [json!(0), json!(46), json!(9000), json!("soon")] {
        assert!(validate_tool_call(
            &targets,
            &known,
            "collect_agent",
            &json!({ "childId": "child-1", "timeoutSeconds": bad })
        )
        .is_err());
    }
    assert!(validate_tool_call(&targets, &known, "rm_rf", &json!({}))
        .unwrap_err()
        .contains("not a sub-agent tool"));
}

#[test]
fn bridge_tokens_are_compared_without_leaking_their_length_by_early_exit() {
    let token = random_hex_token().expect("token");
    assert!(tokens_match(&token, &token.clone()));
    assert!(!tokens_match(&token, &token[..token.len() - 1]));
    assert!(!tokens_match("", "a"));
    let mut wrong = token.clone();
    wrong.replace_range(0..1, if token.starts_with('a') { "b" } else { "a" });
    assert!(!tokens_match(&token, &wrong));
}

#[test]
fn bridge_answers_the_mcp_handshake_without_reaching_the_app() {
    let initialize = bridge_local_response("initialize", Some(&json!(1)))
        .expect("handled locally")
        .expect("answered");
    assert_eq!(
        initialize["result"]["serverInfo"]["name"],
        AGENT_BRIDGE_SERVER
    );
    assert_eq!(AGENT_BRIDGE_SERVER, "mythra_agents");
    assert_eq!(initialize["result"]["protocolVersion"], "2025-06-18");
    assert!(initialize["result"]["capabilities"]["tools"].is_object());
    assert!(initialize["result"]["instructions"]
        .as_str()
        .is_some_and(|instructions| instructions.contains("spawn_mythra_agent")
            && instructions.contains("never use collaboration.spawn_agent")));

    assert_eq!(
        bridge_local_response("ping", Some(&json!("a")))
            .expect("handled locally")
            .expect("answered")["result"],
        json!({})
    );

    // Notifications must never be answered, or the runtime sees a stray reply.
    assert!(bridge_local_response("notifications/initialized", None)
        .expect("handled locally")
        .is_none());

    // Tool traffic is deliberately left to the networked path.
    assert!(bridge_local_response("tools/list", Some(&json!(2))).is_none());
    assert!(bridge_local_response("tools/call", Some(&json!(3))).is_none());

    let unknown = bridge_local_response("resources/read", Some(&json!(4)))
        .expect("handled locally")
        .expect("answered");
    assert_eq!(unknown["error"]["code"], -32601);
}

#[test]
fn lmstudio_urls_are_normalized_without_accepting_embedded_credentials() {
    assert_eq!(
        normalize_lmstudio_base_url("http://127.0.0.1:1234")
            .expect("valid local URL")
            .as_str(),
        "http://127.0.0.1:1234/v1"
    );
    assert_eq!(
        normalize_lmstudio_base_url("https://studio.example.test/openkiwi/v1/")
            .expect("valid reverse proxy URL")
            .as_str(),
        "https://studio.example.test/openkiwi/v1"
    );
    assert!(normalize_lmstudio_base_url("file:///tmp/socket").is_err());
    assert!(normalize_lmstudio_base_url("http://user:secret@127.0.0.1:1234/v1").is_err());
    assert!(normalize_lmstudio_base_url("http://127.0.0.1:1234/v1?token=secret").is_err());
}

#[test]
fn lmstudio_is_an_approved_mythra_code_agent_destination() {
    assert!(super::agents::agent_bridge_providers().contains(&"lmstudio"));
}

#[test]
fn lmstudio_catalog_exposes_only_language_models_and_coding_capabilities() {
    let catalog = normalize_lmstudio_model_catalog(&json!({
        "models": [
            {
                "type": "llm",
                "key": "qwen/local-coder",
                "display_name": "Local Coder",
                "publisher": "qwen",
                "max_context_length": 65536,
                "capabilities": { "trained_for_tool_use": true, "reasoning": { "default": "high" } }
            },
            { "type": "embedding", "key": "nomic/embed", "display_name": "Embed" }
        ]
    }))
    .expect("native LM Studio catalog");
    assert_eq!(catalog["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(catalog["data"][0]["id"], "qwen/local-coder");
    assert_eq!(catalog["data"][0]["context_length"], 65536);
    assert_eq!(catalog["data"][0]["trained_for_tool_use"], true);
}

#[test]
fn openrouter_slug_lookup_accepts_real_slugs_and_variants() {
    assert_eq!(
        openrouter_model_path("moonshotai/kimi-k2").unwrap(),
        "moonshotai/kimi-k2"
    );
    // A `:free`/`:batch` suffix selects a routing variant of the same catalog
    // entry, so the lookup path drops it.
    assert_eq!(
        openrouter_model_path("  z-ai/glm-5.2:free  ").unwrap(),
        "z-ai/glm-5.2"
    );
}

#[test]
fn openrouter_slug_lookup_cannot_climb_out_of_the_models_path() {
    for slug in [
        "",
        "kimi",
        "moonshotai/",
        "/moonshotai/kimi-k2",
        "../../keys",
        "moonshotai/../../keys",
        "moonshotai/./kimi",
        "a//b",
    ] {
        assert!(
            openrouter_model_path(slug).is_err(),
            "expected {slug:?} to be rejected"
        );
    }
}

#[test]
fn openrouter_account_catalog_keeps_only_tool_capable_models() {
    let catalog = openrouter_tool_models(json!({
        "data": [
            { "id": "vendor/agent", "supported_parameters": ["tools", "reasoning"] },
            { "id": "vendor/chat", "supported_parameters": ["temperature"] },
            { "id": "vendor/unknown" }
        ]
    }));
    assert_eq!(catalog["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(catalog["data"][0]["id"], "vendor/agent");
}
