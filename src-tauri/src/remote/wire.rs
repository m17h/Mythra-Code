//! Framed JSON: a 4-byte big-endian length, then UTF-8 JSON. Everything read
//! here is hostile until proven otherwise.

use std::io;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::timeout;

pub(crate) const PROTO: u32 = 1;
pub(crate) const MAX_FRAME: usize = 2 * 1024 * 1024;
/// Until the peer has finished `hello` and been classified, no frame needs to
/// be big. This stops strangers making the host buffer 2 MiB per connection.
pub(crate) const PREAUTH_MAX_FRAME: usize = 16 * 1024;
const READ_CHUNK: usize = 64 * 1024;
/// Once a frame has started it must arrive whole within this time, so a peer
/// cannot hold a read open by trickling bytes.
const FRAME_ARRIVAL_LIMIT: Duration = Duration::from_secs(30);
pub(crate) const MAX_NAME_CHARS: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Role {
    Host,
    Viewer,
}

/// Why a `hello` turned this connection down. The dialer must not register it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Refusal {
    /// A better link already serves this peer and role.
    Link,
    /// This side is not accepting that kind of connection right now.
    Closed,
    /// The dialer's protocol is newer than this side understands.
    Version,
    /// A reason from a newer version. Still a refusal.
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HelloExtras {
    /// Setup-only link: both ends remain unpaired; no work/data authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) access_only: Option<bool>,
    /// `paired`, `port` and `platform` go only to a peer whose key is already
    /// paired. An unknown peer never receives them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) paired: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) platform: Option<String>,
    /// Set only in a reply, and sent to anyone, because it carries no details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) refused: Option<Refusal>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hello {
    pub(crate) proto: u32,
    pub(crate) role: Role,
    pub(crate) app_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    #[serde(flatten)]
    pub(crate) extras: HelloExtras,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct WireError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl WireError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub(crate) enum Frame {
    Hello(Hello),
    Req {
        id: u64,
        op: String,
        #[serde(default)]
        args: Value,
    },
    Res {
        id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<WireError>,
    },
    Evt {
        stream: String,
        epoch: String,
        seq: u64,
        #[serde(default)]
        data: Value,
    },
    Ping {
        t: u64,
    },
    Pong {
        t: u64,
    },
}

const KNOWN_KINDS: [&str; 6] = ["hello", "req", "res", "evt", "ping", "pong"];

pub(crate) enum Decoded {
    Frame(Frame),
    /// A well-formed message of a kind this version does not know. Ignored.
    Unknown,
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Decoded, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let kind = value.get("k").and_then(Value::as_str).ok_or(())?;
    if !KNOWN_KINDS.contains(&kind) {
        return Ok(Decoded::Unknown);
    }
    serde_json::from_value(value)
        .map(Decoded::Frame)
        .map_err(|_| ())
}

pub(crate) fn encode(frame: &Frame) -> Result<Vec<u8>, ()> {
    let body = serde_json::to_vec(frame).map_err(|_| ())?;
    if body.len() > MAX_FRAME {
        return Err(());
    }
    let length = u32::try_from(body.len()).map_err(|_| ())?;
    let mut bytes = Vec::with_capacity(body.len() + 4);
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

/// Reads one frame, waiting up to `idle` for it to start. Memory grows only as
/// bytes actually arrive, so a large length prefix alone cannot allocate anything.
pub(crate) async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
    idle: Duration,
) -> io::Result<Vec<u8>> {
    let first = timeout(idle, reader.read_u8())
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
    timeout(FRAME_ARRIVAL_LIMIT, async {
        let mut header = [first, 0, 0, 0];
        reader.read_exact(&mut header[1..]).await?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > limit {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad frame length"));
        }
        let mut body = Vec::with_capacity(length.min(READ_CHUNK));
        (&mut *reader).take(length as u64).read_to_end(&mut body).await?;
        if body.len() != length {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        Ok(body)
    })
    .await
    .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
}

/// Display text from another device: no control characters, bounded, never
/// empty. `None` when nothing printable remains.
pub(crate) fn clean_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "other"
    }
}
