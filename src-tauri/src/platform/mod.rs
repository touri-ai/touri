//! Native host services. Unsupported features fail closed.
#[cfg(not(target_os = "macos"))]
mod credential_store;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
pub mod transport;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(windows)]
pub mod windows_files;
#[cfg(windows)]
pub(crate) mod windows_job;
#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(target_os = "macos")]
pub use macos::*;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "linux")]
pub(crate) fn configure_webkit_dmabuf_renderer() {
    use std::path::Path;

    const WEBKIT_DMABUF_RENDERER: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    let user_value = std::env::var_os(WEBKIT_DMABUF_RENDERER);
    let has_nvidia_driver = Path::new("/proc/driver/nvidia/version").exists();
    let Some(default_value) = get_webkit_dmabuf_renderer_default(has_nvidia_driver, user_value)
    else {
        return;
    };

    // Set this before native window creation so its web process inherits the fallback.
    std::env::set_var(WEBKIT_DMABUF_RENDERER, default_value);
}

#[cfg(target_os = "linux")]
fn get_webkit_dmabuf_renderer_default(
    has_nvidia_driver: bool,
    user_value: Option<std::ffi::OsString>,
) -> Option<std::ffi::OsString> {
    if !has_nvidia_driver || user_value.is_some() {
        return None;
    }

    Some("1".into())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::get_webkit_dmabuf_renderer_default;
    use std::ffi::OsString;

    #[test]
    fn enables_dmabuf_fallback_for_target_driver_when_unset() {
        let driver_present = true;
        let user_value = None;

        let default_value = get_webkit_dmabuf_renderer_default(driver_present, user_value);

        assert_eq!(default_value, Some(OsString::from("1")));
    }

    #[test]
    fn preserves_a_user_dmabuf_setting() {
        let user_value = Some(OsString::from("0"));

        let default_value = get_webkit_dmabuf_renderer_default(true, user_value);

        assert_eq!(default_value, None);
    }

    #[test]
    fn leaves_other_linux_graphics_drivers_unchanged() {
        let driver_present = false;

        let default_value = get_webkit_dmabuf_renderer_default(driver_present, None);

        assert_eq!(default_value, None);
    }
}
