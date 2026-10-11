export interface ProjectTerminalSnapshot {
  scope: string;
  available: boolean;
  running: boolean;
  command: string;
  text: string;
  truncated: boolean;
  retainedCharacters: number;
  generation: number;
  lifetime: "app-session";
}

/** Incremental state prevents chunk splits or raw scrollback trimming from exposing string payloads. */
export function createTerminalSnapshotSanitizer(): (value: string) => string {
  let mode: "text" | "escape" | "escape-intermediate" | "csi" | "string" = "text";
  let osc = false;
  return (value) => {
    const result: string[] = [];
    for (const character of value) {
      const code = character.charCodeAt(0);
      // ESC starts a fresh instruction even inside CSI/OSC/DCS; CAN and SUB
      // cancel the interrupted instruction. These transitions also apply when
      // the control byte and the next visible text arrive in separate chunks.
      if (code === 0x1b) { mode = "escape"; continue; }
      if (code === 0x18 || code === 0x1a) { mode = "text"; continue; }
      // The equivalent C1 instructions also replace an interrupted sequence.
      if (code === 0x9b) { mode = "csi"; continue; }
      if ([0x9d, 0x90, 0x9f, 0x9e, 0x98].includes(code)) { mode = "string"; osc = code === 0x9d; continue; }
      if (code === 0x9c) { mode = "text"; continue; }
      // Executable C0 controls do not cancel an escape/CSI instruction. Keep
      // the plain layout controls while ignoring the others and DEL.
      if (mode !== "string" && (code < 0x20 || code === 0x7f)) {
        if (code === 0x09 || code === 0x0a || code === 0x0d) result.push(character);
        continue;
      }
      if (mode === "string") {
        if (osc && code === 0x07) mode = "text";
      } else if (mode === "csi") {
        if (code >= 0x40 && code <= 0x7e) mode = "text";
      } else if (mode === "escape" || mode === "escape-intermediate") {
        if (mode === "escape" && code === 0x5b) mode = "csi";
        else if (mode === "escape" && [0x5d, 0x50, 0x5f, 0x5e, 0x58].includes(code)) { mode = "string"; osc = code === 0x5d; }
        else if (code >= 0x20 && code <= 0x2f) mode = "escape-intermediate";
        else mode = "text";
      } else if (code >= 0x20 && (code < 0x7f || code > 0x9f)) result.push(character);
    }
    return result.join("");
  };
}

/** Strip complete or incomplete instructions from a standalone value. */
export function terminalSnapshotText(value: string): string {
  return createTerminalSnapshotSanitizer()(value);
}

export function terminalSnapshotLimit(value = 12_000): number {
  return Number.isFinite(value) ? Math.min(20_000, Math.max(1, Math.trunc(value))) : 12_000;
}

/** UTF-16 limits may omit a whole surrogate pair but never return half of one. */
export function terminalSnapshotTail(value: string, characters: number): string {
  let start = Math.max(0, value.length - Math.max(0, characters));
  if (value.charCodeAt(start) >= 0xdc00 && value.charCodeAt(start) <= 0xdfff) start += 1;
  let end = value.length;
  if (value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return value.slice(start, Math.max(start, end));
}

export function terminalSnapshotPrefix(value: string, characters: number): string {
  let end = Math.min(value.length, characters);
  if (value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
