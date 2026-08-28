use crate::db::Db;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub config_json: String,
    pub is_default: bool,
    pub created_at: String,
}

fn row_to_template(row: &rusqlite::Row) -> rusqlite::Result<Template> {
    Ok(Template {
        id: row.get("id")?,
        name: row.get("name")?,
        platform: row.get("platform")?,
        config_json: row.get("config_json")?,
        is_default: row.get::<_, i64>("is_default")? != 0,
        created_at: row.get("created_at")?,
    })
}

#[tauri::command]
pub async fn create_template(
    db: tauri::State<'_, Db>,
    name: String,
    platform: String,
    config_json: String,
) -> Result<Template, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO templates (id, name, platform, config_json) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, platform, config_json],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row("SELECT * FROM templates WHERE id = ?1", params![id], row_to_template)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_templates(db: tauri::State<'_, Db>) -> Result<Vec<Template>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT * FROM templates ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_template)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn get_template(db: tauri::State<'_, Db>, id: String) -> Result<Template, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT * FROM templates WHERE id = ?1", params![id], row_to_template)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_template(
    db: tauri::State<'_, Db>,
    id: String,
    name: String,
    config_json: String,
) -> Result<Template, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE templates SET name = ?1, config_json = ?2 WHERE id = ?3",
        params![name, config_json, id],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row("SELECT * FROM templates WHERE id = ?1", params![id], row_to_template)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_template(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM templates WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
