import type { JsonObject } from "./codex";
import type { PendingApproval } from "../types";

/**
 * Approval answers, built only from what each provider's request offers and
 * mapped onto that provider's wire format. Fails closed: an option whose
 * meaning is not known exactly is never offered, and nothing is substituted
 * (a "session" button never quietly sends an "always" option, and so on).
 * A wider grant is offered only when its whole scope (what it covers, how long
 * it lasts, where it is saved) can be shown exactly before consent.
 */
type ChoiceKind = "deny" | "once" | "broader" | "denyBroader";

/** One exact fact about what a wider grant covers. Values are never shortened. */
export interface GrantScopeRow {
  label: string;
  value: string;
  mono?: boolean;
  /** A part of the request this grant does not cover. */
  excluded?: boolean;
}

/** One answer the provider actually offered, already in its wire format. */
export interface ApprovalChoice {
  id: string;
  kind: ChoiceKind;
  label: string;
  /** One-sentence summary of what a broader grant covers and for how long. */
  detail?: string;
  /** Exact structured scope: covers, lasts, saved to. */
  scope?: GrantScopeRow[];
  /** The exact rule or access object the provider will save, untruncated. */
  exact?: string;
  /**
   * When set, the grant needs a second, explicit confirmation; the text says
   * why (compound or destructive command).
   */
  confirm?: string;
  /** Label of the second-step confirm button. */
  confirmLabel?: string;
  response: JsonObject;
}

export interface CommandRisk {
  /** The separate commands a shell line runs, in order. */
  segments: string[];
  /** More than one command, or a nested command substitution. */
  compound: boolean;
  /** Short names of destructive patterns found, e.g. "rm -rf". */
  destructive: string[];
}

export interface ApprovalPlan {
  choices: ApprovalChoice[];
  /** Said when the request offered something Mythra Code cannot map safely. */
  note?: string;
  /** Set when the command is compound or matches a destructive pattern. */
  risk?: CommandRisk;
}

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const quoted = (value: string) => `“${value}”`;
const shorten = (value: string, max = 60) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

// ---------------------------------------------------------------- commands ----

/** Shell words, honouring single/double quotes and backslash escapes. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) { word += line[index + 1]; index += 1; }
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "\\" && index + 1 < line.length) { word += line[index + 1]; index += 1; started = true; continue; }
    if (/\s/.test(char)) { if (started) { words.push(word); word = ""; started = false; } continue; }
    word += char;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/**
 * Splits a shell line on the operators that start another command
 * (`&&`, `||`, `;`, `|`, `&`, newlines), outside quotes. `bash -c "…"` and
 * `sh -lc '…'` wrappers are unwrapped first.
 */
export function commandSegments(command: string): { segments: string[]; nested: boolean } {
  const trimmed = command.trim();
  const words = shellWords(trimmed);
  if (words.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh$/.test(words[0]) && /^-[a-z]*c$/.test(words[1])) {
    return commandSegments(words[2]);
  }
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let nested = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && (char === "`" || (char === "$" && next === "("))) nested = true;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === "\\" && next !== undefined) { current += char + next; index += 1; continue; }
    if (char === "`" || (char === "$" && next === "(")) nested = true;
    const two = char + (next ?? "");
    if (two === "&&" || two === "||") { segments.push(current); current = ""; index += 1; continue; }
    // `2>&1` and `>&2` are redirections, not a background operator.
    if (char === "&" && (trimmed[index - 1] === ">" || trimmed[index - 1] === "<" || next === ">")) { current += char; continue; }
    if (char === ";" || char === "|" || char === "&" || char === "\n") { segments.push(current); current = ""; continue; }
    current += char;
  }
  segments.push(current);
  return { segments: segments.map((segment) => segment.trim()).filter(Boolean), nested };
}

/** Destructive patterns, each tested on one command segment's words. */
const DESTRUCTIVE: Array<{ name: string; test: (words: string[], segment: string) => boolean }> = [
  { name: "rm -rf", test: (w) => w[0] === "rm" && w.slice(1).some((arg) => /^-[a-zA-Z]*[rRf]/.test(arg) || arg === "--recursive" || arg === "--force") },
  { name: "git push --force", test: (w) => w[0] === "git" && w.includes("push") && w.some((arg) => arg === "-f" || arg.startsWith("--force") || /^\+[^\s]/.test(arg)) },
  { name: "git reset --hard", test: (w) => w[0] === "git" && w.includes("reset") && w.includes("--hard") },
  { name: "git clean", test: (w) => w[0] === "git" && w.includes("clean") && w.some((arg) => /^-[a-zA-Z]*f/.test(arg) || arg === "--force") },
  { name: "git checkout --", test: (w) => w[0] === "git" && w[1] === "checkout" && (w.includes("--") || w.includes(".")) },
  { name: "git restore", test: (w) => w[0] === "git" && w[1] === "restore" && !w.includes("--staged") },
  { name: "git branch -D", test: (w) => w[0] === "git" && w[1] === "branch" && w.some((arg) => arg === "-D" || (arg === "--delete" && w.includes("--force"))) },
  { name: "git stash drop", test: (w) => w[0] === "git" && w[1] === "stash" && (w[2] === "drop" || w[2] === "clear") },
  { name: "sudo", test: (w) => w[0] === "sudo" || w[0] === "doas" },
  { name: "chmod/chown -R", test: (w) => (w[0] === "chmod" || w[0] === "chown") && w.some((arg) => /^-[a-zA-Z]*R/.test(arg) || arg === "--recursive") },
  { name: "find -delete", test: (w) => w[0] === "find" && (w.includes("-delete") || (w.includes("-exec") && w.includes("rm"))) },
  { name: "dd", test: (w) => w[0] === "dd" && w.some((arg) => arg.startsWith("of=")) },
  { name: "mkfs", test: (w) => /^mkfs(\.|$)/.test(w[0] ?? "") },
  { name: "shred", test: (w) => w[0] === "shred" },
  { name: "kill processes", test: (w) => w[0] === "pkill" || w[0] === "killall" || (w[0] === "kill" && w.includes("-9")) },
  { name: "DROP TABLE", test: (_w, segment) => /\bdrop\s+(?:table|database|schema)\b/i.test(segment) || /\btruncate\s+table\b/i.test(segment) },
];

/** Leading `VAR=value` assignments and `env`/`time`/`nohup` wrappers don't change what runs. */
function commandWords(segment: string): string[] {
  const words = shellWords(segment);
  while (words.length > 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === "env" || words[0] === "time" || words[0] === "nohup" || words[0] === "command")) words.shift();
  return words;
}

/** How risky a shell line is: several commands, or a destructive pattern. */
export function commandRisk(command: string): CommandRisk {
  const { segments, nested } = commandSegments(command);
  const destructive: string[] = [];
  for (const segment of segments) {
    const words = commandWords(segment);
    for (const pattern of DESTRUCTIVE) {
      if (!destructive.includes(pattern.name) && pattern.test(words, segment)) destructive.push(pattern.name);
    }
  }
  if (!destructive.includes("download piped to a shell") && /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/.test(command)) destructive.push("download piped to a shell");
  return { segments, compound: segments.length > 1 || nested, destructive };
}

/** Plain sentence for a risky command, or "" when there is nothing to flag. */
export function riskSummary(risk: CommandRisk | undefined): string {
  if (!risk || (!risk.compound && !risk.destructive.length)) return "";
  const parts: string[] = [];
  if (risk.destructive.length) parts.push(`it can delete or overwrite work (${risk.destructive.join(", ")})`);
  if (risk.compound) parts.push(risk.segments.length > 1 ? `it runs ${risk.segments.length} commands in one line` : "it runs a nested command");
  return `Check this command carefully: ${parts.join(", and ")}.`;
}

/** True when `prefix` words start the segment's words (after env wrappers). */
function prefixCovers(prefix: string[], segment: string): boolean {
  const words = commandWords(segment);
  return prefix.length > 0 && prefix.every((word, index) => words[index] === word);
}

/** The segments a prefix rule does not cover. */
export function uncoveredSegments(prefix: string[], command: string): string[] {
  return commandSegments(command).segments.filter((segment) => !prefixCovers(prefix, segment));
}

function confirmText(risk: CommandRisk, grant: string): string {
  const why = risk.destructive.length
    ? `This command can delete or overwrite work (${risk.destructive.join(", ")})${risk.compound ? " and runs several commands" : ""}.`
    : "This command runs several commands in one line.";
  return `${why} ${grant}`;
}

const commandText = (value: unknown) => Array.isArray(value) ? value.map(String).join(" ") : typeof value === "string" ? value : "";

// ------------------------------------------------------------------- Codex ----

/**
 * Codex decision lists: the request's own `availableDecisions` when it sends
 * them, otherwise the fixed set its protocol documents for the method. Only
 * decisions with a known meaning become buttons; anything else is dropped.
 */
function codexChoices(approval: PendingApproval, file: boolean, legacy: boolean): ApprovalPlan {
  const params = approval.params;
  const offered: unknown[] = !legacy && Array.isArray(params.availableDecisions)
    ? params.availableDecisions as unknown[]
    : ["accept", "acceptForSession", "decline"];
  const wire = (value: string): JsonObject => legacy
    ? { decision: value === "accept" ? "approved" : value === "acceptForSession" ? "approved_for_session" : value === "cancel" ? "abort" : "denied" }
    : { decision: value };
  const grantRoot = typeof params.grantRoot === "string" && params.grantRoot.trim() ? params.grantRoot.trim() : "";
  const command = file ? "" : commandText(params.command).trim();
  const risk = command ? commandRisk(command) : undefined;
  const risky = Boolean(risk && (risk.compound || risk.destructive.length));
  const choices: ApprovalChoice[] = [];
  let dropped = false;
  for (const option of offered) {
    if (option === "decline") choices.push({ id: "decline", kind: "deny", label: "Deny", response: wire("decline") });
    else if (option === "accept") choices.push({ id: "accept", kind: "once", label: "Allow once", response: wire("accept") });
    else if (option === "acceptForSession") {
      if (!file && !command) { dropped = true; continue; }
      const scope: GrantScopeRow[] = file
        ? [{ label: "Covers", value: "Changes to the files in this request" },
          ...(grantRoot ? [{ label: "Also", value: `Writing anywhere in ${grantRoot}`, mono: false }] : []),
          { label: "Lasts", value: "Until this Codex CLI session ends" },
          { label: "Saved", value: "Not saved; the Codex CLI forgets it when the session ends" }]
        : [{ label: "Covers", value: command, mono: true },
          { label: "Lasts", value: "Until this Codex CLI session ends" },
          { label: "Saved", value: "Not saved; the Codex CLI forgets it when the session ends" }];
      choices.push({
        id: "acceptForSession",
        kind: "broader",
        label: file ? "Allow these files for the session" : "Allow this command for the session",
        detail: file
          ? `The Codex CLI won’t ask again before changing these files until this session ends.${grantRoot ? ` It may also write anywhere in ${grantRoot}.` : ""}`
          : "The Codex CLI won’t ask again before running this exact command until this session ends.",
        scope,
        ...(risky && risk ? { confirm: confirmText(risk, "The Codex CLI won’t ask again before running it until this session ends."), confirmLabel: "Yes, allow for the session" } : {}),
        response: wire("acceptForSession"),
      });
    } else if (!legacy && isObject(option) && isObject(option.acceptWithExecpolicyAmendment)) {
      const amendment = option.acceptWithExecpolicyAmendment.execpolicy_amendment;
      const prefixWords = Array.isArray(amendment) && amendment.length && amendment.every((part) => typeof part === "string" && part.length > 0) ? amendment as string[] : [];
      const extra = Object.keys(option.acceptWithExecpolicyAmendment).some((key) => key !== "execpolicy_amendment") || Object.keys(option).length !== 1;
      if (!prefixWords.length || extra || !command) { dropped = true; continue; }
      const prefix = prefixWords.join(" ");
      const uncovered = uncoveredSegments(prefixWords, command);
      const scope: GrantScopeRow[] = [
        { label: "Runs now", value: command, mono: true },
        { label: "Rule allows", value: `Commands starting with ${quoted(prefix)}` },
        ...uncovered.map((segment) => ({ label: "Not covered", value: `${segment} (still asks)`, excluded: true })),
        { label: "Lasts", value: "Until you remove the rule, in later sessions too" },
        { label: "Saved to", value: "The Codex CLI’s own command rules on this computer" },
      ];
      const detail = uncovered.length
        ? `Saves a Codex CLI rule for commands starting with ${quoted(prefix)} only. This command also runs ${uncovered.map((segment) => quoted(shorten(segment))).join(" and ")}, which the rule doesn’t cover, so the Codex CLI will still ask before running ${uncovered.length === 1 ? "it" : "them"} later.`
        : `Saves a Codex CLI rule, so commands starting with ${quoted(prefix)} run without asking, in later sessions too.`;
      // Echo the provider's own object back unchanged: nothing is rebuilt.
      choices.push({
        id: "execpolicy",
        kind: "broader",
        label: uncovered.length ? `Always allow ${shorten(prefix, 40)} only` : "Always allow commands like this",
        detail,
        scope,
        exact: prefixWords.map((word) => JSON.stringify(word)).join(" "),
        ...(risky && risk ? { confirm: confirmText(risk, `The saved rule lets every command starting with ${quoted(prefix)} run without asking, in later sessions too.`), confirmLabel: "Yes, save the rule" } : {}),
        response: { decision: option as JsonObject },
      });
    } else if (option !== "cancel") dropped = true;
  }
  // "cancel" also stops the run; it only stands in when plain decline is missing.
  if (!choices.some((choice) => choice.kind === "deny") && offered.includes("cancel")) {
    choices.unshift({ id: "cancel", kind: "deny", label: "Deny and stop", response: wire("cancel") });
  }
  return { choices, risk: risky ? risk : undefined, note: dropped ? "This request offered a choice Mythra Code can’t describe exactly, so it isn’t shown." : undefined };
}

// ------------------------------------------------------------------ Claude ----

const CLAUDE_DESTINATIONS: Record<string, { session: boolean; where: string; lasts: string; saved: string }> = {
  session: { session: true, where: "until this Claude Code session ends", lasts: "Until this Claude Code session ends", saved: "Not saved; Claude Code forgets it when the session ends" },
  localSettings: { session: false, where: "saved in this project’s local Claude settings", lasts: "Until you remove it", saved: ".claude/settings.local.json in this project (only on this computer)" },
  projectSettings: { session: false, where: "saved in this project’s shared Claude settings", lasts: "Until you remove it", saved: ".claude/settings.json in this project (shared with everyone who uses the repository)" },
  userSettings: { session: false, where: "saved in your Claude settings for every project", lasts: "Until you remove it", saved: "~/.claude/settings.json (every project on this computer)" },
};

/** Claude's suggested permission updates, described exactly or not offered. */
function claudeBroaderChoice(suggestions: unknown, command: string): Omit<ApprovalChoice, "response"> | null {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
  const parts: string[] = [];
  const scope: GrantScopeRow[] = [];
  let sessionOnly = true;
  const destinations = new Set<string>();
  for (const suggestion of suggestions) {
    if (!isObject(suggestion)) return null;
    const destination = CLAUDE_DESTINATIONS[String(suggestion.destination)];
    if (!destination) return null;
    sessionOnly &&= destination.session;
    destinations.add(String(suggestion.destination));
    if (suggestion.type === "addRules" && suggestion.behavior === "allow" && Array.isArray(suggestion.rules) && suggestion.rules.length) {
      const rules: string[] = [];
      for (const rule of suggestion.rules) {
        if (!isObject(rule) || typeof rule.toolName !== "string" || !rule.toolName) return null;
        const content = typeof rule.ruleContent === "string" && rule.ruleContent ? rule.ruleContent : "";
        rules.push(content ? `${rule.toolName}(${content})` : `every ${rule.toolName} call`);
        scope.push({ label: "Rule", value: content ? `${rule.toolName}(${content})` : `Every ${rule.toolName} call`, mono: Boolean(content) });
        // A Bash prefix rule ("npm test:*") may not cover every part of the command.
        if (rule.toolName === "Bash" && content && command) {
          const prefix = content.endsWith(":*") ? shellWords(content.slice(0, -2)) : null;
          const uncovered = prefix ? uncoveredSegments(prefix, command) : commandSegments(command).segments.filter((segment) => segment !== content);
          for (const segment of uncovered) scope.push({ label: "Not covered", value: `${segment} (still asks)`, excluded: true });
        }
      }
      parts.push(`Allows ${rules.join(", ")}, ${destination.where}.`);
    } else if (suggestion.type === "setMode" && suggestion.mode === "acceptEdits") {
      parts.push(`Accepts file edits without asking, ${destination.where}.`);
      scope.push({ label: "Mode", value: "Accept every file edit without asking" });
    } else if (suggestion.type === "addDirectories" && Array.isArray(suggestion.directories) && suggestion.directories.length
      && suggestion.directories.every((entry) => typeof entry === "string")) {
      parts.push(`Gives access to ${(suggestion.directories as string[]).join(", ")}, ${destination.where}.`);
      for (const directory of suggestion.directories as string[]) scope.push({ label: "Folder", value: directory, mono: true });
    } else return null;
  }
  for (const key of destinations) {
    const destination = CLAUDE_DESTINATIONS[key];
    scope.push({ label: "Lasts", value: destination.lasts }, { label: destination.session ? "Saved" : "Saved to", value: destination.saved, mono: !destination.session });
  }
  return { id: "claude-suggestions", kind: "broader", label: sessionOnly ? "Allow for this session" : "Always allow", detail: parts.join(" "), scope,
    exact: JSON.stringify(suggestions, null, 2) };
}

// ------------------------------------------------------------------ Cursor ----

/** Cursor offers named options; each button maps to exactly one of them. */
function cursorChoices(approval: PendingApproval): ApprovalPlan {
  const options = Array.isArray(approval.params.options) ? approval.params.options as unknown[] : [];
  const find = (kind: string) => options.find((option): option is JsonObject => isObject(option) && option.kind === kind
    && (typeof option.optionId === "string" || typeof option.optionId === "number"));
  const selected = (option: JsonObject): JsonObject => ({ outcome: { outcome: "selected", optionId: option.optionId } });
  const choices: ApprovalChoice[] = [];
  const rejectOnce = find("reject_once");
  // Without a reject option, cancelling the request is still a refusal.
  choices.push(rejectOnce
    ? { id: "reject_once", kind: "deny", label: "Deny", response: selected(rejectOnce) }
    : { id: "cancelled", kind: "deny", label: "Deny", response: { outcome: { outcome: "cancelled" } } });
  const allowOnce = find("allow_once");
  if (allowOnce) choices.push({ id: "allow_once", kind: "once", label: "Allow once", response: selected(allowOnce) });
  const rejectAlways = find("reject_always");
  if (rejectAlways) choices.push({ id: "reject_always", kind: "denyBroader", label: "Always deny",
    detail: "Cursor refuses this kind of action from now on without asking.", response: selected(rejectAlways) });
  const notes: string[] = [];
  // Cursor's "Always allow" doesn't say what it covers, for how long or where
  // it is saved, so it is never offered as a wider grant.
  if (find("allow_always")) notes.push("Cursor also offered “Always allow”, but doesn’t say exactly what it would cover, so it isn’t offered here.");
  const known = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
  if (options.some((option) => !isObject(option) || !known.has(String(option.kind)))) notes.push("Cursor offered a choice Mythra Code can’t describe, so it isn’t shown.");
  return { choices, note: notes.length ? notes.join(" ") : undefined };
}

// ---------------------------------------------------------- extra access ----

/**
 * Every line of a Codex extra-access request, or null when any part of it
 * can't be described exactly (then it is only offered as a refusal).
 */
export function describePermissions(permissions: unknown): GrantScopeRow[] | null {
  if (!isObject(permissions)) return null;
  const rows: GrantScopeRow[] = [];
  for (const key of Object.keys(permissions)) if (key !== "network" && key !== "fileSystem") return null;
  if (permissions.network !== undefined && permissions.network !== null) {
    const network = permissions.network;
    if (!isObject(network) || Object.keys(network).some((key) => key !== "enabled") || (network.enabled !== undefined && typeof network.enabled !== "boolean")) return null;
    if (network.enabled === true) rows.push({ label: "Network", value: "Internet access for commands" });
  }
  if (permissions.fileSystem !== undefined && permissions.fileSystem !== null) {
    const files = permissions.fileSystem;
    if (!isObject(files) || Object.keys(files).some((key) => key !== "read" && key !== "write" && key !== "entries")) return null;
    const list = (value: unknown): string[] | null => value === undefined || value === null ? [] : Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : null;
    const read = list(files.read);
    const write = list(files.write);
    if (!read || !write) return null;
    for (const path of read) rows.push({ label: "Read", value: path, mono: true });
    for (const path of write) rows.push({ label: "Write", value: path, mono: true });
    if (files.entries !== undefined && files.entries !== null) {
      if (!Array.isArray(files.entries)) return null;
      for (const entry of files.entries) {
        if (!isObject(entry) || typeof entry.path !== "string" || !entry.path || Object.keys(entry).some((key) => key !== "path" && key !== "access")) return null;
        if (entry.access !== "read" && entry.access !== "write") return null;
        rows.push({ label: entry.access === "read" ? "Read" : "Write", value: entry.path, mono: true });
      }
    }
  }
  return rows;
}

const EMPTY_PERMISSIONS: JsonObject = { network: { enabled: false }, fileSystem: { read: [], write: [], entries: [] } };

/**
 * The buttons a request may show, built from what its provider offers and
 * mapped onto that provider's wire format. Fails closed: an option whose
 * meaning isn't known exactly is never shown, and nothing is substituted.
 */
export function approvalChoices(approval: PendingApproval): ApprovalPlan {
  const method = approval.method;
  if (method === "openkiwi/subagents/change") {
    return { choices: [
      { id: "decline", kind: "deny", label: "Keep current settings", response: { decision: "decline" } },
      { id: "accept", kind: "once", label: "Apply to project", response: { decision: "accept" } },
    ] };
  }
  if (method === "item/commandExecution/requestApproval") return codexChoices(approval, false, false);
  if (method === "item/fileChange/requestApproval") return codexChoices(approval, true, false);
  if (method === "execCommandApproval") return codexChoices(approval, false, true);
  if (method === "applyPatchApproval") return codexChoices(approval, true, true);
  if (method === "item/permissions/requestApproval") {
    const requested = (approval.params.permissions ?? {}) as JsonObject;
    const deny: ApprovalChoice = { id: "decline", kind: "deny", label: "Deny", response: { permissions: EMPTY_PERMISSIONS, scope: "turn" } };
    const rows = describePermissions(requested);
    if (!rows || !rows.length) {
      return { choices: [deny], note: rows ? "This request doesn’t name any access to grant, so it can only be denied here."
        : "This request asks for access Mythra Code can’t describe exactly, so it can only be denied here." };
    }
    return { choices: [
      deny,
      { id: "turn", kind: "once", label: "Allow for this turn", response: { permissions: requested, scope: "turn" } },
      { id: "session", kind: "broader", label: "Allow for the session", detail: "Keeps this access until the Codex CLI session ends, not just for this turn.",
        scope: [...rows, { label: "Lasts", value: "Until this Codex CLI session ends" }, { label: "Saved", value: "Not saved; the Codex CLI forgets it when the session ends" }],
        exact: JSON.stringify(requested, null, 2),
        response: { permissions: requested, scope: "session" } },
    ] };
  }
  if (method === "claude/can_use_tool") {
    const allow: JsonObject = { behavior: "allow", ...(approval.params.input === undefined ? {} : { updatedInput: approval.params.input }) };
    const suggestions = approval.params.permission_suggestions;
    const input = isObject(approval.params.input) ? approval.params.input : {};
    const command = approval.params.tool_name === "Bash" && typeof input.command === "string" ? input.command.trim() : "";
    const risk = command ? commandRisk(command) : undefined;
    const risky = Boolean(risk && (risk.compound || risk.destructive.length));
    const broader = claudeBroaderChoice(suggestions, command);
    const gated = broader && risky && risk
      ? { ...broader, confirm: confirmText(risk, broader.label === "Always allow" ? "The saved rule lets matching commands run without asking from now on." : "Matching commands run without asking until this session ends."), confirmLabel: broader.label === "Always allow" ? "Yes, save the rule" : "Yes, allow for the session" }
      : broader;
    return { choices: [
      { id: "deny", kind: "deny", label: "Deny", response: { behavior: "deny", message: "The user denied this action." } },
      { id: "allow", kind: "once", label: "Allow once", response: allow },
      ...(gated ? [{ ...gated, response: { ...allow, updatedPermissions: suggestions } as JsonObject }] : []),
    ], risk: risky ? risk : undefined, note: Array.isArray(suggestions) && suggestions.length && !broader
      ? "Claude suggested a wider rule Mythra Code can’t describe exactly, so it isn’t offered here." : undefined };
  }
  if (method === "cursor/request_permission") return cursorChoices(approval);
  // An unrecognized request can always be refused, never granted.
  return { choices: [{ id: "decline", kind: "deny", label: "Deny", response: { decision: "decline" } }],
    note: "Mythra Code doesn’t recognize this request’s choices, so it can only be denied here." };
}

/** The facts a request carries about what it will do and where. */
export function approvalFacts(approval: PendingApproval): Array<{ label: string; value: string; mono?: boolean }> {
  const params = approval.params;
  const facts: Array<{ label: string; value: string; mono?: boolean }> = [];
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  if (approval.method === "claude/can_use_tool") {
    const input = isObject(params.input) ? params.input : {};
    const tool = text(params.display_name) || text(params.tool_name);
    if (tool) facts.push({ label: "Tool", value: tool });
    const file = text(input.file_path) || text(input.path) || text(params.blocked_path);
    if (file && file !== text(input.command)) facts.push({ label: "File", value: file, mono: true });
  }
  if (approval.method === "cursor/request_permission") {
    const tool = isObject(params.toolCall) ? params.toolCall : {};
    const kind = text(tool.kind);
    if (kind) facts.push({ label: "Tool", value: kind.charAt(0).toUpperCase() + kind.slice(1) });
    const locations = Array.isArray(tool.locations) ? tool.locations.map((entry) => isObject(entry) ? text(entry.path) : "").filter(Boolean) : [];
    if (locations.length) facts.push({ label: locations.length === 1 ? "File" : "Files", value: locations.join("\n"), mono: true });
  }
  const cwd = text(params.cwd);
  if (cwd) facts.push({ label: "Folder", value: cwd, mono: true });
  const grantRoot = text(params.grantRoot);
  if (grantRoot) facts.push({ label: "Write access", value: grantRoot, mono: true });
  if (approval.method === "item/permissions/requestApproval") {
    const rows = describePermissions(params.permissions);
    if (rows?.length) facts.push({ label: "Requests", value: rows.map((row) => row.label === "Network" ? "Network access" : `${row.label} ${row.value}`).join("\n") });
    else if (!rows) facts.push({ label: "Requests", value: JSON.stringify(params.permissions ?? null, null, 2), mono: true });
  }
  return facts;
}
