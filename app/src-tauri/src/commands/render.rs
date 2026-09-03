use crate::db::Db;
use crate::ffmpeg;
use crate::render_manager::{self, RenderManager};
use crate::transcript;
use rusqlite::params;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

/// Extracts a clip's time range from its parent project's movie file into
/// `<app_data_dir>/renders/<clip_id>.mp4` so it can be played in-app before upload
/// (NEXT_PHASE.md Phase 3 — preview only, not the template-based final render).
///
/// Goes through `RenderManager`'s single-permit semaphore so that firing this (or
/// `render_clip_final`) for several clips back to back queues the actual ffmpeg work
/// instead of running multiple encodes at once — see render_manager.rs's module doc.
/// Navigating away in the frontend doesn't cancel this: it's a plain awaited Tauri command
/// that keeps running server-side regardless of whether anything is still awaiting it.
#[tauri::command]
pub async fn render_clip_preview(app: AppHandle, db: State<'_, Db>, clip_id: String) -> Result<String, String> {
    let job_id = render_manager::insert_job(&app, &clip_id, "preview", None)?;
    let manager = app.state::<RenderManager>();
    let semaphore = manager.semaphore.clone();
    let _permit = semaphore.acquire_owned().await.map_err(|e| e.to_string())?;
    render_manager::set_status(&app, &job_id, "rendering", None);

    let result = render_clip_preview_inner(&app, &db, &clip_id).await;

    match &result {
        Ok(_) => render_manager::set_status(&app, &job_id, "completed", None),
        Err(e) => render_manager::set_status(&app, &job_id, "failed", Some(e)),
    }
    result
}

async fn render_clip_preview_inner(app: &AppHandle, db: &State<'_, Db>, clip_id: &str) -> Result<String, String> {
    let (movie_path, start_seconds, end_seconds) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT p.movie_path, c.start_seconds, c.end_seconds
             FROM clips c JOIN projects p ON p.id = c.project_id
             WHERE c.id = ?1",
            params![clip_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?)),
        )
        .map_err(|e| e.to_string())?
    };

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let output_path = app_data_dir.join("renders").join(format!("{clip_id}.mp4"));

    ffmpeg::extract_clip(&movie_path, start_seconds, end_seconds, &output_path)?;

    let output_path_str = output_path.to_string_lossy().to_string();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clips SET output_path = ?1, status = 'ready' WHERE id = ?2",
            params![output_path_str, clip_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(output_path_str)
}

/// Renders a clip through a saved template's full pipeline (SPEC.md sections 4/5) — the
/// platform-ready final render, as opposed to `render_clip_preview`'s raw trim. Shares
/// `RenderManager`'s semaphore with `render_clip_preview` — see its doc comment.
#[tauri::command]
pub async fn render_clip_final(
    app: AppHandle,
    db: State<'_, Db>,
    clip_id: String,
    template_id: String,
) -> Result<String, String> {
    let job_id = render_manager::insert_job(&app, &clip_id, "final", Some(&template_id))?;
    let manager = app.state::<RenderManager>();
    let semaphore = manager.semaphore.clone();
    let _permit = semaphore.acquire_owned().await.map_err(|e| e.to_string())?;
    render_manager::set_status(&app, &job_id, "rendering", None);

    let result = render_clip_final_inner(&app, &db, &clip_id, &template_id).await;

    match &result {
        Ok(_) => render_manager::set_status(&app, &job_id, "completed", None),
        Err(e) => render_manager::set_status(&app, &job_id, "failed", Some(e)),
    }
    result
}

async fn render_clip_final_inner(
    app: &AppHandle,
    db: &State<'_, Db>,
    clip_id: &str,
    template_id: &str,
) -> Result<String, String> {
    let (movie_path, start_seconds, end_seconds, ai_caption, part_number, config_json, transcript_path, transcript_offset_seconds) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (movie_path, start_seconds, end_seconds, ai_caption, project_id, kind, transcript_path, transcript_offset_seconds): (
            String,
            f64,
            f64,
            Option<String>,
            String,
            String,
            Option<String>,
            f64,
        ) = conn
            .query_row(
                "SELECT p.movie_path, c.start_seconds, c.end_seconds, c.ai_caption, c.project_id, c.kind, p.transcript_path, p.transcript_offset_seconds
                 FROM clips c JOIN projects p ON p.id = c.project_id
                 WHERE c.id = ?1",
                params![clip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
            )
            .map_err(|e| e.to_string())?;
        // 1-based rank of this clip among same-project, same-kind siblings ordered by
        // start_seconds — matches the frontend timeline's "Part N" numbering exactly.
        let part_number: i64 = conn
            .query_row(
                "SELECT COUNT(*) + 1 FROM clips WHERE project_id = ?1 AND kind = ?2 AND start_seconds < ?3",
                params![project_id, kind, start_seconds],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let config_json: String = conn
            .query_row(
                "SELECT config_json FROM templates WHERE id = ?1",
                params![template_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        (movie_path, start_seconds, end_seconds, ai_caption, part_number, config_json, transcript_path, transcript_offset_seconds)
    };

    let mut template: ffmpeg::TemplateConfig =
        serde_json::from_str(&config_json).map_err(|e| format!("invalid template config: {e}"))?;
    // The template stores literal placeholders "{ai_caption}"/"{part_number}" — substitute
    // the clip's actual values before burning either caption into the frame (matches the
    // live preview's resolveCaptionText() in app/src/lib/templatePreview.ts). Both
    // placeholders are supported in both caption slots — e.g. nothing stops a "Part
    // {part_number}: {ai_caption}" style combined caption.
    let resolve = |text: &str| -> String {
        text.replace("{ai_caption}", ai_caption.as_deref().unwrap_or(""))
            .replace("{part_number}", &part_number.to_string())
    };
    template.caption.text = resolve(&template.caption.text);
    template.caption2.text = resolve(&template.caption2.text);

    // Transcript entries overlapping this clip's time range, shifted from the movie's
    // absolute timeline to clip-relative seconds — `-ss` before `-i` in render_final already
    // zeroes ffmpeg's own `t` at the trim point, so `drawtext`'s `enable=between(t,...)` for
    // each cue needs to agree with that same zero point. Silently empty (not an error) when
    // there's no transcript, or subtitles are off — most templates won't use this track.
    let subtitle_cues: Vec<(f64, f64, String)> = if template.subtitle.enabled {
        transcript_path
            .as_deref()
            .and_then(|path| transcript::parse_transcript(Path::new(path)).ok())
            .map(|(_, mut entries)| {
                transcript::apply_offset(&mut entries, transcript_offset_seconds);
                transcript::compute_cues(&entries, start_seconds, end_seconds)
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let output_path = app_data_dir
        .join("renders")
        .join("final")
        .join(format!("{clip_id}_{template_id}.mp4"));

    ffmpeg::render_final(&movie_path, start_seconds, end_seconds, &template, &subtitle_cues, &output_path)?;

    let output_path_str = output_path.to_string_lossy().to_string();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clips SET final_output_path = ?1 WHERE id = ?2",
            params![output_path_str, clip_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(output_path_str)
}

/// Cached single-frame thumbnail — used for the movie thumbnail and per-clip timeline
/// thumbnails in the project editor UI. `cache_key` is caller-chosen (project id or clip
/// id); regeneration is skipped if a thumbnail for that key already exists on disk.
#[tauri::command]
pub async fn get_thumbnail(
    app: AppHandle,
    movie_path: String,
    seek_seconds: f64,
    cache_key: String,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let output_path = app_data_dir.join("thumbnails").join(format!("{cache_key}.jpg"));

    if !output_path.exists() {
        ffmpeg::extract_thumbnail(&movie_path, seek_seconds, &output_path)?;
    }

    Ok(output_path.to_string_lossy().to_string())
}

/// Currently queued/in-progress render jobs (preview or final, any project) — lets the
/// frontend show a small background-work indicator instead of the user having to guess
/// whether a render they kicked off earlier (possibly from a project they've since
/// navigated away from) is still running.
#[tauri::command]
pub async fn get_render_queue(db: State<'_, Db>) -> Result<Vec<render_manager::RenderQueueItem>, String> {
    render_manager::get_queue(&db)
}

#[derive(serde::Serialize)]
pub struct SubtitleCueDto {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Same clip-relative cue timing `render_final` burns into the video (via
/// `transcript::compute_cues`), exposed to the frontend so the in-app live preview (the
/// raw-trim CSS overlay, before a real render exists) can show the same subtitle lines at
/// the same instants instead of only showing them once uploaded. Empty (not an error) when
/// the project has no transcript.
#[tauri::command]
pub async fn get_clip_subtitle_cues(db: State<'_, Db>, clip_id: String) -> Result<Vec<SubtitleCueDto>, String> {
    let (start_seconds, end_seconds, transcript_path, transcript_offset_seconds): (f64, f64, Option<String>, f64) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT c.start_seconds, c.end_seconds, p.transcript_path, p.transcript_offset_seconds
             FROM clips c JOIN projects p ON p.id = c.project_id
             WHERE c.id = ?1",
            params![clip_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?
    };
    let Some(transcript_path) = transcript_path else { return Ok(Vec::new()) };
    let Ok((_, mut entries)) = transcript::parse_transcript(Path::new(&transcript_path)) else {
        return Ok(Vec::new());
    };
    transcript::apply_offset(&mut entries, transcript_offset_seconds);
    Ok(transcript::compute_cues(&entries, start_seconds, end_seconds)
        .into_iter()
        .map(|(start, end, text)| SubtitleCueDto { start, end, text })
        .collect())
}
