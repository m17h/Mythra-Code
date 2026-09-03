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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_receipt_at_every_possible_chunk_boundary() {
        let input = b"event: response.completed\r\ndata: {\"response\":{\"id\":\"gen-1\",\"usage\":{\"cost\":0.125,\"cost_details\":{\"upstream_inference_cost\":9}}}}\r\n\r\n";
        for split in 0..=input.len() {
            let mut observer = ReceiptObserver::new(true);
            let first = observer.push(&input[..split]);
            let second = observer.push(&input[split..]);
            assert_eq!(
                first.or(second),
                Some(serde_json::json!({"id":"gen-1","cost":0.125}))
            );
            assert!(observer.push(input).is_none());
        }
    }

    #[test]
    fn missing_invalid_or_upstream_only_costs_are_not_free_receipts() {
        for usage in [
            "{}",
            "{\"cost\":null}",
            "{\"cost\":\"0.1\"}",
            "{\"cost\":-1}",
            "{\"cost_details\":{\"upstream_inference_cost\":5}}",
        ] {
            let payload = format!("data: {{\"id\":\"gen-1\",\"usage\":{usage}}}\n\n");
            assert!(ReceiptObserver::new(true)
                .push(payload.as_bytes())
                .is_none());
        }
        assert_eq!(
            ReceiptObserver::new(false).push(b"{\"id\":\"gen-free\",\"usage\":{\"cost\":0}}"),
            Some(serde_json::json!({"id":"gen-free","cost":0.0}))
        );
    }

    #[test]
    fn oversized_frames_are_bounded_and_do_not_hide_later_receipts() {
        let mut observer = ReceiptObserver::new(true);
        assert!(observer.push(&vec![b'x'; MAX_FRAME_BYTES * 2]).is_none());
        assert!(observer.buffer.len() <= MAX_FRAME_BYTES);
        assert!(observer
            .push(b"\ndata: {\"id\":\"gen-2\",\"usage\":{\"cost\":0.5}}\n")
            .is_some());
        let mut json = ReceiptObserver::new(false);
        assert!(json.push(&vec![b'x'; MAX_FRAME_BYTES * 2]).is_none());
        assert!(json
            .push(b"{\"id\":\"gen-2\",\"usage\":{\"cost\":0.5}}")
            .is_none());
    }

    #[test]
    fn ignores_provisional_usage_and_accepts_the_terminal_receipt() {
        let mut observer = ReceiptObserver::new(true);
        assert!(observer.push(b"data: {\"type\":\"response.created\",\"response\":{\"id\":\"gen\",\"usage\":{\"cost\":0}}}\n\n").is_none());
        assert_eq!(observer.push(b"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"gen\",\"usage\":{\"input_tokens\":168,\"output_tokens\":2,\"total_tokens\":170,\"cost\":0,\"is_byok\":false}}}\n\n"), Some(serde_json::json!({"id":"gen","cost":0.0})));
    }

    #[test]
    fn non_streaming_receipt_survives_fragmentation() {
        let bytes =
            "{\"id\":\"gen-json\",\"output_text\":\"✓\",\"usage\":{\"cost\":0.01}}".as_bytes();
        for split in 0..=bytes.len() {
            let mut observer = ReceiptObserver::new(false);
            let first = observer.push(&bytes[..split]);
            let second = observer.push(&bytes[split..]);
            assert_eq!(
                first.or(second),
                Some(serde_json::json!({"id":"gen-json","cost":0.01}))
            );
        }
    }
}
