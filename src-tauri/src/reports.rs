//! Offline report support: bounded reads of shell logs and a ZIP saved through the native save panel.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_BYTES: usize = 10 * 1024 * 1024;
fn tail_log(path: &std::path::Path) -> String {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let read = || -> std::io::Result<String> {
        let mut file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Ok("Log indisponível".into());
        }
        let start = metadata.len().saturating_sub(2 * 1024 * 1024);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        file.take(2 * 1024 * 1024).read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes);
        let mut lines: Vec<&str> = text.lines().collect();
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        Ok(lines[lines.len().saturating_sub(500)..].join("\n"))
    };
    read().unwrap_or_else(|_| "Log indisponível".into())
}

#[tauri::command]
pub fn report_shell_diagnostics(app: AppHandle) -> Result<Value, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let mut logs = BTreeMap::new();
    for name in ["sidecar.log", "sidecar-shell.log", "sidecar-stderr.log"] {
        logs.insert(name, tail_log(&root.join("logs").join(name)));
    }
    Ok(json!({
        "home": app.path().home_dir().map_err(|error| error.to_string())?,
        "versions": { "app": app.package_info().version.to_string(), "schema": crate::sidecar::SIDECAR_SCHEMA_VERSION,
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "logs": logs
    }))
}

/// Applies the report ZIP size and signature checks before anything is written.
pub fn decode_report_zip(data_base64: &str) -> Result<Vec<u8>, String> {
    if data_base64.len() > (MAX_BYTES * 4 / 3 + 4) {
        return Err("O relatório excede 10 MB".into());
    }
    let bytes = STANDARD.decode(data_base64).map_err(|_| "ZIP inválido")?;
    if bytes.len() > MAX_BYTES || !bytes.starts_with(b"PK\x03\x04") {
        return Err("ZIP inválido ou maior que 10 MB".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn report_save_zip(
    app: AppHandle,
    webview: tauri::Webview<tauri::Wry>,
    data_base64: String,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("Apenas a janela principal pode salvar arquivos".into());
    }
    let bytes = decode_report_zip(&data_base64)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let outcome = crate::file_save::save_with_panel(
        app,
        format!("touri-relatorio-{stamp}.zip"),
        bytes,
        0o600,
    )
    .await?;
    Ok(json!({ "path": outcome.path }))
}

#[cfg(test)]
mod save_zip_tests {
    use super::*;

    #[test]
    fn report_zip_checks_signature_and_size() {
        assert!(decode_report_zip(&STANDARD.encode(b"PK\x03\x04rest")).is_ok());
        assert!(decode_report_zip(&STANDARD.encode(b"not a zip")).is_err());
        assert!(decode_report_zip("***").is_err());
        assert!(decode_report_zip(&"A".repeat(MAX_BYTES * 2)).is_err());
    }
}
