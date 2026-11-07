import { create } from "zustand";
import type { Project, Thread } from "../../types";
import type { WorkflowDefinition } from "../workflows";
import { isVoiceInputLocked } from "../voiceInputLock";

/** `local`, or the fingerprint of a paired device. */
export type ActiveMachine = string;
export const LOCAL_MACHINE = "local";

/**
 * `leaving`: the old machine's content fades out, moving up.
 * `entering`: the new machine's content fades in, moving down.
 */
export type MachinePhase = "idle" | "leaving" | "entering";

interface ActiveMachineState {
  /** Where input goes. This changes the moment the user chooses. */
  machine: ActiveMachine;
  /** Kept so the header still names a device that has since been removed. */
  name: string | null;
  /** What is on screen. It catches up with `machine` once the old content has left. */
  shown: ActiveMachine;
  phase: MachinePhase;
  /** Whether Escape has a turn to stop on the machine on screen. */
  remoteRunning: boolean;
  remoteThreadOpen: boolean;
  remoteApprovals: number;
  /** The shown machine's other threads, from its last quiet look. */
  remoteElsewhere: { working: number; approvals: number };
  /** A file is being dragged over the window while another machine is shown. */
  remoteDropHover: boolean;
}

/**
 * Which machine the window is showing. Memory-only: every launch starts on this
 * device. Nothing ever moves this back to `local` except the user, so a lost
 * connection or removed access can't silently put them on the other machine.
 */
export const useActiveMachine = create<ActiveMachineState>(() => ({ machine: LOCAL_MACHINE, name: null, shown: LOCAL_MACHINE, phase: "idle", remoteRunning: false, remoteDropHover: false, remoteThreadOpen: false, remoteApprovals: 0, remoteElsewhere: { working: 0, approvals: 0 } }));

/** Same values as --lm-d-2 and --lm-d-3, which the keyframes run for. */
const LEAVE_MS = 160;
const ENTER_MS = 240;
const FIRST_FRAME_LIMIT_MS = 120;
let motionTimer: ReturnType<typeof setTimeout> | undefined;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Nothing here waits on the network: what comes in is whatever is already known. */
let motionRun = 0;
/** Timed from the frame a phase first paints, or the render before it would eat
 * into the fade. A hidden window draws no frames, so that wait has a limit too. */
function afterPhasePaints(run: number, next: () => void): void {
  let waited = false;
  const go = () => {
    if (waited || run !== motionRun) return;
    waited = true;
    clearTimeout(motionTimer);
    next();
  };
  requestAnimationFrame(go);
  motionTimer = setTimeout(go, FIRST_FRAME_LIMIT_MS);
}
function playSwitch(machine: ActiveMachine): void {
  clearTimeout(motionTimer);
  const run = ++motionRun;
  if (reducedMotion()) {
    useActiveMachine.setState({ shown: machine, phase: "idle" });
    return;
  }
  // Switching mid-fade keeps the same content on its way out.
  useActiveMachine.setState({ phase: "leaving" });
  afterPhasePaints(run, () => {
    motionTimer = setTimeout(() => {
      useActiveMachine.setState({ shown: machine, phase: "entering" });
      afterPhasePaints(run, () => { motionTimer = setTimeout(() => useActiveMachine.setState({ phase: "idle" }), ENTER_MS); });
    }, LEAVE_MS);
  });
}

/** What global paths do while another machine is on screen. The remote view
 * registers these, so nothing outside it has to load remote code to route. */
export interface MachineActions {
  newThread(): void;
  stopTurn(): void;
  forkThread(): void;
  findInConversation(): void;
  exportTranscript(): void;
  runWorkflow(id: string): void;
  palette(): { projects: Project[]; threads: Thread[]; workflows: WorkflowDefinition[] };
  openProject(id: string): void;
  openThread(id: string): void;
  /** Files dropped on the window while this machine is shown. */
  dropFiles(paths: readonly string[]): void;
  /** Attaches a file from this machine's project to the message being written. */
  attachHostFile(fileId: string): void;
}
let machineActionsNow: MachineActions | null = null;
export function setMachineActions(actions: MachineActions | null): void {
  machineActionsNow = actions;
}
export function machineActions(): MachineActions | null {
  return machineActionsNow;
}

let generation = 0;

/** For code outside React that must not resubscribe when this changes. */
export function isRemoteMachineActive(): boolean {
  return useActiveMachine.getState().machine !== LOCAL_MACHINE;
}

/** Pending local navigation cannot take over after any switch. */
export function machineSwitchGeneration(): number {
  return generation;
}

/** Light-dismiss surfaces opened from local UI live outside its inert boundary.
 * Modal dialogs can't be open here: they block the switcher that got us here. */
function dismissLocalSurfaces(): void {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  // The selector below is a syntax error where popovers don't exist.
  if (typeof HTMLElement.prototype.showPopover !== "function") return;
  for (const element of document.querySelectorAll<HTMLElement>("[popover]:popover-open")) {
    if (!element.classList.contains("app-toast")) element.hidePopover();
  }
}

/** False while voice owns input: switching would pull the recorder away. */
export function switchMachine(machine: ActiveMachine, name: string | null = null): boolean {
  if (isVoiceInputLocked()) return false;
  if (useActiveMachine.getState().machine === machine) return true;
  generation += 1;
  if (machine !== LOCAL_MACHINE) dismissLocalSurfaces();
  useActiveMachine.setState({ machine, name });
  playSwitch(machine);
  return true;
}

/** Desktop notifications report no click, so each also appears in the app with
 * an Open action. Only that action switches machines: focus alone never does. */
export interface RemoteNotice { id: string; machine: ActiveMachine; name: string | null; title: string; body: string; open: () => void }
const MAX_NOTICES = 4;
export const useRemoteNotices = create<{ notices: RemoteNotice[] }>(() => ({ notices: [] }));
export function addRemoteNotice(notice: RemoteNotice): void {
  useRemoteNotices.setState(({ notices }) => ({ notices: [...notices.filter((entry) => entry.id !== notice.id), notice].slice(-MAX_NOTICES) }));
}
export function dismissRemoteNotice(id: string): void {
  useRemoteNotices.setState(({ notices }) => ({ notices: notices.filter((entry) => entry.id !== id) }));
}
export function openRemoteNotice(notice: RemoteNotice): void {
  dismissRemoteNotice(notice.id);
  if (switchMachine(notice.machine, notice.name)) notice.open();
}
