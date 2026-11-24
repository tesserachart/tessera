use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::token::Secret;
use tessera_host::{BusEvent, Keepalive, KeyFilter, Resync};
use tessera_protocol::methods::{
    ApprovalsResolveParams, HelloParams, HelloResult, PROTOCOL_VERSION, PulseParams,
    SubscribeParams, SubscribeResult, ToolsInvokeParams, ToolsListParams, UnsubscribeParams,
    UnsubscribeResult, names as methods,
};
use tessera_protocol::rpc::{JSONRPC_VERSION, RequestId, RpcError, RpcRequest, RpcResponse, codes};
use tessera_tools::approvals::ApprovalError;
use tessera_tools::{Audience, InvokeRequest, ResolveError, SurfaceState};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::state::SharedState;

const OUTBOUND: usize = 1024;

const HELLO_DEADLINE: Duration = Duration::from_secs(10);

const PULSE_EVERY: Duration = Duration::from_secs(1);

const PULSES_WAITING: usize = 900;

struct Subscription {
    task: JoinHandle<()>,
    _keepalive: Vec<Keepalive>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type Starter = oneshot::Sender<()>;

type Answer = (Option<String>, Vec<Starter>);

struct Connection {
    id: String,
    state: SharedState,
    out: mpsc::Sender<String>,
    subs: Mutex<HashMap<String, Subscription>>,
    closing: AtomicBool,
    next_sub: AtomicU64,
    ticket: Mutex<Option<Secret>>,
    opened: tokio::time::Instant,
    pulse: Mutex<Option<JoinHandle<()>>>,
}

fn rpc_err(code: i32, msg: impl Into<String>) -> RpcError {
    RpcError::new(code, msg)
}

fn params<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    let v = if v.is_null() { json!({}) } else { v };
    serde_json::from_value(v)
        .map_err(|e| rpc_err(codes::INVALID_PARAMS, format!("invalid params: {e}")))
}

fn to_value<T: Serialize>(v: &T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| rpc_err(codes::INTERNAL_ERROR, e.to_string()))
}

fn pulse_notification(pulse: &PulseParams) -> String {
    json!({"jsonrpc": JSONRPC_VERSION, "method": methods::SESSION_PULSE, "params": pulse})
        .to_string()
}

fn pulse_ms(opened: tokio::time::Instant, at: tokio::time::Instant) -> u64 {
    u64::try_from(at.duration_since(opened).as_millis()).unwrap_or(u64::MAX)
}

async fn pulse(
    out: mpsc::Sender<String>,
    opened: tokio::time::Instant,
    origin: tokio::time::Instant,
    every: Duration,
) {
    let every_ms = u64::try_from(every.as_millis()).unwrap_or(u64::MAX);
    let mut beat = tokio::time::interval_at(origin + every, every);
    beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut waiting =
        futures::stream::FuturesUnordered::<futures::future::BoxFuture<'static, bool>>::new();
    loop {
        tokio::select! {
            biased;
            Some(sent) = waiting.next(), if !waiting.is_empty() => {
                if !sent {
                    return;
                }
            }
            _ = beat.tick() => {
                if waiting.len() >= PULSES_WAITING {
                    continue;
                }
                let ms = pulse_ms(opened, tokio::time::Instant::now());
                let frame = pulse_notification(&PulseParams { ms, every_ms });
                let out = out.clone();
                waiting.push(Box::pin(async move { out.send(frame).await.is_ok() }));
            }
        }
    }
}

fn notification(topic: &str, seq: u64, sub: &str, data: &RawValue) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","method":"event","params":{{"topic":{},"seq":{seq},"subscriptionId":{},"data":{}}}}}"#,
        Value::String(topic.to_owned()),
        Value::String(sub.to_owned()),
        data.get()
    )
}

pub async fn serve(socket: WebSocket, state: SharedState, vouched: bool) {
    let id = format!(
        "conn-{}",
        state.next_conn.fetch_add(1, Ordering::Relaxed) + 1
    );
    tracing::info!(conn = %id, "websocket connected");
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(OUTBOUND);
    let mut shutdown = state.shutdown.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = shutdown.changed() => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code: 1001,
                            reason: "runtime shutting down".into(),
                        })))
                        .await;
                    break;
                }
            }
        }
    });
    let conn = Arc::new(Connection {
        id: id.clone(),
        state: Arc::clone(&state),
        out: tx,
        subs: Mutex::new(HashMap::new()),
        closing: AtomicBool::new(false),
        next_sub: AtomicU64::new(1),
        ticket: Mutex::new(None),
        opened: tokio::time::Instant::now(),
        pulse: Mutex::new(None),
    });
    let (answered, mut answers) = mpsc::unbounded_channel::<Answer>();
    let replier = {
        let conn = Arc::clone(&conn);
        tokio::spawn(async move {
            while let Some(answer) = answers.recv().await {
                conn.reply(answer).await;
            }
        })
    };
    let mut shutdown = state.shutdown.clone();
    let mut proven = vouched;
    let deadline = tokio::time::sleep(HELLO_DEADLINE);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Text(text))) if !proven => {
                    if !conn.prove(&text).await {
                        break;
                    }
                    proven = true;
                }
                Some(Ok(Message::Binary(_))) if !proven => break,
                Some(Ok(Message::Text(text))) => {
                    let text = text.to_string();
                    if runs_concurrently(&text) {
                        let c = Arc::clone(&conn);
                        tokio::spawn(async move { c.handle_text(text).await });
                    } else {
                        let _ = answered.send(conn.answer(text).await);
                    }
                }
                Some(Ok(Message::Binary(_))) => {
                    let resp = RpcResponse::err(None, rpc_err(codes::INVALID_REQUEST, "binary frames are not supported"));
                    let _ = conn.out.send(serde_json::to_string(&resp).unwrap_or_default()).await;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            () = &mut deadline, if !proven => {
                tracing::info!(conn = %id, "websocket closed: no session.hello proved it");
                break;
            }
            _ = shutdown.changed() => break,
        }
    }
    replier.abort();
    {
        let mut subs = conn.subs.lock();
        conn.closing.store(true, Ordering::Release);
        subs.clear();
    }
    if let Some(pulse) = conn.pulse.lock().take() {
        pulse.abort();
    }
    if let Some(ticket) = conn.ticket.lock().take() {
        state.tickets.closed(&ticket, Instant::now());
    }
    drop(conn);
    let _ = writer.await;
    tracing::info!(conn = %id, "websocket closed");
}

fn runs_concurrently(text: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct Probe<'a> {
        #[serde(borrow)]
        method: Option<&'a str>,
    }
    let t = text.trim_start();
    if t.starts_with('[') {
        return true;
    }
    serde_json::from_str::<Probe<'_>>(t).is_ok_and(|p| {
        matches!(
            p.method,
            Some(methods::TOOLS_INVOKE | methods::APPROVALS_RESOLVE | methods::SUBSCRIBE)
        )
    })
}

impl Connection {
    async fn send(&self, text: String) {
        let _ = self.out.send(text).await;
    }

    async fn prove(self: &Arc<Self>, text: &str) -> bool {
        let hello = serde_json::from_str::<RpcRequest>(text)
            .ok()
            .filter(|r| r.jsonrpc == JSONRPC_VERSION && r.method == methods::SESSION_HELLO);
        let Some(req) = hello else {
            self.refuse(None, "missing").await;
            return false;
        };
        let hello: HelloParams = match params(req.params.unwrap_or(Value::Null)) {
            Ok(h) => h,
            Err(e) => {
                self.send(serde_json::to_string(&RpcResponse::err(req.id, e)).unwrap_or_default())
                    .await;
                return false;
            }
        };
        let st = &self.state;
        let now = Instant::now();
        let proof = match (&hello.token, &hello.ticket) {
            (Some(t), _) if st.token.matches(t.expose()) => Ok(None),
            (Some(_), _) => Err("invalid"),
            (None, Some(r)) if st.tickets.redeem(r.expose(), now) => Ok(Some(st.token.secret())),
            (None, _) => Err("missing"),
        };
        let token = match proof {
            Ok(token) => token,
            Err(credential) => {
                self.refuse(req.id, credential).await;
                return false;
            }
        };
        let ticket = match st.tickets.issue(now) {
            Ok(t) => t,
            Err(e) => {
                let err = rpc_err(codes::INTERNAL_ERROR, e.to_string());
                self.send(
                    serde_json::to_string(&RpcResponse::err(req.id, err)).unwrap_or_default(),
                )
                .await;
                return false;
            }
        };
        *self.ticket.lock() = Some(ticket.clone());
        let result = HelloResult {
            reload_ticket: Some(ticket),
            token,
            ..self.hello(&hello)
        };
        if req.id.is_some() {
            let answer = to_value(&result).map_or_else(
                |e| RpcResponse::err(req.id.clone(), e),
                |v| RpcResponse::ok(req.id.clone(), v),
            );
            self.send(serde_json::to_string(&answer).unwrap_or_default())
                .await;
        }
        true
    }

    async fn refuse(&self, id: Option<RequestId>, credential: &'static str) {
        tracing::info!(conn = %self.id, credential, "websocket refused: its session.hello did not prove it");
        let err = rpc_err(
            codes::UNAUTHORIZED,
            "this connection's session.hello needs the runtime's token",
        )
        .with_data(json!({ "credential": credential }));
        self.send(serde_json::to_string(&RpcResponse::err(id, err)).unwrap_or_default())
            .await;
    }

    async fn handle_text(self: Arc<Self>, text: String) {
        let answer = self.answer(text).await;
        self.reply(answer).await;
    }

    async fn answer(self: &Arc<Self>, text: String) -> Answer {
        let value: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                let resp = RpcResponse::err(
                    None,
                    rpc_err(codes::PARSE_ERROR, format!("parse error: {e}")),
                );
                return (serde_json::to_string(&resp).ok(), Vec::new());
            }
        };
        match value {
            Value::Array(items) if items.is_empty() => {
                let resp = RpcResponse::err(None, rpc_err(codes::INVALID_REQUEST, "empty batch"));
                (serde_json::to_string(&resp).ok(), Vec::new())
            }
            Value::Array(items) => {
                let mut responses = Vec::new();
                let mut starters = Vec::new();
                for item in items {
                    let (resp, starter) = self.handle_value(item).await;
                    responses.extend(resp);
                    starters.extend(starter);
                }
                let text = (!responses.is_empty())
                    .then(|| serde_json::to_string(&responses).unwrap_or_default());
                (text, starters)
            }
            v => {
                let (resp, starter) = self.handle_value(v).await;
                let text = resp.map(|r| serde_json::to_string(&r).unwrap_or_default());
                (text, starter.into_iter().collect())
            }
        }
    }

    async fn reply(&self, (text, starters): Answer) {
        if let Some(text) = text {
            self.send(text).await;
        }
        for s in starters {
            let _ = s.send(());
        }
    }

    async fn handle_value(self: &Arc<Self>, v: Value) -> (Option<RpcResponse>, Option<Starter>) {
        let req: RpcRequest = match serde_json::from_value(v) {
            Ok(r) => r,
            Err(e) => {
                return (
                    Some(RpcResponse::err(
                        None,
                        rpc_err(codes::INVALID_REQUEST, format!("invalid request: {e}")),
                    )),
                    None,
                );
            }
        };
        if req.jsonrpc != JSONRPC_VERSION {
            return (
                Some(RpcResponse::err(
                    req.id,
                    rpc_err(codes::INVALID_REQUEST, "jsonrpc must be \"2.0\""),
                )),
                None,
            );
        }
        let id: Option<RequestId> = req.id.clone();
        let started = std::time::Instant::now();
        let outcome = self
            .dispatch(&req.method, req.params.unwrap_or(Value::Null))
            .await;
        tracing::debug!(
            conn = %self.id,
            method = %req.method,
            ok = outcome.is_ok(),
            ms = started.elapsed().as_secs_f64() * 1000.0,
            "rpc"
        );
        let notification = id.is_none();
        match outcome {
            Ok((value, starter)) => ((!notification).then(|| RpcResponse::ok(id, value)), starter),
            Err(e) => ((!notification).then(|| RpcResponse::err(id, e)), None),
        }
    }

    async fn dispatch(
        self: &Arc<Self>,
        method: &str,
        p: Value,
    ) -> Result<(Value, Option<Starter>), RpcError> {
        let st = &self.state;
        match method {
            methods::SESSION_HELLO => {
                let hello: HelloParams = params(p)?;
                Ok((to_value(&self.hello(&hello))?, None))
            }
            methods::TOOLS_LIST => {
                let q: ToolsListParams = params(p)?;
                let tools = st.invoker.registry().descriptors(
                    Audience::User,
                    q.category.as_deref(),
                    q.include_hidden.unwrap_or(false),
                );
                Ok((to_value(&tools)?, None))
            }
            methods::TOOLS_INVOKE => {
                let q: ToolsInvokeParams = params(p)?;
                let result = st
                    .invoker
                    .invoke(InvokeRequest {
                        name: q.name,
                        input: q.input,
                        origin: Origin::User,
                        call_id: None,
                        idempotency_key: q.idempotency_key,
                        deadline: q.deadline,
                        surface: q
                            .surface
                            .map(|s| SurfaceState {
                                armed: s.armed,
                                hold_confirmed: s.hold_confirmed,
                            })
                            .unwrap_or_default(),
                    })
                    .await;
                Ok((to_value(&result)?, None))
            }
            methods::SUBSCRIBE => {
                let q: SubscribeParams = params(p)?;
                let (result, starter) = self.subscribe(q).await?;
                Ok((to_value(&result)?, Some(starter)))
            }
            methods::UNSUBSCRIBE => {
                let q: UnsubscribeParams = params(p)?;
                let removed = self.subs.lock().remove(&q.subscription_id).is_some();
                Ok((to_value(&UnsubscribeResult { removed })?, None))
            }
            methods::APPROVALS_RESOLVE => {
                let q: ApprovalsResolveParams = params(p)?;
                let res = st
                    .invoker
                    .resolve(&q, &Origin::User)
                    .await
                    .map_err(resolve_error)?;
                Ok((to_value(&res)?, None))
            }
            other => Err(rpc_err(
                codes::METHOD_NOT_FOUND,
                format!("method not found: {other}"),
            )),
        }
    }

    fn start_pulse(&self) -> u64 {
        let origin = tokio::time::Instant::now();
        let task = tokio::spawn(pulse(self.out.clone(), self.opened, origin, PULSE_EVERY));
        if let Some(earlier) = self.pulse.lock().replace(task) {
            earlier.abort();
        }
        pulse_ms(self.opened, origin)
    }

    fn hello(&self, hello: &HelloParams) -> HelloResult {
        let pulse_ms = (hello.pulse == Some(true)).then(|| self.start_pulse());
        let st = &self.state;
        if let Some(c) = &hello.client {
            tracing::info!(conn = %self.id, client = %c.name, platform = ?c.platform, "hello");
            st.account.hello(&c.name, c.version.as_deref());
        }
        HelloResult {
            server_version: st.version.to_owned(),
            protocol_version: PROTOCOL_VERSION,
            connection_id: self.id.clone(),
            environment: st.broker.paper_broker().primary_environment(),
            server_time: st.clock.now(),
            default_layout_id: st.layouts.active_id(),
            capabilities: st.capabilities(),
            reload_ticket: None,
            token: None,
            pulse_ms,
        }
    }

    async fn subscribe(
        self: &Arc<Self>,
        q: SubscribeParams,
    ) -> Result<(SubscribeResult, Starter), RpcError> {
        let st = &self.state;
        let handler =
            st.topics.get(q.topic.as_str()).cloned().ok_or_else(|| {
                rpc_err(codes::UNKNOWN_TOPIC, format!("unknown topic {}", q.topic))
            })?;
        let topic = handler.name();
        let replay_enabled = q.replay.unwrap_or(true);
        let (rx, replay) = st
            .bus
            .subscribe(topic)
            .ok_or_else(|| rpc_err(codes::UNKNOWN_TOPIC, topic))?;
        let sub = handler.subscribe(q.params).await?;
        let replay = if replay_enabled { replay } else { Vec::new() };
        let sub_id = format!("sub-{}", self.next_sub.fetch_add(1, Ordering::Relaxed));
        let (start_tx, start_rx) = oneshot::channel();
        let task = tokio::spawn(forward(
            self.out.clone(),
            topic,
            sub_id.clone(),
            sub.filter,
            sub.snapshot,
            sub.resync,
            replay,
            rx,
            start_rx,
        ));
        let subscription = Subscription {
            task,
            _keepalive: sub.keepalive,
        };
        {
            let mut subs = self.subs.lock();
            if self.closing.load(Ordering::Acquire) {
                return Err(rpc_err(codes::SHUTTING_DOWN, "the connection closed"));
            }
            subs.insert(sub_id.clone(), subscription);
        }
        Ok((
            SubscribeResult {
                subscription_id: sub_id,
                topic: topic.to_owned(),
            },
            start_tx,
        ))
    }
}

#[allow(clippy::too_many_arguments)]
async fn forward(
    out: mpsc::Sender<String>,
    topic: &'static str,
    sub: String,
    filter: KeyFilter,
    snapshot: Vec<Box<RawValue>>,
    resync: Option<Resync>,
    replay: Vec<Arc<BusEvent>>,
    mut rx: broadcast::Receiver<Arc<BusEvent>>,
    start: oneshot::Receiver<()>,
) {
    if start.await.is_err() {
        return;
    }
    for data in &snapshot {
        if out.send(notification(topic, 0, &sub, data)).await.is_err() {
            return;
        }
    }
    let mut seq = DeliverySeq::default();
    for ev in replay.iter().filter(|e| filter.matches(&e.key)) {
        if out
            .send(notification(topic, seq.next(), &sub, &ev.data))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        match rx.recv().await {
            Ok(ev) => {
                if filter.matches(&ev.key)
                    && out
                        .send(notification(topic, seq.next(), &sub, &ev.data))
                        .await
                        .is_err()
                {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::debug!(%sub, topic, dropped = n, "subscriber lagged");
                match resync.as_ref().map(|now| (rx.resubscribe(), now())) {
                    Some((fresh, Some(data))) => {
                        rx = fresh;
                        if out.send(notification(topic, 0, &sub, &data)).await.is_err() {
                            return;
                        }
                    }
                    _ => seq.skip(),
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

#[derive(Debug, Default)]
struct DeliverySeq {
    last: u64,
    lost: bool,
}

impl DeliverySeq {
    fn next(&mut self) -> u64 {
        self.last += if std::mem::take(&mut self.lost) { 2 } else { 1 };
        self.last
    }

    fn skip(&mut self) {
        self.lost = true;
    }
}

fn resolve_error(e: ResolveError) -> RpcError {
    let (code, msg) = match &e {
        ResolveError::Approval(a) => match a {
            ApprovalError::NotFound(_) => (codes::NOT_FOUND, e.to_string()),
            ApprovalError::NotUser | ApprovalError::SelfApproval => {
                (codes::FORBIDDEN, e.to_string())
            }
            ApprovalError::HashMismatch => (codes::PREVIEW_HASH_MISMATCH, e.to_string()),
            ApprovalError::AlreadyResolved(_) => (codes::ALREADY_RESOLVED, e.to_string()),
            ApprovalError::Stale => (codes::STALE, e.to_string()),
            ApprovalError::MissingEditInput => (codes::INVALID_PARAMS, e.to_string()),
        },
        ResolveError::InvalidInput(_) => (codes::INVALID_PARAMS, e.to_string()),
        ResolveError::UnknownTool(_) => (codes::NOT_FOUND, e.to_string()),
        ResolveError::Conflict(_) => (codes::CONFLICT, e.to_string()),
        ResolveError::NotReady(e) => (codes::INVALID_PARAMS, e.message.clone()),
    };
    rpc_err(code, msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn pulses_keep_their_second_while_a_slow_page_keeps_the_queue_full() {
        let (out, mut page) = mpsc::channel::<String>(8);
        for _ in 0..20 {
            let out = out.clone();
            tokio::spawn(async move { while out.send("event".to_owned()).await.is_ok() {} });
        }
        let opened = tokio::time::Instant::now();
        tokio::spawn(pulse(out, opened, opened, Duration::from_secs(1)));
        let mut stamps = Vec::new();
        let reading = tokio::time::Instant::now();
        while reading.elapsed() < Duration::from_secs(120) {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let frame = page.recv().await.unwrap();
            if frame.contains("session.pulse") {
                let v: Value = serde_json::from_str(&frame).unwrap();
                stamps.push(v["params"]["ms"].as_u64().unwrap());
            }
        }
        assert!(stamps.len() > 60, "{} pulses read in 2 min", stamps.len());
        let widest = stamps.windows(2).map(|w| w[1] - w[0]).max().unwrap();
        assert!(widest <= 1_500, "pulses {widest} ms apart: {stamps:?}");
    }

    #[test]
    fn concurrency_probe() {
        assert!(runs_concurrently(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools.invoke","params":{}}"#
        ));
        assert!(runs_concurrently(r#"{"method":"approvals.resolve"}"#));
        assert!(runs_concurrently("[{}]"));
        assert!(runs_concurrently(
            r#"{"jsonrpc":"2.0","id":1,"method":"subscribe","params":{}}"#
        ));
        assert!(!runs_concurrently(
            r#"{"jsonrpc":"2.0","id":1,"method":"unsubscribe","params":{}}"#
        ));
        assert!(!runs_concurrently("{nope"));
    }

    #[test]
    fn delivery_seq_counts_per_subscription_and_marks_losses() {
        let mut seq = DeliverySeq::default();
        assert_eq!(seq.next(), 1);
        assert_eq!(seq.next(), 2);
        seq.skip();
        seq.skip();
        assert_eq!(seq.next(), 4, "one number skipped however many lag reports");
        assert_eq!(seq.next(), 5);
    }

    async fn behind(resync: Option<Resync>) -> Vec<Value> {
        let (tx, rx) = broadcast::channel::<Arc<BusEvent>>(4);
        let (out, mut page) = mpsc::channel::<String>(1);
        let (start, started) = oneshot::channel();
        tokio::spawn(forward(
            out,
            "market.depth",
            "sub-1".to_owned(),
            KeyFilter::All,
            Vec::new(),
            resync,
            Vec::new(),
            rx,
            started,
        ));
        start.send(()).unwrap();
        let publish = |n: u64| {
            tx.send(Arc::new(BusEvent {
                topic: "market.depth",
                key: tessera_host::TopicKey::None,
                seq: n,
                data: serde_json::value::to_raw_value(&json!({ "delta": n })).unwrap(),
            }))
            .unwrap();
        };
        let mut read = Vec::new();
        publish(1);
        read.push(frame(&mut page).await);
        for n in 2..=20 {
            publish(n);
        }
        read.push(frame(&mut page).await);
        publish(21);
        read.push(frame(&mut page).await);
        read
    }

    async fn frame(page: &mut mpsc::Receiver<String>) -> Value {
        let v: Value = serde_json::from_str(&page.recv().await.unwrap()).unwrap();
        json!([v["params"]["seq"], v["params"]["data"]])
    }

    #[tokio::test]
    async fn a_subscriber_that_fell_behind_gets_the_state_now_in_place_of_what_it_lost() {
        let resync = tessera_host::Subscribed::new(KeyFilter::All)
            .resync(|| Some(json!({ "book": 20 })))
            .resync;
        assert_eq!(
            behind(resync).await,
            vec![
                json!([1, { "delta": 1 }]),
                json!([0, { "book": 20 }]),
                json!([2, { "delta": 21 }]),
            ]
        );
        assert_eq!(
            behind(None).await,
            vec![
                json!([1, { "delta": 1 }]),
                json!([3, { "delta": 17 }]),
                json!([4, { "delta": 18 }]),
            ],
            "without a state to send, the lost events leave a gap"
        );
    }

    #[test]
    fn notification_shape() {
        let data = serde_json::value::to_raw_value(&json!({"a": 1})).unwrap();
        let n = notification("market.quotes", 7, "sub-1", &data);
        let v: Value = serde_json::from_str(&n).unwrap();
        assert_eq!(
            v,
            json!({"jsonrpc":"2.0","method":"event","params":{"topic":"market.quotes","seq":7,"subscriptionId":"sub-1","data":{"a":1}}})
        );
    }
}
