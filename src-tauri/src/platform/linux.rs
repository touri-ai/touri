pub use super::credential_store::{KeychainStore, PRODUCTION_SERVICE};
use std::path::Path;
use std::process::Command;
pub const HOST_COMPUTER: bool = false;
pub fn open_external(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("open external URL failed: {error}"))
}
pub fn reveal(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    let folder = if path.is_dir() {
        path
    } else {
        path.parent().ok_or("file has no parent")?
    };
    Command::new("xdg-open")
        .arg(folder)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("open folder failed: {error}"))
}
pub fn permission_settings(_: &str) -> Result<(), String> {
    Err("Host computer use is not supported on Linux".into())
}

pub fn observe_display_changes<R: tauri::Runtime>(_: &tauri::AppHandle<R>) {}
pub fn unhide_app<R: tauri::Runtime>(_: &tauri::AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}
pub fn after_run_event<R: tauri::Runtime>(_: &tauri::AppHandle<R>, _: &tauri::RunEvent) {}
