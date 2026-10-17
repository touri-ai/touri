use crate::host_bridge::HostBridgeSender;

#[cfg(target_os = "macos")]
#[path = "platform/macos/power.rs"]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::PowerMonitor;

#[cfg(not(target_os = "macos"))]
#[derive(Debug, Default)]
pub struct PowerMonitor;

#[cfg(not(target_os = "macos"))]
impl PowerMonitor {
    pub fn start(_sender: HostBridgeSender) -> Self {
        Self
    }
}
