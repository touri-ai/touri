use super::HostError;
use objc2_app_kit::NSWorkspace;
use serde_json::Value;

pub(super) fn frontmost() -> Result<Value, HostError> {
    let application = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .ok_or_else(|| HostError::Native("no frontmost application".to_string()))?;
    let app = application
        .localizedName()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "Unknown application".to_string());
    let bundle_id = application
        .bundleIdentifier()
        .map(|value| value.to_string())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "app": app,
        "bundleId": bundle_id,
        "windowTitle": Value::Null,
        "processId": application.processIdentifier(),
        "protectedRegions": crate::computer::input::protected_regions()?
    }))
}
