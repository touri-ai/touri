use std::sync::Arc;
use std::time::Duration;

use touri_lib::host_bridge::{HostBridge, HostBridgeCallbacks, AUTH_REQUIRED_CODE};
use touri_lib::keychain::KeychainStore;
use touri_lib::preview::{allows_preview_url, parse_preview_url};
use touri_lib::sidecar::{next_backoff, parse_handshake};
#[cfg(unix)]
use touri_lib::sidecar::{SidecarLaunch, SidecarSupervisor};
use touri_lib::window_config::{parse_position, parse_size, WindowPlacement, DEFAULT_WINDOW_SIZE};

#[test]
fn window_placement_parsing_accepts_signed_positions_and_positive_sizes() {
    assert_eq!(parse_position(Some("-1920, -251")), Some((-1920, -251)));
    assert_eq!(parse_size(Some("1920,1080")), Some((1920, 1080)));
    assert_eq!(parse_size(Some("0,1080")), None);
    assert_eq!(parse_position(Some("1,2,3")), None);
    assert_eq!(
        WindowPlacement {
            position: parse_position(None),
            size: parse_size(None).or(Some(DEFAULT_WINDOW_SIZE)),
        },
        WindowPlacement {
            position: None,
            size: Some(DEFAULT_WINDOW_SIZE),
        }
    );
}

#[test]
fn wp1_host_bridge_requires_authentication_before_dispatch() {
    let root = std::env::temp_dir().join(format!("touri-wp1-integration-{}", std::process::id()));
    let socket = root.join("run").join("host.sock");
    let callbacks = HostBridgeCallbacks {
        file_grants: Arc::new(touri_lib::file_grants::FileGrants::new()),
        secret_prompt: Arc::new(|_| Ok(None)),
        notify: Arc::new(|_, _, _, _| Ok(())),
    };
    let mut bridge = HostBridge::start(
        socket.clone(),
        "wp1-integration-token".to_string(),
        KeychainStore::new("ai.touri.desktop.secret.wp1-integration"),
        callbacks,
    )
    .expect("host bridge starts");
    let mut stream =
        touri_lib::platform::transport::connect(&bridge.endpoint()).expect("connect host bridge");
    use std::io::{BufRead, BufReader, Write};
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("test timeout");
    stream
        .write_all(
            b"{\"id\":1,\"method\":\"keychain.get\",\"params\":{\"account\":\"global/test\"}}\n",
        )
        .expect("write unauthenticated request");
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .expect("read rejection");
    let response: serde_json::Value = serde_json::from_str(&line).expect("JSON response");
    assert_eq!(response["error"]["code"], AUTH_REQUIRED_CODE);
    bridge.shutdown();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn wp1_quit_notification_is_sent_over_the_authenticated_bridge() {
    let root = std::env::temp_dir().join(format!("touri-wp1-quit-{}", std::process::id()));
    let socket = root.join("run").join("host.sock");
    let callbacks = HostBridgeCallbacks {
        file_grants: Arc::new(touri_lib::file_grants::FileGrants::new()),
        secret_prompt: Arc::new(|_| Ok(None)),
        notify: Arc::new(|_, _, _, _| Ok(())),
    };
    let mut bridge = HostBridge::start(
        socket.clone(),
        "wp1-quit-token".to_string(),
        KeychainStore::new("ai.touri.desktop.secret.wp1-quit"),
        callbacks,
    )
    .expect("host bridge starts");
    let mut stream =
        touri_lib::platform::transport::connect(&bridge.endpoint()).expect("connect host bridge");
    use std::io::{BufRead, BufReader, Write};
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("test timeout");
    stream
        .write_all(b"{\"id\":1,\"method\":\"auth\",\"params\":{\"token\":\"wp1-quit-token\"}}\n")
        .expect("authenticate");
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader.read_line(&mut response).expect("read auth response");
    bridge
        .send_notification("app.willQuit", serde_json::json!({}))
        .expect("send quit notification");
    response.clear();
    reader
        .read_line(&mut response)
        .expect("read quit notification");
    let notification: serde_json::Value =
        serde_json::from_str(&response).expect("notification JSON");
    assert_eq!(notification["method"], "app.willQuit");
    bridge.shutdown();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn wp1_preview_guard_matches_acceptance_urls() {
    assert!(allows_preview_url(
        &tauri::Url::parse("http://localhost:5173/x").unwrap()
    ));
    assert!(!allows_preview_url(
        &tauri::Url::parse("https://example.com").unwrap()
    ));
    assert!(!allows_preview_url(
        &tauri::Url::parse("file:///tmp/index.html").unwrap()
    ));
    assert!(parse_preview_url("http://127.0.0.1:3000/").is_ok());
}

#[test]
fn wp1_sidecar_handshake_and_bounded_restart_policy_are_automated() {
    let handshake = parse_handshake(&format!(
        r#"{{"type":"touri-sidecar-ready","port":43123,"pid":99,"version":"0.3.0","schemaVersion":{}}}"#,
        touri_lib::sidecar::SIDECAR_SCHEMA_VERSION
    ))
    .expect("valid sidecar handshake");
    assert_eq!(
        handshake.schema_version,
        touri_lib::sidecar::SIDECAR_SCHEMA_VERSION
    );
    assert_eq!(
        next_backoff(Duration::from_secs(30)),
        Duration::from_secs(30)
    );
}

#[cfg(unix)]
#[test]
fn wp1_sidecar_restarts_after_kill_and_stops_on_quit() {
    let root = std::env::temp_dir().join(format!("touri-wp1-supervisor-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create supervisor fixture");
    let script = root.join("fake-sidecar.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' '{{\"type\":\"touri-sidecar-ready\",\"port\":43123,\"pid\":'\"$$\"',\"version\":\"0.3.0\",\"schemaVersion\":{}}}'\nwhile :; do sleep 1; done\n",
            touri_lib::sidecar::SIDECAR_SCHEMA_VERSION
        ),
    )
    .expect("write sidecar fixture");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .expect("make fixture executable");
    let previous_binary = std::env::var_os("TOURI_SIDECAR_BIN");
    std::env::set_var("TOURI_SIDECAR_BIN", &script);
    let app = tauri::test::mock_app();
    let launch = SidecarLaunch::new(root.join("app-data")).expect("prepare launch");
    let mut supervisor =
        SidecarSupervisor::start(app.handle().clone(), launch).expect("start supervisor");
    let first_token = supervisor.endpoint().expect("initial endpoint").token;
    supervisor.request_restart().expect("kill sidecar");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut restarted = false;
    while std::time::Instant::now() < deadline {
        if let Some(endpoint) = supervisor.endpoint() {
            if endpoint.token != first_token {
                restarted = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(restarted, "sidecar did not reappear within 5 seconds");
    let stop_started = std::time::Instant::now();
    supervisor.stop();
    assert!(
        stop_started.elapsed() < Duration::from_secs(10),
        "sidecar did not stop within 10 seconds"
    );
    assert!(!supervisor.is_running(), "sidecar still running after quit");
    if let Some(previous_binary) = previous_binary {
        std::env::set_var("TOURI_SIDECAR_BIN", previous_binary);
    } else {
        std::env::remove_var("TOURI_SIDECAR_BIN");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn wp1_keychain_acceptance_uses_only_a_dedicated_test_service() {
    let store = KeychainStore::new("ai.touri.desktop.secret.wp1-integration-test");
    let account = "global/WP1_INTEGRATION_SECRET";
    store.delete(account).expect("clean stale test key");
    store
        .set(account, "wp1-integration-value")
        .expect("set test key");
    assert_eq!(
        store.get(account).expect("get test key").as_deref(),
        Some("wp1-integration-value")
    );
    store.delete(account).expect("delete test key");
    assert_eq!(store.get(account).expect("verify test cleanup"), None);
}

const TRAY_SIDE: usize = 44;

fn tray_alpha(rgba: &[u8], x: usize, y: usize) -> u8 {
    rgba[(y * TRAY_SIDE + x) * 4 + 3]
}

#[test]
fn tray_icons_are_bull_silhouettes_with_transparent_corners() {
    let template = include_bytes!("../icons/tray-template.rgba");
    assert_eq!(template.len(), TRAY_SIDE * TRAY_SIDE * 4);
    let last = TRAY_SIDE - 1;
    for (x, y) in [(0, 0), (last, 0), (0, last), (last, last)] {
        assert_eq!(tray_alpha(template, x, y), 0);
    }
    assert_eq!(tray_alpha(template, TRAY_SIDE / 2, TRAY_SIDE / 2), 255);
    assert!(template
        .chunks(4)
        .filter(|p| p[3] == 255)
        .all(|p| p[..3] == [0, 0, 0]));

    let active = include_bytes!("../icons/tray-active.rgba");
    assert_eq!(active.len(), TRAY_SIDE * TRAY_SIDE * 4);
    assert_eq!(tray_alpha(active, TRAY_SIDE / 2, TRAY_SIDE / 2), 255);
    assert!(active.chunks(4).any(|p| p == [220, 38, 38, 255]));
}

#[test]
fn icon_pngs_are_eight_bit_rgba() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons");
    let mut checked = 0;
    let mut pngs: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .chain(std::fs::read_dir(dir.join("icon.iconset")).unwrap())
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "png"))
        .collect();
    pngs.sort();
    for path in pngs {
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[1..4], b"PNG", "{path:?}");
        assert_eq!(bytes[24], 8, "{path:?} must be 8-bit");
        assert_eq!(bytes[25], 6, "{path:?} must be RGBA");
        checked += 1;
    }
    assert!(checked >= 14);
}

#[test]
#[cfg(unix)]
fn drop_grants_redeem_once_over_the_authenticated_bridge_only() {
    use std::io::{BufRead, BufReader, Write};
    let root = std::env::temp_dir().join(format!("touri-drop-bridge-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("root");
    let file = root.join("drop.txt");
    std::fs::write(&file, "payload").expect("file");
    let grants = Arc::new(touri_lib::file_grants::FileGrants::new());
    let id = grants.issue(&[file]).granted[0].id.clone();
    let socket = root.join("run").join("host.sock");
    let callbacks = HostBridgeCallbacks {
        file_grants: Arc::clone(&grants),
        secret_prompt: Arc::new(|_| Ok(None)),
        notify: Arc::new(|_, _, _, _| Ok(())),
    };
    let mut bridge = HostBridge::start(
        socket.clone(),
        "drop-token".to_string(),
        KeychainStore::new("ai.touri.desktop.secret.wp1-drop"),
        callbacks,
    )
    .expect("host bridge starts");
    let mut stream = touri_lib::platform::transport::connect(&bridge.endpoint()).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("timeout");
    let redeem = format!(
        "{{\"id\":1,\"method\":\"file.grant.redeem\",\"params\":{{\"grantId\":\"{id}\"}}}}\n"
    );
    stream
        .write_all(redeem.as_bytes())
        .expect("unauthenticated redeem");
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    reader.read_line(&mut line).expect("read");
    let denied: serde_json::Value = serde_json::from_str(&line).expect("json");
    assert_eq!(denied["error"]["code"], AUTH_REQUIRED_CODE);
    let mut stream =
        touri_lib::platform::transport::connect(&bridge.endpoint()).expect("connect again");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("timeout");
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let batch = format!(
        "{{\"id\":2,\"method\":\"auth\",\"params\":{{\"token\":\"drop-token\"}}}}\n{{\"id\":3,\"method\":\"file.grant.redeem\",\"params\":{{\"grantId\":\"{id}\"}}}}\n"
    );
    stream.write_all(batch.as_bytes()).expect("auth and redeem");
    line.clear();
    reader.read_line(&mut line).expect("auth reply");
    line.clear();
    reader.read_line(&mut line).expect("redeem reply");
    let again = format!(
        "{{\"id\":4,\"method\":\"file.grant.redeem\",\"params\":{{\"grantId\":\"{id}\"}}}}\n"
    );
    let granted: serde_json::Value = serde_json::from_str(&line).expect("json");
    assert!(granted["result"]["path"]
        .as_str()
        .expect("path")
        .ends_with("drop.txt"));
    let mut stream =
        touri_lib::platform::transport::connect(&bridge.endpoint()).expect("connect third");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("timeout");
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let batch = format!(
        "{{\"id\":5,\"method\":\"auth\",\"params\":{{\"token\":\"drop-token\"}}}}\n{again}"
    );
    stream.write_all(batch.as_bytes()).expect("replay");
    line.clear();
    reader.read_line(&mut line).expect("auth reply");
    line.clear();
    reader.read_line(&mut line).expect("replay reply");
    let replay: serde_json::Value = serde_json::from_str(&line).expect("json");
    assert!(replay["error"].is_object());
    bridge.shutdown();
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn windows_drop_grants_fail_closed_until_native_identity_is_implemented() {
    let root = std::env::temp_dir().join(format!("touri-drop-unsupported-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("fixture.txt");
    std::fs::write(&path, "fixture").unwrap();
    let outcome = touri_lib::file_grants::FileGrants::new().issue(&[path]);
    assert!(outcome.granted.is_empty());
    assert_eq!(
        outcome.rejected[0].reason,
        touri_lib::file_grants::RejectReason::Unsupported
    );
    std::fs::remove_dir_all(root).unwrap();
}
