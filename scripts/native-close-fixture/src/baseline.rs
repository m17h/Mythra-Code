#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
const BASELINE: bool = true;
include!("common.rs");
fn main() {
    if !backend_mode() {
        // Tauri codegen resolves the supplied config's parent directory and
        // reads tauri.conf.json there, not an arbitrary alternate filename.
        // Preserve its Windows overlay while setting this bin's isolated identity.
        let mut context = tauri::generate_context!();
        let baseline: tauri::Config = serde_json::from_str(include_str!("../tauri.baseline.conf.json"))
            .expect("isolated baseline configuration");
        let config = context.config_mut();
        config.identifier = baseline.identifier;
        config.product_name = baseline.product_name;
        config.app.windows = baseline.app.windows;
        run(context);
    }
}
