use crate::commands::account::Account;
use crate::db::Db;
use crate::facebook_api;
use rusqlite::params;
use std::sync::Mutex;
use tauri::AppHandle;

#[derive(Default)]
pub struct FacebookOAuthState(pub Mutex<Option<tokio::task::AbortHandle>>);

fn get_setting(conn: &rusqlite::Connection, key: &str) -> Result<String, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get::<_, String>(0))
        .map_err(|_| format!("Add your Facebook app's {key} in Settings first"))
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

fn upsert_account(
    conn: &rusqlite::Connection,
    name: &str,
    fb_id: &str,
    credentials_json: &str,
) -> rusqlite::Result<String> {
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM accounts WHERE platform = 'facebook' AND json_extract(credentials_json, '$.fbId') = ?1",
            params![fb_id],
            |row| row.get(0),
        )
        .ok();

    match existing_id {
        Some(id) => {
            conn.execute(
                "UPDATE accounts SET account_name = ?1, credentials_json = ?2 WHERE id = ?3",
                params![name, credentials_json, id],
            )?;
            Ok(id)
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO accounts (id, platform, account_name, credentials_json) VALUES (?1, 'facebook', ?2, ?3)",
                params![id, name, credentials_json],
            )?;
            Ok(id)
        }
    }
}

#[tauri::command]
pub async fn connect_facebook_account(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    oauth_state: tauri::State<'_, FacebookOAuthState>,
) -> Result<Vec<Account>, String> {
    use tauri_plugin_opener::OpenerExt;

    let (app_id, app_secret) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (get_setting(&conn, "facebook_app_id")?, get_setting(&conn, "facebook_app_secret")?)
    };

    if let Some(prev) = oauth_state.0.lock().map_err(|e| e.to_string())?.take() {
        prev.abort();
    }

    let state = uuid::Uuid::new_v4().to_string();
    log::info!("[facebook oauth] state={state}");
    let listen_task = tokio::spawn(facebook_api::await_oauth_callback());
    *oauth_state.0.lock().map_err(|e| e.to_string())? = Some(listen_task.abort_handle());

    app.opener()
        .open_url(facebook_api::authorize_url(&app_id, &state), None::<&str>)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    let (code, returned_state) = listen_task.await.map_err(|e| e.to_string())??;
    log::info!("[facebook oauth] callback received state={returned_state}");
    if returned_state != state {
        return Err("OAuth state mismatch — possible CSRF, please try connecting again".to_string());
    }

    let short_lived = facebook_api::exchange_code(&app_id, &app_secret, &code).await?;
    let long_lived = facebook_api::exchange_long_lived_token(&app_id, &app_secret, &short_lived.access_token).await?;

    let profile = facebook_api::fetch_me(&long_lived.access_token).await?;
    let pages = facebook_api::fetch_pages(&long_lived.access_token).await?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut connected = Vec::new();

    let user_credentials = serde_json::json!({
        "fbId": profile.id,
        "accountType": "user",
        "accessToken": long_lived.access_token,
        "avatarUrl": profile.avatar_url,
        "expiresAt": long_lived.expires_in.map(|s| (chrono::Utc::now() + chrono::Duration::seconds(s)).to_rfc3339()),
    })
    .to_string();
    let user_row_id = upsert_account(&conn, &profile.name, &profile.id, &user_credentials).map_err(|e| e.to_string())?;
    connected.push(user_row_id);

    for page in &pages {
        let page_credentials = serde_json::json!({
            "fbId": page.id,
            "accountType": "page",
            "accessToken": page.access_token,
            "avatarUrl": page.avatar_url,
            "category": page.category,
            "followerCount": page.followers_count,
            "likesCount": page.fan_count,
        })
        .to_string();
        let page_row_id = upsert_account(&conn, &page.name, &page.id, &page_credentials).map_err(|e| e.to_string())?;
        connected.push(page_row_id);
    }

    let mut accounts = Vec::new();
    for id in connected {
        accounts.push(conn.query_row("SELECT * FROM accounts WHERE id = ?1", params![id], row_to_account).map_err(|e| e.to_string())?);
    }
    Ok(accounts)
}

#[tauri::command]
pub async fn refresh_facebook_account(db: tauri::State<'_, Db>, account_id: String) -> Result<Account, String> {
    let (fb_id, account_type, access_token, account_name): (String, String, String, String) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let credentials_json: String = conn
            .query_row("SELECT credentials_json FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&credentials_json).map_err(|e| e.to_string())?;
        let fb_id = v["fbId"].as_str().ok_or("missing fbId")?.to_string();
        let account_type = v["accountType"].as_str().unwrap_or("page").to_string();
        let access_token = v["accessToken"].as_str().ok_or("missing accessToken")?.to_string();
        let account_name: String = conn
            .query_row("SELECT account_name FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        (fb_id, account_type, access_token, account_name)
    };

    let target = if account_type == "user" { "me".to_string() } else { fb_id };
    let details = facebook_api::fetch_account_details(&target, &access_token).await?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let credentials_json: String = conn
        .query_row("SELECT credentials_json FROM accounts WHERE id = ?1", params![account_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&credentials_json).map_err(|e| e.to_string())?;
    v["avatarUrl"] = serde_json::json!(details.avatar_url);
    v["bioDescription"] = serde_json::json!(details.about);
    v["category"] = serde_json::json!(details.category);
    v["followerCount"] = serde_json::json!(details.followers_count);
    v["likesCount"] = serde_json::json!(details.fan_count);
    v["profileDeepLink"] = serde_json::json!(details.link);

    conn.execute(
        "UPDATE accounts SET account_name = ?1, credentials_json = ?2 WHERE id = ?3",
        params![
            if details.name.is_empty() { account_name } else { details.name },
            serde_json::to_string(&v).map_err(|e| e.to_string())?,
            account_id
        ],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row("SELECT * FROM accounts WHERE id = ?1", params![account_id], row_to_account)
        .map_err(|e| e.to_string())
}
