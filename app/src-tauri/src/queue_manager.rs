// Upload queue processor (SPEC.md section 8). Drives entirely off the `upload_queue`
// table rather than keeping a separate in-memory job list — the rest of this app treats
// SQLite as the single source of truth (see db.rs), so mirroring that here avoids a
// memory/DB sync-bug class the SPEC's VecDeque sketch would otherwise introduce.
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
    /// account_ids with an upload currently in flight — enforces the SPEC's default of
    /// one concurrent upload per account.
    active_accounts: Arc<Mutex<HashSet<String>>>,
}

/// Prefixed onto an `upload_queue.error_message` when `run_job` determined the failure was
/// a connectivity problem (couldn't reach the platform at all) rather than the platform
/// actually rejecting the post. Lets the frontend's `retry_offline_failures` (fired on the
/// browser's `online` event) retry exactly these items and only these — a real rejection
/// (bad params, expired token, content policy) shouldn't get silently re-tried just because
/// the network blipped back.
pub const OFFLINE_ERROR_PREFIX: &str = "No internet connection — ";

/// Best-effort classification of a `reqwest`-originated error string as "never reached the
/// server" rather than "server responded but rejected the request". Matched by substring
/// since the error is already flattened to a `String` by the time it reaches `run_job` (see
/// each platform module's liberal `.map_err(|e| e.to_string())`) — reqwest's own error
/// messages for connection-level failures consistently mention one of these, across DNS
/// failures, refused/unreachable connections, and timeouts.
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

/// Looks for eligible queued jobs and spawns them. Safe to call repeatedly — it's a no-op
/// once every account either has an active upload or no queued work.
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
            "SELECT id, account_id, clip_id FROM upload_queue WHERE status = 'queued' ORDER BY created_at ASC",
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

    // Claim one queued item per idle account (one concurrent upload per account), then
    // drop the lock before spawning so it isn't held across an await point.
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
        // YouTube upload automation isn't built yet (SPEC section 13, deliberately
        // deferred) — keep the old simulated-progress stub for that platform only.
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
            // Tag connectivity failures distinctly (rather than a platform actually
            // rejecting the post) so the frontend can auto-retry just these once it sees
            // the connection come back — see `retry_offline_failures` / OFFLINE_ERROR_PREFIX.
            let message = if is_connectivity_error(&e) { format!("{OFFLINE_ERROR_PREFIX}{e}") } else { e };
            set_failed(&app, &item_id, &message);
            emit_progress(&app, &item_id, &account_id, 0, "failed");
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

/// Runs the real Content Posting API flow: refreshes the token if expired, uploads the
/// clip's rendered video, polls until TikTok finishes processing it, and records the
/// resulting `publish_id` as this item's `platform_post_id`.
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

    emit_progress(app, item_id, account_id, 15, "uploading");
    let init = tiktok_api::init_video_publish(&creds.access_token, &PathBuf::from(&video_path), &title).await?;

    emit_progress(app, item_id, account_id, 30, "uploading");
    tiktok_api::upload_video(&init.upload_url, &PathBuf::from(&video_path), init.video_size, init.chunk_size).await?;
    set_progress(app, item_id, 70);
    emit_progress(app, item_id, account_id, 70, "uploading");

    // TikTok processes the upload asynchronously — poll until it lands on a terminal
    // status. 30 attempts * 2s covers TikTok's typical processing time for short clips;
    // if it's still not done by then, surface a timeout rather than hanging the queue.
    for attempt in 0..30 {
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

/// Publishes the clip's rendered video to a connected Facebook Page, or (where Meta App
/// Review has granted it — see facebook_api.rs) the user's own timeline. Facebook Page
/// tokens derived from a long-lived user token don't expire the way TikTok's do, so unlike
/// `run_tiktok_job` there's no refresh step here — just a single multipart upload, which
/// Facebook processes synchronously enough that the returned video id is usable immediately
/// as `platform_post_id`.
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

/// Builds the TikTok Content Posting API `title` (post caption) field: the project/movie
/// name followed by this clip's own hashtags plus the project's fetched trending hashtags
/// (deduped, clip-specific ones first). Deliberately NOT the same text as `ai_caption` —
/// that's already burned into the video frame by `render_clip_final`, so reusing it here
/// made the posted caption redundant with the on-screen one. `hashtags_json`/`trending_json`
/// are `clips.hashtags`/`projects.trending_hashtags`, JSON arrays of "#tag" strings that
/// silently do nothing if unparseable (a clip/project predating either column, or containing
/// malformed JSON, should still post — just without hashtags — rather than fail the upload).
fn build_tiktok_title(project_name: &str, hashtags_json: &str, trending_json: &str) -> String {
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
        ", completed_at = datetime('now')"
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

fn set_failed(app: &AppHandle, id: &str, error: &str) {
    let db = app.state::<Db>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = conn.execute(
        "UPDATE upload_queue SET status = 'failed', error_message = ?1 WHERE id = ?2",
        params![error, id],
    );
}
