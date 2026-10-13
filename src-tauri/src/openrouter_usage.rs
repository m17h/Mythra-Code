//! Best-effort receipt observation. Forwarded bytes are never changed or held
//! until a complete event, and oversized frames are ignored with bounded memory.
use serde_json::Value;

const MAX_FRAME_BYTES: usize = 256 * 1024;

pub struct ReceiptObserver {
    buffer: Vec<u8>,
    oversized: bool,
    sse: bool,
    emitted: bool,
}

impl ReceiptObserver {
    pub fn new(sse: bool) -> Self {
        Self {
            buffer: Vec::new(),
            oversized: false,
            sse,
            emitted: false,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Option<Value> {
        if self.emitted {
            return None;
        }
        if !self.sse {
            if self.buffer.len().saturating_add(bytes.len()) > MAX_FRAME_BYTES {
                self.buffer.clear();
                self.oversized = true;
            } else if !self.oversized {
                self.buffer.extend_from_slice(bytes);
                if let Some(receipt) = parse_receipt(&self.buffer) {
                    self.emitted = true;
                    return Some(receipt);
                }
            }
            return None;
        }
        // SSE JSON occupies a data line. Both LF and CRLF and arbitrary byte
        // boundaries are supported; raw bytes avoid splitting UTF-8 characters.
        for &byte in bytes {
            if byte == b'\n' {
                let receipt = if !self.oversized {
                    self.buffer.strip_prefix(b"data:").and_then(parse_receipt)
                } else {
                    None
                };
                self.buffer.clear();
                self.oversized = false;
                if receipt.is_some() {
                    self.emitted = true;
                    return receipt;
                }
            } else if !self.oversized {
                if self.buffer.len() >= MAX_FRAME_BYTES {
                    self.buffer.clear();
                    self.oversized = true;
                } else {
                    self.buffer.push(byte);
                }
            }
        }
        None
    }
}

fn parse_receipt(bytes: &[u8]) -> Option<Value> {
    // Almost every frame is text/tool output. Avoid JSON allocation for those.
    if !bytes.windows(7).any(|window| window == b"\"usage\"") {
        return None;
    }
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if let Some(kind) = value.get("type").and_then(Value::as_str) {
        if kind.starts_with("response.")
            && !matches!(
                kind,
                "response.completed" | "response.failed" | "response.incomplete"
            )
        {
            return None;
        }
    }
    // Mythra uses Responses, but also tolerate a Chat Completions receipt.
    let response = value.get("response").unwrap_or(&value);
    let id = response.get("id")?.as_str()?;
    if id.trim().is_empty() || id.len() > 240 {
        return None;
    }
    let cost = response.pointer("/usage/cost")?.as_f64()?;
    if !cost.is_finite() || cost < 0.0 {
        return None;
    }
    Some(serde_json::json!({ "id": id, "cost": cost }))
}
