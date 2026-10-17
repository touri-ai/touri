use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewBuilder, WebviewUrl, Wry};

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

static PREVIEW_ID: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Serialize)]
pub struct PreviewHandle {
    pub label: String,
}
const PREVIEW_DATA_STORE: [u8; 16] = *b"touri-preview-01";

pub fn allows_preview_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_none()
    {
        return false;
    }
    matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
    )
}

const GATEWAY_PREFIX: &str = "/touri/";
const GATEWAY_CAPABILITY_LENGTH: usize = 64;
const GATEWAY_SESSION_SEGMENT: &str = "/__touri/session";
const GATEWAY_COOKIE_PREFIX: &str = "touri_cap_";

fn gateway_capability_split(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix(GATEWAY_PREFIX)?;
    let (capability, tail) = match rest.find('/') {
        Some(index) => rest.split_at(index),
        None => (rest, ""),
    };
    let valid = capability.len() == GATEWAY_CAPABILITY_LENGTH
        && capability
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    valid.then_some((capability, tail))
}

/// A capability gateway URL is opened through its session endpoint so the preview
/// receives an HttpOnly cookie. Root-relative assets, links, fetches and WebSockets
/// then authenticate transparently without the capability appearing in page URLs.
pub fn capability_bootstrap_url(url: &Url) -> Url {
    let Some((capability, tail)) = gateway_capability_split(url.path()) else {
        return url.clone();
    };
    let next = format!(
        "{}{}",
        if tail.is_empty() { "/" } else { tail },
        url.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    let mut bootstrap = url.clone();
    bootstrap.set_path(&format!(
        "{GATEWAY_PREFIX}{capability}{GATEWAY_SESSION_SEGMENT}"
    ));
    bootstrap.set_query(None);
    bootstrap.query_pairs_mut().append_pair("next", &next);
    bootstrap
}

/// Capability cookies never outlive the preview that received them.
pub fn clear_gateway_cookies(webview: &tauri::Webview<Wry>) {
    let Ok(cookies) = webview.cookies() else {
        return;
    };
    for cookie in cookies
        .into_iter()
        .filter(|cookie| cookie.name().starts_with(GATEWAY_COOKIE_PREFIX))
    {
        let _ = webview.delete_cookie(cookie);
    }
}

pub fn parse_preview_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "preview URL is invalid".to_string())?;
    if allows_preview_url(&url) {
        Ok(capability_bootstrap_url(&url))
    } else {
        Err("O preview exige HTTP(S) em localhost, 127.0.0.1 ou [::1] com uma porta".to_string())
    }
}

pub fn parse_external_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "URL inválida".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Somente links HTTP ou HTTPS sem credenciais são permitidos".to_string());
    }
    Ok(url)
}

// Only explicit main-UI actions call this. Preview navigation never opens OS handlers.
pub fn open_external(url: &str) -> Result<(), String> {
    let parsed = parse_external_url(url)?;
    crate::platform::open_external(parsed.as_str())
}

struct OwnedPreviews<T> {
    handles: HashMap<String, T>,
}

impl<T: Clone> OwnedPreviews<T> {
    fn resolve(&self, caller: &str, label: &str) -> Result<T, String> {
        if caller != "main" {
            return Err("Apenas a janela principal pode controlar previews".to_string());
        }
        self.handles
            .get(label)
            .cloned()
            .ok_or_else(|| "Preview não encontrado".to_string())
    }
}

pub struct PreviewRegistry(Mutex<OwnedPreviews<tauri::Webview<Wry>>>);

impl Default for PreviewRegistry {
    fn default() -> Self {
        Self(Mutex::new(OwnedPreviews {
            handles: HashMap::new(),
        }))
    }
}

pub fn owned_preview(
    app: &tauri::AppHandle<Wry>,
    caller: &tauri::Webview<Wry>,
    label: &str,
) -> Result<tauri::Webview<Wry>, String> {
    app.state::<PreviewRegistry>()
        .0
        .lock()
        .map_err(|_| "Registro de previews indisponível".to_string())?
        .resolve(caller.label(), label)
}

pub fn forget_preview(app: &tauri::AppHandle<Wry>, label: &str) -> Result<(), String> {
    app.state::<PreviewRegistry>()
        .0
        .lock()
        .map_err(|_| "Registro de previews indisponível".to_string())?
        .handles
        .remove(label);
    Ok(())
}

pub fn create_preview(
    manager: &tauri::AppHandle<Wry>,
    url: Url,
    bounds: PreviewBounds,
) -> Result<PreviewHandle, String> {
    validate_bounds(bounds)?;
    let label = format!("preview-{}", PREVIEW_ID.fetch_add(1, Ordering::Relaxed));
    let window = manager
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .data_store_identifier(PREVIEW_DATA_STORE)
        .on_navigation(allows_preview_url)
        .on_download(crate::download_guard::deny_download);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| format!("create preview webview failed: {error}"))?;
    manager
        .state::<PreviewRegistry>()
        .0
        .lock()
        .map_err(|_| "Registro de previews indisponível".to_string())?
        .handles
        .insert(label.clone(), webview);
    Ok(PreviewHandle { label })
}

pub fn validate_bounds(bounds: PreviewBounds) -> Result<(), String> {
    if [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|n| n.is_finite())
        && bounds.x >= 0.0
        && bounds.y >= 0.0
        && bounds.width > 0.0
        && bounds.height > 0.0
    {
        Ok(())
    } else {
        Err("preview bounds must be finite and inside the pane".to_string())
    }
}

pub fn set_bounds<R: Runtime>(
    webview: &tauri::Webview<R>,
    bounds: PreviewBounds,
) -> Result<(), String> {
    validate_bounds(bounds)?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("set preview position failed: {error}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| format!("set preview size failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        allows_preview_url, capability_bootstrap_url, parse_preview_url, validate_bounds,
        PreviewBounds, PreviewHandle,
    };
    use tauri::Url;

    #[test]
    fn preview_guard_allows_localhost_and_blocks_non_local_urls() {
        assert!(allows_preview_url(
            &Url::parse("http://localhost:5173/x").unwrap()
        ));
        assert!(!allows_preview_url(
            &Url::parse("https://example.com").unwrap()
        ));
        assert!(!allows_preview_url(
            &Url::parse("file:///tmp/index.html").unwrap()
        ));
        assert!(parse_preview_url("http://127.0.0.1:3000/admin").is_ok());
        assert!(parse_preview_url("http://[::1]:8080/").is_ok());
        assert!(parse_preview_url("http://localhost/no-port").is_err());
    }

    #[test]
    fn external_opener_rejects_os_handlers_and_credentials() {
        for url in [
            "file:///etc/passwd",
            "touri://bot/x",
            "javascript:alert(1)",
            "ftp://example.com",
            "https://user:pass@example.com",
        ] {
            assert!(super::parse_external_url(url).is_err(), "{url}");
        }
        assert!(super::parse_external_url("https://example.com/path").is_ok());
        assert!(parse_preview_url("https://localhost:8443/path").is_ok());
    }

    #[test]
    fn preview_registry_rejects_unowned_labels_and_callers() {
        let mut registry = super::OwnedPreviews {
            handles: std::collections::HashMap::new(),
        };
        registry.handles.insert("preview-1".to_string(), 1);
        assert_eq!(registry.resolve("main", "preview-1"), Ok(1));
        for label in ["main", "secret-card-1", "preview-forged"] {
            assert!(registry.resolve("main", label).is_err());
        }
        assert!(registry.resolve("preview-1", "preview-1").is_err());
        registry.handles.remove("preview-1");
        assert!(registry.resolve("main", "preview-1").is_err());
    }

    #[test]
    fn preview_handle_matches_the_ui_contract() {
        let handle = PreviewHandle {
            label: "preview-1".to_string(),
        };
        assert_eq!(
            serde_json::to_value(handle).unwrap(),
            serde_json::json!({"label": "preview-1"})
        );
    }

    #[test]
    fn preview_rejects_invisible_or_nonfinite_bounds() {
        let bounds = PreviewBounds {
            x: 20.0,
            y: 80.0,
            width: 600.0,
            height: 400.0,
        };
        assert!(validate_bounds(bounds).is_ok());
        assert!(validate_bounds(PreviewBounds {
            width: 0.0,
            ..bounds
        })
        .is_err());
        assert!(validate_bounds(PreviewBounds {
            height: f64::NAN,
            ..bounds
        })
        .is_err());
        assert!(validate_bounds(PreviewBounds { x: -1.0, ..bounds }).is_err());
    }

    #[test]
    fn capability_urls_open_through_the_session_endpoint_and_other_urls_are_untouched() {
        let capability = "ab".repeat(32);
        let parsed = parse_preview_url(&format!(
            "http://127.0.0.1:4100/touri/{capability}/app?x=1&y=2#top"
        ))
        .unwrap();
        assert_eq!(
            parsed.as_str(),
            format!(
                "http://127.0.0.1:4100/touri/{capability}/__touri/session?next=%2Fapp%3Fx%3D1%26y%3D2#top"
            )
        );
        let root = parse_preview_url(&format!("http://127.0.0.1:4100/touri/{capability}")).unwrap();
        assert!(root.as_str().ends_with("/__touri/session?next=%2F"));
        for plain in [
            "http://127.0.0.1:3000/admin",
            "http://localhost:5173/touri/short",
            "http://localhost:5173/touri/ZZ",
            "http://localhost:5173/other/ab",
        ] {
            let url = Url::parse(plain).unwrap();
            assert_eq!(capability_bootstrap_url(&url), url, "{plain}");
        }
        let uppercase =
            Url::parse(&format!("http://127.0.0.1:1/touri/{}", "AB".repeat(32))).unwrap();
        assert_eq!(capability_bootstrap_url(&uppercase), uppercase);
    }
}
