#[cfg(unix)]
#[path = "platform/unix/single_instance.rs"]
mod native;
#[cfg(unix)]
pub use native::*;
#[cfg(windows)]
pub fn init<R: tauri::Runtime>(_: fn(&tauri::AppHandle<R>)) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("touri-single-instance").build()
}
