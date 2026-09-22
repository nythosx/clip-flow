use crate::db::Db;
use crate::queue_manager::{self, QueueManager};
use rusqlite::params;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

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
    pub finished_at: Option<String>,
    pub created_at: String,
    pub title: String,
    pub hashtags: Vec<String>,
    pub kind: String,
    pub part_number: i64,
    pub clip_rendering: bool,
    pub block_reason: Option<String>,
}

const SELECT_QUEUE_ITEM: &str = "
    SELECT
        q.id, q.clip_id, q.account_id, a.account_name, a.platform,
        q.status, q.progress, q.retry_count, q.error_message, q.platform_post_id,
        c.output_path AS clip_output_path, c.final_output_path AS clip_final_output_path,
        q.scheduled_at, q.completed_at, q.finished_at, q.created_at,
        p.name AS project_name, c.hashtags AS clip_hashtags, p.trending_hashtags AS trending_hashtags,
        c.kind AS clip_kind,
        (SELECT COUNT(*) + 1 FROM clips c2
         WHERE c2.project_id = c.project_id AND c2.kind = c.kind AND c2.start_seconds < c.start_seconds) AS part_number,
        EXISTS (
            SELECT 1 FROM render_queue r WHERE r.clip_id = c.id AND r.status IN ('queued', 'rendering')
        ) AS clip_rendering
    FROM upload_queue q
    JOIN accounts a ON a.id = q.account_id
    JOIN clips c ON c.id = q.clip_id
    JOIN projects p ON p.id = c.project_id
";

fn row_to_queue_item(row: &rusqlite::Row) -> rusqlite::Result<QueueItem> {
    let clip_hashtags: String = row.get("clip_hashtags")?;
    let trending_hashtags: String = row.get("trending_hashtags")?;
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
        finished_at: row.get("finished_at")?,
        created_at: row.get("created_at")?,
        title: row.get("project_name")?,
        hashtags: crate::queue_manager::dedupe_hashtags(&clip_hashtags, &trending_hashtags),
        kind: row.get("clip_kind")?,
        part_number: row.get("part_number")?,
        clip_rendering: row.get("clip_rendering")?,
        block_reason: None,
    })
}

fn compute_block_reason(conn: &rusqlite::Connection, item: &mut QueueItem) {
    if item.status != "queued" {
        return;
    }

    let (min_interval, max_per_24h) = queue_manager::get_rate_limit_settings(conn);

    if let Some(sched) = &item.scheduled_at {
        let is_future: i64 = conn
            .query_row(
                "SELECT CASE WHEN ?1 > datetime('now') THEN 1 ELSE 0 END",
                params![sched],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if is_future == 1 {
            let remaining: i64 = conn
                .query_row(
                    "SELECT CAST((julianday(?1) - julianday('now')) * 86400 AS INTEGER)",
                    params![sched],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let r = remaining.max(0);
            item.block_reason = Some(format!(
                "TikTok rate-limited — retrying in {}h {}m",
                r / 3600,
                (r % 3600) / 60
            ));
            return;
        }
    }

    if item.clip_rendering {
        item.block_reason = Some("Rendering clip…".to_string());
        return;
    }

    let has_final = item.clip_final_output_path.is_some();
    let has_preview = item.clip_output_path.is_some();
    if !has_final && !has_preview {
        item.block_reason = Some("Waiting for render to finish".to_string());
        return;
    }

    let blocked_by_predecessor: Option<(String, i64)> = conn
        .query_row(
            "SELECT c2.kind,
                    (SELECT COUNT(*) + 1 FROM clips c2b
                     WHERE c2b.project_id = c2.project_id AND c2b.kind = c2.kind
                       AND c2b.start_seconds < c2.start_seconds) AS pnum
             FROM clips c_self
             JOIN clips c2 ON c2.project_id = c_self.project_id
                          AND c2.kind = c_self.kind
                          AND c2.start_seconds < c_self.start_seconds
             JOIN upload_queue q3 ON q3.clip_id = c2.id
             WHERE c_self.id = ?1
               AND q3.account_id = ?2
               AND q3.status != 'completed'
               AND q3.platform_post_id IS NULL
               AND q3.created_at > datetime('now', '-6 hours')
             ORDER BY c2.start_seconds ASC
             LIMIT 1",
            params![item.clip_id, item.account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    if let Some((kind, pnum)) = blocked_by_predecessor {
        let label = if kind == "part" {
            format!("Waiting for Part {pnum} to finish uploading")
        } else {
            format!("Waiting for earlier clip (slot {pnum}) to finish uploading")
        };
        item.block_reason = Some(label);
        return;
    }

    let count_24h: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM upload_queue
             WHERE account_id = ?1 AND status = 'completed'
               AND completed_at > datetime('now', '-24 hours')",
            params![item.account_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if count_24h >= max_per_24h as i64 {
        let last: Option<String> = conn
            .query_row(
                "SELECT MIN(completed_at) FROM upload_queue
                 WHERE account_id = ?1 AND status = 'completed'
                   AND completed_at > datetime('now', '-24 hours')",
                params![item.account_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        let wait_text = if let Some(ts) = last {
            let secs: i64 = conn
                .query_row(
                    "SELECT CAST((julianday(?1, '+24 hours') - julianday('now')) * 86400 AS INTEGER)",
                    params![ts],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let s = secs.max(0);
            format!(" — resets in {}h {}m", s / 3600, (s % 3600) / 60)
        } else {
            String::new()
        };
        item.block_reason = Some(format!(
            "Account daily limit reached ({}/{}){}",
            count_24h, max_per_24h, wait_text
        ));
        return;
    }

    let last_completed: Option<String> = conn
        .query_row(
            "SELECT MAX(completed_at) FROM upload_queue
             WHERE account_id = ?1 AND status = 'completed'",
            params![item.account_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    if let Some(last) = last_completed {
        let secs_since: i64 = conn
            .query_row(
                "SELECT CAST((julianday('now') - julianday(?1)) * 86400 AS INTEGER)",
                params![last],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let elapsed = secs_since.max(0) as u64;
        if elapsed < min_interval {
            let remaining = min_interval - elapsed;
            item.block_reason = Some(format!(
                "Cooldown — next upload in {}m {}s",
                remaining / 60,
                remaining % 60
            ));
            return;
        }
    }

    let is_earliest: i64 = conn
        .query_row(
            "SELECT CASE WHEN ?1 = (
                SELECT MIN(q2.created_at) FROM upload_queue q2
                WHERE q2.account_id = ?2 AND q2.status = 'queued'
                  AND (q2.scheduled_at IS NULL OR q2.scheduled_at <= datetime('now'))
             ) THEN 1 ELSE 0 END",
            params![item.created_at, item.account_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if is_earliest == 0 {
        item.block_reason = Some("Waiting for earlier queued item on this account".to_string());
        return;
    }

    item.block_reason = Some("Ready — starting shortly".to_string());
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
pub async fn queue_and_render(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    clip_id: String,
    account_ids: Vec<String>,
    template_id: Option<String>,
) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for account_id in &account_ids {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO upload_queue (id, clip_id, account_id, required_template_id) VALUES (?1, ?2, ?3, ?4)",
                params![id, clip_id, account_id, template_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    match template_id {
        Some(template_id) => {
            let job_id = crate::render_manager::insert_job(&app, &clip_id, "final", Some(&template_id))?;
            let app2 = app.clone();
            let clip_id2 = clip_id.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::commands::render::run_final_render_job(app2, clip_id2, template_id, job_id).await;
            });
        }
        None => queue_manager::kick(app),
    }
    Ok(())
}

#[tauri::command]
pub async fn get_queue(db: tauri::State<'_, Db>) -> Result<Vec<QueueItem>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sql = format!("{SELECT_QUEUE_ITEM} ORDER BY q.created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([], row_to_queue_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for item in rows.iter_mut() {
        compute_block_reason(&conn, item);
    }
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
    let mut rows = stmt
        .query_map(params![account_id], row_to_queue_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for item in rows.iter_mut() {
        compute_block_reason(&conn, item);
    }
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
    let (clip_id, required_template_id, final_output_path): (String, Option<String>, Option<String>) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT q.clip_id, q.required_template_id, c.final_output_path
             FROM upload_queue q JOIN clips c ON c.id = q.clip_id
             WHERE q.id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?
    };

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE upload_queue
             SET status = 'queued',
                 retry_count = retry_count + 1,
                 error_message = NULL,
                 progress = 0,
                 finished_at = NULL,
                 completed_at = NULL,
                 scheduled_at = NULL
             WHERE id = ?1",
            params![item_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let render_exists = final_output_path
        .as_deref()
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false);

    if render_exists {
        queue_manager::kick(app);
        return Ok(());
    }

    let template_id = match required_template_id {
        Some(t) => t,
        None => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT value FROM settings WHERE key = 'default_template_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "Cannot retry — the rendered file is missing and no template is set to re-render with. Set a default template in Settings.".to_string())?
        }
    };

    let already_rendering = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM render_queue WHERE clip_id = ?1 AND status IN ('queued', 'rendering')",
                params![clip_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        count > 0
    };

    if already_rendering {
        return Ok(());
    }

    let job_id = crate::render_manager::insert_job(&app, &clip_id, "final", Some(&template_id))?;
    let app2 = app.clone();
    let clip_id2 = clip_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::commands::render::run_final_render_job(app2, clip_id2, template_id, job_id).await;
    });
    Ok(())
}
#[tauri::command]
pub async fn retry_offline_failures(app: AppHandle, db: tauri::State<'_, Db>) -> Result<u32, String> {
    let like_pattern = format!("{}%", queue_manager::OFFLINE_ERROR_PREFIX);
    let updated = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE upload_queue SET status = 'queued', retry_count = retry_count + 1, error_message = NULL, progress = 0, finished_at = NULL, completed_at = NULL
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

#[tauri::command]
pub async fn clear_failed_queue(db: tauri::State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM upload_queue WHERE status = 'failed'", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDiagnostics {
    pub account_id: String,
    pub account_name: String,
    pub platform: String,
    pub uploads_last_24h: i64,
    pub max_uploads_per_24h: u64,
    pub min_interval_seconds: u64,
    pub last_completed_at: Option<String>,
    pub seconds_until_next: Option<u64>,
    pub reason: Option<String>,
    pub active_upload: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDiagnostics {
    pub queue_paused: bool,
    pub min_interval_seconds: u64,
    pub max_uploads_per_24h: u64,
    pub accounts: Vec<AccountDiagnostics>,
}

#[tauri::command]
pub async fn get_queue_diagnostics(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    manager: tauri::State<'_, QueueManager>,
) -> Result<QueueDiagnostics, String> {
    let (min_interval, max_per_24h, rows): (u64, u64, Vec<(String, String, String)>) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (min_interval, max_per_24h) = queue_manager::get_rate_limit_settings(&conn);
        let mut stmt = conn
            .prepare("SELECT id, account_name, platform FROM accounts")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        (min_interval, max_per_24h, rows)
    };

    let active_accounts = manager.active_account_ids();
    let queue_paused = manager.paused.load(std::sync::atomic::Ordering::Relaxed);

    let mut accounts: Vec<AccountDiagnostics> = Vec::new();
    for (account_id, account_name, platform) in rows {
        let (uploads_last_24h, last_completed_at): (i64, Option<String>) = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM upload_queue
                     WHERE account_id = ?1 AND status = 'completed'
                       AND completed_at > datetime('now', '-24 hours')",
                    params![account_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let last: Option<String> = conn
                .query_row(
                    "SELECT MAX(completed_at) FROM upload_queue
                     WHERE account_id = ?1 AND status = 'completed'",
                    params![account_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            (count, last)
        };

        let (seconds_until_next, reason) = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let wait = queue_manager::account_rate_limit_wait(&conn, &account_id);
            match wait {
                Some(secs) => {
                    let mut reason_str = None;
                    if uploads_last_24h >= max_per_24h as i64 {
                        reason_str = Some(format!("Daily cap: {}/{} uploads in last 24h", uploads_last_24h, max_per_24h));
                    } else {
                        reason_str = Some(format!("Cooldown: minimum {}s between uploads", min_interval));
                    }
                    (Some(secs), reason_str)
                }
                None => (None, None),
            }
        };

        let active_upload = active_accounts.contains(&account_id);

        accounts.push(AccountDiagnostics {
            account_id,
            account_name,
            platform,
            uploads_last_24h,
            max_uploads_per_24h: max_per_24h,
            min_interval_seconds: min_interval,
            last_completed_at,
            seconds_until_next,
            reason,
            active_upload,
        });
    }

    Ok(QueueDiagnostics {
        queue_paused,
        min_interval_seconds: min_interval,
        max_uploads_per_24h: max_per_24h,
        accounts,
    })
}

#[tauri::command]
pub fn download_queue_video(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    item_id: String,
) -> Result<Option<String>, String> {
    let (src_path, suggested_name): (String, String) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (final_path, preview_path, kind, project_name, part_number): (
            Option<String>,
            Option<String>,
            String,
            String,
            i64,
        ) = conn
            .query_row(
                "SELECT c.final_output_path, c.output_path, c.kind, p.name,
                        (SELECT COUNT(*) + 1 FROM clips c2
                         WHERE c2.project_id = c.project_id AND c2.kind = c.kind
                           AND c2.start_seconds < c.start_seconds)
                 FROM upload_queue q
                 JOIN clips c ON c.id = q.clip_id
                 JOIN projects p ON p.id = c.project_id
                 WHERE q.id = ?1",
                params![item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(|e| format!("Queue item not found: {e}"))?;

        let src = final_path
            .or(preview_path)
            .ok_or_else(|| "No rendered video available for this item yet".to_string())?;

        if !std::path::Path::new(&src).exists() {
            return Err("Rendered file no longer exists on disk — retry the render first".to_string());
        }

        let safe: String = project_name
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        let safe = safe
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let safe = if safe.is_empty() { "clip".to_string() } else { safe };

        let name = if kind == "part" {
            format!("{safe}-Part-{part_number}.mp4")
        } else {
            format!("{safe}.mp4")
        };

        (src, name)
    };

    let dialog_result = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("Video", &["mp4"])
        .blocking_save_file();

    let Some(target) = dialog_result else {
        return Ok(None);
    };

    let target_path: PathBuf = target
        .into_path()
        .map_err(|e| format!("Invalid save location: {e}"))?;

    std::fs::copy(&src_path, &target_path)
        .map_err(|e| format!("Failed to save video: {e}"))?;

    Ok(Some(target_path.to_string_lossy().to_string()))
}