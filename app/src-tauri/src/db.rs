
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    movie_path TEXT NOT NULL,
    transcript_path TEXT,
    transcript_format TEXT,
    source_resolution_width INTEGER,
    source_resolution_height INTEGER,
    source_duration_seconds REAL,
    trimmed_start_seconds REAL,
    trimmed_end_seconds REAL,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    hook_reason TEXT,
    transcript_excerpt TEXT,
    ai_caption TEXT,
    output_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'tiktok',
    config_json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    account_name TEXT NOT NULL,
    credentials_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upload_queue (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    platform_post_id TEXT,
    scheduled_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watermarks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_cache (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prompt_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, prompt_hash)
);

CREATE TABLE IF NOT EXISTS render_queue (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    template_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error_message TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

pub fn db_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("clipflow.db")
}

pub fn open(app_data_dir: &PathBuf) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(app_data_dir).expect("failed to create app data dir");
    let conn = Connection::open(db_path(app_data_dir))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA)?;

    match conn.execute_batch("ALTER TABLE clips ADD COLUMN final_output_path TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    match conn.execute_batch("ALTER TABLE upload_queue ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    conn.execute_batch("UPDATE upload_queue SET status = 'queued' WHERE status = 'uploading';")?;

    match conn.execute_batch("ALTER TABLE clips ADD COLUMN kind TEXT NOT NULL DEFAULT 'clip';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    match conn.execute_batch("ALTER TABLE projects ADD COLUMN clips_status TEXT NOT NULL DEFAULT 'idle';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    match conn.execute_batch("ALTER TABLE projects ADD COLUMN movie_status TEXT NOT NULL DEFAULT 'idle';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    conn.execute_batch(
        "UPDATE projects SET clips_status = 'ready' WHERE clips_status = 'idle'
         AND EXISTS (SELECT 1 FROM clips WHERE clips.project_id = projects.id AND clips.kind = 'clip');",
    )?;

    match conn.execute_batch("ALTER TABLE clips ADD COLUMN hashtags TEXT NOT NULL DEFAULT '[]';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    match conn.execute_batch("ALTER TABLE projects ADD COLUMN source_thumbnail_url TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    match conn.execute_batch("ALTER TABLE clips ADD COLUMN custom_caption TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    match conn.execute_batch("ALTER TABLE projects ADD COLUMN trending_hashtags TEXT NOT NULL DEFAULT '[]';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    conn.execute_batch(
        "UPDATE render_queue SET status = 'failed', error_message = 'Interrupted — app was closed or restarted while this was rendering', completed_at = datetime('now') WHERE status IN ('queued', 'rendering');",
    )?;

    match conn.execute_batch("ALTER TABLE projects ADD COLUMN transcript_offset_seconds REAL NOT NULL DEFAULT 0;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    match conn.execute_batch("ALTER TABLE upload_queue ADD COLUMN finished_at TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    match conn.execute_batch("ALTER TABLE upload_queue ADD COLUMN required_template_id TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }

    conn.execute_batch(
        "UPDATE upload_queue SET finished_at = completed_at WHERE status = 'completed' AND finished_at IS NULL;",
    )?;
    seed_default_template(&conn)?;
    Ok(conn)
}

fn seed_default_template(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM templates", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let id = uuid::Uuid::new_v4().to_string();

    let config_json = r##"{
        "version": 2,
        "platform": "tiktok",
        "output": { "width": 1080, "height": 1920 },
        "transform": { "mirror": false, "revert": false, "rotation": 0, "scaling": "fill", "crop": { "x": 0.5, "y": 0.5 }, "zoom": 0.5 },
        "watermark": { "enabled": false, "imagePath": "", "position": { "x": 0.85, "y": 0.05 }, "anchor": "top-right", "scale": 0.2, "opacity": 0.8 },
        "caption": { "enabled": true, "text": "{ai_caption}", "fontFamily": "Arial", "fontSize": 64, "fontColor": "#ffffff", "backgroundColor": "#000000", "backgroundOpacity": 0.5, "padding": 16, "position": { "x": 0.1, "y": 0.72 }, "anchor": "bottom-left", "maxWidth": 880, "alignment": "left" },
        "encoding": { "codec": "h264", "crf": 23, "preset": "veryfast", "maxResolution": 1080, "audioBitrate": "192k" }
    }"##;
    conn.execute(
        "INSERT INTO templates (id, name, platform, config_json) VALUES (?1, ?2, ?3, ?4)",
        params![id, "TikTok Default (9:16)", "tiktok", config_json],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('default_template_id', ?1)",
        params![id],
    )?;
    Ok(())
}
