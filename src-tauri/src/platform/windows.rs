pub use super::credential_store::{KeychainStore, PRODUCTION_SERVICE};
use std::process::Command;
pub const HOST_COMPUTER: bool = false;
pub fn open_external(url: &str) -> Result<(), String> {
    // Explorer receives the validated URL as one argument; no command interpreter.
    Command::new("explorer.exe")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("open external URL failed: {error}"))
}
pub fn reveal(path: &str) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("reveal file failed: {error}"))
}
pub fn permission_settings(_: &str) -> Result<(), String> {
    Err("Host computer use is not supported on Windows".into())
}

pub fn observe_display_changes<R: tauri::Runtime>(_: &tauri::AppHandle<R>) {}
pub fn unhide_app<R: tauri::Runtime>(_: &tauri::AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}
pub fn after_run_event<R: tauri::Runtime>(_: &tauri::AppHandle<R>, _: &tauri::RunEvent) {}
