pub mod engine;

use engine::EngineState;
use tauri::{Manager, RunEvent};

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
        .build(tauri::generate_context!())
        .expect("error while running packetcode-gui");

    app.run(|handle, event| {
        // Quitting must shut the engine DOWN rather than kill it. Only closing
        // its stdin gets the engine onto its own shutdown path, where it
        // releases every session runtime and, with them, the MCP child
        // processes those sessions started; letting the app exit instead means
        // kill_on_drop denies it that chance and orphans them.
        //
        // RunEvent::Exit rather than a window CloseRequested handler: it
        // covers every way the app can be asked to quit, not just clicking the
        // window's X, and it needs no prevent_close/destroy dance. It is still
        // only best-effort — a crash, a `taskkill /F`, or a forced logoff runs
        // none of this — so it is a courtesy, not a guarantee. What clients
        // can actually rely on is session/close, which releases sessions as
        // they stop being needed rather than hoping for a clean exit.
        if matches!(event, RunEvent::Exit) {
            let state = handle.state::<EngineState>();
            // Bounded inside, so a wedged engine delays the quit by seconds.
            let _ = tauri::async_runtime::block_on(engine::shutdown_engine_on(&state));
        }
    });
}
