pub mod engine;

use engine::EngineState;
use tauri::{Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        // Give the engine a chance to shut itself down before the app goes.
        // Without this the engine child is simply killed (kill_on_drop), which
        // skips its own teardown and orphans every MCP process its sessions
        // started. Best-effort only: this runs on a user-initiated window
        // close, never on a crash or a forced kill — see shutdown_engine_on.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    let app = window.app_handle().clone();
                    let state = app.state::<EngineState>();
                    // Bounded inside, so a wedged engine cannot block the quit.
                    let _ = engine::shutdown_engine_on(&state).await;
                    // destroy() bypasses CloseRequested, so this cannot loop.
                    let _ = window.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_probe,
            engine::engine_start,
            engine::engine_capabilities,
            engine::engine_new_session,
            engine::engine_load_session,
            engine::engine_prompt,
            engine::engine_cancel,
            engine::engine_close_session,
            engine::engine_permission_reply,
            engine::engine_list_sessions,
            engine::engine_rename_session,
            engine::engine_session_usage,
            engine::engine_list_models,
            engine::engine_list_commands,
            engine::engine_search_files,
            engine::engine_install,
            engine::engine_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running packetcode-gui");
}
