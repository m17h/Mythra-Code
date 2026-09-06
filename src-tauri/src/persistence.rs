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
    let app_data = app
        .path()
        .app_data_dir()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript_fixture(turns: usize, text_bytes: usize) -> Value {
        let mut messages = Vec::new();
        let mut activities = Vec::new();
        let mut timeline_order = 0;
        for index in 0..turns {
            timeline_order += 1;
            messages.push(json!({
                "id": format!("user-{index}"),
                "role": "user",
                "text": "u".repeat(text_bytes),
                "turnId": format!("turn-{index}"),
                "timelineOrder": timeline_order,
            }));
            timeline_order += 1;
            activities.push(json!({
                "id": format!("tool-{index}"),
                "kind": "command",
                "title": "npm test",
                "detail": "passed",
                "turnId": format!("turn-{index}"),
                "timelineOrder": timeline_order,
            }));
            timeline_order += 1;
            messages.push(json!({
                "id": format!("assistant-{index}"),
                "role": "assistant",
                "text": "a".repeat(text_bytes),
                "turnId": format!("turn-{index}"),
                "timelineOrder": timeline_order,
            }));
        }
        json!({
            "thread": { "id": "thread-a", "name": "Paged transcript", "cwd": "/project" },
            "cursorSessionId": "cursor-session",
            "messages": messages,
            "activities": activities,
        })
    }

    fn insert_legacy_transcript(
        connection: &Connection,
        provider: &str,
        thread_id: &str,
        value: &Value,
        updated_at: i64,
    ) {
        let key = local_transcript_key(provider, thread_id).expect("legacy key");
        connection
            .execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, serde_json::to_string(value).unwrap(), updated_at],
            )
            .expect("insert legacy transcript");
    }

    fn temporary_state_db(label: &str) -> (PathBuf, Connection) {
        let directory =
            std::env::temp_dir().join(format!("openkiwi-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("openkiwi.sqlite3");
        let connection = open_state_db(&path).expect("open test state database");
        (directory, connection)
    }

    #[test]
    fn ordinary_open_failures_are_not_classified_as_corruption() {
        let error = classify_state_db_error(
            "Could not open database",
            rusqlite::Error::InvalidPath(PathBuf::from("invalid")),
        );
        assert!(matches!(error, StateDbError::Failed(_)));
    }

    #[test]
    fn confirmed_bad_database_is_quarantined_and_replaced() {
        let directory =
            std::env::temp_dir().join(format!("openkiwi-corrupt-db-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("openkiwi.sqlite3");
        std::fs::write(&path, b"this is not a sqlite database").expect("write corrupt database");

        let connection = open_state_db_or_quarantine(&path).expect("replace corrupt database");
        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_state'",
                [],
                |row| row.get(0),
            )
            .expect("query replacement database");
        assert_eq!(table_count, 1);
        drop(connection);

        let quarantined = std::fs::read_dir(&directory)
            .expect("read test directory")
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("openkiwi.sqlite3.quarantined-")
            });
        assert!(quarantined, "original database was not quarantined");
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn local_transcript_migrates_losslessly_and_pages_oldest_to_newest() {
        let (directory, mut connection) = temporary_state_db("paged-transcript");
        let fixture = transcript_fixture(8, 6_000);
        insert_legacy_transcript(&connection, "cursor", "thread-a", &fixture, 100);

        let first =
            read_local_transcript_page(&mut connection, "cursor", "thread-a", None, Some(20_000))
                .expect("read newest page")
                .expect("transcript exists");
        assert!(first.migrated_legacy);
        assert_eq!(first.cursor_session_id.as_deref(), Some("cursor-session"));
        assert_eq!(first.thread["id"], "thread-a");
        assert_eq!(first.tail_seq, first.head_seq + 1);
        assert!(first.next_cursor.is_some());
        assert!(
            first.byte_len > 20_000,
            "one whole turn may exceed the page target"
        );

        let mut pages = vec![first];
        while let Some(cursor) = pages.last().and_then(|page| page.next_cursor.clone()) {
            pages.push(
                read_local_transcript_page(
                    &mut connection,
                    "cursor",
                    "thread-a",
                    Some(&cursor),
                    Some(20_000),
                )
                .expect("read older page")
                .expect("transcript exists"),
            );
        }
        pages.reverse();
        let message_ids = pages
            .iter()
            .flat_map(|page| page.messages.iter())
            .map(|message| message["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let activity_ids = pages
            .iter()
            .flat_map(|page| page.activities.iter())
            .map(|activity| activity["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let expected_message_ids = fixture["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let expected_activity_ids = fixture["activities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|activity| activity["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(message_ids, expected_message_ids);
        assert_eq!(activity_ids, expected_activity_ids);
        let legacy_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM app_state WHERE key = 'kiwi.cursorThread.thread-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            legacy_count, 1,
            "downgrade-compatible legacy row remains intact"
        );
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn local_transcript_full_read_reassembles_every_page_losslessly() {
        let (directory, mut connection) = temporary_state_db("full-transcript-read");
        let fixture = transcript_fixture(80, 20_000);
        insert_legacy_transcript(&connection, "cursor", "thread-a", &fixture, 100);

        let restored = read_local_transcript_full(&mut connection, "cursor", "thread-a")
            .expect("read full transcript")
            .expect("transcript exists");

        assert_eq!(restored, fixture);
        let chunk_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM local_transcript_chunks
                 WHERE provider = 'cursor' AND thread_id = 'thread-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            chunk_count > 1,
            "fixture must exercise multiple backend pages"
        );
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn local_transcript_discovery_recovers_metadata_without_loading_messages() {
        let (directory, mut connection) = temporary_state_db("transcript-discovery");
        let mut claude = transcript_fixture(4, 8_000);
        claude["thread"] = json!({
            "id": "thread-a",
            "name": "Claude thread",
            "preview": "Claude preview",
            "cwd": "/project",
            "updatedAt": 10,
            "modelProvider": "claude"
        });
        write_local_transcript_snapshot(&mut connection, "claude", &claude, 100).unwrap();

        let mut cursor = transcript_fixture(4, 8_000);
        cursor["thread"] = json!({
            "id": "thread-b",
            "name": "Cursor thread",
            "preview": "Cursor preview",
            "cwd": "/project",
            "updatedAt": 20,
            "modelProvider": "cursor"
        });
        write_local_transcript_snapshot(&mut connection, "cursor", &cursor, 200).unwrap();

        // Simulate an older build updating only the compatibility row after
        // chunk metadata already existed. Discovery must prefer this newer
        // thread metadata without returning the same transcript twice.
        claude["thread"]["name"] = json!("Renamed by older build");
        insert_legacy_transcript(&connection, "claude", "thread-a", &claude, 300);
        connection.execute(
            "INSERT INTO app_state(key, value, updated_at) VALUES ('kiwi.cursorThread.damaged', '{bad json', 400)",
            [],
        ).unwrap();

        let discovered =
            read_local_transcript_threads(&connection, &std::collections::HashSet::new()).unwrap();
        assert_eq!(discovered.len(), 2);
        assert_eq!(discovered[0]["id"], "thread-a");
        assert_eq!(discovered[0]["name"], "Renamed by older build");
        assert_eq!(discovered[0]["modelProvider"], "claude");
        assert!(discovered[0].get("messages").is_none());
        assert_eq!(discovered[1]["id"], "thread-b");
        assert_eq!(discovered[1]["modelProvider"], "cursor");

        let known = std::collections::HashSet::from(["thread-a".to_string()]);
        let discovered_from_compact_index =
            read_local_transcript_threads(&connection, &known).unwrap();
        assert_eq!(discovered_from_compact_index.len(), 2);
        assert_eq!(discovered_from_compact_index[0]["id"], "thread-b");
        assert_eq!(discovered_from_compact_index[1]["id"], "thread-a");
        assert_eq!(discovered_from_compact_index[1]["name"], "Claude thread");

        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn snapshot_writes_only_changed_chunk_suffix_and_leaves_legacy_value_stale() {
        let (directory, mut connection) = temporary_state_db("chunk-suffix-write");
        let original = transcript_fixture(20, 4_000);
        insert_legacy_transcript(&connection, "claude", "thread-a", &original, 100);
        read_local_transcript_full(&mut connection, "claude", "thread-a")
            .unwrap()
            .unwrap();
        let legacy_before: (String, i64) = connection
            .query_row(
                "SELECT value, updated_at FROM app_state
                 WHERE key = 'kiwi.claudeThread.thread-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        let unchanged =
            write_local_transcript_snapshot(&mut connection, "claude", &original, 200).unwrap();
        assert_eq!(unchanged.rewritten_chunks, 0);
        let original_generation = unchanged.generation;

        let mut extended = original.clone();
        let messages = extended["messages"].as_array_mut().unwrap();
        messages.push(json!({
            "id": "user-new",
            "role": "user",
            "text": "new question",
            "turnId": "turn-new",
            "timelineOrder": 61,
        }));
        messages.push(json!({
            "id": "assistant-new",
            "role": "assistant",
            "text": "new answer",
            "turnId": "turn-new",
            "timelineOrder": 62,
        }));
        let changed =
            write_local_transcript_snapshot(&mut connection, "claude", &extended, 201).unwrap();

        assert!(changed.rewritten_chunks > 0);
        assert!(changed.rewritten_chunks < changed.total_chunks);
        assert!(changed.generation > original_generation);
        assert_eq!(
            read_local_transcript_full(&mut connection, "claude", "thread-a")
                .unwrap()
                .unwrap(),
            extended
        );
        let legacy_after: (String, i64) = connection
            .query_row(
                "SELECT value, updated_at FROM app_state
                 WHERE key = 'kiwi.claudeThread.thread-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(legacy_after, legacy_before);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn metadata_only_snapshot_updates_do_not_invalidate_page_cursors() {
        let (directory, mut connection) = temporary_state_db("metadata-only-snapshot");
        let original = transcript_fixture(8, 4_000);
        let initial =
            write_local_transcript_snapshot(&mut connection, "cursor", &original, 100).unwrap();
        assert!(initial.compatibility_snapshot_created);
        let page =
            read_local_transcript_page(&mut connection, "cursor", "thread-a", None, Some(20_000))
                .unwrap()
                .unwrap();
        let cursor = page.next_cursor.expect("older page cursor");
        let mut renamed = original.clone();
        renamed["thread"]["name"] = Value::String("Renamed".to_string());

        let write =
            write_local_transcript_snapshot(&mut connection, "cursor", &renamed, 101).unwrap();

        assert_eq!(write.rewritten_chunks, 0);
        assert_eq!(write.generation, initial.generation);
        assert!(read_local_transcript_page(
            &mut connection,
            "cursor",
            "thread-a",
            Some(&cursor),
            Some(20_000),
        )
        .is_ok());
        assert_eq!(
            read_local_transcript_full(&mut connection, "cursor", "thread-a").unwrap(),
            Some(renamed)
        );
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn metadata_write_preserves_chunks_generation_and_page_cursors() {
        let (directory, mut connection) = temporary_state_db("metadata-write");
        let original = transcript_fixture(8, 4_000);
        let initial =
            write_local_transcript_snapshot(&mut connection, "cursor", &original, 100).unwrap();
        let newest =
            read_local_transcript_page(&mut connection, "cursor", "thread-a", None, Some(20_000))
                .unwrap()
                .unwrap();
        let cursor = newest.next_cursor.expect("older page cursor");
        let chunks_before: Vec<(i64, String)> = connection
            .prepare(
                "SELECT seq, entries_json FROM local_transcript_chunks
                 WHERE provider = 'cursor' AND thread_id = 'thread-a' ORDER BY seq",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut renamed_thread = original["thread"].clone();
        renamed_thread["name"] = Value::String("Renamed without hydration".to_string());

        let written = write_local_transcript_metadata(
            &mut connection,
            "cursor",
            "thread-a",
            &renamed_thread,
            Some("new-session"),
            initial.generation,
            101,
        )
        .unwrap();

        assert_eq!(written.generation, initial.generation);
        assert_eq!(
            connection
                .prepare(
                    "SELECT seq, entries_json FROM local_transcript_chunks
                     WHERE provider = 'cursor' AND thread_id = 'thread-a' ORDER BY seq",
                )
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<(i64, String)>, _>>()
                .unwrap(),
            chunks_before
        );
        assert!(read_local_transcript_page(
            &mut connection,
            "cursor",
            "thread-a",
            Some(&cursor),
            Some(20_000),
        )
        .is_ok());
        let restored = read_local_transcript_full(&mut connection, "cursor", "thread-a")
            .unwrap()
            .unwrap();
        assert_eq!(restored["thread"], renamed_thread);
        assert_eq!(restored["cursorSessionId"], "new-session");
        assert_eq!(restored["messages"], original["messages"]);
        assert_eq!(restored["activities"], original["activities"]);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn stale_metadata_write_leaves_existing_metadata_untouched() {
        let (directory, mut connection) = temporary_state_db("stale-metadata-write");
        let original = transcript_fixture(3, 1_000);
        let initial =
            write_local_transcript_snapshot(&mut connection, "claude", &original, 100).unwrap();
        let mut renamed_thread = original["thread"].clone();
        renamed_thread["name"] = Value::String("Must not persist".to_string());

        let error = write_local_transcript_metadata(
            &mut connection,
            "claude",
            "thread-a",
            &renamed_thread,
            None,
            initial.generation + 1,
            101,
        )
        .unwrap_err();

        assert!(error.contains("generation is stale"));
        let restored = read_local_transcript_full(&mut connection, "claude", "thread-a")
            .unwrap()
            .unwrap();
        assert_eq!(restored["thread"], original["thread"]);
        assert_eq!(restored["cursorSessionId"], "cursor-session");
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn metadata_write_rejects_a_different_thread_identity() {
        let (directory, mut connection) = temporary_state_db("metadata-thread-identity");
        let original = transcript_fixture(1, 100);
        let initial =
            write_local_transcript_snapshot(&mut connection, "claude", &original, 100).unwrap();
        let different = json!({ "id": "thread-b", "name": "Wrong thread" });

        let error = write_local_transcript_metadata(
            &mut connection,
            "claude",
            "thread-a",
            &different,
            None,
            initial.generation,
            101,
        )
        .unwrap_err();

        assert!(error.contains("different thread"));
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn old_build_write_after_chunk_snapshot_is_remigrated() {
        let (directory, mut connection) = temporary_state_db("downgrade-round-trip");
        let original = transcript_fixture(4, 1_000);
        let first =
            write_local_transcript_snapshot(&mut connection, "claude", &original, 100).unwrap();
        let downgraded = transcript_fixture(6, 1_000);
        insert_legacy_transcript(&connection, "claude", "thread-a", &downgraded, 101);

        let restored = read_local_transcript_full(&mut connection, "claude", "thread-a")
            .unwrap()
            .unwrap();
        let generation: i64 = connection
            .query_row(
                "SELECT generation FROM local_transcript_meta
                 WHERE provider = 'claude' AND thread_id = 'thread-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(restored, downgraded);
        assert!(generation > first.generation);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn mutable_tail_replaces_pending_entries_then_seals_without_touching_history() {
        let (directory, mut connection) = temporary_state_db("mutable-tail-lifecycle");
        let original = transcript_fixture(4, 1_000);
        let snapshot =
            write_local_transcript_snapshot(&mut connection, "claude", &original, 100).unwrap();
        connection
            .execute(
                "DELETE FROM local_transcript_tail_state
                 WHERE provider = 'claude' AND thread_id = 'thread-a'",
                [],
            )
            .unwrap();
        let initial_state =
            read_local_transcript_write_state(&mut connection, "claude", "thread-a")
                .unwrap()
                .unwrap();
        assert_eq!(initial_state.generation, snapshot.generation);
        assert_eq!(initial_state.tail_seq, initial_state.head_seq + 1);

        let pending = json!({
            "thread": original["thread"].clone(),
            "messages": [{
                "id": "pending-user",
                "role": "user",
                "text": "new prompt",
                "timelineOrder": 13,
            }],
            "activities": [],
        });
        let pending_state = write_local_transcript_tail(
            &mut connection,
            "claude",
            &pending,
            initial_state.generation,
            false,
            101,
        )
        .unwrap();
        assert_eq!(pending_state.tail_seq, initial_state.tail_seq);

        let running = json!({
            "thread": original["thread"].clone(),
            "messages": [
                {
                    "id": "pending-user",
                    "role": "user",
                    "text": "new prompt",
                    "turnId": "turn-new",
                    "timelineOrder": 13,
                },
                {
                    "id": "answer",
                    "role": "assistant",
                    "text": "partial",
                    "streaming": true,
                    "turnId": "turn-new",
                    "timelineOrder": 15,
                }
            ],
            "activities": [{
                "id": "tool-new",
                "kind": "command",
                "title": "npm test",
                "status": "inProgress",
                "turnId": "turn-new",
                "timelineOrder": 14,
            }],
        });
        let running_state = write_local_transcript_tail(
            &mut connection,
            "claude",
            &running,
            pending_state.generation,
            false,
            102,
        )
        .unwrap();
        assert_eq!(running_state.tail_seq, initial_state.tail_seq);
        let during = read_local_transcript_full(&mut connection, "claude", "thread-a")
            .unwrap()
            .unwrap();
        assert_eq!(during["messages"].as_array().unwrap().len(), 10);
        assert_eq!(
            during["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["id"] == "pending-user")
                .count(),
            1,
            "assigning a turn id replaces rather than duplicates the optimistic entry"
        );

        let mut completed = running.clone();
        completed["messages"][1]["streaming"] = Value::Bool(false);
        completed["messages"][0]["turnStatus"] = Value::String("completed".to_string());
        completed["messages"][1]["turnStatus"] = Value::String("completed".to_string());
        completed["activities"][0]["status"] = Value::String("completed".to_string());
        completed["activities"][0]["turnStatus"] = Value::String("completed".to_string());
        let sealed_state = write_local_transcript_tail(
            &mut connection,
            "claude",
            &completed,
            running_state.generation,
            true,
            103,
        )
        .unwrap();
        assert_eq!(sealed_state.tail_seq, sealed_state.head_seq + 1);

        let next = json!({
            "thread": original["thread"].clone(),
            "messages": [{
                "id": "next-user",
                "role": "user",
                "text": "one more",
                "turnId": "turn-next",
                "timelineOrder": 16,
            }],
            "activities": [],
        });
        write_local_transcript_tail(
            &mut connection,
            "claude",
            &next,
            sealed_state.generation,
            false,
            104,
        )
        .unwrap();
        let final_value = read_local_transcript_full(&mut connection, "claude", "thread-a")
            .unwrap()
            .unwrap();
        assert_eq!(final_value["messages"].as_array().unwrap().len(), 11);
        assert_eq!(final_value["activities"].as_array().unwrap().len(), 5);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn stale_tail_write_cannot_overwrite_a_newer_mutable_generation() {
        let (directory, mut connection) = temporary_state_db("stale-tail-cas");
        let original = transcript_fixture(3, 1_000);
        let snapshot =
            write_local_transcript_snapshot(&mut connection, "cursor", &original, 100).unwrap();
        let newer = json!({
            "thread": original["thread"].clone(),
            "cursorSessionId": "new-session",
            "messages": [{
                "id": "newer",
                "role": "assistant",
                "text": "newer value",
                "turnId": "turn-new",
                "timelineOrder": 10,
            }],
            "activities": [],
        });
        let stale = json!({
            "thread": original["thread"].clone(),
            "cursorSessionId": "old-session",
            "messages": [{
                "id": "stale",
                "role": "assistant",
                "text": "stale value",
                "turnId": "turn-new",
                "timelineOrder": 10,
            }],
            "activities": [],
        });
        write_local_transcript_tail(
            &mut connection,
            "cursor",
            &newer,
            snapshot.generation,
            false,
            101,
        )
        .unwrap();

        let error = write_local_transcript_tail(
            &mut connection,
            "cursor",
            &stale,
            snapshot.generation,
            false,
            102,
        )
        .unwrap_err();

        assert!(error.contains("stale"));
        let restored = read_local_transcript_full(&mut connection, "cursor", "thread-a")
            .unwrap()
            .unwrap();
        assert_eq!(restored["cursorSessionId"], "new-session");
        assert!(restored["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["id"] == "newer"));
        assert!(!restored["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["id"] == "stale"));
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn tail_write_rejects_payloads_that_span_multiple_turns() {
        let (directory, mut connection) = temporary_state_db("multi-turn-tail");
        let original = transcript_fixture(2, 1_000);
        let snapshot =
            write_local_transcript_snapshot(&mut connection, "claude", &original, 100).unwrap();
        let invalid = json!({
            "thread": original["thread"].clone(),
            "messages": [
                { "id": "one", "role": "user", "text": "one", "turnId": "turn-one" },
                { "id": "two", "role": "assistant", "text": "two", "turnId": "turn-two" }
            ],
            "activities": [],
        });

        let error = write_local_transcript_tail(
            &mut connection,
            "claude",
            &invalid,
            snapshot.generation,
            false,
            101,
        )
        .unwrap_err();

        assert!(error.contains("more than one turn"));
        assert_eq!(
            read_local_transcript_full(&mut connection, "claude", "thread-a").unwrap(),
            Some(original)
        );
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn full_snapshot_fallback_seals_an_existing_mutable_tail() {
        let (directory, mut connection) = temporary_state_db("tail-snapshot-fallback");
        let original = transcript_fixture(3, 1_000);
        let snapshot =
            write_local_transcript_snapshot(&mut connection, "claude", &original, 100).unwrap();
        let tail = json!({
            "thread": original["thread"].clone(),
            "messages": [{
                "id": "tail",
                "role": "assistant",
                "text": "tail",
                "turnId": "turn-tail",
                "timelineOrder": 10,
            }],
            "activities": [],
        });
        write_local_transcript_tail(
            &mut connection,
            "claude",
            &tail,
            snapshot.generation,
            false,
            101,
        )
        .unwrap();
        let complete = read_local_transcript_full(&mut connection, "claude", "thread-a")
            .unwrap()
            .unwrap();

        let fallback =
            write_local_transcript_snapshot(&mut connection, "claude", &complete, 102).unwrap();
        let state = read_local_transcript_write_state(&mut connection, "claude", "thread-a")
            .unwrap()
            .unwrap();

        assert_eq!(state.generation, fallback.generation);
        assert_eq!(state.tail_seq, state.head_seq + 1);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn newer_legacy_transcript_invalidates_old_page_cursors() {
        let (directory, mut connection) = temporary_state_db("stale-transcript-cursor");
        insert_legacy_transcript(
            &connection,
            "claude",
            "thread-a",
            &transcript_fixture(5, 5_000),
            100,
        );
        let first =
            read_local_transcript_page(&mut connection, "claude", "thread-a", None, Some(20_000))
                .unwrap()
                .unwrap();
        let stale_cursor = first.next_cursor.expect("older page cursor");
        insert_legacy_transcript(
            &connection,
            "claude",
            "thread-a",
            &transcript_fixture(6, 5_000),
            101,
        );
        let newest =
            read_local_transcript_page(&mut connection, "claude", "thread-a", None, Some(20_000))
                .unwrap()
                .unwrap();
        assert!(newest.generation > first.generation);
        let error = read_local_transcript_page(
            &mut connection,
            "claude",
            "thread-a",
            Some(&stale_cursor),
            Some(20_000),
        )
        .unwrap_err();
        assert!(error.contains("stale"));
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn malformed_newer_legacy_value_cannot_destroy_migrated_chunks() {
        let (directory, mut connection) = temporary_state_db("atomic-transcript-migration");
        insert_legacy_transcript(
            &connection,
            "claude",
            "thread-a",
            &transcript_fixture(4, 1_000),
            100,
        );
        let original =
            read_local_transcript_page(&mut connection, "claude", "thread-a", None, None)
                .unwrap()
                .unwrap();
        connection
            .execute(
                "UPDATE app_state SET value = '{broken', updated_at = 101
                 WHERE key = 'kiwi.claudeThread.thread-a'",
                [],
            )
            .unwrap();
        let fallback =
            read_local_transcript_page(&mut connection, "claude", "thread-a", None, None)
                .unwrap()
                .unwrap();
        assert_eq!(fallback.generation, original.generation);
        assert_eq!(fallback.messages, original.messages);
        assert!(fallback.legacy_migration_failed);
        let (generation, chunk_count): (i64, i64) = connection
            .query_row(
                "SELECT generation, (
                   SELECT COUNT(*) FROM local_transcript_chunks
                   WHERE provider = 'claude' AND thread_id = 'thread-a'
                 ) FROM local_transcript_meta
                 WHERE provider = 'claude' AND thread_id = 'thread-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(generation, original.generation);
        assert!(chunk_count > 0);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn deleting_legacy_transcript_also_removes_migrated_pages() {
        let (directory, mut connection) = temporary_state_db("delete-paged-transcript");
        insert_legacy_transcript(
            &connection,
            "claude",
            "thread-a",
            &transcript_fixture(4, 1_000),
            100,
        );
        read_local_transcript_page(&mut connection, "claude", "thread-a", None, None)
            .unwrap()
            .unwrap();

        delete_state_value(&mut connection, "kiwi.claudeThread.thread-a").unwrap();

        assert!(
            read_local_transcript_page(&mut connection, "claude", "thread-a", None, None)
                .unwrap()
                .is_none()
        );
        let retained: i64 = connection
            .query_row(
                "SELECT (
                   SELECT COUNT(*) FROM local_transcript_meta
                   WHERE provider = 'claude' AND thread_id = 'thread-a'
                 ) + (
                   SELECT COUNT(*) FROM local_transcript_chunks
                   WHERE provider = 'claude' AND thread_id = 'thread-a'
                 ) + (
                   SELECT COUNT(*) FROM local_transcript_tail_state
                   WHERE provider = 'claude' AND thread_id = 'thread-a'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, 0);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn legacy_only_deletion_cleans_compatibility_chunks_without_resurrection() {
        let (directory, mut connection) = temporary_state_db("legacy-delete-paged-transcript");
        insert_legacy_transcript(
            &connection,
            "cursor",
            "thread-a",
            &transcript_fixture(4, 1_000),
            100,
        );
        read_local_transcript_page(&mut connection, "cursor", "thread-a", None, None)
            .unwrap()
            .unwrap();
        connection
            .execute(
                "DELETE FROM app_state WHERE key = 'kiwi.cursorThread.thread-a'",
                [],
            )
            .unwrap();

        assert!(
            read_local_transcript_page(&mut connection, "cursor", "thread-a", None, None)
                .unwrap()
                .is_none()
        );
        let retained: i64 = connection
            .query_row(
                "SELECT (
                   SELECT COUNT(*) FROM local_transcript_meta
                   WHERE provider = 'cursor' AND thread_id = 'thread-a'
                 ) + (
                   SELECT COUNT(*) FROM local_transcript_tail_state
                   WHERE provider = 'cursor' AND thread_id = 'thread-a'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, 0);
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn state_write_timestamps_advance_monotonically_per_key() {
        let (directory, connection) = temporary_state_db("monotonic-state-write");
        write_state_value(&connection, "same-key", &json!({ "version": 1 }), 100).unwrap();
        write_state_value(&connection, "same-key", &json!({ "version": 2 }), 100).unwrap();
        write_state_value(&connection, "same-key", &json!({ "version": 3 }), 90).unwrap();
        let (value, updated_at): (String, i64) = connection
            .query_row(
                "SELECT value, updated_at FROM app_state WHERE key = 'same-key'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(updated_at, 102);
        assert!(value.contains("\"version\":3"));
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn entries_without_turn_ids_chunk_in_linear_sized_windows() {
        let messages = (0..4_000)
            .map(|index| json!({ "id": format!("message-{index}"), "role": "assistant", "text": "small" }))
            .collect::<Vec<_>>();
        let transcript = json!({
            "thread": { "id": "thread-a" },
            "messages": messages,
            "activities": [],
        });

        let chunks = local_transcript_chunks(&transcript).unwrap();

        assert!(chunks.len() > 1);
        let entry_count = chunks
            .iter()
            .map(|chunk| serde_json::from_str::<Vec<Value>>(chunk).unwrap().len())
            .sum::<usize>();
        assert_eq!(entry_count, 4_000);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= LOCAL_TRANSCRIPT_CHUNK_TARGET_BYTES));
    }

    #[test]
    fn local_transcript_read_rejects_unknown_providers_and_missing_rows() {
        let (directory, mut connection) = temporary_state_db("transcript-validation");
        assert!(
            read_local_transcript_page(&mut connection, "openai", "thread-a", None, None).is_err()
        );
        assert!(
            read_local_transcript_page(&mut connection, "claude", "missing", None, None)
                .unwrap()
                .is_none()
        );
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn local_transcript_pages_keep_turns_atomic_and_bound_feasible_payloads() {
        let (directory, mut connection) = temporary_state_db("transcript-page-budget");
        let fixture = transcript_fixture(12, 3_000);
        insert_legacy_transcript(&connection, "claude", "thread-a", &fixture, 100);

        let mut cursor = None;
        loop {
            let page = read_local_transcript_page(
                &mut connection,
                "claude",
                "thread-a",
                cursor.as_deref(),
                Some(40 * 1024),
            )
            .unwrap()
            .unwrap();
            assert!(page.byte_len <= 40 * 1024);
            let mut turn_counts = std::collections::HashMap::<String, (usize, usize)>::new();
            for message in &page.messages {
                let turn_id = message["turnId"].as_str().unwrap().to_string();
                turn_counts.entry(turn_id).or_default().0 += 1;
            }
            for activity in &page.activities {
                let turn_id = activity["turnId"].as_str().unwrap().to_string();
                turn_counts.entry(turn_id).or_default().1 += 1;
            }
            assert!(turn_counts.values().all(|counts| *counts == (2, 1)));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        drop(connection);
        std::fs::remove_dir_all(directory).expect("remove test directory");
    }
}
