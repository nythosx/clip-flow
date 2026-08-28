// Facebook Graph API OAuth + video publishing, for both a connected Page and (where
// Facebook's own permission model allows it — see `run_facebook_job` in queue_manager.rs)
// the user's personal timeline. Same loopback-listener OAuth shape as tiktok_api.rs/
// youtube_api.rs, since Facebook Login for a desktop app follows the same
// authorization-code-in-a-browser-redirect pattern.
use serde::{Deserialize, Serialize};
use std::path::Path;

const GRAPH_VERSION: &str = "v19.0";
const AUTH_BASE: &str = "https://www.facebook.com";
const GRAPH_BASE: &str = "https://graph.facebook.com";
const GRAPH_VIDEO_BASE: &str = "https://graph-video.facebook.com";
// Facebook, like TikTok, requires the exact redirect URI to be pre-registered in the app's
// dashboard ("Valid OAuth Redirect URIs" under Facebook Login settings) — it does not
// support Google's "any localhost port" installed-app flow. Register
// `http://localhost:OAUTH_REDIRECT_PORT/callback` there before connecting.
pub const OAUTH_REDIRECT_PORT: u16 = 53684;

pub fn redirect_uri() -> String {
    format!("http://localhost:{OAUTH_REDIRECT_PORT}/callback")
}

/// Scopes: `pages_show_list`/`pages_read_engagement` to enumerate managed Pages,
/// `pages_manage_posts` + `publish_video` to post video to a Page, `public_profile` for the
/// user's own name/picture. Posting to a personal timeline (`/me/videos`) additionally needs
/// `publish_video` on the *user* token, which — like TikTok's Production posting — requires
/// Meta App Review before it works for anyone other than the app's own developers/testers;
/// this is prepared and will work in that Sandbox-equivalent (Development Mode + added
/// testers) the same way TikTok's Sandbox did.
pub fn authorize_url(app_id: &str, state: &str) -> String {
    let redirect = urlencoding_encode(&redirect_uri());
    let scope = urlencoding_encode(
        "public_profile,pages_show_list,pages_read_engagement,pages_manage_posts,publish_video",
    );
    format!(
        "{AUTH_BASE}/{GRAPH_VERSION}/dialog/oauth?client_id={app_id}&redirect_uri={redirect}&state={state}&scope={scope}&response_type=code"
    )
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

#[derive(Debug, Deserialize)]
struct GraphErrorEnvelope {
    error: GraphError,
}

#[derive(Debug, Deserialize)]
struct GraphError {
    message: String,
    #[serde(rename = "type")]
    error_type: Option<String>,
    code: Option<i64>,
}

async fn check_graph_error(status: reqwest::StatusCode, body: &str) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    if let Ok(err) = serde_json::from_str::<GraphErrorEnvelope>(body) {
        return Err(format!(
            "Facebook API error{}: {}",
            err.error.code.map(|c| format!(" ({c})")).unwrap_or_default(),
            err.error.message
        ));
    }
    Err(format!("Facebook API request failed ({status}): {body}"))
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

pub async fn exchange_code(app_id: &str, app_secret: &str, code: &str) -> Result<TokenResponse, String> {
    let resp = client()
        .get(format!("{GRAPH_BASE}/{GRAPH_VERSION}/oauth/access_token"))
        .query(&[
            ("client_id", app_id),
            ("client_secret", app_secret),
            ("redirect_uri", &redirect_uri()),
            ("code", code),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    check_graph_error(status, &body).await?;
    serde_json::from_str(&body).map_err(|e| format!("failed to parse Facebook token response: {e} — body: {body}"))
}

/// Trades the short-lived (~1-2h) token `exchange_code` returns for a long-lived (~60 day)
/// one. Page access tokens derived afterward from `fetch_pages` inherit long-lived-ness from
/// this, and effectively never expire as long as the user stays connected — this is why
/// there's no `refresh_token` here the way TikTok/Google have one.
pub async fn exchange_long_lived_token(app_id: &str, app_secret: &str, short_lived_token: &str) -> Result<TokenResponse, String> {
    let resp = client()
        .get(format!("{GRAPH_BASE}/{GRAPH_VERSION}/oauth/access_token"))
        .query(&[
            ("grant_type", "fb_exchange_token"),
            ("client_id", app_id),
            ("client_secret", app_secret),
            ("fb_exchange_token", short_lived_token),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    check_graph_error(status, &body).await?;
    serde_json::from_str(&body).map_err(|e| format!("failed to parse Facebook token response: {e} — body: {body}"))
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct FacebookProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MeEnvelope {
    id: String,
    name: String,
    picture: Option<PictureField>,
}

#[derive(Debug, Deserialize)]
struct PictureField {
    data: PictureData,
}

#[derive(Debug, Deserialize)]
struct PictureData {
    url: String,
}

pub async fn fetch_me(access_token: &str) -> Result<FacebookProfile, String> {
    let resp = client()
        .get(format!("{GRAPH_BASE}/{GRAPH_VERSION}/me"))
        .query(&[("fields", "id,name,picture"), ("access_token", access_token)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    check_graph_error(status, &body).await?;
    let me: MeEnvelope = serde_json::from_str(&body).map_err(|e| format!("failed to parse /me response: {e} — body: {body}"))?;
    Ok(FacebookProfile {
        id: me.id,
        name: me.name,
        avatar_url: me.picture.map(|p| p.data.url),
    })
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FacebookPage {
    pub id: String,
    pub name: String,
    pub access_token: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub fan_count: Option<i64>,
    #[serde(default)]
    pub followers_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AccountsEnvelope {
    data: Vec<PageItem>,
}

#[derive(Debug, Deserialize)]
struct PageItem {
    id: String,
    name: String,
    access_token: String,
    category: Option<String>,
    #[serde(default)]
    fan_count: Option<i64>,
    #[serde(default)]
    followers_count: Option<i64>,
    picture: Option<PictureField>,
}

/// Lists every Page the connected user manages, each with its own (long-lived) Page access
/// token — Facebook issues these directly in `/me/accounts`, no separate per-page exchange
/// needed. Requires `pages_show_list` (granted in `authorize_url`'s scope).
pub async fn fetch_pages(user_access_token: &str) -> Result<Vec<FacebookPage>, String> {
    let resp = client()
        .get(format!("{GRAPH_BASE}/{GRAPH_VERSION}/me/accounts"))
        .query(&[
            ("fields", "id,name,access_token,category,fan_count,followers_count,picture"),
            ("access_token", user_access_token),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    check_graph_error(status, &body).await?;
    let envelope: AccountsEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse /me/accounts response: {e} — body: {body}"))?;
    Ok(envelope
        .data
        .into_iter()
        .map(|p| FacebookPage {
            id: p.id,
            name: p.name,
            access_token: p.access_token,
            avatar_url: p.picture.map(|pic| pic.data.url),
            category: p.category,
            fan_count: p.fan_count,
            followers_count: p.followers_count,
        })
        .collect())
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountDetails {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub fan_count: Option<i64>,
    #[serde(default)]
    pub followers_count: Option<i64>,
    #[serde(default)]
    pub link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DetailsEnvelope {
    id: String,
    name: String,
    #[serde(default)]
    about: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    fan_count: Option<i64>,
    #[serde(default)]
    followers_count: Option<i64>,
    #[serde(default)]
    link: Option<String>,
    picture: Option<PictureField>,
}

/// Re-fetches full profile detail for a Page or the user themselves (`target` is either a
/// Page id or `"me"`) — the "give me everything you can get" refresh behind Accounts'
/// Reconnect action, same idea as `tiktok_api::fetch_user_info` pulling more fields than the
/// minimum needed at connect time.
pub async fn fetch_account_details(target: &str, access_token: &str) -> Result<AccountDetails, String> {
    let resp = client()
        .get(format!("{GRAPH_BASE}/{GRAPH_VERSION}/{target}"))
        .query(&[
            ("fields", "id,name,about,category,fan_count,followers_count,link,picture"),
            ("access_token", access_token),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    check_graph_error(status, &body).await?;
    let d: DetailsEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse account details response: {e} — body: {body}"))?;
    Ok(AccountDetails {
        id: d.id,
        name: d.name,
        avatar_url: d.picture.map(|p| p.data.url),
        about: d.about,
        category: d.category,
        fan_count: d.fan_count,
        followers_count: d.followers_count,
        link: d.link,
    })
}

#[derive(Debug, Deserialize)]
struct PublishVideoResponse {
    id: String,
}

/// Publishes a video to a Page's or (permission-permitting) the user's own timeline.
/// `target` is a Page id, or `"me"` for the personal profile. Single-request multipart
/// upload against `graph-video.facebook.com` — fine for typical short-form clip file sizes;
/// Facebook's resumable chunked-upload API exists for multi-GB files but isn't needed here
/// (mirrors tiktok_api::upload_video's same "read the whole clip into memory" approach).
pub async fn publish_video(target: &str, access_token: &str, video_path: &Path, caption: &str) -> Result<String, String> {
    let bytes = tokio::fs::read(video_path).await.map_err(|e| e.to_string())?;
    let filename = video_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip.mp4".to_string());
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename).mime_str("video/mp4").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("access_token", access_token.to_string())
        .text("description", caption.to_string())
        .part("source", part);

    let resp = client()
        .post(format!("{GRAPH_VIDEO_BASE}/{GRAPH_VERSION}/{target}/videos"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    check_graph_error(status, &body).await?;
    let parsed: PublishVideoResponse =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse publish response: {e} — body: {body}"))?;
    Ok(parsed.id)
}

/// Blocks until the OAuth redirect hits `http://localhost:OAUTH_REDIRECT_PORT/callback`,
/// returning `code`/`state`. Same shape/timeout as the TikTok and YouTube callback
/// listeners.
pub async fn await_oauth_callback() -> Result<(String, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::{timeout, Duration};

    let listener = TcpListener::bind(("127.0.0.1", OAUTH_REDIRECT_PORT))
        .await
        .map_err(|e| format!("failed to bind OAuth callback listener on port {OAUTH_REDIRECT_PORT}: {e}"))?;

    let (mut socket, _) = timeout(Duration::from_secs(120), listener.accept())
        .await
        .map_err(|_| "timed out waiting for the Facebook login to complete".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 4096];
    let n = socket.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let path_and_query = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("malformed OAuth callback request")?;
    let query = path_and_query.split('?').nth(1).unwrap_or("");

    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        match (parts.next(), parts.next()) {
            (Some("code"), Some(v)) => code = Some(percent_decode(v)),
            (Some("state"), Some(v)) => state = Some(percent_decode(v)),
            _ => {}
        }
    }

    let body = "<html><body>ClipFlow: Facebook connected. You can close this tab.</body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = socket.write_all(response.as_bytes()).await;

    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err("OAuth callback missing code/state — user may have denied access".to_string()),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
