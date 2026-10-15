import { invoke } from "@tauri-apps/api/core";
import type { OfficialPricingSource } from "./officialPricing";

// This fixed public document explicitly allows cross-origin browser reads.
// Use the webview's networking rather than a separate native HTTP client.
// No cookies, account credentials, arbitrary URLs, or challenge handling.
const OPENAI_PRICING_DOCUMENT = "https://developers.openai.com/api/docs/pricing.md";
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DOCUMENT_TIMEOUT_MS = 20_000;

async function readOpenAIPricing(): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_PRICING_DOCUMENT, {
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(response.status === 403
        ? "OpenAI declined the pricing request (HTTP 403). Try again later or open the official pricing page."
        : `OpenAI’s pricing page returned HTTP ${response.status}. Try again later.`);
    }
    if (response.url !== OPENAI_PRICING_DOCUMENT) throw new Error("The pricing page moved to an unexpected address.");
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mime?.startsWith("text/") || mime === "text/html") throw new Error("The pricing page was not returned as text.");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_DOCUMENT_BYTES) throw new Error("The pricing page was unexpectedly large.");
    if (!response.body) throw new Error("The pricing page was empty.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_DOCUMENT_BYTES) throw new Error("The pricing page was unexpectedly large.");
        try {
          text += decoder.decode(value, { stream: true });
        } catch {
          throw new Error("The pricing page was not UTF-8 text.");
        }
      }
      try {
        return text + decoder.decode();
      } catch {
        throw new Error("The pricing page was not UTF-8 text.");
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("OpenAI’s pricing check took too long. Try again.");
    if (error instanceof TypeError) throw new Error("Couldn’t read OpenAI’s pricing page. Check your connection or open the official pricing page.");
    throw error;
  } finally {
    window.clearTimeout(timer);
    // Also stops an unread error/oversized response; no abandoned body stream.
    controller.abort();
  }
}

export function fetchPricingDocument(source: OfficialPricingSource): Promise<string> {
  return source === "openai" ? readOpenAIPricing() : invoke<string>("fetch_pricing_document", { source });
}
