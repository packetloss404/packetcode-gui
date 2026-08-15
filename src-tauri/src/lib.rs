pub mod engine;

use engine::EngineState;

pub fn run() {
    tauri::Builder::default()
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            engine::engine_probe,
            engine::engine_start,
            engine::engine_new_session,
            engine::engine_load_session,
            engine::engine_prompt,
            engine::engine_cancel,
            engine::engine_permission_reply,
            engine::engine_list_sessions,
            engine::engine_install,
            engine::engine_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running packetcode-gui");
}
