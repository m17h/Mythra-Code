import { useEffect, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { loadStored, storeValue } from "./storage";
import type { ChatFont } from "../types";

/**
 * Custom chat fonts the user adds. A per-device library that applies at once
 * (choosing one as the chat font still goes through Settings > Save).
 * - "file": a .ttf/.otf/.woff/.woff2 copied into app data by the backend
 *   (custom_fonts.rs), registered at runtime with the FontFace API.
 * - "installed": a font family already installed on this computer, by name.
 * A chat font id for either is `custom:<id>`.
 */
export type CustomChatFont =
  | { id: string; name: string; source: "file"; file: string }
  | { id: string; name: string; source: "installed"; family: string };

const KEY = "kiwi.customFonts";
const MAX_FONTS = 24;
let fonts: CustomChatFont[] | undefined;
const listeners = new Set<() => void>();

function sanitize(value: unknown): CustomChatFont[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: CustomChatFont[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, source } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,64}$/.test(id) || seen.has(id)) continue;
    if (typeof name !== "string" || !name.trim()) continue;
    if (source === "file" && typeof (entry as { file?: unknown }).file === "string") {
      result.push({ id, name: name.trim().slice(0, 60), source, file: (entry as { file: string }).file });
    } else if (source === "installed" && typeof (entry as { family?: unknown }).family === "string") {
      const family = cleanFamily((entry as { family: string }).family);
      if (family) result.push({ id, name: name.trim().slice(0, 60), source, family });
    } else continue;
    seen.add(id);
  }
  return result.slice(0, MAX_FONTS);
}

function snapshot(): CustomChatFont[] {
  return fonts ??= sanitize(loadStored<unknown>(KEY, []));
}

function publish(next: CustomChatFont[]): void {
  fonts = next;
  storeValue(KEY, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const EMPTY: CustomChatFont[] = [];
export function useCustomFonts(): CustomChatFont[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

export function customChatFontId(font: Pick<CustomChatFont, "id">): ChatFont {
  return `custom:${font.id}`;
}

export function customFontFor(chatFont: ChatFont, library: CustomChatFont[]): CustomChatFont | undefined {
  return chatFont.startsWith("custom:") ? library.find((font) => font.id === chatFont.slice(7)) : undefined;
}

/** Strip characters that could break out of a quoted CSS font-family name. */
function cleanFamily(family: string): string {
  return family.replace(/["'\\;{}<>\n\r\t]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function fontFamily(font: CustomChatFont): string {
  return font.source === "file" ? `Mythra Custom ${font.id}` : font.family;
}

/** The CSS font stack for a custom font, falling back to the interface font. */
export function customFontStack(font: CustomChatFont): string {
  return `"${fontFamily(font)}", var(--font-sans)`;
}

/**
 * The --chat-font value for any chat font id: built-ins resolve through the
 * --chat-font-<id> variables in styles.css; a custom id uses its own stack,
 * and a missing custom font falls back to the interface font.
 */
export function chatFontCss(chatFont: ChatFont, library: CustomChatFont[]): string {
  if (!chatFont.startsWith("custom:")) return `var(--chat-font-${chatFont})`;
  const font = customFontFor(chatFont, library);
  return font ? customFontStack(font) : "var(--chat-font-system)";
}

const loads = new Map<string, Promise<void>>();

/** Register a file font with the document once; installed fonts need nothing. */
export function ensureCustomFontLoaded(font: CustomChatFont): Promise<void> {
  if (font.source !== "file" || !isTauri() || typeof FontFace === "undefined") return Promise.resolve();
  const existing = loads.get(font.id);
  if (existing) return existing;
  const load = invoke<ArrayBuffer>("custom_font_read", { file: font.file })
    .then(async (bytes) => {
      const face = new FontFace(fontFamily(font), bytes);
      await face.load();
      document.fonts.add(face);
    })
    .catch((reason) => {
      loads.delete(font.id);
      throw reason;
    });
  loads.set(font.id, load);
  return load;
}

/** Keep every file font in the library registered (used by the app shell). */
export function useCustomFontFaces(library: CustomChatFont[]): void {
  useEffect(() => {
    for (const font of library) void ensureCustomFontLoaded(font).catch(() => {});
  }, [library]);
}

function newId(): string {
  return (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).toLowerCase();
}

/** Copy a chosen font file into app data and add it to the library. */
export async function importCustomFontFile(path: string): Promise<CustomChatFont> {
  if (snapshot().length >= MAX_FONTS) throw new Error(`You can add up to ${MAX_FONTS} custom fonts.`);
  const imported = await invoke<{ file: string; name: string }>("custom_font_import", { path });
  const font: CustomChatFont = { id: newId(), name: imported.name, source: "file", file: imported.file };
  try {
    await ensureCustomFontLoaded(font);
  } catch (reason) {
    void invoke("custom_font_remove", { file: imported.file }).catch(() => {});
    throw new Error(`That font file could not be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
  publish([...snapshot(), font]);
  return font;
}

/** Add a font that is already installed on this computer, by family name. */
export function addInstalledCustomFont(familyName: string): CustomChatFont {
  const family = cleanFamily(familyName);
  if (!family) throw new Error("Type the name of a font installed on this computer.");
  if (snapshot().length >= MAX_FONTS) throw new Error(`You can add up to ${MAX_FONTS} custom fonts.`);
  const existing = snapshot().find((font) => font.source === "installed" && font.family.toLowerCase() === family.toLowerCase());
  if (existing) return existing;
  const font: CustomChatFont = { id: newId(), name: family, source: "installed", family };
  publish([...snapshot(), font]);
  return font;
}

export async function removeCustomFont(id: string): Promise<void> {
  const font = snapshot().find((entry) => entry.id === id);
  if (!font) return;
  publish(snapshot().filter((entry) => entry.id !== id));
  loads.delete(id);
  if (font.source === "file" && isTauri()) await invoke("custom_font_remove", { file: font.file });
}

/**
 * Whether a family name resolves to an installed font. The browser has no
 * font list, so compare text widths against two generic fallbacks: an
 * installed font changes the width of at least one of them.
 */
export function isFontInstalled(familyName: string): boolean {
  const family = cleanFamily(familyName);
  if (!family || typeof document === "undefined") return false;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return true;
  const sample = "mmmmmmmmmmlliWW@#0123";
  return ["monospace", "serif"].some((fallback) => {
    context.font = `32px ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `32px "${family}", ${fallback}`;
    return Math.abs(context.measureText(sample).width - base) > 0.5;
  });
}
