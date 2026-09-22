
use serde::{Deserialize, Serialize};
use std::path::Path;

const AUTH_BASE: &str = "https://www.tiktok.com/v2/auth/authorize/";
const API_BASE: &str = "https://open.tiktokapis.com/v2";

pub const OAUTH_REDIRECT_PORT: u16 = 53682;

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{OAUTH_REDIRECT_PORT}/callback")
}

pub fn authorize_url(client_key: &str, state: &str, code_challenge: &str) -> String {
    let redirect = urlencoding_encode(&redirect_uri());

    format!(
        "{AUTH_BASE}?client_key={client_key}&response_type=code&scope=user.info.basic,video.publish&redirect_uri={redirect}&state={state}&code_challenge={code_challenge}&code_challenge_method=S256"
    )
}

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

fn urlencoding_encode(s: &str) -> String {
    s.replace(':', "%3A").replace('/', "%2F")
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
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default()
}

pub const RATE_LIMIT_PREFIX: &str = "RATE_LIMITED:";

async fn rate_limit_error(resp: reqwest::Response, context: &str) -> String {
    const DEFAULT_RETRY_SECONDS: u64 = 60;
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_RETRY_SECONDS);
    let body = resp.text().await.unwrap_or_default();
    format!("{RATE_LIMIT_PREFIX}{retry_after}:{context} rate-limited (429 Too Many Requests): {body}")
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
    pub total_chunk_count: u64,
}

const SINGLE_CHUNK_LIMIT: u64 = 64_000_000;
const CHUNK_SIZE: u64 = 10_000_000;

fn compute_chunking(video_size: u64) -> (u64, u64) {
    if video_size <= SINGLE_CHUNK_LIMIT {
        return (video_size.max(1), 1);
    }
    let total_chunk_count = (video_size / CHUNK_SIZE).max(1);
    (CHUNK_SIZE, total_chunk_count)
}

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
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(rate_limit_error(resp, "TikTok publish init").await);
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {

        if body.contains("spam_risk_too_many_posts") {
            const SPAM_BLOCK_RETRY_SECONDS: u64 = 6 * 60 * 60;
            return Err(format!(
                "{RATE_LIMIT_PREFIX}{SPAM_BLOCK_RETRY_SECONDS}:TikTok blocked this post for posting too many times via the API in the last 24 hours: {body}"
            ));
        }
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
        total_chunk_count,
    })
}

pub async fn upload_video(
    upload_url: &str,
    video_path: &Path,
    video_size: u64,
    chunk_size: u64,
    total_chunk_count: u64,
) -> Result<(), String> {
    let bytes = tokio::fs::read(video_path).await.map_err(|e| e.to_string())?;
    let mut offset: u64 = 0;
    for i in 0..total_chunk_count {
        let end = if i == total_chunk_count - 1 { video_size } else { offset + chunk_size };
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
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(rate_limit_error(resp, "TikTok video upload").await);
        }
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
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(rate_limit_error(resp, "TikTok publish status fetch").await);
    }
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
