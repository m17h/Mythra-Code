//! Shared, private language servers. Recipes and executable lookup are app-owned;
//! project files can select languages but never provide commands or install arguments.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::{Mutex, Semaphore},
    time::timeout,
};

pub(super) const LANGUAGE_TOOL_IDS: [&str; 25] = [
    "typescript",
    "python",
    "php",
    "web",
    "yaml",
    "rust",
    "go",
    "cpp",
    "csharp",
    "swift",
    "java",
    "kotlin",
    "lua",
    "ruby",
    "bash",
    "docker",
    "svelte",
    "astro",
    "solidity",
    "toml",
    "markdown",
    "dart",
    "zig",
    "terraform",
    "vue",
];
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LanguageToolsSnapshot {
    #[serde(default = "default_true")]
    pub auto_install: bool,
    pub generation: u64,
    pub tools: Vec<LanguageToolStatus>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LanguageToolStatus {
    pub id: String,
    pub name: String,
    pub languages: Vec<String>,
    pub state: String,
    pub detail: String,
    pub enabled: bool,
    pub health: String,
}
fn default_true() -> bool {
    true
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default = "default_true")]
    auto_install: bool,
    #[serde(default)]
    enabled: BTreeMap<String, bool>,
    #[serde(default)]
    installations: BTreeMap<String, String>,
    #[serde(default)]
    errors: BTreeMap<String, String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_install: true,
            enabled: BTreeMap::new(),
            installations: BTreeMap::new(),
            errors: BTreeMap::new(),
        }
    }
}
struct Runtime {
    settings: Mutex<Settings>,
    installs: Mutex<()>,
    installing: StdMutex<BTreeSet<String>>,
    generation: AtomicU64,
    inventory: Mutex<Option<(Instant, LanguageToolsSnapshot)>>,
    refreshes: Mutex<Option<RefreshCompletion>>,
}
struct RefreshCompletion {
    finished: Instant,
    ids: BTreeSet<String>,
    scope: Option<(PathBuf, String)>,
    settings: [u8; 32],
}
type RuntimeMap = StdMutex<HashMap<PathBuf, Arc<Runtime>>>;
fn runtimes() -> &'static RuntimeMap {
    static RUNTIMES: OnceLock<RuntimeMap> = OnceLock::new();
    RUNTIMES.get_or_init(Default::default)
}

struct Tool {
    id: &'static str,
    name: &'static str,
    languages: &'static [&'static str],
    extensions: &'static [(&'static str, &'static str)],
    packages: &'static [&'static str],
    servers: &'static [(&'static str, &'static str)],
    binary: Option<&'static str>,
    help: &'static str,
}
const TOOLS: &[Tool] = &[
    Tool { id: "typescript", name: "TypeScript / JavaScript", languages: &["TypeScript", "JavaScript"], extensions: &[(".ts", "typescript"), (".tsx", "typescriptreact"), (".js", "javascript"), (".jsx", "javascriptreact"), (".mts", "typescript"), (".cts", "typescript"), (".mjs", "javascript"), (".cjs", "javascript")], packages: &["typescript-language-server@5.1.3", "typescript@5.9.3"], servers: &[("typescript-language-server", "lib/cli.mjs")], binary: None, help: "Install Node.js 20 or newer, then install this tool here." },
    Tool { id: "python", name: "Python (Pyright)", languages: &["Python"], extensions: &[(".py", "python"), (".pyi", "python")], packages: &["pyright@1.1.414"], servers: &[("pyright", "langserver.index.js")], binary: None, help: "Install Node.js 20 or newer, then install Pyright here. Project Python environments remain separate." },
    Tool { id: "php", name: "PHP (Intelephense)", languages: &["PHP"], extensions: &[(".php", "php"), (".phtml", "php")], packages: &["intelephense@1.18.5"], servers: &[("intelephense", "lib/intelephense.js")], binary: None, help: "Install Node.js 20 or newer, then install Intelephense here. Premium features require a separate license." },
    Tool { id: "web", name: "HTML / CSS / JSON", languages: &["HTML", "CSS", "JSON"], extensions: &[(".html", "html"), (".htm", "html"), (".css", "css"), (".scss", "scss"), (".less", "less"), (".json", "json"), (".jsonc", "jsonc")], packages: &["vscode-langservers-extracted@4.10.0"], servers: &[("vscode-langservers-extracted", "bin/vscode-html-language-server"), ("vscode-langservers-extracted", "bin/vscode-css-language-server"), ("vscode-langservers-extracted", "bin/vscode-json-language-server")], binary: None, help: "Install Node.js 20 or newer, then install these servers here." },
    Tool { id: "yaml", name: "YAML", languages: &["YAML"], extensions: &[(".yaml", "yaml"), (".yml", "yaml")], packages: &["yaml-language-server@1.24.0"], servers: &[("yaml-language-server", "bin/yaml-language-server")], binary: None, help: "Install Node.js 20 or newer, then install the YAML server here." },
    Tool { id: "rust", name: "Rust (rust-analyzer)", languages: &["Rust"], extensions: &[(".rs", "rust")], packages: &[], servers: &[], binary: Some("rust-analyzer"), help: "Install rust-analyzer through your Rust toolchain (rustup component add rust-analyzer), then refresh. Mythra Code does not change that toolchain." },
    Tool { id: "go", name: "Go (gopls)", languages: &["Go"], extensions: &[(".go", "go")], packages: &[], servers: &[], binary: Some("gopls"), help: "Install Go 1.24 or newer, then install gopls here. Its binary and build cache stay in Mythra Code's private storage." },
    Tool { id: "cpp", name: "C / C++ / Objective-C (clangd)", languages: &["C", "C++", "Objective-C"], extensions: &[(".c", "c"), (".h", "c"), (".cc", "cpp"), (".cpp", "cpp"), (".cxx", "cpp"), (".hpp", "cpp"), (".hxx", "cpp"), (".hh", "cpp"), (".m", "objective-c"), (".mm", "objective-cpp")], packages: &[], servers: &[], binary: Some("clangd"), help: "Install LLVM's clangd with your platform's development tools, then refresh. Automatic native compiler installation is unavailable." },
    Tool { id: "csharp", name: "C#", languages: &["C#"], extensions: &[(".cs", "csharp")], packages: &[], servers: &[], binary: Some("csharp-ls"), help: "Install a compatible .NET SDK and csharp-ls through your .NET toolchain, then refresh. Automatic .NET toolchain installation is unavailable." },
    Tool { id: "swift", name: "Swift (SourceKit-LSP)", languages: &["Swift"], extensions: &[(".swift", "swift")], packages: &[], servers: &[], binary: Some("sourcekit-lsp"), help: "Install Swift development tools with SourceKit-LSP, then refresh. Automatic Swift toolchain installation is unavailable." },
    Tool { id: "java", name: "Java (Eclipse JDT LS)", languages: &["Java"], extensions: &[(".java", "java")], packages: &[], servers: &[], binary: Some("jdtls"), help: "Install a compatible Java SDK and Eclipse JDT language server with a jdtls launcher, then refresh. Automatic Java toolchain installation is unavailable." },
    Tool { id: "kotlin", name: "Kotlin", languages: &["Kotlin"], extensions: &[(".kt", "kotlin"), (".kts", "kotlin")], packages: &[], servers: &[], binary: Some("kotlin-lsp"), help: "Install Kotlin's language server and required Java SDK with a kotlin-lsp launcher, then refresh. Automatic Kotlin toolchain installation is unavailable." },
    Tool { id: "lua", name: "Lua", languages: &["Lua"], extensions: &[(".lua", "lua")], packages: &[], servers: &[], binary: Some("lua-language-server"), help: "Install lua-language-server using your platform's development tools, then refresh. Automatic native Lua server installation is unavailable." },
    Tool { id: "ruby", name: "Ruby", languages: &["Ruby"], extensions: &[(".rb", "ruby"), (".rake", "ruby")], packages: &[], servers: &[], binary: Some("ruby-lsp"), help: "Install Ruby and the ruby-lsp gem with your Ruby toolchain, then refresh. Automatic Ruby toolchain installation is unavailable." },
    Tool { id: "bash", name: "Bash / Shell", languages: &["Bash", "Shell"], extensions: &[(".sh", "shellscript"), (".bash", "shellscript")], packages: &["bash-language-server@5.8.1"], servers: &[("bash-language-server", "out/cli.js")], binary: None, help: "Install Node.js 20 or newer, then install the Bash server here. ShellCheck and shfmt are optional separate tools." },
    Tool { id: "docker", name: "Dockerfile", languages: &["Dockerfile"], extensions: &[(".dockerfile", "dockerfile")], packages: &["dockerfile-language-server-nodejs@0.15.0"], servers: &[("dockerfile-language-server-nodejs", "bin/docker-langserver")], binary: None, help: "Install Node.js 20 or newer, then install the Dockerfile server here. Docker itself is not required." },
    Tool { id: "svelte", name: "Svelte", languages: &["Svelte"], extensions: &[(".svelte", "svelte")], packages: &["svelte-language-server@0.18.4", "typescript@5.9.3"], servers: &[("svelte-language-server", "bin/server.js")], binary: None, help: "Install Node.js 20 or newer, then install the Svelte server here. Project Svelte dependencies remain separate." },
    Tool { id: "astro", name: "Astro", languages: &["Astro"], extensions: &[(".astro", "astro")], packages: &["@astrojs/language-server@2.17.2", "typescript@5.9.3"], servers: &[("@astrojs/language-server", "bin/nodeServer.js")], binary: None, help: "Install Node.js 20 or newer, then install the Astro server here. Project Astro dependencies remain separate." },
    Tool { id: "solidity", name: "Solidity", languages: &["Solidity"], extensions: &[(".sol", "solidity")], packages: &["@nomicfoundation/solidity-language-server@0.9.3"], servers: &[("@nomicfoundation/solidity-language-server", "out/index.js")], binary: None, help: "Install Node.js 22.15.1 or newer, then install the Solidity server here. Project build tools remain separate." },
    Tool { id: "toml", name: "TOML (Taplo)", languages: &["TOML"], extensions: &[(".toml", "toml")], packages: &[], servers: &[], binary: Some("taplo"), help: "Install the native Taplo CLI with language-server support, then refresh. The npm/WASM CLI cannot run a language server." },
    Tool { id: "markdown", name: "Markdown (Marksman)", languages: &["Markdown"], extensions: &[(".md", "markdown"), (".markdown", "markdown")], packages: &[], servers: &[], binary: Some("marksman"), help: "Install Marksman using your platform's development tools, then refresh. Cross-file links require a Git project or .marksman.toml." },
    Tool { id: "dart", name: "Dart / Flutter", languages: &["Dart", "Flutter"], extensions: &[(".dart", "dart")], packages: &[], servers: &[], binary: Some("dart"), help: "Install the Dart or Flutter SDK and make its dart executable available, then refresh. Automatic SDK installation is unavailable." },
    Tool { id: "zig", name: "Zig (ZLS)", languages: &["Zig"], extensions: &[(".zig", "zig"), (".zon", "zig")], packages: &[], servers: &[], binary: Some("zls"), help: "Install ZLS matching your Zig SDK version, then refresh. Automatic Zig toolchain installation is unavailable." },
    Tool { id: "terraform", name: "Terraform", languages: &["Terraform"], extensions: &[(".tf", "terraform"), (".tfvars", "terraform-vars")], packages: &[], servers: &[], binary: Some("terraform-ls"), help: "Install HashiCorp's terraform-ls using your platform's development tools, then refresh. Automatic Terraform toolchain installation is unavailable." },
    // Vue 3+ servers require editor-specific TypeScript request forwarding. The
    // last standalone line provides real code intelligence with hybrid mode off.
    Tool { id: "vue", name: "Vue (standalone Volar)", languages: &["Vue"], extensions: &[(".vue", "vue")], packages: &["@vue/language-server@2.2.12", "typescript@5.9.3"], servers: &[("@vue/language-server", "bin/vue-language-server.js")], binary: None, help: "Install Node.js 20 or newer, then install the compatible standalone Vue server here. This uses Volar 2.2.12 with hybrid mode disabled." },
];
pub(super) fn is_known_tool(id: &str) -> bool {
    LANGUAGE_TOOL_IDS.contains(&id)
}
pub(super) fn server_allowed_in_mode(id: &str, permission: &str) -> bool {
    permission == "full" || ["typescript", "python", "web", "yaml"].contains(&id)
}
fn tool(id: &str) -> Result<&'static Tool, String> {
    TOOLS
        .iter()
        .find(|tool| tool.id == id)
        .ok_or_else(|| "Unknown language tool.".into())
}

fn redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}
fn private_dir(path: &Path) -> Result<(), String> {
    // App storage may not be redirected into a project or another user's files.
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            if redirected(&metadata) || !metadata.is_dir() {
                return Err("Language tool storage is redirected or unavailable.".into());
            }
        }
    }
    fs::create_dir_all(path).map_err(|_| "Could not create private language tool storage.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect language tool storage.")?;
    }
    Ok(())
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = crate::release_qa::app_data_dir(app)
        .map_err(|_| "Could not resolve language tool storage.")?
        .join("language-tools");
    private_dir(&root)?;
    Ok(root)
}
fn read_settings(root: &Path) -> Result<Settings, String> {
    let path = root.join("settings.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Ok(metadata) if !redirected(&metadata) && metadata.is_file() && metadata.len() <= 65536 => {
            let settings: Settings = serde_json::from_slice(
                &fs::read(path).map_err(|_| "Could not read language tool settings.")?,
            )
            .map_err(|_| "Language tool settings are invalid; existing settings were preserved.")?;
            if settings
                .installations
                .iter()
                .any(|(id, value)| !is_known_tool(id) || uuid::Uuid::parse_str(value).is_err())
            {
                return Err("Language tool installation records are invalid.".into());
            }
            Ok(settings)
        }
        _ => Err("Language tool settings cannot be read safely.".into()),
    }
}
fn runtime(root: &Path) -> Result<Arc<Runtime>, String> {
    let mut runtimes = runtimes()
        .lock()
        .map_err(|_| "Language tool state is unavailable.")?;
    if let Some(runtime) = runtimes.get(root) {
        return Ok(runtime.clone());
    }
    let runtime = Arc::new(Runtime {
        settings: Mutex::new(read_settings(root)?),
        installs: Mutex::new(()),
        installing: StdMutex::new(BTreeSet::new()),
        generation: AtomicU64::new(1),
        inventory: Mutex::new(None),
        refreshes: Mutex::new(None),
    });
    runtimes.insert(root.to_path_buf(), runtime.clone());
    Ok(runtime)
}
#[cfg(not(windows))]
fn replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}
#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid language tool storage path.")?;
    private_dir(parent)?;
    if fs::symlink_metadata(path).is_ok_and(|m| redirected(&m) || !m.is_file()) {
        return Err("Language tool storage file is redirected.".into());
    }
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| "Could not encode language tool settings.")?;
    if fs::symlink_metadata(path).is_ok_and(|metadata| {
        !redirected(&metadata) && metadata.is_file() && metadata.len() == bytes.len() as u64
    }) && fs::read(path).is_ok_and(|existing| existing == bytes)
        && fs::symlink_metadata(path)
            .is_ok_and(|metadata| !redirected(&metadata) && metadata.is_file())
    {
        return Ok(());
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| {
        "Could not save language tool settings; previous settings were preserved.".into()
    })
}
fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid language tool storage path.")?;
    private_dir(parent)?;
    if fs::symlink_metadata(path).is_ok_and(|metadata| redirected(&metadata) || !metadata.is_file())
    {
        return Err("Language tool storage file is redirected.".into());
    }
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| "Could not save the managed language tool recipe.".into())
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}
pub(super) fn child_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    // Windows canonical paths use the Win32 verbatim prefix. Node/npm's path
    // traversal and Go tooling require conventional drive or UNC arguments.
    #[cfg(windows)]
    {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(drive) = path.strip_prefix(r"\\?\") {
            return drive.to_string();
        }
    }
    path.into_owned()
}
fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}
fn system_binary(name: &str) -> Option<PathBuf> {
    // Deliberately do not search project PATH, node_modules, or the current directory.
    let mut directories = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/go/bin"), PathBuf::from("/Library/Developer/CommandLineTools/usr/bin"), PathBuf::from("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin")];
    if let Some(home) =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
    {
        directories.extend([
            home.join(".cargo/bin"),
            home.join("go/bin"),
            home.join(".dotnet/tools"),
            home.join(".local/bin"),
            home.join(".local/share/swiftly/bin"),
            home.join(".volta/bin"),
            home.join(".local/share/mise/shims"),
        ]);
        // Common nvm installations, bounded and independent of project configuration.
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<_> = entries
                .take(64)
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin"))
                .collect();
            versions.sort();
            versions.reverse();
            directories.extend(versions);
        }
        if name == "ruby-lsp" || name == "ruby" {
            for root in [
                home.join(".gem/ruby"),
                PathBuf::from("/opt/homebrew/lib/ruby/gems"),
                PathBuf::from("/usr/local/lib/ruby/gems"),
            ] {
                if let Ok(entries) = fs::read_dir(root) {
                    directories.extend(
                        entries
                            .take(64)
                            .filter_map(Result::ok)
                            .map(|entry| entry.path().join("bin")),
                    );
                }
            }
        }
    }
    if cfg!(windows) {
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(variable).map(PathBuf::from) {
                directories.extend([
                    dir.join("nodejs"),
                    dir.join("Go/bin"),
                    dir.join("LLVM/bin"),
                    dir.join("Swift/bin"),
                ]);
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            directories.push(local.join("Programs/nodejs"));
        }
    }
    directories
        .into_iter()
        .map(|directory| directory.join(executable_name(name)))
        .find(|path| path.is_absolute() && executable(path))
}
#[derive(Clone, Debug)]
pub(super) struct Launch {
    pub(super) command: PathBuf,
    pub(super) args: Vec<String>,
    pub(super) extensions: Vec<(String, String)>,
    pub(super) initialization_options: Option<Value>,
}
fn server_arguments(id: &str) -> &'static [&'static str] {
    match id {
        "bash" => &["start"],
        "go" | "terraform" => &["serve"],
        "toml" => &["lsp", "stdio"],
        "markdown" => &["server"],
        "dart" => &["language-server", "--protocol=lsp"],
        "rust" | "cpp" | "csharp" | "swift" | "java" | "kotlin" | "lua" | "ruby" | "zig" => &[],
        _ => &["--stdio"],
    }
}
// Extension mappings remain valid Claude plugin suffixes. Extensionless filenames
// are selected separately without inventing an unsupported plugin configuration.
fn language_for_file(tool: &Tool, file: &Path) -> Option<String> {
    let name = file.file_name()?.to_str()?.to_ascii_lowercase();
    if tool.id == "docker" && (name == "dockerfile" || name.starts_with("dockerfile.")) {
        return Some("dockerfile".into());
    }
    tool.extensions
        .iter()
        .find_map(|(extension, language)| name.ends_with(extension).then(|| (*language).into()))
}
fn launches(tool: &Tool, prefix: Option<&Path>) -> Vec<Launch> {
    let extensions = || {
        tool.extensions
            .iter()
            .map(|(ext, language)| (ext.to_string(), language.to_string()))
            .collect()
    };
    if !tool.packages.is_empty() {
        let Some(node) = system_binary("node") else {
            return vec![];
        };
        let mut prefixes = prefix
            .map(Path::to_path_buf)
            .into_iter()
            .collect::<Vec<_>>();
        prefixes.extend(global_npm_prefixes(&node));
        let Some(prefix) = prefixes.into_iter().find(|prefix| {
            tool.servers.iter().all(|(package, script)| {
                prefix
                    .join("node_modules")
                    .join(package)
                    .join(script)
                    .is_file()
            }) && (!matches!(tool.id, "typescript" | "astro" | "vue")
                || prefix
                    .join("node_modules/typescript/lib/tsserver.js")
                    .is_file())
        }) else {
            return vec![];
        };
        return tool
            .servers
            .iter()
            .enumerate()
            .filter_map(|(index, (package, script))| {
                let script = prefix.join("node_modules").join(package).join(script);
                if !script.is_file() {
                    return None;
                }
                let mappings = if tool.id == "web" {
                    tool.extensions
                        .iter()
                        .filter(|(_, language)| match index {
                            0 => *language == "html",
                            1 => ["css", "scss", "less"].contains(language),
                            _ => ["json", "jsonc"].contains(language),
                        })
                        .map(|(ext, language)| (ext.to_string(), language.to_string()))
                        .collect()
                } else {
                    extensions()
                };
                Some(Launch {
                    command: node.clone(),
                    args: std::iter::once(child_path(&script)).chain(server_arguments(tool.id).iter().map(|argument| (*argument).into())).collect(),
                    extensions: mappings,
                    initialization_options: match tool.id {
                        "typescript" => Some(json!({"tsserver":{"path":child_path(&prefix.join("node_modules/typescript/lib/tsserver.js")),"useSyntaxServer":"never"},"disableAutomaticTypingAcquisition":true})),
                        "astro" => Some(json!({"typescript":{"tsdk":child_path(&prefix.join("node_modules/typescript/lib"))}})),
                        "vue" => Some(json!({"typescript":{"tsdk":child_path(&prefix.join("node_modules/typescript/lib"))},"vue":{"hybridMode":false}})),
                        _ => None,
                    },
                })
            })
            .collect();
    }
    let Some(binary) = tool.binary else {
        return vec![];
    };
    let managed = prefix
        .map(|prefix| prefix.join("bin").join(executable_name(binary)))
        .filter(|path| executable(path));
    managed
        .or_else(|| system_binary(binary))
        .map(|command| Launch {
            command,
            args: server_arguments(tool.id)
                .iter()
                .map(|argument| (*argument).into())
                .collect(),
            extensions: extensions(),
            initialization_options: None,
        })
        .into_iter()
        .collect()
}
fn global_npm_prefixes(node: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/opt/homebrew/lib"),
        PathBuf::from("/usr/local/lib"),
    ];
    if let Ok(real) = fs::canonicalize(node) {
        if let Some(parent) = real.parent() {
            roots.push(parent.join("../lib"));
            roots.push(parent.into());
        }
    }
    if let Some(home) =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
    {
        roots.extend([home.join(".npm-global/lib"), home.join(".local/lib")]);
    }
    if cfg!(windows) {
        if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(roaming.join("npm"));
        }
    }
    roots.into_iter().filter(|p| p.is_absolute()).collect()
}

#[derive(Clone, PartialEq, Eq)]
struct FileIdentity {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    stamp: String,
    digest: [u8; 32],
}
#[derive(Clone, PartialEq, Eq)]
struct LaunchIdentity {
    files: Vec<FileIdentity>,
    configuration: [u8; 32],
}
#[derive(Clone, PartialEq, Eq)]
struct ExecutableProof {
    identity: LaunchIdentity,
    checked: Instant,
    error: Option<String>,
}
type HealthProofs = StdMutex<HashMap<(PathBuf, String), Vec<ExecutableProof>>>;
fn proofs() -> &'static HealthProofs {
    static PROOFS: OnceLock<HealthProofs> = OnceLock::new();
    PROOFS.get_or_init(Default::default)
}
type ProbeGates = StdMutex<HashMap<(PathBuf, String), Arc<Mutex<()>>>>;
fn probe_gate(key: &(PathBuf, String)) -> Result<Arc<Mutex<()>>, String> {
    static GATES: OnceLock<ProbeGates> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Language server probes are unavailable.")?;
    if gates.len() >= 128 && !gates.contains_key(key) {
        gates.retain(|_, gate| Arc::strong_count(gate) > 1);
    }
    if gates.len() >= 512 && !gates.contains_key(key) {
        return Err("Too many language server health checks are active.".into());
    }
    Ok(gates.entry(key.clone()).or_default().clone())
}
fn probe_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(4))
}
fn cached_health(key: &(PathBuf, String), identity: &LaunchIdentity) -> Option<Result<(), String>> {
    proofs().lock().ok()?.get(key)?.iter().find_map(|proof| {
        let ttl = if proof.error.is_some() { 10 } else { 120 };
        (proof.identity == *identity && proof.checked.elapsed() < Duration::from_secs(ttl))
            .then(|| proof.error.clone().map_or(Ok(()), Err))
    })
}
fn cached_metadata_health(
    key: &(PathBuf, String),
    identity: &LaunchIdentity,
) -> Option<Result<(), String>> {
    proofs().lock().ok()?.get(key)?.iter().find_map(|proof| {
        let ttl = if proof.error.is_some() { 10 } else { 120 };
        let same = proof.identity.configuration == identity.configuration
            && proof.identity.files.len() == identity.files.len()
            && proof
                .identity
                .files
                .iter()
                .zip(&identity.files)
                .all(|(old, current)| {
                    old.path == current.path
                        && old.size == current.size
                        && old.modified == current.modified
                        && old.stamp == current.stamp
                });
        (same && proof.checked.elapsed() < Duration::from_secs(ttl))
            .then(|| proof.error.clone().map_or(Ok(()), Err))
    })
}
fn proof_matches(key: &(PathBuf, String), current: &[LaunchIdentity]) -> bool {
    current
        .iter()
        .all(|identity| cached_health(key, identity) == Some(Ok(())))
}
fn remember_health(key: &(PathBuf, String), identity: LaunchIdentity, error: Option<String>) {
    if let Ok(mut proofs) = proofs().lock() {
        // Bound profile/catalog proof retention. Each tool has at most three roles.
        if proofs.len() >= 128 && !proofs.contains_key(key) {
            if let Some(oldest) = proofs
                .iter()
                .min_by_key(|(_, entries)| entries.iter().map(|p| p.checked).max())
                .map(|(key, _)| key.clone())
            {
                proofs.remove(&oldest);
            }
        }
        let entries = proofs.entry(key.clone()).or_default();
        entries.retain(|proof| {
            proof.identity != identity && proof.checked.elapsed() < Duration::from_secs(120)
        });
        if entries.len() >= 6 {
            entries.remove(0);
        }
        entries.push(ExecutableProof {
            identity,
            checked: Instant::now(),
            error,
        });
    }
    if let Ok(runtime) = runtime(&key.0) {
        runtime.generation.fetch_add(1, Ordering::SeqCst);
    }
}
fn invalidate_failures(root: &Path) {
    if let Ok(mut proofs) = proofs().lock() {
        for ((profile, _), entries) in proofs.iter_mut() {
            if profile == root {
                entries.retain(|proof| proof.error.is_none());
            }
        }
    }
}
fn file_metadata_identity(path: &Path) -> Option<FileIdentity> {
    let path = fs::canonicalize(path).ok()?;
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 512 * 1024 * 1024 {
        return None;
    }
    #[cfg(unix)]
    let stamp = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    };
    #[cfg(not(unix))]
    let stamp = String::new();
    Some(FileIdentity {
        path,
        size: metadata.len(),
        modified: metadata.modified().ok(),
        stamp,
        digest: [0; 32],
    })
}
fn file_identity(path: &Path) -> Option<FileIdentity> {
    let mut identity = file_metadata_identity(path)?;
    let path = identity.path.clone();
    // Unix change time detects even same-size edits with restored modification time.
    // Other platforms rehash rather than assume a stat tuple is content identity.
    static HASHES: OnceLock<StdMutex<HashMap<PathBuf, FileIdentity>>> = OnceLock::new();
    let hashes = HASHES.get_or_init(Default::default);
    if cfg!(unix) {
        if let Some(cached) = hashes.lock().ok()?.get(&path) {
            if cached.size == identity.size
                && cached.modified == identity.modified
                && cached.stamp == identity.stamp
            {
                return Some(cached.clone());
            }
        }
    }
    let mut file = fs::File::open(&path).ok()?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    let mut bytes = 0u64;
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > 512 * 1024 * 1024 {
            return None;
        }
        hash.update(&buffer[..count]);
    }
    let after = file_metadata_identity(&path)?;
    if bytes != identity.size || after != identity {
        return None;
    }
    identity.digest = hash.finalize().into();
    if let Ok(mut hashes) = hashes.lock() {
        if hashes.len() >= 512 {
            hashes.clear();
        }
        hashes.insert(path, identity.clone());
    }
    Some(identity)
}
pub(super) fn tool_ids_for_file(file: &Path) -> Vec<String> {
    TOOLS
        .iter()
        .filter(|tool| language_for_file(tool, file).is_some())
        .map(|tool| tool.id.to_string())
        .collect()
}
pub(super) fn detected_tools(project: &Path) -> Result<Vec<String>, String> {
    detect_project(project).map(|(_, detected)| detected.into_iter().collect())
}
fn sdk_runtime_paths(sdk: &Path) -> Option<Vec<PathBuf>> {
    let entries = fs::read_dir(sdk)
        .ok()?
        .take(1025)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if entries.len() > 1024 {
        return None;
    }
    let mut paths = entries
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| {
            matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("js" | "json")
            )
        })
        .collect::<Vec<_>>();
    paths.extend([sdk.join("tsserver.js"), sdk.join("typescript.js")]);
    Some(paths)
}
fn identities_inner(launches: &[Launch], content: bool) -> Option<Vec<LaunchIdentity>> {
    let mut result = Vec::new();
    for launch in launches {
        let mut paths = std::iter::once(launch.command.clone())
            .chain(
                launch
                    .args
                    .iter()
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute()),
            )
            .collect::<Vec<_>>();
        if let Some(path) = launch
            .initialization_options
            .as_ref()
            .and_then(|options| options.pointer("/tsserver/path"))
            .and_then(Value::as_str)
        {
            let path = Path::new(path);
            paths.push(path.into());
            paths.extend(sdk_runtime_paths(path.parent()?)?);
        }
        if let Some(sdk) = launch
            .initialization_options
            .as_ref()
            .and_then(|options| options.pointer("/typescript/tsdk"))
            .and_then(Value::as_str)
        {
            paths.extend(sdk_runtime_paths(Path::new(sdk))?);
        }
        paths.sort();
        paths.dedup();
        let files = paths
            .iter()
            .map(|path| {
                if content {
                    file_identity(path)
                } else {
                    file_metadata_identity(path)
                }
            })
            .collect::<Option<Vec<_>>>()?;
        let configuration = Sha256::digest(serde_json::to_vec(&json!({"command":launch.command,"args":launch.args,"extensions":launch.extensions,"initializationOptions":launch.initialization_options})).ok()?).into();
        result.push(LaunchIdentity {
            files,
            configuration,
        });
    }
    Some(result)
}
fn tool_identities(id: &str, launches: &[Launch]) -> Option<Vec<LaunchIdentity>> {
    tool_identities_inner(id, launches, true)
}
fn tool_identities_inner(
    id: &str,
    launches: &[Launch],
    content: bool,
) -> Option<Vec<LaunchIdentity>> {
    let mut identities = identities_inner(launches, content)?;
    static RECIPES: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();
    let mut recipes = RECIPES.get_or_init(Default::default).lock().ok()?;
    let recipe = recipes
        .entry(id.into())
        .or_insert_with(|| {
            super::language_recipes::recipe_digest(id).unwrap_or_else(|| format!("native:{id}:1"))
        })
        .clone();
    drop(recipes);
    for identity in &mut identities {
        let mut hash = Sha256::new();
        hash.update(identity.configuration);
        hash.update(recipe.as_bytes());
        identity.configuration = hash.finalize().into();
    }
    Some(identities)
}
fn managed_prefix(root: &Path, settings: &Settings, id: &str) -> Option<PathBuf> {
    let receipt = settings.installations.get(id)?;
    uuid::Uuid::parse_str(receipt).ok()?;
    let prefix = root.join("tools").join(id).join(receipt);
    // Reject redirects in storage before executing a previously installed server.
    for path in prefix.ancestors().take_while(|p| p.starts_with(root)) {
        let metadata = fs::symlink_metadata(path).ok()?;
        if redirected(&metadata) || !metadata.is_dir() {
            return None;
        }
    }
    Some(prefix)
}
pub(super) fn command(launch: &Launch, cwd: &Path) -> tokio::process::Command {
    let mut command = crate::process_launch::background_command(&launch.command);
    command.env_clear();
    for variable in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "WINDIR",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(variable) {
            command.env(variable, value);
        }
    }
    if let Ok(path) = std::env::join_paths(trusted_runtime_directories(&launch.command)) {
        command.env("PATH", path);
    }
    command
        .args(&launch.args)
        .current_dir(child_path(cwd))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Never let project .js files or injected Node options run during a probe/install.
    for variable in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "NPM_CONFIG_PREFIX",
        "NPM_CONFIG_USERCONFIG",
        "NPM_CONFIG_GLOBALCONFIG",
    ] {
        command.env_remove(variable);
    }
    for (variable, _) in std::env::vars_os() {
        let lower = variable.to_string_lossy().to_ascii_lowercase();
        if lower.starts_with("npm_config_")
            || ["goflags", "goprivate", "gonoproxy", "gonosumdb"].contains(&lower.as_str())
        {
            command.env_remove(variable);
        }
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    command
}
pub(super) async fn stop(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            crate::kill_process_tree(pid);
        }
    }
    let _ = child.kill().await;
    let _ = timeout(Duration::from_secs(2), child.wait()).await;
}
/// Keep the process-group identity even if the direct server exits before its
/// workers. Dropping a cancelled probe/query must stop every owned descendant.
pub(super) struct OwnedProcess {
    pub(super) child: tokio::process::Child,
    group: Option<u32>,
    #[cfg(windows)]
    job: windows_language_job::LanguageJob,
}
impl OwnedProcess {
    #[cfg(not(windows))]
    pub(super) fn new(child: tokio::process::Child) -> Self {
        let group = child.id();
        Self { child, group }
    }
    pub(super) fn spawn(mut command: tokio::process::Command) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let job = windows_language_job::LanguageJob::new()
                .map_err(|_| "Could not contain the language-server process.")?;
            // No project/toolchain code runs before containment is established.
            command.creation_flags(0x08000000 | 0x00000004);
            let mut child = command
                .spawn()
                .map_err(|_| "The language server could not start.")?;
            if job.attach_and_resume(&child).is_err() {
                let _ = child.start_kill();
                return Err("Could not contain and resume the language-server process.".into());
            }
            Ok(Self {
                group: child.id(),
                child,
                job,
            })
        }
        #[cfg(not(windows))]
        {
            command
                .spawn()
                .map(Self::new)
                .map_err(|_| "The language server could not start.".into())
        }
    }
    pub(super) fn kill_tree(&self) {
        if let Some(pid) = self.group {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = pid;
                self.job.terminate();
            }
        }
    }
    pub(super) async fn stop(&mut self) {
        self.kill_tree();
        stop(&mut self.child).await;
        self.group = None;
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.kill_tree();
        let _ = self.child.start_kill();
    }
}
#[cfg(windows)]
mod windows_language_job {
    use std::{
        io,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
                THREAD_SUSPEND_RESUME,
            },
        },
    };
    pub(super) struct LanguageJob(OwnedHandle);
    impl LanguageJob {
        pub(super) fn new() -> io::Result<Self> {
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: the unnamed job handle is exclusively owned by this guard.
            let owned = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    owned.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(owned))
        }
        pub(super) fn attach_and_resume(&self, child: &tokio::process::Child) -> io::Result<()> {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("Language server exited while suspended"))?;
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("Language server has no process identity"))?;
            let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            if raw == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut selected = None;
            let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
            while found {
                if entry.th32OwnerProcessID == pid && selected.replace(entry.th32ThreadID).is_some()
                {
                    return Err(io::Error::other(
                        "Ambiguous suspended language-server thread",
                    ));
                }
                entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
            }
            let id = selected
                .ok_or_else(|| io::Error::other("Suspended language-server thread not found"))?;
            let raw = unsafe {
                OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                    0,
                    id,
                )
            };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
                return Err(io::Error::other(
                    "Suspended language-server thread identity changed",
                ));
            }
            if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
                return Err(io::Error::other(
                    "Could not resume suspended language-server thread",
                ));
            }
            Ok(())
        }
        pub(super) fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0.as_raw_handle(), 1);
            }
        }
    }
}
async fn handshake_with_timeout(
    launch: &Launch,
    cwd: &Path,
    duration: Duration,
) -> Result<(), String> {
    let mut owned = OwnedProcess::spawn(command(launch, cwd))?;
    let child = &mut owned.child;
    let result = timeout(duration, async {
        let request = json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"processId":null,"rootUri":null,"capabilities":{},"workspaceFolders":null,"initializationOptions":launch.initialization_options}}).to_string();
        let message = format!("Content-Length: {}\r\n\r\n{}", request.len(), request);
        child.stdin.as_mut().ok_or("The language server input is unavailable.")?.write_all(message.as_bytes()).await.map_err(|_| "The language server closed its input.")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("The language server output is unavailable.")?);
        // Bound framing, individual payloads and notifications before initialize.
        for _ in 0..32 {
            let response = super::language_framing::read_message(&mut stdout, 1024 * 1024).await?;
            if response.get("id") == Some(&json!(1)) {
                return if response.pointer("/result/capabilities").is_some_and(Value::is_object) { Ok(()) } else { Err("The language server refused initialization.".to_string()) };
            }
        }
        Err("The language server did not complete initialization.".to_string())
    }).await;
    owned.stop().await;
    result.map_err(|_| "The language server initialization timed out.".to_string())?
}
#[cfg(test)]
async fn verified_launches(
    tool: &Tool,
    root: &Path,
    settings: &Settings,
) -> Result<Vec<Launch>, String> {
    verified_launches_scoped(tool, root, settings, None).await
}
fn project_contains(path: &Path, project: &Path) -> bool {
    #[cfg(windows)]
    {
        let components = |p: &Path| {
            PathBuf::from(child_path(p))
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
                .collect::<Vec<_>>()
        };
        components(path).starts_with(&components(project))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(project)
    }
}
fn validate_launch_project(launch: &Launch, project: &Path) -> Result<(), String> {
    let mut paths = vec![launch.command.clone()];
    paths.extend(
        launch
            .args
            .iter()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute()),
    );
    if let Some(options) = &launch.initialization_options {
        for pointer in ["/tsserver/path", "/typescript/tsdk"] {
            if let Some(value) = options.pointer(pointer) {
                let path = PathBuf::from(
                    value
                        .as_str()
                        .ok_or("The language server runtime path is invalid.")?,
                );
                if !path.is_absolute() {
                    return Err("The language server runtime path must be absolute.".into());
                }
                paths.push(path.clone());
                let sdk = if pointer == "/typescript/tsdk" {
                    path.as_path()
                } else {
                    path.parent()
                        .ok_or("The language server runtime path is invalid.")?
                };
                paths.extend(sdk_runtime_paths(sdk).ok_or(
                    "The language server SDK inventory is unavailable or exceeds its limit.",
                )?);
            }
        }
    }
    for path in paths {
        let canonical = fs::canonicalize(path)
            .map_err(|_| "The language server executable or runtime is unavailable.")?;
        if project_contains(&canonical, project) {
            return Err("Project-scoped language tools cannot execute a server, script, or runtime stored inside this project. Install a separate managed copy in Settings.".into());
        }
    }
    Ok(())
}
async fn verified_launches_scoped(
    tool: &Tool,
    root: &Path,
    settings: &Settings,
    project: Option<&Path>,
) -> Result<Vec<Launch>, String> {
    let prefix = managed_prefix(root, settings, tool.id);
    let launches = launches(tool, prefix.as_deref());
    let expected = if tool.servers.is_empty() {
        1
    } else {
        tool.servers.len()
    };
    if launches.len() != expected {
        return Ok(vec![]);
    }
    verify_launch_list(tool.id, root, launches, project).await
}
async fn verify_launch_list(
    id: &str,
    root: &Path,
    launches: Vec<Launch>,
    project: Option<&Path>,
) -> Result<Vec<Launch>, String> {
    if let Some(project) = project {
        for launch in &launches {
            validate_launch_project(launch, project)?;
        }
    }
    let mut current =
        tool_identities(id, &launches).ok_or("The language server executable is unavailable.")?;
    let key = (root.to_path_buf(), id.to_string());
    if proof_matches(&key, &current) {
        return Ok(launches);
    }
    // Deduplicate cold snapshots and bound child processes across the catalog.
    let gate = probe_gate(&key)?;
    let _gate = gate.lock().await;
    current =
        tool_identities(id, &launches).ok_or("The language server executable is unavailable.")?;
    if proof_matches(&key, &current) {
        return Ok(launches);
    }
    let _permit = probe_slots()
        .acquire()
        .await
        .map_err(|_| "Language server probes are unavailable.")?;
    current =
        tool_identities(id, &launches).ok_or("The language server executable is unavailable.")?;
    if let Some(project) = project {
        for launch in &launches {
            validate_launch_project(launch, project)?;
        }
    }
    for (launch, identity) in launches.iter().zip(&current) {
        if is_known_tool(id)
            && !runtime(root)?
                .settings
                .lock()
                .await
                .enabled
                .get(id)
                .copied()
                .unwrap_or(true)
        {
            return Err(
                "This language tool was disabled while its availability was being checked.".into(),
            );
        }
        if let Some(project) = project {
            validate_launch_project(launch, project)?;
        }
        match cached_health(&key, identity) {
            Some(Ok(())) => continue,
            Some(Err(error)) => return Err(error),
            None => (),
        }
        let result = handshake_with_timeout(launch, root, PROBE_TIMEOUT).await;
        let after = tool_identities(id, std::slice::from_ref(launch))
            .ok_or("The language server executable changed during verification.")?;
        if after.first() != Some(identity) {
            return Err("The language server executable changed during verification.".into());
        }
        remember_health(&key, identity.clone(), result.as_ref().err().cloned());
        result?;
    }
    if tool_identities(id, &launches).as_ref() != Some(&current) {
        return Err("The language server executable changed during verification.".into());
    }
    Ok(launches)
}
async fn snapshot_at(root: &Path, runtime: &Runtime) -> Result<LanguageToolsSnapshot, String> {
    let mut cache = runtime.inventory.lock().await;
    let generation = runtime.generation.load(Ordering::SeqCst);
    if let Some((checked, snapshot)) = cache.as_ref() {
        if checked.elapsed() < Duration::from_secs(2) && snapshot.generation == generation {
            return Ok(snapshot.clone());
        }
    }
    let snapshot = metadata_snapshot(root, runtime, generation, None).await?;
    *cache = Some((Instant::now(), snapshot.clone()));
    Ok(snapshot)
}
async fn metadata_snapshot(
    root: &Path,
    runtime: &Runtime,
    generation: u64,
    ids: Option<&[String]>,
) -> Result<LanguageToolsSnapshot, String> {
    let settings = runtime.settings.lock().await.clone();
    let installing = runtime
        .installing
        .lock()
        .map_err(|_| "Language tool state is unavailable.")?
        .clone();
    let tools = TOOLS.iter().filter(|tool| ids.is_none_or(|ids| ids.iter().any(|id| id == tool.id))).map(|tool| {
        let enabled = settings.enabled.get(tool.id).copied().unwrap_or(true);
        let (state, health, detail) = if !enabled {
            ("unavailable", "unverified", "This language tool is disabled in Settings.".into())
        } else if installing.contains(tool.id) {
            ("installing", "unverified", "Installing in shared private storage…".into())
        } else {
            let launches = launches(tool, managed_prefix(root, &settings, tool.id).as_deref());
            if launches.len() == tool.servers.len().max(1) {
                let key = (root.to_path_buf(), tool.id.to_string());
                match tool_identities_inner(tool.id, &launches, false) {
                    None => ("error", "error", "The language server executable or runtime is unavailable.".into()),
                    Some(current) => {
                        let error = current.iter().find_map(|identity| cached_metadata_health(&key, identity).and_then(Result::err))
                            .or_else(|| launches.iter().find_map(|launch| plugin_command(launch).err()));
                        if let Some(error) = error { ("error", "error", error) }
                        else if current.iter().all(|identity| cached_metadata_health(&key, identity) == Some(Ok(()))) { ("installed", "verified", "Last verified language server; shared by your projects. Refresh to recheck health.".into()) }
                        else {
                            let stale = proofs().lock().is_ok_and(|proofs| proofs.get(&key).is_some_and(|entries| !entries.is_empty()));
                            ("available", if stale { "stale" } else { "unverified" }, "Language server found. Refresh to verify its current health.".into())
                        }
                    }
                }
            } else if let Some(error) = settings.errors.get(tool.id) {
                ("error", "unverified", error.clone())
            } else if (tool.packages.is_empty() && tool.id != "go") || (!tool.packages.is_empty() && system_binary("node").is_none()) || (tool.id == "go" && system_binary("go").is_none()) {
                ("unavailable", "unverified", tool.help.into())
            } else {
                ("missing", "unverified", tool.help.into())
            }
        };
        LanguageToolStatus {
            id: tool.id.into(),
            name: tool.name.into(),
            languages: tool.languages.iter().map(|s| s.to_string()).collect(),
            state: state.into(),
            detail,
            enabled,
            health: health.into(),
        }
    }).collect();
    Ok(LanguageToolsSnapshot {
        auto_install: settings.auto_install,
        generation,
        tools,
    })
}
async fn snapshot_at_scoped(
    root: &Path,
    runtime: &Runtime,
    scope: Option<(&Path, &str)>,
) -> Result<LanguageToolsSnapshot, String> {
    snapshot_at_scoped_selected(root, runtime, scope, None).await
}
async fn snapshot_at_scoped_selected(
    root: &Path,
    runtime: &Runtime,
    scope: Option<(&Path, &str)>,
    ids: Option<&[String]>,
) -> Result<LanguageToolsSnapshot, String> {
    let mut snapshot = if ids.is_some() {
        metadata_snapshot(
            root,
            runtime,
            runtime.generation.load(Ordering::SeqCst),
            ids,
        )
        .await?
    } else {
        snapshot_at(root, runtime).await?
    };
    if let Some((project, permission)) = scope {
        let settings = runtime.settings.lock().await.clone();
        for status in &mut snapshot.tools {
            let error = if !server_allowed_in_mode(&status.id, permission) {
                Some("Project queries for this server require Full access because it may evaluate executable project configuration.".to_string())
            } else if !status.enabled {
                Some("This language tool is disabled in Settings.".to_string())
            } else {
                launches(
                    tool(&status.id)?,
                    managed_prefix(root, &settings, &status.id).as_deref(),
                )
                .iter()
                .find_map(|launch| validate_launch_project(launch, project).err())
            };
            if let Some(error) = error {
                status.state = "unavailable".into();
                status.health = "unverified".into();
                status.detail = error;
            }
        }
    }
    Ok(snapshot)
}
pub(super) async fn snapshot(app: &AppHandle) -> Result<LanguageToolsSnapshot, String> {
    let root = root(app)?;
    let runtime = runtime(&root)?;
    snapshot_at(&root, &runtime).await
}
pub(super) async fn snapshot_for_agent_filtered(
    app: &AppHandle,
    project: &Path,
    permission: &str,
    ids: Option<&[String]>,
) -> Result<LanguageToolsSnapshot, String> {
    if let Some(ids) = ids {
        for id in ids {
            tool(id)?;
        }
    }
    let project =
        fs::canonicalize(project).map_err(|_| "The thread's project folder is unavailable.")?;
    let root = root(app)?;
    let runtime = runtime(&root)?;
    snapshot_at_scoped_selected(&root, &runtime, Some((&project, permission)), ids).await
}
pub(super) async fn refresh(app: &AppHandle) -> Result<LanguageToolsSnapshot, String> {
    let root = root(app)?;
    let runtime = runtime(&root)?;
    refresh_at(&root, &runtime, None, None).await?;
    changed(app);
    snapshot_at(&root, &runtime).await
}
pub(super) async fn refresh_for_agent_filtered(
    app: &AppHandle,
    project: &Path,
    permission: &str,
    ids: Option<&[String]>,
) -> Result<LanguageToolsSnapshot, String> {
    let project =
        fs::canonicalize(project).map_err(|_| "The thread's project folder is unavailable.")?;
    let root = root(app)?;
    let runtime = runtime(&root)?;
    refresh_at(&root, &runtime, Some((&project, permission)), ids).await?;
    changed(app);
    snapshot_for_agent_filtered(app, &project, permission, ids).await
}
async fn refresh_at(
    root: &Path,
    runtime: &Runtime,
    scope: Option<(&Path, &str)>,
    ids: Option<&[String]>,
) -> Result<(), String> {
    let requested = ids
        .map(|ids| ids.iter().cloned().collect::<BTreeSet<_>>())
        .unwrap_or_else(|| LANGUAGE_TOOL_IDS.iter().map(|id| id.to_string()).collect());
    for id in &requested {
        tool(id)?;
    }
    let started = Instant::now();
    let mut completed = runtime.refreshes.lock().await;
    let settings = runtime.settings.lock().await.clone();
    let scope_key =
        scope.map(|(project, permission)| (project.to_path_buf(), permission.to_string()));
    let settings_key: [u8; 32] = Sha256::digest(
        serde_json::to_vec(&settings).map_err(|_| "Could not encode language tool settings.")?,
    )
    .into();
    let eligible = requested
        .iter()
        .filter(|id| {
            settings.enabled.get(*id).copied().unwrap_or(true)
                && scope.is_none_or(|(_, permission)| server_allowed_in_mode(id, permission))
        })
        .cloned()
        .collect::<BTreeSet<_>>();
    if completed.as_ref().is_some_and(|done| {
        done.finished >= started
            && done.scope == scope_key
            && done.settings == settings_key
            && eligible.is_subset(&done.ids)
    }) {
        let unchanged = eligible.iter().all(|id| {
            let launches = launches(
                tool(id).expect("validated catalog id"),
                managed_prefix(root, &settings, id).as_deref(),
            );
            if launches.is_empty() {
                return true;
            }
            if scope.is_some_and(|(project, _)| {
                launches
                    .iter()
                    .any(|launch| validate_launch_project(launch, project).is_err())
            }) {
                return false;
            }
            tool_identities(id, &launches).is_some_and(|identities| {
                identities.iter().all(|identity| {
                    cached_health(&(root.to_path_buf(), id.clone()), identity).is_some()
                })
            })
        });
        if unchanged {
            return Ok(());
        }
    }
    // Only this coalesced refresh invalidates failures/positive ages. Overlapping
    // callers share the completed health work rather than each starting servers.
    if let Ok(mut proofs) = proofs().lock() {
        for id in &eligible {
            proofs.remove(&(root.to_path_buf(), id.clone()));
        }
    }
    let checks = eligible.iter().map(|id| async {
        let _ = verified_launches_scoped(
            tool(id).expect("validated catalog id"),
            root,
            &settings,
            scope.map(|(project, _)| project),
        )
        .await;
    });
    futures_util::future::join_all(checks).await;
    *completed = Some(RefreshCompletion {
        finished: Instant::now(),
        ids: eligible,
        scope: scope_key,
        settings: settings_key,
    });
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
fn changed(app: &AppHandle) {
    if let Ok(root) = root(app) {
        if let Ok(runtime) = runtime(&root) {
            let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
            notify_generation(app, generation);
        }
    }
}
fn notify_generation(app: &AppHandle, generation: u64) {
    let _ = app.emit("language-tools-changed", json!({"generation": generation}));
}
pub(super) async fn set_auto_install(
    app: &AppHandle,
    enabled: bool,
) -> Result<LanguageToolsSnapshot, String> {
    let root = root(app)?;
    let runtime = runtime(&root)?;
    set_preference_at(Some(app), &root, &runtime, |settings| {
        settings.auto_install = enabled;
    })
    .await
}
pub(super) async fn set_enabled(
    app: &AppHandle,
    id: &str,
    enabled: bool,
) -> Result<LanguageToolsSnapshot, String> {
    tool(id)?;
    let root = root(app)?;
    let runtime = runtime(&root)?;
    set_preference_at(Some(app), &root, &runtime, |settings| {
        settings.enabled.insert(id.into(), enabled);
    })
    .await
}
// Both Settings endpoints share this exact write/event/metadata-return path.
// Without an AppHandle, native component tests can exercise it without a UI.
async fn set_preference_at(
    app: Option<&AppHandle>,
    root: &Path,
    runtime: &Runtime,
    update: impl FnOnce(&mut Settings),
) -> Result<LanguageToolsSnapshot, String> {
    {
        let mut settings = runtime.settings.lock().await;
        let mut updated = settings.clone();
        update(&mut updated);
        atomic_json(&root.join("settings.json"), &updated)?;
        *settings = updated;
    }
    invalidate_failures(root);
    if let Some(app) = app {
        changed(app);
    } else {
        runtime.generation.fetch_add(1, Ordering::SeqCst);
    }
    snapshot_at(root, runtime).await
}
async fn bounded_run(command: tokio::process::Command) -> Result<(), String> {
    bounded_run_with_timeout(command, INSTALL_TIMEOUT).await
}
async fn bounded_run_with_timeout(
    mut command: tokio::process::Command,
    duration: Duration,
) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    let mut owned = OwnedProcess::spawn(command)
        .map_err(|error| format!("The language tool installer could not start safely: {error}"))?;
    let result = timeout(duration, owned.child.wait()).await;
    owned.stop().await;
    match result {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("The language tool installer failed (exit {}). Check internet access and the required toolchain, then retry in Settings.", status.code().map(|n| n.to_string()).unwrap_or_else(|| "terminated".into()))),
        Ok(Err(_)) => Err("The language tool installer could not be monitored.".into()),
        Err(_) => Err("The language tool installation timed out. Retry in Settings after checking connectivity.".into()),
    }
}
fn npm_cli(node: &Path) -> Option<PathBuf> {
    let real = fs::canonicalize(node).unwrap_or_else(|_| node.to_path_buf());
    let directory = real.parent()?;
    [
        directory.join("node_modules/npm/bin/npm-cli.js"),
        directory.join("../lib/node_modules/npm/bin/npm-cli.js"),
        node.parent()?
            .join("../lib/node_modules/npm/bin/npm-cli.js"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}
fn minimum_node_version(tool: &Tool) -> [u32; 3] {
    if tool.id == "solidity" {
        [22, 15, 1]
    } else {
        [20, 0, 0]
    }
}
async fn node_supported(node: &Path, root: &Path, tool: &Tool) -> bool {
    let minimum = minimum_node_version(tool);
    let launch = Launch {
        command: node.into(),
        args: vec![
            "-e".into(),
            format!("const a=process.versions.node.split('.').map(Number),b={minimum:?};process.exit(a[0]>b[0]||(a[0]===b[0]&&(a[1]>b[1]||(a[1]===b[1]&&a[2]>=b[2])))?0:1)"),
        ],
        extensions: vec![],
        initialization_options: None,
    };
    let mut cmd = command(&launch, root);
    cmd.stdin(Stdio::null()).stdout(Stdio::null());
    timeout(PROBE_TIMEOUT, cmd.status())
        .await
        .is_ok_and(|status| status.is_ok_and(|s| s.success()))
}
fn private_empty_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !redirected(&metadata) && metadata.is_file() && metadata.len() == 0 => {
            return Ok(())
        }
        Ok(_) => return Err("The private npm configuration is redirected or modified.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not check private npm configuration.".into()),
    }
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "Could not prepare private npm configuration.")?;
    Ok(())
}
#[cfg(test)]
fn npm_manifest(tool: &Tool) -> Value {
    let mut manifest = json!({"private":true,"name":"mythra-language-tool","version":"1.0.0"});
    if tool.id == "vue" {
        // This exact transitive release otherwise selects a git+ssh dependency.
        // Keep managed installs on the npm registry, including Windows without Git.
        manifest["overrides"] =
            json!({"volar-service-emmet@0.0.64":{"@emmetio/css-parser":"0.4.1"}});
    }
    manifest
}
async fn install_recipe(tool: &Tool, root: &Path, prefix: &Path) -> Result<(), String> {
    install_recipe_scoped(tool, root, prefix, None).await
}
async fn install_recipe_scoped(
    tool: &Tool,
    root: &Path,
    prefix: &Path,
    project: Option<&Path>,
) -> Result<(), String> {
    install_recipe_with_policy(tool, root, prefix, project, None).await
}
async fn check_automatic_install(runtime: &Runtime, id: &str) -> Result<(), String> {
    let settings = runtime.settings.lock().await;
    if !settings.auto_install || !settings.enabled.get(id).copied().unwrap_or(true) {
        return Err(
            "Automatic installation is disabled for this language tool. Install it in Settings."
                .into(),
        );
    }
    Ok(())
}
async fn install_recipe_with_policy(
    tool: &Tool,
    root: &Path,
    prefix: &Path,
    project: Option<&Path>,
    automatic: Option<&Runtime>,
) -> Result<(), String> {
    if let Some(runtime) = automatic {
        check_automatic_install(runtime, tool.id).await?;
    }
    private_dir(prefix)?;
    if !tool.packages.is_empty() {
        let node = system_binary("node").ok_or(tool.help)?;
        if let Some(project) = project {
            validate_launch_project(
                &Launch {
                    command: node.clone(),
                    args: vec![],
                    extensions: vec![],
                    initialization_options: None,
                },
                project,
            )?;
        }
        if !node_supported(&node, root, tool).await {
            return Err(tool.help.into());
        }
        if let Some(runtime) = automatic {
            check_automatic_install(runtime, tool.id).await?;
        }
        let npm = npm_cli(&node).ok_or(
            "Node.js is available but npm is missing. Install Node.js with npm, then retry.",
        )?;
        let recipe = super::language_recipes::recipe(tool.id)
            .ok_or("The managed language tool recipe is unavailable.")?;
        recipe.validate()?;
        // Retain exact reviewed lock bytes; npm ci verifies every downloaded integrity.
        atomic_bytes(&prefix.join("package.json"), recipe.package_json.as_bytes())?;
        atomic_bytes(
            &prefix.join("package-lock.json"),
            recipe.package_lock_json.as_bytes(),
        )?;
        let config = root.join("empty-user-npmrc");
        let global_config = root.join("empty-global-npmrc");
        private_empty_file(&config)?;
        private_empty_file(&global_config)?;
        let launch = Launch {
            command: node,
            args: vec![child_path(&npm)],
            extensions: vec![],
            initialization_options: None,
        };
        if let Some(project) = project {
            validate_launch_project(&launch, project)?;
        }
        let mut cmd = command(&launch, root);
        cmd.args(super::language_recipes::NPM_CI_FLAGS)
            .arg("--prefix")
            .arg(child_path(prefix))
            .arg("--userconfig")
            .arg(child_path(&config))
            .arg("--globalconfig")
            .arg(child_path(&global_config))
            .arg("--cache")
            .arg(child_path(&root.join("npm-cache")));
        if let Some(runtime) = automatic {
            check_automatic_install(runtime, tool.id).await?;
        }
        bounded_run(cmd).await
    } else if tool.id == "go" {
        let go = system_binary("go").ok_or(tool.help)?;
        private_dir(&prefix.join("bin"))?;
        let launch = Launch {
            command: go,
            args: vec!["install".into(), "golang.org/x/tools/gopls@v0.20.0".into()],
            extensions: vec![],
            initialization_options: None,
        };
        if let Some(project) = project {
            validate_launch_project(&launch, project)?;
        }
        let mut cmd = command(&launch, root);
        cmd.env("GOBIN", child_path(&prefix.join("bin")))
            .env("GOPATH", child_path(&root.join("go-cache")))
            .env("GOCACHE", child_path(&root.join("go-build-cache")))
            .env("GOTOOLCHAIN", "local")
            .env("GOENV", "off")
            .env("GOWORK", "off")
            .env("GOPROXY", "https://proxy.golang.org")
            .env("GOSUMDB", "sum.golang.org");
        if let Some(runtime) = automatic {
            check_automatic_install(runtime, tool.id).await?;
        }
        bounded_run(cmd).await
    } else {
        Err(tool.help.into())
    }
}
struct InstallingGuard<'a> {
    runtime: &'a Runtime,
    id: String,
    app: Option<&'a AppHandle>,
}
impl Drop for InstallingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut installing) = self.runtime.installing.lock() {
            installing.remove(&self.id);
        }
        if let Some(app) = self.app {
            changed(app);
        } else {
            self.runtime.generation.fetch_add(1, Ordering::SeqCst);
        }
    }
}
async fn install_at(
    app: Option<&AppHandle>,
    root: &Path,
    runtime: &Runtime,
    id: &str,
    automatic: bool,
) -> Result<(), String> {
    install_at_scoped(app, root, runtime, id, automatic, None).await
}
async fn install_at_scoped(
    app: Option<&AppHandle>,
    root: &Path,
    runtime: &Runtime,
    id: &str,
    automatic: bool,
    project: Option<&Path>,
) -> Result<(), String> {
    let tool = tool(id)?;
    // Serializing installs prevents concurrent npm/go cache writes and deduplicates
    // simultaneous project setup. Settings and snapshots remain responsive.
    let _install = runtime.installs.lock().await;
    let settings = runtime.settings.lock().await.clone();
    if automatic && (!settings.auto_install || !settings.enabled.get(id).copied().unwrap_or(true)) {
        return Err(
            "Automatic installation is disabled for this language tool. Install it in Settings."
                .into(),
        );
    }
    if verified_launches_scoped(tool, root, &settings, project)
        .await
        .is_ok_and(|launches| !launches.is_empty())
    {
        return Ok(());
    }
    if automatic {
        check_automatic_install(runtime, id).await?;
    }
    runtime
        .installing
        .lock()
        .map_err(|_| "Language tool state is unavailable.")?
        .insert(id.into());
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    let _guard = InstallingGuard {
        runtime,
        id: id.into(),
        app,
    };
    if let Some(app) = app {
        changed(app);
    }
    let receipt = uuid::Uuid::new_v4().to_string();
    let prefix = root.join("tools").join(id).join(&receipt);
    let result = async {
        if automatic {
            install_recipe_with_policy(tool, root, &prefix, project, Some(runtime)).await?;
        } else if project.is_some() {
            install_recipe_scoped(tool, root, &prefix, project).await?;
        } else {
            install_recipe(tool, root, &prefix).await?;
        }
        let launches = launches(tool, Some(&prefix));
        if launches.len() != tool.servers.len().max(1) {
            return Err("The installer finished without a complete language server.".into());
        }
        let current = tool_identities(id, &launches)
            .ok_or("The installed language server identity is unavailable.")?;
        for launch in &launches {
            if automatic {
                check_automatic_install(runtime, id).await?;
            }
            if let Some(project) = project {
                validate_launch_project(launch, project)?;
            }
            handshake_with_timeout(launch, root, PROBE_TIMEOUT).await?;
        }
        if tool_identities(id, &launches).as_ref() != Some(&current) {
            return Err("The installed language server changed during verification.".into());
        }
        Ok::<Vec<LaunchIdentity>, String>(current)
    }
    .await;
    let mut settings = runtime.settings.lock().await;
    let mut updated = settings.clone();
    match &result {
        Ok(_) => {
            updated.installations.insert(id.into(), receipt.clone());
            updated.errors.remove(id);
        }
        Err(error) => {
            updated.errors.insert(id.into(), error.clone());
        }
    }
    atomic_json(&root.join("settings.json"), &updated)?;
    *settings = updated;
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    // Atomic receipt publication precedes proof publication. Failed persistence
    // never exposes a proof for a never-registered staging generation.
    if let Ok(identities) = &result {
        let current = launches(tool, Some(&prefix));
        if tool_identities(id, &current).as_ref() == Some(identities) {
            for identity in identities {
                remember_health(&(root.to_path_buf(), id.into()), identity.clone(), None);
            }
        }
    }
    result.map(|_| ())
}
pub(super) async fn install(app: &AppHandle, id: &str) -> Result<LanguageToolsSnapshot, String> {
    let root = root(app)?;
    let runtime = runtime(&root)?;
    // Installation failures are represented in the returned catalog and event.
    let result = install_at(Some(app), &root, &runtime, id, false).await;
    if let Err(error) = result {
        if !is_known_tool(id) || runtime.settings.lock().await.errors.get(id) != Some(&error) {
            return Err(error);
        }
    }
    snapshot_at(&root, &runtime).await
}
pub(super) async fn install_for_agent(
    app: &AppHandle,
    id: &str,
    project: &Path,
    permission: &str,
) -> Result<LanguageToolsSnapshot, String> {
    if permission != "full" {
        return Err(
            "Language-tool installation requires Full access. Install it manually in Settings."
                .into(),
        );
    }
    let project =
        fs::canonicalize(project).map_err(|_| "The thread's project folder is unavailable.")?;
    let root = root(app)?;
    let runtime = runtime(&root)?;
    install_at_scoped(Some(app), &root, &runtime, id, true, Some(&project)).await?;
    snapshot_at_scoped(&root, &runtime, Some((&project, permission))).await
}

fn detect_project(cwd: &Path) -> Result<(PathBuf, BTreeSet<String>), String> {
    if !cwd.is_absolute() {
        return Err("Language tool setup requires an absolute project folder.".into());
    }
    let metadata = fs::symlink_metadata(cwd).map_err(|_| "The project folder is unavailable.")?;
    if redirected(&metadata) || !metadata.is_dir() {
        return Err("Language tool setup requires a real project folder, not a link.".into());
    }
    let canonical = fs::canonicalize(cwd).map_err(|_| "Could not resolve the project folder.")?;
    let mut detected = BTreeSet::new();
    let mut queue = vec![(canonical.clone(), 0)];
    let mut visited = 0;
    while let Some((directory, depth)) = queue.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 6000 {
                return Ok((canonical, detected));
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if redirected(&metadata) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if metadata.is_dir() {
                if depth < 4
                    && !name.starts_with('.')
                    && ![
                        "node_modules",
                        "target",
                        "dist",
                        "build",
                        "vendor",
                        "coverage",
                        "release-assets",
                        "RELEASE ASSETS",
                        "venv",
                        "__pycache__",
                        "bin",
                        "obj",
                        "Library",
                        "Temp",
                        "Packages",
                    ]
                    .contains(&name.as_str())
                {
                    queue.push((entry.path(), depth + 1));
                }
            } else if metadata.is_file() {
                for tool in TOOLS {
                    let manifest = match tool.id {
                        "typescript" => ["package.json", "tsconfig.json", "jsconfig.json"]
                            .contains(&name.as_str()),
                        "python" => ["pyproject.toml", "requirements.txt", "Pipfile"]
                            .contains(&name.as_str()),
                        "php" => name == "composer.json",
                        "rust" => name == "Cargo.toml",
                        "go" => name == "go.mod",
                        "cpp" => name == "CMakeLists.txt",
                        "swift" => name == "Package.swift",
                        "dart" => name == "pubspec.yaml",
                        "zig" => name == "build.zig.zon",
                        _ => false,
                    };
                    if manifest || language_for_file(tool, &entry.path()).is_some() {
                        detected.insert(tool.id.into());
                    }
                }
            }
        }
    }
    Ok((canonical, detected))
}
fn trusted_runtime_directories(program: &Path) -> Vec<PathBuf> {
    let mut directories = program
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .collect::<Vec<_>>();
    for dependency in ["node", "go", "rustc", "dotnet", "java", "ruby"] {
        if let Some(binary) = system_binary(dependency) {
            if let Some(parent) = binary.parent() {
                directories.push(parent.into());
            }
        }
    }
    if cfg!(windows) {
        if let Some(windows) = std::env::var_os("SystemRoot").map(PathBuf::from) {
            directories.extend([windows.join("System32"), windows]);
        }
    } else {
        directories.extend([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
        ]);
    }
    directories
        .into_iter()
        .map(|path| PathBuf::from(child_path(&path)))
        .collect()
}
#[cfg(windows)]
fn short_executable_path(original: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let path: Vec<u16> = original.as_os_str().encode_wide().chain(Some(0)).collect();
    let size = unsafe { GetShortPathNameW(path.as_ptr(), std::ptr::null_mut(), 0) };
    if size == 0 || size > 32768 {
        return None;
    }
    let mut buffer = vec![0; size as usize];
    let written = unsafe { GetShortPathNameW(path.as_ptr(), buffer.as_mut_ptr(), size) };
    if written == 0 || written >= size {
        return None;
    }
    let short = String::from_utf16(&buffer[..written as usize]).ok()?;
    if short.contains(' ')
        || !Path::new(&short).is_absolute()
        || fs::canonicalize(&short).ok()? != fs::canonicalize(original).ok()?
    {
        return None;
    }
    Some(short)
}
fn plugin_environment(host_names: impl IntoIterator<Item = String>) -> BTreeMap<String, String> {
    let allowed = [
        "home",
        "userprofile",
        "appdata",
        "localappdata",
        "systemroot",
        "windir",
        "tmpdir",
        "temp",
        "tmp",
        "lang",
        "lc_all",
    ];
    let mut environment: BTreeMap<String, String> = host_names
        .into_iter()
        .filter(|key| !allowed.contains(&key.to_ascii_lowercase().as_str()))
        .map(|key| {
            let key = if cfg!(windows) { key.to_ascii_uppercase() } else { key };
            (key, String::new())
        })
        .collect();
    for key in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "GOFLAGS",
        "GOENV",
        "RUBYOPT",
        "RUBYLIB",
        "JAVA_TOOL_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "DOTNET_STARTUP_HOOKS",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENROUTER_API_KEY",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AZURE_OPENAI_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "BASH_ENV",
        "ENV",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONHOME",
    ] {
        environment.insert(key.into(), String::new());
    }
    environment.insert("GOENV".into(), "off".into());
    environment.insert(
        if cfg!(windows) { "NODEFAULTCURRENTDIRECTORYINEXEPATH" } else { "NoDefaultCurrentDirectoryInExePath" }.into(),
        "1".into(),
    );
    environment
}
fn plugin_command(launch: &Launch) -> Result<(String, BTreeMap<String, String>), String> {
    // Store environment names only. Values never enter generated plugin files.
    let mut environment = plugin_environment(
        std::env::vars_os().map(|(name, _)| name.to_string_lossy().into_owned()),
    );
    environment.insert(
        "PATH".into(),
        std::env::join_paths(trusted_runtime_directories(&launch.command))
            .map_err(|_| "Could not prepare the language server's executable search path.")?
            .to_string_lossy()
            .into(),
    );
    #[cfg(windows)]
    if launch.command.to_string_lossy().contains(' ') {
        if let Some(short) = short_executable_path(&launch.command) {
            return Ok((short, environment));
        }
    }
    let command = if cfg!(windows) && launch.command.to_string_lossy().contains(' ') {
        // Claude rejects Windows absolute commands containing spaces. Resolve
        // only against the exact verified binary directory and OS/toolchain dirs.
        return Err("The server is available, but Claude cannot launch its Windows path containing spaces and this volume has no safe short path. Install its toolchain in a path without spaces, then refresh.".into());
    } else {
        child_path(&launch.command)
    };
    Ok((command, environment))
}
fn write_plugin(
    root: &Path,
    canonical: &Path,
    launches: &[(String, Vec<Launch>)],
) -> Result<Option<PathBuf>, String> {
    if launches.is_empty() {
        return Ok(None);
    }
    // Content addressing gives concurrent sessions immutable plugin configuration;
    // new enabled settings never rewrite a plugin already used by another turn.
    let mut servers = serde_json::Map::new();
    for (id, launches) in launches {
        for (index, launch) in launches.iter().enumerate() {
            let mappings: BTreeMap<_, _> = launch.extensions.iter().cloned().collect();
            let (command, environment) = plugin_command(launch)?;
            let mut server = json!({"command":command,"args":launch.args,"env":environment,"extensionToLanguage":mappings,"startupTimeout":15000,"shutdownTimeout":3000,"maxRestarts":1});
            if let Some(options) = &launch.initialization_options {
                server["initializationOptions"] = options.clone();
            }
            servers.insert(format!("{id}-{index}"), server);
        }
    }
    let config = Value::Object(servers);
    let mut hash = Sha256::new();
    hash.update(canonical.to_string_lossy().as_bytes());
    hash.update(
        serde_json::to_vec(&config)
            .map_err(|_| "Could not encode language server configuration.")?,
    );
    let plugin = root.join("plugins").join(format!("{:x}", hash.finalize()));
    private_dir(&plugin.join(".claude-plugin"))?;
    atomic_json(&plugin.join(".lsp.json"), &config)?;
    atomic_json(
        &plugin.join(".claude-plugin/plugin.json"),
        &json!({"name":"mythra-language-tools","version":"1.0.0","description":"Shared language intelligence for this project's detected languages","author":{"name":"Mythra Code"}}),
    )?;
    Ok(Some(plugin))
}
fn write_enabled_plugin(
    root: &Path,
    canonical: &Path,
    mut selected: Vec<(String, Vec<Launch>)>,
    settings: &Settings,
) -> Result<Option<PathBuf>, String> {
    selected.retain(|(id, launches)| {
        settings.enabled.get(id).copied().unwrap_or(true)
            && launches
                .iter()
                .all(|launch| validate_launch_project(launch, canonical).is_ok())
    });
    write_plugin(root, canonical, &selected)
}
#[derive(Clone)]
pub(super) struct QueryLaunchProof {
    app: AppHandle,
    root: PathBuf,
    id: String,
    identity: LaunchIdentity,
    receipt: Option<String>,
}
/// A successful query initialize can certify precisely this selected server role.
/// Policy and project errors never become a profile-wide negative health result.
pub(super) async fn record_query_initialization(
    proof: &QueryLaunchProof,
    launch: &Launch,
    project: &Path,
) -> Result<(), String> {
    let runtime = runtime(&proof.root)?;
    let settings = runtime.settings.lock().await;
    if !settings.enabled.get(&proof.id).copied().unwrap_or(true)
        || settings.installations.get(&proof.id) != proof.receipt.as_ref()
    {
        return Err("The language tool settings changed during initialization. Retry using the current installation.".into());
    }
    validate_launch_project(launch, project)?;
    let current = tool_identities(&proof.id, std::slice::from_ref(launch))
        .ok_or("The language server executable changed during initialization.")?;
    if current.first() != Some(&proof.identity) {
        return Err("The language server executable changed during initialization.".into());
    }
    remember_health(
        &(proof.root.clone(), proof.id.clone()),
        proof.identity.clone(),
        None,
    );
    let generation = runtime.generation.load(Ordering::SeqCst);
    drop(settings);
    notify_generation(&proof.app, generation);
    Ok(())
}
/// Queries only use already available, enabled, independently scoped launches.
/// File names select a fixed catalog mapping; they cannot select executables.
pub(super) async fn query_launch(
    app: &AppHandle,
    file: &Path,
    project: &Path,
    permission: &str,
) -> Result<(String, Launch, QueryLaunchProof), String> {
    let root = root(app)?;
    let runtime = runtime(&root)?;
    let settings = runtime.settings.lock().await.clone();
    for tool in TOOLS {
        let Some(language) = language_for_file(tool, file) else {
            continue;
        };
        if !server_allowed_in_mode(tool.id, permission) {
            return Err(format!("{} language queries require Full access because its server may evaluate executable project configuration. Switch this thread to Full access to use it.",tool.name));
        }
        if !settings.enabled.get(tool.id).copied().unwrap_or(true) {
            return Err(format!("The {} language tool is disabled. Enable it in Settings > Tools & MCP > Language tools.", tool.name));
        }
        let launches = launches(tool, managed_prefix(&root, &settings, tool.id).as_deref());
        if let Some(launch) = launches.into_iter().find(|launch| {
            launch
                .extensions
                .iter()
                .any(|(_, mapped)| mapped == &language)
        }) {
            validate_launch_project(&launch, project)?;
            let identity = tool_identities(tool.id, std::slice::from_ref(&launch))
                .and_then(|mut identities| identities.pop())
                .ok_or("The language server executable or runtime is unavailable.")?;
            let latest = runtime.settings.lock().await;
            if !latest.enabled.get(tool.id).copied().unwrap_or(true)
                || latest.installations.get(tool.id) != settings.installations.get(tool.id)
            {
                return Err("The language tool settings changed while its availability was being checked. Retry using the current installation.".into());
            }
            validate_launch_project(&launch, project)?;
            let proof = QueryLaunchProof {
                app: app.clone(),
                root: root.clone(),
                id: tool.id.into(),
                identity,
                receipt: latest.installations.get(tool.id).cloned(),
            };
            return Ok((language, launch, proof));
        }
        return Err(format!("The {} language server is unavailable. Check language_tools_status and install it in Settings or with install_language_tool when permitted.", tool.name));
    }
    Err("No supported language tool matches this file. Check language_tools_status for supported languages.".into())
}

pub(super) async fn prepare_project(
    app: &AppHandle,
    cwd: &str,
    allow_install: bool,
    permission: &str,
) -> Result<Option<PathBuf>, String> {
    prepare_project_inner(app, cwd, allow_install, permission, true).await
}
/// Frontend setup retains install-before-turn semantics; only Claude's actual
/// native launch needs an immutable plugin descriptor.
pub(super) async fn prepare_project_tools(
    app: &AppHandle,
    cwd: &str,
    allow_install: bool,
    permission: &str,
) -> Result<Option<PathBuf>, String> {
    prepare_project_inner(app, cwd, allow_install, permission, false).await
}
async fn prepare_project_inner(
    app: &AppHandle,
    cwd: &str,
    allow_install: bool,
    permission: &str,
    build_plugin: bool,
) -> Result<Option<PathBuf>, String> {
    let app_data = crate::release_qa::app_data_dir(app)
        .map_err(|_| "Could not resolve language tool storage.")?;
    let normal_chats = app_data.join("normal-chats");
    if Path::new(cwd).starts_with(&normal_chats)
        || fs::canonicalize(cwd).is_ok_and(|path| {
            fs::canonicalize(&normal_chats).is_ok_and(|root| path.starts_with(root))
        })
    {
        return Ok(None);
    }
    let (canonical, detected) = detect_project(Path::new(cwd))?;
    if detected.is_empty() {
        return Ok(None);
    }
    let root = root(app)?;
    let runtime = runtime(&root)?;
    if allow_install && permission == "full" {
        for id in &detected {
            let settings = runtime.settings.lock().await.clone();
            // Persisted failure is not retried automatically on every turn.
            if (!tool(id)?.packages.is_empty() || id == "go")
                && settings.auto_install
                && settings.enabled.get(id).copied().unwrap_or(true)
                && !settings.errors.contains_key(id)
            {
                let _ =
                    install_at_scoped(Some(app), &root, &runtime, id, true, Some(&canonical)).await;
            }
        }
    }
    if !build_plugin {
        return Ok(None);
    }
    let settings = runtime.settings.lock().await.clone();
    let mut selected = Vec::new();
    for id in detected {
        if !settings.enabled.get(&id).copied().unwrap_or(true)
            || !server_allowed_in_mode(&id, permission)
        {
            continue;
        }
        if let Ok(launches) =
            verified_launches_scoped(tool(&id)?, &root, &settings, Some(&canonical)).await
        {
            if !launches.is_empty()
                && launches.iter().all(|launch| plugin_command(launch).is_ok())
                && launches
                    .iter()
                    .all(|launch| validate_launch_project(launch, &canonical).is_ok())
            {
                selected.push((id, launches));
            }
        }
    }
    // Verification awaits can race a Settings toggle. Keep the authoritative
    // settings lock through final synchronous registration so disabled tools
    // cannot be added to a newly starting provider after that toggle completes.
    let latest = runtime.settings.lock().await;
    let result = write_enabled_plugin(&root, &canonical, selected, &latest);
    drop(latest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("mythra-language-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        fs::canonicalize(path).unwrap()
    }
    #[test]
    fn exact_identity_includes_sdk_contents_arguments_and_initialization() {
        let root = temporary();
        let command = root.join("server");
        fs::write(&command, "server").unwrap();
        let sdk = root.join("typescript");
        fs::create_dir(&sdk).unwrap();
        for name in ["tsserver.js", "typescript.js", "_typescript.js"] {
            fs::write(sdk.join(name), "aaaa").unwrap();
        }
        let launch = Launch {
            command,
            args: vec!["--stdio".into()],
            extensions: vec![(".ts".into(), "typescript".into())],
            initialization_options: Some(json!({"typescript":{"tsdk":child_path(&sdk)}})),
        };
        let original = tool_identities("astro", std::slice::from_ref(&launch)).unwrap();
        let edited = sdk.join("_typescript.js");
        let modification = fs::metadata(&edited).unwrap().modified().unwrap();
        fs::write(&edited, "bbbb").unwrap();
        fs::File::options()
            .write(true)
            .open(&edited)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modification))
            .unwrap();
        assert!(
            tool_identities("astro", std::slice::from_ref(&launch)).unwrap() != original,
            "same-size SDK edit with restored mtime must invalidate content proof"
        );
        let mut changed = launch.clone();
        changed.args.push("--different".into());
        assert!(
            tool_identities("astro", &[changed]).unwrap()
                != tool_identities("astro", std::slice::from_ref(&launch)).unwrap()
        );
        let mut changed = launch.clone();
        changed.initialization_options.as_mut().unwrap()["other"] = json!(true);
        assert!(
            tool_identities("astro", &[changed]).unwrap()
                != tool_identities("astro", &[launch]).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn one_role_proof_never_certifies_other_web_roles() {
        let root = temporary();
        let one = root.join("html");
        let two = root.join("css");
        fs::write(&one, "one").unwrap();
        fs::write(&two, "two").unwrap();
        let make = |command| Launch {
            command,
            args: vec![],
            extensions: vec![],
            initialization_options: None,
        };
        let identities = tool_identities("web", &[make(one), make(two)]).unwrap();
        let key = (root.clone(), "web".into());
        remember_health(&key, identities[0].clone(), None);
        assert!(proof_matches(&key, &identities[..1]));
        assert!(!proof_matches(&key, &identities));
        remember_health(&key, identities[1].clone(), None);
        assert!(proof_matches(&key, &identities));
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn settings_metadata_and_both_preference_snapshots_never_start_enabled_server() {
        let node = system_binary("node").expect("Node is required to arm the native server canary");
        let root = temporary();
        let runtime = runtime(&root).unwrap();
        let receipt = uuid::Uuid::new_v4().to_string();
        let package = root
            .join("tools/python")
            .join(&receipt)
            .join("node_modules/pyright");
        fs::create_dir_all(&package).unwrap();
        let marker = root.join("unexpected-server-start");
        let script = package.join("langserver.index.js");
        fs::write(
            &script,
            format!(
                "require('fs').writeFileSync({},'started');process.exit(0);",
                json!(child_path(&marker))
            ),
        )
        .unwrap();
        // Prove the discovered canary can execute and writes the marker before
        // checking that the actual metadata and setter paths never execute it.
        assert!(tokio::process::Command::new(node)
            .arg(&script)
            .status()
            .await
            .unwrap()
            .success());
        assert_eq!(fs::read_to_string(&marker).unwrap(), "started");
        fs::remove_file(&marker).unwrap();
        {
            let mut settings = runtime.settings.lock().await;
            settings.installations.insert("python".into(), receipt.clone());
            settings.errors.insert("go".into(), "Retained error".into());
        }
        let initial = snapshot_at(&root, &runtime).await.unwrap();
        let python = |snapshot: &LanguageToolsSnapshot| {
            snapshot.tools.iter().find(|tool| tool.id == "python").unwrap().clone()
        };
        assert_eq!(python(&initial).state, "available");
        assert_eq!(python(&initial).health, "unverified");
        assert!(python(&initial).enabled);
        assert!(!marker.exists());
        let automatic = set_preference_at(None, &root, &runtime, |settings| {
            settings.auto_install = false;
        })
        .await
        .unwrap();
        assert!(!automatic.auto_install);
        assert!(automatic.generation > initial.generation);
        assert_eq!(python(&automatic).state, "available");
        assert!(!marker.exists());
        let enabled = set_preference_at(None, &root, &runtime, |settings| {
            settings.enabled.insert("python".into(), true);
        })
        .await
        .unwrap();
        assert!(enabled.generation > automatic.generation);
        assert_eq!(python(&enabled).state, "available");
        assert_eq!(python(&enabled).health, "unverified");
        assert!(!marker.exists());
        let disabled = set_preference_at(None, &root, &runtime, |settings| {
            settings.enabled.insert("python".into(), false);
        })
        .await
        .unwrap();
        assert!(disabled.generation > enabled.generation);
        assert!(!python(&disabled).enabled);
        assert!(!marker.exists());
        let saved = fs::read(root.join("settings.json")).unwrap();
        let restarted = read_settings(&root).unwrap();
        assert!(!restarted.auto_install);
        assert!(!restarted.enabled["python"]);
        assert_eq!(restarted.installations["python"], receipt);
        assert_eq!(restarted.errors["go"], "Retained error");
        // A failed atomic write preserves settings and does not invalidate the
        // generation or execute the enabled server while returning an error.
        fs::remove_file(root.join("settings.json")).unwrap();
        fs::create_dir(root.join("settings.json")).unwrap();
        assert!(set_preference_at(None, &root, &runtime, |settings| {
            settings.enabled.insert("python".into(), true);
        })
        .await
        .is_err());
        assert!(!runtime.settings.lock().await.enabled["python"]);
        assert_eq!(runtime.generation.load(Ordering::SeqCst), disabled.generation);
        assert!(!marker.exists());
        fs::remove_dir(root.join("settings.json")).unwrap();
        fs::write(root.join("settings.json"), &saved).unwrap();
        runtimes().lock().unwrap().remove(&root);
        let reopened = snapshot_at(&root, &super::runtime(&root).unwrap()).await.unwrap();
        assert!(!reopened.auto_install);
        assert!(!python(&reopened).enabled);
        assert!(!marker.exists());
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), saved);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cheap_inventory_and_disabled_refresh_never_start_a_server() {
        if system_binary("node").is_none() {
            return;
        }
        let root = temporary();
        let runtime = runtime(&root).unwrap();
        let receipt = uuid::Uuid::new_v4().to_string();
        let package = root
            .join("tools/python")
            .join(&receipt)
            .join("node_modules/pyright");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("langserver.index.js"),
            "require('fs').writeFileSync('unexpected-start','started');process.exit(1);",
        )
        .unwrap();
        {
            let mut settings = runtime.settings.lock().await;
            settings.installations.insert("python".into(), receipt);
        }
        let ids = vec!["python".to_string()];
        let before = metadata_snapshot(&root, &runtime, 1, Some(&ids))
            .await
            .unwrap();
        assert_eq!(before.tools.len(), 1);
        assert_eq!(before.tools[0].state, "available");
        assert_eq!(before.tools[0].health, "unverified");
        runtime
            .settings
            .lock()
            .await
            .enabled
            .insert("python".into(), false);
        refresh_at(&root, &runtime, None, Some(&ids)).await.unwrap();
        assert!(!root.join("unexpected-start").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn automatic_install_rechecks_preferences_after_slow_failed_preflight() {
        if system_binary("node").is_none() {
            return;
        }
        let root = temporary();
        let runtime = runtime(&root).unwrap();
        let receipt = uuid::Uuid::new_v4().to_string();
        let package = root
            .join("tools/python")
            .join(&receipt)
            .join("node_modules/pyright");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("langserver.index.js"), "require('fs').writeFileSync('preflight-started','1');setTimeout(()=>process.exit(42),300);").unwrap();
        runtime
            .settings
            .lock()
            .await
            .installations
            .insert("python".into(), receipt.clone());
        let install = install_at(None, &root, &runtime, "python", true);
        let toggle = async {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !root.join("preflight-started").exists() {
                assert!(Instant::now() < deadline, "preflight did not start");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            runtime.settings.lock().await.auto_install = false;
        };
        let (result, _) = tokio::join!(install, toggle);
        assert!(result.unwrap_err().contains("disabled"));
        let receipts = fs::read_dir(root.join("tools/python"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            receipts.len(),
            1,
            "no new staging generation may be started after auto-off"
        );
        assert!(runtime.installing.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn sdk_sibling_runtime_linked_into_project_is_rejected() {
        let root = temporary();
        let project = root.join("project");
        let sdk = root.join("sdk");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&sdk).unwrap();
        for name in ["tsserver.js", "typescript.js"] {
            fs::write(sdk.join(name), "safe").unwrap();
        }
        let runtime = project.join("_typescript.js");
        fs::write(&runtime, "project-code").unwrap();
        std::os::unix::fs::symlink(runtime, sdk.join("_typescript.js")).unwrap();
        let launch = Launch {
            command: PathBuf::from("/usr/bin/printf"),
            args: vec![],
            extensions: vec![],
            initialization_options: Some(json!({"typescript":{"tsdk":child_path(&sdk)}})),
        };
        assert!(validate_launch_project(&launch, &project)
            .unwrap_err()
            .contains("inside this project"));
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn failed_health_is_singleflight_and_explicit_refresh_retries_once() {
        let Some(node) = system_binary("node") else {
            return;
        };
        let root = temporary();
        let script = root.join("failure.js");
        fs::write(
            &script,
            "require('fs').appendFileSync('failed-starts','1');process.exit(42);",
        )
        .unwrap();
        let launch = Launch {
            command: node,
            args: vec![child_path(&script)],
            extensions: vec![],
            initialization_options: None,
        };
        let (one, two) = tokio::join!(
            verify_launch_list("negative-fixture", &root, vec![launch.clone()], None),
            verify_launch_list("negative-fixture", &root, vec![launch.clone()], None)
        );
        assert!(one.is_err() && two.is_err());
        assert_eq!(fs::read_to_string(root.join("failed-starts")).unwrap(), "1");
        invalidate_failures(&root);
        assert!(
            verify_launch_list("negative-fixture", &root, vec![launch], None)
                .await
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(root.join("failed-starts")).unwrap(),
            "11"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "Measures registry identity and metadata paths using an explicitly retained isolated QA installation"]
    async fn native_registry_efficiency_smoke() {
        let supplied = std::env::var("MYTHRA_LANGUAGE_EFFICIENCY_ROOT")
            .expect("set retained isolated QA root");
        let root = fs::canonicalize(supplied).unwrap();
        let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(project_contains(&root, &temporary_root));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("mythra-language-tools-"));
        let id = std::env::var("MYTHRA_LANGUAGE_EFFICIENCY_TOOL")
            .unwrap_or_else(|_| "typescript".into());
        let selected = tool(&id).unwrap();
        let runtime = runtime(&root).unwrap();
        let receipt = fs::read_dir(root.join("tools").join(&id))
            .unwrap()
            .filter_map(Result::ok)
            .find_map(|entry| {
                let receipt = entry.file_name().to_string_lossy().to_string();
                (uuid::Uuid::parse_str(&receipt).is_ok()
                    && launches(selected, Some(&entry.path())).len()
                        == selected.servers.len().max(1))
                .then_some(receipt)
            })
            .expect("complete retained UUID generation");
        runtime
            .settings
            .lock()
            .await
            .installations
            .insert(id.clone(), receipt);
        let settings = runtime.settings.lock().await.clone();
        let launches = launches(selected, managed_prefix(&root, &settings, &id).as_deref());
        let ids = vec![id.clone()];
        let mut timings = serde_json::Map::new();
        let start = Instant::now();
        let _ = metadata_snapshot(&root, &runtime, 1, Some(&ids))
            .await
            .unwrap();
        timings.insert(
            "metadataColdMs".into(),
            json!(start.elapsed().as_secs_f64() * 1000.0),
        );
        for name in ["identityColdMs", "identityWarmMs"] {
            let start = Instant::now();
            assert!(tool_identities(&id, &launches).is_some());
            timings.insert(name.into(), json!(start.elapsed().as_secs_f64() * 1000.0));
        }
        let project = temporary();
        for name in ["verifyColdMs", "verifyWarmMs"] {
            let start = Instant::now();
            assert!(
                !verified_launches_scoped(selected, &root, &settings, Some(&project))
                    .await
                    .unwrap()
                    .is_empty()
            );
            timings.insert(name.into(), json!(start.elapsed().as_secs_f64() * 1000.0));
        }
        let start = Instant::now();
        let snapshot = metadata_snapshot(
            &root,
            &runtime,
            runtime.generation.load(Ordering::SeqCst),
            Some(&ids),
        )
        .await
        .unwrap();
        timings.insert(
            "metadataVerifiedMs".into(),
            json!(start.elapsed().as_secs_f64() * 1000.0),
        );
        assert_eq!(snapshot.tools[0].health, "verified");
        timings.insert("tool".into(), json!(id));
        timings.insert("serverRoles".into(), json!(launches.len()));
        eprintln!("LANGUAGE_REGISTRY_EFFICIENCY={}", Value::Object(timings));
        fs::remove_dir_all(project).unwrap();
    }
    #[test]
    fn catalog_recipes_are_fixed_and_ids_match() {
        assert_eq!(
            TOOLS.iter().map(|t| t.id).collect::<Vec<_>>(),
            LANGUAGE_TOOL_IDS
        );
        for tool in TOOLS {
            assert!(!tool.extensions.is_empty());
            assert!(tool
                .packages
                .iter()
                .all(|p| p.contains('@') && !p.starts_with('-')));
        }
        assert!(tool("../../evil").is_err());
    }
    #[test]
    fn vue_manifest_uses_reviewed_registry_dependency_override_only_for_vue() {
        for tool in TOOLS {
            let manifest = npm_manifest(tool);
            assert_eq!(manifest["private"], true);
            if tool.id == "vue" {
                assert_eq!(
                    manifest["overrides"],
                    json!({"volar-service-emmet@0.0.64":{"@emmetio/css-parser":"0.4.1"}})
                );
            } else {
                assert!(manifest.get("overrides").is_none());
            }
        }
    }
    #[test]
    fn executable_project_configuration_servers_require_full_access() {
        for permission in ["read-only", "ask", "unrecognized"] {
            for id in LANGUAGE_TOOL_IDS {
                assert_eq!(
                    server_allowed_in_mode(id, permission),
                    ["typescript", "python", "web", "yaml"].contains(&id)
                );
            }
        }
        assert!(LANGUAGE_TOOL_IDS
            .iter()
            .all(|id| server_allowed_in_mode(id, "full")));
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_owned_job_kills_workers_after_server_parent_exits() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        };
        let Some(node) = system_binary("node") else {
            return;
        };
        let root = temporary();
        // A non-detached Node child belongs to libuv's own kill-on-close job.
        // Deliberately leave a ready orphan for our outer job to contain instead.
        // Node's detached spawn does not request CREATE_BREAKAWAY_FROM_JOB.
        let launch = Launch {
            command: node,
            args: vec![
                "-e".into(),
                "const fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e',\"const fs=require('fs');fs.writeFileSync('owned-worker.pending',String(process.pid));fs.renameSync('owned-worker.pending','owned-worker');setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true,windowsHide:true});c.on('error',()=>process.exit(2));c.unref();const deadline=setTimeout(()=>process.exit(3),2000);const ready=setInterval(()=>{if(fs.existsSync('owned-worker')){clearInterval(ready);clearTimeout(deadline)}},10);".into(),
            ],
            extensions: vec![],
            initialization_options: None,
        };
        let mut owned = OwnedProcess::spawn(command(&launch, &root)).unwrap();
        let parent_status = timeout(Duration::from_secs(3), owned.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(parent_status.success(), "fixture parent failed: {parent_status}");
        let pid: u32 = fs::read_to_string(root.join("owned-worker"))
            .unwrap()
            .parse()
            .unwrap();
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        assert!(
            !raw.is_null(),
            "worker {pid} must still exist before owning job is dropped: {}",
            std::io::Error::last_os_error()
        );
        let worker = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert_eq!(
            unsafe { WaitForSingleObject(worker.as_raw_handle(), 0) },
            258
        );
        drop(owned);
        assert_eq!(
            unsafe { WaitForSingleObject(worker.as_raw_handle(), 2000) },
            0,
            "job must kill worker even after parent has exited"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn settings_default_and_atomic_restart_preserve_disabled_tools_errors() {
        let root = temporary();
        let mut settings = read_settings(&root).unwrap();
        assert!(settings.auto_install);
        settings.auto_install = false;
        settings.enabled.insert("python".into(), false);
        settings.errors.insert("go".into(), "Offline".into());
        atomic_json(&root.join("settings.json"), &settings).unwrap();
        let loaded = read_settings(&root).unwrap();
        assert!(!loaded.auto_install);
        assert!(!loaded.enabled["python"]);
        assert_eq!(loaded.errors["go"], "Offline");
        fs::write(root.join("settings.json"), "invalid").unwrap();
        assert!(read_settings(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn detection_excludes_generated_directories_and_bounds_depth() {
        let root = temporary();
        fs::create_dir_all(root.join("node_modules/package")).unwrap();
        fs::write(root.join("node_modules/package/hidden.py"), "").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/file.tsx"), "").unwrap();
        let (_, tools) = detect_project(&root).unwrap();
        assert_eq!(tools, BTreeSet::from(["typescript".into()]));
        assert!(detect_project(Path::new(".")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn detection_selects_framework_infrastructure_and_extensionless_files() {
        let root = temporary();
        for filename in [
            "Dockerfile",
            "Dockerfile.release",
            "script.BASH",
            "page.svelte",
            "page.astro",
            "component.vue",
            "contract.sol",
            "config.toml",
            "guide.md",
            "main.dart",
            "build.zig.zon",
            "main.tfvars",
        ] {
            fs::write(root.join(filename), "").unwrap();
        }
        assert_eq!(
            detect_project(&root).unwrap().1,
            BTreeSet::from(
                [
                    "bash",
                    "docker",
                    "svelte",
                    "astro",
                    "vue",
                    "solidity",
                    "toml",
                    "markdown",
                    "dart",
                    "zig",
                    "terraform"
                ]
                .map(str::to_string)
            )
        );
        assert_eq!(
            language_for_file(tool("docker").unwrap(), Path::new("Dockerfile.release")),
            Some("dockerfile".into())
        );
        assert_eq!(
            language_for_file(tool("docker").unwrap(), Path::new("README.Dockerfile")),
            Some("dockerfile".into())
        );
        assert_eq!(
            language_for_file(tool("docker").unwrap(), Path::new("DockerfileRelease")),
            None
        );
        assert_eq!(
            language_for_file(tool("terraform").unwrap(), Path::new("packer.hcl")),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn fixed_server_arguments_and_runtime_requirements_match_upstream_protocols() {
        assert_eq!(server_arguments("bash"), ["start"]);
        assert_eq!(server_arguments("toml"), ["lsp", "stdio"]);
        assert_eq!(server_arguments("markdown"), ["server"]);
        assert_eq!(
            server_arguments("dart"),
            ["language-server", "--protocol=lsp"]
        );
        assert_eq!(server_arguments("terraform"), ["serve"]);
        assert_eq!(server_arguments("solidity"), ["--stdio"]);
        assert_eq!(minimum_node_version(tool("solidity").unwrap()), [22, 15, 1]);
        assert_eq!(minimum_node_version(tool("astro").unwrap()), [20, 0, 0]);
    }
    #[cfg(unix)]
    #[test]
    fn detection_and_settings_reject_symlinks() {
        use std::os::unix::fs::symlink;
        let root = temporary();
        let outside = temporary();
        fs::write(outside.join("file.py"), "").unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        assert!(detect_project(&root).unwrap().1.is_empty());
        assert!(detect_project(&root.join("linked")).is_err());
        symlink(outside.join("file.py"), root.join("settings.json")).unwrap();
        assert!(read_settings(&root).is_err());
        assert!(atomic_json(&root.join("settings.json"), &json!({})).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn plugins_reuse_servers_and_keep_projects_isolated() {
        let root = temporary();
        let project1 = temporary();
        let project2 = temporary();
        let server = Launch {
            command: PathBuf::from("/safe/node"),
            args: vec!["/shared/server.js".into(), "--stdio".into()],
            extensions: vec![(".py".into(), "python".into())],
            initialization_options: None,
        };
        let selected = vec![("python".into(), vec![server])];
        let one = write_plugin(&root, &project1, &selected).unwrap().unwrap();
        let existing = [
            one.join(".lsp.json"),
            one.join(".claude-plugin/plugin.json"),
        ]
        .into_iter()
        .map(|path| {
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000)),
                )
                .unwrap();
            let metadata = fs::metadata(&path).unwrap();
            (path, metadata)
        })
        .collect::<Vec<_>>();
        let same = write_plugin(&root, &project1, &selected).unwrap().unwrap();
        for (path, before) in existing {
            let after = fs::metadata(path).unwrap();
            assert_eq!(
                before.modified().unwrap(),
                after.modified().unwrap(),
                "unchanged immutable plugin files must not be rewritten"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(before.ino(), after.ino());
            }
        }
        let two = write_plugin(&root, &project2, &selected).unwrap().unwrap();
        assert_eq!(one, same);
        assert_ne!(one, two);
        assert_eq!(
            fs::read(one.join(".lsp.json")).unwrap(),
            fs::read(two.join(".lsp.json")).unwrap()
        );
        assert!(write_plugin(&root, &project1, &[]).unwrap().is_none());
        let manifest: Value =
            serde_json::from_slice(&fs::read(one.join(".claude-plugin/plugin.json")).unwrap())
                .unwrap();
        assert!(manifest.get("hooks").is_none());
        assert!(manifest.get("mcpServers").is_none());
        for root in [root, project1, project2] {
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn final_registration_excludes_tools_disabled_after_verification() {
        let root = temporary();
        let project = temporary();
        let binary = root.join("managed-node");
        fs::write(&binary, "").unwrap();
        let launch = Launch {
            command: binary,
            args: vec![],
            extensions: vec![(".py".into(), "python".into())],
            initialization_options: None,
        };
        let selected = vec![("python".into(), vec![launch])];
        let mut settings = Settings::default();
        assert!(
            write_enabled_plugin(&root, &project, selected.clone(), &settings)
                .unwrap()
                .is_some()
        );
        settings.enabled.insert("python".into(), false);
        assert!(write_enabled_plugin(&root, &project, selected, &settings)
            .unwrap()
            .is_none());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(project).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn project_linked_server_and_initialization_runtimes_never_run_in_scoped_probes() {
        use std::os::unix::fs::symlink;
        let Some(node) = system_binary("node") else {
            return;
        };
        let root = temporary();
        let project = temporary();
        let marker = root.join("probe-executed");
        let code=format!("require('fs').writeFileSync({},'executed');process.stdin.on('data',()=>{{const m=JSON.stringify({{jsonrpc:'2.0',id:1,result:{{capabilities:{{}}}}}});process.stdout.write('Content-Length: '+Buffer.byteLength(m)+'\\r\\n\\r\\n'+m);}});",serde_json::to_string(&marker.to_string_lossy()).unwrap());
        let owned_script = project.join("project-server.js");
        fs::write(&owned_script, &code).unwrap();
        let alias = root.join("global-server.js");
        symlink(&owned_script, &alias).unwrap();
        let shared = root.join("shared-server.js");
        fs::write(&shared, &code).unwrap();
        for name in ["tsserver.js", "typescript.js"] {
            fs::write(root.join(name), &code).unwrap();
        }
        let sdk = project.join("sdk");
        fs::create_dir(&sdk).unwrap();
        fs::write(sdk.join("tsserver.js"), &code).unwrap();
        fs::write(sdk.join("typescript.js"), &code).unwrap();
        let sdk_alias = root.join("global-sdk");
        symlink(&sdk, &sdk_alias).unwrap();
        let selections = [
            Launch {
                command: node.clone(),
                args: vec![alias.to_string_lossy().into_owned()],
                extensions: vec![],
                initialization_options: None,
            },
            Launch {
                command: node.clone(),
                args: vec![shared.to_string_lossy().into_owned()],
                extensions: vec![],
                initialization_options: Some(json!({"tsserver":{"path":alias}})),
            },
            Launch {
                command: node,
                args: vec![shared.to_string_lossy().into_owned()],
                extensions: vec![],
                initialization_options: Some(json!({"typescript":{"tsdk":sdk_alias}})),
            },
        ];
        for (index, launch) in selections.into_iter().enumerate() {
            let id = format!("project-guard-{index}");
            assert!(
                verify_launch_list(&id, &root, vec![launch.clone()], Some(&project))
                    .await
                    .unwrap_err()
                    .contains("inside this project")
            );
            assert!(
                !marker.exists(),
                "scoped cold verification executed project code"
            );
            // Even a previously verified inventory cache cannot skip scope checks.
            let key = (root.clone(), id.clone());
            proofs().lock().unwrap().insert(
                key,
                vec![ExecutableProof {
                    identity: tool_identities(&id, std::slice::from_ref(&launch))
                        .unwrap()
                        .pop()
                        .unwrap(),
                    checked: Instant::now(),
                    error: None,
                }],
            );
            assert!(verify_launch_list(&id, &root, vec![launch], Some(&project))
                .await
                .is_err());
            assert!(
                !marker.exists(),
                "scoped warm verification executed project code"
            );
        }
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(project).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn project_scope_matches_verbatim_drive_unc_and_case_boundaries() {
        assert!(project_contains(
            Path::new(r"C:\Project\runtime.js"),
            Path::new(r"\\?\c:\project")
        ));
        assert!(project_contains(
            Path::new(r"\\server\share\Project\runtime.js"),
            Path::new(r"\\?\UNC\SERVER\SHARE\project")
        ));
        assert!(!project_contains(
            Path::new(r"C:\project-other\runtime.js"),
            Path::new(r"\\?\C:\project")
        ));
    }
    #[test]
    fn installation_receipts_cannot_escape_private_storage() {
        let root = temporary();
        let mut settings = Settings::default();
        settings
            .installations
            .insert("python".into(), "../../outside".into());
        assert!(managed_prefix(&root, &settings, "python").is_none());
        atomic_json(&root.join("settings.json"), &settings).unwrap();
        assert!(read_settings(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "Downloads curated language servers into an isolated retained temporary directory"]
    async fn native_install_smoke() {
        let root = temporary();
        let project = root.join("fixture-project");
        fs::create_dir(&project).unwrap();
        let requested = std::env::var("MYTHRA_LANGUAGE_SMOKE_TOOLS")
            .unwrap_or_else(|_| "typescript,python,php,web,yaml".into());
        let mut selected = Vec::new();
        let mut settings = Settings::default();
        for id in requested.split(',') {
            let tool = tool(id).expect("fixed known smoke tool");
            let receipt = uuid::Uuid::new_v4().to_string();
            let prefix = root.join("tools").join(id).join(&receipt);
            install_recipe(tool, &root, &prefix)
                .await
                .unwrap_or_else(|error| panic!("{id}: {error}"));
            settings.installations.insert(id.into(), receipt);
            let verified = verified_launches(tool, &root, &settings).await.unwrap();
            assert!(!verified.is_empty(), "{id} did not install");
            for (extension, _) in tool.extensions {
                fs::write(project.join(format!("fixture{extension}")), "").unwrap();
            }
            selected.push((id.to_string(), verified));
        }
        atomic_json(&root.join("settings.json"), &settings).unwrap();
        let plugin = write_plugin(&root, &project, &selected).unwrap().unwrap();
        let loaded = read_settings(&root).unwrap();
        for (id, launches) in &selected {
            let again = verified_launches(tool(id).unwrap(), &root, &loaded)
                .await
                .unwrap();
            assert_eq!(again[0].command, launches[0].command);
            assert_eq!(again[0].args, launches[0].args);
        }
        eprintln!("LANGUAGE_TOOLS_SMOKE_ROOT={}", root.display());
        eprintln!("LANGUAGE_TOOLS_SMOKE_PROJECT={}", project.display());
        eprintln!("LANGUAGE_TOOLS_SMOKE_PLUGIN={}", plugin.display());
    }
    #[tokio::test]
    #[ignore = "Revalidates explicitly supplied retained isolated QA installations without downloading"]
    async fn native_retained_install_smoke() {
        let roots: BTreeMap<String, String> = serde_json::from_str(
            &std::env::var("MYTHRA_LANGUAGE_SMOKE_RETAINED_ROOTS")
                .expect("set curated ID to retained QA root JSON map"),
        )
        .unwrap();
        let requested = std::env::var("MYTHRA_LANGUAGE_SMOKE_TOOLS")
            .unwrap_or_else(|_| "typescript,python,php,web,yaml".into());
        let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = temporary();
        let project = root.join("fixture-project");
        fs::create_dir(&project).unwrap();
        let mut selected = Vec::new();
        let mut evidence = serde_json::Map::new();
        for id in requested.split(',') {
            let tool = tool(id).expect("fixed known smoke tool");
            assert!(
                !tool.servers.is_empty(),
                "retained smoke supports managed npm recipes"
            );
            let supplied = PathBuf::from(
                roots
                    .get(id)
                    .expect("retained QA root required for each requested ID"),
            );
            let retained = fs::canonicalize(&supplied).unwrap();
            assert!(
                project_contains(&retained, &temporary_root),
                "retained fixtures must remain inside the machine temporary directory"
            );
            let name = retained.file_name().and_then(|name| name.to_str()).unwrap();
            uuid::Uuid::parse_str(
                name.strip_prefix("mythra-language-tools-")
                    .expect("owned QA root name required"),
            )
            .expect("owned QA root UUID required");
            private_dir(&retained).unwrap();
            let mut candidates = Vec::new();
            for entry in fs::read_dir(retained.join("tools").join(id))
                .unwrap()
                .flatten()
            {
                if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() {
                    continue;
                }
                let metadata = fs::symlink_metadata(entry.path()).unwrap();
                if redirected(&metadata) || !metadata.is_dir() {
                    continue;
                }
                let prefix = entry.path();
                if tool.servers.iter().all(|(package, script)| {
                    prefix
                        .join("node_modules")
                        .join(package)
                        .join(script)
                        .is_file()
                }) {
                    candidates.push(prefix);
                }
            }
            assert_eq!(
                candidates.len(),
                1,
                "each requested tool needs exactly one complete retained receipt"
            );
            let prefix = candidates.pop().unwrap();
            private_dir(&prefix).unwrap();
            for pinned in tool.packages {
                let (package, version) = pinned.rsplit_once('@').expect("fixed pinned package");
                let manifest: Value = serde_json::from_slice(
                    &fs::read(
                        prefix
                            .join("node_modules")
                            .join(package)
                            .join("package.json"),
                    )
                    .unwrap(),
                )
                .unwrap();
                assert_eq!(
                    manifest["version"].as_str(),
                    Some(version),
                    "retained package must match the current recipe"
                );
            }
            let launches = launches(tool, Some(&prefix));
            assert_eq!(launches.len(), tool.servers.len());
            let verified = verify_launch_list(id, &root, launches, Some(&project))
                .await
                .unwrap();
            assert!(!verified.is_empty());
            for (extension, _) in tool.extensions {
                fs::write(project.join(format!("fixture{extension}")), "").unwrap();
            }
            evidence.insert(id.into(),json!({"retainedRoot":retained,"prefix":prefix,"servers":verified.iter().map(|launch|json!({"command":launch.command,"args":launch.args,"initializationOptions":launch.initialization_options})).collect::<Vec<_>>()}));
            selected.push((id.into(), verified));
        }
        let plugin = write_plugin(&root, &project, &selected).unwrap().unwrap();
        atomic_json(
            &root.join("retained-install-proof.json"),
            &Value::Object(evidence),
        )
        .unwrap();
        eprintln!("LANGUAGE_TOOLS_SMOKE_ROOT={}", root.display());
        eprintln!("LANGUAGE_TOOLS_SMOKE_PROJECT={}", project.display());
        eprintln!("LANGUAGE_TOOLS_SMOKE_PLUGIN={}", plugin.display());
    }
    #[test]
    fn npm_configuration_files_are_separate_empty_and_guarded() {
        let root = temporary();
        let user = root.join("empty-user-npmrc");
        let global = root.join("empty-global-npmrc");
        private_empty_file(&user).unwrap();
        private_empty_file(&global).unwrap();
        assert_ne!(user, global);
        assert!(fs::read(&user).unwrap().is_empty());
        assert!(fs::read(&global).unwrap().is_empty());
        fs::write(&user, "ignore-scripts=false").unwrap();
        assert!(private_empty_file(&user).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn generated_lsp_environment_disables_process_injection() {
        let launch = Launch {
            command: PathBuf::from(if cfg!(windows) {
                "C:\\Windows\\System32\\node.exe"
            } else {
                "/usr/bin/node"
            }),
            args: vec![],
            extensions: vec![],
            initialization_options: None,
        };
        let (command, environment) = plugin_command(&launch).unwrap();
        assert_eq!(environment["NODE_OPTIONS"], "");
        assert_eq!(environment["GOFLAGS"], "");
        assert_eq!(environment["DOTNET_STARTUP_HOOKS"], "");
        assert!(!environment["PATH"]
            .split(if cfg!(windows) { ';' } else { ':' })
            .any(|entry| entry == "." || entry.is_empty()));
        if cfg!(windows) {
            assert!(Path::new(&command).is_absolute());
            assert!(!command.contains(' '));
            assert_eq!(environment["NODEFAULTCURRENTDIRECTORYINEXEPATH"], "1");
            let folded: BTreeSet<_> = environment.keys().map(|key| key.to_ascii_lowercase()).collect();
            assert_eq!(folded.len(), environment.len());
        }
    }
    #[cfg(windows)]
    #[test]
    fn plugin_environment_canonicalizes_windows_case_collisions() {
        let environment = plugin_environment([
            "Path", "PATH", "path", "GoEnv", "node_options", "Node_Options",
            "NoDefaultCurrentDirectoryInExePath", "NODEFAULTCURRENTDIRECTORYINEXEPATH",
            "Some_Private_Token", "SystemRoot",
        ].into_iter().map(str::to_string));
        assert_eq!(environment["PATH"], "");
        assert_eq!(environment["GOENV"], "off");
        assert_eq!(environment["NODE_OPTIONS"], "");
        assert_eq!(environment["NODEFAULTCURRENTDIRECTORYINEXEPATH"], "1");
        assert_eq!(environment["SOME_PRIVATE_TOKEN"], "");
        assert!(!environment.contains_key("SYSTEMROOT"));
        let folded: BTreeSet<_> = environment.keys().map(|key| key.to_ascii_lowercase()).collect();
        assert_eq!(folded.len(), environment.len());
    }
    #[test]
    fn plugin_environment_blanks_host_secrets_and_unknown_injection() {
        let environment = plugin_environment(
            [
                "SOME_PRIVATE_TOKEN",
                "TELEGRAM_BOT_TOKEN",
                "NODE_OPTIONS",
                "GIT_CONFIG_PARAMETERS",
                "HOME",
                "SystemRoot",
            ]
            .into_iter()
            .map(str::to_string),
        );
        for key in [
            "SOME_PRIVATE_TOKEN",
            "TELEGRAM_BOT_TOKEN",
            "NODE_OPTIONS",
            "GIT_CONFIG_PARAMETERS",
            "OPENAI_API_KEY",
        ] {
            assert_eq!(environment[key], "");
        }
        assert!(!environment.contains_key("HOME"));
        assert!(!environment.contains_key("SystemRoot"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_spaced_missing_binary_fails_closed() {
        let launch = Launch {
            command: PathBuf::from("C:\\Missing Toolchain With Spaces\\node.exe"),
            args: vec![],
            extensions: vec![],
            initialization_options: None,
        };
        assert!(plugin_command(&launch)
            .unwrap_err()
            .contains("no safe short path"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_child_arguments_normalize_verbatim_drive_and_unc_paths() {
        assert_eq!(
            child_path(Path::new(r"\\?\C:\Users\space name\server.js")),
            r"C:\Users\space name\server.js"
        );
        assert_eq!(
            child_path(Path::new(r"\\?\UNC\server\share\script.js")),
            r"\\server\share\script.js"
        );
        assert_eq!(
            child_path(Path::new(r"C:\Tools\node.exe")),
            r"C:\Tools\node.exe"
        );
    }
    #[tokio::test]
    async fn agent_install_respects_auto_off_and_disabled_before_any_subprocess() {
        let root = temporary();
        let runtime = runtime(&root).unwrap();
        runtime.settings.lock().await.auto_install = false;
        assert!(install_at(None, &root, &runtime, "python", true)
            .await
            .unwrap_err()
            .contains("disabled"));
        {
            let mut settings = runtime.settings.lock().await;
            settings.auto_install = true;
            settings.enabled.insert("python".into(), false);
        }
        assert!(install_at(None, &root, &runtime, "python", true)
            .await
            .unwrap_err()
            .contains("disabled"));
        assert!(!root.join("tools").exists());
        assert!(runtime.installing.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn concurrent_installs_reuse_verified_server_and_reject_changed_executable() {
        let Some(_) = system_binary("node") else {
            return;
        };
        let root = temporary();
        let runtime = runtime(&root).unwrap();
        let receipt = uuid::Uuid::new_v4().to_string();
        let package = root
            .join("tools/python")
            .join(&receipt)
            .join("node_modules/pyright");
        fs::create_dir_all(&package).unwrap();
        let script = package.join("langserver.index.js");
        fs::write(&script, "require('fs').appendFileSync('probe-count','1');process.stdin.on('data',()=>{const m=JSON.stringify({jsonrpc:'2.0',id:1,result:{capabilities:{}}});process.stdout.write('Content-Length: '+Buffer.byteLength(m)+'\\r\\n\\r\\n'+m);});").unwrap();
        runtime
            .settings
            .lock()
            .await
            .installations
            .insert("python".into(), receipt);
        let (one, two) = tokio::join!(
            install_at(None, &root, &runtime, "python", false),
            install_at(None, &root, &runtime, "python", false)
        );
        one.unwrap();
        two.unwrap();
        assert_eq!(fs::read_to_string(root.join("probe-count")).unwrap(), "1");
        fs::write(script, "process.exit(42)").unwrap();
        let settings = runtime.settings.lock().await.clone();
        assert!(verified_launches(tool("python").unwrap(), &root, &settings)
            .await
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn concurrent_cold_snapshots_share_one_protocol_probe() {
        if system_binary("node").is_none() {
            return;
        }
        let root = temporary();
        let receipt = uuid::Uuid::new_v4().to_string();
        let package = root
            .join("tools/python")
            .join(&receipt)
            .join("node_modules/pyright");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("langserver.index.js"),"require('fs').appendFileSync('probe-count','1');process.stdin.on('data',()=>{const m=JSON.stringify({jsonrpc:'2.0',id:1,result:{capabilities:{}}});process.stdout.write('Content-Length: '+Buffer.byteLength(m)+'\\r\\n\\r\\n'+m);});").unwrap();
        let mut settings = Settings::default();
        settings.installations.insert("python".into(), receipt);
        let tool = tool("python").unwrap();
        let (one, two, three) = tokio::join!(
            verified_launches(tool, &root, &settings),
            verified_launches(tool, &root, &settings),
            verified_launches(tool, &root, &settings)
        );
        assert!(!one.unwrap().is_empty());
        assert!(!two.unwrap().is_empty());
        assert!(!three.unwrap().is_empty());
        assert_eq!(fs::read_to_string(root.join("probe-count")).unwrap(), "1");
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn installer_timeout_kills_owned_process() {
        let mut command = crate::process_launch::background_command("/bin/sleep");
        command.arg("10");
        assert!(bounded_run_with_timeout(command, Duration::from_millis(30))
            .await
            .unwrap_err()
            .contains("timed out"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn handshake_accepts_real_protocol_and_rejects_exit_and_timeout() {
        let root = temporary();
        let good = Launch { command: PathBuf::from("/usr/bin/printf"), args: vec!["Content-Length: 53\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"capabilities\":{}}}".into()], extensions: vec![], initialization_options: None };
        handshake_with_timeout(&good, &root, Duration::from_secs(1))
            .await
            .unwrap();
        let bad = Launch {
            command: PathBuf::from("/usr/bin/false"),
            args: vec![],
            extensions: vec![],
            initialization_options: None,
        };
        assert!(handshake_with_timeout(&bad, &root, Duration::from_secs(1))
            .await
            .is_err());
        let slow = Launch {
            command: PathBuf::from("/bin/sleep"),
            args: vec!["10".into()],
            extensions: vec![],
            initialization_options: None,
        };
        assert!(
            handshake_with_timeout(&slow, &root, Duration::from_millis(30))
                .await
                .unwrap_err()
                .contains("timed out")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
