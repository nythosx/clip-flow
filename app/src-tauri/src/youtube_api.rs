
use serde::{Deserialize, Serialize};

const AUTH_BASE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DATA_API_BASE: &str = "https://www.googleapis.com/youtube/v3";

pub const OAUTH_REDIRECT_PORT: u16 = 53683;

pub fn redirect_uri() -> String {
    format!("http://localhost:{OAUTH_REDIRECT_PORT}")
}

pub fn authorize_url(client_id: &str, state: &str, code_challenge: &str) -> String {
    let redirect = urlencoding_encode(&redirect_uri());
    let scope = urlencoding_encode(
        "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
    );
    format!(
        "{AUTH_BASE}?client_id={client_id}&response_type=code&scope={scope}&redirect_uri={redirect}\
         &state={state}&code_challenge={code_challenge}&code_challenge_method=S256\
         &access_type=offline&prompt=consent"
    )
}

pub fn generate_pkce() -> (String, String) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};

    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
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
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    pub expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct TokenErrorEnvelope {
    error: Option<String>,
    error_description: Option<String>,
}

async fn parse_token_response(resp: reqwest::Response) -> Result<TokenResponse, String> {
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<TokenErrorEnvelope>(&body) {
            if let Some(e) = err.error {
                let desc = err.error_description.unwrap_or_default();
                return Err(format!("YouTube token error: {e} {desc}"));
            }
        }
        return Err(format!("YouTube token request failed ({status}): {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("failed to parse YouTube token response: {e} — body: {body}"))
}

pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let resp = client()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
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

pub async fn refresh_token(client_id: &str, client_secret: &str, refresh_token: &str) -> Result<TokenResponse, String> {
    let resp = client()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    parse_token_response(resp).await
}

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct ChannelInfo {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub subscriber_count: Option<String>,
    #[serde(default)]
    pub video_count: Option<String>,
    #[serde(default)]
    pub view_count: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChannelsEnvelope {
    items: Vec<ChannelItem>,
}

#[derive(Debug, Deserialize)]
struct ChannelItem {
    id: String,
    snippet: ChannelSnippet,
    statistics: Option<ChannelStatistics>,
}

#[derive(Debug, Deserialize)]
struct ChannelSnippet {
    title: String,
    thumbnails: Option<Thumbnails>,
}

#[derive(Debug, Deserialize)]
struct ChannelStatistics {
    #[serde(rename = "subscriberCount")]
    subscriber_count: Option<String>,
    #[serde(rename = "videoCount")]
    video_count: Option<String>,
    #[serde(rename = "viewCount")]
    view_count: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Thumbnails {
    high: Option<Thumbnail>,
    medium: Option<Thumbnail>,
    default: Option<Thumbnail>,
}

#[derive(Debug, Deserialize)]
struct Thumbnail {
    url: String,
}

impl Thumbnails {
    fn best_url(&self) -> Option<String> {
        self.high
            .as_ref()
            .or(self.medium.as_ref())
            .or(self.default.as_ref())
            .map(|t| t.url.clone())
    }
}

pub async fn fetch_my_channel(access_token: &str) -> Result<ChannelInfo, String> {
    let resp = client()
        .get(format!("{DATA_API_BASE}/channels?part=snippet,statistics&mine=true"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("YouTube channels.list failed ({status}): {body}"));
    }
    let envelope: ChannelsEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse channels response: {e} — body: {body}"))?;
    let item = envelope.items.into_iter().next().ok_or("no channel found for this account")?;
    Ok(ChannelInfo {
        id: item.id,
        title: item.snippet.title,
        thumbnail_url: item.snippet.thumbnails.as_ref().and_then(|t| t.best_url()),
        subscriber_count: item.statistics.as_ref().and_then(|s| s.subscriber_count.clone()),
        video_count: item.statistics.as_ref().and_then(|s| s.video_count.clone()),
        view_count: item.statistics.as_ref().and_then(|s| s.view_count.clone()),
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoSearchResult {
    pub video_id: String,
    pub title: String,
    pub channel_title: String,
    pub description: String,
    pub thumbnail_url: String,
    pub published_at: String,

    #[serde(default)]
    pub duration_seconds: f64,
    #[serde(default)]
    pub view_count: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchEnvelope {
    items: Vec<SearchItem>,
}

#[derive(Debug, Deserialize)]
struct SearchItem {
    id: SearchItemId,
    snippet: SearchSnippet,
}

#[derive(Debug, Deserialize)]
struct SearchItemId {
    #[serde(rename = "videoId")]
    video_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchSnippet {
    title: String,
    description: String,
    #[serde(rename = "channelTitle")]
    channel_title: String,
    #[serde(rename = "publishedAt")]
    published_at: String,
    thumbnails: Option<Thumbnails>,
}

pub async fn search_videos(
    api_key: &str,
    query: &str,
    max_results: u32,
    order: Option<&str>,
    video_duration: Option<&str>,
    published_after: Option<&str>,
) -> Result<Vec<VideoSearchResult>, String> {
    let q = urlencoding_encode(query);
    let mut url = format!(
        "{DATA_API_BASE}/search?part=snippet&type=video&maxResults={max_results}&q={q}&key={api_key}"
    );
    if let Some(o) = order.filter(|v| !v.is_empty() && *v != "relevance") {
        url.push_str(&format!("&order={}", urlencoding_encode(o)));
    }
    if let Some(d) = video_duration.filter(|v| !v.is_empty() && *v != "any") {
        url.push_str(&format!("&videoDuration={}", urlencoding_encode(d)));
    }
    if let Some(p) = published_after.filter(|v| !v.is_empty()) {
        url.push_str(&format!("&publishedAfter={}", urlencoding_encode(p)));
    }

    let resp = client().get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("YouTube search.list failed ({status}): {body}"));
    }
    let envelope: SearchEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse search response: {e} — body: {body}"))?;
    let mut results: Vec<VideoSearchResult> = envelope
        .items
        .into_iter()
        .filter_map(|item| {
            let video_id = item.id.video_id?;
            Some(VideoSearchResult {
                video_id,
                title: item.snippet.title,
                channel_title: item.snippet.channel_title,
                description: item.snippet.description,
                thumbnail_url: item.snippet.thumbnails.as_ref().and_then(|t| t.best_url()).unwrap_or_default(),
                published_at: item.snippet.published_at,
                duration_seconds: 0.0,
                view_count: None,
            })
        })
        .collect();

    let ids: Vec<String> = results.iter().map(|r| r.video_id.clone()).collect();
    if let Ok(batch) = fetch_videos_batch_details(api_key, &ids).await {
        for r in results.iter_mut() {
            if let Some((duration, views)) = batch.get(&r.video_id) {
                r.duration_seconds = *duration;
                r.view_count = views.clone();
            }
        }
    }

    Ok(results)
}

#[derive(Debug, Deserialize)]
struct VideoDetailsBatchEnvelope {
    items: Vec<VideoDetailsBatchItem>,
}

#[derive(Debug, Deserialize)]
struct VideoDetailsBatchItem {
    id: String,
    #[serde(rename = "contentDetails")]
    content_details: VideoContentDetails,
    statistics: Option<VideoStatistics>,
}

async fn fetch_videos_batch_details(
    api_key: &str,
    ids: &[String],
) -> Result<std::collections::HashMap<String, (f64, Option<String>)>, String> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let joined = ids.join(",");
    let resp = client()
        .get(format!(
            "{DATA_API_BASE}/videos?part=contentDetails,statistics&id={joined}&key={api_key}"
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("YouTube videos.list (batch) failed ({status}): {body}"));
    }
    let envelope: VideoDetailsBatchEnvelope = serde_json::from_str(&body)
        .map_err(|e| format!("failed to parse videos batch response: {e} — body: {body}"))?;
    Ok(envelope
        .items
        .into_iter()
        .map(|it| (it.id, (parse_iso8601_duration(&it.content_details.duration), it.statistics.and_then(|s| s.view_count))))
        .collect())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoDetails {
    pub video_id: String,
    pub title: String,
    pub channel_title: String,
    pub description: String,
    pub thumbnail_url: String,
    pub duration_seconds: f64,
    pub view_count: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VideosEnvelope {
    items: Vec<VideoItem>,
}

#[derive(Debug, Deserialize)]
struct VideoItem {
    id: String,
    snippet: SearchSnippet,
    #[serde(rename = "contentDetails")]
    content_details: VideoContentDetails,
    statistics: Option<VideoStatistics>,
}

#[derive(Debug, Deserialize)]
struct VideoContentDetails {
    duration: String,
}

#[derive(Debug, Deserialize)]
struct VideoStatistics {
    #[serde(rename = "viewCount")]
    view_count: Option<String>,
}

fn parse_iso8601_duration(s: &str) -> f64 {
    let mut total = 0.0_f64;
    let mut num = String::new();
    let mut in_time = false;
    for c in s.chars() {
        match c {
            'P' => {}
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            'H' => {
                total += num.parse::<f64>().unwrap_or(0.0) * 3600.0;
                num.clear();
            }
            'M' if in_time => {
                total += num.parse::<f64>().unwrap_or(0.0) * 60.0;
                num.clear();
            }
            'M' => {

                num.clear();
            }
            'S' => {
                total += num.parse::<f64>().unwrap_or(0.0);
                num.clear();
            }
            'D' => {
                total += num.parse::<f64>().unwrap_or(0.0) * 86400.0;
                num.clear();
            }
            _ => {}
        }
    }
    total
}

pub async fn fetch_video_details(api_key: &str, video_id: &str) -> Result<VideoDetails, String> {
    let resp = client()
        .get(format!(
            "{DATA_API_BASE}/videos?part=snippet,contentDetails,statistics&id={video_id}&key={api_key}"
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("YouTube videos.list failed ({status}): {body}"));
    }
    let envelope: VideosEnvelope =
        serde_json::from_str(&body).map_err(|e| format!("failed to parse videos response: {e} — body: {body}"))?;
    let item = envelope.items.into_iter().next().ok_or("video not found")?;
    Ok(VideoDetails {
        video_id: item.id,
        title: item.snippet.title,
        channel_title: item.snippet.channel_title,
        description: item.snippet.description,
        thumbnail_url: item.snippet.thumbnails.as_ref().and_then(|t| t.best_url()).unwrap_or_default(),
        duration_seconds: parse_iso8601_duration(&item.content_details.duration),
        view_count: item.statistics.and_then(|s| s.view_count),
    })
}

pub async fn fetch_captions_srt(video_id: &str, lang: &str) -> Result<Option<String>, String> {
    let resp = client()
        .get(format!("https://www.youtube.com/api/timedtext?v={video_id}&lang={lang}&fmt=srv3"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() || body.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(timedtext_xml_to_srt(&body)))
}

fn timedtext_xml_to_srt(xml: &str) -> String {
    let mut out = String::new();
    let mut index = 1;
    let mut rest = xml;
    while let Some(p_start) = rest.find("<p ") {
        rest = &rest[p_start..];
        let Some(tag_end) = rest.find('>') else { break };
        let tag = &rest[..tag_end];
        let Some(text_end) = rest[tag_end + 1..].find("</p>") else { break };
        let text_raw = &rest[tag_end + 1..tag_end + 1 + text_end];
        rest = &rest[tag_end + 1 + text_end + 4..];

        let start_ms: f64 = extract_xml_attr(tag, "t").and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let dur_ms: f64 = extract_xml_attr(tag, "d").and_then(|s| s.parse().ok()).unwrap_or(2000.0);
        let text = xml_unescape(&strip_xml_tags(text_raw));
        if text.trim().is_empty() {
            continue;
        }

        out.push_str(&format!("{index}\n"));
        out.push_str(&format!(
            "{} --> {}\n",
            format_srt_timestamp(start_ms / 1000.0),
            format_srt_timestamp((start_ms + dur_ms) / 1000.0)
        ));
        out.push_str(&text);
        out.push_str("\n\n");
        index += 1;
    }
    out
}

fn extract_xml_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

fn strip_xml_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn format_srt_timestamp(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
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
        .map_err(|_| "timed out waiting for the Google login to complete".to_string())?
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

    let body = "<html><body>ClipFlow: Google account connected. You can close this tab.</body></html>";
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
