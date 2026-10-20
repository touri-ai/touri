#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod download_guard;
pub mod file_grants;
mod file_save;
pub mod host_bridge;
mod i18n;
pub mod keychain;
mod notification_permission;
mod notifications;
pub mod platform;
pub mod power;
pub mod preview;
pub mod provider_login_pty;
mod reports;
pub mod secret_card;
pub mod server_mode;
mod shell_runtime;
pub mod sidecar;
pub mod single_instance;
pub mod window_config;

pub mod computer;
pub mod deep_link;
mod deep_link_target;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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
    pub server_mode: Mutex<server_mode::ServerModeStatus>,
    pub server_mode_operation: tokio::sync::Mutex<()>,
    pub server_relay: Mutex<Option<server_mode::ServerRelay>>,
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
            server_mode: Mutex::new(server_mode::ServerModeStatus::default()),
            server_mode_operation: tokio::sync::Mutex::new(()),
            server_relay: Mutex::new(None),
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
    platform::permission_settings(&permission)
}

#[tauri::command]
fn permissions_request(permission: String) -> Result<computer::PermissionsRequestResult, String> {
    computer::request_permission(&permission).map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_save(state: State<'_, AppState>, account: String, value: String) -> Result<(), String> {
    state
        .keychain
        .set(&account, &value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn vault_authorize(
    app: AppHandle<Wry>,
    state: State<'_, AppState>,
    account: String,
) -> Result<(), keychain::KeychainError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        state.keychain.authorize(&account)
    }
    #[cfg(target_os = "macos")]
    {
        // Focus the actual app before Security.framework asks the system to authorize.
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let foreground = app.clone();
        app.run_on_main_thread(move || {
            let result = (|| {
                foreground
                    .show()
                    .map_err(|_| keychain::KeychainError::VaultUnavailable)?;
                let window = foreground
                    .get_window("main")
                    .ok_or(keychain::KeychainError::VaultUnavailable)?;
                window
                    .unminimize()
                    .and_then(|_| window.show())
                    .and_then(|_| window.set_focus())
                    .map_err(|_| keychain::KeychainError::VaultUnavailable)
            })();
            let _ = sender.send(result);
        })
        .map_err(|_| keychain::KeychainError::VaultUnavailable)?;
        let store = state.keychain.clone();
        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .map_err(|_| keychain::KeychainError::VaultTimeout)??;
            store.authorize(&account)
        })
        .await
        .map_err(|_| keychain::KeychainError::VaultUnavailable)?
    }
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
    platform::reveal(&path)
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
    if let Ok(mut relay) = state.server_relay.lock() {
        relay.take();
    }
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

fn start_local_runtime(app: &tauri::App<Wry>) -> Result<(), Box<dyn std::error::Error>> {
    let mut launch = SidecarLaunch::from_app(app.handle()).map_err(std::io::Error::other)?;
    let keychain = app.state::<AppState>().keychain.clone();
    let file_grants = Arc::clone(&app.state::<AppState>().file_grants);
    let card_manager = app.state::<SecretCardManager>().inner().clone();
    let prompt_app = app.handle().clone();
    let notification_app = app.handle().clone();
    let focus_app = app.handle().clone();
    let callbacks = HostBridgeCallbacks {
        file_grants,
        secret_prompt: Arc::new(move |request| card_manager.prompt(&prompt_app, request)),
        notify: Arc::new(move |title, body, _thread_id, options: NotifyOptions| {
            use tauri_plugin_notification::NotificationExt;
            let focused = focus_app
                .get_webview_window("main")
                .map(|window| {
                    window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false)
                })
                .unwrap_or(false);
            if options.only_when_unfocused && focused {
                return Ok(());
            }
            notification_app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .extra("deepLink", options.deep_link)
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
    launch.host_socket = bridge.endpoint();
    let supervisor =
        SidecarSupervisor::start(app.handle().clone(), launch).map_err(std::io::Error::other)?;
    computer::install(app.handle());
    let hotkey_bridge = bridge.clone_for_tray();
    if platform::HOST_COMPUTER {
        app.global_shortcut()
            .on_shortcut(
                "Control+Alt+Command+Period",
                move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        computer::kill();
                        let _ = app.emit("computer-kill-switch", ());
                        let _ = hotkey_bridge
                            .send_notification("computer.killSwitch", json!({ "at": now_ms() }));
                    }
                },
            )
            .map_err(std::io::Error::other)?;
    }
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
        .map_err(|_| std::io::Error::other("supervisor state lock poisoned"))? = Some(supervisor);
    tray::install(app.handle(), &bridge).map_err(std::io::Error::other)?;
    *state
        .host_bridge
        .lock()
        .map_err(|_| std::io::Error::other("host bridge state lock poisoned"))? = Some(bridge);
    *state
        .power_monitor
        .lock()
        .map_err(|_| std::io::Error::other("power monitor state lock poisoned"))? =
        Some(power_monitor);
    Ok(())
}

pub fn run() {
    let runtime = shell_runtime::start_runtime().expect("create shell async runtime");
    tauri::async_runtime::set(runtime.handle().clone());

    tauri::Builder::default()
        .manage(AppState::default())
        .manage(deep_link::PendingLinks::default())
        .manage(SecretCardManager::new())
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
            let mode = app
                .path()
                .app_config_dir()
                .map(|dir| server_mode::load_mode(&dir.join("server-mode.json")))
                .unwrap_or(server_mode::ServerModeStatus {
                    mode: server_mode::Mode::Server,
                    url: None,
                });
            *app.state::<AppState>()
                .server_mode
                .lock()
                .map_err(|_| std::io::Error::other("server mode state lock poisoned"))? =
                mode.clone();
            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or_else(|| std::io::Error::other("main window config missing"))?;
            let main_window = tauri::WebviewWindowBuilder::from_config(app.handle(), &main_config)?
                .on_download(download_guard::deny_download);
            let main_window = if mode.mode == server_mode::Mode::Server {
                // Remote attachments use browser File bytes, never local host path grants.
                main_window.disable_drag_drop_handler()
            } else {
                main_window
            };
            main_window.build()?;
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
            platform::observe_display_changes(app.handle());
            notifications::register_clicks(app.handle());
            server_mode::select_runtime(
                &mode,
                || start_local_runtime(app),
                || {
                    let state = app.state::<AppState>();
                    let (relay, endpoint) = server_mode::start_relay(&mode, state.keychain.clone())
                        .map_err(std::io::Error::other)?;
                    *state
                        .endpoint
                        .lock()
                        .map_err(|_| std::io::Error::other("endpoint state lock poisoned"))? =
                        Some(endpoint);
                    *state
                        .server_relay
                        .lock()
                        .map_err(|_| std::io::Error::other("relay state lock poisoned"))? =
                        Some(relay);
                    tray::install_server(app.handle()).map_err(std::io::Error::other)?;
                    Ok(())
                },
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            deep_link::deep_link_pending,
            deep_link::deep_link_ack,
            sidecar_endpoint,
            sidecar_restart,
            server_mode::server_mode_status,
            server_mode::server_mode_pair,
            server_mode::server_mode_test,
            server_mode::server_mode_local,
            server_mode::server_attention,
            server_mode::server_badge,
            preview_show,
            preview_set_bounds,
            preview_navigate,
            preview_reload,
            preview_hide,
            permissions_status,
            notifications::notification_permission,
            notifications::notification_system_quiet,
            notifications::notification_test,
            notifications::notification_open_settings,
            computer_kill_switch,
            permissions_open_settings,
            permissions_request,
            secret_save,
            vault_authorize,
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
        .run(|app, event| {
            match event {
                tauri::RunEvent::Ready => {
                    if !std::env::args().any(|arg| arg == "--hidden") {
                        window_config::show_main(app, Some(window_config::restore(app)));
                    }
                }

                tauri::RunEvent::ExitRequested { .. } => stop_runtime(app),
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
            }
            platform::after_run_event(app, &event);
        });
}
