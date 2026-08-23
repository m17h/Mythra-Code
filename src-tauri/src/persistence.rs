use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use rusqlite::{params, Connection};
use serde_json::Value;
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
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("Could not create OpenKiwi app data: {error}"))?;
    Ok(app_data.join("openkiwi.sqlite3"))
}

/// Current on-disk schema, recorded via `PRAGMA user_version` so future
/// releases have a migration hook. Version 0 is a pre-versioning database
/// with the same shape and is stamped in place.
const STATE_DB_SCHEMA_VERSION: i64 = 1;

/// Startup cap for the audit log; the newest rows win.
const MAX_AUDIT_EVENT_ROWS: i64 = 20_000;

/// A too-new schema is a deliberate refusal (downgraded install; the data is
/// intact and a newer build reads it). Only SQLite's explicit corruption
/// codes permit quarantine; transient locks, permissions, disk-full, and I/O
/// errors must leave the user's database exactly where it is.
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
        format!("{first_error}. OpenKiwi also could not set the damaged database aside: {error}")
    })?;
    open_state_db(path).inspect(|_| {
        eprintln!(
            "OpenKiwi state database was unreadable and has been moved to {}; starting with a fresh database. Original error: {first_error}",
            quarantined.display()
        );
    }).map_err(|error| {
        format!("{first_error}. OpenKiwi also could not create a replacement database: {error}")
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
        classify_state_db_error("Could not open OpenKiwi state database", error)
    })?;
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| {
            classify_state_db_error("Could not read OpenKiwi state database version", error)
        })?;
    if user_version > STATE_DB_SCHEMA_VERSION {
        return Err(StateDbError::TooNew(format!(
            "OpenKiwi state database uses schema version {user_version}, which is newer than this build supports ({STATE_DB_SCHEMA_VERSION}). Update OpenKiwi."
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
             CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC);",
        )
        .map_err(|error| {
            classify_state_db_error("Could not initialize OpenKiwi state database", error)
        })?;
    connection
        .execute_batch(&format!("PRAGMA user_version = {STATE_DB_SCHEMA_VERSION};"))
        .map_err(|error| {
            classify_state_db_error("Could not stamp OpenKiwi state database version", error)
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
            classify_state_db_error("Could not prune OpenKiwi audit history", error)
        })?;
    Ok(connection)
}

pub(super) fn shared_state_db(app: &AppHandle) -> Result<Arc<Mutex<Connection>>, String> {
    app.try_state::<StateDb>()
        .map(|db| db.connection.clone())
        .ok_or_else(|| "OpenKiwi state database is not initialized".to_string())
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
                .map_err(|error| format!("Stored OpenKiwi state is invalid: {error}")),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(format!("Could not read OpenKiwi state: {error}")),
        }
    })
    .await
    .map_err(|error| format!("State read task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn state_write(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        let json = serde_json::to_string(&value).map_err(|error| format!("Could not encode OpenKiwi state: {error}"))?;
        connection
            .execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, json, unix_timestamp_ms()],
            )
            .map_err(|error| format!("Could not save OpenKiwi state: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("State write task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn state_delete(app: AppHandle, key: String) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        connection
            .execute("DELETE FROM app_state WHERE key = ?1", params![key])
            .map_err(|error| format!("Could not delete OpenKiwi state: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("State delete task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
