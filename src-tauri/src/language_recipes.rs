//! Complete, reviewed npm graphs for the app-owned language tools.
//! Installation policy is part of the recipe identity. Native optional packages
//! stay in the lock so npm selects the matching OS/architecture without scripts.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(super) const RECIPE_VERSION: u32 = 1;
pub(super) const NPM_CI_FLAGS: &[&str] = &[
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--include=optional",
    "--install-strategy=hoisted",
    "--registry=https://registry.npmjs.org",
];

pub(super) struct Recipe {
    pub id: &'static str,
    pub version: u32,
    pub package_json: &'static str,
    pub package_lock_json: &'static str,
}

impl Recipe {
    /// Hash exact embedded bytes and the installation policy, not JSON formatting
    /// reconstructed at runtime. OS/runtime identities belong in the launch proof.
    pub fn digest(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(b"mythra-language-recipe\0");
        hash.update(self.version.to_le_bytes());
        for value in [self.id, self.package_json, self.package_lock_json]
            .into_iter()
            .chain(NPM_CI_FLAGS.iter().copied())
        {
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    pub fn validate(&self) -> Result<(), String> {
        let manifest: Value = serde_json::from_str(self.package_json)
            .map_err(|_| "The embedded language tool manifest is invalid.")?;
        let lock: Value = serde_json::from_str(self.package_lock_json)
            .map_err(|_| "The embedded language tool lock is invalid.")?;
        validate_documents(self.id, &manifest, &lock)
    }
}

macro_rules! recipe {
    ($id:literal) => {
        Recipe {
            id: $id,
            version: RECIPE_VERSION,
            package_json: include_str!(concat!("../language-recipes/", $id, "/package.json")),
            package_lock_json: include_str!(concat!(
                "../language-recipes/",
                $id,
                "/package-lock.json"
            )),
        }
    };
}
pub(super) const RECIPES: &[Recipe] = &[
    recipe!("typescript"),
    recipe!("python"),
    recipe!("php"),
    recipe!("web"),
    recipe!("yaml"),
    recipe!("bash"),
    recipe!("docker"),
    recipe!("svelte"),
    recipe!("astro"),
    recipe!("solidity"),
    recipe!("vue"),
];
pub(super) fn recipe(id: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|recipe| recipe.id == id)
}
pub(super) fn recipe_digest(id: &str) -> Option<String> {
    recipe(id).map(Recipe::digest)
}

fn validate_documents(id: &str, manifest: &Value, lock: &Value) -> Result<(), String> {
    let invalid =
        || "The embedded language tool recipe is not a pinned registry graph.".to_string();
    let manifest_object = manifest.as_object().ok_or_else(invalid)?;
    if manifest["private"] != true
        || manifest["name"] != format!("mythra-language-tool-{id}")
        || manifest["version"] != "1.0.0"
        || manifest_object.keys().any(|key| {
            !["private", "name", "version", "dependencies", "overrides"].contains(&key.as_str())
        })
        || lock["lockfileVersion"] != 3
        || lock["name"] != manifest["name"]
        || lock["version"] != manifest["version"]
    {
        return Err(invalid());
    }
    let expected_override = serde_json::json!({
        "volar-service-emmet@0.0.64": {"@emmetio/css-parser": "0.4.1"}
    });
    if (id == "vue" && manifest["overrides"] != expected_override)
        || (id != "vue" && manifest.get("overrides").is_some())
    {
        return Err(invalid());
    }
    let dependencies = manifest["dependencies"].as_object().ok_or_else(invalid)?;
    if dependencies.is_empty() {
        return Err(invalid());
    }
    let packages = lock["packages"].as_object().ok_or_else(invalid)?;
    let root = packages.get("").ok_or_else(invalid)?;
    if root["dependencies"] != manifest["dependencies"]
        || root["name"] != manifest["name"]
        || root["version"] != manifest["version"]
    {
        return Err(invalid());
    }
    for (name, version) in dependencies {
        let version = version.as_str().ok_or_else(invalid)?;
        if semver::Version::parse(version).is_err()
            || packages
                .get(&format!("node_modules/{name}"))
                .and_then(|entry| entry["version"].as_str())
                != Some(version)
        {
            return Err(invalid());
        }
    }
    for (path, entry) in packages.iter().filter(|(path, _)| !path.is_empty()) {
        if !path.starts_with("node_modules/")
            || path.contains('\\')
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || path.chars().any(char::is_control)
            || entry.get("link").is_some()
            || entry["dev"] == true
            || entry["version"]
                .as_str()
                .is_none_or(|v| semver::Version::parse(v).is_err())
        {
            return Err(invalid());
        }
        let resolved = entry["resolved"].as_str().ok_or_else(invalid)?;
        let tarball = resolved
            .strip_prefix("https://registry.npmjs.org/")
            .ok_or_else(invalid)?;
        if !tarball.ends_with(".tgz")
            || tarball.contains(['\\', '?', '#', '%'])
            || tarball.chars().any(|c| c.is_control() || c.is_whitespace())
            || tarball
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(invalid());
        }
        let integrity = entry["integrity"].as_str().ok_or_else(invalid)?;
        let encoded = integrity.strip_prefix("sha512-").ok_or_else(invalid)?;
        if STANDARD
            .decode(encoded)
            .map_or(true, |bytes| bytes.len() != 64)
        {
            return Err(invalid());
        }
        for key in ["dependencies", "optionalDependencies"] {
            if let Some(dependencies) = entry.get(key) {
                let dependencies = dependencies.as_object().ok_or_else(invalid)?;
                for (name, spec) in dependencies {
                    // npm preserves the upstream declaration in the lock even
                    // when this reviewed override resolves a registry tarball.
                    let overridden_vue_spec = id == "vue"
                        && path == "node_modules/volar-service-emmet"
                        && entry["version"] == "0.0.64"
                        && name == "@emmetio/css-parser"
                        && spec == "ramya-rao-a/css-parser#vscode"
                        && packages["node_modules/@emmetio/css-parser"]["version"] == "0.4.1";
                    if (!name.starts_with('@') && name.contains('/'))
                        || (!overridden_vue_spec
                            && spec.as_str().is_none_or(|value| {
                                value.contains(':') || value.contains('/') || value.starts_with('.')
                            }))
                    {
                        return Err(invalid());
                    }
                    // npm's complete lock must contain the dependency somewhere
                    // along this package's hoisted ancestor resolution path.
                    let mut ancestor = path.as_str();
                    loop {
                        if packages.contains_key(&format!("{ancestor}/node_modules/{name}"))
                            || packages.contains_key(&format!("node_modules/{name}"))
                        {
                            break;
                        }
                        match ancestor.rsplit_once("/node_modules/") {
                            Some((parent, _)) => ancestor = parent,
                            None => return Err(invalid()),
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn every_curated_recipe_has_a_complete_registry_integrity_graph() {
        let mut ids = BTreeSet::new();
        for recipe in RECIPES {
            assert!(ids.insert(recipe.id));
            recipe
                .validate()
                .unwrap_or_else(|error| panic!("{}: {error}", recipe.id));
            assert_eq!(recipe.version, RECIPE_VERSION);
            assert_eq!(recipe.digest().len(), 64);
            assert_eq!(recipe_digest(recipe.id), Some(recipe.digest()));
        }
        assert_eq!(ids.len(), 11);
        assert!(recipe("go").is_none());
        assert!(recipe("../typescript").is_none());
    }

    fn documents(id: &str) -> (Value, Value) {
        let recipe = recipe(id).unwrap();
        (
            serde_json::from_str(recipe.package_json).unwrap(),
            serde_json::from_str(recipe.package_lock_json).unwrap(),
        )
    }

    #[test]
    fn recipe_rejects_unpinned_sources_missing_integrity_and_scripts() {
        let (mut manifest, mut lock) = documents("typescript");
        manifest["scripts"] = serde_json::json!({"install": "arbitrary-command"});
        assert!(validate_documents("typescript", &manifest, &lock).is_err());
        let (manifest, _) = documents("typescript");
        let entry = &mut lock["packages"]["node_modules/typescript"];
        entry["resolved"] = "git+ssh://git@github.com/example/tool".into();
        assert!(validate_documents("typescript", &manifest, &lock).is_err());
        let (_, mut lock) = documents("typescript");
        lock["packages"]["node_modules/typescript"]["integrity"] = "sha512-invalid".into();
        assert!(validate_documents("typescript", &manifest, &lock).is_err());
        let (_, mut lock) = documents("typescript");
        lock["packages"]
            .as_object_mut()
            .unwrap()
            .remove("node_modules/typescript");
        assert!(validate_documents("typescript", &manifest, &lock).is_err());
    }

    #[test]
    fn vue_override_and_platform_optional_packages_are_preserved() {
        let (manifest, lock) = documents("vue");
        assert_eq!(
            manifest["overrides"]["volar-service-emmet@0.0.64"]["@emmetio/css-parser"],
            "0.4.1"
        );
        assert_eq!(
            lock["packages"]["node_modules/@emmetio/css-parser"]["version"],
            "0.4.1"
        );
        let (_, lock) = documents("solidity");
        for platform in ["darwin-arm64", "darwin-x64", "win32-x64-msvc"] {
            let entry = &lock["packages"]
                [format!("node_modules/@nomicfoundation/solidity-analyzer-{platform}")];
            assert_eq!(entry["optional"], true);
            assert!(entry["integrity"].as_str().unwrap().starts_with("sha512-"));
        }
        let (_, lock) = documents("php");
        assert_eq!(
            lock["packages"]["node_modules/intelephense"]["license"],
            "SEE LICENSE IN LICENSE.txt"
        );
    }

    #[test]
    fn identity_changes_with_manifest_lock_or_policy_version() {
        let base = recipe("typescript").unwrap();
        let changed = Recipe {
            version: base.version + 1,
            ..*base
        };
        assert_ne!(changed.digest(), base.digest());
        let changed = Recipe {
            package_json: "{}",
            ..*base
        };
        assert_ne!(changed.digest(), base.digest());
        let changed = Recipe {
            package_lock_json: "{}",
            ..*base
        };
        assert_ne!(changed.digest(), base.digest());
    }
}
