use super::HostError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Granted,
    Denied,
    NotDetermined,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PermissionsStatus {
    pub accessibility: PermissionState,
    #[serde(rename = "screen-recording")]
    pub screen_recording: PermissionState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsRequestResult {
    pub status: PermissionState,
    pub needs_relaunch: bool,
}

#[cfg(target_os = "macos")]
#[path = "../platform/macos/computer_permissions.rs"]
mod macos;

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::{PermissionState, PermissionsRequestResult, PermissionsStatus};

    pub(super) fn status() -> PermissionsStatus {
        PermissionsStatus {
            accessibility: PermissionState::NotDetermined,
            screen_recording: PermissionState::NotDetermined,
        }
    }

    pub(super) fn all_granted() -> bool {
        false
    }

    pub(super) fn request_permission(
        permission: &str,
    ) -> Result<PermissionsRequestResult, super::HostError> {
        Err(super::HostError::InvalidParams(format!(
            "permission unavailable on this platform: {permission}"
        )))
    }
}

pub fn status() -> PermissionsStatus {
    macos::status()
}

pub fn all_granted() -> bool {
    macos::all_granted()
}

pub fn request_permission(permission: &str) -> Result<PermissionsRequestResult, HostError> {
    macos::request_permission(permission)
}

pub fn request(params: &Value) -> Result<Value, HostError> {
    let permission = params
        .get("permission")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::InvalidParams("permission is required".to_string()))?;
    serde_json::to_value(request_permission(permission)?)
        .map_err(|error| HostError::Native(error.to_string()))
}
