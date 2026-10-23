//! The webview always runs bundled code. Only this native relay knows the server credential.
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use axum::body::{to_bytes, Body};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::{oneshot, Semaphore};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;

use crate::keychain::KeychainStore;
use crate::sidecar::SidecarEndpoint;
#[cfg(test)]
use crate::sidecar::SIDECAR_SCHEMA_VERSION;
use crate::AppState;

const CONFIG_FILE: &str = "server-mode.json";
const CLIENT_NAME: &str = "touri desktop";
const MAX_BODY: usize = 32 * 1024 * 1024;
const SMALL_BODY: usize = 16 * 1024;
const TICKET_TTL: Duration = Duration::from_secs(15);
const MAX_TICKETS: usize = 128;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Local,
    Server,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ServerModeStatus {
    pub mode: Mode,
    pub url: Option<String>,
}

impl ServerModeStatus {
    fn unavailable() -> Self {
        Self {
            mode: Mode::Server,
            url: None,
        }
    }
}

/// Startup chooses exactly one runtime before evaluating any local launch/bridge initialization.
pub fn select_runtime<T>(
    mode: &ServerModeStatus,
    local: impl FnOnce() -> T,
    server: impl FnOnce() -> T,
) -> T {
    match mode.mode {
        Mode::Local => local(),
        Mode::Server => server(),
    }
}

/// Missing configuration means local. Invalid/unreadable configuration fails closed to server mode.
pub fn load_mode(path: &Path) -> ServerModeStatus {
    match fs::read(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ServerModeStatus::default(),
        Err(_) => ServerModeStatus::unavailable(),
        Ok(bytes) => parse_mode(&bytes).unwrap_or_else(|_| ServerModeStatus::unavailable()),
    }
}

fn parse_mode(bytes: &[u8]) -> Result<ServerModeStatus, String> {
    let config: ServerModeStatus =
        serde_json::from_slice(bytes).map_err(|_| "SERVER_CONFIG_INVALID")?;
    match config.mode {
        Mode::Local if config.url.is_none() => Ok(config),
        Mode::Server => Ok(ServerModeStatus {
            mode: Mode::Server,
            url: Some(normalize_server_url(
                config.url.as_deref().ok_or("SERVER_CONFIG_INVALID")?,
            )?),
        }),
        _ => Err("SERVER_CONFIG_INVALID".into()),
    }
}

pub fn normalize_server_url(input: &str) -> Result<String, String> {
    if input.len() > 2048 {
        return Err("SERVER_URL_INVALID".into());
    }
    let url = Url::parse(input.trim()).map_err(|_| "SERVER_URL_INVALID")?;
    let loopback_http = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if (url.scheme() != "https" && !loopback_http)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("SERVER_URL_INVALID".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn account(url: &str) -> String {
    format!("server-mode/{url}")
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "SERVER_RANDOM_FAILED")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn config_path(app: &AppHandle<Wry>) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|_| "SERVER_CONFIG_UNAVAILABLE".into())
}

fn persist_mode(path: &Path, status: &ServerModeStatus) -> Result<(), String> {
    let parent = path.parent().ok_or("SERVER_CONFIG_UNAVAILABLE")?;
    fs::create_dir_all(parent).map_err(|_| "SERVER_CONFIG_UNAVAILABLE")?;
    let temp = parent.join(format!(".server-mode-{}", random_secret()?));
    let write = || -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|_| "SERVER_CONFIG_UNAVAILABLE")?;
        let bytes = serde_json::to_vec(status).map_err(|_| "SERVER_CONFIG_UNAVAILABLE")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "SERVER_CONFIG_UNAVAILABLE")?;
        fs::rename(&temp, path).map_err(|_| "SERVER_CONFIG_UNAVAILABLE")?;
        Ok(())
    };
    let result = write();
    let _ = fs::remove_file(temp);
    result
}

fn ensure_crypto_provider() {
    static INITIALIZED: Once = Once::new();
    INITIALIZED.call_once(|| {
        // Share one provider with the updater and the WebSocket TLS transport. A provider already
        // selected by another native component remains valid; install_default never replaces it.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn native_client() -> Result<Client, String> {
    ensure_crypto_provider();
    Client::builder()
        // All callers validate an HTTPS origin (or explicit loopback HTTP for a local server).
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "SERVER_CONNECTION_FAILED".into())
}

fn valid_token(token: &str) -> bool {
    (16..=4096).contains(&token.len())
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

async fn small_json(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "SERVER_PAIRING_REQUIRED",
            429 => "SERVER_RATE_LIMITED",
            _ => "SERVER_CONNECTION_FAILED",
        }
        .into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "SERVER_CONNECTION_FAILED")?
    {
        if body.len() + chunk.len() > SMALL_BODY {
            return Err("SERVER_RESPONSE_INVALID".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "SERVER_RESPONSE_INVALID".into())
}

async fn check_connection(client: &Client, url: &str, token: &str) -> Result<(), String> {
    for path in ["/api/v1/session", "/api/v1/health"] {
        let response = client
            .get(format!("{url}{path}"))
            .timeout(Duration::from_secs(12))
            .bearer_auth(token)
            .header("X-Touri-Client", CLIENT_NAME)
            .send()
            .await
            .map_err(|_| "SERVER_CONNECTION_FAILED")?;
        let value = small_json(response).await?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("SERVER_RESPONSE_INVALID".into());
        }
        if path.ends_with("/health") && !is_protocol_compatible(&value) {
            return Err("SERVER_VERSION_MISMATCH".into());
        }
    }
    Ok(())
}

fn is_protocol_compatible(health: &Value) -> bool {
    let protocol: Value =
        serde_json::from_str(include_str!("../../packages/contracts/protocol.json"))
            .expect("bundled protocol metadata is valid JSON");
    if let Some(version) = health.get("protocolVersion") {
        return version.as_u64() == protocol["version"].as_u64();
    }
    health.get("schemaVersion").and_then(Value::as_u64) == protocol["legacySchemaVersion"].as_u64()
}

fn may_read_mode(label: &str) -> bool {
    label == "main"
        || label.strip_prefix("computer-").is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        })
}

fn require_main(caller: &tauri::Webview<Wry>) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("SERVER_WINDOW_FORBIDDEN".into())
    }
}

fn restart_soon(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        app.request_restart();
    });
}

#[tauri::command]
pub fn server_mode_status(
    caller: tauri::Webview<Wry>,
    state: tauri::State<'_, AppState>,
) -> Result<ServerModeStatus, String> {
    if !may_read_mode(caller.label()) {
        return Err("SERVER_WINDOW_FORBIDDEN".into());
    }
    state
        .server_mode
        .lock()
        .map(|mode| mode.clone())
        .map_err(|_| "SERVER_STATE_UNAVAILABLE".into())
}

#[tauri::command]
pub async fn server_mode_pair(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    state: tauri::State<'_, AppState>,
    url: String,
    code: String,
) -> Result<ServerModeStatus, String> {
    require_main(&caller)?;
    let _operation = state.server_mode_operation.lock().await;
    let url = normalize_server_url(&url)?;
    let code = code.trim();
    if code.is_empty()
        || code.len() > 128
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"- ".contains(&byte))
    {
        return Err("SERVER_CODE_INVALID".into());
    }
    let client = native_client()?;
    let response = client
        .post(format!("{url}/pair"))
        .timeout(Duration::from_secs(12))
        .header("X-Touri-Client", CLIENT_NAME)
        .json(&json!({ "code": code, "name": CLIENT_NAME, "client": true }))
        .send()
        .await
        .map_err(|_| "SERVER_CONNECTION_FAILED")?;
    let payload = small_json(response).await?;
    let token = payload
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| valid_token(token))
        .ok_or("SERVER_RESPONSE_INVALID")?
        .to_owned();
    check_connection(&client, &url, &token).await?;
    let keychain = state.keychain.clone();
    let vault_account = account(&url);
    tauri::async_runtime::spawn_blocking(move || {
        keychain
            .set(&vault_account, &token)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "VAULT_UNAVAILABLE")??;
    let status = ServerModeStatus {
        mode: Mode::Server,
        url: Some(url),
    };
    persist_mode(&config_path(&app)?, &status)?;
    *state
        .server_mode
        .lock()
        .map_err(|_| "SERVER_STATE_UNAVAILABLE")? = status.clone();
    restart_soon(app);
    Ok(status)
}

#[tauri::command]
pub async fn server_mode_test(
    caller: tauri::Webview<Wry>,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    require_main(&caller)?;
    let mode = state
        .server_mode
        .lock()
        .map_err(|_| "SERVER_STATE_UNAVAILABLE")?
        .clone();
    if mode.mode != Mode::Server {
        return Err("SERVER_MODE_REQUIRED".into());
    }
    let url = mode.url.ok_or("SERVER_CONFIG_INVALID")?;
    let keychain = state.keychain.clone();
    let vault_account = account(&url);
    let token = tauri::async_runtime::spawn_blocking(move || {
        keychain
            .get(&vault_account)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "VAULT_UNAVAILABLE")??
    .ok_or("SERVER_PAIRING_REQUIRED")?;
    check_connection(&native_client()?, &url, &token).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn server_mode_local(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    state: tauri::State<'_, AppState>,
) -> Result<ServerModeStatus, String> {
    require_main(&caller)?;
    let _operation = state.server_mode_operation.lock().await;
    let status = ServerModeStatus::default();
    persist_mode(&config_path(&app)?, &status)?;
    *state
        .server_mode
        .lock()
        .map_err(|_| "SERVER_STATE_UNAVAILABLE")? = status.clone();
    restart_soon(app);
    Ok(status)
}

struct Ticket {
    path: String,
    expires: Instant,
}
#[derive(Default)]
struct Tickets(HashMap<String, Ticket>);
impl Tickets {
    fn mint(&mut self, path: &str) -> Result<String, String> {
        self.0.retain(|_, item| item.expires > Instant::now());
        if !socket_path(path) {
            return Err("INVALID_ARGS".into());
        }
        if self.0.len() >= MAX_TICKETS {
            return Err("RATE_LIMITED".into());
        }
        let ticket = random_secret()?;
        self.0.insert(
            ticket.clone(),
            Ticket {
                path: path.to_owned(),
                expires: Instant::now() + TICKET_TTL,
            },
        );
        Ok(ticket)
    }
    fn consume(&mut self, ticket: &str, path: &str) -> bool {
        self.0
            .remove(ticket)
            .is_some_and(|item| item.path == path && item.expires > Instant::now())
    }
}

fn socket_path(path: &str) -> bool {
    if path == "/api/v1/events" {
        return true;
    }
    if let Some(id) = path
        .strip_prefix("/api/v1/desktop/")
        .and_then(|path| path.strip_suffix("/socket"))
    {
        return id.len() == 48
            && id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    }
    path.strip_prefix("/api/v1/bots/")
        .and_then(|path| path.strip_suffix("/machine/presence/socket"))
        .is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn api_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    path.starts_with("/api/v1/")
        && !path.contains('\\')
        && !path.split('/').any(|part| part == "." || part == "..")
        && !["%2e", "%2f", "%5c", "%00"]
            .iter()
            .any(|part| lower.contains(part))
        && path != "/api/v1/session/rotate"
}

fn allowed_origin(origin: Option<&str>) -> bool {
    matches!(
        origin,
        Some("tauri://localhost" | "http://tauri.localhost" | "http://localhost:1420")
    )
}

fn token_matches(actual: &str, expected: &str) -> bool {
    actual.len() == expected.len()
        && actual
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

#[derive(Clone, Copy)]
struct RelayTiming {
    ping_interval: Duration,
    idle_timeout: Duration,
    send_timeout: Duration,
}

impl Default for RelayTiming {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(15),
            idle_timeout: Duration::from_secs(45),
            send_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Clone)]
struct CachedCredential {
    token: String,
    compatible: bool,
}

struct RelayState {
    url: Option<String>,
    port: u16,
    bearer: String,
    keychain: KeychainStore,
    credential: Mutex<Option<CachedCredential>>,
    credential_operation: tokio::sync::Mutex<()>,
    client: Client,
    tickets: Mutex<Tickets>,
    connections: Arc<Semaphore>,
    timing: RelayTiming,
}

impl RelayState {
    async fn token(&self) -> Result<String, String> {
        self.validated_token(false).await
    }

    async fn validated_token(&self, revalidate: bool) -> Result<String, String> {
        let _operation = self.credential_operation.lock().await;
        let cached = self
            .credential
            .lock()
            .map_err(|_| "VAULT_UNAVAILABLE")?
            .clone();
        if let Some(value) = cached.as_ref() {
            if value.compatible && !revalidate {
                return Ok(value.token.clone());
            }
        }
        let url = self.url.as_deref().ok_or("SERVER_CONFIG_INVALID")?;
        let token = if let Some(value) = cached {
            value.token
        } else {
            let vault_account = account(url);
            let keychain = self.keychain.clone();
            tauri::async_runtime::spawn_blocking(move || {
                keychain
                    .get(&vault_account)
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|_| "VAULT_UNAVAILABLE")??
            .filter(|value| valid_token(value))
            .ok_or("SERVER_PAIRING_REQUIRED")?
        };
        // A saved token establishes identity, not protocol compatibility. Never expose an API until
        // the selected server authenticates the session and reports a compatible HTTP/event protocol.
        *self.credential.lock().map_err(|_| "VAULT_UNAVAILABLE")? = Some(CachedCredential {
            token: token.clone(),
            compatible: false,
        });
        check_connection(&self.client, url, &token).await?;
        *self.credential.lock().map_err(|_| "VAULT_UNAVAILABLE")? = Some(CachedCredential {
            token: token.clone(),
            compatible: true,
        });
        Ok(token)
    }
}

pub struct ServerRelay {
    shutdown: Option<oneshot::Sender<()>>,
}
impl Drop for ServerRelay {
    fn drop(&mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
    }
}

pub fn start_relay(
    mode: &ServerModeStatus,
    keychain: KeychainStore,
) -> Result<(ServerRelay, SidecarEndpoint), String> {
    start_relay_inner(mode, keychain, None, RelayTiming::default())
}

fn start_relay_inner(
    mode: &ServerModeStatus,
    keychain: KeychainStore,
    credential: Option<String>,
    timing: RelayTiming,
) -> Result<(ServerRelay, SidecarEndpoint), String> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "SERVER_RELAY_UNAVAILABLE")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "SERVER_RELAY_UNAVAILABLE")?;
    let port = listener
        .local_addr()
        .map_err(|_| "SERVER_RELAY_UNAVAILABLE")?
        .port();
    let bearer = random_secret()?;
    let state = Arc::new(RelayState {
        url: mode.url.as_deref().map(normalize_server_url).transpose()?,
        port,
        bearer: bearer.clone(),
        keychain,
        credential: Mutex::new(credential.map(|token| CachedCredential {
            token,
            compatible: false,
        })),
        credential_operation: tokio::sync::Mutex::new(()),
        client: native_client()?,
        tickets: Mutex::new(Tickets::default()),
        connections: Arc::new(Semaphore::new(64)),
        timing,
    });
    let (shutdown, stopped) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        let router = Router::new().fallback(relay_request).with_state(state);
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
    });
    Ok((
        ServerRelay {
            shutdown: Some(shutdown),
        },
        SidecarEndpoint {
            base_url: format!("http://127.0.0.1:{port}"),
            ws_url: format!("ws://127.0.0.1:{port}/api/v1/events"),
            token: bearer,
        },
    ))
}

fn failure(status: StatusCode, code: &str) -> Response {
    (
        status,
        axum::Json(json!({ "errorCode": code, "error": code })),
    )
        .into_response()
}

fn with_cors(mut response: Response, origin: Option<&str>) -> Response {
    response
        .headers_mut()
        .insert("Cache-Control", HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    if allowed_origin(origin) {
        if let Ok(origin) = HeaderValue::from_str(origin.unwrap()) {
            response
                .headers_mut()
                .insert("Access-Control-Allow-Origin", origin);
            response
                .headers_mut()
                .insert("Vary", HeaderValue::from_static("Origin"));
            response.headers_mut().insert(
                "Access-Control-Expose-Headers",
                HeaderValue::from_static("Content-Type, Content-Disposition, Retry-After"),
            );
        }
    }
    response
}

async fn relay_request(State(state): State<Arc<RelayState>>, request: Request) -> Response {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let response = relay_inner(state, request).await;
    with_cors(response, origin.as_deref())
}

async fn relay_inner(state: Arc<RelayState>, request: Request) -> Response {
    let Ok(permit) = Arc::clone(&state.connections).try_acquire_owned() else {
        return failure(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED");
    };
    if request.uri().scheme().is_some() || request.uri().authority().is_some() {
        return failure(StatusCode::FORBIDDEN, "FORBIDDEN");
    }
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok());
    if request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        != Some(format!("127.0.0.1:{}", state.port).as_str())
    {
        return failure(StatusCode::FORBIDDEN, "FORBIDDEN");
    }
    if origin.is_some() && !allowed_origin(origin) {
        return failure(StatusCode::FORBIDDEN, "FORBIDDEN");
    }
    if !api_path(request.uri().path())
        || request.uri().query().is_some_and(|query| {
            Url::parse(&format!("http://localhost/?{query}"))
                .is_ok_and(|url| url.query_pairs().any(|(key, _)| key == "token"))
        })
    {
        return failure(StatusCode::FORBIDDEN, "FORBIDDEN");
    }
    if request.method() == Method::OPTIONS {
        if !allowed_origin(origin) {
            return failure(StatusCode::FORBIDDEN, "FORBIDDEN");
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        response.headers_mut().insert(
            "Access-Control-Allow-Headers",
            HeaderValue::from_static("Authorization, Content-Type"),
        );
        response.headers_mut().insert(
            "Access-Control-Allow-Methods",
            HeaderValue::from_static("GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS"),
        );
        return response;
    }
    if ![
        Method::GET,
        Method::HEAD,
        Method::POST,
        Method::PATCH,
        Method::PUT,
        Method::DELETE,
    ]
    .contains(request.method())
    {
        return failure(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED");
    }
    let websocket = request
        .headers()
        .get("upgrade")
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if websocket {
        let path = request.uri().path().to_owned();
        let parsed = Url::parse(&format!("http://localhost{}", request.uri()));
        let ticket = parsed.ok().and_then(|url| {
            let values = url
                .query_pairs()
                .filter(|(key, _)| key == "ticket")
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>();
            (values.len() == 1).then(|| values[0].clone())
        });
        let valid = ticket.is_some_and(|ticket| {
            state
                .tickets
                .lock()
                .is_ok_and(|mut tickets| tickets.consume(&ticket, &path))
        });
        if !socket_path(&path) || !valid || !allowed_origin(origin) {
            return failure(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
        }
        let uri = request.uri().to_string();
        let (mut parts, _) = request.into_parts();
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(value) => value,
            Err(error) => return error.into_response(),
        };
        // Connect before accepting the local socket. Auth/TLS failures remain visible as HTTP failures.
        let upstream = match upstream_socket(&state, &uri).await {
            Ok(value) => value,
            Err(code) => return failure(StatusCode::BAD_GATEWAY, &code),
        };
        return upgrade
            .max_message_size(MAX_BODY)
            .on_upgrade(move |socket| async move {
                let _permit = permit;
                bridge_socket(socket, upstream, state.timing).await;
            })
            .into_response();
    }
    let bearer = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !bearer.is_some_and(|value| token_matches(value, &state.bearer))
        || (origin.is_none() && !request.headers().contains_key("x-touri-client"))
    {
        return failure(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
    }
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let uri = request.uri().to_string();
    let headers = request.headers().clone();
    let body = match tokio::time::timeout(
        Duration::from_secs(30),
        to_bytes(request.into_body(), MAX_BODY),
    )
    .await
    {
        Ok(Ok(body)) => body,
        _ => return failure(StatusCode::PAYLOAD_TOO_LARGE, "INVALID_BODY"),
    };
    if path == "/api/v1/ws-ticket" {
        if method != Method::POST {
            return failure(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED");
        }
        let target = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|value| value.get("path").and_then(Value::as_str).map(str::to_owned));
        let Some(target) = target else {
            return failure(StatusCode::BAD_REQUEST, "INVALID_ARGS");
        };
        return match state
            .tickets
            .lock()
            .map_err(|_| "SERVER_STATE_UNAVAILABLE".to_owned())
            .and_then(|mut tickets| tickets.mint(&target))
        {
            Ok(ticket) => {
                (StatusCode::CREATED, axum::Json(json!({ "ticket": ticket }))).into_response()
            }
            Err(code) => failure(StatusCode::BAD_REQUEST, &code),
        };
    }
    let token = match state.token().await {
        Ok(value) => value,
        Err(code) => return failure(StatusCode::SERVICE_UNAVAILABLE, &code),
    };
    let Some(url) = state.url.as_ref() else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "SERVER_CONFIG_INVALID");
    };
    // Only these content headers cross the trust boundary; never forward ambient credentials or Origin.
    let upstream = state
        .client
        .request(method, format!("{url}{uri}"))
        .headers(upstream_headers(&headers))
        .bearer_auth(token)
        .header("X-Touri-Client", CLIENT_NAME)
        .body(body);
    let response = match upstream.send().await {
        Ok(value) => value,
        Err(_) => return failure(StatusCode::BAD_GATEWAY, "SERVER_CONNECTION_FAILED"),
    };
    if response.status().is_redirection() {
        return failure(StatusCode::BAD_GATEWAY, "SERVER_REDIRECT_REFUSED");
    }
    let status = response.status();
    let mut output = Response::builder().status(status);
    for name in [
        "content-type",
        "content-disposition",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "retry-after",
    ] {
        if let Some(value) = response.headers().get(name) {
            output = output.header(name, value);
        }
    }
    output
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| failure(StatusCode::BAD_GATEWAY, "SERVER_CONNECTION_FAILED"))
}

fn upstream_headers(headers: &HeaderMap) -> HeaderMap {
    let mut result = HeaderMap::new();
    for name in ["content-type", "accept", "range", "if-none-match"] {
        if let Some(value) = headers.get(name) {
            result.insert(name, value.clone());
        }
    }
    result
}

type UpstreamSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn upstream_socket(state: &RelayState, uri: &str) -> Result<UpstreamSocket, String> {
    ensure_crypto_provider();
    // Recheck after reconnect: the server may have upgraded while this desktop was offline.
    let token = state.validated_token(true).await?;
    let base = state.url.as_deref().ok_or("SERVER_CONFIG_INVALID")?;
    let mut url = Url::parse(&format!("{base}{uri}")).map_err(|_| "INVALID_ARGS")?;
    let response = state
        .client
        .post(format!("{base}/api/v1/ws-ticket"))
        .bearer_auth(&token)
        .header("X-Touri-Client", CLIENT_NAME)
        .json(&json!({ "path": url.path() }))
        .send()
        .await
        .map_err(|_| "SERVER_CONNECTION_FAILED")?;
    let payload = small_json(response).await?;
    let ticket = payload
        .get("ticket")
        .and_then(Value::as_str)
        .filter(|value| valid_token(value))
        .ok_or("SERVER_RESPONSE_INVALID")?;
    let preserved = url
        .query_pairs()
        .filter(|(key, _)| key != "ticket" && key != "token")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(preserved)
        .append_pair("ticket", ticket);
    url.set_scheme(if base.starts_with("https:") {
        "wss"
    } else {
        "ws"
    })
    .map_err(|_| "SERVER_URL_INVALID")?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "SERVER_CONNECTION_FAILED")?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "SERVER_RESPONSE_INVALID")?,
    );
    request
        .headers_mut()
        .insert("X-Touri-Client", HeaderValue::from_static(CLIENT_NAME));
    // The async client performs exactly one handshake; redirects are HTTP errors, never followed.
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(MAX_BODY);
    config.max_frame_size = Some(MAX_BODY);
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| "SERVER_CONNECTION_FAILED")?
    .map_err(|_| "SERVER_CONNECTION_FAILED")?;
    Ok(socket)
}

async fn bridge_socket(local: WebSocket, upstream: UpstreamSocket, timing: RelayTiming) {
    let (mut local_out, mut local_in) = local.split();
    let (mut remote_out, mut remote_in) = upstream.split();
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + timing.ping_interval,
        timing.ping_interval,
    );
    // Waking from sleep must issue one liveness check, rather than burst old heartbeats.
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_remote_frame = Instant::now();
    let mut timed_out = false;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(last_remote_frame + timing.idle_timeout)) => {
                timed_out = true;
                break;
            }
            _ = heartbeat.tick() => {
                if last_remote_frame.elapsed() >= timing.idle_timeout {
                    timed_out = true;
                    break;
                }
                if !matches!(tokio::time::timeout(timing.send_timeout, remote_out.send(UpstreamMessage::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break; }
            }
            next = local_in.next() => {
                let message = match next {
                    Some(Ok(Message::Text(text))) => UpstreamMessage::Text(text.to_string().into()),
                    Some(Ok(Message::Binary(bytes))) => UpstreamMessage::Binary(bytes),
                    Some(Ok(Message::Ping(bytes))) => UpstreamMessage::Ping(bytes),
                    Some(Ok(Message::Pong(bytes))) => UpstreamMessage::Pong(bytes),
                    _ => break,
                };
                if !matches!(tokio::time::timeout(timing.send_timeout, remote_out.send(message)).await, Ok(Ok(()))) { break; }
            }
            next = remote_in.next() => {
                let Some(Ok(message)) = next else { break; };
                last_remote_frame = Instant::now();
                let message = match message {
                    UpstreamMessage::Text(text) => Message::Text(text.to_string().into()),
                    UpstreamMessage::Binary(bytes) => Message::Binary(bytes),
                    UpstreamMessage::Ping(bytes) => Message::Ping(bytes),
                    UpstreamMessage::Pong(bytes) => Message::Pong(bytes),
                    UpstreamMessage::Close(frame) => {
                        let frame = frame.map(|frame| axum::extract::ws::CloseFrame { code: frame.code.into(), reason: frame.reason.to_string().into() });
                        let _ = tokio::time::timeout(timing.send_timeout, local_out.send(Message::Close(frame))).await;
                        break;
                    }
                    _ => break,
                };
                if !matches!(tokio::time::timeout(timing.send_timeout, local_out.send(message)).await, Ok(Ok(()))) { break; }
            }
        }
    }
    if timed_out {
        let _ = tokio::time::timeout(
            timing.send_timeout,
            local_out.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1001,
                reason: "Connection timed out".into(),
            }))),
        )
        .await;
    }
    // Notify the local UI first so a stalled upstream cannot delay its reconnect/offline state.
    let _ = tokio::time::timeout(timing.send_timeout, local_out.close()).await;
    let _ = tokio::time::timeout(timing.send_timeout, remote_out.close()).await;
}

#[tauri::command]
pub fn server_attention(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    state: tauri::State<'_, AppState>,
    title: String,
    body: String,
    deep_link: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    require_main(&caller)?;
    if state
        .server_mode
        .lock()
        .map_err(|_| "SERVER_STATE_UNAVAILABLE")?
        .mode
        != Mode::Server
    {
        return Err("SERVER_MODE_REQUIRED".into());
    }
    if title.len() > 512
        || body.len() > 4096
        || deep_link
            .as_ref()
            .is_some_and(|value| value.len() > 2048 || crate::deep_link::parse(value).is_none())
    {
        return Err("INVALID_ARGS".into());
    }
    if app.get_webview_window("main").is_some_and(|window| {
        window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false)
    }) {
        return Ok(());
    }
    let mut builder = app.notification().builder().title(title).body(body);
    if let Some(link) = deep_link {
        builder = builder.extra("deepLink", link);
    }
    builder
        .show()
        .map_err(|_| "SERVER_NOTIFICATION_FAILED".into())
}

#[tauri::command]
pub fn server_badge(
    app: AppHandle<Wry>,
    caller: tauri::Webview<Wry>,
    state: tauri::State<'_, AppState>,
    count: i64,
) -> Result<(), String> {
    require_main(&caller)?;
    if state
        .server_mode
        .lock()
        .map_err(|_| "SERVER_STATE_UNAVAILABLE")?
        .mode
        != Mode::Server
    {
        return Err("SERVER_MODE_REQUIRED".into());
    }
    if !(0..=9999).contains(&count) {
        return Err("INVALID_ARGS".into());
    }
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_badge_count((count > 0).then_some(count))
            .map_err(|_| "SERVER_BADGE_FAILED")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_http_and_websocket_tls_share_an_explicit_crypto_provider() {
        let _client =
            native_client().expect("native HTTP client must configure TLS without panicking");
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        let _plain_client = Client::builder().no_proxy().build().unwrap();
        let _websocket_tls = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
    }

    #[test]
    fn bundled_computer_viewers_can_read_mode_without_permission_to_mutate_it() {
        for label in ["main", "computer-bot-1", "computer-bot_id"] {
            assert!(may_read_mode(label), "{label}");
        }
        for label in [
            "computer-",
            "preview-1",
            "secret-card-1",
            "other",
            "computer-../main",
        ] {
            assert!(!may_read_mode(label), "{label}");
        }
    }

    #[test]
    fn server_startup_does_not_evaluate_sidecar_host_or_vm_initialization() {
        let server = ServerModeStatus {
            mode: Mode::Server,
            url: Some("https://server.test".into()),
        };
        assert_eq!(
            select_runtime(
                &server,
                || panic!("local sidecar/host/VM launch called"),
                || "relay"
            ),
            "relay"
        );
        assert_eq!(
            select_runtime(
                &ServerModeStatus::unavailable(),
                || panic!("local fallback called"),
                || "offline relay"
            ),
            "offline relay"
        );
        assert_eq!(
            select_runtime(
                &ServerModeStatus::default(),
                || "local",
                || panic!("unexpected server relay")
            ),
            "local"
        );
    }

    #[test]
    fn server_startup_never_selects_local_on_bad_config() {
        assert_eq!(
            parse_mode(br#"{"mode":"server","url":"https://server.test"}"#)
                .unwrap()
                .mode,
            Mode::Server
        );
        let invalid = [
            br#"{"mode":"server","url":"http://server.test"}"#.as_slice(),
            b"invalid",
            br#"{"mode":"local","url":"https://server.test"}"#,
        ];
        for bytes in invalid {
            let mode = parse_mode(bytes).unwrap_or_else(|_| ServerModeStatus::unavailable());
            assert_eq!(mode.mode, Mode::Server);
        }
    }

    #[test]
    fn https_origin_only_without_embedded_credentials_or_payload() {
        assert_eq!(
            normalize_server_url(" https://server.test:8443/ ").unwrap(),
            "https://server.test:8443"
        );
        for input in [
            "http://server.test",
            "https://user:secret@server.test",
            "https://server.test/?token=value",
            "https://server.test/#secret",
            "https://server.test/other",
            "file:///server",
        ] {
            assert!(normalize_server_url(input).is_err(), "{input}");
        }
    }

    #[test]
    fn plaintext_server_urls_are_limited_to_loopback() {
        for input in [
            "http://127.0.0.1:8443",
            "http://[::1]:8443",
            "http://localhost:8443",
        ] {
            assert!(normalize_server_url(input).is_ok());
        }
        for input in [
            "http://server.test",
            "http://localhost.server.test",
            "http://127.0.0.1.server.test",
            "http://0.0.0.0",
            "http://[::]",
        ] {
            assert!(normalize_server_url(input).is_err());
        }
    }

    #[test]
    fn upstream_headers_do_not_forward_ambient_credentials_origin_or_authority() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("origin", "tauri://localhost"),
            ("cookie", "fixture=secret"),
            ("authorization", "Bearer local-only"),
            ("host", "other.test"),
            ("x-touri-client", "untrusted"),
            ("x-forwarded-host", "other.test"),
            ("content-type", "application/json"),
            ("range", "bytes=0-99"),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        let forwarded = upstream_headers(&headers);
        assert_eq!(forwarded.len(), 2);
        assert_eq!(forwarded.get("content-type").unwrap(), "application/json");
        assert_eq!(forwarded.get("range").unwrap(), "bytes=0-99");
    }

    #[test]
    fn config_has_only_mode_and_url_and_rejects_a_token_field() {
        let config = ServerModeStatus {
            mode: Mode::Server,
            url: Some("https://server.test".into()),
        };
        assert_eq!(
            serde_json::to_value(config).unwrap(),
            json!({"mode":"server","url":"https://server.test"})
        );
        assert!(
            parse_mode(br#"{"mode":"server","url":"https://server.test","token":"secret"}"#)
                .is_err()
        );
    }

    #[test]
    fn relay_only_accepts_api_paths_and_strict_native_origins() {
        assert!(api_path("/api/v1/bots"));
        for path in [
            "/",
            "/pair",
            "//server.test/api/v1/bots",
            "/api/v1/../pair",
            "/api/v1/%2E%2e/pair",
            "/api/v1/part%2F..%2Fpair",
            "/api/v1/session/rotate",
        ] {
            assert!(!api_path(path), "{path}");
        }
        assert!(allowed_origin(Some("tauri://localhost")));
        assert!(!allowed_origin(Some("https://server.test")));
        assert!(!allowed_origin(Some("null")));
        assert!(!allowed_origin(None));
    }

    #[tokio::test]
    async fn live_relay_requires_local_auth_and_keeps_offline_mode_recoverable() {
        let (relay, endpoint) = start_relay(
            &ServerModeStatus::unavailable(),
            KeychainStore::new("ai.touri.desktop.relay-test"),
        )
        .unwrap();
        let client = Client::builder().no_proxy().build().unwrap();
        let health = format!("{}/api/v1/health", endpoint.base_url);
        let unauthorized = client
            .get(&health)
            .header("Origin", "tauri://localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let denied_origin = client
            .get(&health)
            .bearer_auth(&endpoint.token)
            .header("Origin", "https://untrusted.test")
            .send()
            .await
            .unwrap();
        assert_eq!(denied_origin.status(), StatusCode::FORBIDDEN);
        for path in [
            "/pair",
            "/",
            "/api/v1/session/rotate",
            "/api/v1/health?token=fixture",
        ] {
            let response = client
                .get(format!("{}{path}", endpoint.base_url))
                .bearer_auth(&endpoint.token)
                .header("Origin", "tauri://localhost")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
        let preflight = client
            .request(Method::OPTIONS, &health)
            .header("Origin", "tauri://localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "tauri://localhost"
        );
        let offline = client
            .get(&health)
            .bearer_auth(&endpoint.token)
            .header("Origin", "tauri://localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(offline.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            offline.json::<Value>().await.unwrap()["errorCode"],
            "SERVER_CONFIG_INVALID"
        );
        let ticket = client
            .post(format!("{}/api/v1/ws-ticket", endpoint.base_url))
            .bearer_auth(&endpoint.token)
            .header("Origin", "tauri://localhost")
            .json(&json!({"path":"/api/v1/events"}))
            .send()
            .await
            .unwrap();
        assert_eq!(ticket.status(), StatusCode::CREATED);
        let ticket = ticket.json::<Value>().await.unwrap()["ticket"]
            .as_str()
            .unwrap()
            .to_owned();
        let local_ws_url = format!("{}?ticket={ticket}", endpoint.ws_url);
        for expected in [StatusCode::BAD_GATEWAY, StatusCode::UNAUTHORIZED] {
            let response = client
                .get(local_ws_url.replacen("ws:", "http:", 1))
                .header("Origin", "tauri://localhost")
                .header("Connection", "Upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        drop(relay);
    }

    #[test]
    fn wire_protocol_compatibility_is_independent_of_release_and_database_schema() {
        assert!(is_protocol_compatible(
            &json!({"version":"99.0.0", "schemaVersion":999, "protocolVersion":1})
        ));
        assert!(is_protocol_compatible(&json!({"schemaVersion":46})));
        assert!(!is_protocol_compatible(&json!({"schemaVersion":47})));
        assert!(!is_protocol_compatible(
            &json!({"schemaVersion":46, "protocolVersion":2})
        ));
        assert!(!is_protocol_compatible(
            &json!({"schemaVersion":46, "protocolVersion":null})
        ));
    }

    #[derive(Default)]
    struct FakeServer {
        requests: Mutex<Vec<(String, HeaderMap)>>,
        tickets: Mutex<Tickets>,
        silent_socket: bool,
        schema_version: Mutex<Option<u32>>,
        protocol_version: Mutex<Option<u64>>,
        silent_shutdown: tokio::sync::Notify,
    }

    async fn fake_server_request(
        State(state): State<Arc<FakeServer>>,
        request: Request,
    ) -> Response {
        state
            .requests
            .lock()
            .unwrap()
            .push((request.uri().to_string(), request.headers().clone()));
        if request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some("Bearer device-token-fixture")
            || request
                .headers()
                .get("x-touri-client")
                .and_then(|value| value.to_str().ok())
                != Some(CLIENT_NAME)
            || request.headers().contains_key("origin")
            || request.headers().contains_key("cookie")
        {
            return failure(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
        }
        match request.uri().path() {
            "/api/v1/session" => axum::Json(json!({"ok":true,"kind":"device"})).into_response(),
            "/api/v1/health" => {
                let schema = state
                    .schema_version
                    .lock()
                    .unwrap()
                    .unwrap_or(SIDECAR_SCHEMA_VERSION);
                let protocol = *state.protocol_version.lock().unwrap();
                let health = match protocol {
                    Some(version) => {
                        json!({"ok":true,"schemaVersion":schema,"protocolVersion":version})
                    }
                    None => json!({"ok":true,"schemaVersion":schema}),
                };
                axum::Json(health).into_response()
            }
            "/api/v1/echo" => {
                let body = to_bytes(request.into_body(), SMALL_BODY).await.unwrap();
                let value: Value = serde_json::from_slice(&body).unwrap();
                let mut response = axum::Json(json!({"echo":value})).into_response();
                response.headers_mut().insert(
                    "set-cookie",
                    HeaderValue::from_static("touri_device=device-token-fixture; HttpOnly"),
                );
                response
                    .headers_mut()
                    .insert("retry-after", HeaderValue::from_static("3"));
                response
            }
            "/api/v1/ws-ticket" => {
                let body = to_bytes(request.into_body(), SMALL_BODY).await.unwrap();
                let value: Value = serde_json::from_slice(&body).unwrap();
                let ticket = state
                    .tickets
                    .lock()
                    .unwrap()
                    .mint(value["path"].as_str().unwrap())
                    .unwrap();
                (StatusCode::CREATED, axum::Json(json!({"ticket":ticket}))).into_response()
            }
            "/api/v1/events" => {
                let url = Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                let ticket = url
                    .query_pairs()
                    .find(|(key, _)| key == "ticket")
                    .unwrap()
                    .1
                    .into_owned();
                if !state
                    .tickets
                    .lock()
                    .unwrap()
                    .consume(&ticket, "/api/v1/events")
                {
                    return failure(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
                }
                let (mut parts, _) = request.into_parts();
                WebSocketUpgrade::from_request_parts(&mut parts, &())
                    .await
                    .unwrap()
                    .on_upgrade(move |mut socket| async move {
                        if state.silent_socket {
                            // Keep TCP open without polling the socket, so no control Pong is generated.
                            state.silent_shutdown.notified().await;
                            drop(socket);
                            return;
                        }
                        let _ = socket
                            .send(Message::Text("server-event-fixture".into()))
                            .await;
                        if let Some(Ok(Message::Text(text))) = socket.recv().await {
                            let _ = socket.send(Message::Text(text)).await;
                        }
                        let _ = socket
                            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                code: 4003,
                                reason: "Device revoked".into(),
                            })))
                            .await;
                    })
                    .into_response()
            }
            _ => failure(StatusCode::NOT_FOUND, "NOT_FOUND"),
        }
    }

    #[tokio::test]
    async fn native_relay_forwards_http_and_websocket_with_only_native_device_auth() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let fake = Arc::new(FakeServer {
            protocol_version: Mutex::new(Some(1)),
            ..FakeServer::default()
        });
        let router = Router::new()
            .fallback(fake_server_request)
            .with_state(Arc::clone(&fake));
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mode = ServerModeStatus {
            mode: Mode::Server,
            url: Some(url.clone()),
        };
        // This fixture seeds only native memory; production always loads through the existing vault.
        let (relay, endpoint) = start_relay_inner(
            &mode,
            KeychainStore::new("ai.touri.desktop.relay-test"),
            Some("device-token-fixture".into()),
            RelayTiming::default(),
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            check_connection(&native_client().unwrap(), &url, "device-token-fixture")
                .await
                .unwrap();
            let client = Client::builder().no_proxy().build().unwrap();
            let response = client
                .post(format!("{}/api/v1/echo", endpoint.base_url))
                .bearer_auth(&endpoint.token)
                .header("Origin", "tauri://localhost")
                .header("Cookie", "ambient=fixture")
                .header("X-Touri-Client", "untrusted-renderer")
                .header("X-Forwarded-Host", "untrusted.test")
                .json(&json!({"message":"hello"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().get("set-cookie").is_none());
            assert_eq!(response.headers().get("retry-after").unwrap(), "3");
            assert_eq!(
                response.json::<Value>().await.unwrap(),
                json!({"echo":{"message":"hello"}})
            );
            let payload = client
                .post(format!("{}/api/v1/ws-ticket", endpoint.base_url))
                .bearer_auth(&endpoint.token)
                .header("Origin", "tauri://localhost")
                .json(&json!({"path":"/api/v1/events"}))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            let local_ticket = payload["ticket"].as_str().unwrap();
            let mut request = format!("{}?ticket={local_ticket}&since=42", endpoint.ws_url)
                .into_client_request()
                .unwrap();
            request
                .headers_mut()
                .insert("Origin", HeaderValue::from_static("tauri://localhost"));
            request
                .headers_mut()
                .insert("Cookie", HeaderValue::from_static("ambient=fixture"));
            let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                UpstreamMessage::Text("server-event-fixture".into())
            );
            socket
                .send(UpstreamMessage::Text("client-message-fixture".into()))
                .await
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                UpstreamMessage::Text("client-message-fixture".into())
            );
            let UpstreamMessage::Close(Some(frame)) = socket.next().await.unwrap().unwrap() else {
                panic!("expected server revocation close")
            };
            assert_eq!(u16::from(frame.code), 4003);
            let requests = fake.requests.lock().unwrap();
            assert!(requests.iter().any(|(path, _)| path == "/api/v1/session"));
            assert!(requests.iter().any(|(path, _)| path == "/api/v1/echo"));
            assert!(requests.iter().any(|(path, _)| path == "/api/v1/ws-ticket"));
            let socket_path = &requests
                .iter()
                .find(|(path, _)| path.starts_with("/api/v1/events?"))
                .unwrap()
                .0;
            let socket_url = Url::parse(&format!("http://localhost{socket_path}")).unwrap();
            assert!(socket_url
                .query_pairs()
                .any(|(key, value)| key == "since" && value == "42"));
            assert!(!socket_url
                .query_pairs()
                .any(|(key, value)| key == "ticket" && value == local_ticket));
            for (_, headers) in requests.iter() {
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer device-token-fixture"
                );
                assert_eq!(headers.get("x-touri-client").unwrap(), CLIENT_NAME);
                for name in ["origin", "cookie", "x-forwarded-host"] {
                    assert!(!headers.contains_key(name));
                }
            }
        })
        .await
        .unwrap();
        drop(relay);
        upstream_task.abort();
    }

    #[tokio::test]
    async fn saved_device_token_requires_compatible_protocol_before_api_and_each_socket_reconnect()
    {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let mode = ServerModeStatus {
            mode: Mode::Server,
            url: Some(format!("http://{}", listener.local_addr().unwrap())),
        };
        let fake = Arc::new(FakeServer {
            schema_version: Mutex::new(Some(SIDECAR_SCHEMA_VERSION + 1)),
            ..FakeServer::default()
        });
        let router = Router::new()
            .fallback(fake_server_request)
            .with_state(Arc::clone(&fake));
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        // Substitute only the vault read: this token is unvalidated exactly like one loaded at startup.
        let (relay, endpoint) = start_relay_inner(
            &mode,
            KeychainStore::new("ai.touri.desktop.relay-test"),
            Some("device-token-fixture".into()),
            RelayTiming::default(),
        )
        .unwrap();
        let client = Client::builder().no_proxy().build().unwrap();
        for _ in 0..2 {
            let response = client
                .post(format!("{}/api/v1/echo", endpoint.base_url))
                .bearer_auth(&endpoint.token)
                .header("Origin", "tauri://localhost")
                .json(&json!({"message":"blocked"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                response.json::<Value>().await.unwrap()["errorCode"],
                "SERVER_VERSION_MISMATCH"
            );
        }
        assert!(!fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(path, _)| path == "/api/v1/echo"));
        *fake.protocol_version.lock().unwrap() = Some(1);
        let compatible = client
            .post(format!("{}/api/v1/echo", endpoint.base_url))
            .bearer_auth(&endpoint.token)
            .header("Origin", "tauri://localhost")
            .json(&json!({"message":"compatible"}))
            .send()
            .await
            .unwrap();
        assert_eq!(compatible.status(), StatusCode::OK);
        *fake.protocol_version.lock().unwrap() = Some(2);
        let payload = client
            .post(format!("{}/api/v1/ws-ticket", endpoint.base_url))
            .bearer_auth(&endpoint.token)
            .header("Origin", "tauri://localhost")
            .json(&json!({"path":"/api/v1/events"}))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let mut request = format!(
            "{}?ticket={}",
            endpoint.ws_url,
            payload["ticket"].as_str().unwrap()
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        let error = tokio_tungstenite::connect_async(request)
            .await
            .expect_err("socket reconnect must validate the current protocol");
        let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
            panic!("expected rejected socket handshake")
        };
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(!fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(path, _)| path.starts_with("/api/v1/events") || path == "/api/v1/ws-ticket"));
        drop(relay);
        upstream_task.abort();
    }

    #[tokio::test]
    async fn native_relay_closes_an_open_but_unresponsive_upstream_for_reconnect() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let fake = Arc::new(FakeServer {
            silent_socket: true,
            protocol_version: Mutex::new(Some(1)),
            ..FakeServer::default()
        });
        let mode = ServerModeStatus {
            mode: Mode::Server,
            url: Some(format!("http://{}", listener.local_addr().unwrap())),
        };
        let router = Router::new()
            .fallback(fake_server_request)
            .with_state(Arc::clone(&fake));
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (relay, endpoint) = start_relay_inner(
            &mode,
            KeychainStore::new("ai.touri.desktop.relay-test"),
            Some("device-token-fixture".into()),
            RelayTiming {
                ping_interval: Duration::from_millis(20),
                idle_timeout: Duration::from_millis(65),
                send_timeout: Duration::from_millis(100),
            },
        )
        .unwrap();
        let client = Client::builder().no_proxy().build().unwrap();
        let payload = client
            .post(format!("{}/api/v1/ws-ticket", endpoint.base_url))
            .bearer_auth(&endpoint.token)
            .header("Origin", "tauri://localhost")
            .json(&json!({"path":"/api/v1/events"}))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let mut request = format!(
            "{}?ticket={}",
            endpoint.ws_url,
            payload["ticket"].as_str().unwrap()
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_static("tauri://localhost"));
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(2), socket.next()).await;
        fake.silent_shutdown.notify_waiters();
        drop(relay);
        upstream_task.abort();
        let UpstreamMessage::Close(Some(frame)) = closed
            .expect("silent upstream must close the local relay socket")
            .unwrap()
            .unwrap()
        else {
            panic!("expected liveness timeout close")
        };
        assert_eq!(u16::from(frame.code), 1001);
        assert_eq!(frame.reason, "Connection timed out");
    }

    #[test]
    fn websocket_tickets_are_short_lived_single_use_and_path_bound() {
        let mut tickets = Tickets::default();
        let ticket = tickets.mint("/api/v1/events").unwrap();
        assert!(tickets.consume(&ticket, "/api/v1/events"));
        assert!(!tickets.consume(&ticket, "/api/v1/events"));
        let ticket = tickets.mint("/api/v1/events").unwrap();
        assert!(!tickets.consume(&ticket, "/api/v1/desktop/invalid/socket"));
        assert!(!tickets.consume(&ticket, "/api/v1/events"));
        let ticket = tickets.mint("/api/v1/events").unwrap();
        tickets.0.get_mut(&ticket).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(!tickets.consume(&ticket, "/api/v1/events"));
        assert!(tickets.mint("/pair").is_err());
        assert!(!token_matches("a", "aa"));
        assert!(!token_matches("fixture", "fixturE"));
        assert!(token_matches("fixture", "fixture"));
    }
}
