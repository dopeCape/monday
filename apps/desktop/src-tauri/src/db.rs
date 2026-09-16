//! The SQLite Cache behind three commands (ADR 0009; research tauri-sidecar section 10).
//!
//! One rusqlite connection per Workspace, opened lazily at
//! `app_data_dir()/cache/<workspace>.sqlite` in WAL mode. The command surface is
//! deliberately tiny: `db_exec`, `db_query` and `db_batch` (one transaction).
//! Every statement, the schema included, lives in TypeScript under `src/store`.
//! Parameters arrive as JSON values and rows go back as JSON objects keyed by
//! column name, so the webview never sees a SQLite type.
//!
//! The `bundled-sqlcipher-vendored-openssl` feature compiles SQLCipher into the
//! binary with FTS5 and JSON1 on every platform, which is what the search index
//! (ADR 0011) needs, and encrypts the file at rest. The per-Workspace cache key
//! (ADR 0006: revoking a Device invalidates its Cache key) is 32 random bytes
//! kept in the OS keychain under `cache-key:<workspace>`; it never reaches the
//! webview.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{Map, Number, Value};
use tauri::{AppHandle, Manager, State};

/// Open connections, one per Workspace, for the life of the process.
#[derive(Default)]
pub struct DbState {
    conns: Mutex<HashMap<String, Connection>>,
}

/// One statement of a batch: SQL plus positional parameters.
#[derive(Deserialize, Debug, Clone)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

pub type Row = Map<String, Value>;

/// Opens (or creates) the database at `path` with the pragmas the Cache wants.
/// `key` is the SQLCipher key (32 bytes); `None` opens an unencrypted database,
/// which only tests use. `":memory:"` is accepted for tests.
pub fn open_at(path: &Path, key: Option<&[u8]>) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && path.to_str() != Some(":memory:") {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).map_err(|e| e.to_string())?;
    if let Some(key) = key {
        // The hex form keys SQLCipher with the raw bytes and skips its KDF.
        conn.pragma_update(None, "key", format!("x'{}'", encode_hex(key))).map_err(|e| e.to_string())?;
        // Touching the schema is how a wrong key surfaces.
        conn.query_row("select count(*) from sqlite_master", [], |_| Ok(()))
            .map_err(|e| format!("cache is not readable with this key: {e}"))?;
    }
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    // WAL is not available for in-memory databases; ignore that one failure.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "temp_store", "MEMORY").map_err(|e| e.to_string())?;
    Ok(conn)
}

fn to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        // Arrays and objects are stored as JSON text; the schema keeps such
        // columns as TEXT and TypeScript parses them back.
        other => SqlValue::Text(other.to_string()),
    }
}

fn from_sql(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(Number::from(i)),
        ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Array(b.iter().map(|x| Value::Number(Number::from(*x))).collect()),
    }
}

/// Runs one statement and returns the number of rows it changed.
pub fn exec(conn: &Connection, sql: &str, params: &[Value]) -> Result<usize, String> {
    let bound: Vec<SqlValue> = params.iter().map(to_sql).collect();
    if bound.is_empty() {
        // Allows multi-statement text such as a schema.
        if !sql.trim_start().to_ascii_lowercase().starts_with("select") && sql.matches(';').count() > 1 {
            conn.execute_batch(sql).map_err(|e| e.to_string())?;
            return Ok(conn.changes() as usize);
        }
    }
    conn.execute(sql, params_from_iter(bound.iter())).map_err(|e| e.to_string())
}

/// Runs one statement and returns its rows as JSON objects keyed by column name.
pub fn query(conn: &Connection, sql: &str, params: &[Value]) -> Result<Vec<Row>, String> {
    let bound: Vec<SqlValue> = params.iter().map(to_sql).collect();
    let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(params_from_iter(bound.iter())).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut object = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let v = row.get_ref(i).map_err(|e| e.to_string())?;
            object.insert(name.clone(), from_sql(v));
        }
        out.push(object);
    }
    Ok(out)
}

/// Runs every statement in one transaction; any failure rolls all of them back.
pub fn batch(conn: &mut Connection, statements: &[Statement]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for s in statements {
        exec(&tx, &s.sql, &s.params)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Workspace ids become file names; only a conservative character set is accepted.
pub fn cache_file_name(workspace: &str) -> Result<String, String> {
    if workspace.is_empty()
        || workspace.len() > 128
        || !workspace.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid workspace id: {workspace:?}"));
    }
    Ok(format!("{workspace}.sqlite"))
}

fn cache_path(app: &AppHandle, workspace: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cache");
    Ok(dir.join(cache_file_name(workspace)?))
}

/// The Workspace's cache key from the keychain, minted on first use.
fn cache_key(workspace: &str) -> Result<Vec<u8>, String> {
    let entry = keyring::Entry::new(crate::secrets::SERVICE, &format!("cache-key:{workspace}"))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(hex) => decode_hex(&hex).ok_or_else(|| "cache key in keychain is not hex".to_string()),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::RngCore::fill_bytes(&mut rand::rng(), &mut bytes);
            entry
                .set_password(&encode_hex(&bytes))
                .map_err(|e| format!("cannot store the cache key: {e}"))?;
            Ok(bytes.to_vec())
        }
        Err(e) => Err(format!("cannot read the cache key: {e}")),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn with_conn<T>(
    app: &AppHandle,
    state: &DbState,
    workspace: &str,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut conns = state.conns.lock().map_err(|e| e.to_string())?;
    if !conns.contains_key(workspace) {
        let key = cache_key(workspace)?;
        let conn = open_at(&cache_path(app, workspace)?, Some(&key))?;
        conns.insert(workspace.to_string(), conn);
    }
    let conn = conns.get_mut(workspace).ok_or("connection vanished")?;
    f(conn)
}

#[tauri::command]
pub async fn db_exec(
    app: AppHandle,
    state: State<'_, DbState>,
    workspace: String,
    sql: String,
    params: Vec<Value>,
) -> Result<usize, String> {
    with_conn(&app, &state, &workspace, |c| exec(c, &sql, &params))
}

#[tauri::command]
pub async fn db_query(
    app: AppHandle,
    state: State<'_, DbState>,
    workspace: String,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Row>, String> {
    with_conn(&app, &state, &workspace, |c| query(c, &sql, &params))
}

#[tauri::command]
pub async fn db_batch(
    app: AppHandle,
    state: State<'_, DbState>,
    workspace: String,
    statements: Vec<Statement>,
) -> Result<(), String> {
    with_conn(&app, &state, &workspace, |c| batch(c, &statements))
}

/// Closes a Workspace's connection, for example when the Device is revoked and the Cache dropped.
#[tauri::command]
pub async fn db_close(state: State<'_, DbState>, workspace: String) -> Result<(), String> {
    let mut conns = state.conns.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = conns.remove(&workspace) {
        conn.close().map_err(|(_, e)| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn memory() -> Connection {
        open_at(Path::new(":memory:"), None).expect("open")
    }

    #[test]
    fn exec_query_round_trip_json_types() {
        let conn = memory();
        exec(&conn, "create table t (id integer primary key, name text, flag integer, score real, meta text)", &[])
            .unwrap();
        let n = exec(
            &conn,
            "insert into t (name, flag, score, meta) values (?, ?, ?, ?)",
            &[json!("aoife"), json!(true), json!(1.5), json!({"a": [1, 2]})],
        )
        .unwrap();
        assert_eq!(n, 1);
        let rows = query(&conn, "select * from t where name = ?", &[json!("aoife")]).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row["id"], json!(1));
        assert_eq!(row["name"], json!("aoife"));
        assert_eq!(row["flag"], json!(1));
        assert_eq!(row["score"], json!(1.5));
        assert_eq!(row["meta"], json!("{\"a\":[1,2]}"));
        let none = query(&conn, "select * from t where name = ?", &[json!("nobody")]).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn batch_is_one_transaction() {
        let mut conn = memory();
        exec(&conn, "create table t (id integer primary key)", &[]).unwrap();
        let err = batch(
            &mut conn,
            &[
                Statement { sql: "insert into t (id) values (?)".into(), params: vec![json!(1)] },
                Statement { sql: "insert into t (id) values (?)".into(), params: vec![json!(1)] },
            ],
        );
        assert!(err.is_err());
        let rows = query(&conn, "select count(*) as n from t", &[]).unwrap();
        assert_eq!(rows[0]["n"], json!(0));

        batch(
            &mut conn,
            &[
                Statement { sql: "insert into t (id) values (?)".into(), params: vec![json!(1)] },
                Statement { sql: "insert into t (id) values (?)".into(), params: vec![json!(2)] },
            ],
        )
        .unwrap();
        let rows = query(&conn, "select count(*) as n from t", &[]).unwrap();
        assert_eq!(rows[0]["n"], json!(2));
    }

    #[test]
    fn exec_runs_multi_statement_schema_text() {
        let conn = memory();
        exec(&conn, "create table a (x); create table b (y); insert into a values (1);", &[]).unwrap();
        let rows = query(&conn, "select x from a", &[]).unwrap();
        assert_eq!(rows[0]["x"], json!(1));
    }

    #[test]
    fn fts5_is_compiled_in() {
        let conn = memory();
        exec(&conn, "create virtual table idx using fts5(subject, participants)", &[]).unwrap();
        exec(
            &conn,
            "insert into idx (subject, participants) values (?, ?)",
            &[json!("Term sheet redline"), json!("kenji@example.test")],
        )
        .unwrap();
        let rows = query(&conn, "select subject from idx where idx match ?", &[json!("redline")]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["subject"], json!("Term sheet redline"));
    }

    #[test]
    fn file_database_uses_wal() {
        let dir = std::env::temp_dir().join(format!("monday-db-test-{}", std::process::id()));
        let path = dir.join("cache").join("ws.sqlite");
        let conn = open_at(&path, None).unwrap();
        let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn file_database_is_encrypted_with_the_key() {
        let dir = std::env::temp_dir().join(format!("monday-db-enc-test-{}", std::process::id()));
        let path = dir.join("enc.sqlite");
        let key = [7u8; 32];
        {
            let conn = open_at(&path, Some(&key)).unwrap();
            exec(&conn, "create table t (name text)", &[]).unwrap();
            exec(&conn, "insert into t values (?)", &[json!("plaintextmarkerzzz")]).unwrap();
            // Flush the WAL so the main file holds the page.
            conn.pragma_update(None, "wal_checkpoint", "TRUNCATE").unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.starts_with(b"SQLite format 3"), "header must not be plaintext");
        assert!(!bytes.windows(18).any(|w| w == b"plaintextmarkerzzz"));
        assert!(open_at(&path, Some(&[9u8; 32])).is_err(), "a wrong key must not open it");
        let again = open_at(&path, Some(&key)).unwrap();
        let rows = query(&again, "select name from t", &[]).unwrap();
        assert_eq!(rows[0]["name"], json!("plaintextmarkerzzz"));
        drop(again);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(decode_hex("00ff10"), Some(vec![0, 255, 16]));
        assert_eq!(encode_hex(&[0, 255, 16]), "00ff10");
        assert_eq!(decode_hex("0"), None);
        assert_eq!(decode_hex("zz"), None);
    }

    #[test]
    fn workspace_ids_are_safe_file_names() {
        assert_eq!(cache_file_name("ws-genai").unwrap(), "ws-genai.sqlite");
        assert!(cache_file_name("../etc").is_err());
        assert!(cache_file_name("").is_err());
        assert!(cache_file_name("a/b").is_err());
    }
}
