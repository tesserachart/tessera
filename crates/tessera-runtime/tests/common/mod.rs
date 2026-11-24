#![allow(dead_code)]

pub mod keychain;

use std::collections::VecDeque;
use std::fmt::Debug;
use std::time::Duration;

use futures::future::LocalBoxFuture;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::settle::settle_async;
use tessera_protocol::tools::ToolErrorCode;
use tessera_runtime::RuntimeHandle;
use tessera_tools::{InvokeRequest, Invoker};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub const T: Duration = Duration::from_secs(60);

pub async fn call(inv: &Invoker, origin: &Origin, name: &str, input: Value) -> Value {
    let r = inv
        .invoke(InvokeRequest::new(name, input.clone(), origin.clone()))
        .await;
    assert!(r.ok, "{name} {input}: {r:?}");
    r.output.unwrap()
}

pub async fn call_user(inv: &Invoker, name: &str, input: Value) -> Value {
    call(inv, &Origin::User, name, input).await
}

pub async fn try_call(
    inv: &Invoker,
    origin: &Origin,
    name: &str,
    input: Value,
) -> Result<Value, Value> {
    let r = inv
        .invoke(InvokeRequest::new(name, input, origin.clone()))
        .await;
    if r.ok {
        Ok(r.output.unwrap())
    } else {
        Err(serde_json::to_value(r.error).unwrap())
    }
}

pub async fn try_call_code(
    inv: &Invoker,
    origin: &Origin,
    name: &str,
    input: Value,
) -> Result<Value, ToolErrorCode> {
    let r = inv
        .invoke(InvokeRequest::new(name, input, origin.clone()))
        .await;
    match (r.output, r.error) {
        (Some(out), None) => Ok(out),
        (_, Some(e)) => Err(e.code),
        other => panic!("{name}: {other:?}"),
    }
}

pub async fn connect(h: &RuntimeHandle) -> Ws {
    let mut req = format!("ws://127.0.0.1:{}/ws", h.port)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", h.token).parse().unwrap(),
    );
    tokio_tungstenite::connect_async(req).await.unwrap().0
}

pub async fn connect_page(port: u16, origin: &str) -> Ws {
    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert("Origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(req).await.unwrap().0
}

pub async fn first(ws: &mut Ws, text: &str) -> Value {
    ws.send(Message::text(text.to_owned())).await.unwrap();
    loop {
        let msg = tokio::time::timeout(T, ws.next())
            .await
            .expect("timed out waiting for the answer")
            .expect("closed before answering")
            .unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

pub async fn first_hello(ws: &mut Ws, params: Value) -> Value {
    let req = json!({"jsonrpc": "2.0", "id": 1, "method": "session.hello", "params": params});
    first(ws, &req.to_string()).await
}

pub async fn closed(ws: &mut Ws) -> bool {
    loop {
        match tokio::time::timeout(T, ws.next()).await {
            Err(_) => return false,
            Ok(None | Some(Err(_)) | Some(Ok(Message::Close(_)))) => return true,
            Ok(Some(Ok(_))) => {}
        }
    }
}

pub struct Client {
    pub ws: Ws,
    pub next: i64,
    pub events: VecDeque<Value>,
}

impl Client {
    pub async fn new(h: &RuntimeHandle) -> Self {
        Self {
            ws: connect(h).await,
            next: 1,
            events: VecDeque::new(),
        }
    }

    pub async fn recv(&mut self) -> Value {
        loop {
            let msg = tokio::time::timeout(T, self.ws.next())
                .await
                .expect("timed out waiting for a message")
                .expect("socket closed")
                .unwrap();
            if let Message::Text(t) = msg {
                return serde_json::from_str(&t).unwrap();
            }
        }
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.ws.send(Message::text(req.to_string())).await.unwrap();
        loop {
            let v = self.recv().await;
            if v.get("method") == Some(&json!("event")) {
                self.events.push_back(v);
                continue;
            }
            if v["id"] == json!(id) {
                return v;
            }
        }
    }

    pub async fn ok(&mut self, method: &str, params: Value) -> Value {
        let r = self.call(method, params).await;
        assert!(r.get("error").is_none(), "{method} failed: {r}");
        r["result"].clone()
    }

    pub async fn settle<T: Debug + PartialEq>(
        &mut self,
        what: &str,
        look: impl for<'c> Fn(&'c mut Client) -> LocalBoxFuture<'c, T>,
        done: impl Fn(&T) -> bool,
    ) -> T {
        let me = tokio::sync::Mutex::new(self);
        let (me, look) = (&me, &look);
        settle_async(
            what,
            move || async move { look(&mut **me.lock().await).await },
            done,
        )
        .await
    }

    pub async fn event(&mut self, sub: &str, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(pos) = self
            .events
            .iter()
            .position(|e| e["params"]["subscriptionId"] == sub && pred(&e["params"]))
        {
            return self.events.remove(pos).unwrap()["params"].clone();
        }
        loop {
            let v = self.recv().await;
            if v.get("method") == Some(&json!("event")) {
                if v["params"]["subscriptionId"] == sub && pred(&v["params"]) {
                    return v["params"].clone();
                }
                self.events.push_back(v);
            }
        }
    }
}

pub async fn http(port: u16, req: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    (status, text)
}
