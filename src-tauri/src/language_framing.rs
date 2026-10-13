//! One bounded frame reader shared by probes and short-lived query sessions.
//! Keep the BufReader alive for the process lifetime: it may already contain
//! part of the next message when the current response completes.
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

pub(super) async fn read_message<R: AsyncBufRead + Unpin>(
    output: &mut R,
    max_message: usize,
) -> Result<Value, String> {
    let mut header = Vec::new();
    loop {
        let available = output
            .fill_buf()
            .await
            .map_err(|_| "The language server exited before answering.")?;
        if available.is_empty() {
            return Err("The language server exited before answering.".into());
        }
        let mut consumed = 0;
        for byte in available {
            if header.len() == 4096 {
                return Err("The language server returned an oversized protocol header.".into());
            }
            header.push(*byte);
            consumed += 1;
            if header.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        output.consume(consumed);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header_text = String::from_utf8_lossy(&header);
    let mut lengths = header_text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.eq_ignore_ascii_case("Content-Length"))
        .map(|(_, value)| value.trim().parse::<usize>());
    let length = lengths
        .next()
        .and_then(Result::ok)
        .filter(|n| *n <= max_message)
        .ok_or("The language server returned an invalid or oversized protocol message.")?;
    if lengths.next().is_some() {
        return Err("The language server returned duplicate protocol lengths.".into());
    }
    let mut body = vec![0; length];
    output
        .read_exact(&mut body)
        .await
        .map_err(|_| "The language server returned an incomplete protocol message.")?;
    serde_json::from_slice(&body).map_err(|_| "The language server returned invalid JSON.".into())
}
