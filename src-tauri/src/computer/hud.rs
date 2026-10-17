#[cfg(target_os = "macos")]
#[path = "../platform/macos/computer_hud.rs"]
mod native;
#[cfg(target_os = "macos")]
pub use native::*;
#[cfg(not(target_os = "macos"))]
pub fn install(_: &tauri::AppHandle<tauri::Wry>) {}
#[cfg(not(target_os = "macos"))]
pub fn set_tray_active(_: bool) {}
#[cfg(not(target_os = "macos"))]
pub fn show(_: &str) {}
#[cfg(not(target_os = "macos"))]
pub fn hide() {}
