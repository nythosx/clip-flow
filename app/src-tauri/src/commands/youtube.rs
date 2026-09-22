use crate::commands::account::Account;
use crate::db::Db;
use crate::youtube_api;
use rusqlite::params;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Default)]
pub struct YouTubeOAuthState(pub Mutex<Option<tokio::task::AbortHandle>>);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub video_id: String,
    pub title: String,
    pub thumbnail_url: String,

    pub status: String,
    pub percent: Option<f64>,
    pub message: String,
    pub project_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingAction {
    Pause,
    Cancel,
}

#[derive(Default)]
pub struct DownloadManager {
    records: Mutex<HashMap<String, DownloadRecord>>,
    pids: Mutex<HashMap<String, u32>>,
    pending_action: Mutex<HashMap<String, PendingAction>>,
}

fn update_record(app: &AppHandle, manager: &DownloadManager, video_id: &str, f: impl FnOnce(&mut DownloadRecord)) {
    let Ok(mut records) = manager.records.lock() else { return };
    let Some(record) = records.get_mut(video_id) else { return };
    f(record);
    let _ = app.emit("youtube_download_progress", record.clone());
}

fn set_pending(manager: &DownloadManager, video_id: &str, action: PendingAction) {
    if let Ok(mut m) = manager.pending_action.lock() {
        m.insert(video_id.to_string(), action);
    }
}

fn take_pending(manager: &DownloadManager, video_id: &str) -> Option<PendingAction> {
    manager.pending_action.lock().ok()?.remove(video_id)
}

fn set_pid(manager: &DownloadManager, video_id: &str, pid: Option<u32>) {
    let Ok(mut m) = manager.pids.lock() else { return };
    match pid {
        Some(p) => {
            m.insert(video_id.to_string(), p);
        }
        None => {
            m.remove(video_id);
        }
    }
}

fn get_pid(manager: &DownloadManager, video_id: &str) -> Option<u32> {
    manager.pids.lock().ok()?.get(video_id).copied()
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output();
    #[cfg(not(windows))]
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
}

fn video_download_path(app: &AppHandle, video_id: &str) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data_dir.join("youtube_downloads").join(format!("{video_id}.mp4")))
}

#[tauri::command]
pub async fn get_youtube_downloads(manager: tauri::State<'_, DownloadManager>) -> Result<Vec<DownloadRecord>, String> {
    Ok(manager.records.lock().map_err(|e| e.to_string())?.values().cloned().collect())
}

#[tauri::command]
pub async fn remove_youtube_download(manager: tauri::State<'_, DownloadManager>, video_id: String) -> Result<(), String> {
    manager.records.lock().map_err(|e| e.to_string())?.remove(&video_id);
    Ok(())
}

#[tauri::command]
pub async fn pause_youtube_download(manager: tauri::State<'_, DownloadManager>, video_id: String) -> Result<(), String> {
    set_pending(&manager, &video_id, PendingAction::Pause);
    if let Some(pid) = get_pid(&manager, &video_id) {
        kill_pid(pid);
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_youtube_download(
    app: AppHandle,
    manager: tauri::State<'_, DownloadManager>,
    video_id: String,
) -> Result<(), String> {
    set_pending(&manager, &video_id, PendingAction::Cancel);
    if let Some(pid) = get_pid(&manager, &video_id) {
        kill_pid(pid);
    } else {
        let video_path = video_download_path(&app, &video_id)?;
        let _ = std::fs::remove_file(&video_path);
        let _ = std::fs::remove_file(format!("{}.part", video_path.display()));
        update_record(&app, &manager, &video_id, |r| {
            r.status = "cancelled".to_string();
            r.message = "Cancelled".to_string();
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_youtube_download(
    app: AppHandle,
    manager: tauri::State<'_, DownloadManager>,
    video_id: String,
) -> Result<(), String> {
    {
        let mut records = manager.records.lock().map_err(|e| e.to_string())?;
        let record = records.get_mut(&video_id).ok_or("no such download")?;
        record.status = "downloading".to_string();
        record.message = "Resuming…".to_string();
        record.error = None;
    }
    manager.pending_action.lock().map_err(|e| e.to_string())?.remove(&video_id);
    tauri::async_runtime::spawn(run_download(app, video_id));
    Ok(())
}

#[tauri::command]
pub async fn start_youtube_download(
    app: AppHandle,
    manager: tauri::State<'_, DownloadManager>,
    video_id: String,
    title: String,
    thumbnail_url: String,
) -> Result<(), String> {
    {
        let mut records = manager.records.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = records.get(&video_id) {
            if matches!(existing.status.as_str(), "downloading" | "captions" | "creating_project") {
                return Ok(());
            }
        }
        records.insert(
            video_id.clone(),
            DownloadRecord {
                video_id: video_id.clone(),
                title,
                thumbnail_url,
                status: "downloading".to_string(),
                percent: Some(0.0),
                message: "Starting…".to_string(),
                project_id: None,
                error: None,
            },
        );
    }
    manager.pending_action.lock().map_err(|e| e.to_string())?.remove(&video_id);
    tauri::async_runtime::spawn(run_download(app, video_id));
    Ok(())
}

enum DownloadOutcome {
    Completed,
    Paused,
    Cancelled,
    Failed(String),
}

async fn run_ytdlp_process(app: &AppHandle, manager: &DownloadManager, video_id: &str, video_path: &Path) -> DownloadOutcome {
    update_record(app, manager, video_id, |r| {
        r.status = "downloading".to_string();
        r.message = "Starting download…".to_string();
    });
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut child = match tokio::process::Command::new("yt-dlp")
        .args([
            "-f",
            "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
            "--merge-output-format",
            "mp4",
            "--newline",
            "-o",
        ])
        .arg(video_path)
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return DownloadOutcome::Failed(format!("failed to run yt-dlp: {e}")),
    };

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_lines: Arc<tokio::sync::Mutex<Vec<String>>> = Arc::new(tokio::sync::Mutex::new(Vec::new()));

    let progress_task = {
        let app = app.clone();
        let video_id = video_id.to_string();
        tokio::spawn(async move {
            let manager = app.state::<DownloadManager>();
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(percent) = parse_ytdlp_percent(&line) {
                    update_record(&app, &manager, &video_id, |r| {
                        r.percent = Some(percent);
                        r.message = line.clone();
                    });
                }
            }
        })
    };
    let stderr_task = {
        let stderr_lines = stderr_lines.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_lines.lock().await.push(line);
            }
        })
    };

    set_pid(manager, video_id, child.id());
    let status = child.wait().await;
    set_pid(manager, video_id, None);
    let _ = progress_task.await;
    let _ = stderr_task.await;

    match take_pending(manager, video_id) {
        Some(PendingAction::Cancel) => {
            let _ = std::fs::remove_file(video_path);
            let _ = std::fs::remove_file(format!("{}.part", video_path.display()));
            DownloadOutcome::Cancelled
        }
        Some(PendingAction::Pause) => DownloadOutcome::Paused,
        None => match status {
            Ok(s) if s.success() => DownloadOutcome::Completed,
            _ => DownloadOutcome::Failed(stderr_lines.lock().await.join("\n")),
        },
    }
}

fn parse_ytdlp_percent(line: &str) -> Option<f64> {
    let line = line.trim_start();
    if !line.starts_with("[download]") {
        return None;
    }
    let percent_idx = line.find('%')?;
    let start = line[..percent_idx].rfind(|c: char| !c.is_ascii_digit() && c != '.').map(|i| i + 1).unwrap_or(0);
    line[start..percent_idx].trim().parse::<f64>().ok()
}

fn get_setting(conn: &rusqlite::Connection, key: &str) -> Result<String, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get::<_, String>(0))
        .map_err(|_| format!("Add your YouTube app's {key} in Settings first"))
}

fn row_to_account(row: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get("id")?,
        platform: row.get("platform")?,
        account_name: row.get("account_name")?,
        credentials_json: row.get("credentials_json")?,
        is_active: row.get::<_, i64>("is_active")? != 0,
        created_at: row.get("created_at")?,
    })
}

#[tauri::command]
pub async fn connect_youtube_account(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    oauth_state: tauri::State<'_, YouTubeOAuthState>,
) -> Result<Account, String> {
    use tauri_plugin_opener::OpenerExt;

    let (client_id, client_secret) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (get_setting(&conn, "youtube_client_id")?, get_setting(&conn, "youtube_client_secret")?)
    };

    if let Some(prev) = oauth_state.0.lock().map_err(|e| e.to_string())?.take() {
        prev.abort();
    }

    let state = uuid::Uuid::new_v4().to_string();
    let (code_verifier, code_challenge) = youtube_api::generate_pkce();
    log::info!("[youtube oauth] verifier len={} challenge={code_challenge} state={state}", code_verifier.len());
    let listen_task = tokio::spawn(youtube_api::await_oauth_callback());
    *oauth_state.0.lock().map_err(|e| e.to_string())? = Some(listen_task.abort_handle());

    app.opener()
        .open_url(youtube_api::authorize_url(&client_id, &state, &code_challenge), None::<&str>)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    let (code, returned_state) = listen_task.await.map_err(|e| e.to_string())??;
    log::info!("[youtube oauth] callback received state={returned_state}");
    if returned_state != state {
        return Err("OAuth state mismatch — possible CSRF, please try connecting again".to_string());
    }

    let token = youtube_api::exchange_code(&client_id, &client_secret, &code, &code_verifier).await?;
    let channel = youtube_api::fetch_my_channel(&token.access_token).await?;

    let credentials_json = serde_json::json!({
        "accessToken": token.access_token,
        "refreshToken": token.refresh_token,
        "channelId": channel.id,
        "expiresAt": (chrono::Utc::now() + chrono::Duration::seconds(token.expires_in)).to_rfc3339(),
        "avatarUrl": channel.thumbnail_url,
        "subscriberCount": channel.subscriber_count.as_deref().and_then(|s| s.parse::<i64>().ok()),
        "videoCount": channel.video_count.as_deref().and_then(|s| s.parse::<i64>().ok()),
        "viewCount": channel.view_count.as_deref().and_then(|s| s.parse::<i64>().ok()),
    })
    .to_string();

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM accounts WHERE platform = 'youtube' AND json_extract(credentials_json, '$.channelId') = ?1",
            params![channel.id],
            |row| row.get(0),
        )
        .ok();

    let id = match existing_id {
        Some(id) => {
            if token.refresh_token.is_some() {
                conn.execute(
                    "UPDATE accounts SET account_name = ?1, credentials_json = ?2 WHERE id = ?3",
                    params![channel.title, credentials_json, id],
                )
                .map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "UPDATE accounts SET account_name = ?1, credentials_json = json_patch(credentials_json, ?2) WHERE id = ?3",
                    params![channel.title, credentials_json, id],
                )
                .map_err(|e| e.to_string())?;
            }
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO accounts (id, platform, account_name, credentials_json) VALUES (?1, 'youtube', ?2, ?3)",
                params![id, channel.title, credentials_json],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };

    conn.query_row("SELECT * FROM accounts WHERE id = ?1", params![id], row_to_account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_youtube_account(db: tauri::State<'_, Db>, account_id: String) -> Result<Account, String> {
    let (access_token, refresh_token, expires_at, client_id, client_secret) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let credentials_json: String = conn
            .query_row("SELECT credentials_json FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&credentials_json).map_err(|e| e.to_string())?;
        let access_token = v["accessToken"].as_str().ok_or("missing accessToken")?.to_string();
        let refresh_token = v["refreshToken"].as_str().map(|s| s.to_string());
        let expires_at = v["expiresAt"].as_str().map(|s| s.to_string());
        let client_id = get_setting(&conn, "youtube_client_id")?;
        let client_secret = get_setting(&conn, "youtube_client_secret")?;
        (access_token, refresh_token, expires_at, client_id, client_secret)
    };

    let expired = expires_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt < chrono::Utc::now())
        .unwrap_or(true);

    let (access_token, refreshed_expires_at) = if expired {
        let refresh_token = refresh_token.ok_or("this account's login expired — click Reconnect to sign in again")?;
        let token = youtube_api::refresh_token(&client_id, &client_secret, &refresh_token).await?;
        let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(token.expires_in)).to_rfc3339();
        (token.access_token, Some(expires_at))
    } else {
        (access_token, None)
    };

    let channel = youtube_api::fetch_my_channel(&access_token).await?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let credentials_json: String = conn
        .query_row("SELECT credentials_json FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&credentials_json).map_err(|e| e.to_string())?;
    v["accessToken"] = serde_json::json!(access_token);
    if let Some(exp) = refreshed_expires_at {
        v["expiresAt"] = serde_json::json!(exp);
    }
    v["avatarUrl"] = serde_json::json!(channel.thumbnail_url);
    v["subscriberCount"] = serde_json::json!(channel.subscriber_count.as_deref().and_then(|s| s.parse::<i64>().ok()));
    v["videoCount"] = serde_json::json!(channel.video_count.as_deref().and_then(|s| s.parse::<i64>().ok()));
    v["viewCount"] = serde_json::json!(channel.view_count.as_deref().and_then(|s| s.parse::<i64>().ok()));

    conn.execute(
        "UPDATE accounts SET account_name = ?1, credentials_json = ?2 WHERE id = ?3",
        params![channel.title, v.to_string(), account_id],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row("SELECT * FROM accounts WHERE id = ?1", params![account_id], row_to_account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn youtube_search(
    db: tauri::State<'_, Db>,
    query: String,
    order: Option<String>,
    video_duration: Option<String>,
    published_after: Option<String>,
) -> Result<Vec<youtube_api::VideoSearchResult>, String> {
    let api_key = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        get_setting(&conn, "youtube_api_key")?
    };
    youtube_api::search_videos(&api_key, &query, 24, order.as_deref(), video_duration.as_deref(), published_after.as_deref()).await
}

#[tauri::command]
pub async fn youtube_video_details(db: tauri::State<'_, Db>, video_id: String) -> Result<youtube_api::VideoDetails, String> {
    let api_key = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        get_setting(&conn, "youtube_api_key")?
    };
    youtube_api::fetch_video_details(&api_key, &video_id).await
}

async fn fetch_captions(app: &AppHandle, video_id: &str) -> Result<Option<(String, PathBuf)>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dl_dir = app_data_dir.join("youtube_downloads");
    std::fs::create_dir_all(&dl_dir).map_err(|e| e.to_string())?;

    if let Some(path) = find_cached_vtt(&dl_dir, video_id) {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        return Ok(Some((content, path)));
    }

    if yt_dlp_path().is_ok() {
        let url = format!("https://www.youtube.com/watch?v={video_id}");
        let out_template = dl_dir.join(format!("{video_id}.%(ext)s"));
        let output = Command::new("yt-dlp")
            .args([
                "--skip-download",
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs",
                "en.*,en,-live_chat",
                "--sub-format",
                "vtt",
                "-o",
            ])
            .arg(&out_template)
            .arg(&url)
            .output()
            .map_err(|e| format!("failed to run yt-dlp: {e}"))?;
        if !output.status.success() {
            log::warn!(
                "[youtube] yt-dlp caption fetch failed for {video_id}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        } else if let Some(path) = find_cached_vtt(&dl_dir, video_id) {
            let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            return Ok(Some((content, path)));
        }
    }

    for lang in ["en", "a.en"] {
        if let Some(srt) = youtube_api::fetch_captions_srt(video_id, lang).await? {
            let path = dl_dir.join(format!("{video_id}.srt"));
            std::fs::write(&path, &srt).map_err(|e| e.to_string())?;
            return Ok(Some((srt, path)));
        }
    }
    Ok(None)
}

fn find_cached_vtt(dl_dir: &std::path::Path, video_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dl_dir).ok()?;
    let prefix = format!("{video_id}.");
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&prefix) && (n.ends_with(".vtt") || n.ends_with(".srt")))
                .unwrap_or(false)
        })
}

#[tauri::command]
pub async fn youtube_fetch_captions(app: AppHandle, video_id: String) -> Result<Option<String>, String> {
    Ok(fetch_captions(&app, &video_id).await?.map(|(content, _path)| content))
}

fn yt_dlp_path() -> Result<PathBuf, String> {
    Command::new("yt-dlp")
        .arg("--version")
        .output()
        .map(|_| PathBuf::from("yt-dlp"))
        .map_err(|_| {
            "yt-dlp not found on PATH — install it (e.g. `winget install yt-dlp`) and restart the app \
             to import YouTube videos as projects"
                .to_string()
        })
}

async fn run_download(app: AppHandle, video_id: String) {
    if let Err(e) = run_download_inner(&app, &video_id).await {
        log::warn!("[youtube download] {video_id} ended: {e}");
    }
}

async fn run_download_inner(app: &AppHandle, video_id: &str) -> Result<(), String> {
    let manager = app.state::<DownloadManager>();
    let db = app.state::<Db>();

    update_record(app, &manager, video_id, |r| {
        r.status = "details".to_string();
        r.message = "Fetching video details…".to_string();
    });
    let api_key = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        get_setting(&conn, "youtube_api_key")?
    };
    let details = match youtube_api::fetch_video_details(&api_key, video_id).await {
        Ok(d) => d,
        Err(e) => {
            update_record(app, &manager, video_id, |r| {
                r.status = "failed".to_string();
                r.error = Some(e.clone());
            });
            return Err(e);
        }
    };
    update_record(app, &manager, video_id, |r| {
        r.title = details.title.clone();
        r.thumbnail_url = details.thumbnail_url.clone();
    });

    let video_path = video_download_path(app, video_id)?;
    std::fs::create_dir_all(video_path.parent().expect("has parent")).map_err(|e| e.to_string())?;

    if !video_path.exists() {
        if let Err(e) = yt_dlp_path() {
            update_record(app, &manager, video_id, |r| {
                r.status = "failed".to_string();
                r.error = Some(e.clone());
            });
            return Err(e);
        }
        match run_ytdlp_process(app, &manager, video_id, &video_path).await {
            DownloadOutcome::Completed => {}
            DownloadOutcome::Paused => {
                update_record(app, &manager, video_id, |r| {
                    r.status = "paused".to_string();
                    r.message = "Paused".to_string();
                });
                return Err("paused".to_string());
            }
            DownloadOutcome::Cancelled => {
                update_record(app, &manager, video_id, |r| {
                    r.status = "cancelled".to_string();
                    r.message = "Cancelled".to_string();
                });
                return Err("cancelled".to_string());
            }
            DownloadOutcome::Failed(e) => {
                update_record(app, &manager, video_id, |r| {
                    r.status = "failed".to_string();
                    r.error = Some(e.clone());
                });
                return Err(e);
            }
        }
    }

    update_record(app, &manager, video_id, |r| {
        r.status = "captions".to_string();
        r.message = "Fetching captions…".to_string();
        r.percent = None;
    });
    let transcript_path = fetch_captions(app, video_id)
        .await?
        .map(|(_content, path)| path.to_string_lossy().to_string())
        .unwrap_or_default();

    update_record(app, &manager, video_id, |r| {
        r.status = "creating_project".to_string();
        r.message = "Creating project…".to_string();
    });
    let project = crate::commands::project::create_project(
        db.clone(),
        details.title,
        video_path.to_string_lossy().to_string(),
        transcript_path,
    )
    .await?;

    if !details.thumbnail_url.is_empty() {
        crate::commands::project::set_project_thumbnail(db, project.id.clone(), details.thumbnail_url).await?;
    }

    update_record(app, &manager, video_id, |r| {
        r.status = "completed".to_string();
        r.message = "Done".to_string();
        r.percent = Some(100.0);
        r.project_id = Some(project.id.clone());
    });
    Ok(())
}
