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
