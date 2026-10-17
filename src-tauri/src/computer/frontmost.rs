use super::HostError;
use serde_json::Value;

#[cfg(target_os = "macos")]
#[path = "../platform/macos/computer_frontmost.rs"]
mod macos;

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::HostError;
    use serde_json::Value;

    pub(super) fn frontmost() -> Result<Value, HostError> {
        Err(HostError::Unavailable)
    }
}

pub fn frontmost() -> Result<Value, HostError> {
    macos::frontmost()
}
