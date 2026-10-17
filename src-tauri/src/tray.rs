use tauri::menu::{Menu, MenuItem};
use tauri::{image::Image, AppHandle, Emitter, Runtime};

use crate::computer;
use crate::host_bridge::HostBridge;

pub fn install<R: Runtime>(app: &AppHandle<R>, host_bridge: &HostBridge) -> Result<(), String> {
    let open = MenuItem::with_id(app, "open", "Abrir touri", true, None::<&str>)
        .map_err(|error| format!("create tray Open item failed: {error}"))?;
    let pause = MenuItem::with_id(app, "pause-all", "Pausar todos os bots", true, None::<&str>)
        .map_err(|error| format!("create tray Pause item failed: {error}"))?;
    let stop_computer = MenuItem::with_id(
        app,
        "stop-computer",
        "Parar controle do computador",
        true,
        None::<&str>,
    )
    .map_err(|error| format!("create tray Stop item failed: {error}"))?;
    let quit = MenuItem::with_id(app, "quit", "Sair do touri", true, None::<&str>)
        .map_err(|error| format!("create tray Quit item failed: {error}"))?;
    let items: Vec<&dyn tauri::menu::IsMenuItem<R>> = if crate::platform::HOST_COMPUTER {
        vec![&open, &pause, &stop_computer, &quit]
    } else {
        vec![&open, &pause, &quit]
    };
    let menu = Menu::with_items(app, &items)
        .map_err(|error| format!("create tray menu failed: {error}"))?;
    let bridge = host_bridge.clone_for_tray();
    tauri::tray::TrayIconBuilder::with_id("touri-tray")
        .icon(Image::new(
            include_bytes!("../icons/tray-template.rgba"),
            44,
            44,
        ))
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("touri")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => crate::window_config::show_main(app, None),
            "pause-all" => {
                let _ = app.emit("pause-all-bots", ());
            }
            "stop-computer" => {
                computer::kill();
                let _ = bridge.send_notification(
                    "computer.killSwitch",
                    serde_json::json!({ "at": now_ms() }),
                );
                let _ = app.emit("computer-kill-switch", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)
        .map(|_| ())
        .map_err(|error| format!("create tray failed: {error}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
