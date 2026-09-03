// SQLite schema (SPEC.md section 3), applied idempotently on startup. A single
// `CREATE TABLE IF NOT EXISTS` pass is enough for now since there's only one schema
// version to reach — swap for a real migration framework once the schema needs to evolve
// across shipped versions.
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

/// `<app data dir>/clipflow.db` — created if missing.
pub fn db_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("clipflow.db")
}

pub fn open(app_data_dir: &PathBuf) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(app_data_dir).expect("failed to create app data dir");
    let conn = Connection::open(db_path(app_data_dir))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA)?;
    // `ADD COLUMN IF NOT EXISTS` isn't supported by the bundled SQLite version here, so
    // idempotency is done by ignoring the "duplicate column" failure on repeat runs —
    // added after the initial schema for Phase 4's template-based final render
    // (NEXT_PHASE.md). No real migration framework yet; fine for a single added column.
    match conn.execute_batch("ALTER TABLE clips ADD COLUMN final_output_path TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    // Added for the queue manager (SPEC section 8) to report per-item upload percentage.
    match conn.execute_batch("ALTER TABLE upload_queue ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    // Any row left "uploading" from a previous crash/close is stale — requeue it so the
    // manager picks it back up instead of leaving it stuck forever.
    conn.execute_batch("UPDATE upload_queue SET status = 'queued' WHERE status = 'uploading';")?;
    // Full Movie mode (Part 1, Part 2, ...) coexists with the original best-highlights
    // mode — 'kind' distinguishes rows so both share the same clips table (and all its
    // render/preview/upload-queue/template machinery) instead of duplicating it.
    match conn.execute_batch("ALTER TABLE clips ADD COLUMN kind TEXT NOT NULL DEFAULT 'clip';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    // clips_status/movie_status replace the single `status` column for gating each mode's
    // Analyze UI independently — `status` is left in place (still written by analyze_clips)
    // since dropping columns isn't supported without a real migration framework.
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
    // Backfill clips_status for projects analyzed before this column existed, so their
    // already-generated clips don't get hidden behind an "Analyze Clips" prompt.
    conn.execute_batch(
        "UPDATE projects SET clips_status = 'ready' WHERE clips_status = 'idle'
         AND EXISTS (SELECT 1 FROM clips WHERE clips.project_id = projects.id AND clips.kind = 'clip');",
    )?;
    // JSON-encoded array of hashtags the Caption Generator extracted separately from the
    // caption text (SPEC intent: keep captions hashtag-free, prepare hashtags for a future
    // auto-upload flow instead).
    match conn.execute_batch("ALTER TABLE clips ADD COLUMN hashtags TEXT NOT NULL DEFAULT '[]';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    // Set for YouTube-imported projects (youtube_import_project) to the video's own
    // thumbnail — lets the project switcher show the actual YouTube thumbnail instead of an
    // ffmpeg-extracted frame, which for a downloaded video is often a black/blank moment.
    match conn.execute_batch("ALTER TABLE projects ADD COLUMN source_thumbnail_url TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    // A user-written caption, kept fully separate from `ai_caption` — generating (or
    // re-generating) the AI caption must never clobber something the user typed themselves,
    // and vice versa. Neither is baked into a render unless a template's caption/caption2
    // text actually references `{ai_caption}` / `{custom_caption}`.
    match conn.execute_batch("ALTER TABLE clips ADD COLUMN custom_caption TEXT;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    // JSON-encoded array of currently-trending hashtags fetched on demand (via the
    // "Trending hashtags" AI call) for this project — reused across every clip's TikTok
    // title instead of re-fetching per clip, since "trending right now" doesn't change
    // meaningfully between clips uploaded minutes apart within the same session.
    match conn.execute_batch("ALTER TABLE projects ADD COLUMN trending_hashtags TEXT NOT NULL DEFAULT '[]';") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    // Unlike upload_queue, render_queue has no independent background worker — a
    // 'queued'/'rendering' row only ever progresses because the original
    // render_clip_preview/render_clip_final call that inserted it is still awaiting inside
    // this same process (render_manager.rs). Any such row still present when the app starts
    // up must be left over from a previous process that was closed or crashed mid-render —
    // nothing will ever pick it back up. Resetting it to 'queued' (as if requeuing it, the
    // upload_queue pattern) was actively wrong here: the row just sat there forever with no
    // real work behind it, keeping the render-queue indicator spinning indefinitely. Mark it
    // failed instead so it clears; re-selecting/re-rendering the clip starts a fresh row.
    conn.execute_batch(
        "UPDATE render_queue SET status = 'failed', error_message = 'Interrupted — app was closed or restarted while this was rendering', completed_at = datetime('now') WHERE status IN ('queued', 'rendering');",
    )?;
    // Manual correction for a transcript whose timestamps don't line up with the actual
    // movie file (wrong export, extra intro/logo not in the transcript, etc.) — applied to
    // every transcript entry's start/end before it's used for subtitle cues, so the
    // in-app preview and the final render both shift in lockstep. See transcript_sync.rs.
    match conn.execute_batch("ALTER TABLE projects ADD COLUMN transcript_offset_seconds REAL NOT NULL DEFAULT 0;") {
        Ok(()) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e),
    }
    seed_default_template(&conn)?;
    Ok(conn)
}

// TikTok-safe starter template so a fresh install has something to render with instead of
// an empty "No templates yet" state. 1080x1920 (9:16) filled (no letterboxing), caption
// kept clear of TikTok's bottom UI (comment tray sits in roughly the bottom 15%).
fn seed_default_template(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM templates", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let id = uuid::Uuid::new_v4().to_string();
    // r##"..."## (double #) since the JSON contains literal `"#` sequences (hex colors)
    // that would otherwise prematurely terminate a single-# raw string.
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
