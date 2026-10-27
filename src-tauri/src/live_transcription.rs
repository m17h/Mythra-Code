//! A single bounded OpenAI transcription socket; credentials never enter the webview.
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{ipc::{InvokeBody, Request}, Emitter, State, WebviewWindow};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{connect_async_with_config, tungstenite::{client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message}};
use crate::transcription::{live_openai_key, live_openai_key_generation, TranscriptionProvider, TranscriptionState};

const URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const MAX_CHUNK: usize = 48_000;
const MAX_QUEUED_AUDIO: usize = 48;
const MAX_AUDIO: usize = 24_000 * 2 * 600;
const MAX_TEXT: usize = 100_000;
const CANCELED: &str = "Live dictation canceled.";
const CONNECTION_ERROR: &str = "Live dictation lost its connection. Text already received has been kept; start dictation again to continue.";
type LiveResult = Result<String, String>;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum LiveTranscriptionEvent {
    Transcript { id: String, text: String, provisional: bool },
    Error { id: String, message: String },
}

/// `Emitter::emit` broadcasts to every webview in Tauri 2. Dictated text is
/// delivered only to the window that owns the session.
fn emit_live(window: &WebviewWindow, event: LiveTranscriptionEvent) -> tauri::Result<()> {
    window.emit_to(window.label(), "transcription-live-event", event)
}

enum Input { Audio { bytes: Vec<u8>, commit: bool }, Finish }
struct Admission { next_sequence: u64, bytes: usize, finishing: bool }
struct LiveSession {
    id: String,
    model: String,
    window_label: String,
    input: mpsc::Sender<Input>,
    cancel: watch::Sender<bool>,
    ready: watch::Sender<Option<Result<(), String>>>,
    result: watch::Sender<Option<LiveResult>>,
    admission: Mutex<Admission>,
}

#[derive(Default)]
pub(crate) struct LiveTranscriptionState { active: Mutex<Option<Arc<LiveSession>>> }

impl LiveTranscriptionState {
    pub(super) fn cancel_window(&self, label: &str) {
        if let Some(session) = self.active.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|s| s.window_label == label) {
            session.cancel.send_replace(true);
        }
    }

    pub(super) fn cancel(&self, id: &str) {
        if let Some(session) = self.active.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|s| s.id == id) {
            session.cancel.send_replace(true);
        }
    }

    fn session(&self, id: &str, window: &WebviewWindow) -> Result<Arc<LiveSession>, String> {
        self.active.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|s| s.id == id && s.window_label == window.label())
            .cloned().ok_or_else(|| "This live dictation session is no longer active.".into())
    }
}

async fn ready(session: &LiveSession) -> Result<(), String> {
    let mut receiver = session.ready.subscribe();
    let wait = async {
        loop {
            if *session.cancel.borrow() { return Err(CANCELED.into()); }
            if let Some(result) = receiver.borrow().clone() { return result; }
            receiver.changed().await.map_err(|_| CONNECTION_ERROR.to_string())?;
        }
    };
    match tokio::time::timeout(Duration::from_secs(25), wait).await {
        Ok(result) => result,
        Err(_) => { session.cancel.send_replace(true); Err("The live dictation connection did not start in time. Try again.".into()) }
    }
}

#[tauri::command]
pub(crate) async fn transcription_live_start(
    window: WebviewWindow, state: State<'_, TranscriptionState>, id: String, provider: TranscriptionProvider,
    model: String,
) -> Result<(), String> {
    if provider != TranscriptionProvider::Openai || model != "gpt-live-transcribe" {
        return Err("This provider and model do not support live dictation. Choose a Live dictation model in Settings › Voice input.".into());
    }
    let (session, work) = {
        let mut active = state.live.active.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(current) = active.as_ref().filter(|s| s.id == id) {
            if current.model != model || current.window_label != window.label() || current.result.borrow().is_some() || *current.cancel.borrow()
                || current.admission.lock().unwrap_or_else(|e| e.into_inner()).finishing {
                return Err("This dictation session already ended. Start a new recording.".into());
            }
            (current.clone(), None)
        } else {
            let lease = state.reserve_live(&id)?;
            // Audio admission always reserves one queue slot for Finish. Once
            // finishing is set under the same lock, no audio can follow it.
            let (input, receiver) = mpsc::channel(MAX_QUEUED_AUDIO + 1);
            let (cancel, canceled) = watch::channel(false);
            let (ready, _) = watch::channel(None);
            let (result, _) = watch::channel(None);
            let session = Arc::new(LiveSession { id, model, window_label: window.label().to_owned(), input, cancel, ready, result,
                admission: Mutex::new(Admission { next_sequence: 0, bytes: 0, finishing: false }) });
            *active = Some(session.clone());
            (session, Some((receiver, canceled, lease)))
        }
    };
    if let Some((receiver, mut canceled, lease)) = work {
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            let work = run(&session, receiver, &window);
            let result = tokio::select! {
                biased;
                _ = canceled.changed() => Err(CANCELED.into()),
                result = tokio::time::timeout(Duration::from_secs(660), work) => result.unwrap_or_else(|_| Err("Live dictation reached its time limit. Text already received has been kept.".into())),
            };
            if let Err(message) = &result {
                if message != CANCELED { let _ = emit_live(&window, LiveTranscriptionEvent::Error { id: session.id.clone(), message: message.clone() }); }
            }
            if session.ready.borrow().is_none() { session.ready.send_replace(Some(result.as_ref().map(|_| ()).map_err(Clone::clone))); }
            // Release the cross-mode lease before acknowledging completion.
            drop(lease);
            session.result.send_replace(Some(result));
        });
    }
    ready(&session).await
}

#[tauri::command]
pub(crate) fn transcription_live_append(window: WebviewWindow, state: State<'_, TranscriptionState>, request: Request<'_>) -> Result<(), String> {
    let id = request.headers().get("mythra-transcription-id").and_then(|v| v.to_str().ok()).ok_or("Missing live dictation session.")?;
    let sequence = request.headers().get("mythra-audio-sequence").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).ok_or("Invalid live audio sequence.")?;
    let commit = request.headers().get("mythra-audio-commit").and_then(|v| v.to_str().ok()) == Some("1");
    let session = state.live.session(id, &window)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_CHUNK => bytes.clone(),
        InvokeBody::Json(value) => {
            let values = value.as_array().filter(|v| v.len() <= MAX_CHUNK).ok_or("Invalid live audio packet.")?;
            values.iter().map(|v| v.as_u64().filter(|v| *v <= 255).map(|v| v as u8).ok_or("Invalid live audio byte.")).collect::<Result<Vec<_>, _>>()?
        }
        _ => return Err("Live audio packet exceeded its limit.".into()),
    };
    if bytes.is_empty() || bytes.len() % 2 != 0 { return Err("Invalid live audio packet.".into()); }
    let mut admission = session.admission.lock().unwrap_or_else(|e| e.into_inner());
    if *session.cancel.borrow() || admission.finishing || session.result.borrow().is_some() { return Err("Live dictation has stopped.".into()); }
    if sequence < admission.next_sequence { return Ok(()); } // IPC replay never sends audio twice.
    if sequence != admission.next_sequence {
        session.cancel.send_replace(true);
        return Err("Live audio arrived out of order. Text already received has been kept; start dictation again.".into());
    }
    if admission.bytes + bytes.len() > MAX_AUDIO {
        session.cancel.send_replace(true);
        return Err("Live dictation reached its recording limit. Text already received has been kept.".into());
    }
    let count = bytes.len();
    if session.input.capacity() <= 1 || session.input.try_send(Input::Audio { bytes, commit }).is_err() {
        session.cancel.send_replace(true);
        return Err("Live dictation could not keep up with the audio. Text already received has been kept.".into());
    }
    admission.next_sequence += 1;
    admission.bytes += count;
    Ok(())
}

#[tauri::command]
pub(crate) async fn transcription_live_finish(window: WebviewWindow, state: State<'_, TranscriptionState>, id: String) -> LiveResult {
    let session = state.live.session(&id, &window)?;
    let mut receiver = session.result.subscribe();
    {
        let mut admission = session.admission.lock().unwrap_or_else(|e| e.into_inner());
        if !admission.finishing && receiver.borrow().is_none() {
            admission.finishing = true;
            if session.input.try_send(Input::Finish).is_err() {
                session.cancel.send_replace(true);
                return Err(CONNECTION_ERROR.into());
            }
        }
    }
    let wait = async {
        loop {
            if let Some(result) = receiver.borrow().clone() { return result; }
            receiver.changed().await.map_err(|_| CONNECTION_ERROR.to_string())?;
        }
    };
    match tokio::time::timeout(Duration::from_secs(60), wait).await {
        Ok(result) => result,
        Err(_) => { session.cancel.send_replace(true); Err("Live dictation did not finish in time. Text already received has been kept.".into()) }
    }
}

#[derive(Default)]
struct Transcript {
    text: HashMap<String, (String, bool)>,
    seen: Vec<String>,
    committed: Vec<String>,
    previous: HashMap<String, Option<String>>,
}
impl Transcript {
    fn commit(&mut self, id: &str, previous: Option<&str>) -> Result<(), String> {
        if id.is_empty() || id.len() > 256 || previous.is_some_and(|id| id.is_empty() || id.len() > 256) || previous == Some(id) {
            return Err(CONNECTION_ERROR.into());
        }
        if let Some(known) = self.previous.get(id) {
            return if known.as_deref() == previous { Ok(()) } else { Err(CONNECTION_ERROR.into()) };
        }
        if self.committed.len() >= 1024 || self.previous.values().any(|value| value.as_deref() == previous) {
            return Err("Live dictation returned an invalid transcript order. Text already received has been kept.".into());
        }
        // The provider can finish different turns out of order. Preserve its
        // explicit item chain rather than ordering by completion arrival.
        let mut ancestor = previous;
        while let Some(parent) = ancestor {
            if parent == id { return Err(CONNECTION_ERROR.into()); }
            ancestor = self.previous.get(parent).and_then(|value| value.as_deref());
        }
        self.previous.insert(id.to_owned(), previous.map(str::to_owned));
        self.committed.push(id.to_owned());
        Ok(())
    }

    fn ordered_commits(&self) -> Vec<&str> {
        let mut ordered = Vec::with_capacity(self.committed.len());
        // The chain starts at the item whose predecessor is null or was never
        // committed in this session (for example, a provider-side item).
        let Some(root) = self.committed.iter().find(|id| {
            self.previous.get(*id).is_some_and(|value| value.as_deref().map_or(true, |parent| !self.previous.contains_key(parent)))
        }) else { return ordered };
        ordered.push(root.as_str());
        let mut previous = Some(root.as_str());
        while let Some(id) = self.committed.iter().find(|id| self.previous.get(*id).is_some_and(|value| value.as_deref() == previous)) {
            ordered.push(id.as_str());
            previous = Some(id.as_str());
        }
        ordered
    }

    fn update(&mut self, id: &str, text: &str, final_text: bool) -> Result<(), String> {
        if !self.text.contains_key(id) {
            if self.seen.len() >= 1024 || id.len() > 256 { return Err("Live dictation returned too many transcript segments.".into()); }
            self.seen.push(id.to_owned());
        }
        let value = self.text.entry(id.to_owned()).or_default();
        if final_text { *value = (text.to_owned(), true); }
        else if !value.1 { value.0.push_str(text); }
        if self.text.values().map(|(s, _)| s.chars().count()).sum::<usize>() + self.text.len().saturating_sub(1) > MAX_TEXT {
            return Err("Live dictation returned too much text. Text already received has been kept.".into());
        }
        Ok(())
    }
    fn combined(&self) -> (String, bool) {
        let ordered = self.ordered_commits();
        // Uncommitted live deltas still appear immediately. As acknowledgments
        // arrive they move into their provider-defined position.
        let ids = ordered.iter().copied().chain(self.seen.iter().map(String::as_str).filter(|id| !ordered.contains(id)));
        let mut parts = Vec::new();
        let mut provisional = false;
        for id in ids {
            if let Some((text, done)) = self.text.get(id) {
                if !text.trim().is_empty() { parts.push(text.trim()); }
                provisional |= !done || !self.previous.contains_key(id);
            }
        }
        (parts.join(" "), provisional)
    }
    fn complete(&self, commits: usize) -> bool {
        let ordered = self.ordered_commits();
        ordered.len() == commits && self.committed.len() == commits
            && self.text.len() == commits
            && ordered.iter().all(|id| self.text.get(*id).is_some_and(|(_, done)| *done))
    }
}

async fn send_message<S>(outgoing: &mut S, message: Message) -> Result<(), String>
where S: futures_util::Sink<Message> + Unpin {
    tokio::time::timeout(Duration::from_secs(5), outgoing.send(message)).await
        .map_err(|_| CONNECTION_ERROR.to_owned())?.map_err(|_| CONNECTION_ERROR.to_owned())
}

async fn run(session: &LiveSession, mut input: mpsc::Receiver<Input>, window: &WebviewWindow) -> LiveResult {
    let (key, generation) = live_openai_key().await?;
    let mut request = URL.into_client_request().map_err(|_| "Could not prepare live dictation.")?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| "The OpenAI transcription key is invalid.")?;
    authorization.set_sensitive(true);
    request.headers_mut().insert("Authorization", authorization);
    drop(key);
    let config = WebSocketConfig::default().max_message_size(Some(2 * 1024 * 1024)).max_frame_size(Some(2 * 1024 * 1024));
    let (socket, _) = tokio::time::timeout(Duration::from_secs(15), connect_async_with_config(request, Some(config), true)).await
        .map_err(|_| "The OpenAI live dictation connection timed out.")?
        .map_err(|error| match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => match response.status().as_u16() {
                401 | 403 => "OpenAI denied this transcription key access to live dictation. Check Settings › Voice input.".to_owned(),
                429 => "OpenAI's live dictation limit was reached. Try again later.".to_owned(),
                _ => "OpenAI could not start live dictation. Try again later.".to_owned(),
            },
            _ => "Could not connect to OpenAI for live dictation. Check your internet connection.".to_owned(),
        })?;
    let (mut outgoing, mut incoming) = socket.split();
    let send = |value: Value| Message::Text(value.to_string().into());
    if live_openai_key_generation() != generation { return Err("The transcription key changed. Start dictation again.".into()); }
    send_message(&mut outgoing, send(json!({"type":"session.update", "session": {
        "type":"transcription", "audio":{"input":{"format":{"type":"audio/pcm","rate":24000},
        "transcription":{"model":session.model, "delay":"low"}, "turn_detection":null}}
    }}))).await?;
    let mut configured = false;
    let mut transcript = Transcript::default();
    let mut samples = 0usize;
    let mut commits = 0usize;
    let mut finishing = false;
    let mut finish_deadline = None;
    let mut idle_deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let mut credential_tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        if live_openai_key_generation() != generation { return Err("The transcription key changed. Text already received has been kept.".into()); }
        let expiry = finish_deadline.unwrap_or(idle_deadline);
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(expiry) => return Err(if finishing { "Live dictation did not finish in time. Text already received has been kept.".into() } else { CONNECTION_ERROR.into() }),
            message = incoming.next() => {
                let message = message.ok_or(CONNECTION_ERROR)?.map_err(|_| CONNECTION_ERROR)?;
                idle_deadline = tokio::time::Instant::now() + Duration::from_secs(90);
                let value: Value = match message {
                    Message::Text(text) => serde_json::from_str(text.as_ref()).map_err(|_| CONNECTION_ERROR)?,
                    Message::Ping(bytes) => { send_message(&mut outgoing, Message::Pong(bytes)).await?; continue; }
                    Message::Close(_) => return Err(CONNECTION_ERROR.into()),
                    _ => continue,
                };
                match value["type"].as_str().unwrap_or_default() {
                    "session.updated" => {
                        if !configured { configured = true; session.ready.send_replace(Some(Ok(()))); }
                    }
                    "input_audio_buffer.committed" => {
                        let id = value["item_id"].as_str().filter(|s| !s.is_empty() && s.len() <= 256).ok_or(CONNECTION_ERROR)?;
                        let previous = match &value["previous_item_id"] {
                            Value::Null => None,
                            Value::String(previous) => Some(previous.as_str()),
                            _ => return Err(CONNECTION_ERROR.into()),
                        };
                        transcript.commit(id, previous)?;
                        if transcript.committed.len() > commits { return Err(CONNECTION_ERROR.into()); }
                        let (text, provisional) = transcript.combined();
                        emit_live(window, LiveTranscriptionEvent::Transcript { id: session.id.clone(), text, provisional }).map_err(|_| "The dictation window closed.".to_string())?;
                    }
                    "conversation.item.input_audio_transcription.delta" | "conversation.item.input_audio_transcription.completed" => {
                        let id = value["item_id"].as_str().filter(|s| !s.is_empty()).ok_or(CONNECTION_ERROR)?;
                        let done = value["type"] == "conversation.item.input_audio_transcription.completed";
                        let text = value[if done { "transcript" } else { "delta" }].as_str().ok_or(CONNECTION_ERROR)?;
                        transcript.update(id, text, done)?;
                        let (text, provisional) = transcript.combined();
                        emit_live(window, LiveTranscriptionEvent::Transcript { id: session.id.clone(), text, provisional }).map_err(|_| "The dictation window closed.".to_string())?;
                    }
                    "error" | "conversation.item.input_audio_transcription.failed" => return Err("OpenAI could not continue live dictation. Text already received has been kept. Check the selected model and your API account, then try again.".into()),
                    _ => {},
                }
                if finishing && transcript.complete(commits) { return Ok(transcript.combined().0); }
            }
            command = input.recv(), if configured && !finishing => {
                let command = command.ok_or(CANCELED)?;
                idle_deadline = tokio::time::Instant::now() + Duration::from_secs(90);
                let (bytes, commit) = match command {
                    Input::Audio { bytes, commit } => (bytes, commit),
                    Input::Finish => { finishing = true; finish_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(45)); (Vec::new(), true) }
                };
                if !bytes.is_empty() {
                    samples += bytes.len() / 2;
                    send_message(&mut outgoing, send(json!({"type":"input_audio_buffer.append","audio":STANDARD.encode(&bytes)}))).await?;
                }
                if commit && samples > 0 {
                    // The API needs at least 100 ms in a committed item. A
                    // short final tail is padded with silence, never dropped.
                    if samples < 2400 {
                        send_message(&mut outgoing, send(json!({"type":"input_audio_buffer.append","audio":STANDARD.encode(vec![0u8; (2400-samples)*2])}))).await?;
                    }
                    send_message(&mut outgoing, send(json!({"type":"input_audio_buffer.commit"}))).await?;
                    commits += 1;
                    samples = 0;
                }
                if finishing && transcript.complete(commits) { return Ok(transcript.combined().0); }
            }
            _ = credential_tick.tick() => {}
        }
    }
}
