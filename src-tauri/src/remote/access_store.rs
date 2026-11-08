//! Persistent access requests and their atomic, direction-specific decisions.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};

pub(super) const PER_PEER_HISTORY: usize = 128;
pub(super) const GLOBAL_HISTORY: usize = 4096;
pub(super) const HISTORY_FULL:&str="This computer has received too many recent requests. Older requests clear after 7 days; try again then.";
pub(super) fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS remote_access_requests (
      direction TEXT NOT NULL, peer TEXT NOT NULL, payload TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(direction,peer));
      CREATE TABLE IF NOT EXISTS remote_access_effects (token TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS remote_access_seen(peer TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(peer,request_id));
      CREATE TABLE IF NOT EXISTS remote_access_fences(peer TEXT PRIMARY KEY,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_access_consents(peer TEXT PRIMARY KEY,declined_at INTEGER NOT NULL);")?;
    for (table, column) in [
        ("remote_access_requests", "updated_at"),
        ("remote_access_effects", "created_at"),
        ("remote_access_seen", "created_at"),
    ] {
        let present: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
            params![column],
            |r| r.get(0),
        )?;
        if !present {
            db.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
            ))?;
        }
        // Earlier development records had no age. Give them one bounded
        // retention interval, rather than silently dropping live tombstones.
        db.execute(
            &format!("UPDATE {table} SET {column}=?1 WHERE {column}=0"),
            params![now()],
        )?;
        db.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS {table}_age ON {table}({column})"
        ))?;
    }
    prune(db).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(())
}
pub(super) fn prune(db: &Connection) -> Result<(), String> {
    let cutoff = now() - LIFETIME;
    db.execute(
        "DELETE FROM remote_access_seen WHERE created_at<=?1",
        params![cutoff],
    )
    .map_err(sql)?;
    db.execute(
        "DELETE FROM remote_access_effects WHERE created_at<=?1",
        params![cutoff],
    )
    .map_err(sql)?;
    db.execute("DELETE FROM remote_access_requests WHERE
      ((direction='incoming' AND json_extract(payload,'$.decision') IN ('pending','decline')) OR
       (direction='outgoing' AND json_extract(payload,'$.view.state') IN ('connecting','waiting','declined')))
       AND json_extract(payload,'$.view.expiresAt')<=?1
       OR updated_at<=?2 AND
       ((direction='incoming' AND json_extract(payload,'$.decision') NOT IN ('pending','decline')) OR
        (direction='outgoing' AND json_extract(payload,'$.view.state') NOT IN ('connecting','waiting','declined')))",params![now(),cutoff]).map_err(sql)?;
    db.execute(
        "DELETE FROM remote_access_consents WHERE declined_at<=?1",
        params![cutoff],
    )
    .map_err(sql)?;
    Ok(())
}
pub(super) fn has_seen(db: &Connection, peer: &str, id: &str) -> Result<bool, String> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM remote_access_seen WHERE peer=?1 AND request_id=?2 AND created_at>?3)",params![peer,id,now()-LIFETIME],|r|r.get(0)).map_err(sql)
}
pub(super) fn load(
    db: &Connection,
) -> Result<
    (
        HashMap<String, Incoming>,
        HashMap<String, Outgoing>,
        HashSet<(String, String)>,
    ),
    String,
> {
    let mut incoming = HashMap::new();
    let mut outgoing = HashMap::new();
    let mut stmt = db
        .prepare("SELECT direction,peer,payload FROM remote_access_requests")
        .map_err(sql)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (direction, peer, payload) = row.map_err(sql)?;
        match direction.as_str() {
            "incoming" => {
                let row: Incoming = serde_json::from_str(&payload).map_err(|_| save_failed())?;
                incoming.insert(peer, row);
            }
            "outgoing" => {
                let mut row: Outgoing =
                    serde_json::from_str(&payload).map_err(|_| save_failed())?;
                // A proven pin is not a receipt: keep the persisted phase.
                // No connection attempt survives a process restart.
                row.view.reverse_connecting = false;
                outgoing.insert(peer, row);
            }
            _ => {}
        }
    }
    let mut seen = HashSet::new();
    let mut stmt = db
        .prepare("SELECT peer,request_id FROM remote_access_seen LIMIT 4096")
        .map_err(sql)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(sql)?;
    for row in rows {
        seen.insert(row.map_err(sql)?);
    }
    for row in incoming.values() {
        if seen.len() >= GLOBAL_HISTORY {
            break;
        }
        seen.insert((row.view.fingerprint.clone(), row.view.request_id.clone()));
    }
    Ok((incoming, outgoing, seen))
}
fn sql(_: rusqlite::Error) -> String {
    save_failed()
}
fn put(db: &Connection, direction: &str, key: &str, row: &impl Serialize) -> Result<(), String> {
    db.execute(
        "INSERT INTO remote_access_requests(direction,peer,payload,updated_at) VALUES(?1,?2,?3,?4)
      ON CONFLICT(direction,peer) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
        params![
            direction,
            key,
            serde_json::to_string(row).map_err(|_| save_failed())?,
            now()
        ],
    )
    .map_err(sql)?;
    Ok(())
}
pub(super) fn tombstone(db: &Connection, peer: &str, id: &str) -> Result<(), String> {
    prune(db)?;
    if has_seen(db, peer, id)? {
        return Ok(());
    }
    let peer_count: usize = db
        .query_row(
            "SELECT COUNT(*) FROM (SELECT 1 FROM remote_access_seen WHERE peer=?1 LIMIT 128)",
            params![peer],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let total: usize = db
        .query_row(
            "SELECT COUNT(*) FROM (SELECT 1 FROM remote_access_seen LIMIT 4096)",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if peer_count >= PER_PEER_HISTORY || total >= GLOBAL_HISTORY {
        return Err(HISTORY_FULL.into());
    }
    db.execute(
        "INSERT INTO remote_access_seen(peer,request_id,created_at) VALUES(?1,?2,?3)",
        params![peer, id, now()],
    )
    .map_err(sql)?;
    Ok(())
}
pub(super) fn incoming(db: &Connection, row: &Incoming) -> Result<(), String> {
    put(db, "incoming", &row.view.fingerprint, row)?;
    tombstone(db, &row.view.fingerprint, &row.view.request_id)
}
pub(super) fn drop_expired(db: &Connection, row: &Incoming) -> Result<(), String> {
    tombstone(db, &row.view.fingerprint, &row.view.request_id)?;
    db.execute("DELETE FROM remote_access_requests WHERE direction='incoming' AND peer=?1 AND json_extract(payload,'$.view.requestId')=?2",params![row.view.fingerprint,row.view.request_id]).map_err(sql)?;
    Ok(())
}
pub(super) fn save_incoming(db: &mut Connection, row: &Incoming) -> Result<(), String> {
    let tx = db.transaction().map_err(sql)?;
    incoming(&tx, row)?;
    tx.commit().map_err(sql)
}
pub(super) fn outgoing(db: &Connection, row: &Outgoing) -> Result<(), String> {
    put(db, "outgoing", &row.view.request_id, row)
}
#[derive(Clone, Serialize, Deserialize)]
struct Effect {
    before: Option<DeviceRecord>,
    after: DeviceRecord,
    host: bool,
    viewer: bool,
}
/// The caller's core-locked decision queued this transaction. Directional SQL
/// preserves independently approved access in the opposite direction.
pub(super) fn commit(
    db: &mut Connection,
    token: &str,
    record: &DeviceRecord,
    host: bool,
    viewer: bool,
    incoming_row: Option<&Incoming>,
    outgoing_row: Option<&Outgoing>,
) -> Result<DeviceRecord, String> {
    let tx = db.transaction().map_err(sql)?;
    let duplicate: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM remote_access_effects WHERE token=?1)",
            params![token],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if duplicate {
        let saved = store::load_devices(&tx)
            .map_err(sql)?
            .remove(&record.fingerprint)
            .ok_or_else(save_failed)?;
        tx.commit().map_err(sql)?;
        return Ok(saved);
    }
    let before = store::load_devices(&tx)
        .map_err(sql)?
        .remove(&record.fingerprint);
    let mut after = record.clone();
    if host {
        after.grant = after
            .grant
            .map(|grant| grant.succeeding(before.as_ref().and_then(|r| r.grant.as_ref())));
        store::save_device_fields(&tx, &after, 1, None)?;
    }
    if viewer {
        store::save_device_fields(&tx, &after, 2, Some(token))?;
    }
    if let Some(row) = incoming_row {
        incoming(&tx, row)?;
    }
    if let Some(row) = outgoing_row {
        outgoing(&tx, row)?;
    }
    let after = store::load_devices(&tx)
        .map_err(sql)?
        .remove(&record.fingerprint)
        .ok_or_else(save_failed)?;
    tx.execute(
        "INSERT INTO remote_access_effects(token,payload,created_at) VALUES(?1,?2,?3)",
        params![
            token,
            serde_json::to_string(&Effect {
                before,
                after: after.clone(),
                host,
                viewer
            })
            .map_err(|_| save_failed())?,
            now()
        ],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)?;
    Ok(after)
}
/// Cancellation/obsolete completion may undo only this save, never a later
/// grant revision or a newer viewer relationship (including a forget).
pub(super) fn undo(db: &mut Connection, token: &str) -> Result<(), String> {
    let tx = db.transaction().map_err(sql)?;
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload FROM remote_access_effects WHERE token=?1",
            params![token],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    if let Some(payload) = payload {
        let effect: Effect = serde_json::from_str(&payload).map_err(|_| save_failed())?;
        if let Some(mut current) = store::load_devices(&tx)
            .map_err(sql)?
            .remove(&effect.after.fingerprint)
        {
            if effect.host && current.grant == effect.after.grant {
                current.grant = effect
                    .before
                    .as_ref()
                    .and_then(|r| r.grant.clone())
                    .map(|g| g.succeeding(current.grant.as_ref()));
                store::save_device_fields(&tx, &current, 1, None)?;
            }
            let ours:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM remote_viewer_pairing_saves WHERE fingerprint=?1 AND token=?2)",params![current.fingerprint,token],|row|row.get(0)).map_err(sql)?;
            if effect.viewer && ours {
                current.they_host = effect.before.as_ref().is_some_and(|r| r.they_host);
                current.access_removed = effect.before.as_ref().is_some_and(|r| r.access_removed);
                store::save_device_fields(&tx, &current, 2, None)?;
                tx.execute(
                    "DELETE FROM remote_viewer_pairing_saves WHERE fingerprint=?1 AND token=?2",
                    params![current.fingerprint, token],
                )
                .map_err(sql)?;
            }
        }
        tx.execute(
            "DELETE FROM remote_access_effects WHERE token=?1",
            params![token],
        )
        .map_err(sql)?;
    }
    tx.commit().map_err(sql)
}
pub(super) fn cancel_outgoing(db: &mut Connection, row: &Outgoing) -> Result<(), String> {
    // The serialized writer excludes another access commit here. Undo is
    // idempotent; only acknowledge Cancel once its row is durable as well.
    undo(
        db,
        &format!(
            "out:{}:{}",
            row.view.fingerprint.as_deref().unwrap_or(""),
            row.view.request_id
        ),
    )?;
    outgoing(db, row)
}

pub(super) fn fences(db: &Connection) -> Result<HashMap<String, u64>, String> {
    let mut stmt = db
        .prepare("SELECT peer,generation FROM remote_access_fences")
        .map_err(sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
        })
        .map_err(sql)?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(sql)
}

pub(super) fn consent_cutoffs(db: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut stmt = db
        .prepare("SELECT peer,declined_at FROM remote_access_consents")
        .map_err(sql)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(sql)?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(sql)
}
pub(super) fn decline(
    db: &mut Connection,
    row: &Incoming,
    outgoing: &[Outgoing],
    cutoff: i64,
) -> Result<(), String> {
    let tx = db.transaction().map_err(sql)?;
    incoming(&tx, row)?;
    tx.execute("INSERT INTO remote_access_consents(peer,declined_at) VALUES(?1,?2) ON CONFLICT(peer) DO UPDATE SET declined_at=MAX(declined_at,excluded.declined_at)",params![row.view.fingerprint,cutoff]).map_err(sql)?;
    for row in outgoing {
        self::outgoing(&tx, row)?;
    }
    tx.commit().map_err(sql)
}
