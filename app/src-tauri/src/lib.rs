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

#[tauri::command]
fn close_splashscreen(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

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
            // Every other kick() trigger is reactive (an item was added, resumed, manually
            // retried, ...) — nothing re-checks the queue purely because time has passed.
            // A rate-limited item's automatic retry (schedule_rate_limit_retry) sets a
            // future `scheduled_at` and otherwise just sits there until something calls
            // kick() again; this periodic sweep is what actually makes that due retry fire
            // on its own instead of requiring the user to open the app back up.
            {
                let periodic_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(20));
                    loop {
                        interval.tick().await;
                        queue_manager::kick(periodic_handle.clone());
                    }
                });
            }
            app.manage(render_manager::RenderManager::default());

            app.manage(commands::project::AnalysisRegistry::default());
            app.manage(commands::project::CaptionLocks::default());
            app.manage(commands::account::TikTokOAuthState::default());
            app.manage(commands::youtube::YouTubeOAuthState::default());
            app.manage(commands::youtube::DownloadManager::default());
            app.manage(commands::facebook::FacebookOAuthState::default());

            // Main window starts hidden (tauri.conf.json) so the user never sees a blank
            // white frame while React mounts and the initial data fetches resolve — this
            // splash window covers that gap instead, and close_splashscreen swaps them.
            tauri::WebviewWindowBuilder::new(app, "splash", tauri::WebviewUrl::App("splash.html".into()))
                .title("ClipFlow")
                .inner_size(360.0, 420.0)
                .resizable(false)
                .decorations(false)
                .center()
                .always_on_top(true)
                .build()?;

            // Safety net: if the frontend never calls close_splashscreen (crashed before
            // mounting, stuck fetch, etc.) don't leave the user staring at the splash
            // forever — reveal the main window anyway after a generous timeout.
            let fallback_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                close_splashscreen(fallback_handle);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            close_splashscreen,
            commands::project::create_project,
            commands::project::get_projects,
            commands::project::get_project,
            commands::project::get_clips,
            commands::project::update_project_name,
            commands::project::get_transcript_sync_status,
            commands::project::set_transcript_offset,
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
            commands::render::get_clip_subtitle_cues,
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
            commands::account::open_platform_browser,
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
