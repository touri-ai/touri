use super::{PermissionState, PermissionsRequestResult, PermissionsStatus};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_graphics::access::ScreenCaptureAccess;
use std::ffi::c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

fn accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

fn screen_recording_granted() -> bool {
    ScreenCaptureAccess.preflight()
}

pub(super) fn status() -> PermissionsStatus {
    PermissionsStatus {
        accessibility: if accessibility_granted() {
            PermissionState::Granted
        } else {
            PermissionState::NotDetermined
        },
        screen_recording: if screen_recording_granted() {
            PermissionState::Granted
        } else {
            PermissionState::NotDetermined
        },
    }
}

pub(super) fn all_granted() -> bool {
    accessibility_granted() && screen_recording_granted()
}

pub(super) fn request_permission(
    permission: &str,
) -> Result<PermissionsRequestResult, super::HostError> {
    match permission {
        "accessibility" => {
            let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
            let value = CFBoolean::true_value();
            let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
            let granted = unsafe { AXIsProcessTrustedWithOptions(options.as_CFTypeRef().cast()) };
            Ok(PermissionsRequestResult {
                status: if granted {
                    PermissionState::Granted
                } else {
                    PermissionState::NotDetermined
                },
                needs_relaunch: false,
            })
        }
        "screen-recording" => {
            let granted = ScreenCaptureAccess.request();
            Ok(PermissionsRequestResult {
                status: if granted {
                    PermissionState::Granted
                } else {
                    PermissionState::NotDetermined
                },
                needs_relaunch: !granted,
            })
        }
        _ => Err(super::HostError::InvalidParams(
            "unknown permission".to_string(),
        )),
    }
}
