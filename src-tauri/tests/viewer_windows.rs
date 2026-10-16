use serde_json::Value;

fn read_json(path: &str) -> Value {
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    serde_json::from_str(&std::fs::read_to_string(&full).expect("read json")).expect("parse json")
}

fn directive<'a>(csp: &'a str, name: &str) -> Vec<&'a str> {
    csp.split(';')
        .map(str::trim)
        .find_map(|entry| entry.strip_prefix(name))
        .map(|sources| sources.split_whitespace().collect())
        .unwrap_or_default()
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The chat preview and viewers render frames as data: images and never fetch data: URLs,
/// so the CSP stays tight: no blob: images and no data: connections.
#[test]
fn desktop_csp_keeps_preview_frames_on_data_images_only() {
    let config = read_json("tauri.conf.json");
    let csp = config["app"]["security"]["csp"].as_str().expect("csp");
    let images = directive(csp, "img-src ");
    assert!(images.contains(&"data:"));
    assert!(!images.contains(&"blob:"));
    assert!(!images.iter().any(|source| source.contains('*')));
    let connect = directive(csp, "connect-src ");
    assert!(!connect.contains(&"data:"));
    assert!(!connect.contains(&"blob:"));
    assert!(connect.contains(&"ws://127.0.0.1:*"));
}

/// "Abrir em janela" creates `computer-<bot>` from the main window and focuses it, so it is
/// not left occluded (WebKit then reports the document hidden). The popout keeps only the
/// default core permissions; it never gets the main window's privileged commands.
#[test]
fn computer_popout_windows_have_core_events_and_main_can_focus_them() {
    let computer = read_json("capabilities/computer.json");
    assert_eq!(strings(&computer["windows"]), vec!["computer-*"]);
    assert_eq!(strings(&computer["permissions"]), vec!["core:default"]);
    let main = read_json("capabilities/main.json");
    let main_permissions = strings(&main["permissions"]);
    assert!(main_permissions.contains(&"core:webview:allow-create-webview-window"));
    assert!(main_permissions.contains(&"core:window:allow-set-focus"));
    assert!(!strings(&main["windows"])
        .iter()
        .any(|window| window.starts_with("computer")));
}
