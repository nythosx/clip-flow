// TikTok Content Posting API + OAuth (Login Kit) client. Replaces the queue processor's
// old simulated-progress stub (queue_manager.rs) with real calls, per SPEC.md section 12
// superseded — ADB-emulator automation was the original plan but is fragile (breaks on any
// TikTok UI change) and borderline against ToS; the official API is the reliable path and
// is what TikTok's App Review process actually verifies.
use serde::{Deserialize, Serialize};
use std::path::Path;

const AUTH_BASE: &str = "https://www.tiktok.com/v2/auth/authorize/";
const API_BASE: &str = "https://open.tiktokapis.com/v2";
// Fixed (not ephemeral) so it matches the redirect URI registered once in the Developer
// Portal's Platform configuration — this app has no web server, so the OAuth redirect is
// caught by a temporary loopback listener instead (same pattern as `gh`/`gcloud` CLI auth).
pub const OAUTH_REDIRECT_PORT: u16 = 53682;

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{OAUTH_REDIRECT_PORT}/callback")
}

pub fn authorize_url(client_key: &str, state: &str, code_challenge: &str) -> String {
    let redirect = urlencoding_encode(&redirect_uri());
    // `video.publish` (NOT `video.upload`) is what actually authorizes
    // POST /post/publish/video/init/, the direct-post endpoint this app calls — confirmed
    // against TikTok's live Content Posting API docs after a real account hit
    // `scope_not_authorized` on every publish attempt with the old scope list. The doc
    // comment this replaced ("TikTok has no separate video.publish scope") was simply
    // wrong; `video.upload` is a distinct scope for the inbox/drafts upload flow this app
    // doesn't use. TikTok requires PKCE (errCode 10007 "code_challenge" otherwise) —
    // desktop/public clients can't safely embed a client secret in the authorize step, so
    // PKCE proves possession of the verifier at token-exchange time instead.
    format!(
        "{AUTH_BASE}?client_key={client_key}&response_type=code&scope=user.info.basic,video.publish&redirect_uri={redirect}&state={state}&code_challenge={code_challenge}&code_challenge_method=S256"
    )
}

/// Generates a PKCE verifier/challenge pair. The verifier is 32 random bytes
/// base64url-encoded (satisfies RFC 7636's 43-128 char unreserved-charset requirement).
/// The challenge is NOT what generic RFC 7636 (base64url of the SHA-256 digest) would
/// produce — TikTok's own Login Kit for Desktop docs specify hex-encoded SHA-256 instead,
/// confirmed by testing: base64url challenges consistently got "Code verifier or code
/// challenge is invalid" even though the client-side base64url math checked out correctly.
pub fn generate_pkce() -> (String, String) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};

    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = hex::encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

// Only a handful of characters need escaping for this URL's query values; avoids pulling
// in a dedicated urlencoding crate for one call site.
fn urlencoding_encode(s: &str) -> String {
    s.replace(':', "%3A").replace('/', "%2F")
}

/// Decodes `%XX` percent-escapes in a query-string value. TikTok's authorization code can
/// contain characters (seen: `*`, `!`) that arrive percent-encoded over the OAuth redirect.
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

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub open_id: String,
}

#[derive(Debug, Deserialize)]
struct TokenErrorEnvelope {
    error: Option<String>,
    error_description: Option<String>,
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn parse_token_response(resp: reqwest::Response) -> Result<TokenResponse, String> {
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("TikTok token request failed ({status}): {body}"));
    }
    if let Ok(err) = serde_json::from_str::<TokenErrorEnvelope>(&body) {
        if let Some(e) = err.error {
            if e != "ok" && !e.is_empty() {
                let desc = err.error_description.unwrap_or_default();
                return Err(format!("TikTok token error: {e} {desc}"));
            }
        }
    }
    serde_json::from_str(&body).map_err(|e| format!("failed to parse TikTok token response: {e} — body: {body}"))
}

pub async fn exchange_code(
    client_key: &str,
    client_secret: &str,
    code: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let resp = client()
        .post(format!("{API_BASE}/oauth/token/"))
        .header("Cache-Control", "no-cache")
        .form(&[
            ("client_key", client_key),
            ("client_secret", client_secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &redirect_uri()),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    parse_token_response(resp).await
}

pub async fn refresh_token(
    client_key: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let resp = client()
        .post(format!("{API_BASE}/oauth/token/"))
        .header("Cache-Control", "no-cache")
        .form(&[
            ("client_key", client_key),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    parse_token_response(resp).await
}

#[derive(Debug, Deserialize)]
struct UserInfoEnvelope {
    data: UserInfoData,
}

#[derive(Debug, Deserialize)]
struct UserInfoData {
    user: UserInfoUser,
}

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct UserInfoUser {
    pub open_id: Option<String>,
    pub union_id: Option<String>,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub avatar_url_100: Option<String>,
    #[serde(default)]
    pub avatar_large_url: Option<String>,
    #[serde(default)]
    pub bio_description: Option<String>,
    #[serde(default)]
    pub profile_deep_link: Option<String>,
    #[serde(default)]
    pub is_verified: Option<bool>,
    #[serde(default)]
    pub follower_count: Option<i64>,
    #[serde(default)]
    pub following_count: Option<i64>,
    #[serde(default)]
    pub likes_count: Option<i64>,
    #[serde(default)]
    pub video_count: Option<i64>,
}

/// Fetches user/info fields — restricted to exactly what `user.info.basic` (the only scope
/// `authorize_url` requests) actually covers: open_id, union_id, avatar_url, display_name.
///
/// A prior version of this also requested avatar_url_100/avatar_large_url/bio_description/
/// profile_deep_link/is_verified/follower_count/following_count/likes_count/video_count on
/// the (wrong) assumption that TikTok just omits fields a token isn't authorized for.
/// Confirmed against a live account: it doesn't — requesting ANY field outside the token's
/// granted scope fails the ENTIRE call with 401 `scope_not_authorized`, not just those
/// fields. Only re-add the extra fields here if `user.info.profile`/`user.info.stats` are
/// ever actually added to this app's scope list in the Developer Portal AND `authorize_url`
/// is updated to request them — adding them here without that will break this call again.
pub async fn fetch_user_info(access_token: &str) -> Result<UserInfoUser, String> {
    let fields = "open_id,union_id,avatar_url,display_name";
    let resp = client()
        .get(format!("{API_BASE}/user/info/?fields={fields}"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("TikTok user/info failed ({status}): {body}"));
    }
    let envelope: UserInfoEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse user/info response: {e} — body: {body}"))?;
    Ok(envelope.data.user)
}

#[derive(Debug, Serialize)]
struct PostInfo<'a> {
    title: &'a str,
    privacy_level: &'a str,
}

#[derive(Debug, Serialize)]
struct SourceInfo {
    source: &'static str,
    video_size: u64,
    chunk_size: u64,
    total_chunk_count: u64,
}

#[derive(Debug, Serialize)]
struct InitPublishRequest<'a> {
    post_info: PostInfo<'a>,
    source_info: SourceInfo,
}

#[derive(Debug, Deserialize)]
struct InitPublishEnvelope {
    data: InitPublishData,
    error: InitPublishError,
}

#[derive(Debug, Deserialize)]
struct InitPublishData {
    publish_id: String,
    upload_url: String,
}

#[derive(Debug, Deserialize)]
struct InitPublishError {
    code: String,
    message: String,
}

pub struct PublishInit {
    pub publish_id: String,
    pub upload_url: String,
    pub video_size: u64,
    pub chunk_size: u64,
}

// TikTok's Media Transfer Guide: a chunk must be 5-64MB, except the final chunk (which may
// exceed 64MB, up to 128MB, to absorb the remainder). Videos <= 64MB go up as a single chunk
// with chunk_size == video_size; anything larger MUST be split into multiple chunks or the
// init call fails with `invalid_params: chunk size is invalid` — this is what broke uploads
// for any clip whose rendered file passed 64MB (the first queued clip merely happened to be
// under that size, which is why only "the rest" failed).
const SINGLE_CHUNK_LIMIT: u64 = 64 * 1024 * 1024;
const MAX_CHUNK_SIZE: u64 = 64 * 1024 * 1024;

fn compute_chunking(video_size: u64) -> (u64, u64) {
    if video_size <= SINGLE_CHUNK_LIMIT {
        return (video_size.max(1), 1);
    }
    let total_chunk_count = video_size.div_ceil(MAX_CHUNK_SIZE);
    (MAX_CHUNK_SIZE, total_chunk_count)
}

/// Starts a Content Posting API publish job. `privacy_level` must be one of the values the
/// account's TikTok privacy settings actually allow — `SELF_ONLY` is always available, so
/// that's used until the app is out of Sandbox (public posting requires App Review approval
/// per TikTok's rules, matching TIKTOK_APP_SETUP context: sandbox posts are only visible to
/// the developer's own test account).
pub async fn init_video_publish(
    access_token: &str,
    video_path: &Path,
    title: &str,
) -> Result<PublishInit, String> {
    let video_size = std::fs::metadata(video_path).map_err(|e| e.to_string())?.len();
    let (chunk_size, total_chunk_count) = compute_chunking(video_size);
    let req = InitPublishRequest {
        post_info: PostInfo {
            title,
            privacy_level: "SELF_ONLY",
        },
        source_info: SourceInfo {
            source: "FILE_UPLOAD",
            video_size,
            chunk_size,
            total_chunk_count,
        },
    };
    let resp = client()
        .post(format!("{API_BASE}/post/publish/video/init/"))
        .bearer_auth(access_token)
        .json(&req)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("TikTok publish init failed ({status}): {body}"));
    }
    let envelope: InitPublishEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse publish init response: {e} — body: {body}"))?;
    if envelope.error.code != "ok" {
        return Err(format!("TikTok publish init error: {} {}", envelope.error.code, envelope.error.message));
    }
    Ok(PublishInit {
        publish_id: envelope.data.publish_id,
        upload_url: envelope.data.upload_url,
        video_size,
        chunk_size,
    })
}

/// Uploads `video_path` to `upload_url` in `chunk_size`-byte pieces (matching whatever
/// chunk_size was declared to `init_video_publish` — TikTok validates each PUT's
/// Content-Range against that declared size). The final chunk absorbs any remainder, so it
/// may be smaller (or, for a video just over 64MB, up to 2x chunk_size) than the others.
pub async fn upload_video(upload_url: &str, video_path: &Path, video_size: u64, chunk_size: u64) -> Result<(), String> {
    let bytes = tokio::fs::read(video_path).await.map_err(|e| e.to_string())?;
    let mut offset: u64 = 0;
    while offset < video_size {
        let end = (offset + chunk_size).min(video_size);
        let chunk = &bytes[offset as usize..end as usize];
        let resp = client()
            .put(upload_url)
            .header("Content-Type", "video/mp4")
            .header("Content-Range", format!("bytes {}-{}/{}", offset, end - 1, video_size))
            .body(chunk.to_vec())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("TikTok video upload failed ({status}): {body}"));
        }
        offset = end;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct PublishStatusEnvelope {
    data: PublishStatusData,
}

#[derive(Debug, Deserialize)]
struct PublishStatusData {
    status: String,
    #[serde(default)]
    fail_reason: Option<String>,
}

pub enum PublishStatus {
    Processing,
    Complete,
    Failed(String),
}

pub async fn fetch_publish_status(access_token: &str, publish_id: &str) -> Result<PublishStatus, String> {
    let resp = client()
        .post(format!("{API_BASE}/post/publish/status/fetch/"))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "publish_id": publish_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("TikTok publish status fetch failed ({status}): {body}"));
    }
    let envelope: PublishStatusEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse publish status response: {e} — body: {body}"))?;
    Ok(match envelope.data.status.as_str() {
        "PUBLISH_COMPLETE" => PublishStatus::Complete,
        "FAILED" => PublishStatus::Failed(envelope.data.fail_reason.unwrap_or_else(|| "unknown".to_string())),
        _ => PublishStatus::Processing,
    })
}

/// Blocks until the OAuth redirect hits `http://127.0.0.1:OAUTH_REDIRECT_PORT/callback`,
/// then returns the `code`/`state` query params. Serves a minimal static response so the
/// browser tab shows something before the user switches back to ClipFlow.
///
/// Times out after 2 minutes rather than waiting forever — TikTok's own error pages (e.g.
/// a rejected authorize request) never redirect back here at all, so without a timeout a
/// failed attempt would hold the port bound indefinitely and break every retry with
/// "address already in use" until the app is restarted.
pub async fn await_oauth_callback() -> Result<(String, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::{timeout, Duration};

    let listener = TcpListener::bind(("127.0.0.1", OAUTH_REDIRECT_PORT))
        .await
        .map_err(|e| format!("failed to bind OAuth callback listener on port {OAUTH_REDIRECT_PORT}: {e}"))?;

    let (mut socket, _) = timeout(Duration::from_secs(120), listener.accept())
        .await
        .map_err(|_| "timed out waiting for the TikTok login to complete".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 4096];
    let n = socket.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);
    // Request line looks like "GET /callback?code=...&state=... HTTP/1.1"
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
            // TikTok's authorization code contains percent-encoded characters (seen in
            // practice: %2A for '*', %21 for '!') since it's placed in a URL query string —
            // must be decoded before use, or the token exchange silently gets a mangled
            // code that fails validation (surfaces as a generic PKCE mismatch error).
            (Some("code"), Some(v)) => code = Some(percent_decode(v)),
            (Some("state"), Some(v)) => state = Some(percent_decode(v)),
            _ => {}
        }
    }

    let body = "<html><body>ClipFlow: TikTok connected. You can close this tab.</body></html>";
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
