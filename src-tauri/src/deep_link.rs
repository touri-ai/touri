pub use crate::deep_link_target::{notification_target, parse, DeepLink};
use tauri::{AppHandle, Emitter, Runtime};

pub fn dispatch<R: Runtime>(app: &AppHandle<R>, link: &DeepLink) {
    crate::window_config::show_main(app, None);
    let _ = app.emit(
        "deep-link",
        serde_json::json!({ "bot": link.bot, "thread": link.thread }),
    );
}

pub fn handle_url<R: Runtime>(app: &AppHandle<R>, url: &str) {
    if let Some(link) = parse(url) {
        dispatch(app, &link);
    }
}
