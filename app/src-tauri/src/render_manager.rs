
use crate::db::Db;
use rusqlite::params;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

const MAX_CONCURRENT_RENDERS: usize = 5;

pub struct RenderManager {
    pub semaphore: Arc<Semaphore>,
}

impl Default for RenderManager {
    fn default() -> Self {
        Self { semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_RENDERS)) }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RenderQueueItem {
    pub id: String,
    pub clip_id: String,
    pub kind: String,
    pub template_id: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
}

pub fn insert_job(app: &AppHandle, clip_id: &str, kind: &str, template_id: Option<&str>) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO render_queue (id, clip_id, kind, template_id, status) VALUES (?1, ?2, ?3, ?4, 'queued')",
        params![id, clip_id, kind, template_id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    emit_update(app);
    Ok(id)
}

pub fn set_status(app: &AppHandle, id: &str, status: &str, error_message: Option<&str>) {
    let db = app.state::<Db>();
    if let Ok(conn) = db.0.lock() {
        let completed_clause = if status == "completed" || status == "failed" {
            ", completed_at = datetime('now')"
        } else {
            ""
        };
        let sql = format!("UPDATE render_queue SET status = ?1, error_message = ?2{completed_clause} WHERE id = ?3");
        let _ = conn.execute(&sql, params![status, error_message, id]);
    }
    emit_update(app);
}

fn emit_update(app: &AppHandle) {
    let _ = app.emit("render_queue_update", ());
}

pub fn get_queue(db: &Db) -> Result<Vec<RenderQueueItem>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, clip_id, kind, template_id, status, error_message, created_at
             FROM render_queue WHERE status IN ('queued', 'rendering') ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RenderQueueItem {
                id: row.get(0)?,
                clip_id: row.get(1)?,
                kind: row.get(2)?,
                template_id: row.get(3)?,
                status: row.get(4)?,
                error_message: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}
