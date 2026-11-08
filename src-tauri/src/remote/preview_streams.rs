//! Bounded pull streams over the existing authenticated request/reply channel.
//! A stream cannot choose an address; it inherits one preview session's endpoint.
use super::*;
use futures_util::SinkExt;
use tokio::sync::{mpsc, OwnedSemaphorePermit};
use tokio_tungstenite::{
    tungstenite::{
        self,
        client::IntoClientRequest,
        protocol::{Role as WsRole, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};
const CHUNK: usize = 64 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    kind: String,
    body: String,
}
struct Packet {
    chunk: Chunk,
    sent: Option<tokio::sync::oneshot::Sender<bool>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Closing {
    code: Option<u16>,
    reason: String,
}
fn close_bytes(frame: Option<tungstenite::protocol::CloseFrame>) -> Vec<u8> {
    let closing = frame.map_or(
        Closing {
            code: None,
            reason: String::new(),
        },
        |f| Closing {
            code: Some(f.code.into()),
            reason: f.reason.to_string(),
        },
    );
    serde_json::to_vec(&closing).unwrap_or_default()
}
fn decode_message(kind: &str, bytes: Vec<u8>) -> Result<Message, WireError> {
    Ok(match kind {
        "text" => Message::Text(String::from_utf8(bytes).map_err(|_| invalid())?.into()),
        "binary" => Message::Binary(bytes.into()),
        "close" => {
            if bytes.len() > 1024 {
                return Err(invalid());
            }
            let closing: Closing = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if closing.reason.len() > 123 {
                return Err(invalid());
            }
            Message::Close(match closing.code {
                None => {
                    if !closing.reason.is_empty() {
                        return Err(invalid());
                    }
                    None
                }
                Some(code) => {
                    let code = tungstenite::protocol::frame::coding::CloseCode::from(code);
                    if !code.is_allowed() {
                        return Err(invalid());
                    }
                    Some(tungstenite::protocol::CloseFrame {
                        code,
                        reason: closing.reason.into(),
                    })
                }
            })
        }
        _ => return Err(invalid()),
    })
}
pub(super) struct HostStream {
    incoming: tokio::sync::Mutex<mpsc::Receiver<Chunk>>,
    outgoing: Option<mpsc::Sender<Packet>>,
    stop: watch::Sender<bool>,
    finished: std::sync::atomic::AtomicBool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamArgs {
    session_id: String,
    stream_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteArgs {
    session_id: String,
    stream_id: String,
    kind: String,
    body: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WsOpen {
    session_id: String,
    path: String,
    headers: Vec<(String, String)>,
    protocols: Vec<String>,
}
fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(16 * 1024)
        .max_write_buffer_size(128 * 1024)
        .max_frame_size(Some(CHUNK))
        .max_message_size(Some(CHUNK))
}
fn session(inner: &Inner, link: &Link, id: &str) -> Result<Arc<HostSession>, WireError> {
    let session = registry()
        .lock()
        .unwrap()
        .hosts
        .get(id)
        .filter(|s| owner(&s.owner, inner) && s.link.id == link.id)
        .cloned()
        .ok_or_else(denied)?;
    host_live(inner, &session)?;
    Ok(session)
}
fn account(session: &HostSession, bytes: usize) -> Result<(), WireError> {
    if session
        .transferred
        .fetch_add(bytes as u64, std::sync::atomic::Ordering::AcqRel)
        .saturating_add(bytes as u64)
        > SESSION_BYTES
    {
        session.stop.send_replace(true);
        return Err(busy());
    }
    if bytes > 0 {
        *session.touched.lock().unwrap() = Instant::now();
    }
    Ok(())
}
fn install(
    session: &HostSession,
    outgoing: Option<mpsc::Sender<Packet>>,
) -> Result<(String, Arc<HostStream>, mpsc::Sender<Chunk>), WireError> {
    let mut streams = session.streams.lock().unwrap();
    if streams.len() >= 4 {
        return Err(busy());
    }
    let id = random_token()?;
    let (tx, rx) = mpsc::channel(4);
    let stream = Arc::new(HostStream {
        incoming: tokio::sync::Mutex::new(rx),
        outgoing,
        stop: watch::channel(false).0,
        finished: std::sync::atomic::AtomicBool::new(false),
    });
    streams.insert(id.clone(), stream.clone());
    Ok((id, stream, tx))
}
fn finish(stream: &HostStream, tx: &mpsc::Sender<Chunk>) {
    let _ = tx.try_send(Chunk {
        kind: "end".into(),
        body: String::new(),
    });
    stream
        .finished
        .store(true, std::sync::atomic::Ordering::Release);
}
pub(super) async fn handle(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    op: &str,
    args: Value,
) -> Result<Value, WireError> {
    if op == "preview.ws.open" {
        return ws_open(
            inner,
            link,
            serde_json::from_value(args).map_err(|_| invalid())?,
        )
        .await;
    }
    if op == "preview.ws.write" {
        let args: WriteArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        let session = session(inner, link, &args.session_id)?;
        let stream = session
            .streams
            .lock()
            .unwrap()
            .get(&args.stream_id)
            .cloned()
            .ok_or_else(denied)?;
        if !matches!(args.kind.as_str(), "text" | "binary" | "close")
            || args.body.len() > CHUNK.div_ceil(3) * 4
        {
            return Err(invalid());
        }
        let bytes = STANDARD.decode(&args.body).map_err(|_| invalid())?;
        if bytes.len() > CHUNK || args.kind == "text" && std::str::from_utf8(&bytes).is_err() {
            return Err(invalid());
        }
        decode_message(&args.kind, bytes)?;
        let closing = args.kind == "close";
        let (tx, rx) = tokio::sync::oneshot::channel();
        stream
            .outgoing
            .as_ref()
            .ok_or_else(invalid)?
            .try_send(Packet {
                chunk: Chunk {
                    kind: args.kind,
                    body: args.body,
                },
                sent: closing.then_some(tx),
            })
            .map_err(|_| busy())?;
        if closing {
            let mut stop = session.stop.subscribe();
            let mut closed = link.closed();
            let sent = tokio::select! {biased;_=stopped(&mut stop)=>false,_=closed.changed()=>false,result=timeout(IO_WAIT,rx)=>matches!(result,Ok(Ok(true)))};
            if !sent {
                return Err(failure());
            }
        }
        return Ok(json!({}));
    }
    let args: StreamArgs = serde_json::from_value(args).map_err(|_| invalid())?;
    let session = session(inner, link, &args.session_id)?;
    let stream = session
        .streams
        .lock()
        .unwrap()
        .get(&args.stream_id)
        .cloned()
        .ok_or_else(denied)?;
    if op == "preview.stream.close" {
        stream.stop.send_replace(true);
        session.streams.lock().unwrap().remove(&args.stream_id);
        return Ok(json!({}));
    }
    if op != "preview.stream.read" {
        return Err(invalid());
    }
    let mut rx = stream.incoming.try_lock().map_err(|_| busy())?;
    let mut stop = session.stop.subscribe();
    let mut stream_stop = stream.stop.subscribe();
    let mut closed = link.closed();
    let chunk = tokio::select! {biased;_=stopped(&mut stop)=>return Err(denied()),_=stopped(&mut stream_stop)=>return Err(denied()),_=closed.changed()=>return Err(denied()),chunk=timeout(Duration::from_secs(10),rx.recv())=>match chunk{Err(_)=>Chunk{kind:"wait".into(),body:String::new()},Ok(Some(chunk))=>chunk,Ok(None)=>Chunk{kind:"end".into(),body:String::new()}}};
    host_live(inner, &session)?;
    if chunk.kind == "end" {
        session.streams.lock().unwrap().remove(&args.stream_id);
    }
    serde_json::to_value(chunk).map_err(|_| failure())
}
pub(super) fn sse(
    inner: &Arc<Inner>,
    session: Arc<HostSession>,
    response: reqwest::Response,
    permit: OwnedSemaphorePermit,
) -> Result<String, WireError> {
    let (id, stream, tx) = install(&session, None)?;
    let inner = Arc::downgrade(inner);
    tokio::spawn(async move {
        let _permit = permit;
        let mut body = response.bytes_stream();
        let mut stop = session.stop.subscribe();
        let mut stream_stop = stream.stop.subscribe();
        let mut closed = session.link.closed();
        loop {
            let next = tokio::select! {biased;_=stopped(&mut stop)=>break,_=stopped(&mut stream_stop)=>break,_=closed.changed()=>break,next=body.next()=>next};
            let Some(Ok(bytes)) = next else {
                break;
            };
            let Some(inner) = inner.upgrade() else {
                break;
            };
            if host_live(&inner, &session).is_err() {
                break;
            }
            let mut failed = false;
            for part in bytes.chunks(CHUNK) {
                if account(&session, part.len()).is_err() {
                    failed = true;
                    break;
                }
                let chunk = Chunk {
                    kind: "data".into(),
                    body: STANDARD.encode(part),
                };
                if tokio::select! {biased;_=stopped(&mut stop)=>true,_=stopped(&mut stream_stop)=>true,_=closed.changed()=>true,result=timeout(IO_WAIT,tx.send(chunk))=>!matches!(result,Ok(Ok(())))}
                {
                    failed = true;
                    break;
                }
            }
            if failed {
                break;
            }
        }
        finish(&stream, &tx);
    });
    Ok(id)
}
fn protocol_valid(protocol: &str) -> bool {
    !protocol.is_empty()
        && protocol.len() <= 128
        && protocol
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}
async fn ws_open(inner: &Arc<Inner>, link: &Arc<Link>, args: WsOpen) -> Result<Value, WireError> {
    let session = session(inner, link, &args.session_id)?;
    if !path_valid(&args.path)
        || args.protocols.len() > 8
        || args.protocols.iter().any(|p| !protocol_valid(p))
        || args.headers.len() > 32
    {
        return Err(invalid());
    }
    let permit = session
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let url = format!("ws://{}{}", session.endpoint.address, args.path);
    let mut request = url.into_client_request().map_err(|_| invalid())?;
    request.headers_mut().insert(
        "origin",
        format!("http://{}", session.endpoint.address)
            .parse()
            .map_err(|_| invalid())?,
    );
    let mut bytes = 0;
    for (name, value) in args.headers {
        bytes += name.len() + value.len();
        if bytes > HEAD_BYTES || !request_header(&name) {
            return Err(invalid());
        }
        request.headers_mut().insert(
            axum::http::HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?,
            value.parse().map_err(|_| invalid())?,
        );
    }
    if !args.protocols.is_empty() {
        request.headers_mut().insert(
            "sec-websocket-protocol",
            args.protocols.join(", ").parse().map_err(|_| invalid())?,
        );
    }
    let mut stop = session.stop.subscribe();
    let mut closed = link.closed();
    let (socket, response) = tokio::select! {biased;_=stopped(&mut stop)=>return Err(denied()),_=closed.changed()=>return Err(denied()),result=timeout(IO_WAIT,async{let tcp=TcpStream::connect(session.endpoint.address).await.map_err(|_|failure())?;tokio_tungstenite::client_async_with_config(request,tcp,Some(config())).await.map_err(|_|failure())})=>result.map_err(|_|failure())??};
    host_live(inner, &session)?;
    let protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .map(|p| p.to_str().map(str::to_owned).map_err(|_| failure()))
        .transpose()?;
    if protocol
        .as_ref()
        .is_some_and(|p| !args.protocols.contains(p))
    {
        return Err(failure());
    }
    let mut headers = Vec::new();
    for value in response.headers().get_all("set-cookie") {
        let (_, value) = rewrite_cookie(value.to_str().map_err(|_| failure())?)?;
        headers.push(("set-cookie".to_owned(), value));
        if headers.len() > 32 {
            return Err(failure());
        }
    }
    let (outgoing, mut outgoing_rx) = mpsc::channel::<Packet>(4);
    let (id, stream, incoming) = install(&session, Some(outgoing))?;
    let inner = Arc::downgrade(inner);
    tokio::spawn(async move {
        let _permit = permit;
        let mut stop = session.stop.subscribe();
        let mut stream_stop = stream.stop.subscribe();
        let mut closed = session.link.closed();
        let (mut sink, mut source) = socket.split();
        loop {
            tokio::select! {biased;_=stopped(&mut stop)=>break,_=stopped(&mut stream_stop)=>break,_=closed.changed()=>break,
                next=source.next()=>{let Some(Ok(next))=next else{break;};let (kind,bytes)=match next{Message::Text(text)=>("text",text.as_bytes().to_vec()),Message::Binary(bytes)=>("binary",bytes.to_vec()),Message::Close(frame)=>("close",close_bytes(frame)),_=>continue};
                    let Some(inner)=inner.upgrade()else{break;};if host_live(&inner,&session).is_err()||account(&session,bytes.len()).is_err(){break;}
                    if incoming.try_send(Chunk{kind:kind.into(),body:STANDARD.encode(bytes)}).is_err(){break;}if kind=="close"{let _=timeout(IO_WAIT,sink.flush()).await;break;}
                },
                next=outgoing_rx.recv()=>{let Some(packet)=next else{break;};let next=packet.chunk;let Ok(bytes)=STANDARD.decode(&next.body)else{break;};let Some(inner)=inner.upgrade()else{break;};if host_live(&inner,&session).is_err()||account(&session,bytes.len()).is_err(){break;}
                    let Ok(message)=decode_message(&next.kind,bytes)else{break;};let closing=next.kind=="close";
                    let sent=tokio::select!{biased;_=stopped(&mut stop)=>false,_=stopped(&mut stream_stop)=>false,_=closed.changed()=>false,result=timeout(IO_WAIT,sink.send(message))=>matches!(result,Ok(Ok(())))};
                    if let Some(reply)=packet.sent{let _=reply.send(sent);}if !sent||closing{break;}

                }
            }
        }
        finish(&stream, &incoming);
    });
    Ok(json!({"streamId":id,"protocol":protocol,"headers":headers}))
}
async fn read_remote(session: &BrowserSession, id: &str) -> Result<Chunk, WireError> {
    let chunk: Chunk = serde_json::from_value(
        session
            .link
            .request(
                "preview.stream.read",
                json!({"sessionId":session.host_id,"streamId":id}),
                IO_WAIT,
            )
            .await?,
    )
    .map_err(|_| failure())?;
    if !matches!(
        chunk.kind.as_str(),
        "wait" | "end" | "data" | "binary" | "text" | "close"
    ) || chunk.body.len() > CHUNK.div_ceil(3) * 4
        || matches!(chunk.kind.as_str(), "wait" | "end") && !chunk.body.is_empty()
    {
        return Err(failure());
    }
    Ok(chunk)
}
fn browser_account(session: &BrowserSession, bytes: usize) -> Result<(), WireError> {
    if session
        .transferred
        .fetch_add(bytes as u64, std::sync::atomic::Ordering::AcqRel)
        .saturating_add(bytes as u64)
        > SESSION_BYTES
    {
        session.stop.send_replace(true);
        return Err(busy());
    }
    if bytes > 0 {
        *session.touched.lock().unwrap() = Instant::now();
    }
    Ok(())
}
async fn close_remote(session: &BrowserSession, id: &str) {
    let _ = session
        .link
        .request(
            "preview.stream.close",
            json!({"sessionId":session.host_id,"streamId":id}),
            Duration::from_secs(2),
        )
        .await;
}
pub(super) async fn browser_sse(
    socket: &mut TcpStream,
    session: &BrowserSession,
    id: &str,
    status: u16,
    headers: &[(String, String)],
    authority: &str,
    committed: &mut bool,
) -> Result<(), WireError> {
    let result = async {
        let head = browser_head(status, headers, "Transfer-Encoding: chunked\r\n", authority)?;
        *committed = true;
        timeout(IO_WAIT, socket.write_all(head.as_bytes()))
            .await
            .map_err(|_| failure())?
            .map_err(|_| failure())?;
        loop {
            let chunk = read_remote(session, id).await?;
            match chunk.kind.as_str() {
                "wait" => continue,
                "end" => break,
                "data" => {}
                _ => return Err(failure()),
            }
            let data = STANDARD.decode(chunk.body).map_err(|_| failure())?;
            if data.len() > CHUNK {
                return Err(failure());
            }
            browser_account(session, data.len())?;
            if data.is_empty() {
                continue;
            }
            timeout(IO_WAIT, async {
                socket
                    .write_all(format!("{:x}\r\n", data.len()).as_bytes())
                    .await?;
                socket.write_all(&data).await?;
                socket.write_all(b"\r\n").await
            })
            .await
            .map_err(|_| failure())?
            .map_err(|_| failure())?;
        }
        timeout(IO_WAIT, socket.write_all(b"0\r\n\r\n"))
            .await
            .map_err(|_| failure())?
            .map_err(|_| failure())?;
        Ok(())
    }
    .await;
    close_remote(session, id).await;
    result
}
pub(super) async fn browser_ws(
    socket: &mut TcpStream,
    session: &BrowserSession,
    request: BrowserRequest,
    authority: &str,
    committed: &mut bool,
) -> Result<(), WireError> {
    let header = |key: &str| {
        request
            .headers
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    if request.method != "GET"
        || !request.body.is_empty()
        || header("upgrade").is_none_or(|v| !v.eq_ignore_ascii_case("websocket"))
        || !header("connection").is_some_and(|v| {
            v.split(',')
                .any(|v| v.trim().eq_ignore_ascii_case("upgrade"))
        })
        || header("sec-websocket-version") != Some("13")
        || header("origin") != Some(format!("http://{authority}").as_str())
    {
        return Err(denied());
    }
    let key = header("sec-websocket-key").ok_or_else(invalid)?.to_owned();
    if STANDARD.decode(&key).map_or(true, |key| key.len() != 16) {
        return Err(invalid());
    }
    let protocols: Vec<String> = header("sec-websocket-protocol")
        .map(|v| v.split(',').map(|p| p.trim().to_owned()).collect())
        .unwrap_or_default();
    if protocols.len() > 8 || protocols.iter().any(|p| !protocol_valid(p)) {
        return Err(invalid());
    }
    let headers = forward_headers(&request, session)?;
    let result=session.link.request("preview.ws.open",json!({"sessionId":session.host_id,"path":request.path,"headers":headers,"protocols":protocols}),IO_WAIT).await?;
    let id = result
        .get("streamId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or_else(failure)?
        .to_owned();
    let result=async{
        let protocol=result.get("protocol").and_then(Value::as_str);if protocol.is_some_and(|p|!protocols.iter().any(|v|v==p)){return Err(failure());}
        let headers:Vec<(String,String)>=serde_json::from_value(result["headers"].clone()).map_err(|_|failure())?;
        let headers=browser_response_headers(session,headers)?;
        let mut response=format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n",tungstenite::handshake::derive_accept_key(key.as_bytes()));
        if let Some(protocol)=protocol{response.push_str(&format!("Sec-WebSocket-Protocol: {protocol}\r\n"));}
        for(name,value)in headers{if name!="set-cookie"{return Err(failure());}response.push_str(&format!("Set-Cookie: {value}\r\n"));}response.push_str("\r\n");
        *committed=true;
        timeout(IO_WAIT,socket.write_all(response.as_bytes())).await.map_err(|_|failure())?.map_err(|_|failure())?;
        let ws=WebSocketStream::from_raw_socket(socket,WsRole::Server,Some(config())).await;let(sink,source)=ws.split();
        browser_ws_continue(source,sink,session,&id).await
    }.await;
    close_remote(session, &id).await;
    result
}
async fn browser_ws_continue<R, W>(
    mut source: R,
    mut sink: W,
    session: &BrowserSession,
    id: &str,
) -> Result<(), WireError>
where
    R: futures_util::Stream<Item = Result<Message, tungstenite::Error>> + Unpin,
    W: futures_util::Sink<Message, Error = tungstenite::Error> + Unpin,
{
    let next = || {
        Box::pin(async {
            loop {
                let chunk = read_remote(session, id).await?;
                if chunk.kind != "wait" {
                    return Ok::<Chunk, WireError>(chunk);
                }
            }
        })
    };
    let mut read = next();
    loop {
        tokio::select! {
            chunk=&mut read=>{let chunk=chunk?;if chunk.kind=="end"{let _=timeout(IO_WAIT,sink.send(Message::Close(None))).await;return Ok(());}
                let bytes=STANDARD.decode(chunk.body).map_err(|_|failure())?;if bytes.len()>CHUNK{return Err(failure());}browser_account(session,bytes.len())?;
                let closing=chunk.kind=="close";let message=decode_message(&chunk.kind,bytes)?;
                timeout(IO_WAIT,sink.send(message)).await.map_err(|_|failure())?.map_err(|_|failure())?;if closing{return Ok(());}read=next();
            },
            message=source.next()=>{let Some(Ok(message))=message else{return Ok(());};if !browser_write(session,id,message).await?{let _=timeout(IO_WAIT,sink.flush()).await;return Ok(());}}
        }
    }
}
async fn browser_write(
    session: &BrowserSession,
    id: &str,
    message: Message,
) -> Result<bool, WireError> {
    let (kind, bytes) = match message {
        Message::Text(text) => ("text", text.as_bytes().to_vec()),
        Message::Binary(bytes) => ("binary", bytes.to_vec()),
        Message::Close(frame) => ("close", close_bytes(frame)),
        _ => return Ok(true),
    };
    if bytes.len() > CHUNK {
        return Err(invalid());
    }
    browser_account(session, bytes.len())?;
    session.link.request("preview.ws.write",json!({"sessionId":session.host_id,"streamId":id,"kind":kind,"body":STANDARD.encode(bytes)}),IO_WAIT).await?;
    Ok(kind != "close")
}
