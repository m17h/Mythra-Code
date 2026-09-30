//! Bounded, local-only dependency analysis shared by previews and delivery.
use super::{
    canonical_skill_folder, is_markdown, normalize_skill_name, skill_mention_references_filtered,
    skill_mention_references_filtered_at, SkillBridgeConfig,
};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

pub(super) const MAX_DEPTH: usize = 4;
pub(super) const MAX_SKILLS: usize = 8;
pub(super) const MAX_FILES: usize = 24;
pub(super) const MAX_CHARACTERS: usize = 120_000;
pub(super) const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_REFERENCES: usize = 128;
const MAX_ROOTS: usize = 64;
const MAX_DIAGNOSTIC_NODES: usize = MAX_REFERENCES + MAX_ROOTS + 1;
const MAX_ISSUES: usize = 256;
const MAX_CONFIGS: usize = 1_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDependencyLimits {
    max_depth: usize,
    max_skills: usize,
    max_files: usize,
    max_characters: usize,
    max_file_bytes: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDependencyRoot {
    pub node_id: String,
    pub channel: String,
    pub name: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDependencyNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub status: String,
    pub character_count: usize,
    pub depth: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDependencyEdge {
    pub from: String,
    pub to: String,
    pub reference: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDependencyIssue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_name: Option<String>,
    pub chain: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDependencyReport {
    pub version: usize,
    pub limits: SkillDependencyLimits,
    pub roots: Vec<SkillDependencyRoot>,
    pub nodes: Vec<SkillDependencyNode>,
    pub edges: Vec<SkillDependencyEdge>,
    pub issues: Vec<SkillDependencyIssue>,
}
impl Default for SkillDependencyReport {
    fn default() -> Self {
        Self {
            version: 1,
            limits: SkillDependencyLimits {
                max_depth: MAX_DEPTH,
                max_skills: MAX_SKILLS,
                max_files: MAX_FILES,
                max_characters: MAX_CHARACTERS,
                max_file_bytes: MAX_FILE_BYTES,
            },
            roots: vec![],
            nodes: vec![],
            edges: vec![],
            issues: vec![],
        }
    }
}
impl SkillDependencyReport {
    pub fn error(&self) -> Option<String> {
        self.issues.first().map(|issue| {
            format!(
                "{} Dependency chain: {}",
                issue.message,
                issue.chain.join(" -> ")
            )
        })
    }
}

pub(super) struct LoadedDependency {
    pub node: usize,
    pub instructions: String,
    pub system: bool,
}
pub(super) struct DependencyAnalysis {
    pub report: SkillDependencyReport,
    pub loaded: Vec<LoadedDependency>,
}
#[derive(Clone)]
struct Config {
    name: String,
    path: PathBuf,
    enabled: bool,
}
enum Reference {
    Skill(String),
    Document(String),
    Image(String),
}
fn diagnostic(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        let character = if character.is_control() {
            ' '
        } else {
            character
        };
        if output.len() + character.len_utf8() > 4096 {
            break;
        }
        output.push(character);
    }
    output
}
fn diagnostic_path(path: &Path) -> Option<String> {
    let value = path.to_string_lossy();
    (path.is_absolute() && value.len() <= 4096 && !value.chars().any(char::is_control))
        .then(|| value.into_owned())
}
struct Pending {
    dependency: Reference,
    source: PathBuf,
    parent: String,
    depth: usize,
    system: bool,
    chain: Vec<String>,
    stack: Vec<PathBuf>,
}
struct Traversal<'a> {
    depth: usize,
    system: bool,
    parent: Option<&'a str>,
    reference: &'a str,
    chain: Vec<String>,
    stack: &'a [PathBuf],
}

/// Nested mentions follow rendered Markdown text, but must originate at an
/// authored, unescaped @. Formatting never manufactures whitespace boundaries.
fn references(content: &str) -> Vec<Reference> {
    let mut visible = String::with_capacity(content.len());
    let mut mention_sources = Vec::new();
    let mut code_ranges = Vec::new();
    let mut references = Vec::new();
    let mut hidden = 0usize;
    for (event, range) in Parser::new(content).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                visible.push('\n');
                hidden += 1;
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                if hidden == 0 {
                    visible.push('\u{fffc}');
                    if local_document_target(&dest_url) {
                        references.push((range.start, Reference::Image(dest_url.into_string())));
                    }
                }
                hidden += 1;
            }
            Event::End(TagEnd::CodeBlock) => {
                hidden = hidden.saturating_sub(1);
                visible.push('\n');
            }
            Event::End(TagEnd::Image) => hidden = hidden.saturating_sub(1),
            Event::Start(Tag::Link { dest_url, .. })
                if hidden == 0 && local_document_target(&dest_url) =>
            {
                references.push((range.start, Reference::Document(dest_url.into_string())));
            }
            Event::Text(text) if hidden == 0 => {
                let raw = &content[range.clone()];
                if text.as_ref() == raw {
                    for (offset, _) in text
                        .char_indices()
                        .filter(|(_, character)| *character == '@')
                    {
                        let source = range.start + offset;
                        let escapes = content.as_bytes()[..source]
                            .iter()
                            .rev()
                            .take_while(|byte| **byte == b'\\')
                            .count();
                        if escapes % 2 == 0 {
                            mention_sources.push((visible.len() + offset, source));
                        }
                    }
                }
                // Entity Text events contribute their visible characters, but
                // an entity-created @ has no authored invocation position.
                visible.push_str(&text);
            }
            Event::Code(text) if hidden == 0 => {
                // Keep rendered code text for adjacent token boundaries, but
                // never let it supply any part of an invocation's name.
                code_ranges.push(visible.len()..visible.len() + text.len());
                visible.push_str(&text);
            }
            Event::SoftBreak | Event::HardBreak | Event::Rule if hidden == 0 => visible.push('\n'),
            Event::Start(
                Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::BlockQuote(_)
                | Tag::List(_)
                | Tag::Item
                | Tag::HtmlBlock,
            ) if hidden == 0 => visible.push('\n'),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::BlockQuote(_)
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::HtmlBlock,
            ) if hidden == 0 => visible.push('\n'),
            _ => {}
        }
        if references.len() > MAX_REFERENCES {
            break;
        }
    }
    let names = skill_mention_references_filtered_at(
        &visible,
        |offset, name| {
            let first_code = code_ranges.partition_point(|range| range.end <= offset);
            let overlaps_code = code_ranges
                .get(first_code)
                .is_some_and(|range| range.start < offset + 1 + name.len());
            !overlaps_code
                && mention_sources
                    .binary_search_by_key(&offset, |(offset, _)| *offset)
                    .is_ok()
        },
        MAX_REFERENCES + 1,
    );
    let too_many_names = names.len() > MAX_REFERENCES;
    for (offset, name) in names {
        let index = mention_sources
            .binary_search_by_key(&offset, |(offset, _)| *offset)
            .expect("accepted authored mention position");
        references.push((mention_sources[index].1, Reference::Skill(name)));
        if references.len() > MAX_REFERENCES {
            break;
        }
    }
    references.sort_by_key(|(offset, _)| *offset);
    if too_many_names {
        while references.len() <= MAX_REFERENCES {
            references.push((usize::MAX, Reference::Skill("reference-limit".into())));
        }
    }
    references
        .into_iter()
        .map(|(_, reference)| reference)
        .collect()
}

/// Reuse the resolver's rendered-Markdown rules when checking an imported
/// package before copying it. Skill callers pass the body without frontmatter.
/// The returned list is bounded by the resolver's reference scan budget.
pub(super) fn local_document_references(content: &str) -> Vec<String> {
    references(content)
        .into_iter()
        .filter_map(|reference| match reference {
            Reference::Document(target) => Some(target),
            Reference::Skill(_) | Reference::Image(_) => None,
        })
        .collect()
}

/// Local image destinations are known unsupported dependencies even when the
/// target happens to use a text extension; image alt text remains an example.
pub(super) fn local_image_references(content: &str) -> Vec<String> {
    references(content)
        .into_iter()
        .filter_map(|reference| match reference {
            Reference::Image(target) => Some(target),
            Reference::Skill(_) | Reference::Document(_) => None,
        })
        .collect()
}

/// Import preflight must refuse a package when the bounded parser cannot
/// inspect every authored dependency reference.
pub(super) fn dependency_reference_limit_exceeded(content: &str) -> bool {
    references(content).len() > MAX_REFERENCES
}

fn local_document_target(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.starts_with('#') || value.starts_with("//") {
        return false;
    }
    // A drive prefix is an invalid local target; other schemes are ordinary links.
    if let Some((scheme, _)) = value.split_once(':') {
        if !(scheme.len() == 1 && scheme.as_bytes()[0].is_ascii_alphabetic()) {
            return false;
        }
    }
    let path = value.split(['#', '?']).next().unwrap_or("");
    !path.is_empty()
}
fn is_text(path: &Path) -> bool {
    is_markdown(path)
        || path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
}
pub(super) fn percent_decode(value: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(value.len());
    let input = value.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' {
            if index + 2 >= input.len() {
                return Err("Malformed percent escape in document link.".into());
            }
            let hex = std::str::from_utf8(&input[index + 1..index + 3])
                .map_err(|_| "Malformed percent escape in document link.")?;
            bytes.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "Malformed percent escape in document link.")?,
            );
            index += 3;
        } else {
            bytes.push(input[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| "Document link is not valid UTF-8.".into())
}

struct Analyzer {
    folder: PathBuf,
    configs: Vec<Config>,
    aliases: HashMap<String, Vec<usize>>,
    identities: HashMap<PathBuf, usize>,
    report: SkillDependencyReport,
    loaded: Vec<LoadedDependency>,
    characters: usize,
    skill_count: usize,
    references: usize,
    reference_limit_reported: bool,
    issue_pending_target: bool,
    preview: Option<(PathBuf, String)>,
    pending: VecDeque<Pending>,
}
impl Analyzer {
    fn issue(
        &mut self,
        code: &str,
        message: impl Into<String>,
        chain: &[String],
        source: Option<&Path>,
        reference: Option<&str>,
    ) {
        self.issue_pending_target = false;
        if self.report.issues.len() >= MAX_ISSUES - 1 {
            if self.report.issues.len() == MAX_ISSUES - 1 {
                self.report.issues.push(SkillDependencyIssue {
                    code: "diagnostic-limit".into(),
                    message: "Additional dependency problems were found but could not be listed within the diagnostic limit. No skill context was sent.".into(),
                    root_name: None,
                    chain: vec![],
                    source_path: None,
                    reference: None,
                    target_node_id: None,
                    source_node_id: None,
                });
            }
            return;
        }
        self.report.issues.push(SkillDependencyIssue {
            code: code.into(),
            message: diagnostic(&message.into()),
            root_name: chain
                .first()
                .map(|name| name.trim_start_matches('@').to_string()),
            chain: chain.iter().map(|part| diagnostic(part)).collect(),
            source_path: source.and_then(diagnostic_path),
            reference: reference.map(diagnostic),
            target_node_id: None,
            source_node_id: source
                .and_then(|path| self.identities.get(path))
                .map(|index| self.report.nodes[*index].id.clone()),
        });
        self.issue_pending_target = true;
    }
    fn identify_latest_issue(&mut self, reference: &str, target: &str, parent: Option<&str>) {
        if !self.issue_pending_target {
            return;
        }
        self.issue_pending_target = false;
        if let Some(issue) = self.report.issues.last_mut() {
            if issue.reference.as_deref() == Some(diagnostic(reference).as_str())
                && issue.target_node_id.is_none()
            {
                issue.target_node_id = Some(target.into());
                if let Some(parent) = parent {
                    issue.source_node_id = Some(parent.into());
                }
            }
        }
    }
    fn blocked(
        &mut self,
        name: &str,
        kind: &str,
        path: &Path,
        depth: usize,
        parent: Option<&str>,
        reference: &str,
    ) -> String {
        // All diagnostic graph growth shares the reference cap.
        if !path.as_os_str().is_empty() {
            if let Some(index) = self.identities.get(path).copied() {
                let id = self.report.nodes[index].id.clone();
                self.identify_latest_issue(reference, &id, parent);
                if let Some(parent) = parent {
                    self.report.edges.push(SkillDependencyEdge {
                        from: parent.into(),
                        to: id.clone(),
                        reference: diagnostic(reference),
                    });
                }
                return id;
            }
        }
        let id = format!(
            "blocked:{:x}",
            Sha256::digest(
                format!("{}:{reference}:{}", path.display(), self.report.nodes.len()).as_bytes()
            )
        );
        if self.report.nodes.len() < MAX_DIAGNOSTIC_NODES {
            self.report.nodes.push(SkillDependencyNode {
                id: id.clone(),
                name: diagnostic(name),
                kind: kind.into(),
                path: diagnostic_path(path).unwrap_or_default(),
                status: "blocked".into(),
                character_count: 0,
                depth,
                content_hash: None,
            });
            if let Some(parent) = parent {
                self.report.edges.push(SkillDependencyEdge {
                    from: parent.into(),
                    to: id.clone(),
                    reference: diagnostic(reference),
                });
            }
            if !path.as_os_str().is_empty() {
                self.identities
                    .insert(path.to_path_buf(), self.report.nodes.len() - 1);
            }
            self.identify_latest_issue(reference, &id, parent);
        }
        id
    }
    fn skill(
        &mut self,
        name: &str,
        depth: usize,
        system: bool,
        parent: Option<&str>,
        chain: Vec<String>,
        stack: &[PathBuf],
    ) -> Option<String> {
        let reference = format!("@{name}");
        let matches = self.aliases.get(name).cloned().unwrap_or_default();
        let enabled = matches
            .iter()
            .copied()
            .filter(|index| self.configs[*index].enabled)
            .collect::<Vec<_>>();
        if enabled.len() != 1 {
            if parent.is_none() && !system && enabled.is_empty() {
                return None;
            } // Legacy authored unknown mentions are plain text.
            let (code, message) = if enabled.len() > 1 {
                (
                    "ambiguous-skill",
                    format!("Two enabled skills use the invocation name `{name}`"),
                )
            } else if !matches.is_empty() {
                ("disabled-skill", format!("Skill `{name}` is disabled."))
            } else {
                let context = if parent.is_some() {
                    "nested skill"
                } else {
                    "skill"
                };
                ("unknown-skill", format!("Unknown {context} `{name}`."))
            };
            self.issue(
                code,
                message,
                &chain,
                stack.last().map(PathBuf::as_path),
                Some(&reference),
            );
            return Some(self.blocked(name, "skill", Path::new(""), depth, parent, &reference));
        }
        let config = self.configs[enabled[0]].clone();
        Some(self.file(
            &config.path,
            "skill",
            name,
            Traversal {
                depth,
                system,
                parent,
                reference: &reference,
                chain,
                stack,
            },
        ))
    }
    fn file(
        &mut self,
        raw: &Path,
        requested_kind: &str,
        requested_name: &str,
        traversal: Traversal<'_>,
    ) -> String {
        let Traversal {
            depth,
            system,
            parent,
            reference,
            chain,
            stack,
        } = traversal;
        if !raw.is_absolute() || diagnostic_path(raw).is_none() {
            self.issue(
                "invalid-path",
                "Skill source paths must be absolute local paths without control characters.",
                &chain,
                stack.last().map(PathBuf::as_path),
                Some(reference),
            );
            return self.blocked(
                requested_name,
                requested_kind,
                Path::new(""),
                depth,
                parent,
                reference,
            );
        }
        let source = match raw.canonicalize() {
            Ok(source) => source,
            Err(error) => {
                self.issue(
                    "missing-file",
                    format!(
                        "Could not open the skill source or document {}: {error}",
                        raw.display()
                    ),
                    &chain,
                    stack.last().map(PathBuf::as_path),
                    Some(reference),
                );
                return self.blocked(
                    requested_name,
                    requested_kind,
                    raw,
                    depth,
                    parent,
                    reference,
                );
            }
        };
        // Runtime mirrors cannot carry hidden entries or symlink aliases.
        // Reject the authored path as well as its canonical target so preview
        // and provider delivery agree about which documents are available.
        let mut cursor = self.folder.clone();
        let unsupported_path = raw.strip_prefix(&self.folder).is_ok_and(|relative| {
            relative.components().any(|component| {
                match component {
                    std::path::Component::Normal(part) => {
                        cursor.push(part);
                        part.to_string_lossy().starts_with('.')
                            || std::fs::symlink_metadata(&cursor).is_ok_and(|meta| meta.file_type().is_symlink())
                            || super::is_windows_reparse_point(&cursor).unwrap_or(false)
                    }
                    std::path::Component::ParentDir => { cursor.pop(); false }
                    _ => false,
                }
            })
        });
        if source.starts_with(&self.folder) && unsupported_path {
            self.issue("unsupported-document", "Hidden files and symbolic-link paths cannot be included in provider skill libraries. Use a visible, regular file inside the skills folder.", &chain, stack.last().map(PathBuf::as_path), Some(reference));
            return self.blocked(requested_name, requested_kind, raw, depth, parent, reference);
        }
        if diagnostic_path(&source).is_none() {
            self.issue("invalid-path", "Skill source paths must be bounded absolute local paths without control characters.", &chain, stack.last().map(PathBuf::as_path), Some(reference));
            return self.blocked(
                requested_name,
                requested_kind,
                Path::new(""),
                depth,
                parent,
                reference,
            );
        }
        if requested_kind == "document"
            && detected_path(&self.folder, &source)
            && !self.configs.iter().any(|config| config.path == source)
        {
            self.issue(
                "unavailable-skill",
                format!(
                    "Linked skill {} is not available in the configured skills library.",
                    source.display()
                ),
                &chain,
                stack.last().map(PathBuf::as_path),
                Some(reference),
            );
            return self.blocked(requested_name, "skill", &source, depth, parent, reference);
        }
        let enabled_config = self
            .configs
            .iter()
            .find(|config| config.enabled && config.path == source)
            .cloned();
        let known_disabled = enabled_config.is_none()
            && self
                .configs
                .iter()
                .any(|config| !config.enabled && config.path == source);
        let kind = if enabled_config.is_some() {
            "skill"
        } else {
            requested_kind
        };
        let name = enabled_config
            .as_ref()
            .map_or(requested_name, |config| config.name.as_str())
            .to_string();
        let invalid_skill = kind == "skill" && !detected_path(&self.folder, &source);
        if requested_kind == "document" && source.starts_with(&self.folder) && source.is_dir() {
            self.issue(
                "unsupported-document",
                "Local document dependencies must be UTF-8 .md, .markdown, or .txt files, not directories.",
                &chain,
                stack.last().map(PathBuf::as_path),
                Some(reference),
            );
            return self.blocked(&name, "document", &source, depth, parent, reference);
        }
        if !source.starts_with(&self.folder)
            || !source.is_file()
            || !is_text(&source)
            || invalid_skill
        {
            self.issue("outside-folder", "The selected skill source is not a detected Mythra Code skill in the skills folder, or the document escapes that folder.", &chain, stack.last().map(PathBuf::as_path), Some(reference));
            return self.blocked(&name, kind, &source, depth, parent, reference);
        }
        let preview_root = depth == 0
            && parent.is_none()
            && self
                .preview
                .as_ref()
                .is_some_and(|(path, _)| path == &source);
        if known_disabled {
            self.issue(
                "disabled-skill",
                format!("Linked skill {} is disabled.", source.display()),
                &chain,
                stack.last().map(PathBuf::as_path),
                Some(reference),
            );
            if !preview_root {
                return self.blocked(&name, "skill", &source, depth, parent, reference);
            }
        }
        if stack.contains(&source) {
            let id = self
                .identities
                .get(&source)
                .map(|index| self.report.nodes[*index].id.clone())
                .unwrap_or_default();
            if let Some(parent) = parent {
                self.report.edges.push(SkillDependencyEdge {
                    from: parent.into(),
                    to: id.clone(),
                    reference: reference.into(),
                });
            }
            self.issue(
                "cycle",
                "Skill dependency cycle detected.",
                &chain,
                stack.last().map(PathBuf::as_path),
                Some(reference),
            );
            self.identify_latest_issue(reference, &id, parent);
            return id;
        }
        if let Some(index) = self.identities.get(&source).copied() {
            self.report.nodes[index].depth = self.report.nodes[index].depth.min(depth);
            let id = self.report.nodes[index].id.clone();
            if let Some(parent) = parent {
                self.report.edges.push(SkillDependencyEdge {
                    from: parent.into(),
                    to: id.clone(),
                    reference: reference.into(),
                });
            }
            return id;
        }
        if depth > MAX_DEPTH {
            self.issue("depth-limit", format!("Skill dependencies may use no more than {MAX_DEPTH} dependency hops from a direct root."), &chain, stack.last().map(PathBuf::as_path), Some(reference));
            return self.blocked(&name, kind, &source, depth, parent, reference);
        }
        if self.loaded.len() >= MAX_FILES || (kind == "skill" && self.skill_count >= MAX_SKILLS) {
            let (code, message) = if kind == "skill" && self.skill_count >= MAX_SKILLS {
                (
                    "skill-limit",
                    format!("Invoke no more than {MAX_SKILLS} skills in one model turn."),
                )
            } else {
                ("file-limit", format!("Skill dependencies may load no more than {MAX_FILES} files in one model turn."))
            };
            self.issue(
                code,
                message,
                &chain,
                stack.last().map(PathBuf::as_path),
                Some(reference),
            );
            return self.blocked(&name, kind, &source, depth, parent, reference);
        }
        let instructions = if self
            .preview
            .as_ref()
            .is_some_and(|(path, _)| path == &source)
        {
            Ok(self.preview.as_ref().unwrap().1.clone())
        } else {
            read_bounded(&self.folder, &source)
        };
        let instructions = match instructions {
            Ok(content) => content,
            Err((code, message)) => {
                self.issue(code, message, &chain, Some(&source), Some(reference));
                return self.blocked(&name, kind, &source, depth, parent, reference);
            }
        };
        let count = instructions.chars().count();
        if self.characters.saturating_add(count) > MAX_CHARACTERS {
            self.issue("character-limit", "The invoked skill instructions are too large for one model turn. Shorten them or invoke fewer skills.", &chain, Some(&source), Some(reference));
            return self.blocked(&name, kind, &source, depth, parent, reference);
        }
        let index = self.report.nodes.len();
        let id = format!(
            "file:{:x}",
            Sha256::digest(source.to_string_lossy().as_bytes())
        );
        self.identities.insert(source.clone(), index);
        self.report.nodes.push(SkillDependencyNode {
            id: id.clone(),
            kind: kind.into(),
            name,
            path: source.to_string_lossy().into_owned(),
            status: "loaded".into(),
            character_count: count,
            depth,
            content_hash: Some(format!("{:x}", Sha256::digest(instructions.as_bytes()))),
        });
        if let Some(parent) = parent {
            self.report.edges.push(SkillDependencyEdge {
                from: parent.into(),
                to: id.clone(),
                reference: reference.into(),
            });
        }
        self.characters += count;
        self.skill_count += usize::from(kind == "skill");
        // Skill frontmatter describes discovery metadata, not dependency
        // instructions. Keep the complete source in the payload/hash/budget;
        // only dependency discovery uses its authored body. Reference
        // documents remain literal text, including any YAML examples.
        let reference_content = if kind == "skill" {
            super::split_skill_markdown(&instructions).1
        } else {
            &instructions
        };
        let refs = references(reference_content);
        self.loaded.push(LoadedDependency {
            node: index,
            instructions,
            system,
        });
        let mut stack = stack.to_vec();
        stack.push(source.clone());
        for dependency in refs {
            self.references += 1;
            if self.references > MAX_REFERENCES {
                if self.reference_limit_reported {
                    break;
                }
                self.reference_limit_reported = true;
                let (kind, name, reference) = match &dependency {
                    Reference::Skill(name) => ("skill", name.clone(), format!("@{name}")),
                    Reference::Document(reference) | Reference::Image(reference) => {
                        ("document", reference.clone(), reference.clone())
                    }
                };
                let mut omitted_chain = chain.clone();
                omitted_chain.push(reference.clone());
                self.issue(
                    "reference-limit",
                    format!("Skill dependencies contain more than {MAX_REFERENCES} references. This reference and any later references were not inspected."),
                    &omitted_chain,
                    Some(&source),
                    Some(&reference),
                );
                self.blocked(&name, kind, Path::new(""), depth + 1, Some(&id), &reference);
                break;
            }
            self.pending.push_back(Pending {
                dependency,
                source: source.clone(),
                parent: id.clone(),
                depth: depth + 1,
                system,
                chain: chain.clone(),
                stack: stack.clone(),
            });
        }
        id
    }
    fn drain(&mut self) {
        while let Some(Pending {
            dependency,
            source,
            parent,
            depth,
            system,
            chain,
            stack,
        }) = self.pending.pop_front()
        {
            match dependency {
                Reference::Skill(name) => {
                    let mut chain = chain.clone();
                    chain.push(format!("@{name}"));
                    self.skill(&name, depth, system, Some(&parent), chain, &stack);
                }
                Reference::Image(reference) => {
                    let mut chain = chain.clone();
                    chain.push(reference.clone());
                    self.issue(
                        "unsupported-document",
                        "Local image targets are not loaded as skill dependencies. Link a supported UTF-8 text document instead.",
                        &chain,
                        Some(&source),
                        Some(&reference),
                    );
                    self.blocked(
                        &reference,
                        "document",
                        Path::new(""),
                        depth,
                        Some(&parent),
                        &reference,
                    );
                }
                Reference::Document(reference) => {
                    let mut chain = chain.clone();
                    chain.push(reference.clone());
                    let path_text = reference.split(['#', '?']).next().unwrap_or("");
                    if reference.len() > 4096 {
                        self.issue(
                            "malformed-link",
                            "Local document links must be no longer than 4096 bytes.",
                            &chain,
                            Some(&source),
                            Some(&reference),
                        );
                        self.blocked(
                            &reference,
                            "document",
                            Path::new(""),
                            depth,
                            Some(&parent),
                            &reference,
                        );
                        continue;
                    }
                    match percent_decode(path_text) {
                        Ok(path_text)
                            if !path_text.chars().any(char::is_control)
                                && !Path::new(&path_text).is_absolute()
                                && !path_text.contains(':')
                                && !path_text.starts_with('\\') =>
                        {
                            // CommonMark paths use / on both platforms; accepting a backslash here
                            // would give the same text different authority on Windows and macOS.
                            if path_text.contains('\\') {
                                self.issue(
                                    "malformed-link",
                                    "Use forward slashes in local document links.",
                                    &chain,
                                    Some(&source),
                                    Some(&reference),
                                );
                                self.blocked(
                                    &reference,
                                    "document",
                                    Path::new(""),
                                    depth,
                                    Some(&parent),
                                    &reference,
                                );
                            } else {
                                let path = source.parent().unwrap_or(&self.folder).join(&path_text);
                                if path_text.ends_with('/') || !is_text(&path) {
                                    self.issue("unsupported-document", "Unsupported local document target. Only .md, .markdown, and .txt UTF-8 documents can be loaded; other file types, directories, and extensionless targets are not read.", &chain, Some(&source), Some(&reference));
                                    self.blocked(
                                        &reference,
                                        "document",
                                        &path,
                                        depth,
                                        Some(&parent),
                                        &reference,
                                    );
                                    continue;
                                }
                                self.file(
                                    &path,
                                    "document",
                                    &reference,
                                    Traversal {
                                        depth,
                                        system,
                                        parent: Some(&parent),
                                        reference: &reference,
                                        chain,
                                        stack: &stack,
                                    },
                                );
                            }
                        }
                        Ok(_) => {
                            self.issue("malformed-link", "Local document links must be relative paths without a drive, control character or URI scheme.", &chain, Some(&source), Some(&reference));
                            self.blocked(
                                &reference,
                                "document",
                                Path::new(""),
                                depth,
                                Some(&parent),
                                &reference,
                            );
                        }
                        Err(message) => {
                            self.issue(
                                "malformed-link",
                                message,
                                &chain,
                                Some(&source),
                                Some(&reference),
                            );
                            self.blocked(
                                &reference,
                                "document",
                                Path::new(""),
                                depth,
                                Some(&parent),
                                &reference,
                            );
                        }
                    }
                }
            }
        }
    }
}
fn detected_path(folder: &Path, source: &Path) -> bool {
    let Ok(relative) = source.strip_prefix(folder) else {
        return false;
    };
    if relative.components().count() > super::MAX_SKILL_SCAN_DEPTH + 1
        || relative
            .components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    {
        return false;
    }
    is_markdown(source)
        && (source.parent() == Some(folder)
            || source
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md")))
}
pub(super) fn read_bounded(folder: &Path, source: &Path) -> Result<String, (&'static str, String)> {
    read_bounded_with_metadata(folder, source).map(|(contents, _)| contents)
}

pub(super) fn read_bounded_with_metadata(
    folder: &Path,
    source: &Path,
) -> Result<(String, std::fs::Metadata), (&'static str, String)> {
    let mut options = fs_open_options();
    let mut file = options.read(true).open(source).map_err(|error| {
        (
            "read-error",
            format!("Could not read {}: {error}", source.display()),
        )
    })?;
    let before = file
        .metadata()
        .map_err(|error| ("read-error", error.to_string()))?;
    if !before.is_file() || !opened_identity_matches(folder, source, &file, &before) {
        return Err((
            "changed-file",
            format!(
                "{} changed or is not a regular file in the selected folder.",
                source.display()
            ),
        ));
    }
    if before.len() > MAX_FILE_BYTES {
        return Err((
            "file-size-limit",
            format!("{} is larger than 1 MB", source.display()),
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ("read-error", error.to_string()))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err((
            "file-size-limit",
            format!("{} is larger than 1 MB", source.display()),
        ));
    }
    let after = file
        .metadata()
        .map_err(|error| ("read-error", error.to_string()))?;
    #[cfg(windows)]
    let encryption_changed = {
        use std::os::windows::fs::MetadataExt;
        (before.file_attributes() ^ after.file_attributes()) & 0x4000 != 0
    };
    #[cfg(not(windows))]
    let encryption_changed = false;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || before.permissions() != after.permissions()
        || encryption_changed
        || !opened_identity_matches(folder, source, &file, &after)
    {
        return Err((
            "changed-file",
            format!(
                "{} changed while its dependencies were read. Try again.",
                source.display()
            ),
        ));
    }
    String::from_utf8(bytes)
        .map(|contents| (contents, before))
        .map_err(|error| {
            (
                "invalid-utf8",
                format!("Could not read {} as UTF-8: {error}", source.display()),
            )
        })
}

fn fs_open_options() -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options
}
fn opened_identity_matches(
    folder: &Path,
    source: &Path,
    file: &File,
    metadata: &std::fs::Metadata,
) -> bool {
    let Ok(current) = source.canonicalize() else {
        return false;
    };
    if current != source || !current.starts_with(folder) {
        return false;
    }
    let Ok(path_metadata) = std::fs::metadata(source) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        metadata.dev() == path_metadata.dev() && metadata.ino() == path_metadata.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let _ = (metadata, path_metadata);
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let Ok(path_file) = fs_open_options().read(true).open(source) else {
            return false;
        };
        let mut opened: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut named: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        unsafe {
            GetFileInformationByHandle(file.as_raw_handle().cast(), &mut opened) != 0
                && GetFileInformationByHandle(path_file.as_raw_handle().cast(), &mut named) != 0
                && opened.dwVolumeSerialNumber == named.dwVolumeSerialNumber
                && opened.nFileIndexHigh == named.nFileIndexHigh
                && opened.nFileIndexLow == named.nFileIndexLow
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        metadata.len() == path_metadata.len()
            && metadata.modified().ok() == path_metadata.modified().ok()
    }
}

pub(super) fn analyze(
    folder: &Path,
    message: &str,
    system_prompt: &str,
    mention_source: Option<&str>,
    configs: Vec<SkillBridgeConfig>,
    preview_path: Option<&str>,
    preview_content: Option<&str>,
) -> DependencyAnalysis {
    let mut analyzer = Analyzer {
        folder: folder.to_path_buf(),
        configs: vec![],
        aliases: HashMap::new(),
        identities: HashMap::new(),
        report: SkillDependencyReport::default(),
        loaded: vec![],
        characters: 0,
        skill_count: 0,
        references: 0,
        reference_limit_reported: false,
        issue_pending_target: false,
        preview: None,
        pending: VecDeque::new(),
    };
    if configs.len() > MAX_CONFIGS {
        analyzer.issue(
            "configuration-limit",
            "The skills library has too many configured aliases.",
            &[],
            None,
            None,
        );
    }
    for config in configs.into_iter().take(MAX_CONFIGS) {
        let name = normalize_skill_name(&config.name);
        if name.is_empty() {
            continue;
        }
        let raw = PathBuf::from(config.source_path);
        let path = raw.canonicalize().unwrap_or(raw);
        let index = analyzer.configs.len();
        analyzer
            .aliases
            .entry(name.clone())
            .or_default()
            .push(index);
        analyzer.configs.push(Config {
            name,
            path,
            enabled: config.enabled,
        });
    }
    let enabled_names = analyzer
        .aliases
        .iter()
        .filter(|(_, indexes)| indexes.iter().any(|index| analyzer.configs[*index].enabled))
        .map(|(name, _)| name.clone())
        .collect::<HashSet<_>>();
    let authored_names = |text: &str, system: bool| {
        skill_mention_references_filtered(
            text,
            |name| system || enabled_names.contains(name),
            MAX_ROOTS + 1,
        )
        .into_iter()
        .map(|(_, name)| name)
        .collect::<Vec<_>>()
    };
    let system_names = authored_names(system_prompt, true);
    let user_names = authored_names(mention_source.unwrap_or(message), false);
    let has_root = system_names.iter().chain(&user_names).any(|name| {
        analyzer
            .aliases
            .get(name)
            .is_some_and(|indexes| indexes.iter().any(|index| analyzer.configs[*index].enabled))
    }) || preview_path.is_some()
        || preview_content.is_some();
    if has_root {
        match canonical_skill_folder(&folder.to_string_lossy()) {
            Ok(folder) => analyzer.folder = folder,
            Err(message) => analyzer.issue("folder-error", message, &[], None, None),
        }
    }
    if preview_path.is_some() != preview_content.is_some() {
        analyzer.issue(
            "invalid-preview",
            "A preview requires both the known skill path and its content.",
            &[],
            None,
            None,
        );
    } else if let (Some(path), Some(content)) = (preview_path, preview_content) {
        match Path::new(path).canonicalize() {
            Ok(path) if path.starts_with(&analyzer.folder) && detected_path(&analyzer.folder, &path) && analyzer.configs.iter().any(|config| config.path == path) && content.len() as u64 <= MAX_FILE_BYTES => analyzer.preview = Some((path, content.into())),
            _ => analyzer.issue("invalid-preview", "Preview content must belong to a known skill in the selected folder and be no larger than 1 MB.", &[], None, None),
        }
    }
    for (system, names) in [(true, system_names), (false, user_names)] {
        for name in names {
            if analyzer.report.roots.len() >= MAX_ROOTS {
                analyzer.issue(
                    "root-limit",
                    "Too many authored skill roots.",
                    &[format!("@{name}")],
                    None,
                    None,
                );
                break;
            }
            if let Some(id) = analyzer.skill(&name, 0, system, None, vec![format!("@{name}")], &[])
            {
                analyzer.report.roots.push(SkillDependencyRoot {
                    node_id: id,
                    channel: if system { "system" } else { "user" }.into(),
                    name,
                });
            }
        }
    }
    if let Some((path, _)) = analyzer.preview.clone() {
        if let Some(config) = analyzer
            .configs
            .iter()
            .find(|config| config.path == path)
            .cloned()
        {
            let id = analyzer.file(
                &path,
                "skill",
                &config.name,
                Traversal {
                    depth: 0,
                    system: false,
                    parent: None,
                    reference: &format!("@{}", config.name),
                    chain: vec![format!("@{}", config.name)],
                    stack: &[],
                },
            );
            if !analyzer.report.roots.iter().any(|root| root.node_id == id) {
                analyzer.report.roots.push(SkillDependencyRoot {
                    node_id: id,
                    channel: "user".into(),
                    name: config.name,
                });
            }
        }
    }
    analyzer.drain();
    // Ownership is reachability from all system roots, independent of the
    // queue order or which alias first encountered a shared file.
    let mut system_ids = analyzer
        .report
        .roots
        .iter()
        .filter(|root| root.channel == "system")
        .map(|root| root.node_id.clone())
        .collect::<HashSet<_>>();
    loop {
        let previous = system_ids.len();
        for edge in &analyzer.report.edges {
            if system_ids.contains(&edge.from) {
                system_ids.insert(edge.to.clone());
            }
        }
        if previous == system_ids.len() {
            break;
        }
    }
    for loaded in &mut analyzer.loaded {
        loaded.system = system_ids.contains(&analyzer.report.nodes[loaded.node].id);
    }
    detect_cycles(&mut analyzer);
    // Diagnostic expansion is bounded separately from instruction content.
    // Return an explicit failure rather than send a report the renderer cannot
    // validate or leave the model with only part of the dependency graph.
    if serde_json::to_vec(&analyzer.report).is_ok_and(|bytes| bytes.len() > 480_000) {
        let root_name = analyzer.report.roots.first().map(|root| root.name.clone());
        analyzer.report.roots.clear();
        analyzer.report.nodes.clear();
        analyzer.report.edges.clear();
        analyzer.report.issues.clear();
        analyzer.issue("report-limit", "The dependency graph diagnostics are too large. Shorten local references or reduce the dependency graph.", &root_name.iter().map(|name| format!("@{name}")).collect::<Vec<_>>(), None, None);
    }
    DependencyAnalysis {
        report: analyzer.report,
        loaded: analyzer.loaded,
    }
}

fn detect_cycles(analyzer: &mut Analyzer) {
    fn visit(
        id: &str,
        report: &SkillDependencyReport,
        active: &mut Vec<String>,
        done: &mut HashSet<String>,
        chain: &mut Vec<String>,
    ) -> Option<(Vec<String>, String, String)> {
        if done.contains(id) {
            return None;
        }
        active.push(id.into());
        for edge in report.edges.iter().filter(|edge| edge.from == id) {
            chain.push(edge.reference.clone());
            if active.iter().any(|item| item == &edge.to) {
                return Some((chain.clone(), edge.from.clone(), edge.to.clone()));
            }
            if let Some(cycle) = visit(&edge.to, report, active, done, chain) {
                return Some(cycle);
            }
            chain.pop();
        }
        active.pop();
        done.insert(id.into());
        None
    }
    if analyzer
        .report
        .issues
        .iter()
        .any(|issue| issue.code == "cycle")
    {
        return;
    }
    for root in analyzer.report.roots.clone() {
        if let Some((chain, source, target)) = visit(
            &root.node_id,
            &analyzer.report,
            &mut vec![],
            &mut HashSet::new(),
            &mut vec![format!("@{}", root.name)],
        ) {
            let reference = chain.last().cloned().unwrap_or_default();
            analyzer.issue(
                "cycle",
                "Skill dependency cycle detected.",
                &chain,
                None,
                Some(&reference),
            );
            analyzer.identify_latest_issue(&reference, &target, Some(&source));
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Library {
        root: PathBuf,
        configs: Vec<SkillBridgeConfig>,
    }
    impl Library {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("mythra-dependencies-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self {
                root,
                configs: vec![],
            }
        }
        fn document(&self, name: &str, content: impl AsRef<[u8]>) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }
        fn skill(&mut self, alias: &str, path: &str, content: &str, enabled: bool) -> PathBuf {
            let path = self.document(path, content);
            self.configs.push(SkillBridgeConfig {
                name: alias.into(),
                source_path: path.to_string_lossy().into_owned(),
                enabled,
            });
            path
        }
        fn analyze(&self, user: &str, system: &str) -> DependencyAnalysis {
            analyze(
                &self.root,
                user,
                system,
                None,
                self.configs.clone(),
                None,
                None,
            )
        }
    }
    impl Drop for Library {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn has_issue(result: &DependencyAnalysis, code: &str) -> bool {
        result.report.issues.iter().any(|issue| issue.code == code)
    }

    #[test]
    fn direct_system_failures_are_reported_without_changing_unknown_user_text() {
        let mut lib = Library::new();
        lib.skill("disabled", "disabled.md", "Never loaded", false);
        let result = lib.analyze("Please keep @unknown literal", "Use @missing and @disabled");
        assert_eq!(result.report.roots.len(), 2);
        assert!(result
            .report
            .roots
            .iter()
            .all(|root| root.channel == "system"));
        assert!(has_issue(&result, "unknown-skill"));
        assert!(has_issue(&result, "disabled-skill"));
        assert!(result
            .report
            .issues
            .iter()
            .find(|issue| issue.code == "unknown-skill")
            .unwrap()
            .message
            .starts_with("Unknown skill `missing`"));
        assert!(result
            .report
            .nodes
            .iter()
            .all(|node| node.status == "blocked"));
        for issue in &result.report.issues {
            let target = issue
                .target_node_id
                .as_ref()
                .expect("specific blocked node");
            assert!(result.report.nodes.iter().any(|node| &node.id == target));
        }
    }

    #[test]
    fn repeated_authored_mentions_have_one_root_per_channel() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "Ready", true);
        let result = lib.analyze("@a and @a", "@a then @a");
        assert_eq!(result.report.roots.len(), 2);
        assert_eq!(result.report.roots[0].channel, "system");
        assert_eq!(result.report.roots[1].channel, "user");
        assert!(result.report.issues.is_empty());
    }

    #[test]
    fn shared_node_cycle_issue_identifies_the_closing_edge() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "Use @b and @c", true);
        lib.skill("b", "b.md", "Use @c", true);
        lib.skill("c", "c.md", "Use @b", true);
        let report = lib.analyze("@a", "").report;
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.code == "cycle")
            .unwrap();
        let source = issue.source_node_id.as_deref().expect("cycle source node");
        let target = issue.target_node_id.as_deref().expect("cycle target node");
        assert!(report.edges.iter().any(|edge| edge.from == source
            && edge.to == target
            && issue.chain.last() == Some(&edge.reference)));
        assert!(report
            .nodes
            .iter()
            .any(|node| node.id == source && node.name == "c"));
        assert!(report
            .nodes
            .iter()
            .any(|node| node.id == target && node.name == "b"));
    }

    #[test]
    fn reused_blocked_target_keeps_each_failing_parent_edge() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "Use @b and @c", true);
        lib.skill("b", "b.md", "[Required](missing.txt)", true);
        lib.skill("c", "c.md", "[Required](missing.txt)", true);
        let report = lib.analyze("@a", "").report;
        let issues = report
            .issues
            .iter()
            .filter(|issue| issue.code == "missing-file")
            .collect::<Vec<_>>();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].target_node_id, issues[1].target_node_id);
        assert_ne!(issues[0].source_node_id, issues[1].source_node_id);
        for issue in issues {
            assert!(report.edges.iter().any(|edge| Some(edge.from.as_str())
                == issue.source_node_id.as_deref()
                && Some(edge.to.as_str()) == issue.target_node_id.as_deref()
                && Some(edge.reference.as_str()) == issue.reference.as_deref()));
        }
    }

    #[test]
    fn reference_limit_names_first_omitted_dependency() {
        let mut lib = Library::new();
        lib.skill(
            "a",
            "a.md",
            &(0..=MAX_REFERENCES)
                .map(|index| format!("[d](missing{index}.txt)\n"))
                .collect::<String>(),
            true,
        );
        let result = lib.analyze("@a", "");
        let issue = result
            .report
            .issues
            .iter()
            .find(|issue| issue.code == "reference-limit")
            .unwrap();
        assert_eq!(
            issue.chain.last().map(String::as_str),
            Some("missing128.txt")
        );
        assert_eq!(issue.reference.as_deref(), Some("missing128.txt"));
        let target = issue
            .target_node_id
            .as_ref()
            .expect("specific omitted node");
        assert!(result
            .report
            .nodes
            .iter()
            .any(|node| &node.id == target && node.status == "blocked"));
    }

    #[test]
    fn full_root_and_reference_budget_still_names_every_reported_target() {
        let mut lib = Library::new();
        lib.skill(
            "root",
            "root.md",
            &(0..=MAX_REFERENCES)
                .map(|child| format!("[Required](missing{child}.txt)\n"))
                .collect::<String>(),
            true,
        );
        let system = format!(
            "@root {}",
            (1..MAX_ROOTS)
                .map(|index| format!("@unknown{index}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let report = lib.analyze("", &system).report;
        assert_eq!(report.roots.len(), MAX_ROOTS);
        assert_eq!(report.nodes.len(), MAX_ROOTS + MAX_REFERENCES + 1);
        let ids = report
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<HashSet<_>>();
        assert!(report
            .edges
            .iter()
            .all(|edge| ids.contains(edge.from.as_str()) && ids.contains(edge.to.as_str())));
        assert!(report.issues.iter().all(|issue| issue
            .target_node_id
            .as_deref()
            .is_some_and(|id| ids.contains(id))));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "reference-limit"
                && issue.chain.last().map(String::as_str) == Some("missing128.txt")));
    }

    #[test]
    fn diagnostic_cap_reports_that_later_issues_were_omitted() {
        let mut analyzer = Analyzer {
            folder: PathBuf::new(),
            configs: vec![],
            aliases: HashMap::new(),
            identities: HashMap::new(),
            report: SkillDependencyReport::default(),
            loaded: vec![],
            characters: 0,
            skill_count: 0,
            references: 0,
            reference_limit_reported: false,
            issue_pending_target: false,
            preview: None,
            pending: VecDeque::new(),
        };
        for index in 0..MAX_ISSUES + 10 {
            analyzer.issue("sample", format!("Problem {index}"), &[], None, None);
        }
        assert_eq!(analyzer.report.issues.len(), MAX_ISSUES);
        assert_eq!(
            analyzer.report.issues.last().unwrap().code,
            "diagnostic-limit"
        );
        assert!(analyzer
            .report
            .issues
            .last()
            .unwrap()
            .message
            .contains("could not be listed"));
    }

    #[test]
    fn import_preflight_helpers_share_the_bounded_resolver_parser() {
        let markdown = "[Keep](docs/one%20two.txt) ` [Ignore](hidden.md) ` [Web](https://example.com/file.txt)";
        assert_eq!(
            local_document_references(markdown),
            vec!["docs/one%20two.txt"]
        );
        assert_eq!(
            percent_decode("docs/one%20two.txt").unwrap(),
            "docs/one two.txt"
        );
        assert!(!dependency_reference_limit_exceeded(markdown));
        let many = (0..=MAX_REFERENCES)
            .map(|index| format!("[Required](docs/{index}.txt)\n"))
            .collect::<String>();
        assert!(dependency_reference_limit_exceeded(&many));
    }

    #[test]
    fn unsupported_local_document_links_block_with_full_chains_without_reads() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "Use @b", true);
        lib.skill("b", "b.md", "[Report](references/report.pdf)", true);
        let result = lib.analyze("@a", "");
        assert!(has_issue(&result, "unsupported-document"));
        let issue = result
            .report
            .issues
            .iter()
            .find(|issue| issue.code == "unsupported-document")
            .unwrap();
        assert_eq!(issue.chain, vec!["@a", "@b", "references/report.pdf"]);
        assert_eq!(result.report.edges.len(), 2);
        let blocked = result
            .report
            .nodes
            .iter()
            .find(|node| node.status == "blocked")
            .unwrap();
        assert_eq!(issue.target_node_id.as_deref(), Some(blocked.id.as_str()));
        let parent = result
            .report
            .nodes
            .iter()
            .find(|node| node.name == "b")
            .unwrap();
        assert_eq!(issue.source_node_id.as_deref(), Some(parent.id.as_str()));
        assert!(result
            .report
            .nodes
            .iter()
            .any(|node| node.kind == "document" && node.status == "blocked"));
    }

    #[test]
    fn local_image_target_is_reported_without_reading_it_or_invoking_alt_text() {
        let mut lib = Library::new();
        lib.skill(
            "a",
            "a.md",
            "![Diagram @ghost](assets/flow.png) ![Remote @ghost](https://example.com/flow.png)",
            true,
        );
        lib.document("assets/flow.png", [0xff, 0xfe]);
        let result = lib.analyze("@a", "");
        let issue = result
            .report
            .issues
            .iter()
            .find(|issue| issue.code == "unsupported-document")
            .expect("local image issue");
        assert_eq!(issue.chain, vec!["@a", "assets/flow.png"]);
        assert_eq!(issue.reference.as_deref(), Some("assets/flow.png"));
        assert_eq!(result.loaded.len(), 1);
        assert!(!has_issue(&result, "invalid-utf8"));
        assert!(!has_issue(&result, "unknown-skill"));
        let node = result
            .report
            .nodes
            .iter()
            .find(|node| node.status == "blocked")
            .unwrap();
        assert_eq!(node.kind, "document");
        assert_eq!(issue.target_node_id.as_deref(), Some(node.id.as_str()));
        assert_eq!(
            local_image_references("![One](assets/flow.png) ![Two](https://example.com/flow.png)"),
            vec!["assets/flow.png"]
        );
        lib.document("a.md", "![Looks like text](assets/notes.md)");
        lib.document("assets/notes.md", "This must not be read");
        let text_target = lib.analyze("@a", "");
        assert!(has_issue(&text_target, "unsupported-document"));
        assert_eq!(text_target.loaded.len(), 1);
    }

    #[test]
    fn unsupported_document_types_directory_and_extensionless_links_are_required_but_never_read() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "x", true);
        for target in [
            "refs/file.pdf",
            "refs/file.PDF",
            "refs/file.docx",
            "refs/file.csv",
            "refs/file.json",
            "refs/file.png",
            "refs/file.jpg",
            "refs/file.rs",
            "refs/",
            "refs.txt/",
            "refs/file",
        ] {
            lib.document("a.md", format!("[Required]({target})"));
            let result = lib.analyze("@a", "");
            assert!(has_issue(&result, "unsupported-document"), "{target}");
            assert!(!has_issue(&result, "missing-file"));
            assert_eq!(result.loaded.len(), 1);
            assert_eq!(result.report.edges[0].reference, target);
        }
        lib.document("refs/file.docx", [0xff, 0xfe]);
        lib.document("a.md", "[Required](refs/file.docx)");
        let result = lib.analyze("@a", "");
        assert!(has_issue(&result, "unsupported-document"));
        assert!(!has_issue(&result, "invalid-utf8"));
        fs::create_dir_all(lib.root.join("refs/directory.txt")).unwrap();
        lib.document("a.md", "[Required](refs/directory.txt)");
        assert!(has_issue(&lib.analyze("@a", ""), "unsupported-document"));
        lib.document("a.md", "![Remote image](https://example.com/file.png) [Web](https://example.com/file.pdf) [Anchor](#x) [Network](//example.com/file.pdf) ` [Example](refs/file.docx) `\n\n```md\n[Example](refs/file.csv)\n```\n");
        assert!(lib.analyze("@a", "").report.issues.is_empty());
        lib.document(
            "a.md",
            (0..1_000)
                .map(|index| format!("[Required](refs/{index}.pdf)\n"))
                .collect::<String>(),
        );
        let bounded = lib.analyze("@a", "");
        assert!(has_issue(&bounded, "reference-limit"));
        assert!(bounded.report.edges.len() <= MAX_REFERENCES + 1);
        assert!(bounded.report.nodes.len() <= MAX_REFERENCES + MAX_ROOTS);
    }

    #[test]
    fn commonmark_links_reference_styles_escapes_and_code_examples() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "Use @b first, then [one](docs/one.md \"title\").\n[Two][two]\n\n[two]: docs/two.markdown\n\n[space](docs/space%20name.txt) [escaped](docs/parens\\(x\\).txt)\n\n`@missing [x](missing.md)`\n\n```md\n@missing [x](missing.md)\n```\n\n    @missing [x](missing.md)\n\n![image](https://example.com/image.png) [web](https://example.com/web.md) [anchor](#section) [pdf](https://example.com/missing.pdf) \\@missing **ordinary**", true);
        lib.skill("b", "b.md", "B", true);
        for name in ["one.md", "two.markdown", "space name.txt", "parens(x).txt"] {
            lib.document(&format!("docs/{name}"), "reference");
        }
        let result = lib.analyze("@a", "");
        assert!(
            result.report.issues.is_empty(),
            "{}",
            serde_json::to_string(&result.report).unwrap()
        );
        assert_eq!(result.loaded.len(), 6);
        assert_eq!(result.report.edges[0].reference, "@b");
        assert_eq!(result.report.edges[1].reference, "docs/one.md");
        assert_eq!(
            result
                .report
                .nodes
                .iter()
                .filter(|node| node.kind == "document")
                .count(),
            4
        );
    }

    #[test]
    fn nested_mentions_follow_rendered_emphasis_and_preserve_escapes_and_code() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "😀 Use @plain, &#64;bold then **@bold**, \\@italic then *@italic*, then _@underscore_. @**mixed** @al&#105;as &#32;@after\n\nfoo**@within** **prefix@within** **word**@within word<span>@within</span> `sample`@within ![alt](https://example.com/ignored.png)@within\n\n\\@escaped `@inline` ![image @image](https://example.com/ignored.png)\n\n```markdown\n@fenced\n```\n\n    @indented\n", true);
        for name in [
            "plain",
            "bold",
            "italic",
            "underscore",
            "mixed",
            "alias",
            "after",
            "within",
            "escaped",
            "inline",
            "image",
            "fenced",
            "indented",
        ] {
            lib.skill(name, &format!("{name}.md"), name, true);
        }
        let result = lib.analyze("@a", "");
        assert!(result.report.issues.is_empty());
        assert_eq!(result.loaded.len(), 8);
        assert_eq!(
            result
                .report
                .edges
                .iter()
                .map(|edge| edge.reference.as_str())
                .collect::<Vec<_>>(),
            vec![
                "@plain",
                "@bold",
                "@italic",
                "@underscore",
                "@mixed",
                "@alias",
                "@after"
            ]
        );
    }

    #[test]
    fn rendered_breaks_entities_link_labels_and_utf8_preserve_reference_order() {
        let as_strings = |text: &str| {
            references(text)
                .into_iter()
                .map(|reference| match reference {
                    Reference::Skill(name) => format!("@{name}"),
                    Reference::Document(path) => path,
                    Reference::Image(path) => format!("image:{path}"),
                })
                .collect::<Vec<_>>()
        };
        for text in [
            "\\* @b",
            "Tom &amp; @b",
            "&#64;b then @b",
            "\\@b then @b",
            "&#32;**@b**",
        ] {
            assert_eq!(as_strings(text), vec!["@b"], "{text}");
        }
        for text in ["@b\n@c", "@b  \n@c", "# @b\n\n- @c"] {
            assert_eq!(as_strings(text), vec!["@b", "@c"], "{text}");
        }
        assert_eq!(
            as_strings("😀 **@b** then [d](docs/x.txt) then _@c_"),
            vec!["@b", "docs/x.txt", "@c"]
        );
        assert_eq!(
            as_strings("[**@b**][doc]\n\n[doc]: docs/x.txt"),
            vec!["docs/x.txt", "@b"]
        );
        assert_eq!(
            as_strings("&#64;b \\@b `@b`\n\n```md\n@b\n```\n\n![alt @b](image.png)"),
            vec!["image:image.png"]
        );
        assert_eq!(
            as_strings("foo**@b** **word**@b word<span>@b</span> `word`@b ![alt](image.png)@b"),
            vec!["image:image.png"]
        );
    }

    #[test]
    fn inline_code_cannot_supply_a_nested_invocation_name() {
        for text in ["Use @`b`", "Use @b`eta`", "Use @be`ta`", "Use @`b`eta"] {
            assert!(
                references(text)
                    .iter()
                    .all(|reference| !matches!(reference, Reference::Skill(_))),
                "inline code manufactured a nested invocation: {text}"
            );
        }
        for text in ["Use @b`.`", "Use @b` `"] {
            assert!(
                matches!(references(text).as_slice(), [Reference::Skill(name)] if name == "b"),
                "{text}"
            );
        }
        for text in ["Use @b`/x`", "Use @b`_`", "Use @b`.x`"] {
            assert!(
                references(text)
                    .iter()
                    .all(|reference| !matches!(reference, Reference::Skill(_))),
                "{text}"
            );
        }
    }

    #[test]
    fn skill_frontmatter_metadata_does_not_invoke_nested_dependencies() {
        let mut lib = Library::new();
        for newline in ["\n", "\r\n"] {
            let content = "---\nname: a\ndescription: Use when the user asks about @example or [a report](missing.txt)\n---\n\nActual instructions.\n".replace('\n', newline);
            if lib.configs.is_empty() {
                lib.skill("a", "package/SKILL.md", &content, true);
            } else {
                lib.document("package/SKILL.md", &content);
            }
            let result = lib.analyze("@a", "");
            assert!(
                result.report.issues.is_empty(),
                "frontmatter became dependencies: {}",
                serde_json::to_string(&result.report).unwrap()
            );
            assert!(result.report.edges.is_empty());
            assert_eq!(result.loaded[0].instructions, content);
            assert_eq!(
                result.report.nodes[0].character_count,
                content.chars().count()
            );
            assert_eq!(
                result.report.nodes[0].content_hash,
                Some(format!("{:x}", Sha256::digest(content.as_bytes())))
            );
        }
        // A referenced document is not a skill; its text remains discoverable
        // even when it happens to start with a YAML-looking example.
        lib.skill("b", "b.md", "B instructions", true);
        lib.document(
            "docs/guide.txt",
            "---\ndescription: Use @b\n---\n\nReference text.",
        );
        lib.document(
            "package/SKILL.md",
            "---\ndescription: Use @example\n---\n\n[Guide](../docs/guide.txt)",
        );
        let result = lib.analyze("@a", "");
        assert!(result.report.issues.is_empty());
        assert_eq!(result.loaded.len(), 3);
        assert_eq!(
            result
                .report
                .edges
                .iter()
                .map(|edge| edge.reference.as_str())
                .collect::<Vec<_>>(),
            vec!["../docs/guide.txt", "@b"]
        );
    }

    #[test]
    fn mixed_frontmatter_line_endings_keep_metadata_out_of_dependencies() {
        let mut lib = Library::new();
        let body = "Actual instructions.\r\n\n---\nKeep this body separator.\n";
        for (opening, middle, closing) in [
            ("\n", "\n", "\n"),
            ("\r\n", "\r\n", "\r\n"),
            ("\n", "\r\n", "\n"),
            ("\r\n", "\n", "\r\n"),
            ("\n", "\n", "\r\n"),
            ("\r\n", "\r\n", "\n"),
        ] {
            let content = format!("---{opening}description: Use @example or [metadata](missing.txt){middle}---{closing}{body}");
            if lib.configs.is_empty() {
                lib.skill("a", "package/SKILL.md", &content, true);
            } else {
                lib.document("package/SKILL.md", &content);
            }
            let result = lib.analyze("@a", "");
            assert!(
                result.report.issues.is_empty(),
                "{}",
                serde_json::to_string(&result.report).unwrap()
            );
            assert!(result.report.edges.is_empty());
            assert_eq!(result.loaded[0].instructions, content);
            assert_eq!(
                result.report.nodes[0].character_count,
                content.chars().count()
            );
            assert_eq!(
                result.report.nodes[0].content_hash,
                Some(format!("{:x}", Sha256::digest(content.as_bytes())))
            );

            lib.document(
                "package/SKILL.md",
                format!("{content}\nUse @unknown in the body."),
            );
            let blocked = lib.analyze("@a", "");
            assert!(has_issue(&blocked, "unknown-skill"));
            assert_eq!(blocked.report.issues[0].chain, vec!["@a", "@unknown"]);
        }
    }

    #[test]
    fn nested_chains_aliases_relative_links_and_authored_only_roots() {
        let mut lib = Library::new();
        lib.skill(
            "alias",
            "package/SKILL.md",
            "Use @helper. [Read](../docs/one.txt)",
            true,
        );
        lib.skill("helper", "helper.md", "Helper", true);
        lib.document("docs/one.txt", "[Next](two.md)");
        lib.document("docs/two.md", "Nested contents");
        let result = lib.analyze("@alias [ordinary](unrelated.md)", "");
        assert!(result.report.issues.is_empty());
        assert_eq!(result.loaded.len(), 4);
        assert_eq!(result.report.roots.len(), 1);
        assert_eq!(result.report.roots[0].name, "alias");
        assert!(result
            .report
            .nodes
            .iter()
            .any(|node| node.depth == 2 && node.path.ends_with("two.md")));
    }

    #[test]
    fn shared_files_and_aliases_have_one_identity_and_system_reachability_owns_them() {
        let mut lib = Library::new();
        lib.skill(
            "system",
            "system.md",
            "Use @shared. [Guide](docs/guide.txt)",
            true,
        );
        let shared = lib.skill("shared", "shared.md", "[Guide](docs/guide.txt)", true);
        lib.configs.push(SkillBridgeConfig {
            name: "second-alias".into(),
            source_path: shared.to_string_lossy().into_owned(),
            enabled: true,
        });
        lib.document("docs/guide.txt", "Reference");
        let result = lib.analyze("@shared @second-alias", "@system");
        assert!(result.report.issues.is_empty());
        assert_eq!(result.loaded.len(), 3);
        assert_eq!(result.report.roots.len(), 3);
        assert!(result.loaded.iter().all(|loaded| loaded.system));
        assert_eq!(
            result.report.roots[1].node_id,
            result.report.roots[2].node_id
        );
        assert_eq!(result.report.edges.len(), 3);
    }

    #[test]
    fn cycles_are_fatal_but_shared_dags_are_allowed_including_separate_roots() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "Use @b", true);
        lib.skill("b", "b.md", "Use @a", true);
        assert!(has_issue(&lib.analyze("@a @b", ""), "cycle"));
        lib.document("b.md", "[Shared](docs/shared.txt)");
        lib.document("docs/shared.txt", "Shared");
        lib.document("a.md", "Use @b. [Shared](docs/shared.txt)");
        let dag = lib.analyze("@a @b", "");
        assert!(dag.report.issues.is_empty());
        assert_eq!(dag.loaded.len(), 3);
    }

    #[test]
    fn shortest_root_distance_is_order_independent_and_four_hops_are_allowed() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "[One](docs/1.txt)", true);
        for index in 1..=4 {
            lib.document(
                &format!("docs/{index}.txt"),
                if index == 4 {
                    "end".into()
                } else {
                    format!("[Next]({}.txt)", index + 1)
                },
            );
        }
        assert!(lib.analyze("@a", "").report.issues.is_empty());
        lib.document("docs/4.txt", "[Next](5.txt)");
        lib.document("docs/5.txt", "end");
        assert!(has_issue(&lib.analyze("@a", ""), "depth-limit"));
        lib.skill("short", "short.md", "[End](docs/5.txt)", true);
        for roots in ["@a @short", "@short @a"] {
            let result = lib.analyze(roots, "");
            assert!(result.report.issues.is_empty());
            assert_eq!(result.loaded.len(), 7);
        }
    }

    #[test]
    fn enabled_skill_count_and_unique_file_limits_enforce_exact_boundaries() {
        let mut lib = Library::new();
        for index in 0..=MAX_SKILLS {
            lib.skill(&format!("s{index}"), &format!("s{index}.md"), "x", true);
        }
        let eight = (0..MAX_SKILLS)
            .map(|index| format!("@s{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(lib.analyze(&eight, &eight).report.issues.is_empty());
        assert!(has_issue(
            &lib.analyze(&format!("{eight} @s8"), ""),
            "skill-limit"
        ));
        let mut refs = String::new();
        for index in 0..MAX_FILES {
            lib.document(&format!("docs/{index}.txt"), "x");
            if index < MAX_FILES - 1 {
                refs.push_str(&format!("[d](docs/{index}.txt)\n"));
            }
        }
        lib.document("s0.md", &refs);
        assert_eq!(lib.analyze("@s0", "").loaded.len(), MAX_FILES);
        refs.push_str("[extra](docs/23.txt)");
        lib.document("s0.md", &refs);
        assert!(has_issue(&lib.analyze("@s0", ""), "file-limit"));
    }

    #[test]
    fn unicode_character_budget_and_file_byte_limit_are_independent() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", &"é".repeat(MAX_CHARACTERS), true);
        assert!(lib.analyze("@a", "").report.issues.is_empty());
        lib.document("a.md", "é".repeat(MAX_CHARACTERS + 1));
        assert!(has_issue(&lib.analyze("@a", ""), "character-limit"));
        lib.document("a.md", "x".repeat(MAX_FILE_BYTES as usize));
        assert!(has_issue(&lib.analyze("@a", ""), "character-limit"));
        assert!(!has_issue(&lib.analyze("@a", ""), "file-size-limit"));
        lib.document("a.md", "x".repeat(MAX_FILE_BYTES as usize + 1));
        assert!(has_issue(&lib.analyze("@a", ""), "file-size-limit"));
    }

    #[test]
    fn unknown_disabled_links_missing_and_invalid_utf8_keep_full_chains() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "[Read](docs/read.txt)", true);
        lib.skill("disabled", "disabled.md", "do not expose", false);
        for (content, code) in [
            ("Use @unknown", "unknown-skill"),
            ("Use @disabled", "disabled-skill"),
            ("[d](../disabled.md)", "disabled-skill"),
            ("[missing](no.md)", "missing-file"),
            ("[bad](bad%ZZ.md)", "malformed-link"),
        ] {
            lib.document("docs/read.txt", content);
            let result = lib.analyze("@a", "");
            assert!(has_issue(&result, code), "{code}");
            let issue = result
                .report
                .issues
                .iter()
                .find(|issue| issue.code == code)
                .unwrap();
            assert_eq!(issue.chain[0], "@a");
            assert_eq!(issue.chain[1], "docs/read.txt");
            assert!(issue.chain.len() >= 3);
        }
        lib.document("docs/read.txt", [0xff]);
        assert!(has_issue(&lib.analyze("@a", ""), "invalid-utf8"));
    }

    #[test]
    fn changes_on_disk_are_reloaded_and_preview_is_known_bounded_and_unsaved() {
        let mut lib = Library::new();
        let path = lib.skill("a", "a.md", "saved", false);
        lib.document("docs/x.txt", "reference");
        let preview = analyze(
            &lib.root,
            "",
            "",
            None,
            lib.configs.clone(),
            Some(&path.to_string_lossy()),
            Some("[d](docs/x.txt)"),
        );
        assert!(has_issue(&preview, "disabled-skill"));
        assert_eq!(preview.loaded.len(), 2);
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved");
        assert_eq!(lib.analyze("@a", "").loaded.len(), 0);
        let invalid = analyze(
            &lib.root,
            "",
            "",
            None,
            lib.configs.clone(),
            Some("/unknown.md"),
            Some("x"),
        );
        assert!(has_issue(&invalid, "invalid-preview"));
        let oversized = analyze(
            &lib.root,
            "",
            "",
            None,
            lib.configs.clone(),
            Some(&path.to_string_lossy()),
            Some(&"x".repeat(MAX_FILE_BYTES as usize + 1)),
        );
        assert!(has_issue(&oversized, "invalid-preview"));
        lib.configs[0].enabled = true;
        let first = lib.analyze("@a", "").report.nodes[0].content_hash.clone();
        lib.document("a.md", "changed");
        let second = lib.analyze("@a", "").report.nodes[0].content_hash.clone();
        assert_ne!(first, second);
    }

    #[test]
    fn graph_and_unknown_names_stay_bounded_under_adversarial_references() {
        let mut lib = Library::new();
        lib.skill(
            "a",
            "a.md",
            &(0..1_000)
                .map(|index| format!("[d](missing{index}.txt)\n"))
                .collect::<String>(),
            true,
        );
        let result = lib.analyze("@a", "");
        assert!(has_issue(&result, "reference-limit"));
        assert!(result.report.nodes.len() <= MAX_REFERENCES + MAX_ROOTS);
        assert!(result.report.edges.len() <= MAX_REFERENCES + 1);
        assert!(result.report.issues.len() <= MAX_ISSUES);
        assert!(serde_json::to_vec(&result.report).unwrap().len() <= 480_000);
        lib.document(
            "a.md",
            (0..1_000)
                .map(|index| format!("@unknown{index} "))
                .collect::<String>(),
        );
        assert!(has_issue(&lib.analyze("@a", ""), "reference-limit"));
        let roots = (0..100_000)
            .map(|index| format!("@unknown{index} "))
            .collect::<String>();
        let unknown = lib.analyze(&roots, "");
        assert!(unknown.report.issues.is_empty());
        assert!(unknown.report.roots.is_empty());
        let late_known = lib.analyze(&format!("{roots} @a"), "");
        assert_eq!(late_known.report.roots.len(), 1);
    }

    #[test]
    fn forged_deep_skill_is_rejected_at_scanner_depth_boundary() {
        let mut lib = Library::new();
        let path = format!(
            "{}SKILL.md",
            "dir/".repeat(super::super::MAX_SKILL_SCAN_DEPTH + 1)
        );
        lib.skill("deep", &path, "x", true);
        assert!(has_issue(&lib.analyze("@deep", ""), "outside-folder"));
    }

    #[test]
    fn hidden_documents_are_blocked_consistently_with_runtime_mirrors() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "[Private](.hidden/secret.txt)", true);
        lib.document(".hidden/secret.txt", "must not be loaded");
        let result = lib.analyze("@a", "");
        assert!(has_issue(&result, "unsupported-document"));
        assert_eq!(result.loaded.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn internal_symlink_documents_are_blocked_consistently_with_runtime_mirrors() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "[Alias](alias.txt)", true);
        lib.document("docs/real.txt", "private instructions");
        std::os::unix::fs::symlink(lib.root.join("docs/real.txt"), lib.root.join("alias.txt")).unwrap();
        assert!(has_issue(&lib.analyze("@a", ""), "unsupported-document"));
    }

    #[test]
    fn removed_or_unconfigured_physical_skill_cannot_be_loaded_as_a_document() {
        let mut lib = Library::new();
        lib.skill("a", "a.md", "[Removed](removed.md)", true);
        lib.document("removed.md", "do not load");
        assert!(has_issue(&lib.analyze("@a", ""), "unavailable-skill"));
        lib.document("package/SKILL.md", "do not load");
        lib.document("a.md", "[Removed](package/SKILL.md)");
        assert!(has_issue(&lib.analyze("@a", ""), "unavailable-skill"));
    }

    #[test]
    fn actual_native_report_contract_fixtures() {
        let mut lib = Library::new();
        let a = lib.skill("a", "a.md", "Use @b. [Doc](docs/x.txt)", true);
        lib.skill("b", "b.md", "B", true);
        lib.document("docs/x.txt", "Doc");
        lib.configs.push(SkillBridgeConfig {
            name: "alias".into(),
            source_path: a.to_string_lossy().into_owned(),
            enabled: true,
        });
        let mut reports = vec![(
            "aliases-and-channels",
            lib.analyze("@a @alias", "@b").report,
        )];
        lib.document("a.md", "\\@b then **@b**. [Doc](docs/x.txt)");
        reports.push(("formatted-nested-alias", lib.analyze("@a", "").report));
        for (label, content) in [
            ("unknown", "Use @unknown".into()),
            ("missing", "[d](docs/missing.txt)".into()),
            ("unsupported-document", "[d](docs/report.pdf)".into()),
            ("long-reference", format!("[d]({}.md)", "x".repeat(5_000))),
            ("controls", "[d](docs/%00%0A.txt)".into()),
        ] {
            lib.document("a.md", content);
            reports.push((label, lib.analyze("@a", "").report));
        }
        lib.document("a.md", "[d](removed.md)");
        lib.document("removed.md", "removed");
        reports.push(("removed", lib.analyze("@a", "").report));
        lib.document("a.md", "[d](docs/0.txt)");
        for index in 0..5 {
            lib.document(
                &format!("docs/{index}.txt"),
                format!("[d]({}.txt)", index + 1),
            );
        }
        lib.document("docs/5.txt", "end");
        reports.push(("depth", lib.analyze("@a", "").report));
        for config in &mut lib.configs {
            if Path::new(&config.source_path) == a {
                config.enabled = false;
            }
        }
        reports.push((
            "disabled-preview",
            analyze(
                &lib.root,
                "",
                "",
                None,
                lib.configs.clone(),
                Some(&a.to_string_lossy()),
                Some("[d](docs/x.txt)"),
            )
            .report,
        ));
        reports.push((
            "invalid-preview",
            analyze(
                &lib.root,
                "",
                "",
                None,
                lib.configs.clone(),
                Some("/missing.md"),
                Some("x"),
            )
            .report,
        ));
        lib.configs[0].enabled = true;
        reports.push((
            "invalid-folder",
            analyze(
                Path::new("/not-a-real-folder"),
                "@a",
                "",
                None,
                lib.configs.clone(),
                None,
                None,
            )
            .report,
        ));
        lib.document(
            "a.md",
            (0..128)
                .map(|_| format!("[d]({}.txt)\n", "x".repeat(700)))
                .collect::<String>(),
        );
        reports.push(("repeated-missing-reference", lib.analyze("@a", "").report));
        let bytes = serde_json::to_vec(&reports).unwrap();
        if let Ok(path) = std::env::var("MYTHRA_NATIVE_REPORT_FIXTURES") {
            fs::write(path, bytes).unwrap();
        }
        for (_, report) in reports {
            assert!(serde_json::to_vec(&report).unwrap().len() <= 480_000);
            assert!(report
                .nodes
                .iter()
                .all(|node| node.name.len() <= 4096 && node.path.len() <= 4096));
            assert!(report.edges.iter().all(|edge| edge.reference.len() <= 4096));
            assert!(report
                .issues
                .iter()
                .all(|issue| issue.chain.iter().all(|part| part.len() <= 4096)));
        }
    }

    #[cfg(unix)]
    #[test]
    fn bounded_skill_read_keeps_contents_and_permissions_from_one_opened_source() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let lib = Library::new();
        let path = lib.document("private.txt", "Original private contents");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let source = path.canonicalize().unwrap();
        let (contents, metadata) =
            read_bounded_with_metadata(&lib.root.canonicalize().unwrap(), &source).unwrap();
        let replacement = lib.document("replacement.txt", "New public contents");
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o644)).unwrap();
        fs::rename(replacement, &path).unwrap();
        assert_eq!(contents, "Original private contents");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let named = fs::metadata(&path).unwrap();
        assert_eq!(named.permissions().mode() & 0o777, 0o644);
        assert_ne!(metadata.ino(), named.ino());
    }

    #[cfg(unix)]
    #[test]
    fn path_escape_and_symlink_escape_are_blocked_and_fifo_reads_do_not_block() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;
        let mut lib = Library::new();
        let outside = Library::new();
        outside.document("secret.txt", "secret");
        lib.skill(
            "a",
            "a.md",
            &format!("[d]({})", outside.root.join("secret.txt").display()),
            true,
        );
        assert!(has_issue(&lib.analyze("@a", ""), "malformed-link"));
        symlink(outside.root.join("secret.txt"), lib.root.join("escape.txt")).unwrap();
        lib.document("a.md", "[d](escape.txt)");
        assert!(has_issue(&lib.analyze("@a", ""), "outside-folder"));
        assert!(read_bounded(
            &lib.root.canonicalize().unwrap(),
            &lib.root.join("escape.txt")
        )
        .is_err());
        let fifo = lib.root.join("fifo.txt");
        let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(read_bounded(&lib.root.canonicalize().unwrap(), &fifo).is_err());
        lib.document("a.md", "[d](../escape.txt)");
        assert!(has_issue(&lib.analyze("@a", ""), "missing-file"));
    }
}
