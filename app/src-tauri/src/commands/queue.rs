use crate::db::Db;
use crate::queue_manager::{self, QueueManager};
use rusqlite::params;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub clip_id: String,
    pub account_id: String,
    pub account_name: String,
    pub platform: String,
    pub status: String,
    pub progress: i64,
    pub retry_count: i64,
    pub error_message: Option<String>,
    pub platform_post_id: Option<String>,
    pub clip_output_path: Option<String>,
    pub clip_final_output_path: Option<String>,
    pub scheduled_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
}

const SELECT_QUEUE_ITEM: &str = "
    SELECT
        q.id, q.clip_id, q.account_id, a.account_name, a.platform,
        q.status, q.progress, q.retry_count, q.error_message, q.platform_post_id,
        c.output_path AS clip_output_path, c.final_output_path AS clip_final_output_path,
        q.scheduled_at, q.completed_at, q.created_at
    FROM upload_queue q
    JOIN accounts a ON a.id = q.account_id
    JOIN clips c ON c.id = q.clip_id
";

fn row_to_queue_item(row: &rusqlite::Row) -> rusqlite::Result<QueueItem> {
    Ok(QueueItem {
        id: row.get("id")?,
        clip_id: row.get("clip_id")?,
        account_id: row.get("account_id")?,
        account_name: row.get("account_name")?,
        platform: row.get("platform")?,
        status: row.get("status")?,
        progress: row.get("progress")?,
        retry_count: row.get("retry_count")?,
        error_message: row.get("error_message")?,
        platform_post_id: row.get("platform_post_id")?,
        clip_output_path: row.get("clip_output_path")?,
        clip_final_output_path: row.get("clip_final_output_path")?,
        scheduled_at: row.get("scheduled_at")?,
        completed_at: row.get("completed_at")?,
        created_at: row.get("created_at")?,
    })
}

#[tauri::command]
pub async fn add_to_queue(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    clip_id: String,
    account_ids: Vec<String>,
) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for account_id in &account_ids {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO upload_queue (id, clip_id, account_id) VALUES (?1, ?2, ?3)",
                params![id, clip_id, account_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    queue_manager::kick(app);
    Ok(())
}

#[tauri::command]
pub async fn get_queue(db: tauri::State<'_, Db>) -> Result<Vec<QueueItem>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sql = format!("{SELECT_QUEUE_ITEM} ORDER BY q.created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_queue_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn get_queue_for_account(
    db: tauri::State<'_, Db>,
    account_id: String,
) -> Result<Vec<QueueItem>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sql = format!("{SELECT_QUEUE_ITEM} WHERE q.account_id = ?1 ORDER BY q.created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id], row_to_queue_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn pause_queue(app: AppHandle, manager: tauri::State<'_, QueueManager>) -> Result<(), String> {
    manager.paused.store(true, Ordering::Relaxed);
    let _ = app.emit("queue_paused", ());
    Ok(())
}

#[tauri::command]
pub async fn resume_queue(app: AppHandle, manager: tauri::State<'_, QueueManager>) -> Result<(), String> {
    manager.paused.store(false, Ordering::Relaxed);
    let _ = app.emit("queue_resumed", ());
    queue_manager::kick(app.clone());
    Ok(())
}

#[tauri::command]
pub async fn retry_queue_item(app: AppHandle, db: tauri::State<'_, Db>, item_id: String) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE upload_queue SET status = 'queued', retry_count = retry_count + 1, error_message = NULL, progress = 0 WHERE id = ?1",
            params![item_id],
        )
        .map_err(|e| e.to_string())?;
    }
    queue_manager::kick(app);
    Ok(())
}

/// Re-queues every item that failed specifically because it couldn't reach the platform
/// (see `queue_manager::OFFLINE_ERROR_PREFIX`) — called from the frontend when the browser's
/// `online` event fires, so uploads that only failed because the connection was down resume
/// on their own instead of sitting there until the user notices and clicks Retry. Items that
/// failed for a real reason (the platform itself rejecting the post) are untouched.
#[tauri::command]
pub async fn retry_offline_failures(app: AppHandle, db: tauri::State<'_, Db>) -> Result<u32, String> {
    let like_pattern = format!("{}%", queue_manager::OFFLINE_ERROR_PREFIX);
    let updated = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE upload_queue SET status = 'queued', retry_count = retry_count + 1, error_message = NULL, progress = 0
             WHERE status = 'failed' AND error_message LIKE ?1",
            params![like_pattern],
        )
        .map_err(|e| e.to_string())?
    };
    if updated > 0 {
        queue_manager::kick(app);
    }
    Ok(updated as u32)
}

#[tauri::command]
pub async fn remove_queue_item(db: tauri::State<'_, Db>, item_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM upload_queue WHERE id = ?1", params![item_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn clear_completed_queue(db: tauri::State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM upload_queue WHERE status = 'completed'", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
