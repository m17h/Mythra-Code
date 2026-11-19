// The contract between the app window and the hidden theme preview
// (src/themePreview, src-tauri/src/theme_preview.rs). A job names one exact
// theme revision, a view and the window's measurements. It never carries
// user content: no transcript, file, project, thread or account data.

import type { BuiltInChatFont, ChatFont, ClaudeLogoStyle, CursorLogoStyle, EffortSliderStyle, OpenAILogoStyle, Provider, ThemeName } from "../../types";
import type { CustomThemeId, ThemeSpec } from "./spec";

export const PREVIEW_VIEWS = ["conversation", "changes"] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

export const PREVIEW_VIEW_DESCRIPTIONS: Record<PreviewView, string> = {
  conversation: "sidebar, top bar, a sample conversation and the composer",
  changes: "the same window with Tools open on Changes, showing a sample diff",
};

/** How the app window is laid out right now (sizes and look only, no content). */
export interface PreviewEnvironment {
  /** The window's CSS size. */
  viewport: { width: number; height: number };
  /** 1 = 100%. */
  uiScale: number;
  /** The saved preferences in shell pixels, before fitting to a window. */
  panes: { sidebar: number; dock: number; dockAuto: boolean; sidebarOpen: boolean };
  chatFont: BuiltInChatFont;
  effortSlider: EffortSliderStyle;
  logos: { openai: OpenAILogoStyle; claude: ClaudeLogoStyle; cursor: CursorLogoStyle };
  /** Whether the person sees theme animations, and why not when not. */
  motion: { animate: boolean; paused: boolean; reducedMotion: boolean };
}

export interface PreviewJob extends PreviewEnvironment {
  version: 1;
  view: PreviewView;
  /** A picture is wanted; otherwise only the layout report is measured. */
  capture: boolean;
  /** Tints the composer and picks its model control. */
  provider: Provider;
  theme: { base: ThemeName; custom: { id: CustomThemeId; revision: number; spec: ThemeSpec } | null };
}

export interface PreviewImage { mimeType: "image/png"; data: string; width: number; height: number }

export interface PreviewResult {
  layout: Record<string, unknown> | null;
  /** The preview window's CSS size as drawn. */
  viewport: { width: number; height: number } | null;
  image?: PreviewImage;
  /** Why no picture came back although one was asked for. */
  imageError?: string;
}

export type PreviewOutcome =
  | { ok: true; result: PreviewResult }
  | { ok: false; error: string; unavailable?: boolean };

/** Built-in fonts only: a custom font is a user file the preview never reads. */
export function previewChatFont(font: ChatFont): BuiltInChatFont {
  return font.startsWith("custom:") ? "system" : font as BuiltInChatFont;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function readSize(value: unknown): { width: number; height: number } | null {
  if (!isObject(value)) return null;
  const { width, height } = value;
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0
    || typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) return null;
  return { width, height };
}

/** The native result of `theme_preview_capture`, checked before use. */
export function parsePreviewResult(value: unknown): PreviewResult | null {
  if (!isObject(value)) return null;
  const layout = isObject(value.layout) ? value.layout : null;
  const viewport = readSize(value.viewport);
  const result: PreviewResult = { layout, viewport };
  const image = value.image;
  const picture = readSize(image);
  if (picture && isObject(image) && image.mimeType === "image/png" && typeof image.data === "string" && image.data) {
    result.image = { mimeType: "image/png", data: image.data, ...picture };
  }
  if (typeof value.imageError === "string" && value.imageError.trim()) result.imageError = value.imageError.slice(0, 200);
  return layout || viewport || result.image || result.imageError ? result : null;
}

/** The handoff the preview page takes from `theme_preview_job`, checked before use. */
export function parsePreviewHandoff(value: unknown): { nonce: string; job: PreviewJob } | null {
  if (!isObject(value) || typeof value.nonce !== "string" || !value.nonce || !isObject(value.job)) return null;
  const job = value.job;
  if (job.version !== 1 || !PREVIEW_VIEWS.includes(job.view as PreviewView) || !isObject(job.theme)
    || typeof job.capture !== "boolean" || !readSize(job.viewport) || !isObject(job.panes)
    || !isObject(job.motion) || !isObject(job.logos)) return null;
  const custom = job.theme.custom;
  if (custom !== null && (!isObject(custom) || typeof custom.id !== "string"
    || typeof custom.revision !== "number" || !Number.isSafeInteger(custom.revision) || custom.revision < 1
    || !isObject(custom.spec) || custom.spec.base !== job.theme.base)) return null;
  return { nonce: value.nonce, job: job as unknown as PreviewJob };
}
