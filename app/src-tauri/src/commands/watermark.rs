use crate::db::Db;
use rusqlite::params;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub created_at: String,
}

fn row_to_watermark(row: &rusqlite::Row) -> rusqlite::Result<Watermark> {
    Ok(Watermark {
        id: row.get("id")?,
        name: row.get("name")?,
        file_path: row.get("file_path")?,
        created_at: row.get("created_at")?,
    })
}

/// Copies a user-picked image (which can live anywhere on disk) into
/// `<app_data_dir>/watermarks/`, the only place besides renders/thumbnails the Tauri asset
/// protocol is scoped to serve from (see tauri.conf.json) — without this copy, the picked
/// file's original path can't be displayed via `convertFileSrc` in the preview/editor.
#[tauri::command]
pub async fn upload_watermark(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    name: String,
    source_path: String,
) -> Result<Watermark, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let watermarks_dir = app_data_dir.join("watermarks");
    std::fs::create_dir_all(&watermarks_dir).map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let ext = Path::new(&source_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let dest_path = watermarks_dir.join(format!("{id}.{ext}"));
    std::fs::copy(&source_path, &dest_path).map_err(|e| format!("failed to copy watermark image: {e}"))?;

    let file_path = dest_path.to_string_lossy().to_string();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO watermarks (id, name, file_path) VALUES (?1, ?2, ?3)",
        params![id, name, file_path],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row("SELECT * FROM watermarks WHERE id = ?1", params![id], row_to_watermark)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_watermarks(db: tauri::State<'_, Db>) -> Result<Vec<Watermark>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT * FROM watermarks ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_watermark)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn delete_watermark(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let file_path: Option<String> = conn
        .query_row("SELECT file_path FROM watermarks WHERE id = ?1", params![id], |row| row.get(0))
        .ok();
    conn.execute("DELETE FROM watermarks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(path) = file_path {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}
