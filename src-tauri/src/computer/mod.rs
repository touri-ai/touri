pub mod capture;
mod frontmost;
mod hud;
pub mod input;
mod permissions;

use serde_json::Value;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

pub use permissions::{PermissionState, PermissionsRequestResult, PermissionsStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostError {
    Unavailable,
    PermissionMissing,
    Killed,
    InvalidParams(String),
    Native(String),
}

impl Display for HostError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("computer host unavailable"),
            Self::PermissionMissing => {
                formatter.write_str("Accessibility or Screen Recording permission is missing")
            }
            Self::Killed => formatter.write_str("computer use was stopped"),
            Self::InvalidParams(message) | Self::Native(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for HostError {}

static KILLED: AtomicBool = AtomicBool::new(false);
static KILL_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn dispatch(method: &str, params: Value) -> Result<Value, HostError> {
    match method {
        "permissions.status" => {
            serde_json::to_value(status()).map_err(|error| HostError::Native(error.to_string()))
        }
        "permissions.request" => permissions::request(&params),
        "computer.screenshot" => ensure_live().and_then(|_| capture::screenshot(&params)),
        "computer.click" => ensure_live().and_then(|_| input::click(&params)),
        "computer.move" => ensure_live().and_then(|_| input::move_pointer(&params)),
        "computer.type" => ensure_live().and_then(|_| input::type_text(&params)),
        "computer.key" => ensure_live().and_then(|_| input::key(&params)),
        "computer.scroll" => ensure_live().and_then(|_| input::scroll(&params)),
        "computer.frontmost" => ensure_live().and_then(|_| frontmost::frontmost()),
        "computer.setActive" => set_active(&params),
        _ => Err(HostError::Unavailable),
    }
}

pub fn kill() {
    KILLED.store(true, Ordering::SeqCst);
    KILL_GENERATION.fetch_add(1, Ordering::SeqCst);
    hud::hide();
    hud::set_tray_active(false);
}

pub fn status() -> PermissionsStatus {
    permissions::status()
}

pub fn request_permission(permission: &str) -> Result<PermissionsRequestResult, HostError> {
    permissions::request_permission(permission)
}

pub fn install(app: &tauri::AppHandle<tauri::Wry>) {
    input::install_consent_guard();
    hud::install(app);
}

pub fn key_generation() -> u64 {
    KILL_GENERATION.load(Ordering::SeqCst)
}

#[cfg(target_os = "macos")]
pub(crate) fn input_generation() -> Result<u64, HostError> {
    ensure_live()?;
    Ok(key_generation())
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn ensure_input_generation(generation: u64) -> Result<(), HostError> {
    if KILLED.load(Ordering::SeqCst) || key_generation() != generation {
        Err(HostError::Killed)
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn ensure_live() -> Result<(), HostError> {
    if KILLED.load(Ordering::SeqCst) {
        Err(HostError::Killed)
    } else if !permissions::all_granted() {
        Err(HostError::PermissionMissing)
    } else {
        Ok(())
    }
}

fn set_active(params: &Value) -> Result<Value, HostError> {
    let active = params
        .get("active")
        .and_then(Value::as_bool)
        .ok_or_else(|| HostError::InvalidParams("active is required".to_string()))?;
    if active {
        let generation = params.get("generation").and_then(Value::as_u64);
        let current_generation = key_generation();
        if KILLED.load(Ordering::SeqCst) {
            if generation != Some(current_generation) {
                return Err(HostError::Killed);
            }
            KILLED.store(false, Ordering::SeqCst);
        }
        let bot_name = params
            .get("botName")
            .and_then(Value::as_str)
            .unwrap_or("bot");
        hud::show(bot_name);
        hud::set_tray_active(true);
        if KILLED.load(Ordering::SeqCst) || key_generation() != current_generation {
            hud::hide();
            hud::set_tray_active(false);
            return Err(HostError::Killed);
        }
    } else {
        hud::hide();
        hud::set_tray_active(false);
    }
    serde_json::to_value(serde_json::json!({}))
        .map_err(|error| HostError::Native(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{key_generation, kill, set_active, HostError, KILLED};
    use serde_json::json;
    use std::sync::atomic::Ordering;

    #[test]
    fn stale_activation_cannot_clear_the_kill_generation() {
        let _guard = super::test_lock().lock().expect("test lock");
        KILLED.store(false, Ordering::SeqCst);
        let stale_generation = key_generation();
        kill();
        let stale = set_active(
            &json!({ "active": true, "botName": "test", "generation": stale_generation }),
        );
        assert_eq!(stale, Err(HostError::Killed));
        let current = key_generation();
        assert!(set_active(&json!({
            "active": true,
            "botName": "test",
            "generation": current
        }))
        .is_ok());
        KILLED.store(false, Ordering::SeqCst);
    }
}
