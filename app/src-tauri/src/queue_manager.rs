use crate::db::Db;
use crate::facebook_api;
use crate::tiktok_api;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct QueueManager {
    pub paused: Arc<AtomicBool>,
    active_accounts: Arc<Mutex<HashSet<String>>>,
    tiktok_gate: Arc<tokio::sync::Mutex<Option<std::time::Instant>>>,
}

const TIKTOK_MIN_CALL_INTERVAL: Duration = Duration::from_millis(1500);

pub const DEFAULT_MIN_UPLOAD_INTERVAL_SECONDS: u64 = 15 * 60;
pub const DEFAULT_MAX_UPLOADS_PER_24H: u64 = 15;

pub fn get_rate_limit_settings(conn: &rusqlite::Connection) -> (u64, u64) {
    let get = |key: &str, default: u64| -> u64 {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(default)
    };
    (
        get("queue_min_upload_interval_seconds", DEFAULT_MIN_UPLOAD_INTERVAL_SECONDS),
        get("queue_max_uploads_per_24h", DEFAULT_MAX_UPLOADS_PER_24H),
    )
}

impl QueueManager {
    pub fn active_account_ids(&self) -> Vec<String> {
        self.active_accounts
            .lock()
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }
}

async fn wait_tiktok_slot(manager: &QueueManager) {
    let mut next_slot = manager.tiktok_gate.lock().await;
    let now = std::time::Instant::now();
    if let Some(slot) = *next_slot {
        if slot > now {
            tokio::time::sleep(slot - now).await;
        }
    }
    *next_slot = Some(std::time::Instant::now() + TIKTOK_MIN_CALL_INTERVAL);
}

pub const OFFLINE_ERROR_PREFIX: &str = "No internet connection — ";

pub fn account_rate_limit_wait(conn: &rusqlite::Connection, account_id: &str) -> Option<u64> {
    let (min_interval, max_per_24h) = get_rate_limit_settings(conn);
    let count_24h: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM upload_queue
             WHERE account_id = ?1 AND status = 'completed'
               AND completed_at > datetime('now', '-24 hours')",
            params![account_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if count_24h >= max_per_24h as i64 {
        let oldest: Option<String> = conn
            .query_row(
                "SELECT MIN(completed_at) FROM upload_queue
                 WHERE account_id = ?1 AND status = 'completed'
                   AND completed_at > datetime('now', '-24 hours')",
                params![account_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        if let Some(ts) = oldest {
            let secs_left: i64 = conn
                .query_row(
                    "SELECT CAST((julianday(?1, '+24 hours') - julianday('now')) * 86400 AS INTEGER)",
                    params![ts],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            return Some(secs_left.max(1) as u64);
        }
        return Some(24 * 60 * 60);
    }

    let last_completed: Option<String> = conn
        .query_row(
            "SELECT MAX(completed_at) FROM upload_queue
             WHERE account_id = ?1 AND status = 'completed'",
            params![account_id],
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
            return Some(min_interval - elapsed);
        }
    }

    None
}

fn is_connectivity_error(message: &str) -> bool {
    let m = message.to_lowercase();
    [
        "error sending request",
        "error trying to connect",
        "dns error",
        "tcp connect error",
        "connection refused",
        "network is unreachable",
        "could not connect",
        "operation timed out",
        "timed out",
        "no such host is known",
        "name or service not known",
    ]
    .iter()
    .any(|needle| m.contains(needle))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProgressEvent {
    id: String,
    account_id: String,
    progress: i64,
    status: String,
}

pub fn kick(app: AppHandle) {
    let manager = app.state::<QueueManager>();
    if manager.paused.load(Ordering::Relaxed) {
        return;
    }

    let candidates: Vec<(String, String, String)> = {
        let db = app.state::<Db>();
        let conn = match db.0.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut stmt = match conn.prepare(
            "SELECT q.id, q.account_id, q.clip_id FROM upload_queue q
             JOIN clips c ON c.id = q.clip_id
             WHERE q.status = 'queued' AND (q.scheduled_at IS NULL OR q.scheduled_at <= datetime('now'))
               AND (
                 CASE WHEN q.required_template_id IS NOT NULL
                      THEN c.final_output_path IS NOT NULL
                      ELSE (c.final_output_path IS NOT NULL OR c.output_path IS NOT NULL)
                 END
               )
               AND NOT EXISTS (
                 SELECT 1 FROM render_queue r
                 WHERE r.clip_id = c.id AND r.status IN ('queued', 'rendering')
               )
               AND q.created_at = (
                 SELECT MIN(q2.created_at) FROM upload_queue q2
                 WHERE q2.account_id = q.account_id AND q2.status = 'queued'
                   AND (q2.scheduled_at IS NULL OR q2.scheduled_at <= datetime('now'))
               )
               AND NOT EXISTS (
                 SELECT 1 FROM clips c2
                 JOIN upload_queue q3 ON q3.clip_id = c2.id
                 WHERE c2.project_id = c.project_id
                   AND c2.kind = c.kind
                   AND c2.start_seconds < c.start_seconds
                   AND q3.account_id = q.account_id
                   AND q3.status != 'completed'
                   AND q3.platform_post_id IS NULL
                   AND q3.created_at > datetime('now', '-6 hours')
               )
             ORDER BY q.created_at ASC",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        });
        match rows {
            Ok(r) => r.filter_map(|x| x.ok()).collect(),
            Err(_) => return,
        }
    };

    let db = app.state::<Db>();
    let rate_limited_accounts: HashSet<String> = {
        let guard = match db.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let mut set = HashSet::new();
        for (_, account_id, _) in &candidates {
            if set.contains(account_id) {
                continue;
            }
            if let Some(secs) = account_rate_limit_wait(&guard, account_id) {
                log::info!(
                    "[queue_manager] account {account_id} is rate-limited — cooldown {secs}s remaining, skipping dispatch"
                );
                set.insert(account_id.clone());
            }
        }
        set
    };

    let mut to_spawn = Vec::new();
    {
        let mut active = match manager.active_accounts.lock() {
            Ok(a) => a,
            Err(_) => return,
        };
        for (item_id, account_id, clip_id) in candidates {
            if active.contains(&account_id) {
                continue;
            }
            if rate_limited_accounts.contains(&account_id) {
                continue;
            }
            active.insert(account_id.clone());
            to_spawn.push((item_id, account_id, clip_id));
        }
    }

    for (item_id, account_id, clip_id) in to_spawn {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_job(app, item_id, account_id, clip_id).await;
        });
    }
}

async fn run_job(app: AppHandle, item_id: String, account_id: String, clip_id: String) {
    set_status(&app, &item_id, "uploading", 0);
    emit_progress(&app, &item_id, &account_id, 0, "uploading");

    let platform = {
        let db = app.state::<Db>();
        let conn = db.0.lock().ok();
        conn.and_then(|c| {
            c.query_row("SELECT platform FROM accounts WHERE id = ?1", params![account_id], |row| {
                row.get::<_, String>(0)
            })
            .ok()
        })
    };

    let result = match platform.as_deref() {
        Some("tiktok") => run_tiktok_job(&app, &item_id, &account_id, &clip_id).await,
        Some("facebook") => run_facebook_job(&app, &item_id, &account_id, &clip_id).await,
        _ => {
            for pct in [33, 66, 100] {
                tokio::time::sleep(Duration::from_millis(700)).await;
                set_progress(&app, &item_id, pct);
                emit_progress(&app, &item_id, &account_id, pct, "uploading");
            }
            Ok(())
        }
    };

    match result {
        Ok(()) => {
            set_status(&app, &item_id, "completed", 100);
            emit_progress(&app, &item_id, &account_id, 100, "completed");
        }
        Err(e) => {
            log::error!("[queue_manager] job {item_id} failed for account {account_id} (clip {clip_id}): {e}");
            if let Some((retry_after, human)) = parse_rate_limit(&e) {
                let rescheduled = schedule_rate_limit_retry(&app, &item_id, retry_after, &human);
                emit_progress(&app, &item_id, &account_id, 0, if rescheduled { "queued" } else { "failed" });
            } else {
                let message = if is_connectivity_error(&e) {
                    format!("{OFFLINE_ERROR_PREFIX}{e}")
                } else if e.trim().is_empty() {
                    "Upload failed (no error details captured — check terminal logs)".to_string()
                } else {
                    e
                };
                set_failed(&app, &item_id, &message);
                emit_progress(&app, &item_id, &account_id, 0, "failed");
            }
        }
    }

    let manager = app.state::<QueueManager>();
    if let Ok(mut active) = manager.active_accounts.lock() {
        active.remove(&account_id);
    }

    kick(app);
}

#[derive(serde::Deserialize, serde::Serialize)]
struct TikTokCredentials {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    #[serde(rename = "openId")]
    open_id: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

async fn run_tiktok_job(app: &AppHandle, item_id: &str, account_id: &str, clip_id: &str) -> Result<(), String> {
    let (client_key, client_secret, mut creds) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let get_setting = |key: &str| -> Result<String, String> {
            conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get::<_, String>(0))
                .map_err(|_| format!("missing setting {key} — add TikTok app credentials in Settings"))
        };
        let client_key = get_setting("tiktok_client_key")?;
        let client_secret = get_setting("tiktok_client_secret")?;
        let credentials_json: String = conn
            .query_row("SELECT credentials_json FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let creds: TikTokCredentials = serde_json::from_str(&credentials_json).map_err(|e| e.to_string())?;
        (client_key, client_secret, creds)
    };

    let expires_at = chrono::DateTime::parse_from_rfc3339(&creds.expires_at).map_err(|e| e.to_string())?;
    if expires_at < chrono::Utc::now() {
        let refreshed = tiktok_api::refresh_token(&client_key, &client_secret, &creds.refresh_token).await?;
        creds = TikTokCredentials {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token,
            open_id: refreshed.open_id,
            expires_at: (chrono::Utc::now() + chrono::Duration::seconds(refreshed.expires_in)).to_rfc3339(),
        };
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET credentials_json = ?1 WHERE id = ?2",
            params![serde_json::to_string(&creds).map_err(|e| e.to_string())?, account_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let (video_path, title) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (output_path, final_output_path, hashtags_json, project_name, trending_json): (
            Option<String>,
            Option<String>,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT c.output_path, c.final_output_path, c.hashtags, p.name, p.trending_hashtags
                 FROM clips c JOIN projects p ON p.id = c.project_id WHERE c.id = ?1",
                params![clip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(|e| e.to_string())?;
        let path = final_output_path
            .or(output_path)
            .ok_or("clip has no rendered video — render it before queuing for upload")?;
        (path, build_tiktok_title(&project_name, &hashtags_json, &trending_json))
    };

    let manager = app.state::<QueueManager>();

    emit_progress(app, item_id, account_id, 15, "uploading");
    wait_tiktok_slot(&manager).await;
    let init = tiktok_api::init_video_publish(&creds.access_token, &PathBuf::from(&video_path), &title).await?;

    emit_progress(app, item_id, account_id, 30, "uploading");
    tiktok_api::upload_video(
        &init.upload_url,
        &PathBuf::from(&video_path),
        init.video_size,
        init.chunk_size,
        init.total_chunk_count,
    )
    .await?;
    set_progress(app, item_id, 70);
    emit_progress(app, item_id, account_id, 70, "uploading");

    for attempt in 0..30 {
        wait_tiktok_slot(&manager).await;
        match tiktok_api::fetch_publish_status(&creds.access_token, &init.publish_id).await? {
            tiktok_api::PublishStatus::Complete => {
                let db = app.state::<Db>();
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE upload_queue SET platform_post_id = ?1 WHERE id = ?2",
                    params![init.publish_id, item_id],
                )
                .map_err(|e| e.to_string())?;
                return Ok(());
            }
            tiktok_api::PublishStatus::Failed(reason) => return Err(format!("TikTok publish failed: {reason}")),
            tiktok_api::PublishStatus::Processing => {
                let pct = 70 + (attempt * 30 / 30).min(29);
                set_progress(app, item_id, pct);
                emit_progress(app, item_id, account_id, pct, "uploading");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    Err("timed out waiting for TikTok to finish processing the upload".to_string())
}

#[derive(serde::Deserialize)]
struct FacebookCredentials {
    #[serde(rename = "fbId")]
    fb_id: String,
    #[serde(rename = "accountType")]
    account_type: String,
    #[serde(rename = "accessToken")]
    access_token: String,
}

async fn run_facebook_job(app: &AppHandle, item_id: &str, account_id: &str, clip_id: &str) -> Result<(), String> {
    let creds = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let credentials_json: String = conn
            .query_row("SELECT credentials_json FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        serde_json::from_str::<FacebookCredentials>(&credentials_json).map_err(|e| e.to_string())?
    };

    let (video_path, caption): (String, Option<String>) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (output_path, final_output_path, ai_caption): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT output_path, final_output_path, ai_caption FROM clips WHERE id = ?1",
                params![clip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        let path = final_output_path
            .or(output_path)
            .ok_or("clip has no rendered video — render it before queuing for upload")?;
        (path, ai_caption)
    };

    emit_progress(app, item_id, account_id, 30, "uploading");
    let target = if creds.account_type == "page" { creds.fb_id.as_str() } else { "me" };
    let post_id = facebook_api::publish_video(target, &creds.access_token, &PathBuf::from(&video_path), caption.as_deref().unwrap_or(""))
        .await?;
    set_progress(app, item_id, 90);
    emit_progress(app, item_id, account_id, 90, "uploading");

    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE upload_queue SET platform_post_id = ?1 WHERE id = ?2",
        params![post_id, item_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn dedupe_hashtags(hashtags_json: &str, trending_json: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut tags: Vec<String> = Vec::new();
    for json in [hashtags_json, trending_json] {
        let parsed: Vec<String> = serde_json::from_str(json).unwrap_or_default();
        for tag in parsed {
            if seen.insert(tag.clone()) {
                tags.push(tag);
            }
        }
    }
    tags
}

fn build_tiktok_title(project_name: &str, hashtags_json: &str, trending_json: &str) -> String {
    let tags = dedupe_hashtags(hashtags_json, trending_json);
    if tags.is_empty() {
        project_name.to_string()
    } else {
        format!("{project_name}\n\n{}", tags.join(" "))
    }
}

fn emit_progress(app: &AppHandle, id: &str, account_id: &str, progress: i64, status: &str) {
    let _ = app.emit(
        "upload_progress",
        UploadProgressEvent {
            id: id.to_string(),
            account_id: account_id.to_string(),
            progress,
            status: status.to_string(),
        },
    );
}

fn set_status(app: &AppHandle, id: &str, status: &str, progress: i64) {
    let db = app.state::<Db>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let completed_at_clause = if status == "completed" {
        ", completed_at = datetime('now'), finished_at = datetime('now')"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE upload_queue SET status = ?1, progress = ?2{} WHERE id = ?3",
        completed_at_clause
    );
    let _ = conn.execute(&sql, params![status, progress, id]);
}

fn set_progress(app: &AppHandle, id: &str, progress: i64) {
    let db = app.state::<Db>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = conn.execute(
        "UPDATE upload_queue SET progress = ?1 WHERE id = ?2",
        params![progress, id],
    );
}

fn parse_rate_limit(message: &str) -> Option<(u64, String)> {
    let rest = message.strip_prefix(tiktok_api::RATE_LIMIT_PREFIX)?;
    let (secs_str, human) = rest.split_once(':')?;
    let secs = secs_str.parse::<u64>().ok()?;
    Some((secs, human.to_string()))
}

const MAX_AUTO_RATE_LIMIT_RETRIES: i64 = 6;
const MAX_RATE_LIMIT_BACKOFF_SECONDS: u64 = 24 * 60 * 60;

fn schedule_rate_limit_retry(app: &AppHandle, id: &str, retry_after_seconds: u64, human_message: &str) -> bool {
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return false };
    let retry_count: i64 = conn
        .query_row("SELECT retry_count FROM upload_queue WHERE id = ?1", params![id], |row| row.get(0))
        .unwrap_or(0);

    if retry_count >= MAX_AUTO_RATE_LIMIT_RETRIES {
        let _ = conn.execute(
            "UPDATE upload_queue SET status = 'failed', error_message = ?1, finished_at = datetime('now') WHERE id = ?2",
            params![format!("TikTok kept rate-limiting this upload after {retry_count} automatic retries — {human_message}"), id],
        );
        return false;
    }

    let backoff = (retry_after_seconds.max(1) * 2u64.pow(retry_count.min(20) as u32)).min(MAX_RATE_LIMIT_BACKOFF_SECONDS);
    let modifier = format!("+{backoff} seconds");
    let note = format!("Rate-limited by TikTok — retrying automatically in ~{}s ({human_message})", backoff);
    let _ = conn.execute(
        "UPDATE upload_queue SET status = 'queued', retry_count = retry_count + 1, progress = 0,
         error_message = ?1, scheduled_at = datetime('now', ?2) WHERE id = ?3",
        params![note, modifier, id],
    );
    true
}

pub fn fail_rows_awaiting_render(app: &AppHandle, clip_id: &str, template_id: &str, error: &str) {
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return };
    let message = if error.trim().is_empty() {
        "Render failed (no error details captured — check terminal logs)".to_string()
    } else {
        format!("Render failed — {error}")
    };
    let _ = conn.execute(
        "UPDATE upload_queue SET status = 'failed', error_message = ?1, finished_at = datetime('now')
         WHERE clip_id = ?2 AND status = 'queued' AND (required_template_id = ?3 OR required_template_id IS NULL)",
        params![message, clip_id, template_id],
    );
}

fn set_failed(app: &AppHandle, id: &str, error: &str) {
    let db = app.state::<Db>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let message = if error.trim().is_empty() {
        "Upload failed (no error details captured — check terminal logs)".to_string()
    } else {
        error.to_string()
    };
    let _ = conn.execute(
        "UPDATE upload_queue SET status = 'failed', error_message = ?1, finished_at = datetime('now') WHERE id = ?2",
        params![message, id],
    );
}