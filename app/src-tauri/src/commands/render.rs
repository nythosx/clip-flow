use crate::db::Db;
use crate::ffmpeg;
use crate::queue_manager;
use crate::render_manager::{self, RenderManager};
use crate::transcript;
use rusqlite::params;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn render_clip_preview(app: AppHandle, db: State<'_, Db>, clip_id: String) -> Result<String, String> {
    let job_id = render_manager::insert_job(&app, &clip_id, "preview", None)?;
    let manager = app.state::<RenderManager>();
    let semaphore = manager.semaphore.clone();
    let _permit = semaphore.acquire_owned().await.map_err(|e| e.to_string())?;
    render_manager::set_status(&app, &job_id, "rendering", None);

    let result = render_clip_preview_inner(&app, &db, &clip_id).await;

    match &result {
        Ok(_) => {
            render_manager::set_status(&app, &job_id, "completed", None);
            queue_manager::kick(app.clone());
        }
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
    let short_clip: String = clip_id.chars().filter(|c| *c != '-').take(12).collect();
    let output_path = app_data_dir.join("renders").join(format!("{short_clip}.mp4"));

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

#[tauri::command]
pub async fn render_clip_final(app: AppHandle, clip_id: String, template_id: String) -> Result<String, String> {
    let job_id = render_manager::insert_job(&app, &clip_id, "final", Some(&template_id))?;
    run_final_render_job(app, clip_id, template_id, job_id).await
}

pub(crate) async fn run_final_render_job(
    app: AppHandle,
    clip_id: String,
    template_id: String,
    job_id: String,
) -> Result<String, String> {
    let manager = app.state::<RenderManager>();
    let semaphore = manager.semaphore.clone();
    let _permit = semaphore.acquire_owned().await.map_err(|e| e.to_string())?;
    render_manager::set_status(&app, &job_id, "rendering", None);

    let db = app.state::<Db>();
    let result = render_clip_final_inner(&app, &db, &clip_id, &template_id).await;

    match &result {
        Ok(_) => {
            render_manager::set_status(&app, &job_id, "completed", None);
            queue_manager::kick(app.clone());
        }
        Err(e) => {
            render_manager::set_status(&app, &job_id, "failed", Some(e));
            queue_manager::fail_rows_awaiting_render(&app, &clip_id, &template_id, e);
        }
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
    let resolve = |text: &str| -> String {
        text.replace("{ai_caption}", ai_caption.as_deref().unwrap_or(""))
            .replace("{part_number}", &part_number.to_string())
    };
    template.caption.text = resolve(&template.caption.text);
    template.caption2.text = resolve(&template.caption2.text);

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
    let short_clip: String = clip_id.chars().filter(|c| *c != '-').take(12).collect();
    let short_tpl: String = template_id.chars().filter(|c| *c != '-').take(12).collect();
    let output_path = app_data_dir
        .join("renders")
        .join("final")
        .join(format!("{short_clip}_{short_tpl}.mp4"));

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