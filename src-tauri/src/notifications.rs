//! Permission checks use the OS, rather than the desktop plugin's unconditional grant.
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::notification_permission::Permission;

impl Serialize for Permission {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

#[cfg(target_os = "macos")]
fn permission(request: bool) -> Permission {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNNotificationSettings, UNUserNotificationCenter,
    };
    use std::{ptr::NonNull, sync::mpsc, time::Duration};

    let center = UNUserNotificationCenter::currentNotificationCenter();
    if request {
        let (sender, receiver) = mpsc::sync_channel(1);
        let completion = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
            let _ = sender.send(());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );
        if receiver.recv_timeout(Duration::from_secs(60)).is_err() {
            return Permission::Unknown;
        }
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: the OS keeps settings alive for this callback.
        let settings = unsafe { settings.as_ref() };
        let state = crate::notification_permission::from_settings(
            settings.authorizationStatus().0,
            settings.alertSetting().0,
            settings.notificationCenterSetting().0,
        );
        let _ = sender.send(state);
    });
    center.getNotificationSettingsWithCompletionHandler(&completion);
    receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or(Permission::Unknown)
}

#[cfg(not(target_os = "macos"))]
fn permission(_request: bool) -> Permission {
    Permission::Unknown
}

#[tauri::command]
pub async fn notification_permission() -> Result<Permission, String> {
    tauri::async_runtime::spawn_blocking(|| permission(false))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notification_system_quiet() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(system_quiet)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn system_quiet() -> bool {
    use windows_sys::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_ACCEPTS_NOTIFICATIONS};

    let mut state = 0;
    let result = unsafe { SHQueryUserNotificationState(&mut state) };
    result >= 0 && state != QUNS_ACCEPTS_NOTIFICATIONS
}

#[cfg(not(target_os = "windows"))]
fn system_quiet() -> bool {
    false
}

#[tauri::command]
pub async fn notification_test(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<Permission, String> {
    let state = tauri::async_runtime::spawn_blocking(|| permission(true))
        .await
        .map_err(|error| error.to_string())?;
    if state == Permission::Granted || state == Permission::Unknown {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())?;
    }
    Ok(state)
}

#[tauri::command]
pub fn notification_open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Notification settings are unavailable on this platform".into())
    }
}

pub fn register_clicks<R: Runtime>(app: &AppHandle<R>) {
    let target_app = app.clone();
    if let Err(error) = app.notification().on_action(move |event| {
        let url = event.notification().and_then(|notification| {
            notification
                .extra()
                .get("deepLink")
                .and_then(serde_json::Value::as_str)
        });
        if let Some(link) = crate::deep_link::notification_target(event.action_id(), url) {
            crate::deep_link::dispatch(&target_app, &link);
        }
    }) {
        eprintln!("[notifications] click handler registration failed: {error}");
    }
}
