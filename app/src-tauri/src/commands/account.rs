use crate::db::Db;
use crate::tiktok_api;
use rusqlite::params;
use serde::Serialize;
use std::sync::Mutex;
use tauri::AppHandle;

/// Tracks the loopback listener task from the most recent `connect_tiktok_account` call.
/// Retrying (new browser tab, different account, etc.) while a prior attempt is still
/// waiting on port OAUTH_REDIRECT_PORT used to fail with "address already in use" — this
/// aborts the stale attempt first so the port is always free for a fresh one.
#[derive(Default)]
pub struct TikTokOAuthState(pub Mutex<Option<tokio::task::AbortHandle>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub platform: String,
    pub account_name: String,
    pub credentials_json: String,
    pub is_active: bool,
    pub created_at: String,
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
pub async fn create_account(
    db: tauri::State<'_, Db>,
    platform: String,
    account_name: String,
    credentials_json: String,
) -> Result<Account, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO accounts (id, platform, account_name, credentials_json) VALUES (?1, ?2, ?3, ?4)",
        params![id, platform, account_name, credentials_json],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row("SELECT * FROM accounts WHERE id = ?1", params![id], row_to_account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_accounts(db: tauri::State<'_, Db>) -> Result<Vec<Account>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT * FROM accounts ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_account)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn delete_account(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Runs the full TikTok OAuth (Login Kit) flow: opens the system browser to TikTok's
/// consent screen, catches the redirect on a loopback listener, exchanges the code for
/// tokens, and upserts an `accounts` row keyed by TikTok's `open_id` so reconnecting the
/// same account refreshes its tokens instead of creating a duplicate.
#[tauri::command]
pub async fn connect_tiktok_account(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    oauth_state: tauri::State<'_, TikTokOAuthState>,
) -> Result<Account, String> {
    use tauri_plugin_opener::OpenerExt;

    let (client_key, client_secret) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let get = |key: &str| -> Result<String, String> {
            conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get::<_, String>(0))
                .map_err(|_| "Add your TikTok app's Client key and Client secret in Settings first".to_string())
        };
        (get("tiktok_client_key")?, get("tiktok_client_secret")?)
    };

    // Abort whatever previous attempt might still be holding the loopback port — e.g. the
    // user opened the wrong browser account, or the last try never got a redirect at all.
    if let Some(prev) = oauth_state.0.lock().map_err(|e| e.to_string())?.take() {
        prev.abort();
    }

    let state = uuid::Uuid::new_v4().to_string();
    let (code_verifier, code_challenge) = tiktok_api::generate_pkce();
    log::info!("[tiktok oauth] verifier={code_verifier} (len={}) challenge={code_challenge} state={state}", code_verifier.len());
    let listen_task = tokio::spawn(tiktok_api::await_oauth_callback());
    *oauth_state.0.lock().map_err(|e| e.to_string())? = Some(listen_task.abort_handle());

    app.opener()
        .open_url(tiktok_api::authorize_url(&client_key, &state, &code_challenge), None::<&str>)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    let (code, returned_state) = listen_task.await.map_err(|e| e.to_string())??;
    log::info!("[tiktok oauth] callback received code={code} state={returned_state}");
    if returned_state != state {
        return Err("OAuth state mismatch — possible CSRF, please try connecting again".to_string());
    }

    log::info!("[tiktok oauth] exchanging with verifier={code_verifier}");
    let token = tiktok_api::exchange_code(&client_key, &client_secret, &code, &code_verifier).await?;
    let profile = tiktok_api::fetch_user_info(&token.access_token).await?;

    let credentials_json = serde_json::json!({
        "accessToken": token.access_token,
        "refreshToken": token.refresh_token,
        "openId": token.open_id,
        "expiresAt": (chrono::Utc::now() + chrono::Duration::seconds(token.expires_in)).to_rfc3339(),
        "avatarUrl": profile.avatar_large_url.or(profile.avatar_url_100).or(profile.avatar_url),
        "bioDescription": profile.bio_description,
        "profileDeepLink": profile.profile_deep_link,
        "isVerified": profile.is_verified,
        "followerCount": profile.follower_count,
        "followingCount": profile.following_count,
        "likesCount": profile.likes_count,
        "videoCount": profile.video_count,
    })
    .to_string();

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Reconnecting the same TikTok account (retry after a token expired, or just clicking
    // "Connect with TikTok" again) must update the existing row instead of erroring or
    // inserting a duplicate — keyed on TikTok's own `open_id`, which is stable per account,
    // rather than display_name (which the user can change on TikTok's side at any time).
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM accounts WHERE platform = 'tiktok' AND json_extract(credentials_json, '$.openId') = ?1",
            params![token.open_id],
            |row| row.get(0),
        )
        .ok();

    let id = match existing_id {
        Some(id) => {
            conn.execute(
                "UPDATE accounts SET account_name = ?1, credentials_json = ?2 WHERE id = ?3",
                params![profile.display_name, credentials_json, id],
            )
            .map_err(|e| e.to_string())?;
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO accounts (id, platform, account_name, credentials_json) VALUES (?1, 'tiktok', ?2, ?3)",
                params![id, profile.display_name, credentials_json],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };

    conn.query_row("SELECT * FROM accounts WHERE id = ?1", params![id], row_to_account)
        .map_err(|e| e.to_string())
}
