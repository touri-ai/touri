#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod download_guard;
pub mod file_grants;
mod file_save;
pub mod host_bridge;
mod i18n;
pub mod keychain;
pub mod power;
pub mod preview;
mod reports;
pub mod secret_card;
pub mod sidecar;
pub mod single_instance;
pub mod window_config;

pub mod computer;
pub mod deep_link;
mod tray;

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use deep_link::PendingDeepLink;
use file_grants::FileGrants;
use host_bridge::{HostBridge, HostBridgeCallbacks, NotifyOptions};
use keychain::{KeychainStore, PRODUCTION_SERVICE};
use secret_card::{secret_card_cancel, secret_card_submit, SecretCardManager};
use serde::Serialize;
use serde_json::json;
use sidecar::{SidecarEndpoint, SidecarLaunch, SidecarSupervisor};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

pub struct AppState {
    pub endpoint: Mutex<Option<SidecarEndpoint>>,
    pub supervisor: Mutex<Option<SidecarSupervisor<Wry>>>,
    pub host_bridge: Mutex<Option<HostBridge>>,
    pub power_monitor: Mutex<Option<power::PowerMonitor>>,
    pub keychain: KeychainStore,
    pub file_grants: Arc<FileGrants>,
    pub shutting_down: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            endpoint: Mutex::new(None),
            supervisor: Mutex::new(None),
            host_bridge: Mutex::new(None),
            power_monitor: Mutex::new(None),
            keychain: KeychainStore::new(PRODUCTION_SERVICE),
            file_grants: Arc::new(FileGrants::new()),
            shutting_down: AtomicBool::new(false),
        }
    }
}

#[tauri::command]
fn sidecar_endpoint(state: State<'_, AppState>) -> Result<SidecarEndpoint, String> {
    if let Some(supervisor) = state
        .supervisor
        .lock()
        .map_err(|_| "sidecar state lock poisoned".to_string())?
        .as_ref()
    {
        return supervisor.connection_info();
    }
    state
        .endpoint
        .lock()
        .map_err(|_| "sidecar state lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "sidecar is not ready".to_string())
}

#[tauri::command]
fn sidecar_restart(state: State<'_, AppState>) -> Result<(), String> {
    state
        .supervisor
        .lock()
        .map_err(|_| "sidecar state lock poisoned".to_string())?
        .as_ref()
        .ok_or_else(|| "sidecar supervisor is not ready".to_string())?
        .request_restart()
}

#[tauri::command]
fn preview_show(
    app: AppHandle<Wry>,
    webview: tauri::Webview<Wry>,
    url: String,
    bounds: preview::PreviewBounds,
) -> Result<preview::PreviewHandle, String> {
    if webview.label() != "main" {
        return Err("Apenas a janela principal pode abrir previews".to_string());
    }
    let parsed = preview::parse_preview_url(&url)?;
    preview::create_preview(&app, parsed, bounds)
}

#[tauri::command]
fn preview_set_bounds(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    label: String,
    bounds: preview::PreviewBounds,
) -> Result<(), String> {
    let webview = preview::owned_preview(&app, &caller, &label)?;
    preview::set_bounds(&webview, bounds)
}

#[tauri::command]
fn preview_navigate(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    label: String,
    url: String,
) -> Result<(), String> {
    let parsed = preview::parse_preview_url(&url)?;
    let webview = preview::owned_preview(&app, &caller, &label)?;
    webview
        .navigate(parsed)
        .map_err(|error| format!("preview navigation failed: {error}"))
}

#[tauri::command]
fn preview_reload(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    label: String,
) -> Result<(), String> {
    let webview = preview::owned_preview(&app, &caller, &label)?;
    webview
        .reload()
        .map_err(|error| format!("preview reload failed: {error}"))
}

#[tauri::command]
fn preview_hide(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    label: String,
) -> Result<(), String> {
    let webview = preview::owned_preview(&app, &caller, &label)?;
    preview::clear_gateway_cookies(&webview);
    webview
        .close()
        .map_err(|error| format!("close preview failed: {error}"))?;
    preview::forget_preview(&app, &label)
}

#[tauri::command]
fn permissions_status() -> computer::PermissionsStatus {
    computer::status()
}

#[tauri::command]
fn computer_kill_switch(
    app: AppHandle<Wry>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    computer::kill();
    // All viewer windows drop input immediately, even if the sidecar bridge is unavailable.
    let _ = app.emit("computer-kill-switch", ());
    let bridge = state
        .host_bridge
        .lock()
        .map_err(|_| "host bridge state lock poisoned".to_string())?
        .as_ref()
        .map(HostBridge::clone_for_tray)
        .ok_or_else(|| "host bridge is not ready".to_string())?;
    bridge.send_notification("computer.killSwitch", json!({ "at": now_ms() }))?;
    Ok(json!({}))
}

#[tauri::command]
fn permissions_open_settings(permission: String) -> Result<(), String> {
    let url = match permission.as_str() {
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        "screen-recording" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        _ => return Err("unknown permission".to_string()),
    };
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("open permission settings failed: {error}"))
}

#[tauri::command]
fn permissions_request(permission: String) -> Result<computer::PermissionsRequestResult, String> {
    computer::request_permission(&permission).map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_save(state: State<'_, AppState>, account: String, value: String) -> Result<(), String> {
    state.keychain.set(&account, &value)
}

#[tauri::command]
fn pick_folder(app: AppHandle<Wry>, title: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    app.dialog()
        .file()
        .set_title(title)
        .blocking_pick_folder()
        .map(|path| path.to_string())
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("reveal in Finder failed: {error}"))
}

#[tauri::command]
fn open_external(webview: tauri::Webview<Wry>, url: String) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Apenas a janela principal pode abrir links externos".to_string());
    }
    preview::open_external(&url)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterCheck {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

fn updater_enabled() -> bool {
    std::env::var("TOURI_ENABLE_UPDATER")
        .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

#[tauri::command]
async fn updater_check(app: AppHandle<Wry>) -> Result<UpdaterCheck, String> {
    if !updater_enabled() {
        return Ok(UpdaterCheck {
            available: false,
            version: None,
            notes: Some("updater disabled for unsigned local builds".to_string()),
        });
    }
    let update = app
        .updater_builder()
        .build()
        .map_err(|error| format!("build updater failed: {error}"))?
        .check()
        .await
        .map_err(|error| format!("check for updates failed: {error}"))?;
    Ok(match update {
        Some(update) => UpdaterCheck {
            available: true,
            version: Some(update.version),
            notes: update.body,
        },
        None => UpdaterCheck {
            available: false,
            version: None,
            notes: None,
        },
    })
}

#[tauri::command]
async fn updater_install(app: AppHandle<Wry>) -> Result<(), String> {
    if !updater_enabled() {
        return Err("updater disabled for unsigned local builds".to_string());
    }
    let update = app
        .updater_builder()
        .build()
        .map_err(|error| format!("build updater failed: {error}"))?
        .check()
        .await
        .map_err(|error| format!("check for updates failed: {error}"))?
        .ok_or_else(|| "no update is available".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("install update failed: {error}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn stop_runtime(app: &AppHandle<Wry>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    computer::kill();
    if let Ok(bridge) = state.host_bridge.lock() {
        if let Some(bridge) = bridge.as_ref() {
            let _ = bridge.send_notification("app.willQuit", json!({}));
        }
    }
    if let Ok(mut supervisor) = state.supervisor.lock() {
        if let Some(supervisor) = supervisor.as_mut() {
            supervisor.stop();
        }
    }
    if let Ok(mut bridge) = state.host_bridge.lock() {
        if let Some(bridge) = bridge.as_mut() {
            bridge.shutdown();
        }
    };
}

const FILE_DRAG_EVENT: &str = "touri://file-drag";
const FILE_DROP_EVENT: &str = "touri://file-drop";

fn handle_drag_drop(window: &tauri::Window, drag: &tauri::DragDropEvent) {
    match drag {
        tauri::DragDropEvent::Enter { .. } => {
            let _ = window.emit(FILE_DRAG_EVENT, json!({ "active": true }));
        }
        tauri::DragDropEvent::Leave => {
            let _ = window.emit(FILE_DRAG_EVENT, json!({ "active": false }));
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            let _ = window.emit(FILE_DRAG_EVENT, json!({ "active": false }));
            let outcome = window.state::<AppState>().file_grants.issue(paths);
            let _ = window.emit(FILE_DROP_EVENT, outcome);
        }
        _ => {}
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(SecretCardManager::new())
        .manage(PendingDeepLink::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(single_instance::init(|app| {
            window_config::show_main(app, None);
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--hidden")
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or_else(|| std::io::Error::other("main window config missing"))?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main_config)?
                .on_download(download_guard::deny_download)
                .build()?;
            app.manage(preview::PreviewRegistry::default());
            let menu = tauri::menu::Menu::default(app.handle())?;
            i18n::localize_menu(menu.items()?)?;
            let report_item = tauri::menu::MenuItem::with_id(
                app,
                "report-problem",
                "Reportar problema",
                true,
                None::<&str>,
            )?;
            let mut added = false;
            for item in menu.items()? {
                if let tauri::menu::MenuItemKind::Submenu(submenu) = item {
                    if submenu.text()? == "Ajuda" {
                        submenu.append(&report_item)?;
                        added = true;
                        break;
                    }
                }
            }
            if !added {
                let help = tauri::menu::Submenu::with_items(app, "Ajuda", true, &[&report_item])?;
                menu.append(&help)?;
            }
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "report-problem" {
                    window_config::show_main(app, None);
                    let _ = app.emit("report-problem", ());
                }
            });
            app.set_menu(menu)?;
            #[cfg(target_os = "macos")]
            window_config::observe_display_changes(app.handle());
            let launch = SidecarLaunch::from_app(app.handle()).map_err(std::io::Error::other)?;
            let keychain = app.state::<AppState>().keychain.clone();
            let file_grants = Arc::clone(&app.state::<AppState>().file_grants);
            let card_manager = app.state::<SecretCardManager>().inner().clone();
            let prompt_app = app.handle().clone();
            let notification_app = app.handle().clone();
            let pending_app = app.handle().clone();
            let callbacks = HostBridgeCallbacks {
                file_grants,
                secret_prompt: Arc::new(move |request| card_manager.prompt(&prompt_app, request)),
                notify: Arc::new(move |title, body, _thread_id, options: NotifyOptions| {
                    use tauri_plugin_notification::NotificationExt;
                    let focused = pending_app
                        .get_webview_window("main")
                        .map(|window| {
                            window.is_focused().unwrap_or(false)
                                && window.is_visible().unwrap_or(false)
                        })
                        .unwrap_or(false);
                    if options.only_when_unfocused && focused {
                        return Ok(());
                    }
                    if let Some(link) = options.deep_link.as_deref().and_then(deep_link::parse) {
                        pending_app.state::<PendingDeepLink>().set(link);
                    }
                    notification_app
                        .notification()
                        .builder()
                        .title(title)
                        .body(body)
                        .show()
                        .map_err(|error| format!("notification failed: {error}"))
                }),
            };
            let bridge = HostBridge::start(
                launch.host_socket.clone(),
                launch.host_token.clone(),
                keychain,
                callbacks,
            )
            .map_err(std::io::Error::other)?;
            let supervisor = SidecarSupervisor::start(app.handle().clone(), launch)
                .map_err(std::io::Error::other)?;
            computer::install(app.handle());
            let hotkey_bridge = bridge.clone_for_tray();
            app.global_shortcut()
                .on_shortcut(
                    "Control+Alt+Command+Period",
                    move |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            computer::kill();
                            let _ = app.emit("computer-kill-switch", ());
                            let _ = hotkey_bridge.send_notification(
                                "computer.killSwitch",
                                json!({ "at": now_ms() }),
                            );
                        }
                    },
                )
                .map_err(std::io::Error::other)?;
            let power_monitor = power::PowerMonitor::start(bridge.clone_for_tray());
            let endpoint = supervisor.endpoint();
            let state = app.state::<AppState>();
            *state
                .endpoint
                .lock()
                .map_err(|_| std::io::Error::other("endpoint state lock poisoned"))? = endpoint;
            *state
                .supervisor
                .lock()
                .map_err(|_| std::io::Error::other("supervisor state lock poisoned"))? =
                Some(supervisor);
            tray::install(app.handle(), &bridge).map_err(std::io::Error::other)?;
            *state
                .host_bridge
                .lock()
                .map_err(|_| std::io::Error::other("host bridge state lock poisoned"))? =
                Some(bridge);
            *state
                .power_monitor
                .lock()
                .map_err(|_| std::io::Error::other("power monitor state lock poisoned"))? =
                Some(power_monitor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_endpoint,
            sidecar_restart,
            preview_show,
            preview_set_bounds,
            preview_navigate,
            preview_reload,
            preview_hide,
            permissions_status,
            computer_kill_switch,
            permissions_open_settings,
            permissions_request,
            secret_save,
            pick_folder,
            reveal_in_finder,
            open_external,
            reports::report_save_zip,
            file_save::save_file,
            reports::report_shell_diagnostics,
            updater_check,
            updater_install,
            secret_card_submit,
            secret_card_cancel
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if matches!(
                    event,
                    tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                        | tauri::WindowEvent::CloseRequested { .. }
                ) {
                    for (label, view) in window.app_handle().webviews() {
                        if label.starts_with("preview-") {
                            let _ = view.hide();
                        }
                    }
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    window_config::persist(window);
                    api.prevent_close();
                    let _ = window.hide();
                }
                if let tauri::WindowEvent::DragDrop(drag) = event {
                    handle_drag_drop(window, drag);
                }
                if let tauri::WindowEvent::Focused(true) = event {
                    if let Some(link) = window.state::<PendingDeepLink>().take_fresh() {
                        deep_link::dispatch(window.app_handle(), &link);
                    }
                }
                if matches!(
                    event,
                    tauri::WindowEvent::Moved(_)
                        | tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                ) {
                    window_config::repair(window);
                    window_config::persist(window);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running touri")
        .run(|app, event| match event {
            tauri::RunEvent::Ready => {
                if !std::env::args().any(|arg| arg == "--hidden") {
                    window_config::show_main(app, Some(window_config::restore(app)));
                }
                #[cfg(target_os = "macos")]
                window_config::log_native_windows(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => window_config::show_main(app, None),
            tauri::RunEvent::ExitRequested { .. } => stop_runtime(app),
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    deep_link::handle_url(app, url.as_str());
                }
            }
            tauri::RunEvent::Resumed => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(bridge) = state.host_bridge.lock() {
                        if let Some(bridge) = bridge.as_ref() {
                            let _ = bridge
                                .send_notification("power.sleep", json!({ "sleeping": false }));
                        }
                    }
                }
            }
            _ => {}
        });
}
