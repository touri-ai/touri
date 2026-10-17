use crate::platform::transport::{self, Listener as UnixListener, Stream as UnixStream};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::computer;
use crate::file_grants::FileGrants;
use crate::keychain::KeychainStore;

pub const AUTH_REQUIRED_CODE: i32 = -32001;
pub const INVALID_REQUEST_CODE: i32 = -32600;
pub const METHOD_NOT_FOUND_CODE: i32 = -32601;
pub const INTERNAL_ERROR_CODE: i32 = -32603;

#[derive(Debug, Clone)]
pub struct SecretPromptRequest {
    pub request_id: String,
    pub title: String,
    pub origin: String,
    pub field_kinds: Vec<String>,
}

pub type SecretPrompt = dyn Fn(SecretPromptRequest) -> Result<Option<HashMap<String, String>>, String>
    + Send
    + Sync
    + 'static;
pub type Notify = dyn Fn(String, String, Option<String>, NotifyOptions) -> Result<(), String>
    + Send
    + Sync
    + 'static;

#[derive(Clone, Debug, Default)]
pub struct NotifyOptions {
    pub only_when_unfocused: bool,
    pub deep_link: Option<String>,
}

#[derive(Clone)]
pub struct HostBridgeCallbacks {
    pub file_grants: Arc<FileGrants>,
    pub secret_prompt: Arc<SecretPrompt>,
    pub notify: Arc<Notify>,
}

pub struct HostBridge {
    socket_path: PathBuf,
    stop: Arc<AtomicBool>,
    sender: Arc<Mutex<Option<Arc<Mutex<UnixStream>>>>>,
    join: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct HostBridgeSender {
    sender: Arc<Mutex<Option<Arc<Mutex<UnixStream>>>>>,
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<u64>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

impl HostBridge {
    pub fn start(
        socket_path: PathBuf,
        token: String,
        keychain: KeychainStore,
        callbacks: HostBridgeCallbacks,
    ) -> Result<Self, String> {
        let (listener, socket_path) = transport::listen(&socket_path)?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("configure host socket failed: {error}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let sender = Arc::new(Mutex::new(None));
        let thread_stop = Arc::clone(&stop);
        let thread_sender = Arc::clone(&sender);
        let join = thread::spawn(move || {
            accept_loop(
                listener,
                token,
                keychain,
                callbacks,
                thread_stop,
                thread_sender,
            )
        });
        Ok(Self {
            socket_path,
            stop,
            sender,
            join: Some(join),
        })
    }

    pub fn endpoint(&self) -> PathBuf {
        self.socket_path.clone()
    }

    pub fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        HostBridgeSender {
            sender: Arc::clone(&self.sender),
        }
        .send_notification(method, params)
    }

    pub fn clone_for_tray(&self) -> HostBridgeSender {
        HostBridgeSender {
            sender: Arc::clone(&self.sender),
        }
    }
}

impl HostBridgeSender {
    pub fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let connection = loop {
            if let Some(connection) = self
                .sender
                .lock()
                .map_err(|_| "host bridge sender lock poisoned".to_string())?
                .clone()
            {
                break connection;
            }
            if std::time::Instant::now() >= deadline {
                return Err("sidecar host connection is not ready".to_string());
            }
            thread::sleep(Duration::from_millis(10));
        };
        let payload = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut stream = connection
            .lock()
            .map_err(|_| "host bridge connection lock poisoned".to_string())?;
        stream
            .write_all(format!("{}\n", payload).as_bytes())
            .map_err(|error| format!("send host notification failed: {error}"))
    }
}

impl HostBridge {
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        transport::wake(&self.socket_path);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        if self.socket_path.exists() {
            transport::cleanup(&self.socket_path);
        }
    }
}

impl Drop for HostBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn accept_loop(
    listener: UnixListener,
    token: String,
    keychain: KeychainStore,
    callbacks: HostBridgeCallbacks,
    stop: Arc<AtomicBool>,
    sender: Arc<Mutex<Option<Arc<Mutex<UnixStream>>>>>,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                let Ok(writer_stream) = stream.try_clone() else {
                    continue;
                };
                let connection = Arc::new(Mutex::new(writer_stream));
                let connection_sender = Arc::clone(&sender);
                let connection_token = token.clone();
                let connection_keychain = keychain.clone();
                let connection_callbacks = callbacks.clone();
                thread::spawn(move || {
                    handle_connection(
                        stream,
                        connection,
                        connection_token,
                        connection_keychain,
                        connection_callbacks,
                        connection_sender,
                    )
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn handle_connection(
    stream: UnixStream,
    writer: Arc<Mutex<UnixStream>>,
    token: String,
    keychain: KeychainStore,
    callbacks: HostBridgeCallbacks,
    sender: Arc<Mutex<Option<Arc<Mutex<UnixStream>>>>>,
) {
    let mut authenticated = false;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let authenticated_before_request = authenticated;
                let response = match serde_json::from_str::<RpcRequest>(line.trim()) {
                    Ok(request) if authenticated && request.method != "auth" => {
                        let request_writer = Arc::clone(&writer);
                        let request_keychain = keychain.clone();
                        let request_callbacks = callbacks.clone();
                        // Prompts and Security framework calls can block. Keep reading this
                        // connection and correlate concurrent responses by their request IDs.
                        thread::spawn(move || {
                            if let Some(response) = dispatch_authenticated_request(
                                request,
                                &request_keychain,
                                &request_callbacks,
                            ) {
                                let _ = write_response(&request_writer, response);
                            }
                        });
                        None
                    }
                    Ok(request) => {
                        dispatch_request(request, &token, &mut authenticated, &keychain, &callbacks)
                    }
                    Err(_) => Some(error_response(
                        None,
                        INVALID_REQUEST_CODE,
                        "invalid host bridge request",
                    )),
                };
                if !authenticated_before_request && authenticated {
                    if let Ok(mut current) = sender.lock() {
                        *current = Some(Arc::clone(&writer));
                    }
                }
                if let Some(response) = response {
                    if write_response(&writer, response).is_err() {
                        break;
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
    }
}

fn dispatch_request(
    request: RpcRequest,
    token: &str,
    authenticated: &mut bool,
    keychain: &KeychainStore,
    callbacks: &HostBridgeCallbacks,
) -> Option<RpcResponse> {
    if request.method == "auth" {
        let supplied = request.params.get("token").and_then(Value::as_str);
        if supplied == Some(token) {
            *authenticated = true;
            return Some(success_response(request.id, json!({ "ok": true })));
        }
        return Some(error_response(
            request.id,
            AUTH_REQUIRED_CODE,
            "host bridge authentication failed",
        ));
    }
    if !*authenticated {
        return Some(error_response(
            request.id,
            AUTH_REQUIRED_CODE,
            "host bridge authentication required",
        ));
    }
    dispatch_authenticated_request(request, keychain, callbacks)
}

fn dispatch_authenticated_request(
    request: RpcRequest,
    keychain: &KeychainStore,
    callbacks: &HostBridgeCallbacks,
) -> Option<RpcResponse> {
    let result = match request.method.as_str() {
        "keychain.get" => request
            .params
            .get("account")
            .and_then(Value::as_str)
            .ok_or_else(|| "account is required".to_string())
            .and_then(|account| {
                keychain
                    .get(account)
                    .map(|value| json!({ "value": value }))
                    .map_err(|error| error.to_string())
            }),
        "keychain.set" => {
            let account = request.params.get("account").and_then(Value::as_str);
            let value = request.params.get("value").and_then(Value::as_str);
            match (account, value) {
                (Some(account), Some(value)) => keychain
                    .set(account, value)
                    .map(|_| json!({}))
                    .map_err(|error| error.to_string()),
                _ => Err("account and value are required".to_string()),
            }
        }
        "keychain.delete" => request
            .params
            .get("account")
            .and_then(Value::as_str)
            .ok_or_else(|| "account is required".to_string())
            .and_then(|account| {
                keychain
                    .delete(account)
                    .map(|_| json!({}))
                    .map_err(|error| error.to_string())
            }),
        "secret.prompt" => prompt_secret(&request.params, callbacks.secret_prompt.as_ref()),
        "notify" => notify_user(&request.params, callbacks.notify.as_ref()),
        "file.grant.redeem" => redeem_file_grant(&request.params, &callbacks.file_grants),
        "permissions.status" => {
            serde_json::to_value(computer::status()).map_err(|error| error.to_string())
        }
        "permissions.request" => Err("permission onboarding is provided by WP7".to_string()),
        method if method.starts_with("computer.") => {
            computer::dispatch(method, request.params.clone())
                .map_err(|error| format!("computer host call unavailable: {error:?}"))
        }
        _ => {
            return Some(error_response(
                request.id,
                METHOD_NOT_FOUND_CODE,
                "host bridge method not found",
            ))
        }
    };
    Some(match result {
        Ok(value) => success_response(request.id, value),
        Err(error) => error_response(request.id, INTERNAL_ERROR_CODE, &error),
    })
}

fn redeem_file_grant(params: &Value, grants: &FileGrants) -> Result<Value, String> {
    let id = params
        .get("grantId")
        .and_then(Value::as_str)
        .ok_or_else(|| "grantId is required".to_string())?;
    grants
        .redeem(id)
        .map(|file| {
            json!({
                "path": file.path,
                "dev": file.dev.to_string(),
                "ino": file.ino.to_string(),
                "size": file.size,
            })
        })
        .map_err(|error| error.message().to_string())
}

fn prompt_secret(params: &Value, prompt: &SecretPrompt) -> Result<Value, String> {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "requestId is required".to_string())?;
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| "title is required".to_string())?;
    let origin = params
        .get("origin")
        .and_then(Value::as_str)
        .ok_or_else(|| "origin is required".to_string())?;
    let field_kinds = params
        .get("fieldKinds")
        .and_then(Value::as_array)
        .ok_or_else(|| "fieldKinds is required".to_string())?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    prompt(SecretPromptRequest {
        request_id: request_id.to_string(),
        title: title.to_string(),
        origin: origin.to_string(),
        field_kinds,
    })
    .map(|values| json!({ "values": values }))
}

fn notify_user(params: &Value, notify: &Notify) -> Result<Value, String> {
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| "title is required".to_string())?;
    let body = params
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| "body is required".to_string())?;
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let options = NotifyOptions {
        only_when_unfocused: params
            .get("onlyWhenUnfocused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        deep_link: params
            .get("deepLink")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    notify(title.to_string(), body.to_string(), thread_id, options)?;
    Ok(json!({}))
}

fn success_response(id: Option<u64>, result: Value) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(result),
        error: None,
    }
}

fn error_response(id: Option<u64>, code: i32, message: &str) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_string(),
        }),
    }
}

fn write_response(writer: &Arc<Mutex<UnixStream>>, response: RpcResponse) -> Result<(), String> {
    let mut stream = writer
        .lock()
        .map_err(|_| "host bridge writer lock poisoned".to_string())?;
    stream
        .write_all(
            format!(
                "{}\n",
                serde_json::to_string(&response).map_err(|error| error.to_string())?
            )
            .as_bytes(),
        )
        .map_err(|error| error.to_string())
}

pub fn host_notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

#[cfg(test)]
mod tests {
    use super::{HostBridge, HostBridgeCallbacks, AUTH_REQUIRED_CODE};
    use crate::keychain::KeychainStore;
    use crate::platform::transport;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn host_bridge_rejects_calls_before_auth() {
        let root = std::env::temp_dir().join(format!("touri-wp1-host-{}", std::process::id()));
        let socket = root.join("run").join("host.sock");
        let callbacks = HostBridgeCallbacks {
            file_grants: Arc::new(crate::file_grants::FileGrants::new()),
            secret_prompt: Arc::new(|_| Ok(None)),
            notify: Arc::new(|_, _, _, _| Ok(())),
        };
        let mut bridge = HostBridge::start(
            socket.clone(),
            "test-host-token".to_string(),
            KeychainStore::new("ai.touri.desktop.secret.wp1-bridge-test"),
            callbacks,
        )
        .expect("start host bridge");
        let mut connection = transport::connect(&bridge.endpoint()).expect("connect host bridge");
        connection
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set test timeout");
        connection
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"keychain.get\",\"params\":{\"account\":\"global/test\"}}\n")
            .expect("write unauthenticated request");
        let mut line = String::new();
        BufReader::new(connection)
            .read_line(&mut line)
            .expect("read rejection");
        let response: serde_json::Value = serde_json::from_str(&line).expect("valid JSON response");
        assert_eq!(response["error"]["code"], AUTH_REQUIRED_CODE);
        bridge.shutdown();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn keychain_read_bypasses_a_pending_prompt_on_the_same_connection() {
        let (entered, prompt_entered) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let released = Mutex::new(released);
        let callbacks = HostBridgeCallbacks {
            file_grants: Arc::new(crate::file_grants::FileGrants::new()),
            secret_prompt: Arc::new(move |_| {
                entered.send(()).expect("signal pending prompt");
                released
                    .lock()
                    .expect("prompt release lock")
                    .recv_timeout(Duration::from_secs(30))
                    .expect("release prompt");
                Ok(None)
            }),
            notify: Arc::new(|_, _, _, _| Ok(())),
        };
        let (host, mut connection) = transport::stream_pair().expect("create host connection");
        host.set_read_timeout(Some(Duration::from_millis(20)))
            .expect("set host read timeout");
        let writer = Arc::new(Mutex::new(host.try_clone().expect("clone host writer")));
        let handler = std::thread::spawn(move || {
            super::handle_connection(
                host,
                writer,
                "test-host-token".to_string(),
                KeychainStore::new("ai.touri.desktop.secret.pipeline-test"),
                callbacks,
                Arc::new(Mutex::new(None)),
            )
        });
        connection
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("set test timeout");
        // Authentication must take effect before any pipelined call is dispatched.
        connection
            .write_all(concat!(
                "{\"id\":0,\"method\":\"keychain.get\",\"params\":{\"account\":\"missing\"}}\n",
                "{\"id\":1,\"method\":\"auth\",\"params\":{\"token\":\"test-host-token\"}}\n",
                "{\"id\":2,\"method\":\"secret.prompt\",\"params\":{\"requestId\":\"pending\",\"title\":\"Test\",\"origin\":\"https://example.test\",\"fieldKinds\":[\"password\"]}}\n"
            ).as_bytes())
            .expect("write pipelined calls");
        let mut reader = BufReader::new(connection);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("read unauthenticated rejection");
        let rejection: serde_json::Value = serde_json::from_str(&line).expect("valid rejection");
        assert_eq!(rejection["id"], 0);
        assert_eq!(rejection["error"]["code"], AUTH_REQUIRED_CODE);
        line.clear();
        reader.read_line(&mut line).expect("read authentication");
        let auth: serde_json::Value = serde_json::from_str(&line).expect("valid auth response");
        assert_eq!(auth["id"], 1);
        assert_eq!(auth["result"]["ok"], true);
        prompt_entered
            .recv_timeout(Duration::from_secs(10))
            .expect("prompt is pending");
        // The connection must keep accepting requests after an idle read timeout.
        std::thread::sleep(Duration::from_millis(100));
        reader
            .get_mut()
            .write_all(
                b"{\"id\":3,\"method\":\"keychain.get\",\"params\":{\"account\":\"missing\"}}\n",
            )
            .expect("request keychain while prompt is pending");
        line.clear();
        let keychain_read = reader.read_line(&mut line);
        // Always release the callback, including when serialization makes the read time out.
        release.send(()).expect("release pending prompt");
        keychain_read.expect("keychain must answer while the prompt is pending");
        let response: serde_json::Value =
            serde_json::from_str(&line).expect("valid keychain response");
        assert_eq!(response["id"], 3);
        // Progress must not depend on whether this test process can access the macOS keychain.
        if response.get("error").is_some() {
            assert_eq!(response["error"]["code"], super::INTERNAL_ERROR_CODE);
        } else {
            assert_eq!(response["result"], serde_json::json!({ "value": null }));
        }
        line.clear();
        reader.read_line(&mut line).expect("read released prompt");
        let prompt: serde_json::Value = serde_json::from_str(&line).expect("valid prompt response");
        assert_eq!(prompt["id"], 2);
        assert_eq!(prompt["result"], serde_json::json!({ "values": null }));
        drop(reader);
        handler.join().expect("host reader exits");
    }
}
