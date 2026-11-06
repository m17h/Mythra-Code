//! SQLite tables for remote work. They are additive, so older builds ignore
//! them. Public keys are not secrets, and nothing secret is ever stored here.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::discovery::types::MAX_ADDRESSES;

const SETTING_NAME: &str = "device_name";
const SETTING_HOSTING: &str = "hosting_enabled";
const SETTING_SHARE_NAME: &str = "share_name";
const SETTING_PORT: &str = "listen_port";
const JOURNAL_MAX_ROWS_PER_DEVICE: i64 = 1_000;
const MAX_GRANT_PROJECTS: usize = 1_000;
const MAX_PROJECT_ID_BYTES: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum GrantScope {
    All,
    Projects {
        #[serde(rename = "projectIds")]
        project_ids: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrantCapabilities {
    /// Without this, a turn started remotely runs at no more than `ask`.
    #[serde(default)]
    pub(crate) full_access: bool,
    pub(crate) git_write: bool,
    pub(crate) checkpoint_restore: bool,
    pub(crate) terminal: bool,
    #[serde(default)]
    pub(crate) manage_projects: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceGrant {
    pub(crate) scope: GrantScope,
    pub(crate) view: bool,
    pub(crate) work: bool,
    pub(crate) capabilities: GrantCapabilities,
    /// Owned by the host. Goes up with every change, so later phases can tell
    /// which grant a subscription was opened under. Never read from IPC.
    #[serde(default)]
    pub(crate) revision: u64,
}

impl DeviceGrant {
    /// View only, every eligible thread, no capabilities.
    pub(crate) fn initial() -> Self {
        Self {
            scope: GrantScope::All,
            view: true,
            work: false,
            capabilities: GrantCapabilities::default(),
            revision: 0,
        }
    }

    /// The grant to store when replacing `previous`.
    pub(crate) fn succeeding(mut self, previous: Option<&DeviceGrant>) -> Self {
        self.revision = previous.map_or(1, |grant| grant.revision.saturating_add(1));
        self
    }

    /// What this grant and `next` both allow, at `next`'s revision. This is what
    /// is in force while a change is being saved, so an edit that widens one
    /// thing and narrows another never gives the wider result early.
    pub(crate) fn overlap(&self, next: &DeviceGrant) -> DeviceGrant {
        let scope = match (&self.scope, &next.scope) {
            (GrantScope::All, other) | (other, GrantScope::All) => other.clone(),
            (GrantScope::Projects { project_ids: left }, GrantScope::Projects { project_ids: right }) => {
                GrantScope::Projects {
                    project_ids: left.iter().filter(|id| right.contains(id)).cloned().collect(),
                }
            }
        };
        DeviceGrant {
            scope,
            view: self.view && next.view,
            work: self.work && next.work,
            capabilities: GrantCapabilities {
                full_access: self.capabilities.full_access && next.capabilities.full_access,
                git_write: self.capabilities.git_write && next.capabilities.git_write,
                checkpoint_restore: self.capabilities.checkpoint_restore
                    && next.capabilities.checkpoint_restore,
                terminal: self.capabilities.terminal && next.capabilities.terminal,
                manage_projects: self.capabilities.manage_projects && next.capabilities.manage_projects,
            },
            revision: next.revision,
        }
    }

    /// `view` is required for everything else, so a grant without it carries
    /// nothing. Bounds apply because this also arrives through IPC.
    pub(crate) fn normalized(mut self) -> Result<Self, String> {
        if let GrantScope::Projects { project_ids } = &mut self.scope {
            project_ids.dedup();
            if project_ids.len() > MAX_GRANT_PROJECTS
                || project_ids
                    .iter()
                    .any(|id| id.is_empty() || id.len() > MAX_PROJECT_ID_BYTES)
            {
                return Err("That list of projects is not valid.".into());
            }
        }
        if !self.view {
            self.work = false;
            self.capabilities = GrantCapabilities::default();
        }
        if !self.work || !matches!(self.scope, GrantScope::All) {
            self.capabilities.manage_projects = false;
        }
        Ok(self)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DeviceRecord {
    pub(crate) fingerprint: String,
    pub(crate) spki: Vec<u8>,
    pub(crate) name: String,
    pub(crate) platform: Option<String>,
    pub(crate) addresses: Vec<String>,
    /// We hold this device's key and may view it.
    pub(crate) they_host: bool,
    /// The other device no longer lets this one in.
    pub(crate) access_removed: bool,
    pub(crate) paired_at: i64,
    pub(crate) last_seen_at: Option<i64>,
    /// This device may view us, within this grant.
    pub(crate) grant: Option<DeviceGrant>,
}

#[derive(Clone, Debug)]
pub(crate) struct Settings {
    pub(crate) device_name: Option<String>,
    pub(crate) hosting: bool,
    pub(crate) share_name: bool,
    pub(crate) port: Option<u16>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            device_name: None,
            hosting: false,
            share_name: false,
            port: None,
        }
    }
}

pub(crate) fn init(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS remote_settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS remote_devices (
           fingerprint TEXT PRIMARY KEY,
           spki BLOB NOT NULL,
           name TEXT NOT NULL,
           platform TEXT,
           addresses TEXT NOT NULL DEFAULT '[]',
           they_host INTEGER NOT NULL DEFAULT 0,
           access_removed INTEGER NOT NULL DEFAULT 0,
           paired_at INTEGER NOT NULL,
           last_seen_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS remote_grants (
           fingerprint TEXT PRIMARY KEY,
           grant_json TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS remote_op_journal (
           device_fingerprint TEXT NOT NULL,
           op_id TEXT NOT NULL,
           op TEXT NOT NULL,
           op_seq INTEGER NOT NULL DEFAULT 0,
           request_digest TEXT NOT NULL DEFAULT '',
           state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'uncertain')),
           thread_id TEXT,
           turn_id TEXT,
           queued_turn_id TEXT,
           error_code TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (device_fingerprint, op_id)
         );
         CREATE TABLE IF NOT EXISTS remote_op_devices (
           device_fingerprint TEXT PRIMARY KEY,
           evicted_through INTEGER NOT NULL DEFAULT 0,
           highest_op_seq INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    // A journal created by an earlier development build gains the new columns.
    for (column, definition) in [
        ("op_seq", "INTEGER NOT NULL DEFAULT 0"),
        ("request_digest", "TEXT NOT NULL DEFAULT ''"),
        ("delivery_json", "TEXT"),
        ("attachments_json", "TEXT"),
        ("result_json", "TEXT"),
    ] {
        let present: bool = connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_table_info('remote_op_journal') WHERE name = ?1)",
            params![column],
            |row| row.get(0),
        )?;
        if !present {
            connection.execute_batch(&format!(
                "ALTER TABLE remote_op_journal ADD COLUMN {column} {definition};"
            ))?;
        }
    }
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS remote_op_journal_seq
           ON remote_op_journal(device_fingerprint, op_seq);",
    )?;
    super::attachments::init(connection)?;
    // A row still pending after a restart has an unknown outcome. It is never
    // retried automatically; the viewer asks `op.status`.
    connection.execute(
        "UPDATE remote_op_journal SET state = 'uncertain' WHERE state = 'pending'",
        [],
    )?;
    Ok(())
}

fn read_setting(connection: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM remote_settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
}

fn write_setting(connection: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO remote_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub(crate) fn load_settings(connection: &Connection) -> rusqlite::Result<Settings> {
    Ok(Settings {
        device_name: read_setting(connection, SETTING_NAME)?,
        hosting: read_setting(connection, SETTING_HOSTING)?.as_deref() == Some("1"),
        share_name: read_setting(connection, SETTING_SHARE_NAME)?.as_deref() == Some("1"),
        port: read_setting(connection, SETTING_PORT)?.and_then(|value| value.parse().ok()),
    })
}

pub(crate) fn set_hosting(connection: &Connection, enabled: bool) -> rusqlite::Result<()> {
    write_setting(connection, SETTING_HOSTING, if enabled { "1" } else { "0" })
}

pub(crate) fn set_share_name(connection: &Connection, shared: bool) -> rusqlite::Result<()> {
    write_setting(connection, SETTING_SHARE_NAME, if shared { "1" } else { "0" })
}

pub(crate) fn set_device_name(connection: &Connection, name: &str) -> rusqlite::Result<()> {
    write_setting(connection, SETTING_NAME, name)
}

pub(crate) fn set_port(connection: &Connection, port: u16) -> rusqlite::Result<()> {
    write_setting(connection, SETTING_PORT, &port.to_string())
}

pub(crate) fn load_devices(
    connection: &Connection,
) -> rusqlite::Result<HashMap<String, DeviceRecord>> {
    let mut grants: HashMap<String, DeviceGrant> = HashMap::new();
    {
        let mut statement =
            connection.prepare("SELECT fingerprint, grant_json FROM remote_grants")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (fingerprint, json) = row?;
            // An unreadable grant fails closed: the device simply has no access.
            if let Ok(grant) = serde_json::from_str::<DeviceGrant>(&json) {
                grants.insert(fingerprint, grant);
            }
        }
    }
    let mut statement = connection.prepare(
        "SELECT fingerprint, spki, name, platform, addresses, they_host, access_removed,
                paired_at, last_seen_at
         FROM remote_devices",
    )?;
    let rows = statement.query_map([], |row| {
        let fingerprint: String = row.get(0)?;
        let addresses: String = row.get(4)?;
        Ok(DeviceRecord {
            grant: None,
            spki: row.get(1)?,
            name: row.get(2)?,
            platform: row.get(3)?,
            addresses: serde_json::from_str(&addresses).unwrap_or_default(),
            they_host: row.get::<_, i64>(5)? != 0,
            access_removed: row.get::<_, i64>(6)? != 0,
            paired_at: row.get(7)?,
            last_seen_at: row.get(8)?,
            fingerprint,
        })
    })?;
    let mut devices = HashMap::new();
    for row in rows {
        let mut device = row?;
        device.grant = grants.remove(&device.fingerprint);
        device.addresses.truncate(MAX_ADDRESSES);
        devices.insert(device.fingerprint.clone(), device);
    }
    Ok(devices)
}

/// Writes one device and its grant atomically. No grant means no row, so a
/// revocation cannot leave a stale grant behind.
pub(crate) fn save_device(connection: &mut Connection, device: &DeviceRecord) -> Result<(), String> {
    let grant = device
        .grant
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    let addresses =
        serde_json::to_string(&device.addresses).map_err(|error| error.to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO remote_devices
               (fingerprint, spki, name, platform, addresses, they_host, access_removed,
                paired_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(fingerprint) DO UPDATE SET
               spki = excluded.spki, name = excluded.name, platform = excluded.platform,
               addresses = excluded.addresses, they_host = excluded.they_host,
               access_removed = excluded.access_removed, paired_at = excluded.paired_at,
               last_seen_at = excluded.last_seen_at",
            params![
                device.fingerprint,
                device.spki,
                device.name,
                device.platform,
                addresses,
                device.they_host as i64,
                device.access_removed as i64,
                device.paired_at,
                device.last_seen_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    match grant {
        Some(grant) => transaction.execute(
            "INSERT INTO remote_grants (fingerprint, grant_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(fingerprint) DO UPDATE SET
               grant_json = excluded.grant_json, updated_at = excluded.updated_at",
            params![device.fingerprint, grant, crate::unix_timestamp_ms() as i64],
        ),
        None => transaction.execute(
            "DELETE FROM remote_grants WHERE fingerprint = ?1",
            params![device.fingerprint],
        ),
    }
    .map_err(|error| error.to_string())?;
    reject_queued_for_grant(&transaction,&device.fingerprint,device.grant.as_ref())?;
    transaction.commit().map_err(|error| error.to_string())
}

/// Refreshes what a device reports about itself. This never touches a grant or
/// creates a row, so a background save that races a revocation cannot bring
/// access back or re-add a removed device.
pub(crate) fn update_device_details(
    connection: &Connection,
    device: &DeviceRecord,
) -> Result<(), String> {
    let addresses =
        serde_json::to_string(&device.addresses).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE remote_devices
             SET name = ?2, platform = ?3, addresses = ?4, access_removed = ?5, last_seen_at = ?6
             WHERE fingerprint = ?1",
            params![
                device.fingerprint,
                device.name,
                device.platform,
                addresses,
                device.access_removed as i64,
                device.last_seen_at,
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(crate) fn delete_device(connection: &mut Connection, fingerprint: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    reject_queued_for_grant(&transaction,fingerprint,None)?;
    for table in ["remote_devices", "remote_grants"] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE fingerprint = ?1"),
                params![fingerprint],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpStatus {
    pub(crate) op_id: String,
    /// A journal state (pending, accepted, rejected, uncertain), or one of:
    /// `unknown`: this host never admitted the operation, so a retry with the
    /// same `opId` is safe. `expired`: its row may have been evicted, so nobody
    /// can say. It is never executed and never retried automatically.
    pub(crate) state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) queued_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<String>,
}

impl OpStatus {
    fn without_row(op_id: &str, state: &str) -> Self {
        Self {
            op_id: op_id.to_string(),
            state: state.to_string(),
            thread_id: None,
            turn_id: None,
            queued_turn_id: None,
            error_code: None,
        }
    }
}

fn read_op_row(
    connection: &Connection,
    fingerprint: &str,
    op_id: &str,
) -> rusqlite::Result<Option<(OpStatus, String)>> {
    connection
        .query_row(
            "SELECT state, thread_id, turn_id, queued_turn_id, error_code, request_digest
             FROM remote_op_journal WHERE device_fingerprint = ?1 AND op_id = ?2",
            params![fingerprint, op_id],
            |row| {
                Ok((
                    OpStatus {
                        op_id: op_id.to_string(),
                        state: row.get(0)?,
                        thread_id: row.get(1)?,
                        turn_id: row.get(2)?,
                        queued_turn_id: row.get(3)?,
                        error_code: row.get(4)?,
                    },
                    row.get(5)?,
                ))
            },
        )
        .optional()
}

fn device_counters(connection: &Connection, fingerprint: &str) -> rusqlite::Result<(i64, i64)> {
    Ok(connection
        .query_row(
            "SELECT evicted_through, highest_op_seq FROM remote_op_devices
             WHERE device_fingerprint = ?1",
            params![fingerprint],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, 0)))
}

/// The highest `opSeq` seen from this device, so a viewer that lost its counter
/// can resume above it.
pub(crate) fn highest_op_seq(connection: &Connection, fingerprint: &str) -> rusqlite::Result<u64> {
    device_counters(connection, fingerprint).map(|(_, highest)| highest.max(0) as u64)
}

/// Rows are scoped by device: one device can never read another's operations.
/// A missing row is `unknown` only when the sequence number proves it was never
/// evicted. Anything that cannot be proven is `expired`.
pub(crate) fn op_status(
    connection: &Connection,
    fingerprint: &str,
    op_id: &str,
    op_seq: Option<u64>,
) -> rusqlite::Result<OpStatus> {
    if let Some((status, _)) = read_op_row(connection, fingerprint, op_id)? {
        return Ok(status);
    }
    let (evicted_through, _) = device_counters(connection, fingerprint)?;
    let provable = match op_seq {
        Some(seq) => i64::try_from(seq).is_ok_and(|seq| seq > evicted_through),
        None => evicted_through == 0,
    };
    Ok(OpStatus::without_row(op_id, if provable { "unknown" } else { "expired" }))
}

/// What claiming an operation decided. The caller dispatches only on `Claimed`.
#[allow(dead_code)] // The first mutating operations arrive in Phase 3.
#[derive(Debug)]
pub(crate) enum JournalClaim {
    Claimed,
    /// The same request again. Never re-executed: return this recorded result.
    Existing(OpStatus),
    /// The same `opId` with different content. Refused.
    DigestMismatch,
    /// At or below the watermark with no row. Never executed.
    Expired,
    /// Only pending and uncertain rows remain, and those are never evicted.
    Busy,
}

fn write_canonical_json(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            out.push('{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical_json(item, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical_json(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Key order is normalized, because `serde_json` here preserves the order the
/// peer sent and a resend must produce the same digest.
#[allow(dead_code)] // The first mutating operations arrive in Phase 3.
pub(crate) fn request_digest(op: &str, args: &Value) -> String {
    let mut canonical = String::new();
    write_canonical_json(args, &mut canonical);
    let mut digest = Sha256::new();
    digest.update((op.len() as u64).to_be_bytes());
    digest.update(op.as_bytes());
    digest.update(canonical.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Atomically claims `(device, opId)` before anything is dispatched, evicting
/// the oldest finished rows when the device is at its cap. Eviction raises the
/// watermark first, so "accepted" can never turn into "never seen".
#[allow(dead_code)] // The first mutating operations arrive in Phase 3.
pub(crate) fn claim_operation(
    connection: &mut Connection,
    fingerprint: &str,
    op_id: &str,
    op_seq: u64,
    op: &str,
    digest: &str,
) -> rusqlite::Result<JournalClaim> {
    let seq = match i64::try_from(op_seq) {
        Ok(seq) if seq > 0 => seq,
        _ => return Ok(JournalClaim::Expired),
    };
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some((status, recorded)) = read_op_row(&transaction, fingerprint, op_id)? {
        let recorded_seq: i64 = transaction.query_row("SELECT op_seq FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2", params![fingerprint, op_id], |row| row.get(0))?;
        return Ok(if recorded == digest && recorded_seq == seq {
            JournalClaim::Existing(status)
        } else {
            JournalClaim::DigestMismatch
        });
    }
    let (mut evicted_through, highest) = device_counters(&transaction, fingerprint)?;
    if seq <= evicted_through || seq <= highest {
        return Ok(JournalClaim::Expired);
    }
    let rows: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM remote_op_journal WHERE device_fingerprint = ?1",
        params![fingerprint],
        |row| row.get(0),
    )?;
    let excess = rows - JOURNAL_MAX_ROWS_PER_DEVICE + 1;
    if excess > 0 {
        let oldest: Vec<(String, i64)> = {
            let mut statement = transaction.prepare(
                "SELECT op_id, op_seq FROM remote_op_journal
                 WHERE device_fingerprint = ?1 AND state IN ('accepted', 'rejected')
                 ORDER BY op_seq ASC LIMIT ?2",
            )?;
            let found = statement
                .query_map(params![fingerprint, excess], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            found
        };
        if (oldest.len() as i64) < excess {
            return Ok(JournalClaim::Busy);
        }
        for (old_id, old_seq) in oldest {
            evicted_through = evicted_through.max(old_seq);
            transaction.execute(
                "DELETE FROM remote_op_journal WHERE device_fingerprint = ?1 AND op_id = ?2",
                params![fingerprint, old_id],
            )?;
        }
        if seq <= evicted_through {
            return Ok(JournalClaim::Expired);
        }
    }
    let now = crate::unix_timestamp_ms();
    transaction.execute(
        "INSERT INTO remote_op_journal
           (device_fingerprint, op_id, op_seq, request_digest, op, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
        params![fingerprint, op_id, seq, digest, op, now],
    )?;
    transaction.execute(
        "INSERT INTO remote_op_devices (device_fingerprint, evicted_through, highest_op_seq)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(device_fingerprint) DO UPDATE SET
           evicted_through = excluded.evicted_through,
           highest_op_seq = excluded.highest_op_seq",
        params![fingerprint, evicted_through, highest.max(seq)],
    )?;
    transaction.commit()?;
    Ok(JournalClaim::Claimed)
}

/// Delivery receipts contain identities/dispositions only. Prompt and answer
/// bodies must never be copied into this durable table.
pub(super) fn delivery_receipt(connection: &Connection, device: &str, op_id: &str, op_seq: u64) -> Result<Option<Value>, String> {
    let row: Option<(i64, Option<String>)> = connection.query_row(
        "SELECT op_seq, delivery_json FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2",
        params![device, op_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|_| "The delivery record could not be read.".to_string())?;
    match row {
        Some((seq, receipt)) if seq == op_seq as i64 => receipt.map(|text| serde_json::from_str(&text)
            .map_err(|_| "The delivery record could not be read.".to_string())).transpose(),
        _ => Err("That delivery record is no longer available.".into()),
    }
}

pub(super) fn operation_result(connection: &Connection, device: &str, op_id: &str) -> Result<Value, String> {
    let saved: Option<(String,Option<String>)> = connection.query_row(
        "SELECT state,result_json FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2",
        params![device, op_id], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(|_| "The delivery record could not be read.".to_string())?;
    if let Some((state,Some(saved))) = saved {
        let mut result:Value=serde_json::from_str(&saved).map_err(|_| "The delivery record could not be read.".to_string())?;
        // Startup can conservatively mark a pending row uncertain without
        // rewriting the optional structured result. The row state wins.
        if !(state=="accepted"&&result.get("state").and_then(Value::as_str)==Some("queued")){result["state"]=Value::String(state);}
        return Ok(result);
    }
    serde_json::to_value(op_status(connection, device, op_id, None).map_err(|_| "The delivery record could not be read.".to_string())?)
        .map_err(|_| "The delivery record could not be read.".into())
}

pub(super) fn save_operation_result(connection: &Connection, device: &str, op_id: &str, op_seq: u64, result: &Value) -> Result<(), String> {save_result_inner(connection,device,op_id,op_seq,result,false)}
fn save_result_inner(connection: &Connection, device: &str, op_id: &str, op_seq: u64, result: &Value,receipt_transition:bool) -> Result<(), String> {
    let state = result.get("state").and_then(Value::as_str).ok_or("Invalid delivery result.")?;
    if !["pending", "accepted", "queued", "rejected", "uncertain"].contains(&state) { return Err("Invalid delivery result.".into()); }
    // A native accepted receipt cannot be demoted by a late renderer timeout.
    let previous: Option<(String, Option<String>,Option<String>)> = connection.query_row(
        "SELECT state, delivery_json,result_json FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",
        params![device, op_id, op_seq as i64], |row| Ok((row.get(0)?, row.get(1)?,row.get(2)?)),
    ).optional().map_err(|_| "The delivery record could not be saved.".to_string())?;
    let Some((previous, receipt,saved_result)) = previous else { return Err("That delivery record is no longer available.".into()); };
    let disposition = receipt.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.get("disposition").and_then(Value::as_str).map(str::to_owned));
    if !receipt_transition&&previous=="accepted"&&matches!(disposition.as_deref(),Some("accepted"|"queued")){
        // Preserve native/admission state and owner identities, but fill safe
        // final reply fields (draft tokens/settings, public workspace, etc.).
        // Otherwise an accepted renderer receipt would erase its own reply.
        if matches!(state,"accepted"|"queued"){
            let mut merged=saved_result.as_deref().and_then(|s|serde_json::from_str::<Value>(s).ok()).unwrap_or_else(||serde_json::json!({"opId":op_id,"state":previous}));
            let authoritative=receipt.as_deref().and_then(|s|serde_json::from_str::<Value>(s).ok());
            if let Some(fields)=result.as_object(){for(key,value)in fields{if key=="state"||key=="opId"||merged.get(key).is_some(){continue;}if let Some(native)=authoritative.as_ref().and_then(|r|r.get(key)).filter(|v|!v.is_null()){merged[key]=native.clone();}else{merged[key]=value.clone();}}}
            connection.execute("UPDATE remote_op_journal SET result_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op_id,op_seq as i64,merged.to_string()]).map_err(|_|"The delivery result could not be saved.".to_string())?;
        }return Ok(());
    }
    if !receipt_transition&&previous=="rejected"&&disposition.as_deref()==Some("rejected"){return Ok(());}
    connection.execute("UPDATE remote_op_journal SET state=?4, thread_id=COALESCE(?5,thread_id), turn_id=COALESCE(?6,turn_id), queued_turn_id=COALESCE(?7,queued_turn_id), error_code=?8, result_json=?9, updated_at=?10 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",
        params![device,op_id,op_seq as i64,if state=="queued" {"accepted"} else {state},
            result.get("threadId").and_then(Value::as_str),result.get("turnId").and_then(Value::as_str),
            result.get("queuedTurnId").and_then(Value::as_str),result.pointer("/error/code").and_then(Value::as_str),result.to_string(),crate::unix_timestamp_ms()])
        .map_err(|_| "The delivery record could not be saved.".to_string())?;
    Ok(())
}

pub(super) fn save_delivery_receipt(connection: &mut Connection, device: &str, op_id: &str, op_seq: u64, receipt: &Value) -> Result<(), String> { save_receipt_inner(connection,device,op_id,op_seq,receipt,false) }
pub(super) fn save_native_delivery_receipt(connection: &mut Connection, device: &str, op_id: &str, op_seq: u64, receipt: &Value) -> Result<(), String> { save_receipt_inner(connection,device,op_id,op_seq,receipt,true) }
fn save_receipt_inner(connection: &mut Connection, device: &str, op_id: &str, op_seq: u64, receipt: &Value,native:bool) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|_| "The delivery record could not be saved.".to_string())?;
    // Never replace an uncertain/dispatched/accepted execution with a queued
    // admission after restart, nor overwrite a provider-accepted native result.
    let old = delivery_receipt(&transaction,device,op_id,op_seq)?;
    let next = receipt.get("disposition").and_then(Value::as_str).ok_or("Invalid delivery disposition.")?;
    if !["preparing","queued","dispatched","accepted","rejected","uncertain"].contains(&next) { return Err("Invalid delivery disposition.".into()); }
    let state:String=transaction.query_row("SELECT state FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op_id,op_seq as i64],|row|row.get(0)).map_err(|_|"That delivery is no longer available.".to_string())?;
    if state=="rejected"&&next!="rejected"&&!(native&&next=="accepted"){return Err("A rejected instruction cannot be reopened.".into());}
    let mut receipt = receipt.clone();
    let native_op:String=transaction.query_row("SELECT op FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op_id,op_seq as i64],|row|row.get(0)).map_err(|_|"That delivery is no longer available.".to_string())?;
    receipt["op"]=Value::String(native_op);
    if let Some(old) = old {
        for key in ["workspaceId","threadId","turnId","queuedTurnId","messageId","attemptId","startRequestId","provider","ownerHandle"]{
            if let Some(previous)=old.get(key).filter(|value|!value.is_null()){if receipt.get(key).is_some_and(|next|!next.is_null()&&next!=previous){return Err("That delivery belongs to another execution owner.".into());}receipt[key]=previous.clone();}
        }
        let previous = old.get("disposition").and_then(Value::as_str).unwrap_or("uncertain");
        if previous == "accepted" && next != "accepted" { return Ok(()); }
        if previous=="rejected"&&next!="rejected"&&!(native&&next=="accepted"){return Err("A rejected instruction cannot be reopened.".into());}
        if ["dispatched","uncertain","accepted","rejected"].contains(&previous) && ["preparing","queued"].contains(&next) { return Err("That delivery cannot be queued again.".into()); }
        for key in ["queueAuthorized","queueAdmissionCommitted","permissionCeiling","ownerHandle","engineOwnerHandle"]{if let Some(value)=old.get(key){receipt[key]=value.clone();}}
        // Native dispatch latches may only be added, never cleared by IPC.
        if let Some(steps) = old.get("nativeSteps") { receipt["nativeSteps"] = steps.clone(); }
    }
    let state = match next { "queued" | "accepted" => "accepted", "rejected" => "rejected", "uncertain" => "uncertain", _ => "pending" };
    let mut result = serde_json::json!({"opId":op_id,"state":if next=="queued" {"queued"} else {state}});
    for key in ["workspaceId","threadId","turnId","queuedTurnId","messageId","attemptId","terminalId"] {
        if let Some(value) = receipt.get(key).filter(|value| !value.is_null()) { result[key] = value.clone(); }
    }
    if next == "rejected" { result["error"] = serde_json::json!({"code":receipt.get("errorCode").and_then(Value::as_str).unwrap_or("internal"),"message":"The host did not deliver this instruction."}); }
    if native&&next=="accepted"{super::attachments::retain_instruction(&transaction,device,op_id,op_seq,&receipt)?;}
    save_result_inner(&transaction,device,op_id,op_seq,&result,true)?;
    transaction.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op_id,op_seq as i64,receipt.to_string()])
        .map_err(|_| "The delivery record could not be saved.".to_string())?;
    transaction.commit().map_err(|_| "The delivery record could not be saved.".into())
}

/// Durable one-shot latch written before a native start/write. A crash between
/// this latch and the pipe is deliberately uncertain, never safe to redeliver.
pub(super) fn claim_native_step(connection: &mut Connection, device: &str, op_id: &str, op_seq: u64, step: &str) -> Result<Value,String> {
    let transaction=connection.transaction().map_err(|_| "The delivery record could not be saved.".to_string())?;
    let mut receipt=delivery_receipt(&transaction,device,op_id,op_seq)?.ok_or("This delivery has no execution receipt.")?;
    // A durable claim for one instruction cannot authorize a different
    // provider action. Future parity engines need their own typed provenance
    // adapters before extending this explicit dispatch matrix.
    let operation:String=transaction.query_row("SELECT op FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op_id,op_seq as i64],|row|row.get(0)).map_err(|_|"That delivery is no longer available.".to_string())?;
    let allowed=match step {
        "thread/start"|"thread/resume"|"turn/start"|"claude_prompt"|"cursor_prompt"=>matches!(operation.as_str(),"prompt.send"|"prompt.queue")||(matches!(operation.as_str(),"queue.edit.finish"|"queue.retry"|"prompt.schedule"|"schedules.edit")&&receipt.get("queueAuthorized").and_then(Value::as_bool)==Some(true)&&receipt.get("queueAdmissionCommitted").and_then(Value::as_bool)==Some(true)),
        "claude_turn_steer"|"cursor_turn_steer"|"codex_steer"=>operation=="prompt.steer",
        "approval_answer"=>operation=="approval.answer",
        "question_answer"=>operation=="question.answer",
        "turn_stop"=>operation=="turn.stop",
        "command/exec"=>operation=="terminal.open",
        "command/exec/write"=>operation=="terminal.write",
        "command/exec/resize"=>operation=="terminal.resize",
        "command/exec/terminate"=>operation=="terminal.close",
        step if step.starts_with("owner_stop:")=>matches!(operation.as_str(),"turn.stop"|"workflows.stop"),
        _=>false,
    };
    if !allowed{return Err("That instruction does not authorize this native action.".into());}
    let disposition=receipt.get("disposition").and_then(Value::as_str).unwrap_or("uncertain");
    if !["preparing","dispatched"].contains(&disposition) {return Err("This delivery cannot be dispatched again.".into());}
    if !receipt.get("nativeSteps").is_some_and(Value::is_array) {receipt["nativeSteps"]=serde_json::json!([]);}
    let steps=receipt["nativeSteps"].as_array_mut().ok_or("Invalid delivery record.")?;
    if steps.iter().any(|value| value.as_str()==Some(step)) {return Err("This delivery was already dispatched.".into());}
    steps.push(serde_json::json!(step));
    transaction.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,op_id,op_seq as i64,receipt.to_string()])
        .map_err(|_| "The delivery record could not be saved.".to_string())?;
    transaction.commit().map_err(|_| "The delivery record could not be saved.".to_string())?;
    Ok(receipt)
}

fn reject_queued_for_grant(connection:&Connection,device:&str,grant:Option<&DeviceGrant>)->Result<(),String>{
    let rows:Vec<(String,i64,String)>={let mut statement=connection.prepare("SELECT op_id,op_seq,delivery_json FROM remote_op_journal WHERE device_fingerprint=?1 AND delivery_json IS NOT NULL").map_err(|_|"The delivery records could not be checked.".to_string())?;
        let rows=statement.query_map(params![device],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_|"The delivery records could not be checked.".to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|"The delivery records could not be checked.".to_string())?;rows};
    for(id,seq,source)in rows{let Ok(mut receipt)=serde_json::from_str::<Value>(&source)else{continue;};
        let disposition=receipt.get("disposition").and_then(Value::as_str).unwrap_or("uncertain");
        if !["preparing","queued"].contains(&disposition){continue;}
        let allowed=grant.is_some_and(|grant|grant.view&&grant.work&&receipt.get("op").and_then(Value::as_str).is_some_and(|op|super::manifest::access(op,grant).is_ok())&&(receipt.get("permission").and_then(Value::as_str)!=Some("full")||grant.capabilities.full_access)&&match &grant.scope{GrantScope::All=>true,GrantScope::Projects{project_ids}=>receipt.get("workspaceId").and_then(Value::as_str).is_some_and(|id|project_ids.iter().any(|project|project==id))});
        if allowed{continue;}receipt["disposition"]=serde_json::json!("rejected");receipt["errorCode"]=serde_json::json!("forbidden");
        let result=serde_json::json!({"opId":id,"state":"rejected","threadId":receipt.get("threadId"),"queuedTurnId":receipt.get("queuedTurnId"),"error":{"code":"forbidden","message":"Remote access was removed before this instruction could run."}});
        connection.execute("UPDATE remote_op_journal SET state='rejected',error_code='forbidden',delivery_json=?4,result_json=?5,updated_at=?6 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![device,id,seq,receipt.to_string(),result.to_string(),crate::unix_timestamp_ms()]).map_err(|_|"The revoked instructions could not be saved.".to_string())?;
    }Ok(())
}
