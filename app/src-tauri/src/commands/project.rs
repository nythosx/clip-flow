use crate::ai_client::AiClient;
use crate::db::Db;
use crate::transcript::{self, TranscriptFormat};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Tracks the currently in-flight AI requestId for each `"{project_id}:{mode}"` pair so
/// `cancel_analysis` can find and interrupt it. Entries only exist while an AI call for
/// that project+mode is actually awaiting a response.
#[derive(Default)]
pub struct AnalysisRegistry(pub Mutex<HashMap<String, String>>);

fn registry_key(project_id: &str, mode: &str) -> String {
    format!("{project_id}:{mode}")
}

/// Serializes caption generation per project — every clip's "Generate with AI" (and the
/// batch `generate_missing_captions`) shares one AI Engine browser tab per project
/// (`sessionKey = "{project_id}:caption"`, see `generate_and_save_caption`'s doc comment).
/// Firing two of those concurrently (e.g. clicking Generate on clip B before clip A's
/// request finished) let the AI Engine's single-tab orchestration cross the wires and hand
/// clip B the response actually meant for clip A. Holding this lock for the full
/// request+save of each caption call makes that overlap structurally impossible instead of
/// relying on the external AI Engine to get tab/request correlation right.
#[derive(Default)]
pub struct CaptionLocks(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl CaptionLocks {
    fn get(&self, project_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(project_id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }
}

/// Wraps an AI call with cancellation bookkeeping: generates the requestId up front,
/// registers it under `key` for the duration of the call, and always deregisters it after
/// (success, failure, or — if cancelled — the "Cancelled by user" error `AiClient::cancel_request`
/// injects).
async fn call_ai_tracked(
    ai: &Arc<AiClient>,
    registry: &AnalysisRegistry,
    key: &str,
    mut payload: Value,
) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    payload["requestId"] = json!(request_id);
    registry.0.lock().map_err(|e| e.to_string())?.insert(key.to_string(), request_id);
    let result = ai.call_ai_default_timeout(payload).await;
    registry.0.lock().map_err(|e| e.to_string())?.remove(key);
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub movie_path: String,
    pub transcript_path: Option<String>,
    pub transcript_format: Option<String>,
    pub source_resolution_width: Option<i64>,
    pub source_resolution_height: Option<i64>,
    pub source_duration_seconds: Option<f64>,
    pub trimmed_start_seconds: Option<f64>,
    pub trimmed_end_seconds: Option<f64>,
    pub source_thumbnail_url: Option<String>,
    pub status: String,
    pub clips_status: String,
    pub movie_status: String,
    pub clips_count: i64,
    pub parts_count: i64,
    pub trending_hashtags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

// Subquery-based column list (instead of `SELECT *`) so every project row carries its
// clip/part counts for the sidebar project switcher without an N+1 query per project.
const PROJECT_SELECT: &str = "
    SELECT p.*,
        (SELECT COUNT(*) FROM clips WHERE clips.project_id = p.id AND clips.kind = 'clip') AS clips_count,
        (SELECT COUNT(*) FROM clips WHERE clips.project_id = p.id AND clips.kind = 'part') AS parts_count
    FROM projects p
";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub project_id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub hook_reason: Option<String>,
    pub transcript_excerpt: Option<String>,
    pub ai_caption: Option<String>,
    pub custom_caption: Option<String>,
    pub output_path: Option<String>,
    pub final_output_path: Option<String>,
    pub status: String,
    pub kind: String,
    pub hashtags: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAnalysisProgress {
    pub project_id: String,
    pub mode: String, // "clips" | "movie"
    pub stage: String,
    pub progress: f64,
}

fn row_to_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    let trending_hashtags_json: String = row.get("trending_hashtags")?;
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        movie_path: row.get("movie_path")?,
        transcript_path: row.get("transcript_path")?,
        transcript_format: row.get("transcript_format")?,
        source_resolution_width: row.get("source_resolution_width")?,
        source_resolution_height: row.get("source_resolution_height")?,
        source_duration_seconds: row.get("source_duration_seconds")?,
        trimmed_start_seconds: row.get("trimmed_start_seconds")?,
        trimmed_end_seconds: row.get("trimmed_end_seconds")?,
        source_thumbnail_url: row.get("source_thumbnail_url")?,
        status: row.get("status")?,
        clips_status: row.get("clips_status")?,
        movie_status: row.get("movie_status")?,
        clips_count: row.get("clips_count")?,
        parts_count: row.get("parts_count")?,
        trending_hashtags: serde_json::from_str(&trending_hashtags_json).unwrap_or_default(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_clip(row: &rusqlite::Row) -> rusqlite::Result<Clip> {
    let hashtags_json: String = row.get("hashtags")?;
    Ok(Clip {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        start_seconds: row.get("start_seconds")?,
        end_seconds: row.get("end_seconds")?,
        hook_reason: row.get("hook_reason")?,
        transcript_excerpt: row.get("transcript_excerpt")?,
        ai_caption: row.get("ai_caption")?,
        custom_caption: row.get("custom_caption")?,
        output_path: row.get("output_path")?,
        final_output_path: row.get("final_output_path")?,
        status: row.get("status")?,
        kind: row.get("kind")?,
        hashtags: serde_json::from_str(&hashtags_json).unwrap_or_default(),
        created_at: row.get("created_at")?,
    })
}

#[tauri::command]
pub async fn create_project(
    db: State<'_, Db>,
    name: String,
    movie_path: String,
    transcript_path: String,
) -> Result<Project, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let transcript_format = if transcript_path.is_empty() {
        None
    } else {
        let (format, _entries) =
            transcript::parse_transcript(Path::new(&transcript_path)).map_err(|e| e.to_string())?;
        Some(match format {
            TranscriptFormat::Srt => "srt",
            TranscriptFormat::Vtt => "vtt",
            TranscriptFormat::Plain => "plain",
        })
    };

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO projects (id, name, movie_path, transcript_path, transcript_format) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            id,
            name,
            movie_path,
            if transcript_path.is_empty() { None } else { Some(&transcript_path) },
            transcript_format
        ],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), params![id], row_to_project)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_projects(db: State<'_, Db>) -> Result<Vec<Project>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{PROJECT_SELECT} ORDER BY p.created_at DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_project)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn get_project(db: State<'_, Db>, id: String) -> Result<Project, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), params![id], row_to_project)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_clips(db: State<'_, Db>, project_id: String) -> Result<Vec<Clip>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT * FROM clips WHERE project_id = ?1 ORDER BY start_seconds ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], row_to_clip)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Sets a project's display thumbnail to an external image URL — used right after
/// `youtube_import_project` creates the project, so the sidebar switcher shows the video's
/// actual YouTube thumbnail rather than an ffmpeg-extracted frame of the downloaded file.
#[tauri::command]
pub async fn set_project_thumbnail(db: State<'_, Db>, id: String, thumbnail_url: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE projects SET source_thumbnail_url = ?1 WHERE id = ?2",
        params![thumbnail_url, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_project_name(db: State<'_, Db>, id: String, name: String) -> Result<Project, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE projects SET name = ?1 WHERE id = ?2", params![name, id])
        .map_err(|e| e.to_string())?;
    conn.query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), params![id], row_to_project)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_project(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_clip_caption(db: State<'_, Db>, clip_id: String, caption: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE clips SET ai_caption = ?1 WHERE id = ?2",
        params![caption, clip_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Separate from `update_clip_caption` on purpose — this is the user's own hand-written
/// caption, never touched by "Generate with AI" (which only ever writes `ai_caption`).
#[tauri::command]
pub async fn update_clip_custom_caption(db: State<'_, Db>, clip_id: String, caption: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE clips SET custom_caption = ?1 WHERE id = ?2",
        params![caption, clip_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_progress(app: &AppHandle, project_id: &str, mode: &str, stage: &str, progress: f64) {
    let _ = app.emit(
        "project_analysis_progress",
        ProjectAnalysisProgress {
            project_id: project_id.to_string(),
            mode: mode.to_string(),
            stage: stage.to_string(),
            progress,
        },
    );
}

// `column` is always one of the two hardcoded literals below (never caller-controlled),
// so interpolating it into the SQL string here doesn't open an injection path.
fn set_mode_status(conn: &rusqlite::Connection, project_id: &str, column: &str, status: &str) -> Result<(), String> {
    conn.execute(
        &format!("UPDATE projects SET {column} = ?1, updated_at = datetime('now') WHERE id = ?2"),
        params![status, project_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Runs Smart Trimmer then Clip Finder against the AI Engine (SPEC.md section 6.A/B) and
/// persists the resulting best-highlights clips (`kind = 'clip'`). Caption Generator is a
/// separate per-clip command (`generate_clip_caption`), not called here.
#[tauri::command]
pub async fn analyze_clips(
    app: AppHandle,
    db: State<'_, Db>,
    ai: State<'_, Arc<AiClient>>,
    registry: State<'_, AnalysisRegistry>,
    caption_locks: State<'_, CaptionLocks>,
    id: String,
) -> Result<(), String> {
    let (transcript_path, existing_status) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let project = conn
            .query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), params![id], row_to_project)
            .map_err(|e| e.to_string())?;
        (project.transcript_path, project.clips_status)
    };
    let Some(transcript_path) = transcript_path else {
        return Err("Project has no transcript to analyze".to_string());
    };
    if existing_status == "analyzing" {
        return Err("Clips are already being analyzed".to_string());
    }

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        set_mode_status(&conn, &id, "clips_status", "analyzing")?;
    }
    emit_progress(&app, &id, "clips", "parsing_transcript", 0.05);

    let (_format, entries) =
        transcript::parse_transcript(Path::new(&transcript_path)).map_err(|e| e.to_string())?;
    if entries.is_empty() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        set_mode_status(&conn, &id, "clips_status", "error")?;
        return Err("Transcript parsed to zero entries — nothing to analyze".to_string());
    }
    let total_duration = entries.iter().map(|e| e.end).fold(0.0_f64, f64::max);

    // SPEC.md section 6.A: "excerpt showing first 5 minutes and last 5 minutes".
    let excerpt: String = entries
        .iter()
        .filter(|e| e.start <= 300.0 || e.start >= total_duration - 300.0)
        .map(|e| format!("[{}] {}", transcript::format_timestamp(e.start), e.text))
        .collect::<Vec<_>>()
        .join("\n");

    emit_progress(&app, &id, "clips", "smart_trimmer", 0.2);
    let trim_result = call_ai_tracked(
        &ai,
        &registry,
        &registry_key(&id, "clips"),
        json!({
            "type": "trim_analysis",
            "sessionKey": format!("{id}:trim"),
            "transcript": excerpt,
            "duration": transcript::format_timestamp(total_duration),
        }),
    )
    .await
    .map_err(|e| {
        let _ = mark_error(&db, &id, "clips_status");
        format!("Smart Trimmer failed: {e}")
    })?;

    let removed: Vec<(f64, f64)> = trim_result
        .get("segments")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|seg| {
                    let start = transcript::parse_timestamp(seg.get("start")?.as_str()?)?;
                    let end = transcript::parse_timestamp(seg.get("end")?.as_str()?)?;
                    Some((start, end))
                })
                .collect()
        })
        .unwrap_or_default();

    let is_removed = |t: f64| removed.iter().any(|(s, e)| t >= *s && t < *e);
    let cleaned_entries: Vec<_> = entries.iter().filter(|e| !is_removed(e.start)).collect();
    let cleaned_transcript: String = cleaned_entries
        .iter()
        .map(|e| format!("[{}] {}", transcript::format_timestamp(e.start), e.text))
        .collect::<Vec<_>>()
        .join("\n");

    // Best-effort derivation of the kept range from what got removed at the very start/end.
    let trimmed_start = removed.iter().find(|(s, _)| *s <= 0.5).map(|(_, e)| *e);
    let trimmed_end = removed
        .iter()
        .find(|(_, e)| *e >= total_duration - 0.5)
        .map(|(s, _)| *s);

    emit_progress(&app, &id, "clips", "clip_finder", 0.5);
    let clip_result = call_ai_tracked(
        &ai,
        &registry,
        &registry_key(&id, "clips"),
        json!({
            "type": "clip_finder",
            "sessionKey": format!("{id}:clips"),
            "transcript": cleaned_transcript,
            "count": 8,
        }),
    )
    .await
    .map_err(|e| {
        let _ = mark_error(&db, &id, "clips_status");
        format!("Clip Finder failed: {e}")
    })?;

    let clips: Vec<(f64, f64, Option<String>)> = clip_result
        .get("clips")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let start = transcript::parse_timestamp(c.get("start")?.as_str()?)?;
                    let end = transcript::parse_timestamp(c.get("end")?.as_str()?)?;
                    let hook = c.get("hook").and_then(|h| h.as_str()).map(|s| s.to_string());
                    Some((start, end, hook))
                })
                .collect()
        })
        .unwrap_or_default();

    emit_progress(&app, &id, "clips", "saving", 0.9);
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for (start, end, hook) in &clips {
            let excerpt_text: String = entries
                .iter()
                .filter(|e| e.start >= *start && e.start <= *end)
                .map(|e| e.text.clone())
                .collect::<Vec<_>>()
                .join(" ");
            conn.execute(
                "INSERT INTO clips (id, project_id, start_seconds, end_seconds, hook_reason, transcript_excerpt, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'clip')",
                params![uuid::Uuid::new_v4().to_string(), id, start, end, hook, excerpt_text],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE projects SET status = 'ready', clips_status = 'ready', trimmed_start_seconds = ?1, trimmed_end_seconds = ?2, source_duration_seconds = ?3, updated_at = datetime('now') WHERE id = ?4",
            params![trimmed_start, trimmed_end, total_duration, id],
        )
        .map_err(|e| e.to_string())?;
    }

    backfill_missing_captions(&app, &db, &ai, &registry, &caption_locks, &id, "clips", "clip").await;

    emit_progress(&app, &id, "clips", "done", 1.0);
    Ok(())
}

/// Splits the whole (trimmed) runtime into sequential Part 1, Part 2, ... chunks
/// (`kind = 'part'`) at AI-detected natural scene/topic breaks, instead of picking best
/// moments. Coexists with `analyze_clips` — both write into the same `clips` table so
/// preview/render/template/upload-queue all work on a Part exactly like a Clip.
#[tauri::command]
pub async fn analyze_movie(
    app: AppHandle,
    db: State<'_, Db>,
    ai: State<'_, Arc<AiClient>>,
    registry: State<'_, AnalysisRegistry>,
    caption_locks: State<'_, CaptionLocks>,
    id: String,
) -> Result<(), String> {
    let (transcript_path, existing_status) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let project = conn
            .query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), params![id], row_to_project)
            .map_err(|e| e.to_string())?;
        (project.transcript_path, project.movie_status)
    };
    let Some(transcript_path) = transcript_path else {
        return Err("Project has no transcript to analyze".to_string());
    };
    if existing_status == "analyzing" {
        return Err("Full movie is already being analyzed".to_string());
    }

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        set_mode_status(&conn, &id, "movie_status", "analyzing")?;
    }
    emit_progress(&app, &id, "movie", "parsing_transcript", 0.05);

    let (_format, entries) =
        transcript::parse_transcript(Path::new(&transcript_path)).map_err(|e| e.to_string())?;
    if entries.is_empty() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        set_mode_status(&conn, &id, "movie_status", "error")?;
        return Err("Transcript parsed to zero entries — nothing to analyze".to_string());
    }
    let total_duration = entries.iter().map(|e| e.end).fold(0.0_f64, f64::max);

    let excerpt: String = entries
        .iter()
        .filter(|e| e.start <= 300.0 || e.start >= total_duration - 300.0)
        .map(|e| format!("[{}] {}", transcript::format_timestamp(e.start), e.text))
        .collect::<Vec<_>>()
        .join("\n");

    // Own session key (not shared with analyze_clips's trim session) so the two modes'
    // AI conversations don't contend or cross-talk.
    emit_progress(&app, &id, "movie", "smart_trimmer", 0.2);
    let trim_result = call_ai_tracked(
        &ai,
        &registry,
        &registry_key(&id, "movie"),
        json!({
            "type": "trim_analysis",
            "sessionKey": format!("{id}:movie-trim"),
            "transcript": excerpt,
            "duration": transcript::format_timestamp(total_duration),
        }),
    )
    .await
    .map_err(|e| {
        let _ = mark_error(&db, &id, "movie_status");
        format!("Smart Trimmer failed: {e}")
    })?;

    let removed: Vec<(f64, f64)> = trim_result
        .get("segments")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|seg| {
                    let start = transcript::parse_timestamp(seg.get("start")?.as_str()?)?;
                    let end = transcript::parse_timestamp(seg.get("end")?.as_str()?)?;
                    Some((start, end))
                })
                .collect()
        })
        .unwrap_or_default();

    let is_removed = |t: f64| removed.iter().any(|(s, e)| t >= *s && t < *e);
    let cleaned_entries: Vec<_> = entries.iter().filter(|e| !is_removed(e.start)).collect();
    let cleaned_transcript: String = cleaned_entries
        .iter()
        .map(|e| format!("[{}] {}", transcript::format_timestamp(e.start), e.text))
        .collect::<Vec<_>>()
        .join("\n");

    let trimmed_start = removed.iter().find(|(s, _)| *s <= 0.5).map(|(_, e)| *e);
    let trimmed_end = removed
        .iter()
        .find(|(_, e)| *e >= total_duration - 0.5)
        .map(|(s, _)| *s);

    emit_progress(&app, &id, "movie", "movie_segmenter", 0.5);
    let segment_result = call_ai_tracked(
        &ai,
        &registry,
        &registry_key(&id, "movie"),
        json!({
            "type": "movie_segmenter",
            "sessionKey": format!("{id}:movie-segments"),
            "transcript": cleaned_transcript,
            "duration": transcript::format_timestamp(total_duration),
        }),
    )
    .await
    .map_err(|e| {
            let _ = mark_error(&db, &id, "movie_status");
            format!("Movie Segmenter failed: {e}")
        })?;

    let parts: Vec<(f64, f64)> = segment_result
        .get("parts")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let start = transcript::parse_timestamp(p.get("start")?.as_str()?)?;
                    let end = transcript::parse_timestamp(p.get("end")?.as_str()?)?;
                    Some((start, end))
                })
                .collect()
        })
        .unwrap_or_default();

    emit_progress(&app, &id, "movie", "saving", 0.9);
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for (start, end) in &parts {
            let excerpt_text: String = entries
                .iter()
                .filter(|e| e.start >= *start && e.start <= *end)
                .map(|e| e.text.clone())
                .collect::<Vec<_>>()
                .join(" ");
            conn.execute(
                "INSERT INTO clips (id, project_id, start_seconds, end_seconds, transcript_excerpt, kind) VALUES (?1, ?2, ?3, ?4, ?5, 'part')",
                params![uuid::Uuid::new_v4().to_string(), id, start, end, excerpt_text],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE projects SET movie_status = 'ready', trimmed_start_seconds = ?1, trimmed_end_seconds = ?2, source_duration_seconds = ?3, updated_at = datetime('now') WHERE id = ?4",
            params![trimmed_start, trimmed_end, total_duration, id],
        )
        .map_err(|e| e.to_string())?;
    }

    backfill_missing_captions(&app, &db, &ai, &registry, &caption_locks, &id, "movie", "part").await;

    emit_progress(&app, &id, "movie", "done", 1.0);
    Ok(())
}

/// Interrupts an in-flight `analyze_clips`/`analyze_movie` call for this project+mode.
/// The awaiting call gets an immediate "Cancelled by user" error, which flows through that
/// command's existing error handling (marks `clips_status`/`movie_status` = 'error') —
/// there's no separate "cancelled" state to keep in sync. A no-op (not an error) if nothing
/// was actually in flight, since that's a harmless race (e.g. it just finished on its own).
#[tauri::command]
pub async fn cancel_analysis(
    ai: State<'_, Arc<AiClient>>,
    registry: State<'_, AnalysisRegistry>,
    project_id: String,
    mode: String,
) -> Result<(), String> {
    let request_id = registry.0.lock().map_err(|e| e.to_string())?.remove(&registry_key(&project_id, &mode));
    if let Some(request_id) = request_id {
        ai.cancel_request(&request_id).await;
    }
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCaption {
    pub caption: String,
    pub hashtags: Vec<String>,
}

/// Auto-generates captions for every clip/part in a project still missing one, right after
/// analysis finishes — so captions show up without a separate manual step, while staying
/// editable afterward (`update_clip_caption`/regenerable via `generate_clip_caption`).
/// Best-effort: one clip's caption failing doesn't fail the whole analyze command (the
/// clips/parts themselves are already saved and usable) — it's just skipped, still
/// generatable manually later. A cancellation, though, stops the whole backfill rather than
/// skipping to the next clip, matching what hitting Stop should mean.
async fn backfill_missing_captions(
    app: &AppHandle,
    db: &State<'_, Db>,
    ai: &Arc<AiClient>,
    registry: &AnalysisRegistry,
    caption_locks: &CaptionLocks,
    project_id: &str,
    mode: &str,
    kind: &str,
) {
    let clip_ids: Vec<String> = {
        let Ok(conn) = db.0.lock() else { return };
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM clips WHERE project_id = ?1 AND kind = ?2 AND (ai_caption IS NULL OR ai_caption = '')",
        ) else {
            return;
        };
        let Ok(rows) = stmt.query_map(params![project_id, kind], |row| row.get::<_, String>(0)) else {
            return;
        };
        rows.filter_map(|r| r.ok()).collect()
    };

    let total = clip_ids.len().max(1);
    for (i, clip_id) in clip_ids.iter().enumerate() {
        emit_progress(app, project_id, mode, "captions", 0.9 + 0.09 * ((i + 1) as f64 / total as f64));
        if let Err(e) = generate_and_save_caption(ai, db, registry, caption_locks, project_id, mode, clip_id).await {
            if e.contains("Cancelled by user") {
                break;
            }
            log::warn!("[analyze] caption generation failed for clip {clip_id}: {e}");
        }
    }
}

/// Calls the AI Engine's Caption Generator (SPEC.md section 6.C) for one clip and persists
/// the result — shared by the standalone `generate_clip_caption` command and the automatic
/// missing-caption backfill in `analyze_clips`/`analyze_movie`.
///
/// `sessionKey` is `"{project_id}:caption"` — one shared chat tab per *project*, not one
/// per clip. Generating captions for many clips used to open a brand-new browser tab per
/// clip (via a `{clip_id}:caption` sessionKey), and enough tabs piled up quickly enough to
/// make a later call fail; content.js then resolved with `{error}` instead of throwing,
/// which orchestrator.js used to hand back as `undefined` text, surfacing far downstream as
/// "Cannot read properties of undefined (reading 'trim')". Reusing one tab per project fixes
/// the pileup at the root, and the `res.error` checks added to orchestrator.js turn any
/// future failure into a real, readable error instead of that crash.
async fn generate_and_save_caption(
    ai: &Arc<AiClient>,
    db: &State<'_, Db>,
    registry: &AnalysisRegistry,
    caption_locks: &CaptionLocks,
    project_id: &str,
    mode: &str,
    clip_id: &str,
) -> Result<GeneratedCaption, String> {
    // Held for this whole request+save — see CaptionLocks's doc comment for why (the AI
    // Engine's single shared browser tab per project can't safely serve two caption
    // requests at once).
    let lock = caption_locks.get(project_id);
    let _guard = lock.lock().await;

    let (excerpt, hook): (Option<String>, Option<String>) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT transcript_excerpt, hook_reason FROM clips WHERE id = ?1",
            params![clip_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?
    };

    let result = call_ai_tracked(
        ai,
        registry,
        &registry_key(project_id, mode),
        json!({
            "type": "caption_generate",
            "sessionKey": format!("{project_id}:caption"),
            "excerpt": excerpt.unwrap_or_default(),
            "hook": hook.unwrap_or_default(),
        }),
    )
    .await
    .map_err(|e| format!("Caption Generator failed: {e}"))?;

    let caption = result
        .get("caption")
        .and_then(|c| c.as_str())
        .ok_or("Caption Generator returned no caption text")?
        .to_string();
    let hashtags: Vec<String> = result
        .get("hashtags")
        .and_then(|h| h.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let hashtags_json = serde_json::to_string(&hashtags).unwrap_or_else(|_| "[]".to_string());

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clips SET ai_caption = ?1, hashtags = ?2 WHERE id = ?3",
            params![caption, hashtags_json, clip_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(GeneratedCaption { caption, hashtags })
}

/// Calls the AI Engine's Caption Generator for a single clip and persists the result —
/// the manual "Generate with AI" button's command.
#[tauri::command]
pub async fn generate_clip_caption(
    db: State<'_, Db>,
    ai: State<'_, Arc<AiClient>>,
    registry: State<'_, AnalysisRegistry>,
    caption_locks: State<'_, CaptionLocks>,
    clip_id: String,
) -> Result<GeneratedCaption, String> {
    let project_id: String = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT project_id FROM clips WHERE id = ?1", params![clip_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
    };
    generate_and_save_caption(&ai, &db, &registry, &caption_locks, &project_id, "caption", &clip_id).await
}

/// "Generate all missing captions" button's command — same per-clip work
/// `generate_clip_caption` does, just looped over every clip/part in `kind` that doesn't
/// have an AI caption yet, one at a time (the shared-tab serialization in
/// `generate_and_save_caption` would force that anyway, but doing it here means the
/// frontend gets one command call instead of firing N concurrent ones that'd just queue).
#[tauri::command]
pub async fn generate_missing_captions(
    app: AppHandle,
    db: State<'_, Db>,
    ai: State<'_, Arc<AiClient>>,
    registry: State<'_, AnalysisRegistry>,
    caption_locks: State<'_, CaptionLocks>,
    project_id: String,
    kind: String,
) -> Result<(), String> {
    let mode = if kind == "part" { "movie" } else { "clips" };
    backfill_missing_captions(&app, &db, &ai, &registry, &caption_locks, &project_id, mode, &kind).await;
    Ok(())
}

/// One clip's caption as sent to/received from the caption-refine batch review.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinedCaption {
    pub clip_id: String,
    pub caption: String,
}

/// Batch-reviews every already-generated caption in a project against the same shared
/// context (each other + the transcript) instead of the one-clip-in-isolation view
/// `generate_and_save_caption` has — so it can catch and fix problems that only show up
/// across the set: near-duplicate hooks between clips, captions that read too formal/long,
/// or ones that aren't actually algorithm-optimized. Runs on a dedicated
/// `"{project_id}:caption-refine"` chat tab, deliberately separate from the per-clip
/// `"{project_id}:caption"` session, so the review sees the captions as a finished batch
/// rather than continuing the same conversation that generated them one at a time.
#[tauri::command]
pub async fn refine_captions(
    db: State<'_, Db>,
    ai: State<'_, Arc<AiClient>>,
    registry: State<'_, AnalysisRegistry>,
    caption_locks: State<'_, CaptionLocks>,
    project_id: String,
    kind: String,
) -> Result<Vec<RefinedCaption>, String> {
    let lock = caption_locks.get(&project_id);
    let _guard = lock.lock().await;

    let items: Vec<(String, Option<String>, String)> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, transcript_excerpt, ai_caption FROM clips
                 WHERE project_id = ?1 AND kind = ?2 AND ai_caption IS NOT NULL AND ai_caption != ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_id, kind], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    if items.is_empty() {
        return Ok(Vec::new());
    }

    let mode = if kind == "part" { "movie" } else { "clips" };
    let payload_items: Vec<Value> = items
        .iter()
        .map(|(id, excerpt, caption)| json!({ "id": id, "excerpt": excerpt.clone().unwrap_or_default(), "caption": caption }))
        .collect();

    let result = call_ai_tracked(
        &ai,
        &registry,
        &registry_key(&project_id, mode),
        json!({
            "type": "caption_refine",
            "sessionKey": format!("{project_id}:caption-refine"),
            "items": payload_items,
        }),
    )
    .await
    .map_err(|e| format!("Caption Refiner failed: {e}"))?;

    let refined: Vec<RefinedCaption> = result
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("Caption Refiner returned no items")?
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let caption = item.get("caption")?.as_str()?.to_string();
            Some(RefinedCaption { clip_id: id, caption })
        })
        .collect();

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for r in &refined {
            conn.execute(
                "UPDATE clips SET ai_caption = ?1 WHERE id = ?2",
                params![r.caption, r.clip_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(refined)
}

/// Asks the AI Engine for hashtags actually trending right now (explicitly excluding
/// evergreen tags like #fyp that carry no real algorithmic signal) and saves them on the
/// project, so every clip queued from it picks them up (`build_tiktok_title` in
/// `queue_manager.rs`) without re-fetching per clip.
#[tauri::command]
pub async fn fetch_trending_hashtags(
    db: State<'_, Db>,
    ai: State<'_, Arc<AiClient>>,
    registry: State<'_, AnalysisRegistry>,
    project_id: String,
) -> Result<Vec<String>, String> {
    let result = call_ai_tracked(
        &ai,
        &registry,
        &registry_key(&project_id, "trending-hashtags"),
        json!({
            "type": "trending_hashtags",
            "niche": "short movie/TV clips and edits posted to TikTok",
        }),
    )
    .await
    .map_err(|e| format!("Trending Hashtags call failed: {e}"))?;

    let hashtags: Vec<String> = result
        .get("hashtags")
        .and_then(|h| h.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .ok_or("Trending Hashtags call returned no hashtags")?;

    let hashtags_json = serde_json::to_string(&hashtags).unwrap_or_else(|_| "[]".to_string());
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE projects SET trending_hashtags = ?1 WHERE id = ?2",
            params![hashtags_json, project_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(hashtags)
}

fn mark_error(db: &State<'_, Db>, project_id: &str, column: &str) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    set_mode_status(&conn, project_id, column, "error")
}
