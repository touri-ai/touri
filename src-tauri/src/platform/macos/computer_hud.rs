#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;

const HUD_LABEL: &str = "computer-use-hud";
const TRAY_LABEL: &str = "touri-tray";
const TRAY_SIZE: u32 = 44;
const TRAY_IDLE_RGBA: &[u8] = include_bytes!("../../../icons/tray-template.rgba");
const TRAY_ACTIVE_RGBA: &[u8] = include_bytes!("../../../icons/tray-active.rgba");
static APP: OnceLock<tauri::AppHandle<tauri::Wry>> = OnceLock::new();
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn install(app: &tauri::AppHandle<tauri::Wry>) {
    let _ = APP.set(app.clone());
}

pub fn set_tray_active(active: bool) {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let runner = app.clone();
    let _ = runner.run_on_main_thread(move || {
        if let Some(tray) = app.tray_by_id(TRAY_LABEL) {
            let icon = tauri::image::Image::new(tray_icon(active), TRAY_SIZE, TRAY_SIZE);
            let _ = tray.set_icon(Some(icon));
            let _ = tray.set_icon_as_template(!active);
            let _ = tray.set_tooltip(Some(if active {
                "touri · computer use active"
            } else {
                "touri"
            }));
        }
    });
}

pub fn show(bot_name: &str) {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    ACTIVE.store(true, Ordering::SeqCst);
    let safe_name = escape_html(bot_name);
    let runner = app.clone();
    let _ = runner.run_on_main_thread(move || {
        if !ACTIVE.load(Ordering::SeqCst) {
            return;
        }
        if let Some(window) = app.get_webview_window(HUD_LABEL) {
            crate::window_config::repair(&window.as_ref().window());
            let _ = window.show();
            let _ = window.set_ignore_cursor_events(true);
            return;
        }
        let url = match tauri::Url::parse(&format!(
            "data:text/html,<meta charset=utf-8><style>html,body{{margin:0;background:rgba(220,38,38,.96);color:white;font:13px -apple-system;padding:10px 14px;white-space:nowrap}}</style>{safe_name} is controlling your Mac &middot; &#8963;&#8997;&#8984;. to stop"
        )) {
            Ok(url) => url,
            Err(_) => return,
        };
        let builder = tauri::WebviewWindowBuilder::new(&app, HUD_LABEL, tauri::WebviewUrl::External(url))
            .title("touri computer use")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .inner_size(360.0, 42.0)
            .position(980.0, 18.0)
            .visible(false)
            .on_download(crate::download_guard::deny_download);
        if let Ok(window) = builder.build() {
            crate::window_config::repair(&window.as_ref().window());
            let _ = window.set_ignore_cursor_events(true);
            if ACTIVE.load(Ordering::SeqCst) {
                let _ = window.show();
            } else {
                let _ = window.destroy();
            }
        }
    });
}

pub fn hide() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(app) = APP.get().cloned() {
        let runner = app.clone();
        let _ = runner.run_on_main_thread(move || {
            if ACTIVE.load(Ordering::SeqCst) {
                return; // A newer activation superseded this stop request.
            }
            if let Some(window) = app.get_webview_window(HUD_LABEL) {
                let _ = window.destroy();
            }
        });
    }
}

pub fn hide_and_wait() {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let runner = app.clone();
    let (sender, receiver) = mpsc::sync_channel(0);
    let _ = runner.run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window(HUD_LABEL) {
            let _ = window.hide();
        }
        let _ = sender.send(());
    });
    let _ = receiver.recv_timeout(Duration::from_millis(100));
}

pub fn restore() {
    // A capture finishing after computer use was stopped must not resurrect the HUD.
    if let Some(app) = APP.get().cloned() {
        let runner = app.clone();
        let _ = runner.run_on_main_thread(move || {
            if !ACTIVE.load(Ordering::SeqCst) {
                return;
            }
            if let Some(window) = app.get_webview_window(HUD_LABEL) {
                let _ = window.show();
            }
        });
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn tray_icon(active: bool) -> &'static [u8] {
    if active {
        TRAY_ACTIVE_RGBA
    } else {
        TRAY_IDLE_RGBA
    }
}
