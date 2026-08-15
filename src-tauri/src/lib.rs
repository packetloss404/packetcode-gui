pub mod engine;

use engine::EngineState;
use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            engine::engine_probe,
            engine::engine_start,
            engine::engine_capabilities,
            engine::engine_new_session,
            engine::engine_load_session,
            engine::engine_prompt,
            engine::engine_cancel,
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
        .build(tauri::generate_context!())
        .expect("error while running packetcode-gui");

    app.run(|handle, event| {
        // Quitting must shut the engine DOWN, not kill it: only closing its
        // stdin gets the engine to its own shutdown path, where it closes
        // every session runtime and, with them, the MCP child processes those
        // sessions spawned. Without this the app simply exits and
        // `kill_on_drop` denies the engine that chance, orphaning whatever it
        // started. The stop is bounded (see `engine::stop_engine`), so a
        // wedged engine delays exit by seconds and no more.
        if matches!(event, tauri::RunEvent::Exit) {
            let state = handle.state::<EngineState>();
            let _ = tauri::async_runtime::block_on(engine::stop_on(&state));
        }
    });
}
