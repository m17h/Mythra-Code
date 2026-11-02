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
let pendingImports = 0;
let fonts: CustomChatFont[] | undefined;
const listeners = new Set<() => void>();

function sanitize(value: unknown): CustomChatFont[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const seenFiles = new Set<string>();
  const result: CustomChatFont[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, source } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,64}$/.test(id) || seen.has(id)) continue;
    if (typeof name !== "string" || !name.trim()) continue;
    if (source === "file") {
      const file = (entry as { file?: unknown }).file;
      if (typeof file !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:ttf|otf|woff2?)$/.test(file) || seenFiles.has(file)) continue;
      seenFiles.add(file);
      result.push({ id, name: name.trim().slice(0, 60), source, file });
    } else if (source === "installed" && typeof (entry as { family?: unknown }).family === "string") {
      const family = cleanFamily((entry as { family: string }).family);
      if (!family) continue;
      result.push({ id, name: name.trim().slice(0, 60), source, family });
    } else continue;
    seen.add(id);
    if (result.length === MAX_FONTS) break;
  }
  return result;
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

/** Normalize family names; quote them separately so punctuation remains valid. */
function cleanFamily(family: string): string {
  return family.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function quotedFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}"`;
}

function fontFamily(font: CustomChatFont): string {
  return font.source === "file" ? `Mythra Custom ${font.id}` : font.family;
}

/** The CSS font stack for a custom font, falling back to the interface font. */
export function customFontStack(font: CustomChatFont): string {
  return `${quotedFamily(fontFamily(font))}, var(--font-sans)`;
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

type FileFontLoad = { file: string; promise: Promise<void>; face?: FontFace };
const loads = new Map<string, FileFontLoad>();

function forgetFontFace(id: string): void {
  const entry = loads.get(id);
  loads.delete(id);
  if (entry?.face && document.fonts.delete(entry.face)) {
    document.dispatchEvent(new Event("mythra-custom-fonts-changed"));
  }
}

/** Register a file font with the document once; installed fonts need nothing. */
export function ensureCustomFontLoaded(font: CustomChatFont): Promise<void> {
  if (font.source !== "file" || !isTauri() || typeof FontFace === "undefined") return Promise.resolve();
  const existing = loads.get(font.id);
  if (existing?.file === font.file) return existing.promise;
  if (existing) forgetFontFace(font.id);
  const entry: FileFontLoad = {
    file: font.file,
    promise: invoke<ArrayBuffer>("custom_font_read", { file: font.file })
      .then(async (bytes) => {
        // Removal or replacement may finish while IPC or parsing is pending.
        if (loads.get(font.id) !== entry) return;
        const face = new FontFace(fontFamily(font), bytes, { display: "swap" });
        entry.face = face;
        // Let the document track loading and use fallback text until ready.
        document.fonts.add(face);
        await face.load();
        // Binary sources may finish before FontFaceSet sees a loading cycle.
        if (loads.get(font.id) === entry) document.dispatchEvent(new Event("mythra-custom-fonts-changed"));
      })
      .catch((reason) => {
        if (loads.get(font.id) === entry) forgetFontFace(font.id);
        throw reason;
      }),
  };
  loads.set(font.id, entry);
  return entry.promise;
}

/** Load a visible picker library or the app's selected custom font. */
export function useCustomFontFaces(library: CustomChatFont[], enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    for (const font of library) void ensureCustomFontLoaded(font).catch(() => {});
  }, [library, enabled]);
}

function newId(): string {
  return (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).toLowerCase();
}

/** Copy a chosen font file into app data and add it to the library. */
export async function importCustomFontFile(path: string): Promise<CustomChatFont> {
  if (snapshot().length + pendingImports >= MAX_FONTS) throw new Error(`You can add up to ${MAX_FONTS} custom fonts.`);
  pendingImports += 1;
  try {
    const imported = await invoke<{ file: string; name: string }>("custom_font_import", { path });
    const font: CustomChatFont = { id: newId(), name: imported.name, source: "file", file: imported.file };
    try {
      await ensureCustomFontLoaded(font);
    } catch (reason) {
      forgetFontFace(font.id);
      void invoke("custom_font_remove", { file: imported.file }).catch(() => {});
      throw new Error(`That font file could not be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    publish([...snapshot(), font]);
    return font;
  } finally {
    pendingImports -= 1;
  }
}

/** Add a font that is already installed on this computer, by family name. */
export function addInstalledCustomFont(familyName: string): CustomChatFont {
  const family = cleanFamily(familyName);
  if (!family) throw new Error("Type the name of a font installed on this computer.");
  const existing = snapshot().find((font) => font.source === "installed" && font.family.toLowerCase() === family.toLowerCase());
  if (existing) return existing;
  if (snapshot().length + pendingImports >= MAX_FONTS) throw new Error(`You can add up to ${MAX_FONTS} custom fonts.`);
  const font: CustomChatFont = { id: newId(), name: family, source: "installed", family };
  publish([...snapshot(), font]);
  return font;
}

export async function removeCustomFont(id: string): Promise<void> {
  const font = snapshot().find((entry) => entry.id === id);
  if (!font) return;
  // Keep the entry available for a retry when deleting the stored file fails.
  if (font.source === "file" && isTauri()) await invoke("custom_font_remove", { file: font.file });
  publish(snapshot().filter((entry) => entry.id !== id));
  forgetFontFace(id);
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
  if (!context) return false;
  const sample = "mmmmmmmmmmlliWW@#0123";
  return ["monospace", "serif"].some((fallback) => {
    context.font = `32px ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `32px ${quotedFamily(family)}, ${fallback}`;
    return Math.abs(context.measureText(sample).width - base) > 0.5;
  });
}
