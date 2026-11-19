// The settings-appearance preview scene: the app's real Settings sheet, open
// on Appearance, over the sample conversation. Loaded only for that scene
// (main.tsx), so other previews don't pay for the Settings bundle.
//
// Every prop is sample state or a passive handler. Nothing is saved, no
// account is read and no native command runs: the page's storage is the
// fixture map (hiddenPage.ts), so the Custom themes list is empty and custom
// fonts are absent.

import { SettingsModal } from "../components/SettingsModal";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import type { AppUpdater } from "../lib/appUpdater";
import type { DeveloperRuntimeUpdater } from "../lib/runtimeUpdates";
import type { PreviewJob } from "../lib/customThemes/previewJob";
import type { AppSettings } from "../types";
import { SAMPLE_PALETTE_PROJECTS } from "./fixtures";

const noop = () => {};
const idle = async () => {};
const declined = async () => false;

const NO_UPDATES: AppUpdater = {
  phase: "idle", currentVersion: "…", availableVersion: null, notes: null, publishedAt: null,
  downloadedBytes: 0, totalBytes: null, restartPending: false, error: null,
  checkForUpdates: idle, applyUpdate: idle,
};
const NO_RUNTIME_UPDATES: DeveloperRuntimeUpdater = {
  status: null, checking: false, updating: null, error: null, message: null,
  checkForUpdates: idle, updateRuntime: idle,
};

export function SettingsScene({ job }: { job: PreviewJob }) {
  const custom = job.theme.custom;
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    theme: custom ? `custom:${custom.id}` : job.theme.base,
    provider: job.provider,
    chatFont: job.chatFont,
    ...(job.effortSlider ? { effortSlider: job.effortSlider } : {}),
    uiScale: Math.round(job.uiScale * 100),
    themeMotion: job.motion.paused ? "paused" : DEFAULT_SETTINGS.themeMotion,
    ...(job.logos?.openai ? { openAiLogo: job.logos.openai } : {}),
    ...(job.logos?.claude ? { claudeLogo: job.logos.claude } : {}),
    ...(job.logos?.cursor ? { cursorLogo: job.logos.cursor } : {}),
  };
  return <SettingsModal
    open
    initialSection="appearance"
    appUpdater={NO_UPDATES}
    developerRuntimeUpdater={NO_RUNTIME_UPDATES}
    settings={settings}
    account={null}
    runtimeStatus={null}
    openRouterReady={false}
    childAgentReadiness={{ codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false }}
    githubStatus={null}
    onClose={noop}
    onSave={noop}
    onThemePreview={noop}
    onEffortSliderPreview={noop}
    onChatFontPreview={noop}
    onDesignTheme={noop}
    onCustomThemeAccessChange={noop}
    onSignIn={idle}
    onSignOut={idle}
    onRuntimeRequired={noop}
    onWorkspaceTools={noop}
    onOpenRouterChange={noop}
    onGitHubSignIn={idle}
    onGitHubRefresh={idle}
    onGitHubClone={declined}
    onError={noop}
    profiles={[]}
    agents={[]}
    actions={[]}
    schedules={[]}
    workflows={[]}
    workflowRuns={[]}
    projects={SAMPLE_PALETTE_PROJECTS}
    activeProjectId={SAMPLE_PALETTE_PROJECTS[0]?.id}
    skillsFolder=""
    skills={[]}
    removedSkills={[]}
    skillsBusy={false}
    skillsError=""
    workspaceToolsAvailable
    onProfiles={noop}
    onAgents={noop}
    onActions={noop}
    onSchedules={noop}
    onWorkflows={noop}
    onRunWorkflow={noop}
    onStopWorkflow={() => false}
    onProjects={noop}
    onChooseSkillsFolder={noop}
    onRefreshSkills={noop}
    onImportSkills={noop}
    onCreateSkill={declined}
    onReadSkill={async () => ""}
    onUpdateSkill={idle}
    onRenameSkill={() => false}
    onToggleSkill={noop}
    onRemoveSkill={declined}
    onRestoreSkill={declined}
    onOpenOnboarding={noop}
  />;
}
