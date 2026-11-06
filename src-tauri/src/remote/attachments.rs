//! Chunked uploads into app-owned attachment storage. No viewer path is used.
use super::{
    commit::{self, Stamp},
    finish_write,
    fs_guard::{self, Anchor},
    work, Inner,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::Arc,
};
const MAX: u64 = 50 * 1024 * 1024;
fn failed() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: The host could not confirm this upload. Check the attachment before trying again.".into()
}
fn invalid() -> String {
    work::refused("invalid")
}
pub(super) fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS remote_uploads(id TEXT PRIMARY KEY,device TEXT NOT NULL,workspace TEXT NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,size INTEGER NOT NULL,offset INTEGER NOT NULL,leaf TEXT NOT NULL,expires INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS remote_attachment_refs(attachment_id TEXT NOT NULL,device TEXT NOT NULL,op_id TEXT NOT NULL,thread_id TEXT,message_id TEXT,PRIMARY KEY(attachment_id,device,op_id));")
}
pub(super) fn validate(args: &Value) -> Result<(), String> {
    let phase = args
        .get("phase")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if !matches!(phase, "begin" | "chunk" | "finish" | "cancel") {
        return Err(invalid());
    }
    if phase == "begin" {
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if !fs_guard::leaf(name)
            || !matches!(
                args.get("kind").and_then(Value::as_str),
                Some("image" | "file")
            )
            || !args
                .get("size")
                .and_then(Value::as_u64)
                .is_some_and(|v| v > 0 && v <= MAX)
        {
            return Err(invalid());
        }
    } else if !args
        .get("uploadId")
        .and_then(Value::as_str)
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    {
        return Err(invalid());
    }
    if phase == "chunk" {
        if !args
            .get("offset")
            .and_then(Value::as_u64)
            .is_some_and(|v| v <= MAX)
            || !args
                .get("data")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty() && v.len() <= 87384)
        {
            return Err(invalid());
        }
    }
    if phase == "finish"
        && !args
            .get("sha256")
            .and_then(Value::as_str)
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(invalid());
    }
    Ok(())
}
fn directory(inner: &Inner, kind: &str) -> Result<PathBuf, String> {
    let app = inner.app.get().ok_or_else(failed)?;
    crate::release_qa::app_data_dir(app)
        .map_err(|_| failed())
        .map(|root| {
            root.join(if kind == "image" {
                "message-images"
            } else {
                "message-attachments"
            })
        })
}
fn image_ok(name: &str, bytes: &[u8]) -> bool {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}
pub(super) async fn put(inner: &Arc<Inner>, stamp: Stamp, args: Value) -> Result<Value, String> {
    validate(&args)?;
    let worker = inner.clone();
    let saved=inner.enqueue_write(false,move|db|{
        if commit::operation(db,&stamp)?!="attachment.put"{return Err(invalid());}
        if let Some(result)=commit::prior(db,&stamp)?{return Ok(result);}
        let phase=args["phase"].as_str().ok_or_else(invalid)?;
        let now=crate::unix_timestamp_ms();
        // On-demand sweep only. Completed, referenced attachments are durable.
        let expired:Vec<(String,String,String)>={let mut q=db.prepare("SELECT id,kind,leaf FROM remote_uploads WHERE expires<?1 AND NOT EXISTS(SELECT 1 FROM remote_attachment_refs r WHERE r.attachment_id=remote_uploads.id) LIMIT 64").map_err(|_|failed())?;let rows=q.query_map([now],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|failed())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|failed())?;rows};
        for(id,kind,leaf)in expired{if fs_guard::leaf(&leaf){if let Ok(dir)=directory(&worker,&kind){let _=std::fs::remove_file(dir.join(&leaf));}}db.execute("DELETE FROM remote_uploads WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM remote_attachment_refs r WHERE r.attachment_id=remote_uploads.id)",[id]).map_err(|_|failed())?;}
        let tx=db.transaction().map_err(|_|failed())?;
        let mut result=json!({"opId":stamp.op_id,"state":"accepted"});
        if phase=="begin"{
            let workspace=stamp.workspace_id.as_deref().ok_or_else(invalid)?;let name=args["name"].as_str().ok_or_else(invalid)?;let kind=args["kind"].as_str().ok_or_else(invalid)?;let size=args["size"].as_u64().ok_or_else(invalid)?;
            let (count,total,own_count,own_size):(i64,i64,i64,i64)=tx.query_row("SELECT COUNT(*),COALESCE(SUM(size),0),COALESCE(SUM(device=?1),0),COALESCE(SUM(CASE WHEN device=?1 THEN size ELSE 0 END),0) FROM remote_uploads WHERE NOT EXISTS(SELECT 1 FROM remote_attachment_refs r WHERE r.attachment_id=remote_uploads.id)",[&stamp.device],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|failed())?;
            if count>=16||own_count>=4||total+size as i64>200*1024*1024||own_size+size as i64>100*1024*1024{return Err(work::refused("busy"));}
            let projects:Option<String>=tx.query_row("SELECT value FROM app_state WHERE key='kiwi.projects'",[],|r|r.get(0)).optional().map_err(|_|failed())?;
            if !projects.and_then(|s|serde_json::from_str::<Value>(&s).ok()).and_then(|v|v.as_array().cloned()).is_some_and(|ps|ps.iter().any(|p|p.get("id").and_then(Value::as_str)==Some(workspace))){return Err(work::refused("thread_unavailable"));}
            let id=uuid::Uuid::new_v4().to_string();let ext=std::path::Path::new(name).extension().and_then(|e|e.to_str()).filter(|e|e.len()<=16&&e.bytes().all(|b|b.is_ascii_alphanumeric())).unwrap_or("bin");let leaf=format!("remote-{id}.{ext}");
            let directory=directory(&worker,kind)?;std::fs::create_dir_all(&directory).map_err(|_|failed())?;let anchor=Anchor::open(&directory)?;
            let core=worker.lock();stamp.check(&core,"attachment.put")?;let file=fs_guard::create_new(&anchor,&leaf)?;file.sync_all().map_err(|_|failed())?;
            tx.execute("INSERT INTO remote_uploads(id,device,workspace,generation,revision,name,kind,size,offset,leaf,expires) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?10)",params![id,stamp.device,workspace,stamp.generation as i64,stamp.grant_revision as i64,name,kind,size as i64,leaf,now+15*60000]).map_err(|_|failed())?;
            result["uploadId"]=json!(id);result["nextOffset"]=json!(0);commit::complete(&tx,&stamp,"attachment.put",&result,false)?;tx.commit().map_err(|_|failed())?;drop(core);return Ok(result);
        }
        let id=args["uploadId"].as_str().ok_or_else(invalid)?;
        let row:Option<(String,String,i64,i64,i64,String,i64)>=tx.query_row("SELECT name,kind,size,offset,complete,leaf,expires FROM remote_uploads WHERE id=?1 AND device=?2 AND workspace=?3 AND generation=?4 AND revision=?5",params![id,stamp.device,stamp.workspace_id,stamp.generation as i64,stamp.grant_revision as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(|_|failed())?;
        let (name,kind,size,offset,complete,leaf,expires)=row.ok_or_else(invalid)?;if expires<now||(complete!=0&&phase!="cancel")||!fs_guard::leaf(&leaf){return Err(invalid());}
        let dir=directory(&worker,&kind)?;let anchor=Anchor::open(&dir)?;
        let mut final_hash=None;
        if phase=="finish"{
            if offset!=size{return Err(invalid());}
            // Hash outside the authority lock; final publication rechecks it.
            use sha2::{Digest,Sha256};let mut file=anchor.regular(&leaf)?;let mut hasher=Sha256::new();let mut buffer=[0u8;65536];let mut total=0u64;let mut header=Vec::new();loop{let n=file.read(&mut buffer).map_err(|_|failed())?;if n==0{break;}total+=n as u64;if total>MAX{return Err(invalid());}if header.is_empty(){header.extend_from_slice(&buffer[..n.min(16)]);}hasher.update(&buffer[..n]);}
            if total!=size as u64||kind=="image"&&!image_ok(&name,&header){return Err(invalid());}final_hash=Some(format!("{:x}",hasher.finalize()));
        }
        let core=worker.lock();stamp.check(&core,"attachment.put")?;anchor.validate()?;
        match phase{
            "chunk"=>{let data=STANDARD.decode(args["data"].as_str().ok_or_else(invalid)?).map_err(|_|invalid())?;if data.is_empty()||data.len()>65536||args["offset"].as_i64()!=Some(offset)||offset+data.len() as i64>size{return Err(invalid());}let mut file=fs_guard::append_file(&anchor,&leaf)?;if file.metadata().map_err(|_|failed())?.len()!=offset as u64{return Err(failed());}file.write_all(&data).map_err(|_|failed())?;file.sync_data().map_err(|_|failed())?;tx.execute("UPDATE remote_uploads SET offset=?2,expires=?3 WHERE id=?1",params![id,offset+data.len() as i64,now+15*60000]).map_err(|_|failed())?;result["uploadId"]=json!(id);result["nextOffset"]=json!(offset+data.len() as i64);},
            "finish"=>{if !final_hash.as_deref().zip(args["sha256"].as_str()).is_some_and(|(a,b)|a.eq_ignore_ascii_case(b)){return Err(invalid());}tx.execute("UPDATE remote_uploads SET complete=1 WHERE id=?1",[id]).map_err(|_|failed())?;result["attachmentId"]=json!(id);result["name"]=json!(name);result["kind"]=json!(kind);result["size"]=json!(size);},
            "cancel"=>{let referenced:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM remote_attachment_refs WHERE attachment_id=?1)",[id],|r|r.get(0)).map_err(|_|failed())?;if referenced{return Err(invalid());}std::fs::remove_file(dir.join(&leaf)).map_err(|_|failed())?;tx.execute("DELETE FROM remote_uploads WHERE id=?1",[id]).map_err(|_|failed())?;},_=>return Err(invalid())}
        commit::complete(&tx,&stamp,"attachment.put",&result,false)?;tx.commit().map_err(|_|failed())?;drop(core);Ok(result)
    });
    finish_write(saved).await
}

/// Host-only conversion, after upload completion and a fresh grant check. LAN
/// responses carry only attachmentId; this path is never a viewer file handle.
#[tauri::command]
pub(crate) async fn remote_attachment_resolve(
    state: tauri::State<'_, super::RemoteState>,
    window: tauri::WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    workspace_id: String,
    attachment_id: String,
) -> Result<Value, String> {
    super::hostbridge::window_is_host(&window).map_err(|_| invalid())?;
    let inner = state.inner.clone();
    state.inner.read_db(move|db|{
        let row:Option<(String,String,String,i64)>=db.query_row("SELECT name,kind,leaf,size FROM remote_uploads WHERE id=?1 AND device=?2 AND workspace=?3 AND complete=1 AND (expires>?4 OR EXISTS(SELECT 1 FROM remote_attachment_refs r WHERE r.attachment_id=remote_uploads.id))",params![attachment_id,device,workspace_id,crate::unix_timestamp_ms()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_|failed())?;
        let(name,kind,leaf,size)=row.ok_or_else(invalid)?;if !fs_guard::leaf(&leaf){return Err(invalid());}let dir=directory(&inner,&kind)?;let anchor=Anchor::open(&dir)?;let file=anchor.regular(&leaf)?;if file.metadata().map_err(|_|failed())?.len()!=size as u64{return Err(invalid());}
        let stamp=Stamp{generation,device,grant_revision,op_id:String::new(),op_seq:1,workspace_id:Some(workspace_id),thread_id:None};let core=inner.lock();stamp.check(&core,"attachment.put")?;anchor.validate()?;Ok(json!({"path":dir.join(leaf).to_string_lossy(),"name":name,"kind":kind,"size":size}))
    }).await
}

pub(super) fn retain_instruction(
    db: &Connection,
    device: &str,
    op_id: &str,
    op_seq: u64,
    receipt: &Value,
) -> Result<(), String> {
    let ids:Option<String>=db.query_row("SELECT attachments_json FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op_id,op_seq as i64],|row|row.get(0)).optional().map_err(|_|failed())?.flatten();
    let Some(ids) = ids else {
        return Ok(());
    };
    let ids: Vec<String> = serde_json::from_str(&ids).map_err(|_| failed())?;
    if ids.len() > 20 {
        return Err(invalid());
    }
    for id in ids {
        let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM remote_uploads WHERE id=?1 AND device=?2 AND workspace=?3 AND complete=1 AND (expires>?4 OR EXISTS(SELECT 1 FROM remote_attachment_refs r WHERE r.attachment_id=remote_uploads.id)))",params![id,device,receipt.get("workspaceId").and_then(Value::as_str),crate::unix_timestamp_ms()],|r|r.get(0)).map_err(|_|failed())?;
        if !exists {
            return Err(invalid());
        }
        db.execute("INSERT OR IGNORE INTO remote_attachment_refs(attachment_id,device,op_id,thread_id,message_id) VALUES(?1,?2,?3,?4,?5)",params![id,device,op_id,receipt.get("threadId").and_then(Value::as_str),receipt.get("messageId").and_then(Value::as_str)]).map_err(|_|failed())?;
    }
    Ok(())
}
