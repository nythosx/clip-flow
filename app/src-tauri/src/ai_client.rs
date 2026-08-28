// Plays the same role `cli/lib/server.js` + `cli/index.js` play in the AI Engine repo
// (../cli, ../native-host, ../extension, ../shared/protocol.js): starts a local WebSocket
// server, writes the well-known port file the native-host already polls, and speaks the
// `AI_MESSAGE_TYPES` protocol (shared/protocol.js) request/response shape — one JSON
// message out per call, matched back to its response by `requestId`. The native-host and
// extension are unmodified; only the caller changed, per README.md's "Suggested next
// steps" item 1.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

const PREFERRED_PORT: u16 = 9876;
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(20 * 60); // real AI calls are slow (typing pacing, rate-limit gate, model response, occasional migration)

fn well_known_dir() -> PathBuf {
    // Must match cli/lib/server.js's WELL_KNOWN_DIR and native-host/host.js's PORT_FILE —
    // this is the discovery handshake the always-on native host polls.
    dirs_home().join(".clipflow")
}

fn dirs_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .expect("no home directory found (USERPROFILE/HOME unset)")
}

fn port_file() -> PathBuf {
    well_known_dir().join("current_port")
}

pub struct AiClient {
    outgoing: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl AiClient {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            outgoing: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Binds the WS server, writes the port file, and spawns the accept loop in the
    /// background. Returns once listening (not once a client has connected — the
    /// native-host connects whenever it next polls the port file).
    pub async fn start(self: &Arc<Self>) -> std::io::Result<()> {
        let listener = match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?, // fall back to an OS-assigned free port
        };
        let port = listener.local_addr()?.port();

        let dir = well_known_dir();
        std::fs::create_dir_all(&dir)?;
        std::fs::write(port_file(), port.to_string())?;
        log::info!("[ai_client] listening on 127.0.0.1:{port}, wrote {}", port_file().display());

        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let this = Arc::clone(&this);
                        tokio::spawn(this.handle_connection(stream));
                    }
                    Err(e) => log::error!("[ai_client] accept error: {e}"),
                }
            }
        });

        Ok(())
    }

    async fn handle_connection(self: Arc<Self>, stream: TcpStream) {
        let ws = match tokio_tungstenite::accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => {
                log::error!("[ai_client] websocket handshake failed: {e}");
                return;
            }
        };
        log::info!("[ai_client] native-host connected");
        let (mut write, mut read) = ws.split();

        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        *self.outgoing.lock().await = Some(tx);

        // Drain queued outgoing messages onto the socket.
        let send_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(msg).await.is_err() {
                    break;
                }
            }
        });

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => self.handle_incoming(&text).await,
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(e) => {
                    log::warn!("[ai_client] websocket read error: {e}");
                    break;
                }
            }
        }

        log::warn!("[ai_client] native-host disconnected");
        *self.outgoing.lock().await = None;
        send_task.abort();
    }

    async fn handle_incoming(&self, text: &str) {
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[ai_client] malformed message from native-host: {e}");
                return;
            }
        };
        let Some(request_id) = value.get("requestId").and_then(|v| v.as_str()) else {
            log::warn!("[ai_client] message with no requestId: {value}");
            return;
        };
        let mut pending = self.pending.lock().await;
        let Some(sender) = pending.remove(request_id) else {
            return; // no one waiting (already timed out, or a stray/duplicate message)
        };
        drop(pending);

        let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type == "ai_error" {
            let error = value.get("error").and_then(|v| v.as_str()).unwrap_or("unknown AI error").to_string();
            let _ = sender.send(Err(error));
        } else {
            let _ = sender.send(Ok(value));
        }
    }

    /// Sends one AI_MESSAGE_TYPES request and resolves with the matching response (by
    /// `requestId`) or times out. `payload` should already have `type` set (and whichever
    /// function-specific fields — `transcript`, `duration`, `count`, `excerpt`, `hook`,
    /// `sessionKey`); `requestId` is generated here if not already present.
    pub async fn call_ai(&self, mut payload: Value, timeout: Duration) -> Result<Value, String> {
        let request_id = payload
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        payload["requestId"] = json!(request_id);

        let outgoing = self
            .outgoing
            .lock()
            .await
            .clone()
            .ok_or_else(|| "AI Engine not connected (extension/native-host not reachable yet)".to_string())?;

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);

        let text = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        if outgoing.send(Message::Text(text)).is_err() {
            self.pending.lock().await.remove(&request_id);
            return Err("AI Engine connection closed while sending request".to_string());
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("AI Engine dropped the request".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err(format!("AI Engine call timed out after {}s", timeout.as_secs()))
            }
        }
    }

    pub async fn call_ai_default_timeout(&self, payload: Value) -> Result<Value, String> {
        self.call_ai(payload, DEFAULT_CALL_TIMEOUT).await
    }

    /// Unblocks a pending `call_ai`/`call_ai_default_timeout` for `request_id` immediately,
    /// resolving it with an error instead of waiting out the full timeout. The AI Engine
    /// itself (the live browser tab) isn't told to stop — there's no cancel message in the
    /// protocol for a call already in flight — this only stops the Rust side from waiting
    /// on it, which is what actually unsticks a caller like `analyze_clips`/`analyze_movie`.
    pub async fn cancel_request(&self, request_id: &str) -> bool {
        let mut pending = self.pending.lock().await;
        if let Some(sender) = pending.remove(request_id) {
            let _ = sender.send(Err("Cancelled by user".to_string()));
            true
        } else {
            false
        }
    }
}
