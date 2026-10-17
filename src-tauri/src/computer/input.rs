#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
use super::HostError;
use serde_json::Value;

const SYNTHETIC_INPUT_MARKER: i64 = 0x746f757269;

fn is_synthetic_input(marker: i64) -> bool {
    marker == SYNTHETIC_INPUT_MARKER
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    Cmd,
    Shift,
    Alt,
    Ctrl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {
    pub modifiers: Vec<Modifier>,
    pub key: String,
}

pub fn parse_key_combo(combo: &str) -> Result<KeyCombo, HostError> {
    let pieces: Vec<&str> = combo.split('+').collect();
    let Some(key) = pieces.last().copied() else {
        return Err(HostError::InvalidParams("key combo is empty".to_string()));
    };
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.')
    {
        return Err(HostError::InvalidParams(
            "key combo contains an invalid key".to_string(),
        ));
    }
    let mut modifiers = Vec::new();
    for modifier in pieces.iter().take(pieces.len().saturating_sub(1)) {
        let parsed = match *modifier {
            "cmd" => Modifier::Cmd,
            "shift" => Modifier::Shift,
            "alt" => Modifier::Alt,
            "ctrl" => Modifier::Ctrl,
            _ => {
                return Err(HostError::InvalidParams(format!(
                    "unknown key modifier: {modifier}"
                )))
            }
        };
        if modifiers.contains(&parsed) {
            return Err(HostError::InvalidParams(
                "key combo repeats a modifier".to_string(),
            ));
        }
        modifiers.push(parsed);
    }
    Ok(KeyCombo {
        modifiers,
        key: key.to_ascii_lowercase(),
    })
}

fn protected_application(pid: i32, bundle: &str, name: &str) -> bool {
    pid == std::process::id() as i32
        || matches!(
            bundle,
            "ai.touri.desktop" | "com.apple.systempreferences" | "com.apple.SecurityAgent"
        )
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "touri" | "system settings" | "system preferences"
        )
}

fn contains_point(bounds: (f64, f64, f64, f64), point: (f64, f64)) -> bool {
    let (x, y, width, height) = bounds;
    point.0 >= x && point.1 >= y && point.0 <= x + width && point.1 <= y + height
}

fn terminal_application(bundle: &str, name: &str) -> bool {
    let identity = format!("{bundle} {name}").to_ascii_lowercase();
    [
        "terminal",
        "iterm",
        "warp",
        "alacritty",
        "kitty",
        "wezterm",
        "ghostty",
        "hyper",
        "tabby",
        "termius",
        "termora",
    ]
    .iter()
    .any(|term| identity.contains(term))
}

#[cfg(target_os = "macos")]
#[path = "../platform/macos/computer_input.rs"]
mod macos;

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::HostError;
    use serde_json::Value;

    pub(super) fn click(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn move_pointer(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn type_text(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn key(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
    pub(super) fn scroll(_: &Value) -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn protected_regions() -> Result<Value, HostError> {
    Ok(serde_json::json!(macos::protected_regions()?
        .into_iter()
        .map(|(x, y, width, height)| {
            serde_json::json!({ "x": x, "y": y, "width": width, "height": height })
        })
        .collect::<Vec<_>>()))
}

pub fn click(params: &Value) -> Result<Value, HostError> {
    macos::click(params)
}

pub fn install_consent_guard() {
    #[cfg(target_os = "macos")]
    macos::install_consent_guard();
}
pub fn move_pointer(params: &Value) -> Result<Value, HostError> {
    macos::move_pointer(params)
}
pub fn type_text(params: &Value) -> Result<Value, HostError> {
    macos::type_text(params)
}
pub fn key(params: &Value) -> Result<Value, HostError> {
    macos::key(params)
}
pub fn scroll(params: &Value) -> Result<Value, HostError> {
    macos::scroll(params)
}

#[cfg(test)]
mod tests {
    use super::{parse_key_combo, Modifier};
    use crate::computer::{ensure_input_generation, key_generation, kill, KILLED};
    use std::sync::atomic::Ordering;

    #[test]
    fn blocks_consent_apps_and_background_window_regions() {
        assert!(super::is_synthetic_input(super::SYNTHETIC_INPUT_MARKER));
        assert!(!super::is_synthetic_input(0));
        assert!(super::protected_application(
            42,
            "ai.touri.desktop",
            "touri"
        ));
        assert!(super::protected_application(
            std::process::id() as i32,
            "dev.bundle",
            "dev"
        ));
        assert!(super::protected_application(
            42,
            "com.apple.systempreferences",
            "Settings"
        ));
        assert!(!super::protected_application(
            42,
            "com.apple.Safari",
            "Safari"
        ));
        assert!(super::contains_point(
            (-100.0, 40.0, 400.0, 200.0),
            (-50.0, 100.0)
        ));
        assert!(!super::contains_point(
            (-100.0, 40.0, 400.0, 200.0),
            (350.0, 100.0)
        ));
        assert!(super::terminal_application(
            "com.apple.Terminal",
            "Terminal"
        ));
        assert!(super::terminal_application(
            "com.mitchellh.ghostty",
            "Ghostty"
        ));
    }

    #[test]
    fn parses_cmd_shift_four() {
        let parsed = parse_key_combo("cmd+shift+4").expect("valid key combo");
        assert_eq!(parsed.modifiers, vec![Modifier::Cmd, Modifier::Shift]);
        assert_eq!(parsed.key, "4");
    }

    #[test]
    fn rejects_unknown_modifiers() {
        assert!(parse_key_combo("meta+4").is_err());
    }

    #[test]
    fn native_input_generation_rejects_events_after_kill() {
        let _guard = crate::computer::test_lock().lock().expect("test lock");
        KILLED.store(false, Ordering::SeqCst);
        let generation = key_generation();
        kill();
        assert!(ensure_input_generation(generation).is_err());
        KILLED.store(false, Ordering::SeqCst);
    }
}
