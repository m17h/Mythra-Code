use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::unix_timestamp_ms;

/// Shared SQLite connection, opened once at startup with DDL applied.
/// Locked with a std::sync::Mutex and only used inside spawn_blocking.
pub(super) struct StateDb {
    pub(super) connection: Arc<Mutex<Connection>>,
}

pub(super) fn state_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = crate::release_qa::app_data_dir(app)
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?;
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("Could not create Mythra Code app data: {error}"))?;
    Ok(app_data.join("openkiwi.sqlite3"))
}

/// Current on-disk schema, recorded via `PRAGMA user_version` so future
/// releases have a migration hook. Version 0 is a pre-versioning database
/// with the same shape and is stamped in place.
const STATE_DB_SCHEMA_VERSION: i64 = 1;

/// Startup cap for the audit log; the newest rows win.
pub(crate) fn prune_audit_events(connection: &Connection) -> rusqlite::Result<usize> {
    connection.execute(
        "DELETE FROM audit_events WHERE id <= (SELECT MAX(id) FROM audit_events) - ?1",
        params![MAX_AUDIT_EVENT_ROWS],
    )
}

const MAX_AUDIT_EVENT_ROWS: i64 = 20_000;
const LOCAL_TRANSCRIPT_CHUNK_TARGET_BYTES: usize = 32 * 1024;
const LOCAL_TRANSCRIPT_PAGE_DEFAULT_BYTES: usize = 40 * 1024;
const LOCAL_TRANSCRIPT_PAGE_MAX_BYTES: usize = 1024 * 1024;

/// A too-new schema is a deliberate refusal (downgraded install; the data is
/// intact and a newer build reads it). Only SQLite's explicit corruption
/// codes permit quarantine; transient locks, permissions, disk-full, and I/O
/// errors must leave the user's database exactly where it is.
#[derive(Debug)]
pub(super) enum StateDbError {
    TooNew(String),
    Corrupt(String),
    Failed(String),
}

impl std::fmt::Display for StateDbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateDbError::TooNew(message)
            | StateDbError::Corrupt(message)
            | StateDbError::Failed(message) => f.write_str(message),
        }
    }
}

fn classify_state_db_error(context: &str, error: rusqlite::Error) -> StateDbError {
    let message = format!("{context}: {error}");
    match &error {
        rusqlite::Error::SqliteFailure(code, _)
            if matches!(
                code.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            ) =>
        {
            StateDbError::Corrupt(message)
        }
        _ => StateDbError::Failed(message),
    }
}

/// Open the state database, and if SQLite confirms corruption or a bad header,
/// rename it aside and start fresh rather than refusing to launch.
/// The quarantined file is kept next to the live one for manual recovery.
pub(super) fn open_state_db_or_quarantine(path: &Path) -> Result<Connection, String> {
    let first_error = match open_state_db(path) {
        Ok(connection) => return Ok(connection),
        Err(StateDbError::TooNew(message)) => return Err(message),
        Err(StateDbError::Failed(message)) => return Err(message),
        Err(StateDbError::Corrupt(message)) => message,
    };
    let quarantined = quarantine_state_db(path).map_err(|error| {
        format!("{first_error}. Mythra Code also could not set the damaged database aside: {error}")
    })?;
    open_state_db(path).inspect(|_| {
        eprintln!(
            "Mythra Code state database was unreadable and has been moved to {}; starting with a fresh database. Original error: {first_error}",
            quarantined.display()
        );
    }).map_err(|error| {
        format!("{first_error}. Mythra Code also could not create a replacement database: {error}")
    })
}

fn quarantine_state_db(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("openkiwi.sqlite3");
    let quarantined =
        path.with_file_name(format!("{file_name}.quarantined-{}", unix_timestamp_ms()));
    // WAL sidecars belong to the damaged database; a fresh one must not replay
    // them. Treat the moves as a unit and roll back anything already moved if
    // one rename fails, so a partial quarantine never strands live state.
    let mut moves = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let sidecar = path.with_file_name(format!("{file_name}{suffix}"));
        if sidecar.exists() {
            moves.push((
                sidecar,
                quarantined.with_file_name(format!(
                    "{}{suffix}",
                    quarantined
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(file_name)
                )),
            ));
        }
    }
    moves.push((path.to_path_buf(), quarantined.clone()));

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (source, destination) in moves {
        if let Err(error) = std::fs::rename(&source, &destination) {
            let mut rollback_errors = Vec::new();
            for (moved_source, moved_destination) in moved.iter().rev() {
                if let Err(rollback_error) = std::fs::rename(moved_destination, moved_source) {
                    rollback_errors.push(rollback_error.to_string());
                }
            }
            let rollback = if rollback_errors.is_empty() {
                String::new()
            } else {
                format!("; rollback also failed: {}", rollback_errors.join("; "))
            };
            return Err(format!(
                "could not move {} to {}: {error}{rollback}",
                source.display(),
                destination.display()
            ));
        }
        moved.push((source, destination));
    }
    Ok(quarantined)
}

pub(super) fn open_state_db(path: &Path) -> Result<Connection, StateDbError> {
    let connection = Connection::open(path).map_err(|error| {
        classify_state_db_error("Could not open Mythra Code state database", error)
    })?;
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| {
            classify_state_db_error("Could not read Mythra Code state database version", error)
        })?;
    if user_version > STATE_DB_SCHEMA_VERSION {
        return Err(StateDbError::TooNew(format!(
            "Mythra Code state database uses schema version {user_version}, which is newer than this build supports ({STATE_DB_SCHEMA_VERSION}). Update Mythra Code."
        )));
    }
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS app_state (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS audit_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               created_at INTEGER NOT NULL,
               kind TEXT NOT NULL,
               thread_id TEXT,
               payload TEXT NOT NULL
             );
             -- Additive tables intentionally remain compatible with schema-1
             -- builds: older apps ignore them and continue using app_state.
             CREATE TABLE IF NOT EXISTS local_transcript_meta (
               provider TEXT NOT NULL,
               thread_id TEXT NOT NULL,
               thread_json TEXT NOT NULL,
               cursor_session_id TEXT,
               head_seq INTEGER NOT NULL,
               generation INTEGER NOT NULL,
               legacy_updated_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY(provider, thread_id)
             );
             CREATE TABLE IF NOT EXISTS local_transcript_chunks (
               provider TEXT NOT NULL,
               thread_id TEXT NOT NULL,
               seq INTEGER NOT NULL,
               entries_json TEXT NOT NULL,
               byte_len INTEGER NOT NULL,
               PRIMARY KEY(provider, thread_id, seq)
             );
             CREATE TABLE IF NOT EXISTS local_transcript_tail_state (
               provider TEXT NOT NULL,
               thread_id TEXT NOT NULL,
               tail_seq INTEGER NOT NULL,
               PRIMARY KEY(provider, thread_id)
             );
             CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC);",
        )
        .map_err(|error| {
            classify_state_db_error("Could not initialize Mythra Code state database", error)
        })?;
    connection
        .execute_batch(&format!("PRAGMA user_version = {STATE_DB_SCHEMA_VERSION};"))
        .map_err(|error| {
            classify_state_db_error("Could not stamp Mythra Code state database version", error)
        })?;
    // Keep the audit log bounded: prune to the newest rows at startup so a
    // long-lived profile cannot grow the database without limit.
    connection
        .execute(
            "DELETE FROM audit_events WHERE id NOT IN (
               SELECT id FROM audit_events ORDER BY id DESC LIMIT ?1
             )",
            params![MAX_AUDIT_EVENT_ROWS],
        )
        .map_err(|error| {
            classify_state_db_error("Could not prune Mythra Code audit history", error)
        })?;
    Ok(connection)
}

pub(super) fn shared_state_db(app: &AppHandle) -> Result<Arc<Mutex<Connection>>, String> {
    app.try_state::<StateDb>()
        .map(|db| db.connection.clone())
        .ok_or_else(|| "Mythra Code state database is not initialized".to_string())
}

pub(super) fn lock_state_db(
    connection: &Mutex<Connection>,
) -> Result<MutexGuard<'_, Connection>, String> {
    // A panic while holding the guard poisons the mutex, but the connection
    // itself is still usable (SQLite statements are transactional). Recover
    // instead of failing every persistence call for the rest of the session.
    Ok(connection
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner))
}

struct LocalTranscriptEntry {
    value: Value,
    wrapped_json: String,
    timeline_order: Option<f64>,
    source_order: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalTranscriptPage {
    thread: Value,
    cursor_session_id: Option<String>,
    messages: Vec<Value>,
    activities: Vec<Value>,
    next_cursor: Option<String>,
    head_seq: i64,
    tail_seq: i64,
    generation: i64,
    byte_len: usize,
    migrated_legacy: bool,
    legacy_migration_failed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalTranscriptSnapshotWrite {
    generation: i64,
    head_seq: i64,
    tail_seq: i64,
    rewritten_chunks: usize,
    total_chunks: usize,
    compatibility_snapshot_created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalTranscriptWriteState {
    generation: i64,
    head_seq: i64,
    tail_seq: i64,
}

const MAX_DISCOVERED_LOCAL_TRANSCRIPTS: usize = 5_000;

/// Rebuild the lightweight sidebar index from durable transcript metadata.
///
/// `localStorage` is only a paint cache. It can be cleared by the webview and
/// is intentionally capped, so it must never be the sole way to discover a
/// Claude or Cursor transcript that still exists in SQLite. Current chunked
/// rows already keep compact thread metadata separately. Legacy compatibility
/// rows are projected through SQLite's JSON support so their message arrays do
/// not cross into Rust or the renderer merely to recover one sidebar row.
fn read_local_transcript_threads(
    connection: &Connection,
    known_thread_ids: &std::collections::HashSet<String>,
) -> Result<Vec<Value>, String> {
    let mut candidates: Vec<(i64, String, String, String)> = Vec::new();
    let mut meta_statement = connection
        .prepare(
            "SELECT updated_at, provider, thread_id, thread_json
             FROM local_transcript_meta ORDER BY updated_at DESC",
        )
        .map_err(|error| {
            format!("Could not prepare local transcript metadata discovery: {error}")
        })?;
    let meta_rows = meta_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("Could not discover local transcript metadata: {error}"))?;
    for row in meta_rows {
        candidates.push(
            row.map_err(|error| format!("Could not read local transcript metadata: {error}"))?,
        );
    }
    drop(meta_statement);

    // The old whole-value row is only parsed when its thread is absent from
    // both chunk metadata and the renderer's compact sidebar cache. Normal
    // upgrades therefore stay metadata-only; true cache recovery pays the
    // unavoidable one-time JSON projection for the missing legacy row.
    let mut legacy_statement = connection
        .prepare(
            "WITH legacy AS (
               SELECT
                 CASE WHEN key LIKE 'kiwi.claudeThread.%' THEN 'claude' ELSE 'cursor' END AS provider,
                 CASE
                   WHEN key LIKE 'kiwi.claudeThread.%' THEN substr(key, length('kiwi.claudeThread.') + 1)
                   ELSE substr(key, length('kiwi.cursorThread.') + 1)
                 END AS thread_id,
                 updated_at
               FROM app_state
               WHERE key LIKE 'kiwi.claudeThread.%' OR key LIKE 'kiwi.cursorThread.%'
             )
             SELECT legacy.updated_at, legacy.provider, legacy.thread_id
             FROM legacy
             LEFT JOIN local_transcript_meta meta
               ON meta.provider = legacy.provider AND meta.thread_id = legacy.thread_id
             WHERE meta.thread_id IS NULL OR legacy.updated_at > meta.legacy_updated_at
             ORDER BY legacy.updated_at DESC",
        )
        .map_err(|error| format!("Could not prepare legacy transcript discovery: {error}"))?;
    let legacy_rows = legacy_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("Could not discover legacy transcripts: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read legacy transcript identity: {error}"))?;
    drop(legacy_statement);
    for (updated_at, provider, thread_id) in legacy_rows {
        if known_thread_ids.contains(&thread_id) {
            continue;
        }
        let legacy_key = local_transcript_key(&provider, &thread_id)?;
        let thread_json = connection
            .query_row(
                "SELECT json_extract(value, '$.thread') FROM app_state
                 WHERE key = ?1 AND json_valid(value)",
                params![legacy_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not project legacy thread metadata: {error}"))?;
        if let Some(thread_json) = thread_json {
            candidates.push((updated_at, provider, thread_id, thread_json));
        }
    }

    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    let mut discovered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (_, provider, thread_id, thread_json) in candidates {
        let identity = format!("{provider}\0{thread_id}");
        if seen.contains(&identity) {
            continue;
        }
        let Ok(mut thread) = serde_json::from_str::<Value>(&thread_json) else {
            // One damaged transcript must not make every healthy thread
            // disappear from the sidebar. Opening that specific legacy row
            // will still surface its precise validation error.
            continue;
        };
        if thread.get("id").and_then(Value::as_str) != Some(thread_id.as_str()) {
            continue;
        }
        let Some(object) = thread.as_object_mut() else {
            continue;
        };
        object.insert("modelProvider".into(), Value::String(provider));
        seen.insert(identity);
        discovered.push(thread);
        if discovered.len() >= MAX_DISCOVERED_LOCAL_TRANSCRIPTS {
            break;
        }
    }
    Ok(discovered)
}

#[tauri::command]
pub(super) async fn local_transcript_list(
    app: AppHandle,
    known_thread_ids: Vec<String>,
) -> Result<Vec<Value>, String> {
    if known_thread_ids.len() > MAX_DISCOVERED_LOCAL_TRANSCRIPTS
        || known_thread_ids
            .iter()
            .any(|thread_id| thread_id.trim().is_empty() || thread_id.len() > 256)
    {
        return Err("Local transcript discovery received an invalid sidebar index".to_string());
    }
    let known_thread_ids = known_thread_ids.into_iter().collect();
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        read_local_transcript_threads(&connection, &known_thread_ids)
    })
    .await
    .map_err(|error| format!("Local transcript discovery task failed: {error}"))?
}

fn local_transcript_key(provider: &str, thread_id: &str) -> Result<String, String> {
    if thread_id.trim().is_empty() {
        return Err("A local transcript requires a thread id".to_string());
    }
    match provider {
        "claude" => Ok(format!("kiwi.claudeThread.{thread_id}")),
        "cursor" => Ok(format!("kiwi.cursorThread.{thread_id}")),
        _ => Err("Local transcript provider must be claude or cursor".to_string()),
    }
}

fn local_transcript_identity_from_key(key: &str) -> Option<(&'static str, &str)> {
    if let Some(thread_id) = key.strip_prefix("kiwi.claudeThread.") {
        return (!thread_id.is_empty()).then_some(("claude", thread_id));
    }
    if let Some(thread_id) = key.strip_prefix("kiwi.cursorThread.") {
        return (!thread_id.is_empty()).then_some(("cursor", thread_id));
    }
    None
}

fn ordered_local_transcript_entries(value: &Value) -> Result<Vec<LocalTranscriptEntry>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Stored local transcript is not an object".to_string())?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Stored local transcript has no messages array".to_string())?;
    let activities = object
        .get("activities")
        .and_then(Value::as_array)
        .ok_or_else(|| "Stored local transcript has no activities array".to_string())?;
    let mut entries = Vec::with_capacity(messages.len() + activities.len());
    for (source_order, message) in messages.iter().chain(activities.iter()).enumerate() {
        let kind = if source_order < messages.len() {
            "message"
        } else {
            "activity"
        };
        let value = message.clone();
        let wrapped_json = serde_json::to_string(&json!({ "kind": kind, "entry": value }))
            .map_err(|error| format!("Could not encode local transcript entry: {error}"))?;
        entries.push(LocalTranscriptEntry {
            timeline_order: message.get("timelineOrder").and_then(Value::as_f64),
            value,
            wrapped_json,
            source_order,
        });
    }
    entries.sort_by(
        |left, right| match (left.timeline_order, right.timeline_order) {
            (Some(left_order), Some(right_order)) => left_order
                .partial_cmp(&right_order)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.source_order.cmp(&right.source_order)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left.source_order.cmp(&right.source_order),
        },
    );
    Ok(entries)
}

fn local_transcript_chunks(value: &Value) -> Result<Vec<String>, String> {
    let entries = ordered_local_transcript_entries(value)?;
    let mut groups: Vec<Vec<LocalTranscriptEntry>> = Vec::new();
    let mut turn_groups = HashMap::<String, usize>::new();
    for entry in entries {
        let turn_id = entry
            .value
            .get("turnId")
            .and_then(Value::as_str)
            .filter(|turn_id| !turn_id.is_empty())
            .map(str::to_string);
        if let Some(group_index) = turn_id
            .as_ref()
            .and_then(|turn_id| turn_groups.get(turn_id))
            .copied()
        {
            groups[group_index].push(entry);
        } else {
            if let Some(turn_id) = turn_id {
                turn_groups.insert(turn_id, groups.len());
            }
            groups.push(vec![entry]);
        }
    }

    let encode = |entries: &[LocalTranscriptEntry]| -> String {
        format!(
            "[{}]",
            entries
                .iter()
                .map(|entry| entry.wrapped_json.as_str())
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let mut chunks = Vec::new();
    let mut current: Vec<LocalTranscriptEntry> = Vec::new();
    let mut current_bytes = 2usize;
    for group in groups {
        let group_bytes = group
            .iter()
            .map(|entry| entry.wrapped_json.len())
            .sum::<usize>()
            + group.len().saturating_sub(1);
        let separator_bytes = usize::from(!current.is_empty());
        if !current.is_empty()
            && current_bytes
                .saturating_add(separator_bytes)
                .saturating_add(group_bytes)
                > LOCAL_TRANSCRIPT_CHUNK_TARGET_BYTES
        {
            chunks.push(encode(&current));
            current = group;
            current_bytes = 2usize.saturating_add(group_bytes);
        } else {
            current_bytes = current_bytes
                .saturating_add(separator_bytes)
                .saturating_add(group_bytes);
            current.extend(group);
        }
    }
    if !current.is_empty() {
        chunks.push(encode(&current));
    }
    if chunks.is_empty() {
        chunks.push("[]".to_string());
    }
    Ok(chunks)
}

enum LegacyMigrationOutcome {
    Migrated,
    Missing,
}

fn migrate_legacy_local_transcript(
    connection: &mut Connection,
    provider: &str,
    thread_id: &str,
) -> Result<LegacyMigrationOutcome, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not begin local transcript migration: {error}"))?;
    let legacy_key = local_transcript_key(provider, thread_id)?;
    let Some((legacy_json, legacy_updated_at)) = transaction
        .query_row(
            "SELECT value, updated_at FROM app_state WHERE key = ?1",
            params![legacy_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not read legacy local transcript: {error}"))?
    else {
        return Ok(LegacyMigrationOutcome::Missing);
    };
    let value: Value = serde_json::from_str(&legacy_json)
        .map_err(|error| format!("Stored local transcript is invalid: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Stored local transcript is not an object".to_string())?;
    let thread = object
        .get("thread")
        .cloned()
        .ok_or_else(|| "Stored local transcript has no thread metadata".to_string())?;
    if thread.get("id").and_then(Value::as_str) != Some(thread_id) {
        return Err("Stored local transcript belongs to a different thread".to_string());
    }
    let cursor_session_id = object
        .get("cursorSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let chunks = local_transcript_chunks(&value)?;
    let prior_generation: i64 = transaction
        .query_row(
            "SELECT generation FROM local_transcript_meta WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect local transcript generation: {error}"))?
        .unwrap_or(0);
    transaction
        .execute(
            "DELETE FROM local_transcript_chunks WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id],
        )
        .map_err(|error| format!("Could not replace local transcript chunks: {error}"))?;
    for (seq, chunk) in chunks.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO local_transcript_chunks(provider, thread_id, seq, entries_json, byte_len)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![provider, thread_id, seq as i64, chunk, chunk.len() as i64],
            )
            .map_err(|error| format!("Could not save local transcript chunk: {error}"))?;
    }
    let now = unix_timestamp_ms();
    transaction
        .execute(
            "INSERT INTO local_transcript_meta(
               provider, thread_id, thread_json, cursor_session_id, head_seq,
               generation, legacy_updated_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(provider, thread_id) DO UPDATE SET
               thread_json = excluded.thread_json,
               cursor_session_id = excluded.cursor_session_id,
               head_seq = excluded.head_seq,
               generation = excluded.generation,
               legacy_updated_at = excluded.legacy_updated_at,
               updated_at = excluded.updated_at",
            params![
                provider,
                thread_id,
                serde_json::to_string(&thread)
                    .map_err(|error| format!("Could not encode local thread metadata: {error}"))?,
                cursor_session_id,
                chunks.len() as i64 - 1,
                prior_generation + 1,
                legacy_updated_at,
                now,
            ],
        )
        .map_err(|error| format!("Could not save local transcript metadata: {error}"))?;
    transaction
        .execute(
            "INSERT INTO local_transcript_tail_state(provider, thread_id, tail_seq)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(provider, thread_id) DO UPDATE SET tail_seq = excluded.tail_seq",
            params![provider, thread_id, chunks.len() as i64],
        )
        .map_err(|error| format!("Could not seal migrated local transcript: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit local transcript migration: {error}"))?;
    Ok(LegacyMigrationOutcome::Migrated)
}

fn parse_local_transcript_cursor(cursor: &str, generation: i64) -> Result<i64, String> {
    let (cursor_generation, seq) = cursor
        .split_once(':')
        .ok_or_else(|| "Local transcript cursor is malformed".to_string())?;
    let cursor_generation = cursor_generation
        .parse::<i64>()
        .map_err(|_| "Local transcript cursor generation is malformed".to_string())?;
    let seq = seq
        .parse::<i64>()
        .map_err(|_| "Local transcript cursor sequence is malformed".to_string())?;
    if cursor_generation != generation || seq < 0 {
        return Err("Local transcript cursor is stale".to_string());
    }
    Ok(seq)
}

fn read_local_transcript_page(
    connection: &mut Connection,
    provider: &str,
    thread_id: &str,
    cursor: Option<&str>,
    byte_budget: Option<usize>,
) -> Result<Option<LocalTranscriptPage>, String> {
    let legacy_key = local_transcript_key(provider, thread_id)?;
    let legacy_updated_at = connection
        .query_row(
            "SELECT updated_at FROM app_state WHERE key = ?1",
            params![legacy_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect legacy local transcript: {error}"))?;
    let meta_legacy_updated_at = connection
        .query_row(
            "SELECT legacy_updated_at FROM local_transcript_meta WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect local transcript metadata: {error}"))?;
    let had_migrated_generation = meta_legacy_updated_at.is_some();
    let mut legacy_migration_failed = false;
    let migrated_legacy = match (legacy_updated_at, meta_legacy_updated_at) {
        (Some(legacy_updated_at), Some(migrated_at)) if legacy_updated_at <= migrated_at => false,
        (Some(_), _) => match migrate_legacy_local_transcript(connection, provider, thread_id) {
            Ok(LegacyMigrationOutcome::Migrated) => true,
            Ok(LegacyMigrationOutcome::Missing) => {
                delete_state_value(connection, &legacy_key)?;
                return Ok(None);
            }
            // A malformed newer compatibility row must not make the last
            // complete migrated generation unreachable.
            Err(_) if had_migrated_generation => {
                legacy_migration_failed = true;
                false
            }
            Err(error) => return Err(error),
        },
        // While legacy rows are the write-side source of truth, their absence
        // means the user deleted the transcript. Never resurrect old chunks.
        (None, Some(_)) => {
            delete_state_value(connection, &legacy_key)?;
            return Ok(None);
        }
        (None, None) => return Ok(None),
    };
    // Builds predating mutable-tail persistence can have chunk metadata but no
    // tail boundary. Initialize it before returning the page and write token
    // together; the shared connection lock keeps this read atomic to callers.
    connection
        .execute(
            "INSERT OR IGNORE INTO local_transcript_tail_state(provider, thread_id, tail_seq)
             SELECT provider, thread_id, head_seq + 1 FROM local_transcript_meta
             WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id],
        )
        .map_err(|error| format!("Could not initialize local transcript tail state: {error}"))?;
    let (thread_json, cursor_session_id, head_seq, tail_seq, generation) = connection
        .query_row(
            "SELECT meta.thread_json, meta.cursor_session_id, meta.head_seq,
                    tail.tail_seq, meta.generation
             FROM local_transcript_meta meta
             JOIN local_transcript_tail_state tail
               ON tail.provider = meta.provider AND tail.thread_id = meta.thread_id
             WHERE meta.provider = ?1 AND meta.thread_id = ?2",
            params![provider, thread_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(|error| format!("Could not read local transcript metadata: {error}"))?;
    let start_seq = cursor
        .map(|cursor| parse_local_transcript_cursor(cursor, generation))
        .transpose()?
        .unwrap_or(head_seq);
    if start_seq > head_seq {
        return Err("Local transcript cursor is stale".to_string());
    }
    let budget = byte_budget
        .unwrap_or(LOCAL_TRANSCRIPT_PAGE_DEFAULT_BYTES)
        .clamp(1, LOCAL_TRANSCRIPT_PAGE_MAX_BYTES);
    let mut statement = connection
        .prepare(
            "SELECT seq, entries_json, byte_len FROM local_transcript_chunks
             WHERE provider = ?1 AND thread_id = ?2 AND seq <= ?3
             ORDER BY seq DESC",
        )
        .map_err(|error| format!("Could not prepare local transcript page: {error}"))?;
    let mut rows = statement
        .query(params![provider, thread_id, start_seq])
        .map_err(|error| format!("Could not read local transcript page: {error}"))?;
    let mut selected: Vec<(i64, String)> = Vec::new();
    let mut byte_len = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Could not advance local transcript page: {error}"))?
    {
        let seq = row
            .get::<_, i64>(0)
            .map_err(|error| format!("Could not read local transcript sequence: {error}"))?;
        let entries_json = row
            .get::<_, String>(1)
            .map_err(|error| format!("Could not read local transcript entries: {error}"))?;
        let chunk_bytes = row
            .get::<_, i64>(2)
            .map_err(|error| format!("Could not read local transcript size: {error}"))?
            .max(0) as usize;
        if !selected.is_empty() && byte_len.saturating_add(chunk_bytes) > budget {
            break;
        }
        byte_len = byte_len.saturating_add(chunk_bytes);
        selected.push((seq, entries_json));
    }
    drop(rows);
    drop(statement);
    selected.reverse();
    let oldest_seq = selected.first().map(|(seq, _)| *seq).unwrap_or(start_seq);
    let mut messages = Vec::new();
    let mut activities = Vec::new();
    for (_, entries_json) in selected {
        let entries: Vec<Value> = serde_json::from_str(&entries_json)
            .map_err(|error| format!("Stored local transcript chunk is invalid: {error}"))?;
        for wrapped in entries {
            let kind = wrapped.get("kind").and_then(Value::as_str);
            let entry = wrapped.get("entry").cloned();
            match (kind, entry) {
                (Some("message"), Some(entry)) => messages.push(entry),
                (Some("activity"), Some(entry)) => activities.push(entry),
                _ => return Err("Stored local transcript chunk has an invalid entry".to_string()),
            }
        }
    }
    let thread = serde_json::from_str(&thread_json)
        .map_err(|error| format!("Stored local thread metadata is invalid: {error}"))?;
    Ok(Some(LocalTranscriptPage {
        thread,
        cursor_session_id,
        messages,
        activities,
        next_cursor: (oldest_seq > 0).then(|| format!("{generation}:{}", oldest_seq - 1)),
        head_seq,
        tail_seq,
        generation,
        byte_len,
        migrated_legacy,
        legacy_migration_failed,
    }))
}

#[tauri::command]
pub(super) async fn local_transcript_page_read(
    app: AppHandle,
    provider: String,
    thread_id: String,
    cursor: Option<String>,
    byte_budget: Option<usize>,
) -> Result<Option<LocalTranscriptPage>, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        read_local_transcript_page(
            &mut connection,
            &provider,
            &thread_id,
            cursor.as_deref(),
            byte_budget,
        )
    })
    .await
    .map_err(|error| format!("Local transcript page task failed: {error}"))?
}

fn read_local_transcript_full(
    connection: &mut Connection,
    provider: &str,
    thread_id: &str,
) -> Result<Option<Value>, String> {
    let mut cursor = None;
    let mut pages = Vec::new();
    loop {
        let Some(page) = read_local_transcript_page(
            connection,
            provider,
            thread_id,
            cursor.as_deref(),
            Some(LOCAL_TRANSCRIPT_PAGE_MAX_BYTES),
        )?
        else {
            return Ok(None);
        };
        cursor = page.next_cursor.clone();
        pages.push(page);
        if cursor.is_none() {
            break;
        }
    }
    pages.reverse();
    let newest = pages
        .last()
        .ok_or_else(|| "Local transcript has no readable pages".to_string())?;
    let thread = newest.thread.clone();
    let cursor_session_id = newest.cursor_session_id.clone();
    let mut messages = Vec::new();
    let mut activities = Vec::new();
    for page in pages {
        messages.extend(page.messages);
        activities.extend(page.activities);
    }
    let mut transcript = serde_json::Map::new();
    transcript.insert("thread".to_string(), thread);
    if let Some(cursor_session_id) = cursor_session_id {
        transcript.insert(
            "cursorSessionId".to_string(),
            Value::String(cursor_session_id),
        );
    }
    transcript.insert("messages".to_string(), Value::Array(messages));
    transcript.insert("activities".to_string(), Value::Array(activities));
    Ok(Some(Value::Object(transcript)))
}

#[tauri::command]
pub(super) async fn local_transcript_full_read(
    app: AppHandle,
    provider: String,
    thread_id: String,
) -> Result<Option<Value>, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        read_local_transcript_full(&mut connection, &provider, &thread_id)
    })
    .await
    .map_err(|error| format!("Local transcript full read task failed: {error}"))?
}

fn write_local_transcript_snapshot(
    connection: &mut Connection,
    provider: &str,
    value: &Value,
    now: i64,
) -> Result<LocalTranscriptSnapshotWrite, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Local transcript snapshot is not an object".to_string())?;
    let thread = object
        .get("thread")
        .cloned()
        .ok_or_else(|| "Local transcript snapshot has no thread metadata".to_string())?;
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .filter(|thread_id| !thread_id.trim().is_empty())
        .ok_or_else(|| "Local transcript snapshot has no thread id".to_string())?;
    let legacy_key = local_transcript_key(provider, thread_id)?;
    let cursor_session_id = object
        .get("cursorSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let chunks = local_transcript_chunks(value)?;
    let thread_json = serde_json::to_string(&thread)
        .map_err(|error| format!("Could not encode local thread metadata: {error}"))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not begin local transcript snapshot: {error}"))?;

    // Keep exactly one whole-value compatibility snapshot. Older builds can
    // still open a thread after downgrade, but routine saves in this build no
    // longer rewrite the multi-megabyte app_state row.
    let existing_legacy_updated_at = transaction
        .query_row(
            "SELECT updated_at FROM app_state WHERE key = ?1",
            params![legacy_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect compatibility transcript: {error}"))?;
    let compatibility_snapshot_created = existing_legacy_updated_at.is_none();
    let legacy_updated_at = if let Some(updated_at) = existing_legacy_updated_at {
        updated_at
    } else {
        let snapshot_json = serde_json::to_string(value)
            .map_err(|error| format!("Could not encode compatibility transcript: {error}"))?;
        transaction
            .execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, ?3)",
                params![legacy_key, snapshot_json, now],
            )
            .map_err(|error| format!("Could not create compatibility transcript: {error}"))?;
        now
    };

    let prior_meta = transaction
        .query_row(
            "SELECT generation FROM local_transcript_meta
             WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect local transcript generation: {error}"))?;
    let mut statement = transaction
        .prepare(
            "SELECT entries_json FROM local_transcript_chunks
             WHERE provider = ?1 AND thread_id = ?2 ORDER BY seq ASC",
        )
        .map_err(|error| format!("Could not prepare local transcript comparison: {error}"))?;
    let existing_chunks = statement
        .query_map(params![provider, thread_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not compare local transcript chunks: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read local transcript chunk: {error}"))?;
    drop(statement);
    let common_prefix = existing_chunks
        .iter()
        .zip(chunks.iter())
        .take_while(|(existing, replacement)| existing == replacement)
        .count();
    let chunks_changed = existing_chunks != chunks;
    let rewritten_chunks = if chunks_changed {
        let affected_chunks = existing_chunks
            .len()
            .max(chunks.len())
            .saturating_sub(common_prefix);
        transaction
            .execute(
                "DELETE FROM local_transcript_chunks
                 WHERE provider = ?1 AND thread_id = ?2 AND seq >= ?3",
                params![provider, thread_id, common_prefix as i64],
            )
            .map_err(|error| format!("Could not replace local transcript suffix: {error}"))?;
        for (seq, chunk) in chunks.iter().enumerate().skip(common_prefix) {
            transaction
                .execute(
                    "INSERT INTO local_transcript_chunks(provider, thread_id, seq, entries_json, byte_len)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![provider, thread_id, seq as i64, chunk, chunk.len() as i64],
                )
                .map_err(|error| format!("Could not save local transcript suffix: {error}"))?;
        }
        affected_chunks
    } else {
        0
    };
    let generation = match prior_meta {
        Some(generation) if !chunks_changed => generation,
        Some(generation) => generation + 1,
        None => 1,
    };
    transaction
        .execute(
            "INSERT INTO local_transcript_meta(
               provider, thread_id, thread_json, cursor_session_id, head_seq,
               generation, legacy_updated_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(provider, thread_id) DO UPDATE SET
               thread_json = excluded.thread_json,
               cursor_session_id = excluded.cursor_session_id,
               head_seq = excluded.head_seq,
               generation = excluded.generation,
               legacy_updated_at = excluded.legacy_updated_at,
               updated_at = MAX(excluded.updated_at, local_transcript_meta.updated_at + 1)",
            params![
                provider,
                thread_id,
                thread_json,
                cursor_session_id,
                chunks.len() as i64 - 1,
                generation,
                legacy_updated_at,
                now,
            ],
        )
        .map_err(|error| format!("Could not save local transcript metadata: {error}"))?;
    transaction
        .execute(
            "INSERT INTO local_transcript_tail_state(provider, thread_id, tail_seq)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(provider, thread_id) DO UPDATE SET tail_seq = excluded.tail_seq",
            params![provider, thread_id, chunks.len() as i64],
        )
        .map_err(|error| format!("Could not seal local transcript snapshot: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit local transcript snapshot: {error}"))?;
    Ok(LocalTranscriptSnapshotWrite {
        generation,
        head_seq: chunks.len() as i64 - 1,
        tail_seq: chunks.len() as i64,
        rewritten_chunks,
        total_chunks: chunks.len(),
        compatibility_snapshot_created,
    })
}

#[tauri::command]
pub(super) async fn local_transcript_snapshot_write(
    app: AppHandle,
    provider: String,
    value: Value,
) -> Result<LocalTranscriptSnapshotWrite, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        write_local_transcript_snapshot(&mut connection, &provider, &value, unix_timestamp_ms())
    })
    .await
    .map_err(|error| format!("Local transcript snapshot task failed: {error}"))?
}

fn read_local_transcript_write_state(
    connection: &mut Connection,
    provider: &str,
    thread_id: &str,
) -> Result<Option<LocalTranscriptWriteState>, String> {
    if read_local_transcript_page(connection, provider, thread_id, None, Some(1))?.is_none() {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT meta.generation, meta.head_seq, tail.tail_seq
             FROM local_transcript_meta meta
             JOIN local_transcript_tail_state tail
               ON tail.provider = meta.provider AND tail.thread_id = meta.thread_id
             WHERE meta.provider = ?1 AND meta.thread_id = ?2",
            params![provider, thread_id],
            |row| {
                Ok(LocalTranscriptWriteState {
                    generation: row.get(0)?,
                    head_seq: row.get(1)?,
                    tail_seq: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Could not read local transcript write state: {error}"))
}

#[tauri::command]
pub(super) async fn local_transcript_write_state_read(
    app: AppHandle,
    provider: String,
    thread_id: String,
) -> Result<Option<LocalTranscriptWriteState>, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        read_local_transcript_write_state(&mut connection, &provider, &thread_id)
    })
    .await
    .map_err(|error| format!("Local transcript write state task failed: {error}"))?
}

fn rename_local_transcript(
    connection: &mut Connection,
    provider: &str,
    thread_id: &str,
    name: &str,
    now: i64,
) -> Result<(), String> {
    local_transcript_key(provider, thread_id)?;
    if name.trim().is_empty() {
        return Err("A thread name cannot be empty".into());
    }
    // Import a legacy transcript if necessary, without ever passing an empty
    // renderer window through the destructive snapshot writer.
    if read_local_transcript_page(connection, provider, thread_id, None, Some(1))?.is_none() {
        return Err("Local transcript no longer exists".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not begin thread rename: {error}"))?;
    let raw: String = transaction
        .query_row(
            "SELECT thread_json FROM local_transcript_meta WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read thread metadata: {error}"))?
        .ok_or_else(|| "Local transcript no longer exists".to_string())?;
    let mut thread: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not decode thread metadata: {error}"))?;
    let metadata = thread
        .as_object_mut()
        .ok_or("Local thread metadata is not an object")?;
    metadata.insert("name".into(), Value::String(name.to_string()));
    transaction.execute(
        "UPDATE local_transcript_meta SET thread_json = ?3, updated_at = MAX(?4, updated_at + 1)
         WHERE provider = ?1 AND thread_id = ?2",
        params![provider, thread_id, thread.to_string(), now],
    ).map_err(|error| format!("Could not rename thread: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit thread rename: {error}"))
}

#[tauri::command]
pub(super) async fn local_transcript_rename(
    app: AppHandle,
    provider: String,
    thread_id: String,
    name: String,
) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        rename_local_transcript(
            &mut connection,
            &provider,
            &thread_id,
            &name,
            unix_timestamp_ms(),
        )
    })
    .await
    .map_err(|error| format!("Local thread rename task failed: {error}"))?
}

fn write_local_transcript_metadata(
    connection: &mut Connection,
    provider: &str,
    thread_id: &str,
    thread: &Value,
    cursor_session_id: Option<&str>,
    expected_generation: i64,
    now: i64,
) -> Result<LocalTranscriptWriteState, String> {
    local_transcript_key(provider, thread_id)?;
    if thread.get("id").and_then(Value::as_str) != Some(thread_id) {
        return Err("Local transcript metadata belongs to a different thread".to_string());
    }
    if read_local_transcript_page(connection, provider, thread_id, None, Some(1))?.is_none() {
        return Err("Local transcript no longer exists".to_string());
    }
    let thread_json = serde_json::to_string(thread)
        .map_err(|error| format!("Could not encode local thread metadata: {error}"))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not begin local transcript metadata write: {error}"))?;
    let (generation, head_seq, tail_seq): (i64, i64, i64) = transaction
        .query_row(
            "SELECT meta.generation, meta.head_seq, tail.tail_seq
             FROM local_transcript_meta meta
             JOIN local_transcript_tail_state tail
               ON tail.provider = meta.provider AND tail.thread_id = meta.thread_id
             WHERE meta.provider = ?1 AND meta.thread_id = ?2",
            params![provider, thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Could not inspect local transcript metadata: {error}"))?;
    if generation != expected_generation {
        return Err(format!(
            "Local transcript generation is stale (expected {expected_generation}, current {generation})"
        ));
    }
    transaction
        .execute(
            "UPDATE local_transcript_meta SET
               thread_json = ?3,
               cursor_session_id = ?4,
               updated_at = MAX(?5, updated_at + 1)
             WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id, thread_json, cursor_session_id, now],
        )
        .map_err(|error| format!("Could not update local transcript metadata: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit local transcript metadata: {error}"))?;
    Ok(LocalTranscriptWriteState {
        generation,
        head_seq,
        tail_seq,
    })
}

#[tauri::command]
pub(super) async fn local_transcript_metadata_write(
    app: AppHandle,
    provider: String,
    thread_id: String,
    thread: Value,
    cursor_session_id: Option<String>,
    expected_generation: i64,
) -> Result<LocalTranscriptWriteState, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        write_local_transcript_metadata(
            &mut connection,
            &provider,
            &thread_id,
            &thread,
            cursor_session_id.as_deref(),
            expected_generation,
            unix_timestamp_ms(),
        )
    })
    .await
    .map_err(|error| format!("Local transcript metadata task failed: {error}"))?
}

fn write_local_transcript_tail(
    connection: &mut Connection,
    provider: &str,
    value: &Value,
    expected_generation: i64,
    seal: bool,
    now: i64,
) -> Result<LocalTranscriptWriteState, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Local transcript tail is not an object".to_string())?;
    let thread = object
        .get("thread")
        .cloned()
        .ok_or_else(|| "Local transcript tail has no thread metadata".to_string())?;
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .filter(|thread_id| !thread_id.trim().is_empty())
        .ok_or_else(|| "Local transcript tail has no thread id".to_string())?;
    local_transcript_key(provider, thread_id)?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Local transcript tail has no messages array".to_string())?;
    let activities = object
        .get("activities")
        .and_then(Value::as_array)
        .ok_or_else(|| "Local transcript tail has no activities array".to_string())?;
    let mut turn_ids = messages
        .iter()
        .chain(activities.iter())
        .filter_map(|entry| entry.get("turnId").and_then(Value::as_str))
        .filter(|turn_id| !turn_id.is_empty())
        .collect::<Vec<_>>();
    turn_ids.sort_unstable();
    turn_ids.dedup();
    if turn_ids.len() > 1 {
        return Err("Local transcript tail spans more than one turn".to_string());
    }
    let tail_chunks = if messages.is_empty() && activities.is_empty() {
        Vec::new()
    } else {
        local_transcript_chunks(value)?
    };
    let thread_json = serde_json::to_string(&thread)
        .map_err(|error| format!("Could not encode local thread metadata: {error}"))?;
    let cursor_session_id = object
        .get("cursorSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);

    // Reconcile a newer compatibility row (or an old-build deletion) before
    // entering the CAS transaction. A remigration advances generation, so the
    // caller must retry from fresh state instead of overwriting it.
    if read_local_transcript_page(connection, provider, thread_id, None, Some(1))?.is_none() {
        return Err("Local transcript no longer exists".to_string());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not begin local transcript tail write: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO local_transcript_tail_state(provider, thread_id, tail_seq)
             SELECT provider, thread_id, head_seq + 1 FROM local_transcript_meta
             WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id],
        )
        .map_err(|error| format!("Could not initialize local transcript tail: {error}"))?;
    let (generation, head_seq, tail_seq): (i64, i64, i64) = transaction
        .query_row(
            "SELECT meta.generation, meta.head_seq, tail.tail_seq
             FROM local_transcript_meta meta
             JOIN local_transcript_tail_state tail
               ON tail.provider = meta.provider AND tail.thread_id = meta.thread_id
             WHERE meta.provider = ?1 AND meta.thread_id = ?2",
            params![provider, thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Could not inspect local transcript tail: {error}"))?;
    if generation != expected_generation {
        return Err(format!(
            "Local transcript generation is stale (expected {expected_generation}, current {generation})"
        ));
    }
    if tail_seq < 0 || tail_seq > head_seq + 1 {
        return Err("Stored local transcript tail boundary is invalid".to_string());
    }
    transaction
        .execute(
            "DELETE FROM local_transcript_chunks
             WHERE provider = ?1 AND thread_id = ?2 AND seq >= ?3",
            params![provider, thread_id, tail_seq],
        )
        .map_err(|error| format!("Could not replace local transcript tail: {error}"))?;
    for (offset, chunk) in tail_chunks.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO local_transcript_chunks(provider, thread_id, seq, entries_json, byte_len)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    provider,
                    thread_id,
                    tail_seq + offset as i64,
                    chunk,
                    chunk.len() as i64
                ],
            )
            .map_err(|error| format!("Could not save local transcript tail: {error}"))?;
    }
    let next_head_seq = tail_seq + tail_chunks.len() as i64 - 1;
    let next_generation = generation + 1;
    let next_tail_seq = if seal { next_head_seq + 1 } else { tail_seq };
    transaction
        .execute(
            "UPDATE local_transcript_meta SET
               thread_json = ?3,
               cursor_session_id = ?4,
               head_seq = ?5,
               generation = ?6,
               updated_at = MAX(?7, updated_at + 1)
             WHERE provider = ?1 AND thread_id = ?2",
            params![
                provider,
                thread_id,
                thread_json,
                cursor_session_id,
                next_head_seq,
                next_generation,
                now,
            ],
        )
        .map_err(|error| format!("Could not update local transcript tail metadata: {error}"))?;
    transaction
        .execute(
            "UPDATE local_transcript_tail_state SET tail_seq = ?3
             WHERE provider = ?1 AND thread_id = ?2",
            params![provider, thread_id, next_tail_seq],
        )
        .map_err(|error| format!("Could not update local transcript tail boundary: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit local transcript tail: {error}"))?;
    Ok(LocalTranscriptWriteState {
        generation: next_generation,
        head_seq: next_head_seq,
        tail_seq: next_tail_seq,
    })
}

#[tauri::command]
pub(super) async fn local_transcript_tail_write(
    app: AppHandle,
    provider: String,
    value: Value,
    expected_generation: i64,
    seal: bool,
) -> Result<LocalTranscriptWriteState, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        write_local_transcript_tail(
            &mut connection,
            &provider,
            &value,
            expected_generation,
            seal,
            unix_timestamp_ms(),
        )
    })
    .await
    .map_err(|error| format!("Local transcript tail task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn state_read(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        match connection.query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            Ok(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|error| format!("Stored Mythra Code state is invalid: {error}")),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(format!("Could not read Mythra Code state: {error}")),
        }
    })
    .await
    .map_err(|error| format!("State read task failed: {error}"))?
}

// Startup must distinguish a missing record from a saved JSON `null` (or
// malformed JSON). Returning serialized data preserves that distinction and
// lets the frontend stop before migrations could replace an invalid record.
fn read_state_raw(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Could not read saved startup data.".to_owned())
}

#[tauri::command]
pub(super) async fn state_read_raw(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        read_state_raw(&connection, &key)
    })
    .await
    .map_err(|_| "Could not read saved startup data.".to_owned())?
}

fn write_state_value(
    connection: &Connection,
    key: &str,
    value: &Value,
    now: i64,
) -> Result<(), String> {
    let json = serde_json::to_string(value)
        .map_err(|error| format!("Could not encode Mythra Code state: {error}"))?;
    connection
        .execute(
            "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = MAX(excluded.updated_at, app_state.updated_at + 1)",
            params![key, json, now],
        )
        .map_err(|error| format!("Could not save Mythra Code state: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(super) async fn state_write(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        write_state_value(&connection, &key, &value, unix_timestamp_ms())
    })
    .await
    .map_err(|error| format!("State write task failed: {error}"))?
}

fn delete_state_value(connection: &mut Connection, key: &str) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not begin Mythra Code state deletion: {error}"))?;
    transaction
        .execute("DELETE FROM app_state WHERE key = ?1", params![key])
        .map_err(|error| format!("Could not delete Mythra Code state: {error}"))?;
    if let Some((provider, thread_id)) = local_transcript_identity_from_key(key) {
        transaction
            .execute(
                "DELETE FROM local_transcript_tail_state WHERE provider = ?1 AND thread_id = ?2",
                params![provider, thread_id],
            )
            .map_err(|error| format!("Could not delete local transcript tail state: {error}"))?;
        transaction
            .execute(
                "DELETE FROM local_transcript_chunks WHERE provider = ?1 AND thread_id = ?2",
                params![provider, thread_id],
            )
            .map_err(|error| format!("Could not delete local transcript chunks: {error}"))?;
        transaction
            .execute(
                "DELETE FROM local_transcript_meta WHERE provider = ?1 AND thread_id = ?2",
                params![provider, thread_id],
            )
            .map_err(|error| format!("Could not delete local transcript metadata: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Mythra Code state deletion: {error}"))
}

#[tauri::command]
pub(super) async fn state_delete(app: AppHandle, key: String) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = lock_state_db(&connection)?;
        delete_state_value(&mut connection, &key)
    })
    .await
    .map_err(|error| format!("State delete task failed: {error}"))?
}
