#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
const BASELINE: bool = false;
include!("common.rs");
fn main() {
    if !backend_mode() {
        run(tauri::generate_context!("tauri.conf.json"));
    }
}
