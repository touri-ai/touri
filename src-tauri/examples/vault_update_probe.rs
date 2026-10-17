//! Manual macOS acceptance harness. Uses only a dedicated disposable Keychain item.
use tauri::{Manager, State};
use touri_lib::keychain::KeychainStore;

const SERVICE: &str = "ai.touri.desktop.secret.update-probe";
const ACCOUNT: &str = "throwaway-update-check";
const VALUE: &str = "throwaway-value-A";
const HTML: &str = r#"<!doctype html><html><meta charset="utf-8"><body style="font:18px system-ui;padding:32px"><h1>touri Vault Test</h1><p>Dedicated disposable test services only (update-probe / stable-update-probe)</p><button onclick="run('write')">Write A</button> <button onclick="run('read')">Read</button> <button onclick="run('authorize')">Permitir acesso ao cofre</button> <button onclick="run('delete')">Remove test item</button><p id="result" role="status">Ready</p><script>async function run(action) { document.querySelector('#result').textContent='Waiting…';try { document.querySelector('#result').textContent = await window.__TAURI_INTERNALS__.invoke('probe_action',{action}); } catch(e) { document.querySelector('#result').textContent=String(e); } }</script></body></html>"#;

#[tauri::command]
async fn probe_action(store: State<'_, KeychainStore>, action: String) -> Result<String, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match action.as_str() {
            "write" => store.set(ACCOUNT, VALUE).map(|_| "Written".to_string()),
            "read" => store
                .get(ACCOUNT)
                .map(|value| format!("Value matches: {}", value.as_deref() == Some(VALUE))),
            "authorize" => store
                .authorize(ACCOUNT)
                .map(|_| "Authorized; click Read to verify".to_string()),
            "delete" => store
                .delete(ACCOUNT)
                .map(|_| "Test item removed".to_string()),
            _ => return Err("Unknown test operation".to_string()),
        }
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Test worker failed".to_string())?
}

fn main() {
    // Only this isolated harness embeds inline HTML/JS; production CSP is unchanged.
    let mut context = tauri::generate_context!();
    context.config_mut().app.security.csp = None;
    tauri::Builder::default()
        .register_uri_scheme_protocol("vault-probe", |_, _| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(HTML.as_bytes().to_vec())
                .unwrap()
        })
        .manage(KeychainStore::new(
            if std::env::args().any(|arg| arg == "--stable") {
                "ai.touri.desktop.secret.stable-update-probe"
            } else {
                SERVICE
            },
        ))
        .invoke_handler(tauri::generate_handler![probe_action])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::CustomProtocol("vault-probe://localhost/index.html".parse()?),
            )
            .title("touri Vault Test")
            .inner_size(760.0, 300.0)
            .build()?;
            app.get_webview_window("main").unwrap().set_focus()?;
            Ok(())
        })
        .run(context)
        .expect("run disposable vault test app");
}
