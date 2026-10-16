//! Explicit "save file" flow. User file saves never go through WKWebView navigation downloads:
//! the UI sends the bytes here, a native save panel is shown off the main thread, and Rust writes.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Wry};

pub const MAX_SAVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;
const FALLBACK_NAME: &str = "arquivo";

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SaveFileOutcome {
    pub path: Option<String>,
}

/// Reduces a suggested name to a single safe path component.
pub fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control() && *c != ':')
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        FALLBACK_NAME.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Decodes the payload, enforcing the size cap before and after decoding.
pub fn decode_payload(data_base64: &str) -> Result<Vec<u8>, String> {
    if data_base64.len() > MAX_SAVE_BYTES / 3 * 4 + 4 {
        return Err("O arquivo excede 64 MB".into());
    }
    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|_| "Conteúdo do arquivo inválido".to_string())?;
    if bytes.len() > MAX_SAVE_BYTES {
        return Err("O arquivo excede 64 MB".into());
    }
    Ok(bytes)
}

/// Accepts only absolute destinations with a real file name that are not directories.
pub fn validate_destination(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("Destino inválido".into());
    }
    if path.is_dir() {
        return Err("O destino é uma pasta".into());
    }
    Ok(())
}

pub fn write_file_with_mode(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    validate_destination(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(not(unix))]
    let _ = mode;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

/// Shows the native save panel off the calling thread and writes the bytes to the chosen file.
pub async fn save_with_panel(
    app: AppHandle<Wry>,
    name: String,
    bytes: Vec<u8>,
    mode: u32,
) -> Result<SaveFileOutcome, String> {
    let suggested = sanitize_file_name(&name);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = pick_destination(&app, suggested) else {
            return Ok(SaveFileOutcome { path: None });
        };
        write_file_with_mode(&path, &bytes, mode)?;
        Ok(SaveFileOutcome {
            path: Some(path.display().to_string()),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn pick_destination(app: &AppHandle<Wry>, name: String) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_file_name(name)
        .blocking_save_file()
        .and_then(|path| path.into_path().ok())
}

#[tauri::command]
pub async fn save_file(
    app: AppHandle<Wry>,
    webview: tauri::Webview<Wry>,
    name: String,
    data_base64: String,
) -> Result<SaveFileOutcome, String> {
    if webview.label() != "main" {
        return Err("Apenas a janela principal pode salvar arquivos".into());
    }
    let bytes = decode_payload(&data_base64)?;
    save_with_panel(app, name, bytes, 0o644).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("touri-save-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_strips_paths_and_dots() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("a\\b\\c.md"), "c.md");
        assert_eq!(sanitize_file_name(".hidden"), "hidden");
        assert_eq!(sanitize_file_name("  "), FALLBACK_NAME);
        assert_eq!(sanitize_file_name("rel\u{0}at:orio.md"), "relatorio.md");
        assert_eq!(
            sanitize_file_name(&"x".repeat(500)).chars().count(),
            MAX_NAME_CHARS
        );
    }

    #[test]
    fn decode_enforces_cap_and_format() {
        assert_eq!(decode_payload("b2s=").unwrap(), b"ok");
        assert!(decode_payload("***").is_err());
        let huge = "A".repeat(MAX_SAVE_BYTES / 3 * 4 + 8);
        assert!(decode_payload(&huge).is_err());
    }

    #[test]
    fn destination_must_be_absolute_file() {
        assert!(validate_destination(Path::new("relative.md")).is_err());
        assert!(validate_destination(Path::new("/")).is_err());
        assert!(validate_destination(&temp_dir("dir")).is_err());
    }

    #[test]
    fn write_creates_and_overwrites() {
        let path = temp_dir("write").join("out.md");
        write_file_with_mode(&path, b"first version", 0o644).unwrap();
        write_file_with_mode(&path, b"v2", 0o644).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"v2");
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_symlink_target() {
        let dir = temp_dir("link");
        let real = dir.join("real.txt");
        std::fs::write(&real, b"keep").unwrap();
        let link = dir.join("link.txt");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(write_file_with_mode(&link, b"evil", 0o644).is_err());
        assert_eq!(std::fs::read(&real).unwrap(), b"keep");
    }

    #[test]
    fn jpg_name_and_binary_payload_round_trip() {
        let jpeg: Vec<u8> = vec![
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0xFF, 0xD9,
        ];
        assert_eq!(
            sanitize_file_name("01-initial-empty.jpg"),
            "01-initial-empty.jpg"
        );
        assert_eq!(
            sanitize_file_name("12-Replacement-Result-image.JPG"),
            "12-Replacement-Result-image.JPG"
        );
        let decoded = decode_payload(&STANDARD.encode(&jpeg)).unwrap();
        assert_eq!(decoded, jpeg);
        let path = temp_dir("jpg").join("01-initial-empty.jpg");
        write_file_with_mode(&path, &decoded, 0o600).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), jpeg);
    }

    #[test]
    fn data_url_payload_is_rejected_instead_of_saving_garbage() {
        let jpeg: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0xFF, 0xD9];
        let data_url = format!("data:image/jpeg;base64,{}", STANDARD.encode(&jpeg));
        assert!(decode_payload(&data_url).is_err());
    }
}
