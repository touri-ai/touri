//! Private Unix sockets on Unix, token-authenticated loopback streams on Windows.
#[cfg(windows)]
pub use std::net::{TcpListener as Listener, TcpStream as Stream};
#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};
use std::path::{Path, PathBuf};
#[cfg(unix)]
pub fn listen(path: &Path) -> Result<(Listener, PathBuf), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let listener = Listener::bind(path).map_err(|e| format!("bind host socket failed: {e}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    Ok((listener, path.to_path_buf()))
}
#[cfg(windows)]
pub fn listen(_: &Path) -> Result<(Listener, PathBuf), String> {
    listen_loopback().map_err(|e| e.to_string())
}
#[cfg(any(windows, test))]
fn listen_loopback() -> std::io::Result<(std::net::TcpListener, PathBuf)> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let endpoint = PathBuf::from(format!("tcp://{}", listener.local_addr()?));
    Ok((listener, endpoint))
}
pub fn connect(path: &Path) -> std::io::Result<Stream> {
    #[cfg(unix)]
    {
        Stream::connect(path)
    }
    #[cfg(windows)]
    {
        Stream::connect(loopback_address(path)?)
    }
}
#[cfg(any(windows, test))]
fn loopback_address(path: &Path) -> std::io::Result<std::net::SocketAddr> {
    path.to_str()
        .and_then(|s| s.strip_prefix("tcp://"))
        .and_then(|s| s.parse::<std::net::SocketAddr>().ok())
        .filter(|address| address.ip() == std::net::Ipv4Addr::LOCALHOST && address.port() > 0)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid loopback host bridge endpoint",
            )
        })
}
pub fn wake(path: &Path) {
    let _ = connect(path);
}
pub fn cleanup(path: &Path) {
    #[cfg(unix)]
    let _ = std::fs::remove_file(path);
    #[cfg(windows)]
    let _ = path;
}

#[cfg(test)]
pub(crate) fn stream_pair() -> std::io::Result<(Stream, Stream)> {
    #[cfg(windows)]
    let (listener, endpoint) = listen_loopback()?;
    #[cfg(unix)]
    let (listener, endpoint) = {
        let root = std::env::temp_dir().join(format!(
            "touri-stream-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        listen(&root.join("s")).map_err(std::io::Error::other)?
    };
    let client = connect(&endpoint)?;
    let (server, _) = listener.accept()?;
    drop(listener);
    cleanup(&endpoint);
    #[cfg(unix)]
    let _ = std::fs::remove_dir(endpoint.parent().unwrap());
    Ok((server, client))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_loopback_transport_is_exercised_on_every_host() {
        use std::io::{Read, Write};
        let (listener, endpoint) = listen_loopback().unwrap();
        let address = loopback_address(&endpoint).unwrap();
        assert!(address.ip().is_loopback());
        let mut client = std::net::TcpStream::connect(address).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        client.write_all(b"fixture").unwrap();
        let mut bytes = [0; 7];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"fixture");
        for invalid in [
            "tcp://localhost:12",
            "tcp://example.test:12",
            "tcp://127.0.0.1:0",
            "tcp://127.0.0.1:12/path",
        ] {
            assert!(loopback_address(Path::new(invalid)).is_err());
        }
    }
}
