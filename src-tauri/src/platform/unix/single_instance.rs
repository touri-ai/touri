//! Single-instance handoff over a socket in a directory only this OS user can open.
//!
//! The upstream plugin uses a fixed path in the shared `/tmp`. Another macOS account
//! can pre-create that path, receive this user's launch arguments, and make every
//! launch exit silently. Here the socket lives in the per-user Darwin temp directory
//! (0700, owned by the user), and a directory that is not private disables the handoff.
use std::ffi::OsStr;
use std::io::{ErrorKind, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};

const SOCKET_NAME: &str = "ai.touri.desktop.si.sock";
const APP_DATA_ENV: &str = "TOURI_APP_DATA";
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
const SHOW_MESSAGE: &[u8] = b"show\n";

pub enum Claim {
    Primary(UnixListener),
    Secondary,
}

fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// True when only the current user can create, replace or connect to entries in `dir`.
pub fn is_private_directory(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir)
        .map(|meta| meta.is_dir() && meta.uid() == current_uid() && meta.mode() & 0o077 == 0)
        .unwrap_or(false)
}

/// The per-user temp directory macOS assigns at login (`/var/folders/.../T`).
#[cfg(target_os = "macos")]
pub fn private_runtime_dir() -> Option<PathBuf> {
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: the buffer is writable for its full length, which is passed as the size.
    let written = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    if written == 0 || written > buffer.len() {
        return None;
    }
    buffer.truncate(written - 1);
    let dir = PathBuf::from(String::from_utf8(buffer).ok()?);
    is_private_directory(&dir).then_some(dir)
}

#[cfg(not(target_os = "macos"))]
pub fn private_runtime_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        if is_private_directory(&dir) {
            return Some(dir);
        }
    }
    let dir = PathBuf::from(std::env::var_os("HOME")?)
        .join(".cache")
        .join("touri-runtime");
    if !dir.exists() {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(&dir).ok()?;
    }
    is_private_directory(&dir).then_some(dir)
}

pub fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME)
    })
}

/// The default data dir keeps the historical name; an explicit `TOURI_APP_DATA` gets its own
/// socket, so an instance with isolated data never hands off to one running on other data.
/// The hashed name stays short because a Unix socket path is limited to 104 bytes on macOS.
pub fn socket_name(app_data: Option<&OsStr>) -> String {
    match app_data.filter(|value| !value.is_empty()) {
        None => SOCKET_NAME.to_string(),
        Some(value) => format!("touri.si.{:016x}.sock", fnv1a(value.as_bytes())),
    }
}

/// Hands off to a running instance, or becomes the instance that others hand off to.
pub fn claim(dir: &Path, name: &str) -> std::io::Result<Claim> {
    if !is_private_directory(dir) {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "single-instance directory is not private",
        ));
    }
    let path = dir.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_socket() || meta.uid() != current_uid() => {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "single-instance socket is not ours",
            ))
        }
        _ => {}
    }
    match UnixStream::connect(&path) {
        Ok(mut stream) => {
            stream.write_all(SHOW_MESSAGE)?;
            Ok(Claim::Secondary)
        }
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::ConnectionRefused
            ) =>
        {
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            Ok(Claim::Primary(listener))
        }
        Err(error) => Err(error),
    }
}

/// Calls `on_show` once per handoff; the payload is ignored so nothing a peer sends is trusted.
pub fn serve(listener: UnixListener, on_show: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stream.is_ok() {
                on_show();
            }
        }
    });
}

pub fn init<R: Runtime>(on_show: fn(&AppHandle<R>)) -> TauriPlugin<R> {
    tauri::plugin::Builder::new("touri-single-instance")
        .setup(move |app, _api| {
            let Some(dir) = private_runtime_dir() else {
                return Ok(());
            };
            let name = socket_name(std::env::var_os(APP_DATA_ENV).as_deref());
            match claim(&dir, &name) {
                Ok(Claim::Secondary) => std::process::exit(0),
                Ok(Claim::Primary(listener)) => {
                    let handle = app.clone();
                    serve(listener, move || on_show(&handle));
                }
                Err(_) => {}
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{claim, is_private_directory, socket_name, Claim, SOCKET_NAME};
    use std::ffi::OsStr;
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::PathBuf;

    fn private_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("touri-si-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn the_runtime_dir_is_private_and_never_the_shared_tmp() {
        let dir = super::private_runtime_dir().expect("per-user runtime dir");
        assert!(is_private_directory(&dir));
        let canonical = std::fs::canonicalize(&dir).unwrap();
        assert!(!canonical.starts_with("/private/tmp"));
        #[cfg(target_os = "macos")]
        assert!(!canonical.starts_with("/tmp"));
        assert_ne!(canonical, std::env::temp_dir());
    }

    #[test]
    fn the_first_claim_listens_owner_only_and_the_second_hands_off() {
        let dir = private_dir("handoff");
        let Claim::Primary(listener) = claim(&dir, SOCKET_NAME).unwrap() else {
            panic!("first launch must own the socket");
        };
        let socket = dir.join(SOCKET_NAME);
        assert_eq!(std::fs::metadata(&socket).unwrap().mode() & 0o777, 0o600);
        assert!(matches!(
            claim(&dir, SOCKET_NAME).unwrap(),
            Claim::Secondary
        ));
        let (mut stream, _) = listener.accept().unwrap();
        let mut received = Vec::new();
        stream.read_to_end(&mut received).unwrap();
        assert_eq!(received, b"show\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_default_data_dir_keeps_the_historical_socket_name() {
        assert_eq!(socket_name(None), SOCKET_NAME);
        assert_eq!(socket_name(Some(OsStr::new(""))), SOCKET_NAME);
    }

    #[test]
    fn an_explicit_data_dir_gets_its_own_stable_socket_name() {
        let first = socket_name(Some(OsStr::new("/tmp/touri-a")));
        let second = socket_name(Some(OsStr::new("/tmp/touri-b")));
        assert_ne!(first, SOCKET_NAME);
        assert_ne!(first, second);
        assert_eq!(first, socket_name(Some(OsStr::new("/tmp/touri-a"))));
        assert_eq!(first, "touri.si.5efd3af95012abf3.sock");
    }

    #[test]
    fn an_isolated_instance_does_not_hand_off_to_the_default_one() {
        let dir = private_dir("iso");
        let Claim::Primary(_default) = claim(&dir, SOCKET_NAME).unwrap() else {
            panic!("default instance must own its socket");
        };
        let isolated = socket_name(Some(OsStr::new("/tmp/touri-scratch")));
        let Claim::Primary(_isolated) = claim(&dir, &isolated).unwrap() else {
            panic!("an isolated instance must not hand off to the default one");
        };
        assert!(matches!(claim(&dir, &isolated).unwrap(), Claim::Secondary));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_stale_socket_is_replaced_by_a_fresh_owner() {
        let dir = private_dir("stale");
        drop(claim(&dir, SOCKET_NAME).unwrap());
        assert!(matches!(
            claim(&dir, SOCKET_NAME).unwrap(),
            Claim::Primary(_)
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_directory_other_users_can_write_is_refused() {
        let dir = private_dir("shared");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o1777)).unwrap();
        assert!(claim(&dir, SOCKET_NAME).is_err());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(claim(&dir, SOCKET_NAME).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_planted_non_socket_entry_is_never_connected_to() {
        let dir = private_dir("planted");
        std::fs::write(dir.join(SOCKET_NAME), b"not a socket").unwrap();
        assert!(claim(&dir, SOCKET_NAME).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
