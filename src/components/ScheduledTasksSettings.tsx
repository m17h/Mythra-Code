import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, Check, Clock3, Info, Pencil, Play, Plus, Trash2, Workflow, X } from "lucide-react";
import type { AppSettings, Project, Provider, ScheduledTask, ScheduleRunRecord, ScheduleRunSettings, ScheduleIntervalUnit, ScheduleThreadMode } from "../types";
import { localScheduleTimeZone, nextScheduledRunAt, normalizedDailyTimes, scheduleTimingLabel, scheduleIntervalMinutes, scheduleIntervalParts } from "../lib/schedules";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import { providerDisplayName } from "../lib/childAgents";
import { DEFAULT_OPENAI_MODEL } from "../lib/appConfig";
import { confirmDialog } from "../lib/confirmDialog";
import { friendlyError } from "../lib/errors";
import { workflowFromSchedule, type WorkflowDefinition } from "../lib/workflows";
import { ProviderLogo } from "./BrandLogos";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import type { ChildAgentModelOption } from "./ChildAgentRoster";
import "./ScheduledTasksSettings.css";

const PROVIDERS: Provider[] = ["openai", "openrouter", "lmstudio"];
const CHATS = "__mythra_normal_chats__";
type ScheduleUpdate = ScheduledTask[] | ((current: ScheduledTask[]) => ScheduledTask[]);
type Catalogs = Partial<Record<Provider, ChildAgentModelOption[]>>;
interface TaskDraft {
  id?: string;
  name: string;
  prompt: string;
  projectId: string;
  interval: string;
  unit: ScheduleIntervalUnit;
  scheduleMode: "interval" | "daily";
  dailyTimes: string[];
  threadMode: ScheduleThreadMode;
  enabled: boolean;
  run: ScheduleRunSettings;
}

function captureRun(settings: AppSettings, provider: Provider, catalogs?: Catalogs): ScheduleRunSettings {
  const model = provider === settings.provider ? settings.model
    : catalogs?.[provider]?.[0]?.id ?? (provider === "openai" ? DEFAULT_OPENAI_MODEL : "");
  return scheduleRunSnapshot({ ...settings, provider, model,
    // Provider-specific compaction/native options cannot follow a provider switch.
    autoCompactTokens: provider === settings.provider ? settings.autoCompactTokens : undefined,
    nativeSubagentOptions: provider === settings.provider ? settings.nativeSubagentOptions : undefined,
  });
}

function timeLabel(at: number | undefined): string {
  return at && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toLocaleString() : "Not scheduled";
}

export function ScheduledTasksSettings({ visible, settings, schedules, projects, modelCatalogs, scheduleRuns, workflows, onSchedules, onWorkflows, onDiscoverOpenRouterModels, onOpenRun }: {
  visible: boolean;
  settings: AppSettings;
  schedules: ScheduledTask[];
  projects: Project[];
  modelCatalogs?: Catalogs;
  scheduleRuns: ScheduleRunRecord[];
  workflows: WorkflowDefinition[];
  onSchedules: (value: ScheduleUpdate) => void;
  onWorkflows: (value: WorkflowDefinition[]) => void;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onOpenRun?: (threadId: string) => void;
}) {
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [notice, setNotice] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const latestSchedules = useRef(schedules);
  latestSchedules.current = schedules;
  useEffect(() => { if (!visible) setDraft(null); }, [visible]);
  const closeEditor = () => {
    setDraft(null);
    requestAnimationFrame(() => {
      const opener = editorOpener.current;
      if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
    });
  };
  const openEditor = (schedule?: ScheduledTask, opener?: HTMLElement) => {
    editorOpener.current = opener ?? null;
    setNotice("");
    try {
      const interval = schedule ? scheduleIntervalParts(schedule) : { value: 60, unit: "minutes" as const };
      setDraft({
        id: schedule?.id, name: schedule?.name ?? "", prompt: schedule?.prompt ?? "",
        projectId: schedule ? schedule.projectId ?? CHATS : CHATS,
        interval: String(interval.value), unit: interval.unit, threadMode: schedule?.threadMode ?? "new",
        scheduleMode: schedule?.scheduleMode ?? "interval", dailyTimes: schedule?.dailyTimes?.length ? [...schedule.dailyTimes] : ["09:00"],
        enabled: schedule?.enabled ?? true,
        run: schedule?.run ?? captureRun(settings, PROVIDERS.includes(settings.provider) ? settings.provider : "openai", modelCatalogs),
      });
    } catch (reason) { setNotice(friendlyError(reason)); }
  };
  const save = (value: TaskDraft): string | null => {
    if (value.id && !latestSchedules.current.some((item) => item.id === value.id)) return "This task no longer exists. Close this window and create a new task instead.";
    const intervalValue = Number(value.interval);
    const intervalMinutes = scheduleIntervalMinutes(intervalValue, value.unit);
    const projectId = value.projectId === CHATS ? null : value.projectId;
    const fields = { name: value.name.trim(), prompt: value.prompt.trim(), projectId, intervalValue, intervalUnit: value.unit, intervalMinutes, scheduleMode: value.scheduleMode, dailyTimes: value.scheduleMode === "daily" ? normalizedDailyTimes(value.dailyTimes) : undefined, dailyTimeZone: value.scheduleMode === "daily" ? localScheduleTimeZone() : undefined, threadMode: value.threadMode, enabled: value.enabled, run: value.run };
    const nextRunAt = nextScheduledRunAt(fields);
    const id = value.id ?? crypto.randomUUID();
    onSchedules((current) => value.id ? current.map((item) => {
      if (item.id !== id) return item;
      const targetChanged = item.projectId !== projectId || (item.run?.provider ?? settings.provider) !== value.run.provider;
      const timingChanged = (item.scheduleMode ?? "interval") !== value.scheduleMode
        || (value.scheduleMode === "daily" && item.dailyTimeZone !== fields.dailyTimeZone)
        || (value.scheduleMode === "daily" ? JSON.stringify(normalizedDailyTimes(item.dailyTimes)) !== JSON.stringify(fields.dailyTimes) : item.intervalMinutes !== intervalMinutes)
        || (!item.enabled && value.enabled) || targetChanged;
      // Keep the scheduler's latest history and delivery latch, even if it ran
      // while this form was open. A new target must not reuse the old thread.
      return { ...item, ...fields, nextRunAt: timingChanged ? nextRunAt : item.nextRunAt,
        ...(targetChanged ? { lastThreadId: undefined } : {}) };
    }) : [...current, { id, ...fields, nextRunAt }]);
    return null;
  };
  const activeCount = schedules.filter((task) => task.enabled).length;
  return <section className="set-group scheduled-tasks-settings" ref={rootRef}>
    <div className="set-group-head"><h4>Scheduled tasks</h4><span className="scheduled-task-count">{schedules.length ? `${activeCount} active · ${schedules.length - activeCount} inactive` : ""}</span></div>
    <p>Recurring prompts for your chats and projects. Tasks run while Mythra Code is open; changes here are saved immediately.</p>
    {notice && <p className="scheduled-task-error" role="alert">{notice}</p>}
    {schedules.length ? <div className="scheduled-task-list">{schedules.map((schedule) => {
      const run = schedule.run;
      const provider = run?.provider ?? settings.provider;
      const missingProject = schedule.projectId !== null && !projects.some((project) => project.id === schedule.projectId);
      return <article className="scheduled-task-card" key={schedule.id}>
        <div className="scheduled-task-heading"><strong>{schedule.name}</strong><span className={`scheduled-task-status ${schedule.enabled ? "active" : "inactive"}`}><i />{schedule.enabled ? "Active" : "Inactive"}</span></div>
        <p className="scheduled-task-description">{schedule.prompt}</p>
        <div className="scheduled-task-details"><span><CalendarClock size={13} />{scheduleTimingLabel(schedule)}</span><span>{schedule.projectId === null ? "Chats" : projects.find((project) => project.id === schedule.projectId)?.name ?? "Missing project"}</span><span><ProviderLogo provider={provider} size={13} />{providerDisplayName(provider)} · {run?.model || settings.model || "Default model"}</span><span>{schedule.threadMode === "reuse" ? "Continue the same thread" : "New thread each time"}</span></div>
        {missingProject ? <p className="scheduled-task-error"><Info size={13} />Choose an available project before enabling this task.</p>
          : schedule.unconfirmedThreadId ? <p className="scheduled-task-timing"><Clock3 size={13} />Waiting for confirmation of the previous run</p>
            : <p className="scheduled-task-timing"><Clock3 size={13} />{schedule.enabled ? `Next run: ${timeLabel(schedule.nextRunAt)}` : "Not running until enabled"}{schedule.lastRunAt ? ` · Last started: ${timeLabel(schedule.lastRunAt)}` : ""}</p>}
        <div className="scheduled-task-actions">
          <label className="scheduled-task-switch"><button type="button" role="switch" className={`toggle-switch ${schedule.enabled ? "on" : ""}`} aria-label={`${schedule.name} active`} aria-checked={schedule.enabled} disabled={missingProject && !schedule.enabled} onClick={() => onSchedules((current) => current.map((item) => item.id === schedule.id ? { ...item, enabled: !item.enabled, nextRunAt: !item.enabled ? nextScheduledRunAt(item) : item.nextRunAt } : item))}><span /></button><span>{schedule.enabled ? "Enabled" : "Disabled"}</span></label>
          <button type="button" className="secondary-button" onClick={(event) => openEditor(schedule, event.currentTarget)} aria-label={`Edit ${schedule.name}`}><Pencil size={12} />Edit</button>
          <button type="button" className="icon-button" disabled={!schedule.projectId || missingProject || schedule.scheduleMode === "daily"} aria-label={`Convert ${schedule.name} to workflow`} title={schedule.scheduleMode === "daily" ? "Daily times are supported in scheduled tasks, not workflows" : "Convert to a project workflow"} onClick={() => {
            try { onWorkflows([workflowFromSchedule(schedule, schedule.run ?? scheduleRunSnapshot(settings)), ...workflows]); }
            catch (reason) { setNotice(friendlyError(reason)); }
          }}><Workflow size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Delete ${schedule.name}`} onClick={async () => {
            if (await confirmDialog(`Delete the scheduled task “${schedule.name}”? It will stop running.`)) onSchedules((current) => current.filter((item) => item.id !== schedule.id));
          }}><Trash2 size={14} /></button>
        </div>
      </article>;
    })}</div> : <div className="scheduled-task-empty"><CalendarClock size={26} /><strong>No scheduled tasks exist</strong><span>Add a task to have a prompt run on a regular schedule.</span></div>}
    {scheduleRuns.length > 0 && <details className="scheduled-task-history"><summary>Recent runs <span>{Math.min(scheduleRuns.length, 10)}</span></summary><div className="schedule-run-list">{scheduleRuns.slice(0, 10).map((run) => <div key={run.id} className={run.status === "failed" ? "failed" : ""}>
      <span className={`status-orb ${run.status === "failed" ? "failed" : "ready"}`} /><span className="schedule-run-copy"><strong>{run.scheduleName} · {run.status === "failed" ? "Failed" : "Started"}</strong><small title={run.error}>{timeLabel(run.at)}{run.error ? ` · ${run.error}` : ""}</small></span>
      {run.threadId && onOpenRun && <button type="button" onClick={() => onOpenRun(run.threadId!)} aria-label={`Open run thread for ${run.scheduleName}`}><Play size={11} />Open</button>}
    </div>)}</div></details>}
    <button type="button" className="secondary-button scheduled-task-add" onClick={(event) => openEditor(undefined, event.currentTarget)}><Plus size={15} />Add a task</button>
    {visible && draft && rootRef.current && createPortal(<ScheduleEditor initial={draft} settings={settings} projects={projects} modelCatalogs={modelCatalogs} onDiscoverOpenRouterModels={onDiscoverOpenRouterModels} onClose={closeEditor} onSave={save} />, rootRef.current.closest(".app-shell") ?? rootRef.current)}
  </section>;
}

function ScheduleEditor({ initial, settings, projects, modelCatalogs, onDiscoverOpenRouterModels, onClose, onSave }: {
  initial: TaskDraft; settings: AppSettings; projects: Project[]; modelCatalogs?: Catalogs;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onClose: () => void; onSave: (value: TaskDraft) => string | null;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("[data-autofocus]")?.focus({ preventScroll: true });
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => onCloseRef.current(), 240);
    return () => window.clearTimeout(timer);
  }, [closing]);
  const close = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onCloseRef.current();
    else setClosing(true);
  };
  const projectMissing = draft.projectId !== CHATS && !projects.some((project) => project.id === draft.projectId);
  const providerUnsupported = !PROVIDERS.includes(draft.run.provider);
  const interval = Number(draft.interval);
  const minimum = draft.unit === "minutes" ? 5 : 1;
  const minutes = scheduleIntervalMinutes(interval, draft.unit);
  const validInterval = Number.isSafeInteger(interval) && interval >= minimum && Number.isSafeInteger(minutes) && Date.now() + minutes * 60_000 <= 8.64e15;
  const dailyTimes = normalizedDailyTimes(draft.dailyTimes);
  const validDailyTimes = dailyTimes.length > 0 && dailyTimes.length === draft.dailyTimes.length;
  const valid = Boolean(draft.name.trim() && draft.prompt.trim() && draft.run.model.trim() && !projectMissing && !providerUnsupported && (draft.scheduleMode === "daily" ? validDailyTimes : validInterval));
  const models: AppSelectOption[] = (modelCatalogs?.[draft.run.provider] ?? []).map((model) => ({ value: model.id, label: model.label, detail: model.detail, keywords: model.keywords, icon: <ProviderLogo provider={draft.run.provider} size={14} /> }));
  if (draft.run.model && !models.some((model) => model.value === draft.run.model)) models.unshift({ value: draft.run.model, label: draft.run.model, detail: "Current selection" });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || closing) return;
    const reason = onSave(draft);
    if (reason) setError(reason);
    else close();
  };
  return <dialog ref={dialogRef} role="dialog" aria-modal="true" className="scheduled-task-dialog" data-closing={closing || undefined} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
  }} onPointerDown={(event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  }}>
    <form className="scheduled-task-editor" onSubmit={submit} inert={closing}>
      <header><span className="scheduled-task-editor-icon"><CalendarClock size={20} /></span><div><h3 id={titleId}>{initial.id ? "Edit scheduled task" : "Create a scheduled task"}</h3><p>{initial.id ? "Update the details of your recurring prompt." : "Tell Mythra Code what to do and how often."}</p></div><button className="icon-button" type="button" aria-label="Close task editor" onClick={close}><X size={17} /></button></header>
      <div className="schedule-create scheduled-task-form">
        <div className="schedule-create-grid">
          <label className="scheduled-task-wide"><span>Task name</span><input data-autofocus required aria-label="Task name" value={draft.name} placeholder="Daily code review" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <div className="schedule-field"><span>Run in</span><AppSelectMenu ariaLabel="Task location" value={draft.projectId} selectedDisplay={projectMissing ? { label: "Missing project", detail: "Choose another location" } : undefined} options={[{ value: CHATS, label: "Chats", detail: "No project folder" }, ...projects.map((project) => ({ value: project.id, label: project.name, detail: project.path }))]} portal onChange={(projectId) => setDraft({ ...draft, projectId })} /></div>
          <div className="schedule-field"><span>Schedule</span><AppSelectMenu ariaLabel="Task schedule" value={draft.scheduleMode} options={[{ value: "interval", label: "Every X minutes / hours", detail: "Repeat at a regular interval" }, { value: "daily", label: "At specific times", detail: "One or more times each day" }]} portal onChange={(scheduleMode) => setDraft({ ...draft, scheduleMode: scheduleMode as TaskDraft["scheduleMode"] })} /></div>
          {draft.scheduleMode === "interval" ? <div className="schedule-field scheduled-task-wide"><span>Run every</span><div className="schedule-interval-inputs"><input type="number" required min={minimum} step={1} aria-label="Task interval" value={draft.interval} onChange={(event) => setDraft({ ...draft, interval: event.target.value })} /><AppSelectMenu ariaLabel="Task interval unit" value={draft.unit} options={[{ value: "minutes", label: "Minutes" }, { value: "hours", label: "Hours" }, { value: "days", label: "Days" }]} portal onChange={(unit) => setDraft({ ...draft, unit: unit as ScheduleIntervalUnit })} /></div><small>Minimum 5 minutes.</small></div>
            : <div className="schedule-field scheduled-task-wide"><span>Daily times</span><div className="scheduled-daily-times">{draft.dailyTimes.map((time, index) => <div className="scheduled-daily-time" key={index}><input type="time" required step={60} aria-label={`Daily time ${index + 1}`} value={time} onChange={(event) => setDraft({ ...draft, dailyTimes: draft.dailyTimes.map((value, at) => at === index ? event.target.value : value) })} /><button type="button" className="icon-button" aria-label={`Remove daily time ${index + 1}`} disabled={draft.dailyTimes.length === 1} onClick={() => setDraft({ ...draft, dailyTimes: draft.dailyTimes.filter((_, at) => at !== index) })}><Trash2 size={14} /></button></div>)}</div><button type="button" className="secondary-button scheduled-daily-add" onClick={() => setDraft({ ...draft, dailyTimes: [...draft.dailyTimes, ""] })}><Plus size={13} />Add a time</button><small>Every day in your device’s local time zone. Mythra Code must be open. Missed times run once when available, not all at once.</small>{!validDailyTimes && <small role="status">Choose a different, valid time for each entry.</small>}</div>}
          <div className="schedule-field"><span>Provider</span><AppSelectMenu ariaLabel="Task provider" value={draft.run.provider} selectedDisplay={providerUnsupported ? { label: providerDisplayName(draft.run.provider), detail: "Not supported for scheduled tasks" } : undefined} options={PROVIDERS.map((provider) => ({ value: provider, label: providerDisplayName(provider), icon: <ProviderLogo provider={provider} size={15} /> }))} portal onChange={(provider) => {
            try { setDraft({ ...draft, run: captureRun(settings, provider as Provider, modelCatalogs) }); setError(""); }
            catch (reason) { setError(friendlyError(reason)); }
          }} /></div>
          <div className="schedule-field"><span>Model</span><AppSelectMenu ariaLabel="Task model" value={draft.run.model} options={models} placeholder="Choose a model…" searchable={draft.run.provider === "openrouter" || models.length > 8} emptyMessage={draft.run.provider === "lmstudio" ? "No LM Studio models available" : "No models available"} onSearch={draft.run.provider === "openrouter" ? onDiscoverOpenRouterModels : undefined} portal onChange={(model) => setDraft({ ...draft, run: { ...draft.run, model } })} /></div>
          <div className="schedule-field scheduled-task-wide"><span>Each run</span><AppSelectMenu ariaLabel="Task thread behavior" value={draft.threadMode} options={[{ value: "new", label: "New thread each time" }, { value: "reuse", label: "Continue the same thread" }]} portal onChange={(threadMode) => setDraft({ ...draft, threadMode: threadMode as ScheduleThreadMode })} /></div>
        </div>
        <label className="schedule-prompt-control"><span>Prompt</span><textarea required spellCheck aria-label="Task prompt" value={draft.prompt} placeholder="What should the model do?" rows={5} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
        <div className="scheduled-task-enabled"><div><strong>Task is active</strong><small>{draft.enabled ? draft.scheduleMode === "daily" ? "Its first run is at the next chosen time." : "Its first run is scheduled after the chosen interval." : "Save it without running it until you enable it."}</small></div><button type="button" role="switch" aria-label="Task is active" aria-checked={draft.enabled} className={`toggle-switch ${draft.enabled ? "on" : ""}`} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}><span /></button></div>
        <p className="schedule-runtime-note"><Info size={13} />Mythra Code must be open. Scheduled runs use this task’s saved settings and do not ask for approvals.</p>
        {projectMissing && <p role="alert" className="scheduled-task-error">This project is no longer available. Choose Chats or another project.</p>}
        {providerUnsupported && <p role="alert" className="scheduled-task-error">Choose OpenAI, OpenRouter, or LM Studio for scheduled tasks.</p>}
        {error && <p role="alert" className="scheduled-task-error">{error}</p>}
      </div>
      <footer><button type="button" className="secondary-button" onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={!valid || closing}>{initial.id ? <Check size={14} /> : <Plus size={14} />}{initial.id ? "Save changes" : "Create task"}</button></footer>
    </form>
  </dialog>;
}
