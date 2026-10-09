import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPlan, atomicJson, containedPath, digest, fileHash, HASH, objectHash, processIdentity, readJson, receiptPath, saveReceipt, workerTreeAlive } from './release-state.mjs';

import { sourceUpgradeSchema, validateUpgradeObservation } from './release-upgrade-snapshot.mjs';

import { windowsCleanupContract, provisionWindowsQaProfile, cleanupSuccessfulWindowsQaProfile, validateWindowsCleanupReceipt, verifyWindowsCleanupLive } from './release-windows-qa-cleanup.mjs';

const observations = {
  'native-startup': ['exact-package-identity', 'visible-native-shell', 'affected-startup-replay'],
  'native-close': ['healthy-save-close-reopen', 'affected-close-failure', 'owned-processes-exited'],
  'native-storage': ['representative-existing-data', 'save-close-reopen', 'affected-data-preserved'],
  'native-onboarding': ['fresh-isolated-profile', 'affected-onboarding-flow'],
  'native-installer': ['isolated-installer-environment', 'affected-install-update-recovery'],
};
export function expectedNativeObservations(check) { return [...(observations[check] ?? [])]; }
export function assertQaSourceSupport({ root, plan, execute = execFileSync }) {
  const source = (path) => execute('git', ['show', `${plan.commit}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let module, integration, recipe;
  try { module = source('src-tauri/src/release_qa.rs'); integration = source('src-tauri/src/lib.rs'); recipe = source('docs/operations/native-release-qa.md'); }
  catch { throw new Error('Frozen candidate lacks the supported QA isolation contract; refusing to launch an older package against real user data'); }
  if (!/RELEASE_QA_CONTRACT_VERSION\s*:\s*u32\s*=\s*1\s*;/.test(module) || !module.includes('MYTHRA_RELEASE_QA_ROOT')
    || !/mod\s+release_qa\s*;/.test(integration) || !/release_qa::initialize\s*\(\s*\)/.test(integration)
    || !integration.includes('release_qa::configure_context') || !integration.includes('release_qa::configure_window') || !recipe.trim()) throw new Error('Frozen candidate QA isolation is absent or unsupported; native launch is forbidden');
  let closeFailure;
  if (plan.checks?.some((c) => c.required && c.id.startsWith('native-close:'))) {
    const guard = source('src-tauri/src/close_guard.rs');
    if (!/RELEASE_QA_CLOSE_FAILURE_VERSION\s*:\s*u32\s*=\s*1\s*;/.test(module)
      || !module.includes('close-save-failure-once') || !guard.includes('arm_qa_save_failure')) throw new Error('Selected close failure replay lacks the maintained one-shot QA recipe');
    closeFailure = { version: 1, guardSha256: digest(guard) };
  }
  return { version: 1, ...(closeFailure ? { closeFailure } : {}), moduleSha256: digest(module), integrationSha256: digest(integration), recipePath: 'docs/operations/native-release-qa.md', recipeSha256: digest(recipe) };
}

export function createNativeContract({ root, stateRoot, plan, platform }) {
  assertPlan(plan);
  const sourceCapability = assertQaSourceSupport({ root, plan });
  const build = readJson(receiptPath(stateRoot, `build:${platform}`));
  const audit = readJson(receiptPath(stateRoot, `audit:${platform}`));
  if (!HASH.test(audit.details.executableSha256)) throw new Error('Native integrity audit must identify the packaged executable bytes');
  const selected = plan.checks.filter((c) => c.kind === 'native' && c.required && c.platform === platform);
  if (!selected.length) throw new Error('No native checks are required for this platform');
  const profileId = randomUUID();
  const upgradeCases = plan.predecessors.flatMap((p) => {
    const storageSchema = sourceUpgradeSchema({ root, predecessorCommit: p.commit, candidateCommit: plan.commit });
    return storageSchema ? [{ id: `upgrade:${p.tag}@${p.commit}`, predecessor: { tag: p.tag, commit: p.commit }, recipeSha256: sourceCapability.recipeSha256, storageSchema }] : [];
  });
  const contract = { schemaVersion: 1, planHash: plan.planHash, commit: plan.commit, version: plan.version, platform,
    packagePath: build.details.packagePath, packageSha256: build.details.packageSha256,
    executableSha256: audit.details.executableSha256,
    sourceCapability,
    ...(windowsCleanupContract(platform) ? { windowsCleanup: windowsCleanupContract(platform) } : {}),
    ...(selected.some((c) => c.id.startsWith('native-close:')) ? { closeFailureScenario: {
      schemaVersion: 1, nonce: randomUUID(), kind: 'save-failure-once', cause: 'override-saved-result',
    } } : {}),
    profile: { root: resolve(stateRoot, 'qa-profiles', profileId), profileId, environment: 'MYTHRA_RELEASE_QA_ROOT' },
    releaseScope: { changedFiles: plan.changedFiles, classifications: plan.classifications, boundaryHints: plan.boundaryHints, knownIssues: plan.knownIssues, predecessors: plan.predecessors },
    checks: selected.map((c) => ({ id: c.id, reason: c.reason, observations: observations[c.id.split(':')[0]],
      // Optional historical reuse requires explicit predecessor fixtures. These
      // describe the already-selected case; absence never counts as coverage.
      upgradeCases })),
    scope: { sourceReadOnly: true, noPublish: true, noRealProfile: true, noProviderRequests: true, normalComputerUseReview: true } };
  return { ...contract, contractHash: objectHash(contract) };
}

export function nativePrompt(contract, contractPath, stateRoot) {
  const languagePreferencePaths = ['src-tauri/src/language_tools.rs', 'src/components/LanguageToolsSettings.tsx', 'src/lib/languageTools.ts'];
  const languageStorage = contract.checks.some((c) => c.id.startsWith('native-storage:'))
    && [contract.releaseScope?.changedFiles ?? [], ...(contract.releaseScope?.predecessors ?? []).map((p) => p.changedFiles ?? [])]
      .some((files) => files.some((file) => languagePreferencePaths.includes(file)));
  return `Execute the authorized Mythra Code native release validation contract at ${contractPath}.
The human already authorized this release and bounded native QA. Read the exact contract and frozen repository instructions. Work only on its final package, disposable profile and evidence files under ${stateRoot}; never edit tracked source, rebuild, publish, stop the working user's app, or read/copy their application/provider profile or credentials.

First preflight your actual supported computer-use capability. On Windows use the installed Windows/Sky skill and its normal review controls. On macOS use the available supported CUA surface. Inventory and capture the native surface through that tool. If unavailable or denied, return blocked with exact tool/capability evidence; do not invent a shell/UI fallback or treat a normal automatic review as rejection. Verify your actual model/high reasoning and danger-full-access/approval_policy never from session metadata without printing private context. This worker is persisted; no child agents.

Read the frozen maintained recipe ${contract.sourceCapability?.recipePath}, and execute only its selected cases. The machine has already checked the exact source QA contract before launching you. Use supported MYTHRA_RELEASE_QA_ROOT isolation ONLY if the candidate actually implements it. Root ${contract.profile.root}; marker .mythra-release-qa.json must be {schemaVersion:1,purpose:"mythra-release-qa",profileId:"${contract.profile.profileId}"}. On Mac root0700/marker0600. For a Windows contract with windowsCleanup, the coordinator has already provisioned the root and marker: verify them, never recreate/repair/adopt a root. Other Windows contracts retain their frozen provisioning recipe. The implementation permits only its exact reviewed Edge Stable network capability and raw ACE shapes in the three documented WebView browser-storage subtrees; this capability is channel-wide, not QA-profile-specific. Never add that grant yourself or normalize runtime ACLs to pass validation. Never switch, junction, symlink or rename the user's real roots. The app must emit matching profile-open identity before acceptance. Verify provider/auth access is disabled by this supported profile.

Use the final DMG app or NSIS payload verified by the integrity audit. Retain the extracted app/executable under the release state directory after cleanup, so its bytes can be independently rehashed. Resolve executable image path/hash/PID/start time and match version ${contract.version}, package hash ${contract.packageSha256}, foreground window and accessibility identity BEFORE interacting. The actual AX title MUST contain the FULL profileId ${contract.profile.profileId} in "Mythra Code — Release QA ${contract.profile.profileId}"; an app label, bundle path or launcher result alone does not establish this. If AX resolves the user's installed app, do not click/type there. A launcher returning an older registered copy is a failed launch: close only that explicitly owned idle test instance if authorized, and use the supported exact-path launcher; do not repeat the same failed method. A different directory does not isolate an NSIS global process-kill action: installer cases require a supported isolated OS environment, otherwise return blocked.

Run exactly the selected contract checks, sharing healthy startup/save/close work across cases. Inspect actual native pixels plus AX; process liveness, render-ready events, DOM-only results and fixture module passes are insufficient. Use synthetic representative prior-version saved data; an empty folder with a marker is not existing-data coverage. Seed malformed data only in this isolated profile and preserve raw rows where the selected storage case requires it. No paid provider turn. No unrelated UI tour, fresh account, or hypothetical test expansion.
${languageStorage ? '\nSelected language storage: execute the maintained Language-tool preferences recipe within existing representative-existing-data/save-close-reopen/affected-data-preserved observations. In actual Settings > Tools & MCP inspect inventory, switch Automatic setup off and disable Python; verify the owned app-data/language-tools/settings.json has autoInstall:false and enabled.python:false. Close normally and reopen the SAME package/root with no external edits or reseeding between those saves and their healthy reopen; retain fresh run identity, renderer marker, visible controls and matching JSON preferences, plus the original theme/onboarding/draft/app-state checks and close-failure recipe. Snapshot and the two setters are metadata-only; inventory may discover bounded host tool metadata but cannot start a server. Never click Refresh/Install or run preparation, a query, MCP or provider. Missing/rejected controls are a real failure, not fixture acceptance.\n' : ''}

For each upgradeCases entry relevant to your selected case, retain the exact predecessor tag/commit fixture before launch and after the accepted replay using the maintained recipe's historical-coverage format. An upgrade observation is optional for ordinary package acceptance; report it only when that exact predecessor replay actually occurred. Never turn a fresh profile or marker-only folder into historical coverage. Missing upgrade proof means future releases must retain their native upgrade check.

Supported events.jsonl records schemaVersion/profileId/pid/runId/kind (profile-open, window-constructed, control-ready, renderer-storage, render-ready, render-failed, close-finish, exit). Wait for matching control-ready for this exact launch BEFORE writing any control request; profile-open alone is too early. Normal close may use actual UI or the supported atomic request.json {schemaVersion:1,profileId,nonce:UUIDv4,action:"close"}; it invokes the production close guard. Remove an old request before reopening. Retain the exact runId for each observed candidate process. These events complement real pixels/AX, never replace them. Final cleanup on Mac requires normal owned-process exit followed by a separate headless launch of the SAME candidate with MYTHRA_RELEASE_QA_ROOT and the documented --release-qa-dispose-store argument. Require successful store-absence verification; an in-process deferred disposal is not cleanup. For prospective Windows contracts (windowsCleanup version 1), NEVER remove the profile yourself: after every launch reaches control-ready, run: node scripts/release-windows-qa-cleanup.mjs capture-writers "${stateRoot}" PID RETAINED_EXECUTABLE to capture the live host and persistent WebView identities. Capture every launch, including the injected run and healthy reopen, before closing it. Copy the exact processStart from that capture into results. After successful selected observations and normal exits, return status passed with cleanupComplete:false; the coordinator validates all observations, preserves the evidence, explicitly permanently removes this one newly owned successful profile, independently verifies absence/writer exit, and finalizes cleanup. Any failed/denied cleanup is retained without fallback. Legacy Windows contracts keep their frozen recipe. Copy native events to permanent native-events.jsonl evidence before deleting the owned root. Never delete the extracted executable or evidence.

If closeFailureScenario is present, execute the maintained one-shot save-failure recipe with its exact nonce and the first launch's runId. Capture the actual native failure dialog via CUA, choose Keep open, verify the window and saved state, then close normally. Reopen the SAME candidate/root and use this later completely healthy run as the primary PID/runId in EVERY check result. Store the typed close-failure.json plus prompt/recovery pixels and AX as specified by the recipe. This injects a saved-result failure at the native guard boundary; it does not prove actual disk failure, renderer crash or timeout behavior. Unexpected failures remain failed. Never use the injected run as the healthy primary.

Save actual screenshots, accessibility.json, process identity and relevant data/exit evidence under ${stateRoot}. Every result must include each observation ID listed by the contract, with a concrete evidence path. Record each evidence SHA256. On completion close only the owned candidate normally, confirm its host and descendants exited, and record cleanupComplete/restorationComplete (restoration means no real roots were touched; prospective Windows workers MUST leave cleanupComplete:false for the coordinator). A native failure is failed; missing capability is blocked. Preserve evidence and leave publication untouched.

Continue routine already-authorized actions without asking the user again. For UI ambiguity, refresh once, inspect current state, and use the supported alternate once; if still unresolved return a precise blocked result. A real control rejection is not permission to bypass controls. Do not produce a generic passed JSON. Return the required structured result only after actual acceptance checks, with native executable/PID/window, session capability and evidence. Do not claim repair of native/GPU deadlocks beyond the changed behavior. Deadline: 25 minutes; finish with a terminal passed/failed/blocked result. Do not wait indefinitely for user input.`;
}

export const nativeResultSchema = {
  type: 'object', additionalProperties: false,
  required: ['status', 'reason', 'capability', 'cleanupComplete', 'restorationComplete', 'results'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'blocked'] }, reason: { type: 'string' },
    capability: { type: 'object', additionalProperties: false, required: ['tool', 'verified', 'evidence'], properties: { tool: { type: 'string' }, verified: { type: 'boolean' }, evidence: { type: 'string' } } },
    cleanupComplete: { type: 'boolean' }, restorationComplete: { type: 'boolean' },
    results: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['checkId', 'executablePath', 'executableSha256', 'pid', 'processStart', 'runId', 'windowIdentity', 'version', 'observations', 'evidence'],
      properties: { checkId: { type: 'string' }, executablePath: { type: 'string' }, executableSha256: { type: 'string' }, pid: { type: 'integer' }, processStart: { type: 'string' }, runId: { type: 'string' }, windowIdentity: { type: 'string' }, version: { type: 'string' },
        observations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'evidence'], properties: { id: { type: 'string' }, evidence: { type: 'string' } } } },
        evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'sha256'], properties: { path: { type: 'string' }, sha256: { type: 'string' } } } } } } },
  },
};

export function assertNativeContract(contract) {
  const { contractHash, ...body } = contract;
  if (!HASH.test(contractHash) || objectHash(body) !== contractHash) throw new Error('Native worker contract hash differs from its content');
}

function acceptedCloseFault(events, result, contract, stateRoot, primaryEntry) {
  const scenario = contract.closeFailureScenario;
  if (!scenario) {
    if (contract.checks.some((c) => c.id.startsWith('native-close:'))) throw new Error('Selected close replay lacks its fault declaration');
    return null;
  }
  const reject = () => { throw new Error('Invalid maintained close failure replay'); };
  const close = result.results.find((r) => r.checkId === `native-close:${contract.platform}`);
  if (!close || contract.sourceCapability?.closeFailure?.version !== 1 || scenario.schemaVersion !== 1
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(scenario.nonce)
    || scenario.kind !== 'save-failure-once' || scenario.cause !== 'override-saved-result') reject();
  const observation = close.observations.find((o) => o.id === 'affected-close-failure');
  const evidence = (path) => {
    const item = close.evidence.find((e) => e.path === path);
    if (!item || !HASH.test(item.sha256) || fileHash(containedPath(stateRoot, path)) !== item.sha256) reject();
    return containedPath(stateRoot, path);
  };
  if (!observation) reject();
  const proof = readJson(evidence(observation.evidence));
  if (proof.schemaVersion !== 1 || proof.nonce !== scenario.nonce || proof.kind !== scenario.kind || proof.cause !== scenario.cause
    || proof.profileId !== contract.profile.profileId || !Number.isInteger(proof.pid) || proof.pid < 1
    || !/^[a-f0-9-]{36}$/.test(proof.runId) || proof.runId === primaryEntry.runId
    || !Number.isSafeInteger(proof.requestId) || proof.requestId < 1) reject();
  const captures = [];
  for (const [name, capture] of [['prompt', proof.prompt], ['recovery', proof.recovery]]) {
    if (!capture || capture.pid !== proof.pid || capture.runId !== proof.runId || capture.phase !== name
      || !/\.(png|jpe?g)$/.test(capture.screenshot ?? '') || !/\.json$/.test(capture.accessibility ?? '')) reject();
    const pixels = readFileSync(evidence(capture.screenshot));
    if (pixels.length <= 32 || !(pixels.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || pixels.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))) reject();
    const ax = JSON.stringify(readJson(evidence(capture.accessibility)));
    const dialogTitle = `Close Mythra Code? — Release QA ${contract.profile.profileId}`;
    if (!ax.includes(`Mythra Code — Release QA ${contract.profile.profileId}`)
      || (name === 'prompt' && (!ax.includes(dialogTitle) || !ax.includes('Keep open')))
      || (name === 'recovery' && ax.includes(dialogTitle))) reject();
    captures.push({ pixels, ax });
  }
  if (proof.prompt.screenshot === proof.recovery.screenshot || proof.prompt.accessibility === proof.recovery.accessibility) reject();
  if (captures[0].pixels.equals(captures[1].pixels) || captures[0].ax === captures[1].ax) reject();
  const run = events.filter((e) => e.pid === proof.pid && e.runId === proof.runId);
  const once = (kind) => { const matches = run.filter((e) => e.kind === kind); if (matches.length !== 1) reject(); return matches[0]; };
  const opened = once('profile-open'), rendered = once('render-ready');
  if (opened.details?.closeFailureVersion !== 1) reject();
  const armed = once('qa-close-fault-armed'), applied = once('qa-close-fault-applied');
  if (events.filter((e) => e.kind.startsWith('qa-close-fault-')).length !== 2) reject();
  for (const event of [armed, applied]) if (event.details?.nonce !== scenario.nonce || event.details.kind !== scenario.kind || event.details.cause !== scenario.cause) reject();
  if (applied.details.originalResult !== 'saved' || applied.details.result !== 'failed') reject();
  const failed = events.filter((e) => e.kind === 'close-finish' && e.details?.result === 'failed');
  if (failed.length !== 1 || !run.includes(failed[0]) || failed[0].details.accepted !== true || failed[0].details.faultNonce !== scenario.nonce) reject();
  const prompt = once('close-prompt'), answer = once('close-prompt-answer'), cancelled = once('close-cancelled');
  for (const event of [applied, failed[0], prompt, answer, cancelled]) {
    if (event.details?.requestId !== proof.requestId || event.details.label !== 'main') reject();
  }
  if (prompt.details.reason !== 'SaveFailed' || answer.details.accepted !== true || answer.details.confirmed !== false || answer.details.choice !== 'keep-open') reject();
  const saved = run.filter((e) => e.kind === 'close-finish' && e.details?.accepted === true && e.details.result === 'saved');
  if (saved.length !== 1 || saved[0].details.faultNonce != null || !Number.isSafeInteger(saved[0].details.requestId) || saved[0].details.requestId <= proof.requestId) reject();
  const exit = once('exit'), reopened = events.find((e) => e.pid === primaryEntry.pid && e.runId === primaryEntry.runId && e.kind === 'profile-open');
  const ordered = [opened, rendered, armed, applied, failed[0], prompt, answer, cancelled, saved[0], exit, reopened].map((e) => events.indexOf(e));
  if (ordered.some((position, index) => position < 0 || (index > 0 && position <= ordered[index - 1]))) reject();
  return { failure: failed[0], prompt };
}

export function validateNativeObservations(result, contract, stateRoot, { executablePath = (entry) => containedPath(stateRoot, relative(stateRoot, entry.executablePath)) } = {}) {
  if (result.status !== 'passed') throw new Error(`Native worker ${result.status}: ${result.reason}`);
  if (!result.capability?.verified || !/cua|sky|computer.use/i.test(result.capability.tool) || !result.restorationComplete) throw new Error('Native worker lacks verified computer use or completed restoration');
  if (objectHash(result.results?.map((r) => r.checkId).sort()) !== objectHash(contract.checks.map((c) => c.id).sort())) throw new Error('Native worker omitted or duplicated required checks');
  const capabilityEvidence = readJson(containedPath(stateRoot, result.capability.evidence));
  if (!capabilityEvidence || typeof capabilityEvidence !== 'object' || !Object.keys(capabilityEvidence).length) throw new Error('Computer-use capability evidence is empty');
  for (const entry of result.results) {
    const expected = contract.checks.find((c) => c.id === entry.checkId);
    if (!Number.isInteger(entry.pid) || entry.pid < 1 || !entry.processStart || !/^[a-f0-9-]{36}$/.test(entry.runId) || !entry.windowIdentity?.includes(contract.profile.profileId) || entry.version !== contract.version || !HASH.test(entry.executableSha256)
      || entry.executableSha256 !== contract.executableSha256) throw new Error('Native worker package/process identity mismatch');
    if (fileHash(executablePath(entry)) !== entry.executableSha256) throw new Error('Native executable no longer matches observed bytes');
    if (expected.observations.some((id) => !entry.observations.some((o) => o.id === id && entry.evidence.some((e) => e.path === o.evidence)))) throw new Error('Native acceptance observation lacks evidence');
    if (!entry.evidence.some((e) => /\.(png|jpe?g)$/.test(e.path)) || !entry.evidence.some((e) => /(?:accessibility|ax)\.json$/.test(e.path))) throw new Error('Native result needs pixels and accessibility evidence');
    for (const item of entry.evidence) if (!HASH.test(item.sha256) || fileHash(containedPath(stateRoot, item.path)) !== item.sha256) throw new Error('Native evidence hash mismatch');
    const pixels = entry.evidence.filter((e) => /\.(png|jpe?g)$/.test(e.path)).map((e) => readFileSync(containedPath(stateRoot, e.path)));
    if (!pixels.some((b) => b.length > 32 && (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || b.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))))) throw new Error('Native screenshot is not encoded image evidence');
    const ax = readJson(containedPath(stateRoot, entry.evidence.find((e) => /(?:accessibility|ax)\.json$/.test(e.path)).path));
    if (!ax || typeof ax !== 'object' || !JSON.stringify(ax).includes(contract.profile.profileId)) throw new Error('Native accessibility evidence does not identify this isolated QA window');
    const eventsEvidence = entry.evidence.find((e) => /native-events\.jsonl$/.test(e.path));
    if (!eventsEvidence) throw new Error('Native result has no persistent app event evidence');
    const events = readFileSync(containedPath(stateRoot, eventsEvidence.path), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const profileEvents = events.filter((e) => e.schemaVersion === 1 && e.profileId === contract.profile.profileId);
    const expectedFault = acceptedCloseFault(profileEvents, result, contract, stateRoot, entry);
    // Only the declared one-shot fault with complete native recovery evidence
    // is expected. All other failed events, including other runs, still fail.
    if (profileEvents.some((e) => ['render-failed', 'setup-failed', 'renderer-storage-failed', 'control-rejected'].includes(e.kind)
      || (e.kind === 'close-finish' && e.details?.result === 'failed' && e !== expectedFault?.failure))) throw new Error('Native app recorded a failure unsupported by the maintained recipe');
    if (profileEvents.some((e) => e.kind === 'close-prompt' && e !== expectedFault?.prompt)) throw new Error('Native app recorded an undeclared close prompt');
    const primary = profileEvents.filter((e) => e.pid === entry.pid && e.runId === entry.runId);
    for (const kind of ['profile-open', 'window-constructed', 'renderer-storage', 'render-ready', 'close-finish', 'exit']) if (!primary.some((e) => e.kind === kind)) throw new Error(`Native profile identity or ${kind} event is absent`);
    const opened = primary.find((e) => e.kind === 'profile-open');
    if (opened.details?.contractVersion !== 1 || opened.details.providers !== 'blocked' || opened.details.persistentWebview !== true) throw new Error('Running candidate did not confirm supported profile isolation');
    if (!primary.some((e) => e.kind === 'renderer-storage' && e.details?.current === contract.profile.profileId
      && (e.details.previous === null || e.details.previous === contract.profile.profileId))) throw new Error('Native renderer did not confirm this isolated persistent store');
    if (expectedFault && primary.filter((e) => e.kind === 'renderer-storage').some((e) => e.details?.current !== contract.profile.profileId
      || e.details.previous !== contract.profile.profileId)) throw new Error('Healthy reopen did not retain the isolated persistent store');
    const savedClose = primary.findIndex((e) => e.kind === 'close-finish' && e.details?.accepted === true && e.details.result === 'saved');
    if (savedClose < 0 || primary.findIndex((e) => e.kind === 'exit') <= savedClose) throw new Error('Native primary run did not finish saved normal close before exit');
    for (const upgrade of expected.upgradeCases ?? []) {
      const observation = entry.observations.find((o) => o.id === upgrade.id);
      if (!observation) continue; // Legacy/ordinary acceptance remains valid, but cannot yield upgrade coverage.
      if (!entry.evidence.some((e) => e.path === observation.evidence)) throw new Error('Upgrade observation is not retained evidence');
      const proof = readJson(containedPath(stateRoot, observation.evidence));
      validateUpgradeObservation({ proof, upgrade, entry, contract, stateRoot, events });
    }
    if (contract.platform === 'darwin-aarch64') {
      const initialized = events.find((e) => e.profileId === contract.profile.profileId && e.kind === 'webview-maintenance-initialized'
        && e.details?.mainThread === true && e.details.persistent === false && e.details.url === 'about:blank');
      if (!initialized || !opened.details.webviewStoreId || !events.some((e) => e.profileId === contract.profile.profileId && e.runId === initialized.runId && e.kind === 'webview-dispose-complete'
        && e.details?.verifiedAbsent === true && e.details.webviewStoreId === opened.details.webviewStoreId)) throw new Error('Owned macOS WebView store cleanup was not verified');
    }
  }
  return result;
}

export function validateNativeResult(result, contract, stateRoot, options = {}) {
  validateNativeObservations(result, contract, stateRoot, options);
  validateWindowsCleanupReceipt(result, contract, stateRoot);
  if (!result.cleanupComplete) throw new Error('Native worker lacks completed cleanup');
  return result;
}

export function effectiveSession(sessionId, { sessionsRoot = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions') } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('Native worker session identity is invalid');
  const file = readdirSync(sessionsRoot, { recursive: true }).find((name) => name.endsWith(`${sessionId}.jsonl`));
  if (!file) throw new Error('Persisted native worker session is not readable');
  let context;
  // Resume can change the model, effort or permissions. Acceptance is bound to
  // the newest persisted turn, never to the session's original defaults.
  for (const line of readFileSync(resolve(sessionsRoot, file), 'utf8').split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type === 'turn_context') context = event.payload;
  }
  if (!context) throw new Error('Native worker runtime metadata not recorded');
  if (context.model !== 'gpt-6.1-sol' || context.effort !== 'high' || context.approval_policy !== 'never' || context.sandbox_policy?.type !== 'danger-full-access') throw new Error('Native worker effective runtime differs from required Sol/high/Full Access contract');
  return { model: context.model, reasoningEffort: context.effort, approvalPolicy: context.approval_policy, sandbox: context.sandbox_policy.type };
}

function nativeBinary(path, platform) {
  let fd;
  try {
    const actual = realpathSync(path);
    if (!statSync(actual).isFile() || /\.(cmd|bat|ps1|js)$/i.test(actual)) return null;
    fd = openSync(actual, 'r'); const magic = Buffer.alloc(4); readSync(fd, magic, 0, 4, 0);
    const hex = magic.toString('hex');
    if (platform === 'win32' ? magic.subarray(0, 2).toString() !== 'MZ' : !['7f454c46', 'cffaedfe', 'feedfacf', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(hex)) return null;
    return actual;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

export function resolveCodexBinary({ env = process.env, platform = process.platform } = {}) {
  const directories = String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const requested = env.MYTHRA_CODEX_BINARY;
  const candidates = requested ? [requested] : directories.map((path) => join(path, platform === 'win32' ? 'codex.exe' : 'codex'));
  if (!requested && platform === 'win32') {
    // npm installs a cmd shim. Resolve only the known Codex package's vendor
    // executable, never run the shim with a shell or scan unrelated user data.
    for (const directory of directories) for (const name of ['codex', 'codex-win32-x64', 'codex-win32-arm64']) {
      for (const vendor of [join(directory, 'node_modules', '@openai', name, 'vendor'), join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', name, 'vendor')]) {
        if (existsSync(vendor)) for (const file of readdirSync(vendor, { recursive: true })) if (/(?:^|[\\/])codex\.exe$/i.test(file)) candidates.push(join(vendor, file));
      }
    }
  }
  for (const path of candidates) { const binary = nativeBinary(path, platform); if (binary) return binary; }
  throw new Error('Native Codex executable unavailable; install the supported CLI or set MYTHRA_CODEX_BINARY to its native binary (cmd/PowerShell shims are not workers)');
}

function sessionFromEvents(path) {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split('\n')) try {
    const event = JSON.parse(line); if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
  } catch { /* only complete JSONL events establish session identity */ }
  return null;
}

export async function runNativeWorkerWrapper(config) {
  const previous = readJson(config.statusPath);
  const worker = { host: hostname(), pid: process.pid, processStart: processIdentity() };
  const startedAt = previous.startedAt || new Date().toISOString();
  const base = { ...previous, worker, status: 'running', startedAt };
  const stdout = openSync(config.eventsPath, 'a', 0o600), stderr = openSync(config.errorsPath, 'a', 0o600);
  let child, timer, forcedTimer, timedOut = false, childWorker;
  try {
    if (!worker.processStart) throw new Error('Cannot identify persisted native wrapper');
    atomicJson(config.statusPath, base);
    child = spawn(config.binary, config.args, { cwd: config.root, stdio: ['pipe', stdout, stderr], windowsHide: true });
    const exit = new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
    // Establish the child identity before accepting its work. File-backed output
    // continues even if the publishing coordinator disappears.
    childWorker = { host: hostname(), pid: child.pid, processStart: Number.isInteger(child.pid) ? processIdentity(child.pid) : null };
    if (!childWorker.processStart) { child.kill(); await exit.catch(() => {}); throw new Error('Cannot identify native Codex worker'); }
    atomicJson(config.statusPath, { ...base, childWorker });
    child.stdin.on('error', () => {}); child.stdin.end(readFileSync(config.promptPath));
    timer = setTimeout(() => {
      timedOut = true;
      atomicJson(config.statusPath, { ...base, childWorker, status: 'blocked', reason: 'Native worker deadline exceeded; descendant ownership retained', sessionId: sessionFromEvents(config.eventsPath) });
      child.kill('SIGTERM');
      forcedTimer = setTimeout(() => child.kill('SIGKILL'), config.terminationGraceMs ?? 30_000);
    }, config.deadlineMs);
    const code = await exit;
    const sessionId = sessionFromEvents(config.eventsPath);
    if (timedOut || code !== 0 || !sessionId || !existsSync(config.resultPath)) throw new Error(`Native worker did not complete (${timedOut ? 'deadline exceeded' : code}); inspect preserved session evidence`);
    atomicJson(config.statusPath, { ...base, childWorker, status: 'result-ready', sessionId, completedAt: new Date().toISOString() });
  } catch (error) {
    atomicJson(config.statusPath, { ...base, childWorker, status: 'blocked', reason: error.message, sessionId: sessionFromEvents(config.eventsPath), stoppedAt: new Date().toISOString() });
  } finally { clearTimeout(timer); clearTimeout(forcedTimer); closeSync(stdout); closeSync(stderr); }
}

function nativeOwnershipAlive(status) {
  return [status.worker, status.childWorker].filter(Boolean).some((worker) => workerTreeAlive(worker));
}

export async function collectNativeWorker(statusPath, { sleep = (ms) => new Promise((accept) => setTimeout(accept, ms)), pollMs = 1_000, timeoutMs = 27 * 60_000, ownershipAlive = nativeOwnershipAlive } = {}) {
  const start = Date.now();
  for (;;) {
    const status = readJson(statusPath);
    if (status.status === 'result-ready' || status.status === 'passed') return status;
    if (status.status === 'blocked') throw new Error(`Native worker blocked: ${status.reason}; inspect and preserve owned descendants before retry`);
    if (!['queued', 'running'].includes(status.status)) throw new Error('Invalid native worker ownership status');
    if (status.worker && !ownershipAlive(status)) {
      // A synchronous Windows ownership probe can outlast wrapper completion.
      // Read its durable terminal record again before treating the owner as lost.
      const latest = readJson(statusPath);
      if (latest.status === 'result-ready' || latest.status === 'passed') return latest;
      if (latest.status === 'blocked') throw new Error(`Native worker blocked: ${latest.reason}; inspect and preserve owned descendants before retry`);
      throw Object.assign(new Error('Native wrapper ended without a terminal result; inspect preserved logs before retry'), { status: 'waiting' });
    }
    if (Date.now() - start >= timeoutMs) throw Object.assign(new Error('Native result collection deadline reached; owned worker can be collected on resume'), { status: 'waiting' });
    await sleep(pollMs);
  }
}

export async function launchNativeWorker(config, { modulePath = fileURLToPath(import.meta.url) } = {}) {
  if (existsSync(config.statusPath)) return collectNativeWorker(config.statusPath);
  // Exclusive launch lock protects direct callers as well as coordinator-owned
  // calls. An interrupted queued launch is retained for diagnosis, not replaced.
  const lockPath = `${config.statusPath}.launch-lock`;
  const guard = openSync(lockPath, 'wx', 0o600);
  try {
    if (existsSync(config.statusPath)) return await collectNativeWorker(config.statusPath);
    const configPath = `${config.statusPath}.launch.json`;
    atomicJson(configPath, config);
    atomicJson(config.statusPath, { status: 'queued', startedAt: new Date().toISOString(), contractHash: config.contractHash });
    const log = openSync(`${config.statusPath}.wrapper.log`, 'a', 0o600);
    try {
      const wrapper = spawn(process.execPath, [modulePath, '--native-worker', configPath], { cwd: config.root, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
      const identity = { host: hostname(), pid: wrapper.pid, processStart: Number.isInteger(wrapper.pid) ? processIdentity(wrapper.pid) : null };
      wrapper.on('error', (error) => atomicJson(config.statusPath, { ...readJson(config.statusPath), status: 'blocked', reason: error.message }));
      if (!identity.processStart) throw new Error('Cannot identify native wrapper; preserve queued ownership');
      // The wrapper alone advances status; a parent write after spawn could
      // race its terminal result and regress ownership back to queued.
      atomicJson(`${config.statusPath}.spawn.json`, identity);
      wrapper.unref();
    } finally { closeSync(log); }
  } finally { closeSync(guard); rmSync(lockPath, { force: true }); }
  return collectNativeWorker(config.statusPath);
}

export async function runNativeCheck({ root, stateRoot, plan, check }) {
  const sourceCapability = assertQaSourceSupport({ root, plan });
  const directory = resolve(stateRoot, 'workers', `native-${check.platform}`); mkdirSync(directory, { recursive: true });
  const contractPath = join(directory, 'contract.json');
  const contract = existsSync(contractPath) ? readJson(contractPath) : createNativeContract({ root, stateRoot, plan, platform: check.platform });
  assertNativeContract(contract);
  if (objectHash(contract.sourceCapability) !== objectHash(sourceCapability)) throw new Error('Native source capability contract changed');
  if (contract.planHash !== plan.planHash || contract.packageSha256 !== readJson(receiptPath(stateRoot, `build:${check.platform}`)).details.packageSha256) throw new Error('Native worker contract became stale');
  atomicJson(contractPath, contract);
  const schemaPath = join(directory, 'result-schema.json'), resultPath = join(directory, 'result.json'), statusPath = join(directory, 'status.json');
  atomicJson(schemaPath, nativeResultSchema);
  let status;
  if (existsSync(statusPath)) {
    const previous = readJson(statusPath);
    if (previous.contractHash !== contract.contractHash) throw new Error('Native worker ownership contract became stale');
    status = ['result-ready', 'passed'].includes(previous.status) ? previous : await collectNativeWorker(statusPath); // no blind replacement
  } else {
    if (existsSync(resultPath)) throw new Error('Native result exists without a persisted worker owner; inspect before adoption');
    if (contract.windowsCleanup) provisionWindowsQaProfile(contract, stateRoot);
    const binary = resolveCodexBinary();
    execFileSync(binary, ['exec', '--help'], { cwd: root, stdio: 'ignore', timeout: 10_000 });
    const args = ['exec', '--model', 'gpt-6.1-sol', '--sandbox', 'danger-full-access', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="high"',
      '--json', '--output-schema', schemaPath, '--output-last-message', resultPath, '--cd', root, '-'];
    const promptPath = join(directory, 'prompt.txt'); writeFileSync(promptPath, nativePrompt(contract, contractPath, stateRoot), { mode: 0o600 });
    status = await launchNativeWorker({ binary, args, root, promptPath, statusPath, resultPath, eventsPath: join(directory, 'events.jsonl'), errorsPath: join(directory, 'stderr.log'), deadlineMs: 25 * 60_000, contractHash: contract.contractHash }, { modulePath: resolve(root, 'scripts/release-native-check.mjs') });
  }
  if (!status.sessionId) throw new Error('Native result has no persisted worker session identity');
  const runtime = effectiveSession(status.sessionId);
  let result = readJson(resultPath);
  if (contract.windowsCleanup) {
    validateNativeObservations(result, contract, stateRoot);
    const workerResultPath = join(directory, 'worker-result.json');
    if (!existsSync(workerResultPath)) writeFileSync(workerResultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const cleanupReceiptPath = join(directory, 'cleanup-receipt.json');
    if (!existsSync(cleanupReceiptPath)) cleanupSuccessfulWindowsQaProfile(result, contract, stateRoot);
    result = { ...result, cleanupComplete: true };
    validateWindowsCleanupReceipt(result, contract, stateRoot);
    verifyWindowsCleanupLive(contract, stateRoot, result.results[0].executablePath);
    atomicJson(resultPath, result);
  }
  result = validateNativeResult(result, contract, stateRoot);
  const startedAt = status.startedAt, completedAt = status.completedAt;
  const receipts = result.results.map((r) => ({ schemaVersion: 1, checkId: r.checkId, status: 'passed', planHash: plan.planHash, commit: plan.commit,
    platform: check.platform, packageSha256: contract.packageSha256, checkerVersion: 'native-check-v1', startedAt, completedAt,
    evidence: [...r.evidence, ...[r.executablePath, contractPath, resultPath, containedPath(stateRoot, result.capability.evidence), ...(contract.windowsCleanup ? ['provisioning.json', 'writers.json', 'cleanup-intent.json', 'cleanup-receipt.json', 'worker-result.json'].map((name) => join(directory, name)) : [])].map((path) => ({ path: relative(stateRoot, path).replaceAll('\\', '/'), sha256: fileHash(path) }))],
    details: { ...r, portableExecutablePath: relative(stateRoot, r.executablePath).replaceAll('\\', '/'), workerContractHash: contract.contractHash, sessionId: status.sessionId, runtime, cleanupComplete: result.cleanupComplete, restorationComplete: result.restorationComplete } }));
  for (const receipt of receipts) saveReceipt(stateRoot, plan, receipt);
  atomicJson(statusPath, { ...status, status: 'passed', completedAt, contractHash: contract.contractHash });
  return receipts.find((r) => r.checkId === check.id);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--native-worker') {
  await runNativeWorkerWrapper(readJson(process.argv[3]));
}
