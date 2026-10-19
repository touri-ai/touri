#[cfg(unix)]
#[path = "platform/unix/single_instance.rs"]
mod native;
#[cfg(windows)]
#[path = "platform/windows_single_instance.rs"]
mod native;
pub use native::*;
