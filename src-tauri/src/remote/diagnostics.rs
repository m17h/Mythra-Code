//! Dev-build-only, bounded protocol breadcrumbs. Never format network strings,
//! args, ids, keys, addresses, paths, pairing codes, prompts, answers or output.
//! Every text field crosses an exact allowlist BEFORE it reaches the formatter.
#[derive(Clone, Copy)]
pub(super) enum Event {
    Start,
    Discovery,
    Link,
    Closed,
    Request,
    Reply,
    Journal,
    NativeBegin,
    NativeAccepted,
    Publish,
    Lease,
    Grant,
    Readiness,
}
fn event(event: Event) -> &'static str {
    match event {
        Event::Start => "start",
        Event::Discovery => "discovery",
        Event::Link => "link",
        Event::Closed => "closed",
        Event::Request => "request",
        Event::Reply => "reply",
        Event::Journal => "journal",
        Event::NativeBegin => "native_begin",
        Event::NativeAccepted => "native_accepted",
        Event::Publish => "publish",
        Event::Lease => "lease",
        Event::Grant => "grant",
        Event::Readiness => "readiness",
    }
}
fn operation(value: &str) -> &'static str {
    match value {
        "listener"=>"listener", "providers"=>"providers",
        "tls.accept" => "tls.accept",
        "tls.dial" => "tls.dial",
        "tcp.dial" => "tcp.dial",
        "host" => "host",
        "viewer" => "viewer",
        "pair.request" => "pair.request",
        "pair.reveal" => "pair.reveal",
        "pair.await" => "pair.await",
        "pair.offer" => "pair.offer",
        "workspaces.list" => "workspaces.list",
        "threads.list" => "threads.list",
        "timeline.subscribe" => "timeline.subscribe",
        "timeline.read" => "timeline.read",
        "timeline.unsubscribe" => "timeline.unsubscribe",
        "host.info" => "host.info",
        "host.context" => "host.context",
        "work.inspect" => "work.inspect",
        "op.status" => "op.status",
        "prompt.send" => "prompt.send",
        "prompt.queue" => "prompt.queue",
        "prompt.steer" => "prompt.steer",
        "prompt.cancel" => "prompt.cancel",
        "turn.stop" => "turn.stop",
        "approval.answer" => "approval.answer",
        "question.answer" => "question.answer",
        "thread/start" => "thread/start",
        "thread/resume" => "thread/resume",
        "turn/start" => "turn/start",
        "claude_prompt" => "claude_prompt",
        "cursor_prompt" => "cursor_prompt",
        "approval_answer" => "approval_answer",
        "question_answer" => "question_answer",
        "turn_stop" => "turn_stop",
        "command/exec" => "command/exec",
        "browse" => "browse",
        "advertise" => "advertise",
        _ => "other",
    }
}
fn outcome(value: &str) -> &'static str {
    match value {
        "listening"=>"listening", "tcp_received"=>"tcp_received", "permission_denied"=>"permission_denied", "address_in_use"=>"address_in_use", "connection_refused"=>"connection_refused", "network_unreachable"=>"network_unreachable",
        "no_catalog_requests"=>"no_catalog_requests", "no_thread_requests"=>"no_thread_requests", "no_subscribe"=>"no_subscribe", "subscribe_requested"=>"subscribe_requested", "ready_reported"=>"ready_reported", "none_reported"=>"none_reported",
        "ok" => "ok",
        "accepted" => "accepted",
        "queued" => "queued",
        "rejected" => "rejected",
        "uncertain" => "uncertain",
        "in" => "in",
        "out" => "out",
        "found" => "found",
        "lost" => "lost",
        "narrowed" => "narrowed",
        "denied" => "denied",
        "name_conflict" => "name_conflict",
        "key_rejected" => "key_rejected",
        "timeout" => "timeout",
        "failed" => "failed",
        "paired" => "paired",
        "unpaired" => "unpaired",
        "claimed" => "claimed",
        "existing" => "existing",
        "digest_mismatch" => "digest_mismatch",
        "expired" => "expired",
        "busy" => "busy",
        "revoked" => "revoked",
        "changed" => "changed",
        "finished" => "finished",
        "dead" => "dead",
        "protocol" => "protocol",
        "overloaded" => "overloaded",
        "replaced" => "replaced",
        "hosting_off" => "hosting_off",
        "refused" => "refused",
        "forbidden" => "forbidden",
        "not_paired" => "not_paired",
        "invalid" => "invalid",
        "unsupported" => "unsupported",
        "pairing_closed" => "pairing_closed",
        "host_unavailable" => "host_unavailable",
        "stale_generation" => "stale_generation",
        "stale_target" => "stale_target",
        "rate_limited" => "rate_limited",
        "bad_token" => "bad_token",
        "pairing_expired" => "pairing_expired",
        "internal" => "internal",
        "thread_unavailable" => "thread_unavailable",
        _ => "other",
    }
}
pub(super) fn record(
    kind: Event,
    link: u64,
    request: u64,
    seq: u64,
    count: usize,
    op: &str,
    result: &str,
) {
    #[cfg(debug_assertions)]
    enabled::record(kind, link, request, seq, count, op, result);
    #[cfg(not(debug_assertions))]
    let _ = (kind, link, request, seq, count, op, result);
}
pub(super) fn start(app: &tauri::AppHandle) {
    #[cfg(debug_assertions)]
    enabled::start(app);
    #[cfg(not(debug_assertions))]
    let _ = app;
}
#[cfg(debug_assertions)]
mod enabled {
    use super::*;
    use std::{
        fs::{self, File, OpenOptions},
        io::{self, Write},
        path::{Path, PathBuf},
        sync::{Mutex, OnceLock},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use tauri::Manager;
    const MAX_BYTES: u64 = 1024 * 1024;
    const MAX_PER_SECOND: u32 = 40;
    static TRACE: OnceLock<Mutex<Option<Trace>>> = OnceLock::new();
    struct Trace {
        path: PathBuf,
        file: Option<File>,
        bytes: u64,
        run: u64,
        began: Instant,
        window: Instant,
        lines: u32,
        dropped: u64,
        last_publish: Option<Instant>,
    }
    fn open(path: &Path) -> io::Result<File> {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(7).custom_flags(0x00200000);
        }
        let file = options.open(path)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(io::Error::other("not a log file"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(io::Error::other("not a log file"));
            }
        }
        Ok(file)
    }
    impl Trace {
        fn new(path: PathBuf, run: u64) -> io::Result<Self> {
            let file = open(&path)?;
            let bytes = file.metadata()?.len();
            Ok(Self {
                path,
                file: Some(file),
                bytes,
                run,
                began: Instant::now(),
                window: Instant::now(),
                lines: 0,
                dropped: 0,
                last_publish: None,
            })
        }
        fn line(
            &mut self,
            kind: Event,
            link: u64,
            request: u64,
            seq: u64,
            count: usize,
            op: &str,
            result: &str,
        ) -> io::Result<()> {
            let now = Instant::now();
            if now.duration_since(self.window) >= Duration::from_secs(1) {
                self.window = now;
                self.lines = 0;
            }
            if self.lines >= MAX_PER_SECOND {
                self.dropped += 1;
                return Ok(());
            }
            if matches!(kind, Event::Publish) {
                if self
                    .last_publish
                    .is_some_and(|last| now.duration_since(last) < Duration::from_millis(1000))
                {
                    self.dropped += 1;
                    return Ok(());
                }
                self.last_publish = Some(now);
            }
            self.lines += 1;
            let utc = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis());
            let text=format!("mythra.remote utc_ms={utc} run={:016x} elapsed_ms={} event={} link={link} request={request} seq={seq} count={count} op={} result={} dropped={}\n",self.run,self.began.elapsed().as_millis(),event(kind),operation(op),outcome(result),self.dropped);
            self.dropped = 0;
            if self.bytes.saturating_add(text.len() as u64) > MAX_BYTES {
                drop(self.file.take());
                let backup = self.path.with_file_name("remote-diagnostics.previous.log");
                match fs::remove_file(&backup) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
                fs::rename(&self.path, &backup)?;
                self.file = Some(open(&self.path)?);
                self.bytes = 0;
            }
            self.file
                .as_mut()
                .ok_or_else(|| io::Error::other("closed log"))?
                .write_all(text.as_bytes())?;
            self.bytes += text.len() as u64;
            Ok(())
        }
    }
    pub(super) fn start(app: &tauri::AppHandle) {
        // Debug assertions alone are not a profile boundary. Never create this
        // log for the installed identifier, including debug builds of it.
        if app.config().identifier != "com.kiwi.harness.localdev" {
            return;
        }
        let trace = (|| {
            let root = app.path().app_data_dir().ok()?;
            fs::create_dir_all(&root).ok()?;
            let mut run = [0u8; 8];
            getrandom::fill(&mut run).ok()?;
            Trace::new(root.join("remote-diagnostics.log"), u64::from_le_bytes(run)).ok()
        })();
        if TRACE.set(Mutex::new(trace)).is_ok() {
            record(Event::Start, 0, 0, 0, 0, "other", "ok");
        }
    }
    pub(super) fn record(
        kind: Event,
        link: u64,
        request: u64,
        seq: u64,
        count: usize,
        op: &str,
        result: &str,
    ) {
        let Some(trace) = TRACE.get() else {
            return;
        };
        let Ok(mut trace) = trace.try_lock() else {
            return;
        };
        // Logging never waits for other logging, performs native work, or takes
        // Core/DB locks. Any I/O failure disables the sink instead of the app.
        if trace.as_mut().is_some_and(|sink| {
            sink.line(kind, link, request, seq, count, op, result)
                .is_err()
        }) {
            *trace = None;
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn log_is_bounded_and_never_formats_untrusted_text() {
            let root =
                std::env::temp_dir().join(format!("mythra-remote-log-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let path = root.join("remote-diagnostics.log");
            let mut trace = Trace::new(path.clone(), 1).unwrap();
            trace
                .line(
                    Event::Request,
                    2,
                    3,
                    4,
                    5,
                    "SECRET-PROMPT-DO-NOT-LOG",
                    "SECRET-TOKEN-DO-NOT-LOG",
                )
                .unwrap();
            for _ in 0..100 {
                trace
                    .line(Event::Reply, 2, 3, 0, 0, "timeline.read", "ok")
                    .unwrap();
            }
            let text = fs::read_to_string(&path).unwrap();
            assert!(!text.contains("SECRET"));
            assert!(text.contains("op=other result=other"));
            assert!(text.lines().count() <= MAX_PER_SECOND as usize);
            trace.bytes = MAX_BYTES;
            trace.window = Instant::now() - Duration::from_secs(2);
            trace
                .line(Event::Closed, 2, 0, 0, 0, "viewer", "dead")
                .unwrap();
            assert!(path.metadata().unwrap().len() <= MAX_BYTES);
            assert!(
                root.join("remote-diagnostics.previous.log")
                    .metadata()
                    .unwrap()
                    .len()
                    <= MAX_BYTES
            );
            drop(trace);
            fs::remove_dir_all(root).unwrap();
        }
    }
}

/// Numeric/error-kind classification only. Never record formatted OS errors,
/// addresses or claim that a timeout by itself proves a firewall block.
pub(super) fn network_outcome(error:&std::io::Error)->&'static str{match error.kind(){std::io::ErrorKind::PermissionDenied=>"permission_denied",std::io::ErrorKind::ConnectionRefused=>"connection_refused",std::io::ErrorKind::AddrInUse=>"address_in_use",std::io::ErrorKind::NetworkUnreachable|std::io::ErrorKind::HostUnreachable=>"network_unreachable",std::io::ErrorKind::TimedOut=>"timeout",_=>"failed"}}
#[tauri::command]
pub(crate) fn remote_host_provider_status(state:tauri::State<'_,super::RemoteState>,window:tauri::WebviewWindow,generation:u64,ready_providers:u8,total_providers:u8)->Result<(),super::wire::WireError>{
 super::hostbridge::window_is_host(&window)?;super::hostbridge::check_generation(&state.inner.lock(),generation)?;
 if total_providers>5||ready_providers>total_providers{return Err(super::wire::WireError::new("invalid","That provider status isn't valid."));}
 record(Event::Readiness,0,0,total_providers as u64,ready_providers as usize,"providers",if ready_providers==0{"none_reported"}else{"ready_reported"});Ok(())
}
#[cfg(test)]
mod readiness_tests{
 use super::*;
 #[test]
 fn readiness_and_network_classification_never_infers_firewall_or_formats_content(){
  for(kind,expected)in[(std::io::ErrorKind::TimedOut,"timeout"),(std::io::ErrorKind::PermissionDenied,"permission_denied"),(std::io::ErrorKind::ConnectionRefused,"connection_refused"),(std::io::ErrorKind::AddrInUse,"address_in_use")]{let error=std::io::Error::new(kind,"SECRET path or address");assert_eq!(network_outcome(&error),expected);assert!(!network_outcome(&error).contains("SECRET"));}
  assert_eq!(operation("providers"),"providers");assert_eq!(outcome("no_subscribe"),"no_subscribe");assert_eq!(outcome("firewall_blocked"),"other");assert_eq!(operation("SECRET"),"other");
 }
}
