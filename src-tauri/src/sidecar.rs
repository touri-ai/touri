use std::collections::VecDeque;
#[cfg(unix)]
use std::fs::create_dir_all;
use std::fs::{metadata, remove_file, rename, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEndpoint {
    pub base_url: String,
    pub ws_url: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarHandshake {
    #[serde(rename = "type")]
    pub kind: String,
    pub port: u16,
    pub pid: u32,
    pub version: String,
    pub schema_version: u32,
}

pub const SIDECAR_SCHEMA_VERSION: u32 = 29;
const MAX_IDENTICAL_HANDSHAKE_FAILURES: usize = 3;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

pub fn parse_handshake(line: &str) -> Result<SidecarHandshake, String> {
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("parse sidecar handshake failed: {error}"))?;
    if !value.is_object() {
        return Err("invalid sidecar handshake: expected a JSON object".to_string());
    }
    let string = |field: &str| {
        value
            .get(field)
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("invalid sidecar handshake {field}: expected a string"))
    };
    let integer = |field: &str| {
        value
            .get(field)
            .and_then(|value| value.as_u64())
            .ok_or_else(|| {
                format!("invalid sidecar handshake {field}: expected an unsigned integer")
            })
    };
    let kind = string("type")?;
    if kind != "touri-sidecar-ready" {
        return Err(format!(
            "invalid sidecar handshake type: expected touri-sidecar-ready, sidecar reported {kind:?}"
        ));
    }
    let port = integer("port")?;
    if !(1..=u16::MAX as u64).contains(&port) {
        return Err(format!(
            "invalid sidecar handshake port: expected 1..=65535, sidecar reported {port}"
        ));
    }
    let pid = integer("pid")?;
    if !(1..=u32::MAX as u64).contains(&pid) {
        return Err(format!(
            "invalid sidecar handshake pid: expected 1..=4294967295, sidecar reported {pid}"
        ));
    }
    let version = string("version")?;
    if version.trim().is_empty() {
        return Err("invalid sidecar handshake version: expected a non-empty string".to_string());
    }
    let schema_version = integer("schemaVersion")?;
    if schema_version != SIDECAR_SCHEMA_VERSION as u64 {
        return Err(format!(
            "schema mismatch: shell expects {SIDECAR_SCHEMA_VERSION}, sidecar reported {schema_version}"
        ));
    }
    Ok(SidecarHandshake {
        kind: kind.to_string(),
        port: port as u16,
        pid: pid as u32,
        version: version.to_string(),
        schema_version: schema_version as u32,
    })
}

#[derive(Debug)]
struct SpawnFailure {
    reason: String,
    handshake: bool,
}

impl From<String> for SpawnFailure {
    fn from(reason: String) -> Self {
        Self {
            reason,
            handshake: false,
        }
    }
}

#[derive(Default)]
struct HandshakeRetryPolicy {
    last_error: Option<String>,
    consecutive: usize,
}

impl HandshakeRetryPolicy {
    fn record_failure(&mut self, failure: &SpawnFailure) -> bool {
        if !failure.handshake {
            *self = Self::default();
            return false;
        }
        if self.last_error.as_ref() == Some(&failure.reason) {
            self.consecutive += 1;
        } else {
            self.last_error = Some(failure.reason.clone());
            self.consecutive = 1;
        }
        self.consecutive >= MAX_IDENTICAL_HANDSHAKE_FAILURES
    }
}

pub fn next_backoff(previous: Duration) -> Duration {
    if previous.is_zero() {
        Duration::from_secs(1)
    } else {
        previous.saturating_mul(2).min(Duration::from_secs(30))
    }
}

pub struct SidecarLaunch {
    pub app_data: PathBuf,
    pub run_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub host_socket: PathBuf,
    pub host_token: String,
}

impl SidecarLaunch {
    pub fn from_app<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let identifier_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("app data path unavailable: {error}"))?;
        let app_data = std::env::var_os("TOURI_APP_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                identifier_data
                    .parent()
                    .map(|parent| parent.join("touri"))
                    .unwrap_or(identifier_data)
            });
        Self::new(app_data)
    }

    pub fn new(app_data: PathBuf) -> Result<Self, String> {
        create_private_dir(&app_data)
            .map_err(|error| format!("create app data failed: {error}"))?;
        let run_dir = app_data.join("run");
        create_private_dir(&run_dir).map_err(|error| format!("create run dir failed: {error}"))?;
        let logs_dir = app_data.join("logs");
        create_private_dir(&logs_dir)
            .map_err(|error| format!("create logs dir failed: {error}"))?;
        let shell_log = logs_dir.join("sidecar-shell.log");
        private_append_options()
            .open(&shell_log)
            .map_err(|error| format!("create sidecar shell log failed: {error}"))?;
        Ok(Self {
            app_data,
            host_socket: run_dir.join("host.sock"),
            logs_dir,
            run_dir,
            host_token: random_token()?,
        })
    }
}

struct SupervisorState {
    endpoint: Option<SidecarEndpoint>,
    child: Option<Child>,
    last_error: Option<String>,
    handshake_failures: HandshakeRetryPolicy,
    retry_stopped: bool,
    restart_requested: bool,
}

pub struct SidecarSupervisor<R: Runtime> {
    app: AppHandle<R>,
    launch: SidecarLaunch,
    state: Arc<Mutex<SupervisorState>>,
    stop: Arc<AtomicBool>,
    monitor: Option<JoinHandle<()>>,
}

impl<R: Runtime> SidecarSupervisor<R> {
    pub fn start(app: AppHandle<R>, launch: SidecarLaunch) -> Result<Self, String> {
        let mut handshake_failures = HandshakeRetryPolicy::default();
        let (endpoint, child, last_error) = match spawn_sidecar(&app, &launch) {
            Ok((endpoint, child)) => (Some(endpoint), Some(child), None),
            Err(failure) => {
                handshake_failures.record_failure(&failure);
                let _ = app.emit("sidecar-failed", failure.reason.clone());
                (None, None, Some(failure.reason))
            }
        };
        let state = Arc::new(Mutex::new(SupervisorState {
            endpoint: endpoint.clone(),
            child,
            last_error,
            handshake_failures,
            retry_stopped: false,
            restart_requested: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let supervisor = Self {
            app: app.clone(),
            launch,
            state: Arc::clone(&state),
            stop: Arc::clone(&stop),
            monitor: None,
        };
        let launch_for_thread = supervisor.launch_for_thread();
        let monitor = thread::spawn(move || monitor_sidecar(app, launch_for_thread, state, stop));
        let mut supervisor = supervisor;
        supervisor.monitor = Some(monitor);
        if let Some(endpoint) = endpoint {
            let _ = supervisor.app.emit("sidecar-ready", endpoint);
        }
        Ok(supervisor)
    }

    fn launch_for_thread(&self) -> SidecarLaunch {
        SidecarLaunch {
            app_data: self.launch.app_data.clone(),
            run_dir: self.launch.run_dir.clone(),
            logs_dir: self.launch.logs_dir.clone(),
            host_socket: self.launch.host_socket.clone(),
            host_token: self.launch.host_token.clone(),
        }
    }

    pub fn endpoint(&self) -> Option<SidecarEndpoint> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.endpoint.clone())
    }

    pub fn connection_info(&self) -> Result<SidecarEndpoint, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "sidecar state lock poisoned".to_string())?;
        state.endpoint.clone().ok_or_else(|| {
            state
                .last_error
                .clone()
                .unwrap_or_else(|| "sidecar is not ready".to_string())
        })
    }

    pub fn is_running(&self) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| {
                state
                    .child
                    .as_mut()
                    .map(|child| child.try_wait().ok().flatten().is_none())
            })
            .unwrap_or(false)
    }

    pub fn request_restart(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "sidecar state lock poisoned".to_string())?;
        state.endpoint = None;
        state.restart_requested = true;
        Ok(())
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            if let Some(child) = state.child.as_mut() {
                #[cfg(unix)]
                let _ = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
                // End of input runs the same clean shutdown as SIGTERM; the deadline below still kills.
                #[cfg(windows)]
                drop(child.stdin.take());
            }
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let exited = self
                .state
                .lock()
                .ok()
                .and_then(|mut state| {
                    state
                        .child
                        .as_mut()
                        .map(|child| child.try_wait().ok().flatten().is_some())
                })
                .unwrap_or(true);
            if exited || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        if let Ok(mut state) = self.state.lock() {
            if let Some(child) = state.child.as_mut() {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        if let Some(monitor) = self.monitor.take() {
            let _ = monitor.join();
        }
    }
}

impl<R: Runtime> Drop for SidecarSupervisor<R> {
    fn drop(&mut self) {
        self.stop();
    }
}

fn monitor_sidecar<R: Runtime>(
    app: AppHandle<R>,
    launch: SidecarLaunch,
    state: Arc<Mutex<SupervisorState>>,
    stop: Arc<AtomicBool>,
) {
    let mut backoff = Duration::from_secs(1);
    let mut crashes = VecDeque::new();
    loop {
        thread::sleep(Duration::from_millis(100));
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let (needs_restart, crashed, requested) = state
            .lock()
            .map(|mut current| {
                if current.restart_requested {
                    current.restart_requested = false;
                    current.retry_stopped = false;
                    current.handshake_failures = HandshakeRetryPolicy::default();
                    if let Some(mut child) = current.child.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    current.endpoint = None;
                    return (true, false, true);
                }
                if current.retry_stopped {
                    return (false, false, false);
                }
                if let Some(child) = current.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            append_shell_log_line(
                                &launch.logs_dir,
                                &format!("sidecar exited: {status}"),
                            );
                            current.child.take();
                            current.endpoint = None;
                            current.last_error = Some(format!("sidecar exited: {status}"));
                            (true, true, false)
                        }
                        _ => (false, false, false),
                    }
                } else {
                    (current.endpoint.is_none(), false, false)
                }
            })
            .unwrap_or((false, false, false));
        if !needs_restart {
            continue;
        }
        if requested {
            crashes.clear();
            backoff = Duration::from_secs(1);
        }
        if crashed {
            if let Ok(current) = state.lock() {
                if let Some(error) = &current.last_error {
                    let _ = app.emit("sidecar-failed", error.clone());
                }
            }
            let now = Instant::now();
            crashes.push_back(now);
            while crashes
                .front()
                .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(120))
            {
                crashes.pop_front();
            }
            if crashes.len() >= 5 {
                let error = "sidecar stopped after repeated crashes".to_string();
                if let Ok(mut current) = state.lock() {
                    current.retry_stopped = true;
                    current.last_error = Some(error.clone());
                }
                append_shell_log_line(&launch.logs_dir, &error);
                let _ = app.emit("sidecar-failed", error);
                continue;
            }
        }
        // Manual recovery and shutdown must not wait for a 30-second backoff.
        let deadline = Instant::now() + if requested { Duration::ZERO } else { backoff };
        while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
            if state.lock().is_ok_and(|current| current.restart_requested) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if state.lock().is_ok_and(|current| current.restart_requested) {
            continue;
        }
        match spawn_sidecar(&app, &launch) {
            Ok((endpoint, child)) => {
                if let Ok(mut current) = state.lock() {
                    current.endpoint = Some(endpoint.clone());
                    current.child = Some(child);
                    current.last_error = None;
                    current.handshake_failures = HandshakeRetryPolicy::default();
                }
                let _ = app.emit("sidecar-ready", endpoint);
                backoff = Duration::from_secs(1);
            }
            Err(failure) => {
                if let Ok(mut current) = state.lock() {
                    current.endpoint = None;
                    current.child = None;
                    current.last_error = Some(failure.reason.clone());
                    current.retry_stopped = current.handshake_failures.record_failure(&failure);
                    if current.retry_stopped {
                        append_shell_log_line(&launch.logs_dir, &format!(
                            "automatic sidecar retries stopped after {MAX_IDENTICAL_HANDSHAKE_FAILURES} identical handshake failures: {}",
                            failure.reason
                        ));
                    }
                }
                let _ = app.emit("sidecar-failed", failure.reason);
                backoff = next_backoff(backoff);
            }
        }
    }
}

fn spawn_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    launch: &SidecarLaunch,
) -> Result<(SidecarEndpoint, Child), SpawnFailure> {
    let ui_token = random_token()?;
    let binary = sidecar_binary(app);
    append_shell_log_line(
        &launch.logs_dir,
        &format!("starting sidecar: {}", binary.display()),
    );
    let mut command = Command::new(binary);
    // The sidecar is a console executable; without this flag Windows opens a terminal window beside the app.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    inherit_safe_environment(&mut command);
    #[cfg(windows)]
    command.env(
        "TOURI_DESKTOP_HELPER",
        std::env::current_exe().map_err(|error| error.to_string())?,
    );
    // Windows has no SIGTERM. `stop` closes this pipe to ask for a clean shutdown.
    #[cfg(windows)]
    command
        .env("TOURI_SHUTDOWN_ON_STDIN_EOF", "1")
        .stdin(Stdio::piped());
    command
        .arg("serve")
        .env("TOURI_UI_TOKEN", &ui_token)
        .env("TOURI_HOST_TOKEN", &launch.host_token)
        .env("TOURI_APP_DATA", &launch.app_data)
        .env("TOURI_PARENT_PID", std::process::id().to_string())
        .env("TOURI_HOST_SOCK", &launch.host_socket)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        let message = format!("spawn sidecar failed: {error}");
        append_shell_log_line(&launch.logs_dir, &message);
        message
    })?;
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let error = "sidecar stderr unavailable".to_string();
            append_shell_log_line(&launch.logs_dir, &error);
            return Err(error.into());
        }
    };
    let stderr_log = launch.logs_dir.join("sidecar-stderr.log");
    let stderr_thread = thread::spawn(move || log_sidecar_stderr(stderr, stderr_log));
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let error = "sidecar stdout unavailable".to_string();
            let _ = stderr_thread.join();
            append_shell_log_line(&launch.logs_dir, &error);
            return Err(error.into());
        }
    };
    // Reading a line can block forever, including when only part of the JSON arrives.
    // Keep setup and restarts bounded so the webview can offer recovery.
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.read_line(&mut line);
        let _ = sender.send((result, reader, line));
    });
    let (result, mut reader, line) = match receiver.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            let message = "sidecar handshake timed out after 15 seconds".to_string();
            let _ = child.kill();
            let _ = child.wait();
            // A descendant may still hold a pipe open. Reader threads must not
            // turn the startup deadline into another unbounded join.
            append_shell_log_line(&launch.logs_dir, &message);
            return Err(SpawnFailure {
                reason: message,
                handshake: true,
            });
        }
    };
    if let Err(error) = result {
        let message = format!("read sidecar handshake failed: {error}");
        let _ = child.kill();
        let _ = child.wait();
        let _ = stderr_thread.join();
        append_shell_log_line(&launch.logs_dir, &message);
        return Err(message.into());
    }
    let handshake = match parse_handshake(&line) {
        Ok(handshake) => handshake,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_thread.join();
            append_shell_log_line(&launch.logs_dir, &error);
            return Err(SpawnFailure {
                reason: error,
                handshake: true,
            });
        }
    };
    thread::spawn(move || {
        let mut discarded = String::new();
        while reader.read_line(&mut discarded).is_ok() && !discarded.is_empty() {
            discarded.clear();
        }
    });
    Ok((
        SidecarEndpoint {
            base_url: format!("http://127.0.0.1:{}", handshake.port),
            ws_url: format!("ws://127.0.0.1:{}/api/v1/events", handshake.port),
            token: ui_token,
        },
        child,
    ))
}

fn log_sidecar_stderr(stderr: impl std::io::Read, filename: PathBuf) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    let mut scheduling_denial_logged = false;
    while reader.read_line(&mut line).is_ok() && !line.is_empty() {
        let diagnostic = line.trim_end_matches(['\r', '\n']);
        if !is_optional_thread_scheduling_denial(diagnostic) {
            append_sidecar_log_line(
                &filename,
                &sanitize_sidecar_diagnostic(diagnostic),
                "sidecar stderr",
            );
            line.clear();
            continue;
        }
        line.clear();

        if scheduling_denial_logged {
            continue;
        }

        // Permission denial leaves the runtime on its existing scheduling policy.
        append_sidecar_log_line(
            &filename,
            "Optional scheduling adjustment was denied; continuing with the existing thread policy.",
            "sidecar stderr warning",
        );
        scheduling_denial_logged = true;
    }
}

fn is_optional_thread_scheduling_denial(line: &str) -> bool {
    const PREFIX: &str = "Failed to apply scheduling attributes to thread ";
    const SUFFIX: &str = ": Operation not permitted";
    let Some(thread_id) = line
        .strip_prefix(PREFIX)
        .and_then(|line| line.strip_suffix(SUFFIX))
    else {
        return false;
    };

    !thread_id.is_empty()
        && thread_id
            .chars()
            .all(|character| character.is_ascii_digit())
}

fn append_shell_log_line(logs_dir: &Path, line: &str) {
    append_sidecar_log_line(
        &logs_dir.join("sidecar-shell.log"),
        &sanitize_sidecar_diagnostic(line),
        "shell",
    );
}

fn credential_label(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    if lower.rsplit(['-', '_']).next().is_some_and(|suffix| {
        matches!(
            suffix,
            "token" | "secret" | "password" | "passwd" | "credential"
        )
    }) {
        return true;
    }
    matches!(
        lower.replace(['-', '_'], "").as_str(),
        "authorization"
            | "proxyauthorization"
            | "password"
            | "passwd"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "clientsecret"
            | "secret"
            | "token"
            | "credential"
    )
}

fn sanitize_sidecar_diagnostic(line: &str) -> String {
    fn sanitize_value(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(fields) => {
                for (key, value) in fields {
                    if credential_label(key) {
                        *value = serde_json::Value::String("[REDACTED]".into());
                    } else {
                        sanitize_value(value);
                    }
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(sanitize_value),
            serde_json::Value::String(text) => *text = sanitize_diagnostic_text(text),
            _ => {}
        }
    }
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) {
        sanitize_value(&mut value);
        return serde_json::to_string(&value).unwrap_or_else(|_| "Diagnóstico indisponível".into());
    }
    sanitize_diagnostic_text(line)
}

fn sanitize_diagnostic_text(text: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    // Parse labels before formatting. Unknown values are masked as well as
    // recognizable token shapes; no vault values are needed by this boundary.
    while !rest.is_empty() {
        let start = rest
            .find(|c: char| c.is_ascii_alphabetic())
            .unwrap_or(rest.len());
        output.push_str(&rest[..start]);
        rest = &rest[start..];
        if rest.is_empty() {
            break;
        }
        let end = rest
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
            .unwrap_or(rest.len());
        let label = &rest[..end];
        let after = rest[end..].trim_start_matches([' ', '\t', '"', '\'']);
        if credential_label(label) && (after.starts_with(':') || after.starts_with('=')) {
            let mut value = after[1..].trim_start();
            if value.to_ascii_lowercase().starts_with("bearer ")
                || value.to_ascii_lowercase().starts_with("basic ")
            {
                value = value
                    .split_once(' ')
                    .map(|(_, value)| value)
                    .unwrap_or("")
                    .trim_start();
            }
            let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'');
            let length = if let Some(quote) = quote {
                let mut escaped = false;
                value
                    .char_indices()
                    .skip(1)
                    .find_map(|(i, c)| {
                        if escaped {
                            escaped = false;
                            return None;
                        }
                        if c == '\\' {
                            escaped = true;
                            return None;
                        }
                        (c == quote).then_some(i + c.len_utf8())
                    })
                    .unwrap_or(value.len())
            } else {
                value
                    .find(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '}' | ']'))
                    .unwrap_or(value.len())
            };
            output.push_str(label);
            output.push_str(": [REDACTED]");
            rest = &value[length..];
        } else if label.starts_with("sk-")
            || label.starts_with("ghp_")
            || label.starts_with("AKIA")
            || label.starts_with("eyJ")
        {
            let length = rest
                .find(|c: char| {
                    c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';' | '}' | ']')
                })
                .unwrap_or(rest.len());
            output.push_str("[REDACTED]");
            rest = &rest[length..];
        } else {
            output.push_str(label);
            rest = &rest[end..];
        }
    }
    output
        .split_whitespace()
        .map(|word| {
            let path = word.trim_start_matches(['"', '\'', '(', '[']);
            if path.starts_with('/') || (word.contains("://") && word.contains('@')) {
                "[REDACTED]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn append_sidecar_log_line(filename: &Path, line: &str, source: &str) {
    const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
    const RETAINED_GENERATIONS: u32 = 5;
    if metadata(filename)
        .map(|info| info.len())
        .unwrap_or_default()
        > MAX_LOG_BYTES
    {
        for index in (1..=RETAINED_GENERATIONS).rev() {
            let current = filename.with_extension(format!("log.{index}"));
            if index == RETAINED_GENERATIONS {
                let _ = remove_file(&current);
            } else if current.exists() {
                let next = filename.with_extension(format!("log.{}", index + 1));
                let _ = rename(current, next);
            }
        }
        let first = filename.with_extension("log.1");
        let _ = rename(filename, first);
    }
    if let Ok(mut file) = private_append_options().open(filename) {
        let _ = writeln!(file, "{} [{}] {}", unix_timestamp_ms(), source, line);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(filename, std::fs::Permissions::from_mode(0o600));
        }
    }
}

/// Owner-only from the first byte: other macOS accounts never see app data or logs.
fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    return crate::platform::windows_files::ensure_private_directory(path);
    #[cfg(unix)]
    create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(unix)]
    {
        Ok(())
    }
}

fn private_append_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn unix_timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn is_internal_auth_environment(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "TOURI_UI_TOKEN" | "TOURI_HOST_TOKEN" | "TOURI_HOST_SOCK"
    ) {
        return true;
    }
    if upper.starts_with("TOURI_")
        && [
            "TOKEN",
            "AUTH",
            "SOCK",
            "SOCKET",
            "PASSWORD",
            "SECRET",
            "CREDENTIAL",
            "API_KEY",
        ]
        .iter()
        .any(|part| upper.contains(part))
    {
        return true;
    }
    upper.starts_with("MCP_")
        && ["TOKEN", "AUTH", "SECRET", "CREDENTIAL"]
            .iter()
            .any(|part| upper.contains(part))
}

fn inherit_safe_environment(command: &mut Command) {
    command.env_clear();
    for (name, value) in std::env::vars_os() {
        let name_text = name.to_string_lossy();
        if !is_internal_auth_environment(&name_text) {
            command.env(name, value);
        }
    }
}

fn sidecar_binary<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Ok(path) = std::env::var("TOURI_SIDECAR_BIN") {
        return PathBuf::from(path);
    }
    if let Some(sibling) = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent().map(|dir| {
                dir.join(if cfg!(windows) {
                    "touri-sidecar.exe"
                } else {
                    "touri-sidecar"
                })
            })
        })
        .filter(|path| path.exists())
    {
        return sibling;
    }
    let resource = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let bundled = resource
        .join("binaries")
        .join(format!("touri-sidecar-{}", std::env::consts::ARCH));
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from("touri-sidecar")
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("token generation failed: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[allow(dead_code)]
fn is_existing_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    // Tests that replace the process-wide sidecar override cannot run together.
    #[cfg(unix)]
    static SIDECAR_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[cfg(unix)]
    #[test]
    fn r13_app_data_run_and_logs_are_owner_only_even_under_a_loose_umask() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = std::env::temp_dir().join(format!("touri-r13-modes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        // SAFETY: umask only changes this process's default creation mask.
        let previous = unsafe { libc::umask(0o022) };
        let app_data = root.join("touri");
        let launch = super::SidecarLaunch::new(app_data.clone());
        unsafe { libc::umask(previous) };
        let launch = launch.unwrap();
        for dir in [&app_data, &launch.run_dir, &launch.logs_dir] {
            assert_eq!(
                std::fs::metadata(dir).unwrap().mode() & 0o777,
                0o700,
                "{dir:?}"
            );
        }
        let shell_log = launch.logs_dir.join("sidecar-shell.log");
        assert_eq!(std::fs::metadata(&shell_log).unwrap().mode() & 0o777, 0o600);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stderr_ingestion_masks_credential_labels() {
        let dir =
            std::env::temp_dir().join(format!("touri-stderr-redaction-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stderr.log");
        let input = concat!(
            "Authorization: Bearer synthetic-fixture-token\n",
            "{\"password\":\"synthetic-fixture-password\"}\n",
            "AUTH_TOKEN=synthetic-prefixed-credential\n"
        );
        super::log_sidecar_stderr(std::io::Cursor::new(input.as_bytes()), path.clone());
        let log = std::fs::read_to_string(path).unwrap();
        assert!(!log.contains("synthetic-fixture-token"));
        assert!(!log.contains("synthetic-fixture-password"));
        assert!(!log.contains("synthetic-prefixed-credential"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stderr_ingestion_compacts_optional_scheduling_denials_and_keeps_reading() {
        let dir =
            std::env::temp_dir().join(format!("touri-scheduler-stderr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stderr.log");
        let input = concat!(
            "Failed to apply scheduling attributes to thread 101: Operation not permitted\n",
            "Failed to apply scheduling attributes to thread 102: Operation not permitted\n",
            "Failed to apply scheduling attributes to thread 103: Permission denied\n",
            "sidecar ready after scheduling denial\n"
        );

        super::log_sidecar_stderr(std::io::Cursor::new(input.as_bytes()), path.clone());

        let log = std::fs::read_to_string(path).unwrap();
        assert_eq!(
            log.matches("Optional scheduling adjustment was denied")
                .count(),
            1
        );
        assert!(log.contains("[sidecar stderr warning]"));
        assert!(!log.contains("thread 101"));
        assert!(!log.contains("thread 102"));
        assert!(log.contains("thread 103: Permission denied"));
        assert!(log.contains("sidecar ready after scheduling denial"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    use super::{
        is_internal_auth_environment, next_backoff, parse_handshake, HandshakeRetryPolicy,
        SpawnFailure, MAX_IDENTICAL_HANDSHAKE_FAILURES, SIDECAR_SCHEMA_VERSION,
    };
    #[cfg(unix)]
    use super::{SidecarLaunch, SidecarSupervisor};
    use std::time::Duration;

    #[test]
    fn schema_version_matches_sidecar_migrations() {
        let migrations = std::fs::read_dir(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sidecar/src/kernel/migrations"
        ))
        .expect("migrations dir")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "sql"))
        .count();
        assert_eq!(migrations as u32, SIDECAR_SCHEMA_VERSION);
    }

    #[test]
    fn current_sidecar_schema_handshake_is_accepted() {
        let schema = include_str!("../../sidecar/src/kernel/db.ts")
            .lines()
            .find_map(|line| line.strip_prefix("export const SCHEMA_VERSION = "))
            .expect("sidecar schema declaration")
            .trim_end_matches(';')
            .parse::<u32>()
            .expect("sidecar schema number");
        let handshake = serde_json::json!({
            "type": "touri-sidecar-ready",
            "port": 43123,
            "pid": 99,
            "version": "0.3.0",
            "schemaVersion": schema,
        });
        let parsed = parse_handshake(&handshake.to_string())
            .expect("the current sidecar must be able to start the desktop");
        assert_eq!(parsed.schema_version, schema);
    }

    #[test]
    fn handshake_parser_accepts_only_the_contract() {
        let parsed = parse_handshake(&format!(
            r#"{{"type":"touri-sidecar-ready","port":43123,"pid":99,"version":"0.3.0","schemaVersion":{SIDECAR_SCHEMA_VERSION}}}"#
        ))
        .expect("valid handshake");
        assert_eq!(parsed.port, 43123);
        assert_eq!(parsed.schema_version, SIDECAR_SCHEMA_VERSION);
        assert!(parse_handshake(&format!(
            r#"{{"type":"wrong","port":43123,"pid":99,"version":"0.3.0","schemaVersion":{SIDECAR_SCHEMA_VERSION}}}"#
        ))
        .is_err());
        assert!(parse_handshake(
            r#"{"type":"touri-sidecar-ready","port":43123,"pid":99,"version":"0.3.0","schemaVersion":3}"#,
        )
        .is_err());
    }

    #[test]
    fn handshake_errors_explain_the_invalid_field() {
        let valid = serde_json::json!({
            "type": "touri-sidecar-ready", "port": 43123, "pid": 99,
            "version": "0.3.0", "schemaVersion": SIDECAR_SCHEMA_VERSION
        });
        let schema_mismatch_reason =
            format!("schema mismatch: shell expects {SIDECAR_SCHEMA_VERSION}, sidecar reported 5");
        let cases = [
            ("schemaVersion", serde_json::json!(5), schema_mismatch_reason.as_str()),
            ("type", serde_json::json!("wrong"), "invalid sidecar handshake type: expected touri-sidecar-ready, sidecar reported \"wrong\""),
            ("type", serde_json::json!(42), "invalid sidecar handshake type: expected a string"),
            ("port", serde_json::json!(0), "invalid sidecar handshake port: expected 1..=65535, sidecar reported 0"),
            ("port", serde_json::json!(65536), "invalid sidecar handshake port: expected 1..=65535, sidecar reported 65536"),
            ("port", serde_json::json!("43123"), "invalid sidecar handshake port: expected an unsigned integer"),
            ("port", serde_json::json!(-1), "invalid sidecar handshake port: expected an unsigned integer"),
            ("pid", serde_json::json!(0), "invalid sidecar handshake pid: expected 1..=4294967295, sidecar reported 0"),
            ("version", serde_json::json!(" "), "invalid sidecar handshake version: expected a non-empty string"),
            ("schemaVersion", serde_json::json!("6"), "invalid sidecar handshake schemaVersion: expected an unsigned integer"),
        ];
        for (field, value, expected) in cases {
            let mut handshake = valid.clone();
            handshake[field] = value;
            assert_eq!(
                parse_handshake(&handshake.to_string()).unwrap_err(),
                expected
            );
        }
        let mut missing = valid;
        missing.as_object_mut().unwrap().remove("port");
        assert_eq!(
            parse_handshake(&missing.to_string()).unwrap_err(),
            "invalid sidecar handshake port: expected an unsigned integer"
        );
        assert_eq!(
            parse_handshake("[]").unwrap_err(),
            "invalid sidecar handshake: expected a JSON object"
        );
        assert!(parse_handshake("not JSON")
            .unwrap_err()
            .starts_with("parse sidecar handshake failed:"));
    }

    #[test]
    fn identical_handshake_failures_stop_at_the_limit() {
        let failure = SpawnFailure {
            reason: "schema mismatch: shell expects 8, sidecar reported 5".to_string(),
            handshake: true,
        };
        let mut policy = HandshakeRetryPolicy::default();
        for attempt in 1..=MAX_IDENTICAL_HANDSHAKE_FAILURES {
            assert_eq!(
                policy.record_failure(&failure),
                attempt == MAX_IDENTICAL_HANDSHAKE_FAILURES
            );
        }
        assert_eq!(policy.last_error.as_ref(), Some(&failure.reason));
        assert!(policy.record_failure(&failure));
        // Success and manual restart both reset the same policy.
        policy = HandshakeRetryPolicy::default();
        assert!(!policy.record_failure(&failure));
    }

    #[test]
    fn only_consecutive_identical_handshake_failures_count() {
        let mut policy = HandshakeRetryPolicy::default();
        let failure = SpawnFailure {
            reason: "schema mismatch".to_string(),
            handshake: true,
        };
        assert!(!policy.record_failure(&failure));
        assert!(!policy.record_failure(&failure));
        let changed = SpawnFailure {
            reason: "invalid version".to_string(),
            handshake: true,
        };
        assert!(!policy.record_failure(&changed));
        assert_eq!(policy.consecutive, 1);
        assert!(!policy.record_failure(&failure));
        let transient =
            SpawnFailure::from("spawn sidecar failed: temporarily unavailable".to_string());
        for _ in 0..10 {
            assert!(!policy.record_failure(&transient));
        }
        assert!(!policy.record_failure(&failure));
        assert_eq!(policy.consecutive, 1);
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_preserves_the_failure_and_manual_restart_resumes_after_the_limit() {
        let _environment = SIDECAR_ENV_LOCK.lock().unwrap();
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        struct Fixture {
            root: std::path::PathBuf,
            previous_binary: Option<std::ffi::OsString>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Some(previous) = &self.previous_binary {
                    std::env::set_var("TOURI_SIDECAR_BIN", previous);
                } else {
                    std::env::remove_var("TOURI_SIDECAR_BIN");
                }
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
        let fixture = Fixture {
            root: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join(format!("handshake-failure-test-{}", std::process::id())),
            previous_binary: std::env::var_os("TOURI_SIDECAR_BIN"),
        };
        std::fs::create_dir_all(&fixture.root).unwrap();
        let script = fixture.root.join("fake-sidecar.sh");
        let handshake = |schema| {
            format!(
            "#!/bin/sh\nprintf '%s\\n' '{{\"type\":\"touri-sidecar-ready\",\"port\":43123,\"pid\":99,\"version\":\"0.3.0\",\"schemaVersion\":{schema}}}'\n"
        )
        };
        std::fs::write(&script, handshake(5)).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("TOURI_SIDECAR_BIN", &script);
        let app = tauri::test::mock_app();
        let launch = SidecarLaunch::new(fixture.root.join("app-data")).unwrap();
        let log = launch.logs_dir.join("sidecar-shell.log");
        let mut supervisor = SidecarSupervisor::start(app.handle().clone(), launch).unwrap();
        let deadline = Instant::now() + Duration::from_secs(6);
        while !supervisor.state.lock().unwrap().retry_stopped && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(supervisor.state.lock().unwrap().retry_stopped);
        let reason =
            format!("schema mismatch: shell expects {SIDECAR_SCHEMA_VERSION}, sidecar reported 5");
        assert_eq!(supervisor.connection_info().unwrap_err(), reason);
        std::thread::sleep(Duration::from_millis(1100));
        let logs = std::fs::read_to_string(log).unwrap();
        assert_eq!(
            logs.matches("starting sidecar:").count(),
            MAX_IDENTICAL_HANDSHAKE_FAILURES
        );
        assert_eq!(
            logs.matches(reason.as_str()).count(),
            MAX_IDENTICAL_HANDSHAKE_FAILURES + 1
        );
        assert!(
            logs.contains("automatic sidecar retries stopped after 3 identical handshake failures")
        );
        assert_eq!(supervisor.connection_info().unwrap_err(), reason);

        std::fs::write(
            &script,
            format!("{}exec sleep 60\n", handshake(SIDECAR_SCHEMA_VERSION)),
        )
        .unwrap();
        supervisor.request_restart().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while supervisor.endpoint().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            supervisor.endpoint().is_some(),
            "manual restart must wake the stopped supervisor"
        );
        assert!(supervisor.state.lock().unwrap().last_error.is_none());
        supervisor.stop();
    }

    #[cfg(unix)]
    #[test]
    fn an_unterminated_handshake_times_out_and_reaps_the_child() {
        let _environment = SIDECAR_ENV_LOCK.lock().unwrap();
        use std::os::unix::fs::PermissionsExt;

        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("stalled-handshake-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("fake-sidecar.sh");
        let child_pid = root.join("fake-sidecar.sh.pid");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s' \"$$\" > \"$0.pid\"\nprintf '%s' '{\"type\":'\nexec sleep 60\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let previous = std::env::var_os("TOURI_SIDECAR_BIN");
        std::env::set_var("TOURI_SIDECAR_BIN", &script);
        let app = tauri::test::mock_app();
        let launch = SidecarLaunch::new(root.join("app-data")).unwrap();
        let result = super::spawn_sidecar(app.handle(), &launch);
        if let Some(previous) = previous {
            std::env::set_var("TOURI_SIDECAR_BIN", previous);
        } else {
            std::env::remove_var("TOURI_SIDECAR_BIN");
        }
        let pid = std::fs::read_to_string(child_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let log = std::fs::read_to_string(launch.logs_dir.join("sidecar-shell.log")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        let failure = result.expect_err("a partial handshake must fail");
        assert_eq!(
            failure.reason,
            "sidecar handshake timed out after 15 seconds"
        );
        assert!(
            failure.handshake,
            "repeated startup stalls must use the bounded retry policy"
        );
        assert!(log.contains(&failure.reason));
        // The timed-out process must be killed and waited on, not left running or zombied.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }

    #[test]
    fn restart_backoff_is_bounded() {
        assert_eq!(next_backoff(Duration::ZERO), Duration::from_secs(1));
        assert_eq!(
            next_backoff(Duration::from_secs(16)),
            Duration::from_secs(30)
        );
        assert_eq!(
            next_backoff(Duration::from_secs(30)),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn internal_auth_environment_is_not_inherited() {
        assert!(is_internal_auth_environment("TOURI_UI_TOKEN"));
        assert!(is_internal_auth_environment("TOURI_MCP_TOKEN"));
        assert!(is_internal_auth_environment("MCP_AUTH_TOKEN"));
        assert!(!is_internal_auth_environment("TOURI_APP_DATA"));
        assert!(!is_internal_auth_environment("PATH"));
    }
}
