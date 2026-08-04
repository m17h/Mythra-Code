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

pub(super) fn open_state_db(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Could not open OpenKiwi state database: {error}"))?;
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read OpenKiwi state database version: {error}"))?;
    if user_version > STATE_DB_SCHEMA_VERSION {
        return Err(format!(
            "OpenKiwi state database uses schema version {user_version}, which is newer than this build supports ({STATE_DB_SCHEMA_VERSION}). Update OpenKiwi."
        ));
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
        .map_err(|error| format!("Could not initialize OpenKiwi state database: {error}"))?;
    connection
        .execute_batch(&format!("PRAGMA user_version = {STATE_DB_SCHEMA_VERSION};"))
        .map_err(|error| format!("Could not stamp OpenKiwi state database version: {error}"))?;
    // Keep the audit log bounded: prune to the newest rows at startup so a
    // long-lived profile cannot grow the database without limit.
    connection
        .execute(
            "DELETE FROM audit_events WHERE id NOT IN (
               SELECT id FROM audit_events ORDER BY id DESC LIMIT ?1
             )",
            params![MAX_AUDIT_EVENT_ROWS],
        )
        .map_err(|error| format!("Could not prune OpenKiwi audit history: {error}"))?;
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
