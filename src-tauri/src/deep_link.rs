pub use crate::deep_link_target::{notification_target, parse, DeepLink};
use crate::deep_link_target::{PendingDeepLink, PendingDeepLinks};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview, Wry};

#[derive(Default)]
pub struct PendingLinks {
    inbox: Mutex<PendingDeepLinks>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLinkPayload {
    request_id: u64,
    bot: Option<String>,
    thread: Option<String>,
    notification_id: Option<u64>,
}

impl From<PendingDeepLink> for PendingLinkPayload {
    fn from(pending: PendingDeepLink) -> Self {
        Self {
            request_id: pending.request_id,
            bot: pending.target.bot,
            thread: pending.target.thread,
            notification_id: pending.target.notification_id,
        }
    }
}

fn require_main(caller: &Webview<Wry>) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("DEEP_LINK_WINDOW_FORBIDDEN".into())
    }
}

#[tauri::command]
pub fn deep_link_pending(
    caller: Webview<Wry>,
    state: State<'_, PendingLinks>,
) -> Result<Option<PendingLinkPayload>, String> {
    require_main(&caller)?;
    state
        .inbox
        .lock()
        .map(|inbox| inbox.pending().map(Into::into))
        .map_err(|_| "DEEP_LINK_STATE_UNAVAILABLE".into())
}

#[tauri::command]
pub fn deep_link_ack(
    caller: Webview<Wry>,
    state: State<'_, PendingLinks>,
    request_id: u64,
) -> Result<(), String> {
    require_main(&caller)?;
    state
        .inbox
        .lock()
        .map(|mut inbox| inbox.acknowledge(request_id))
        .map_err(|_| "DEEP_LINK_STATE_UNAVAILABLE".into())
}

pub fn dispatch<R: Runtime>(app: &AppHandle<R>, link: &DeepLink) {
    crate::window_config::show_main(app, None);
    let Some(state) = app.try_state::<PendingLinks>() else {
        return;
    };
    let Ok(mut inbox) = state.inbox.lock() else {
        return;
    };
    let payload: PendingLinkPayload = inbox.publish(link.clone()).into();
    drop(inbox);
    let _ = app.emit("deep-link", payload);
}

pub fn handle_url<R: Runtime>(app: &AppHandle<R>, url: &str) {
    if let Some(link) = parse(url) {
        dispatch(app, &link);
    }
}
