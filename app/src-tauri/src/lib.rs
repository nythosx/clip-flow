mod ai_client;
mod commands;
mod db;
mod facebook_api;
mod ffmpeg;
mod queue_manager;
mod render_manager;
mod tiktok_api;
mod transcript;
mod youtube_api;

use ai_client::AiClient;
use db::Db;
use queue_manager::QueueManager;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `log::info!`/`log::error!` calls throughout this codebase (ai_client.rs,
    // tiktok_api.rs, etc.) were silently going nowhere without a registered backend —
    // this is what actually makes them show up in the dev terminal.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("no app data dir resolved");
            let conn = db::open(&app_data_dir).expect("failed to open database");
            app.manage(Db(Mutex::new(conn)));

            let ai_client = AiClient::new();
            let ai_client_for_state = ai_client.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ai_client.start().await {
                    log::error!("[ai_client] failed to start: {e}");
                }
            });
            app.manage(ai_client_for_state);

            app.manage(QueueManager::default());
            queue_manager::kick(app.handle().clone());
            app.manage(render_manager::RenderManager::default());

            app.manage(commands::project::AnalysisRegistry::default());
            app.manage(commands::project::CaptionLocks::default());
            app.manage(commands::account::TikTokOAuthState::default());
            app.manage(commands::youtube::YouTubeOAuthState::default());
            app.manage(commands::youtube::DownloadManager::default());
            app.manage(commands::facebook::FacebookOAuthState::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project,
            commands::project::get_projects,
            commands::project::get_project,
            commands::project::get_clips,
            commands::project::update_project_name,
            commands::project::delete_project,
            commands::project::set_project_thumbnail,
            commands::project::update_clip_caption,
            commands::project::update_clip_custom_caption,
            commands::project::generate_missing_captions,
            commands::project::analyze_clips,
            commands::project::analyze_movie,
            commands::project::cancel_analysis,
            commands::project::generate_clip_caption,
            commands::project::refine_captions,
            commands::project::fetch_trending_hashtags,
            commands::render::render_clip_preview,
            commands::render::render_clip_final,
            commands::render::get_thumbnail,
            commands::render::get_render_queue,
            commands::template::create_template,
            commands::template::get_templates,
            commands::template::get_template,
            commands::template::update_template,
            commands::template::delete_template,
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::settings::get_app_data_dir,
            commands::account::create_account,
            commands::account::get_accounts,
            commands::account::delete_account,
            commands::account::connect_tiktok_account,
            commands::youtube::connect_youtube_account,
            commands::youtube::refresh_youtube_account,
            commands::youtube::youtube_search,
            commands::youtube::youtube_video_details,
            commands::youtube::youtube_fetch_captions,
            commands::youtube::start_youtube_download,
            commands::youtube::pause_youtube_download,
            commands::youtube::resume_youtube_download,
            commands::youtube::cancel_youtube_download,
            commands::youtube::remove_youtube_download,
            commands::youtube::get_youtube_downloads,
            commands::facebook::connect_facebook_account,
            commands::facebook::refresh_facebook_account,
            commands::queue::add_to_queue,
            commands::queue::get_queue,
            commands::queue::get_queue_for_account,
            commands::queue::pause_queue,
            commands::queue::resume_queue,
            commands::queue::retry_queue_item,
            commands::queue::remove_queue_item,
            commands::queue::clear_completed_queue,
            commands::queue::retry_offline_failures,
            commands::files::pick_file,
            commands::files::pick_directory,
            commands::watermark::upload_watermark,
            commands::watermark::get_watermarks,
            commands::watermark::delete_watermark,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
