//! Session-scoped HTTP preview gateway. The host never opens a LAN port. A
//! viewer click binds numeric loopback and returns a one-use bootstrap URL
//! for the normal browser, never an app webview. No arbitrary TCP/URL proxy.
#[path = "preview_browser.rs"]
mod browser;
#[path = "preview_streams.rs"]
mod streaming;
use super::{
    hostbridge,
    session::Link,
    store::GrantScope,
    wire::{Frame, Role, WireError},
    Inner, RemoteState,
};
use base64::{
    engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD, Engine as _,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
    time::timeout,
};

const IDLE: Duration = Duration::from_secs(600);
const IO_WAIT: Duration = Duration::from_secs(15);
const HEAD_BYTES: usize = 16 * 1024;
const BODY_BYTES: usize = 1024 * 1024;
const MAX_SESSIONS: usize = 8;
const SESSION_BYTES: u64 = 64 * 1024 * 1024;
const PER_PEER: usize = 2;
const COOKIE_PREFIX: &str = "mythra_preview_";
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
fn denied() -> WireError {
    WireError::new(
        "forbidden",
        "This preview is no longer available. Open it again from the other device's project.",
    )
}
fn invalid() -> WireError {
    WireError::new("invalid", "That preview request is not valid.")
}
fn busy() -> WireError {
    WireError::new("busy", "Too many preview connections are open.")
}
fn failure() -> WireError {
    WireError::new("preview_unavailable", "The preview on the other device couldn't be read.")
}
#[derive(Clone)]
struct Endpoint {
    owner: Weak<Inner>,
    generation: u64,
    workspace: String,
    address: SocketAddr,
    expires: Instant,
}
struct HostSession {
    owner: Weak<Inner>,
    link: Arc<Link>,
    endpoint: Endpoint,
    revision: u64,
    touched: Mutex<Instant>,
    transferred: std::sync::atomic::AtomicU64,
    stop: watch::Sender<bool>,
    slots: Arc<Semaphore>,
    streams: Mutex<HashMap<String, Arc<streaming::HostStream>>>,
}
struct BrowserSession {
    owner: Weak<Inner>,
    link: Arc<Link>,
    host_id: String,
    initial_path: String,
    touched: Mutex<Instant>,
    transferred: std::sync::atomic::AtomicU64,
    bootstrapped: std::sync::atomic::AtomicBool,
    cookies: Mutex<std::collections::HashSet<String>>,
    stop: watch::Sender<bool>,
}
#[derive(Default)]
struct Registry {
    endpoints: HashMap<String, Endpoint>,
    hosts: HashMap<String, Arc<HostSession>>,
    browsers: HashMap<String, Arc<BrowserSession>>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(Default::default)
}
fn owner(weak: &Weak<Inner>, inner: &Inner) -> bool {
    std::ptr::eq(weak.as_ptr(), inner)
}
fn random_token() -> Result<String, WireError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| failure())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn sweep(reg: &mut Registry) {
    reg.endpoints
        .retain(|_, e| e.owner.strong_count() > 0 && e.expires > Instant::now());
    reg.hosts
        .retain(|_, s| !*s.stop.borrow() && s.owner.strong_count() > 0);
    reg.browsers
        .retain(|_, s| !*s.stop.borrow() && s.owner.strong_count() > 0);
}
/// Lock order: callers may hold core. This function only takes REGISTRY; no
/// registry holder is allowed to acquire core or await network I/O.
pub(super) fn retire(inner: &Inner, device: Option<&str>) {
    let mut reg = registry().lock().unwrap();
    reg.endpoints
        .retain(|_, e| !owner(&e.owner, inner) || device.is_some());
    reg.hosts.retain(|id, s| {
        if owner(&s.owner, inner) && device.is_none_or(|peer| s.link.peer_fingerprint == peer) {
            s.stop.send_replace(true);
            s.link.send(&Frame::Evt {
                stream: format!("preview:{id}"),
                epoch: String::new(),
                seq: 0,
                data: json!({"closed":true}),
            });
            false
        } else {
            true
        }
    });
    reg.browsers.retain(|_, s| {
        if owner(&s.owner, inner) && device.is_none_or(|peer| s.link.peer_fingerprint == peer) {
            s.stop.send_replace(true);
            false
        } else {
            true
        }
    });
}
pub(super) fn link_closed(inner: &Inner, link: &Link) {
    let mut reg = registry().lock().unwrap();
    reg.hosts.retain(|_, s| {
        let close = owner(&s.owner, inner) && s.link.id == link.id;
        if close {
            s.stop.send_replace(true);
        }
        !close
    });
    reg.browsers.retain(|_, s| {
        let close = owner(&s.owner, inner) && s.link.id == link.id;
        if close {
            s.stop.send_replace(true);
        }
        !close
    });
}
pub(super) fn receive_event(inner: &Inner, link: &Link, stream: &str, data: &Value) -> bool {
    let Some(id) = stream.strip_prefix("preview:") else {
        return false;
    };
    if link.role != Role::Viewer || data.get("closed") != Some(&Value::Bool(true)) {
        return true;
    }
    let reg = registry().lock().unwrap();
    for s in reg.browsers.values() {
        if owner(&s.owner, inner) && s.link.id == link.id && s.host_id == id {
            s.stop.send_replace(true);
        }
    }
    true
}
fn host_authority(
    inner: &Inner,
    link: &Link,
    endpoint: &Endpoint,
    revision: Option<u64>,
) -> Result<u64, WireError> {
    let core = inner.lock();
    hostbridge::check_generation(&core, endpoint.generation)?;
    let grant = hostbridge::authorize(&core, link)?;
    if !grant.work
        || revision.is_some_and(|revision| grant.revision != revision)
        || matches!(&grant.scope,GrantScope::Projects{project_ids}if !project_ids.contains(&endpoint.workspace))
    {
        return Err(denied());
    }
    Ok(grant.revision)
}
/// The host renderer registers an explicitly selected project endpoint. The
/// address is never taken from LAN preview.open/http arguments.
pub(super) fn register(
    inner: &Arc<Inner>,
    generation: u64,
    workspace: String,
    address: SocketAddr,
) -> Result<String, WireError> {
    let ip = address.ip().to_canonical();
    if !ip.is_loopback() || address.port() == 0 || workspace.is_empty() || workspace.len() > 512 {
        return Err(invalid());
    }
    {
        let core = inner.lock();
        hostbridge::check_generation(&core, generation)?;
        if !core.settings.hosting {
            return Err(denied());
        }
    }
    let mut reg = registry().lock().unwrap();
    sweep(&mut reg);
    if reg.endpoints.len() >= 32 {
        return Err(busy());
    }
    let id = random_token()?;
    reg.endpoints.insert(
        id.clone(),
        Endpoint {
            owner: Arc::downgrade(inner),
            generation,
            workspace,
            address: SocketAddr::new(ip, address.port()),
            expires: Instant::now() + IDLE,
        },
    );
    Ok(id)
}
#[tauri::command]
pub(crate) fn remote_preview_register(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    workspace_id: String,
    address: String,
) -> Result<Value, WireError> {
    hostbridge::window_is_host(&window)?;
    let address = address.parse::<SocketAddr>().map_err(|_| invalid())?;
    Ok(json!({"endpointId":register(&state.inner,generation,workspace_id,address)?}))
}
/// Enumerates only locally registered, current-generation endpoints in the
/// caller's granted project. No address, URL or port crosses the wire.
#[tauri::command]
pub(crate) async fn remote_preview_list(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    device: String,
    workspace_id: String,
) -> Result<Value, WireError> {
    hostbridge::window_is_host(&window)?;
    let link = viewer_link(&state.inner, &device)?;
    link.request("preview.list", json!({"workspaceId":workspace_id}), IO_WAIT)
        .await
}
#[tauri::command]
pub(crate) async fn remote_preview_open(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    device: String,
    endpoint_id: String,
    path: Option<String>,
) -> Result<Value, WireError> {
    hostbridge::window_is_host(&window)?;
    let path = path.unwrap_or_else(|| "/".into());
    let mut opened = open_browser_at(&state.inner, &device, &endpoint_id, &path).await?;
    let url = opened["url"].as_str().ok_or_else(failure)?.to_owned();
    let result = tauri::async_runtime::spawn_blocking(move || browser::open(&url))
        .await
        .map_err(|_| failure())?;
    if let Some(fields) = result.as_object() {
        for (key, value) in fields {
            opened[key] = value.clone();
        }
    }
    Ok(opened)
}
#[tauri::command]
pub(crate) fn remote_preview_close(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    preview_id: String,
) -> Result<(), WireError> {
    hostbridge::window_is_host(&window)?;
    let mut reg = registry().lock().unwrap();
    if reg
        .browsers
        .get(&preview_id)
        .is_some_and(|s| owner(&s.owner, &state.inner))
    {
        if let Some(s) = reg.browsers.remove(&preview_id) {
            s.stop.send_replace(true);
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    workspace_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    endpoint_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Http {
    session_id: String,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Close {
    session_id: String,
}
async fn stopped(rx: &mut watch::Receiver<bool>) {
    if !*rx.borrow() {
        let _ = rx.changed().await;
    }
}
fn host_live(inner: &Inner, s: &HostSession) -> Result<(), WireError> {
    if *s.stop.borrow() || !s.link.is_open() || s.touched.lock().unwrap().elapsed() >= IDLE {
        return Err(denied());
    }
    host_authority(inner, &s.link, &s.endpoint, Some(s.revision)).map(|_| ())
}
pub(super) async fn handle_request(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    op: &str,
    args: Value,
) -> Result<Value, WireError> {
    match op {
        "preview.ws.open" | "preview.ws.write" | "preview.stream.read" | "preview.stream.close" => {
            streaming::handle(inner, link, op, args).await
        }
        "preview.list" => {
            let args: List = serde_json::from_value(args).map_err(|_| invalid())?;
            if args.workspace_id.is_empty() || args.workspace_id.len() > 512 {
                return Err(invalid());
            }
            {
                let core = inner.lock();
                let grant = hostbridge::authorize(&core, link)?;
                if !grant.work
                    || matches!(&grant.scope,GrantScope::Projects{project_ids}if !project_ids.contains(&args.workspace_id))
                {
                    return Err(denied());
                }
            }
            let endpoints: Vec<_> = {
                let reg = registry().lock().unwrap();
                reg.endpoints
                    .iter()
                    .filter(|(_, e)| {
                        owner(&e.owner, inner)
                            && e.expires > Instant::now()
                            && e.workspace == args.workspace_id
                    })
                    .map(|(id, e)| (id.clone(), e.clone()))
                    .collect()
            };
            let previews:Vec<_>=endpoints.into_iter().filter(|(_,e)|host_authority(inner,link,e,None).is_ok())
                .map(|(id,_)|json!({"endpointId":id,"workspaceId":args.workspace_id,"name":"Web preview"})).collect();
            Ok(json!({"previews":previews}))
        }
        "preview.open" => {
            let args: Open = serde_json::from_value(args).map_err(|_| invalid())?;
            let endpoint = registry()
                .lock()
                .unwrap()
                .endpoints
                .get(&args.endpoint_id)
                .filter(|e| owner(&e.owner, inner) && e.expires > Instant::now())
                .cloned()
                .ok_or_else(denied)?;
            let revision = host_authority(inner, link, &endpoint, None)?;
            let session = Arc::new(HostSession {
                owner: Arc::downgrade(inner),
                link: link.clone(),
                endpoint,
                revision,
                touched: Mutex::new(Instant::now()),
                transferred: std::sync::atomic::AtomicU64::new(0),
                stop: watch::channel(false).0,
                slots: Arc::new(Semaphore::new(4)),
                streams: Mutex::new(HashMap::new()),
            });
            let id = random_token()?;
            {
                let mut reg = registry().lock().unwrap();
                sweep(&mut reg);
                if reg.hosts.len() >= MAX_SESSIONS
                    || reg
                        .hosts
                        .values()
                        .filter(|s| {
                            owner(&s.owner, inner)
                                && s.link.peer_fingerprint == link.peer_fingerprint
                        })
                        .count()
                        >= PER_PEER
                {
                    return Err(busy());
                }
                reg.hosts.insert(id.clone(), session.clone());
            }
            if let Err(error) = host_live(inner, &session) {
                session.stop.send_replace(true);
                registry().lock().unwrap().hosts.remove(&id);
                return Err(error);
            }
            let key = id.clone();
            tokio::spawn(async move {
                let mut stop = session.stop.subscribe();
                let mut closed = session.link.closed();
                loop {
                    if !session.link.is_open() {
                        break;
                    }
                    let remaining = IDLE.saturating_sub(session.touched.lock().unwrap().elapsed());
                    tokio::select! {_=stopped(&mut stop)=>break,_=closed.changed()=>break,_=tokio::time::sleep(remaining)=>{if session.touched.lock().unwrap().elapsed()>=IDLE{break;}}}
                }
                session.stop.send_replace(true);
                session.link.send(&Frame::Evt {
                    stream: format!("preview:{key}"),
                    epoch: String::new(),
                    seq: 0,
                    data: json!({"closed":true}),
                });
                registry().lock().unwrap().hosts.remove(&key);
            });
            Ok(json!({"sessionId":id}))
        }
        // Viewer installs its local retirement target before this round-trip.
        // Otherwise a revoke event racing the open reply could arrive before
        // there is a BrowserSession to close and be silently lost.
        "preview.ready" => {
            let args: Close = serde_json::from_value(args).map_err(|_| invalid())?;
            let session = registry()
                .lock()
                .unwrap()
                .hosts
                .get(&args.session_id)
                .filter(|s| owner(&s.owner, inner) && s.link.id == link.id)
                .cloned()
                .ok_or_else(denied)?;
            host_live(inner, &session)?;
            Ok(json!({}))
        }
        "preview.close" => {
            let args: Close = serde_json::from_value(args).map_err(|_| invalid())?;
            let mut reg = registry().lock().unwrap();
            if reg
                .hosts
                .get(&args.session_id)
                .is_some_and(|s| owner(&s.owner, inner) && s.link.id == link.id)
            {
                if let Some(s) = reg.hosts.remove(&args.session_id) {
                    s.stop.send_replace(true);
                }
            }
            Ok(json!({}))
        }
        "preview.http" => {
            let request: Http = serde_json::from_value(args).map_err(|_| invalid())?;
            let session = registry()
                .lock()
                .unwrap()
                .hosts
                .get(&request.session_id)
                .filter(|s| owner(&s.owner, inner) && s.link.id == link.id)
                .cloned()
                .ok_or_else(denied)?;
            host_live(inner, &session)?;
            let _slot = session
                .slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| busy())?;
            *session.touched.lock().unwrap() = Instant::now();
            let mut stop = session.stop.subscribe();
            let mut closed = link.closed();
            let result = tokio::select! {biased;_=stopped(&mut stop)=>Err(denied()),_=closed.changed()=>Err(denied()),result=timeout(IO_WAIT,host_http(inner,session.clone(),request,_slot))=>result.map_err(|_|failure())?};
            host_live(inner, &session)?;
            result
        }
        _ => Err(invalid()),
    }
}
fn path_valid(path: &str) -> bool {
    path.len() <= 8192
        && path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && !path.contains('#')
        && path
            .parse::<axum::http::Uri>()
            .is_ok_and(|u| u.authority().is_none() && u.scheme().is_none())
}
fn method_valid(method: &str) -> bool {
    matches!(
        method,
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    )
}
fn request_header(name: &str) -> bool {
    matches!(
        name,
        "accept"
            | "accept-language"
            | "content-type"
            | "user-agent"
            | "if-none-match"
            | "if-modified-since"
            | "cache-control"
            | "cookie"
            | "x-csrf-token"
            | "x-xsrf-token"
            | "last-event-id"
    )
}
fn response_header(name: &str) -> bool {
    matches!(
        name,
        "content-type" | "cache-control" | "etag" | "last-modified" | "vary"
    )
}
/// Upstream cookies are host-only browser-session cookies at this preview's
/// unique hostname. Never forward Domain/Expires or permit a gateway-cookie
/// collision. Expired cookies still clear correctly. The listener and grant,
/// not cookie persistence, define the actual ten-minute idle authority window.
pub(super) fn rewrite_cookie(raw: &str) -> Result<(String, String), WireError> {
    if raw.len() > 4096 || raw.contains(['\r', '\n']) {
        return Err(failure());
    }
    let parsed = cookie::Cookie::parse(raw.to_owned()).map_err(|_| failure())?;
    let name = parsed.name();
    if name.is_empty()
        || name.len() > 128
        || name.starts_with(COOKIE_PREFIX)
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
    {
        return Err(failure());
    }
    let path = parsed.path().unwrap_or("/");
    if !path_valid(path) || path.contains(['?', ';']) {
        return Err(failure());
    }
    axum::http::HeaderValue::from_str(parsed.value()).map_err(|_| failure())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(i64::MAX, |d| d.as_secs() as i64);
    // Never turn a short-lived login cookie into an indefinite session cookie.
    // Retention is no longer than upstream requested (and at most one day);
    // the unique hostname/listener still makes it inert after preview closure.
    let age = parsed.max_age().map(|age| age.whole_seconds()).or_else(|| {
        parsed
            .expires_datetime()
            .map(|when| when.unix_timestamp().saturating_sub(now))
    });
    let mut cookie = cookie::Cookie::build((name.to_owned(), parsed.value().to_owned()))
        .path(path.to_owned())
        .same_site(cookie::SameSite::Strict)
        .http_only(parsed.http_only().unwrap_or(false))
        .secure(parsed.secure().unwrap_or(false))
        .build();
    if let Some(age) = age {
        cookie.set_max_age(cookie::time::Duration::seconds(age.clamp(0, 86400)));
    }
    Ok((name.to_owned(), cookie.to_string()))
}
fn browser_response_headers(
    session: &BrowserSession,
    headers: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, WireError> {
    if headers.len() > 32 {
        return Err(failure());
    }
    let mut bytes = 0;
    let mut result = Vec::new();
    for (name, value) in headers {
        bytes += name.len() + value.len();
        if bytes > HEAD_BYTES || value.contains(['\r', '\n']) {
            return Err(failure());
        }
        if name == "set-cookie" {
            let (name, value) = rewrite_cookie(&value)?;
            let mut names = session.cookies.lock().unwrap();
            if !names.contains(&name) && names.len() >= 64 {
                return Err(failure());
            }
            names.insert(name);
            result.push(("set-cookie".into(), value));
        } else {
            if !response_header(&name) && name != "location"
                || name == "location" && !path_valid(&value)
            {
                return Err(failure());
            }
            result.push((name, value));
        }
    }
    Ok(result)
}
fn forward_headers(
    request: &BrowserRequest,
    session: &BrowserSession,
) -> Result<Vec<(String, String)>, WireError> {
    let mut headers: Vec<_> = request
        .headers
        .iter()
        .filter(|(name, _)| request_header(name) && name != "cookie")
        .cloned()
        .collect();
    if let Some((_, cookie)) = request.headers.iter().find(|(name, _)| name == "cookie") {
        let names = session.cookies.lock().unwrap();
        // Only names issued by THIS preview's upstream may leave the browser.
        // Unknown ambient cookies and the gateway bearer are never forwarded.
        let cookies: Vec<_> = cookie
            .split(';')
            .filter_map(|part| {
                let (name, value) = part.trim().split_once('=')?;
                if names.contains(name) && !name.starts_with(COOKIE_PREFIX) {
                    Some(format!("{name}={value}"))
                } else {
                    None
                }
            })
            .collect();
        if !cookies.is_empty() {
            headers.push(("cookie".into(), cookies.join("; ")));
        }
    }
    if headers.len() > 32 {
        return Err(invalid());
    }
    Ok(headers)
}
// HTTP-only target URLs are constructed here, never supplied by a peer. Use
// an explicit TLS config anyway: reqwest's no-provider feature otherwise
// panics before sending even an HTTP request in an embedded/test runtime.
pub(super) fn http_client_builder() -> Result<reqwest::ClientBuilder, WireError> {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| failure())?
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(IO_WAIT))
}
async fn host_http(
    inner: &Arc<Inner>,
    session: Arc<HostSession>,
    request: Http,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Value, WireError> {
    if !method_valid(&request.method)
        || !path_valid(&request.path)
        || request.headers.len() > 32
        || request.body.len() > BODY_BYTES.div_ceil(3) * 4
    {
        return Err(invalid());
    }
    let body = STANDARD.decode(&request.body).map_err(|_| invalid())?;
    if body.len() > BODY_BYTES {
        return Err(invalid());
    }
    if session
        .transferred
        .fetch_add(body.len() as u64, std::sync::atomic::Ordering::AcqRel)
        .saturating_add(body.len() as u64)
        > SESSION_BYTES
    {
        session.stop.send_replace(true);
        return Err(busy());
    }
    let origin = format!("http://{}", session.endpoint.address);
    let url = format!("{origin}{}", request.path);
    let client = http_client_builder()?.build().map_err(|_| failure())?;
    let mut outgoing = client
        .request(request.method.parse().map_err(|_| invalid())?, url)
        .header("host", session.endpoint.address.to_string())
        .header("accept-encoding", "identity")
        .header("origin", &origin)
        .body(body);
    let mut header_bytes = 0;
    for (name, value) in request.headers {
        header_bytes += name.len() + value.len();
        if header_bytes > HEAD_BYTES || !request_header(&name) || value.contains(['\r', '\n']) {
            return Err(invalid());
        }
        outgoing = outgoing.header(&name, &value);
    }
    let response = outgoing.send().await.map_err(|_| failure())?;
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|value| value != "identity")
    {
        return Err(failure());
    }
    let status = response.status().as_u16();
    let mut headers = Vec::new();
    let mut bytes = 0;
    for (name, value) in response.headers() {
        bytes += name.as_str().len() + value.as_bytes().len();
        if bytes > HEAD_BYTES {
            return Err(failure());
        }
        if response_header(name.as_str()) {
            headers.push((
                name.as_str().to_owned(),
                value.to_str().map_err(|_| failure())?.to_owned(),
            ));
        }
    }
    if let Some(location) = response.headers().get("location") {
        let location = location.to_str().map_err(|_| failure())?;
        let target = if path_valid(location) {
            location.to_owned()
        } else {
            let absolute = reqwest::Url::parse(location).map_err(|_| failure())?;
            if absolute.origin().ascii_serialization() != origin
                || !absolute.username().is_empty()
                || absolute.password().is_some()
            {
                return Err(denied());
            }
            format!(
                "{}{}",
                absolute.path(),
                absolute
                    .query()
                    .map(|q| format!("?{q}"))
                    .unwrap_or_default()
            )
        };
        if !path_valid(&target) {
            return Err(denied());
        }
        headers.push(("location".into(), target));
    }
    for value in response.headers().get_all("set-cookie") {
        let (_, value) = rewrite_cookie(value.to_str().map_err(|_| failure())?)?;
        headers.push(("set-cookie".into(), value));
        if headers.len() > 32 {
            return Err(failure());
        }
    }
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    if sse && request.method != "HEAD" {
        let id = streaming::sse(inner, session, response, permit)?;
        return Ok(json!({"status":status,"headers":headers,"body":"","streamId":id}));
    }
    let mut body = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| failure())?;
        if body.len() + chunk.len() > BODY_BYTES {
            return Err(failure());
        }
        if session
            .transferred
            .fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::AcqRel)
            .saturating_add(chunk.len() as u64)
            > SESSION_BYTES
        {
            session.stop.send_replace(true);
            return Err(busy());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(json!({"status":status,"headers":headers,"body":STANDARD.encode(body)}))
}

fn viewer_link(inner: &Inner, device: &str) -> Result<Arc<Link>, WireError> {
    if !super::identity::fingerprint_is_valid(device) {
        return Err(invalid());
    }
    Ok({
        let core = inner.lock();
        if !core
            .devices
            .get(device)
            .is_some_and(|d| d.they_host && !d.access_removed)
        {
            return Err(denied());
        }
        hostbridge::current_link(&core, device, Role::Viewer).ok_or_else(denied)?
    })
}
#[cfg(test)]
pub(super) async fn open_browser(
    inner: &Arc<Inner>,
    device: &str,
    endpoint_id: &str,
) -> Result<Value, WireError> {
    open_browser_at(inner, device, endpoint_id, "/").await
}
pub(super) async fn open_browser_at(
    inner: &Arc<Inner>,
    device: &str,
    endpoint_id: &str,
    path: &str,
) -> Result<Value, WireError> {
    if !path_valid(path) {
        return Err(invalid());
    }
    let link = viewer_link(inner, device)?;
    if endpoint_id.is_empty() || endpoint_id.len() > 128 {
        return Err(invalid());
    }
    // Allocate fallible local resources before opening a remote session. If
    // admission loses a race after the reply, close that host session explicitly.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| failure())?;
    let address = listener.local_addr().map_err(|_| failure())?;
    let token = random_token()?;
    let preview_id = random_token()?;
    // Cookies ignore TCP ports (RFC 6265 8.5). Never host preview JavaScript on
    // the shared 127.0.0.1/localhost origin used by other local applications.
    // RFC 6761 reserves *.localhost for loopback. Browser support is a platform
    // qualification requirement; do NOT fall back to a shared numeric origin.
    let authority = format!(
        "p-{}.localhost:{}",
        uuid::Uuid::new_v4().simple(),
        address.port()
    );
    let reply = link
        .request("preview.open", json!({"endpointId":endpoint_id}), IO_WAIT)
        .await?;
    let host_id = reply
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(invalid)?
        .to_owned();
    let session = Arc::new(BrowserSession {
        owner: Arc::downgrade(inner),
        link: link.clone(),
        host_id,
        initial_path: path.to_owned(),
        touched: Mutex::new(Instant::now()),
        transferred: std::sync::atomic::AtomicU64::new(0),
        bootstrapped: std::sync::atomic::AtomicBool::new(false),
        cookies: Mutex::new(std::collections::HashSet::new()),
        stop: watch::channel(false).0,
    });
    let admitted = {
        let mut reg = registry().lock().unwrap();
        sweep(&mut reg);
        if !link.is_open()
            || reg.browsers.len() >= MAX_SESSIONS
            || reg
                .browsers
                .values()
                .filter(|s| owner(&s.owner, inner) && s.link.peer_fingerprint == device)
                .count()
                >= PER_PEER
        {
            false
        } else {
            reg.browsers.insert(preview_id.clone(), session.clone());
            true
        }
    };
    if !admitted {
        let _ = link
            .request(
                "preview.close",
                json!({"sessionId":session.host_id}),
                Duration::from_secs(2),
            )
            .await;
        return Err(busy());
    }
    if link
        .request(
            "preview.ready",
            json!({"sessionId":session.host_id}),
            IO_WAIT,
        )
        .await
        .is_err()
        || *session.stop.borrow()
        || !link.is_open()
    {
        session.stop.send_replace(true);
        registry().lock().unwrap().browsers.remove(&preview_id);
        let _ = link
            .request(
                "preview.close",
                json!({"sessionId":session.host_id}),
                Duration::from_secs(2),
            )
            .await;
        return Err(denied());
    }
    let cookie = format!("{COOKIE_PREFIX}{}", preview_id.replace('-', "_"));
    let url = format!("http://{authority}/{token}/");
    let key = preview_id.clone();
    tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(4));
        let mut stop = session.stop.subscribe();
        let mut closed = link.closed();
        loop {
            if !link.is_open() {
                break;
            }
            let remaining = IDLE.saturating_sub(session.touched.lock().unwrap().elapsed());
            tokio::select! {biased;_=stopped(&mut stop)=>break,_=closed.changed()=>break,
                _=tokio::time::sleep(remaining)=>{if session.touched.lock().unwrap().elapsed()>=IDLE{break;}},
                accepted=listener.accept()=>{let Ok((stream,peer))=accepted else{break};if !peer.ip().is_loopback(){continue;}
                    let Ok(permit)=slots.clone().try_acquire_owned()else{drop(stream);continue;};
                    let (s,t,c,a)=(session.clone(),token.clone(),cookie.clone(),authority.clone());
                    tokio::spawn(async move {let _permit=permit;let mut stop=s.stop.subscribe();let mut closed=s.link.closed();
                        tokio::select!{biased;_=stopped(&mut stop)=>{},_=closed.changed()=>{},_=browser_http(stream,&s,&a,&t,&c)=>{}}
                    });
                }
            }
        }
        session.stop.send_replace(true);
        registry().lock().unwrap().browsers.remove(&key);
        if link.is_open() {
            let _ = link
                .request(
                    "preview.close",
                    json!({"sessionId":session.host_id}),
                    Duration::from_secs(2),
                )
                .await;
        }
    });
    Ok(json!({"previewId":preview_id,"url":url,"expiresAfterIdleMs":IDLE.as_millis()}))
}
struct BrowserRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
async fn read_browser(stream: &mut TcpStream) -> Result<BrowserRequest, WireError> {
    let mut buffer = Vec::new();
    let header_end;
    loop {
        let mut chunk = [0u8; 2048];
        let read = stream.read(&mut chunk).await.map_err(|_| invalid())?;
        if read == 0 {
            return Err(invalid());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|v| v == b"\r\n\r\n") {
            header_end = end + 4;
            break;
        }
        if buffer.len() > HEAD_BYTES {
            return Err(invalid());
        }
    }
    if header_end > HEAD_BYTES {
        return Err(invalid());
    }
    let header = std::str::from_utf8(&buffer[..header_end]).map_err(|_| invalid())?;
    let mut lines = header.split("\r\n");
    let request = lines.next().ok_or_else(invalid)?;
    let parts: Vec<_> = request.split(' ').collect();
    if parts.len() != 3
        || !method_valid(parts[0])
        || !path_valid(parts[1])
        || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0")
    {
        return Err(invalid());
    }
    let method = parts[0].to_owned();
    let path = parts[1].to_owned();
    let mut headers = Vec::new();
    let mut length = None;
    let mut seen = std::collections::HashSet::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
        let name = name.to_ascii_lowercase();
        let value = value.trim().to_owned();
        axum::http::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
        axum::http::header::HeaderValue::from_str(&value).map_err(|_| invalid())?;
        // One request per connection, no trailers/transfer coding/upgrade or
        // duplicate framing/auth fields. Re-serialize, never relay raw HTTP.
        if !seen.insert(name.clone()) || matches!(name.as_str(), "transfer-encoding" | "expect") {
            return Err(invalid());
        }
        if name == "content-length" {
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            length = Some(value.parse::<usize>().map_err(|_| invalid())?);
        }
        headers.push((name, value));
        if headers.len() > 64 {
            return Err(invalid());
        }
    }
    let length = length.unwrap_or(0);
    if length > BODY_BYTES {
        return Err(invalid());
    }
    let mut body = buffer[header_end..].to_vec();
    if body.len() > length {
        return Err(invalid());
    }
    if body.len() < length {
        let have = body.len();
        body.resize(length, 0);
        stream
            .read_exact(&mut body[have..])
            .await
            .map_err(|_| invalid())?;
    }
    Ok(BrowserRequest {
        method,
        path,
        headers,
        body,
    })
}
fn browser_head(
    status: u16,
    headers: &[(String, String)],
    framing: &str,
    authority: &str,
) -> Result<String, WireError> {
    let status = axum::http::StatusCode::from_u16(status).map_err(|_| invalid())?;
    let policy = CSP.replace(
        "connect-src 'self';",
        &format!("connect-src 'self' ws://{authority};"),
    );
    let mut response=format!("HTTP/1.1 {} {}\r\n{framing}Connection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {policy}\r\n",status.as_u16(),status.canonical_reason().unwrap_or("Response"));
    for (name, value) in headers {
        if name == "cache-control" {
            continue;
        }
        if !response_header(name) && !matches!(name.as_str(), "location" | "set-cookie") {
            return Err(invalid());
        }
        if value.contains(['\r', '\n']) {
            return Err(invalid());
        }
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    Ok(response)
}
async fn send_browser(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(String, String)],
    body: &[u8],
    head: bool,
    authority: &str,
) -> Result<(), WireError> {
    let response = browser_head(
        status,
        headers,
        &format!("Content-Length: {}\r\n", body.len()),
        authority,
    )?;
    timeout(IO_WAIT, async {
        stream.write_all(response.as_bytes()).await?;
        if !head {
            stream.write_all(body).await?;
        }
        stream.shutdown().await
    })
    .await
    .map_err(|_| failure())?
    .map_err(|_| failure())
}
async fn browser_http(
    mut stream: TcpStream,
    session: &BrowserSession,
    authority: &str,
    token: &str,
    cookie: &str,
) {
    let mut committed = false;
    let result = async {
        let request = timeout(IO_WAIT, read_browser(&mut stream))
            .await
            .map_err(|_| invalid())??;
        let header = |key: &str| {
            request
                .headers
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.as_str())
        };
        let expected = authority;
        let origin = format!("http://{expected}");
        if header("host") != Some(expected) {
            return Err(denied());
        }
        if matches!(request.path.as_str(),p if p==format!("/{token}")||p==format!("/{token}/")) {
            if request.method != "GET"
                || !request.body.is_empty()
                || session
                    .bootstrapped
                    .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                return Err(invalid());
            }
            // Bootstrap uses an unguessable path once, then a session-specific
            // HttpOnly cookie supports root-relative assets without HTML rewrites.
            *session.touched.lock().unwrap() = Instant::now();
            return send_browser(
                &mut stream,
                303,
                &[
                    ("location".into(), session.initial_path.clone()),
                    (
                        "set-cookie".into(),
                        format!("{cookie}={token}; HttpOnly; SameSite=Strict; Path=/"),
                    ),
                ],
                &[],
                false,
                authority,
            )
            .await;
        }
        let authorized_cookie = header("cookie").is_some_and(|value| {
            value
                .split(';')
                .filter_map(|part| part.trim().split_once('='))
                .filter(|(name, _)| *name == cookie)
                .collect::<Vec<_>>()
                == vec![(cookie, token)]
        });
        let same_origin = header("origin") == Some(origin.as_str())
            || header("sec-fetch-site") == Some("same-origin")
            || (header("sec-fetch-site") == Some("none")
                && header("sec-fetch-mode") == Some("navigate")
                && header("sec-fetch-dest") == Some("document"))
            || header("referer").is_some_and(|r| r.starts_with(&format!("{origin}/")));
        if !authorized_cookie || !same_origin {
            return Err(denied());
        }
        *session.touched.lock().unwrap() = Instant::now();
        if session
            .transferred
            .fetch_add(
                request.body.len() as u64,
                std::sync::atomic::Ordering::AcqRel,
            )
            .saturating_add(request.body.len() as u64)
            > SESSION_BYTES
        {
            session.stop.send_replace(true);
            return Err(busy());
        }
        if request.headers.iter().any(|(name, _)| name == "upgrade") {
            return streaming::browser_ws(&mut stream, session, request, authority, &mut committed)
                .await;
        }
        let headers = forward_headers(&request, session)?;
        let args = Http {
            session_id: session.host_id.clone(),
            method: request.method.clone(),
            path: request.path,
            headers,
            body: STANDARD.encode(request.body),
        };
        let result = session
            .link
            .request(
                "preview.http",
                serde_json::to_value(args).map_err(|_| invalid())?,
                IO_WAIT,
            )
            .await?;
        let response: HttpResponse = serde_json::from_value(result).map_err(|_| failure())?;
        if response.body.len() > BODY_BYTES.div_ceil(3) * 4 || response.headers.len() > 32 {
            return Err(failure());
        }
        let mut headers = browser_response_headers(session, response.headers)?;
        headers.push((
            "set-cookie".into(),
            format!("{cookie}={token}; HttpOnly; SameSite=Strict; Path=/"),
        ));
        if let Some(id) = response.stream_id {
            if id.is_empty()
                || id.len() > 128
                || request.method == "HEAD"
                || !response.body.is_empty()
            {
                return Err(failure());
            }
            return streaming::browser_sse(
                &mut stream,
                session,
                &id,
                response.status,
                &headers,
                authority,
                &mut committed,
            )
            .await;
        }
        let body = STANDARD.decode(&response.body).map_err(|_| failure())?;
        if body.len() > BODY_BYTES {
            return Err(failure());
        }
        if session
            .transferred
            .fetch_add(body.len() as u64, std::sync::atomic::Ordering::AcqRel)
            .saturating_add(body.len() as u64)
            > SESSION_BYTES
        {
            session.stop.send_replace(true);
            return Err(busy());
        }
        send_browser(
            &mut stream,
            response.status,
            &headers,
            &body,
            request.method == "HEAD",
            authority,
        )
        .await
    }
    .await;
    if result.is_err() && !committed {
        let _ = send_browser(
            &mut stream,
            403,
            &[],
            b"Preview unavailable. Open it again from Mythra Code.",
            false,
            authority,
        )
        .await;
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    #[serde(default)]
    stream_id: Option<String>,
}
