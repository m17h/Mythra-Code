import { invoke } from "@tauri-apps/api/core";
import type { OfficialPricingSource } from "./officialPricing";

// These fixed public documents explicitly allow cross-origin browser reads.
// Use the webview's networking rather than a separate native HTTP client.
// No cookies, account credentials, arbitrary URLs, or challenge handling.
const OPENAI_PRICING_DOCUMENT = "https://developers.openai.com/api/docs/pricing.md";
const OPENAI_DEPRECATIONS_DOCUMENT = "https://developers.openai.com/api/docs/deprecations.md";
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DOCUMENT_TIMEOUT_MS = 20_000;

async function readOpenAIDocument(url: typeof OPENAI_PRICING_DOCUMENT | typeof OPENAI_DEPRECATIONS_DOCUMENT): Promise<string> {
  const page = url === OPENAI_PRICING_DOCUMENT ? "pricing page" : "model deprecations page";
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(response.status === 403
        ? `OpenAI declined the request for its ${page} (HTTP 403). Try again later.`
        : `OpenAI’s ${page} returned HTTP ${response.status}. Try again later.`);
    }
    if (response.url !== url) throw new Error(`The ${page} moved to an unexpected address.`);
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mime?.startsWith("text/") || mime === "text/html") throw new Error(`The ${page} was not returned as text.`);
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_DOCUMENT_BYTES) throw new Error(`The ${page} was unexpectedly large.`);
    if (!response.body) throw new Error(`The ${page} was empty.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_DOCUMENT_BYTES) throw new Error(`The ${page} was unexpectedly large.`);
        try {
          text += decoder.decode(value, { stream: true });
        } catch {
          throw new Error(`The ${page} was not UTF-8 text.`);
        }
      }
      try {
        return text + decoder.decode();
      } catch {
        throw new Error(`The ${page} was not UTF-8 text.`);
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Reading OpenAI’s ${page} took too long. Try again.`);
    if (error instanceof TypeError) throw new Error(`Couldn’t read OpenAI’s ${page}. Check your connection or open the official page.`);
    throw error;
  } finally {
    window.clearTimeout(timer);
    // Also stops an unread error/oversized response; no abandoned body stream.
    controller.abort();
  }
}

export function fetchPricingDocument(source: OfficialPricingSource): Promise<string> {
  return source === "openai" ? readOpenAIDocument(OPENAI_PRICING_DOCUMENT) : invoke<string>("fetch_pricing_document", { source });
}

export function fetchModelLifecycleDocument(source: "openai" | "anthropic"): Promise<string> {
  return source === "openai" ? readOpenAIDocument(OPENAI_DEPRECATIONS_DOCUMENT)
    : invoke<string>("fetch_pricing_document", { source: "anthropic-model-status" });
}
