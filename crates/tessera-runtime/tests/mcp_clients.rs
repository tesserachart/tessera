use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::clock::ManualClock;
use tessera_core::ids::SessionId;
use tessera_core::settle::{settle, settle_async};
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{Origin, Timestamp};
use tessera_mcp::Discovery;
use tessera_protocol::tools::{SessionMode, ToolOutcome};
use tessera_runtime::logging::Redactor;
use tessera_runtime::{Runtime, RuntimeConfig, RuntimeHandle};
use tessera_testkit::Fakes;
use tessera_tools::{Audience, InvokeRequest, Invoker, SessionPolicy};

mod common;

use common::http;

fn config(data_dir: Option<&Path>) -> RuntimeConfig {
    RuntimeConfig {
        data_dir: data_dir.map(Path::to_path_buf),
        mcp_exe: Some("/opt/tessera/tessera-runtime".into()),
        ..RuntimeConfig::default()
    }
}

async fn start(data_dir: Option<&Path>) -> RuntimeHandle {
    Runtime::build(config(data_dir), vec![Fakes::still(1).module()])
        .await
        .unwrap()
        .spawn()
}

async fn user(inv: &Invoker, name: &str, input: Value) -> Result<Value, String> {
    let r = inv
        .invoke(InvokeRequest::new(name, input, Origin::User))
        .await;
    match (r.ok, r.output, r.error) {
        (true, Some(out), _) => Ok(out),
        (_, _, e) => Err(format!("{:?} {e:?}", r.status)),
    }
}

async fn connect(inv: &Invoker, kind: &str, policy: Option<&str>) -> (String, String) {
    let mut input = json!({ "kind": kind });
    if let Some(p) = policy {
        input["policy"] = json!(p);
    }
    let out = user(inv, "mcp.add_client", input).await.unwrap();
    (
        out["client"]["id"].as_str().unwrap().to_owned(),
        out["token"].as_str().unwrap().to_owned(),
    )
}

async fn post(port: u16, token: &str, msg: Value) -> (u16, Value) {
    let body = msg.to_string();
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let (status, raw) = http(port, &req).await;
    let json = raw
        .split_once("\r\n\r\n")
        .and_then(|(_, b)| serde_json::from_str(b).ok())
        .unwrap_or(Value::Null);
    (status, json)
}

fn rpc(id: i64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

async fn tool_names(port: u16, token: &str) -> Vec<String> {
    let (status, list) = post(port, token, rpc(1, "tools/list", json!({}))).await;
    assert_eq!(status, 200, "{list}");
    list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect()
}

async fn call(port: u16, token: &str, tool: &str, args: Value) -> Value {
    let (status, answer) = post(
        port,
        token,
        rpc(2, "tools/call", json!({"name": tool, "arguments": args})),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    answer
}

fn refused(answer: &Value) -> bool {
    answer.get("error").is_some() || answer["result"]["isError"] == true
}

const USER_ONLY: [&str; 12] = [
    "account_status",
    "account_sign_in",
    "account_sign_out",
    "mcp_list_clients",
    "mcp_add_client",
    "mcp_revoke_client",
    "mcp_set_client_policy",
    "mcp_add_to_claude_desktop",
    "approvals_resolve",
    "agent_set_mode",
    "connections_add_rithmic",
    "connections_list_credentials",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connected_client_calls_under_its_policy_until_it_is_revoked() {
    let h = start(None).await;
    let inv = Arc::clone(&h.state.invoker);
    let (id, token) = connect(&inv, "claude-desktop", None).await;
    assert_eq!(id, "claude-desktop");
    let origin = Origin::External {
        client_id: id.clone(),
    };

    let (status, init) = post(
        h.port,
        &token,
        rpc(0, "initialize", json!({"protocolVersion": "2025-06-18"})),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(init["result"]["serverInfo"]["name"], "tessera");
    assert_eq!(
        post(h.port, &h.token, rpc(1, "ping", json!({}))).await.0,
        401
    );
    let body = rpc(1, "ping", json!({})).to_string();
    let from_page = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:5173\r\nAuthorization: Bearer {token}\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    assert_eq!(http(h.port, &from_page).await.0, 403);

    let names = tool_names(h.port, &token).await;
    assert!(names.iter().any(|n| n == "watchlists_list"), "{names:?}");
    assert!(names.iter().any(|n| n == "watchlists_create"), "{names:?}");
    assert!(names.iter().any(|n| n == "orders_submit"), "{names:?}");
    for u in USER_ONLY {
        assert!(!names.iter().any(|n| n == u), "{u} is listed to a client");
        assert!(refused(&call(h.port, &token, u, json!({})).await), "{u}");
    }

    let r = call(h.port, &token, "watchlists_list", json!({})).await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    let r = call(
        h.port,
        &token,
        "watchlists_create",
        json!({"name": "From Claude"}),
    )
    .await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    assert!(
        r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("approves or rejects it in Tessera"),
        "{r}"
    );
    let r = call(
        h.port,
        &token,
        "orders_submit",
        json!({"accountId": "paper-main", "instrument": "NQ", "side": "buy", "qty": 1, "orderType": "market"}),
    )
    .await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    let pending: Vec<_> = inv
        .approvals()
        .pending()
        .into_iter()
        .filter(|a| a.origin == origin)
        .map(|a| a.tool)
        .collect();
    assert_eq!(pending, ["watchlists.create", "orders.submit"]);
    assert!(refused(
        &call(h.port, &token, "approvals_resolve", json!({})).await
    ));

    let listed = user(&inv, "mcp.list_clients", json!({})).await.unwrap();
    assert!(listed["clients"][0]["lastUsedAt"].is_number(), "{listed}");
    assert!(!listed.to_string().contains(&token[4..]), "never its token");

    user(
        &inv,
        "mcp.set_client_policy",
        json!({"id": id, "policy": "read_only"}),
    )
    .await
    .unwrap();
    let names = tool_names(h.port, &token).await;
    assert!(names.iter().any(|n| n == "watchlists_list"));
    assert!(!names.iter().any(|n| n == "watchlists_create"), "{names:?}");
    assert!(!names.iter().any(|n| n == "orders_submit"), "{names:?}");
    let r = call(h.port, &token, "watchlists_create", json!({"name": "Nope"})).await;
    assert!(refused(&r), "{r}");
    assert_eq!(inv.policy_for(&origin).mode, SessionMode::ReadOnly);

    let out = user(&inv, "mcp.revoke_client", json!({"id": id}))
        .await
        .unwrap();
    assert_eq!(out["revoked"], true);
    assert_eq!(post(h.port, &token, rpc(3, "ping", json!({}))).await.0, 401);
    let listed = user(&inv, "mcp.list_clients", json!({})).await.unwrap();
    assert_eq!(listed["clients"], json!([]));
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mcp_tools_are_the_users_alone_and_a_token_never_reaches_a_log_or_a_record() {
    let tmp = tempfile::tempdir().unwrap();
    let claude = tmp.path().join("Claude");
    std::fs::create_dir_all(&claude).unwrap();
    let file = claude.join("claude_desktop_config.json");
    std::fs::write(
        &file,
        r#"{"mcpServers": {"filesystem": {"command": "npx"}}}"#,
    )
    .unwrap();
    let rt = Runtime::build(
        RuntimeConfig {
            claude_desktop_config: Some(file.clone()),
            ..config(None)
        },
        vec![Fakes::still(1).module()],
    )
    .await
    .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);

    let agent = Origin::Agent {
        session_id: SessionId::new("S-mcp"),
        provider: "codex".into(),
    };
    inv.set_policy(&agent, SessionPolicy::with_mode(SessionMode::FullAccess));
    let listed: Vec<String> = inv
        .registry()
        .descriptors(Audience::Agent, None, true)
        .into_iter()
        .map(|d| d.name)
        .collect();
    for name in [
        "mcp.list_clients",
        "mcp.add_client",
        "mcp.revoke_client",
        "mcp.set_client_policy",
        "mcp.add_to_claude_desktop",
    ] {
        assert!(!listed.iter().any(|n| n == name), "{name}");
        let r = inv
            .invoke(InvokeRequest::new(
                name,
                json!({"kind": "codex"}),
                agent.clone(),
            ))
            .await;
        assert_eq!(r.status, ToolOutcome::Denied, "{name}: {r:?}");
    }

    let out = user(&inv, "mcp.add_client", json!({"kind": "claude-desktop"}))
        .await
        .unwrap();
    let token = out["token"].as_str().unwrap().to_owned();
    let id = out["client"]["id"].as_str().unwrap().to_owned();
    assert_eq!(out["snippets"][0]["format"], "json");
    assert!(
        out["snippets"][0]["text"]
            .as_str()
            .unwrap()
            .contains("/opt/tessera/tessera-runtime")
    );
    assert_eq!(
        Redactor::global().redact(&format!("token={token}")),
        "token=[redacted]"
    );

    let added = user(
        &inv,
        "mcp.add_to_claude_desktop",
        json!({"id": id, "token": token}),
    )
    .await
    .unwrap();
    assert_eq!(added["path"], file.display().to_string());
    assert!(added["backup"].is_string());
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(v["mcpServers"]["filesystem"]["command"], "npx");
    assert_eq!(
        v["mcpServers"]["tessera"]["env"]["TESSERA_MCP_TOKEN"],
        token
    );
    assert!(
        user(
            &inv,
            "mcp.add_to_claude_desktop",
            json!({"id": id, "token": "tsk_not-this-one"}),
        )
        .await
        .is_err()
    );

    let recorded = &state;
    let rows = settle_async(
        "the user's calls are recorded",
        move || async move {
            recorded.observer.flush().await;
            let conn = recorded.store.conn().unwrap();
            let mut stmt = conn
                .prepare("SELECT tool, input FROM tool_calls WHERE tool LIKE 'mcp.%'")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<(String, String)>, _>>()
                .unwrap()
        },
        |rows| rows.len() >= 3,
    )
    .await;
    for (_, input) in &rows {
        assert!(!input.contains(&token[4..]), "{input}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_outlives_a_restart_and_the_discovery_file_lives_with_the_runtime() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let h = start(Some(&dir)).await;
    let (_, token) = connect(&h.state.invoker, "cursor", None).await;
    let found = wait_for_discovery(&dir).await;
    assert_eq!(found.port, h.port);
    assert_eq!(found.pid, std::process::id());
    let text = std::fs::read_to_string(dir.join(tessera_mcp::DISCOVERY_FILE)).unwrap();
    assert!(!text.contains(&h.token), "never the user's token");
    assert!(!text.contains(&token[4..]), "nor a client's");
    h.shutdown().await.unwrap();
    assert_eq!(Discovery::read(&dir), None, "removed on a clean stop");

    let h = start(Some(&dir)).await;
    assert_eq!(wait_for_discovery(&dir).await.port, h.port);
    let (status, answer) = post(h.port, &token, rpc(1, "ping", json!({}))).await;
    assert_eq!(status, 200, "{answer}");
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_clients_calls_are_counted_a_minute_at_a_time() {
    let clock = Arc::new(ManualClock::new(
        Timestamp::parse("2026-10-02T14:42:30-04:00").unwrap(),
    ));
    let h = Runtime::build(
        RuntimeConfig {
            clock: clock.clone(),
            ..config(None)
        },
        vec![Fakes::still(1).module()],
    )
    .await
    .unwrap()
    .spawn();
    let inv = Arc::clone(&h.state.invoker);
    for (key, value) in [
        ("agent.maxToolCallsPerTurn", json!(3)),
        ("agent.dedupWindowMs", json!(0)),
    ] {
        user(&inv, "settings.set", json!({"key": key, "value": value}))
            .await
            .unwrap();
    }
    let (_, token) = connect(&inv, "cursor", None).await;
    for _ in 0..3 {
        let r = call(h.port, &token, "watchlists_list", json!({})).await;
        assert_eq!(r["result"]["isError"], false, "{r}");
    }
    let r = call(h.port, &token, "watchlists_list", json!({})).await;
    assert!(refused(&r), "the fourth call this minute: {r}");
    assert!(r.to_string().contains("tool-call limit"), "{r}");
    clock.advance(61 * NANOS_PER_SEC);
    let r = call(h.port, &token, "watchlists_list", json!({})).await;
    assert_eq!(r["result"]["isError"], false, "a minute on: {r}");
    h.shutdown().await.unwrap();
}

async fn wait_for_discovery(dir: &Path) -> Discovery {
    settle(
        &format!("a discovery file appears in {}", dir.display()),
        || Discovery::read(dir),
        Option::is_some,
    )
    .await
    .expect("a discovery file")
}

async fn through_the_shim(dir: &Path, token: Option<&str>, lines: &[Value]) -> Vec<Value> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut agent, shim_side) = tokio::io::duplex(1 << 20);
    let (read, write) = tokio::io::split(shim_side);
    let shim = tokio::spawn(tessera_runtime::mcp_stdio::run(
        dir.to_path_buf(),
        token.map(str::to_owned),
        read,
        write,
    ));
    let mut input = String::new();
    for l in lines {
        input.push_str(&l.to_string());
        input.push('\n');
    }
    agent.write_all(input.as_bytes()).await.unwrap();
    agent.shutdown().await.unwrap();
    let mut out = String::new();
    agent.read_to_string(&mut out).await.unwrap();
    shim.await.unwrap().unwrap();
    out.lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_stdio_shim_proxies_an_agent_to_the_running_runtime() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let h = start(Some(&dir)).await;
    let (_, token) = connect(&h.state.invoker, "claude-code", None).await;
    wait_for_discovery(&dir).await;

    let answers = through_the_shim(
        &dir,
        Some(&token),
        &[
            rpc(1, "initialize", json!({"protocolVersion": "2025-06-18"})),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            rpc(2, "tools/list", json!({})),
            rpc(
                3,
                "tools/call",
                json!({"name": "watchlists_list", "arguments": {}}),
            ),
        ],
    )
    .await;
    assert_eq!(
        answers.len(),
        3,
        "a notification gets no answer: {answers:?}"
    );
    let by_id = |id: i64| answers.iter().find(|a| a["id"] == id).unwrap();
    assert_eq!(by_id(1)["result"]["serverInfo"]["name"], "tessera");
    let names: Vec<&str> = by_id(2)["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"watchlists_list"));
    assert!(!names.contains(&"mcp_add_client"));
    assert_eq!(by_id(3)["result"]["isError"], false, "{}", by_id(3));

    user(
        &h.state.invoker,
        "mcp.revoke_client",
        json!({"id": "claude-code"}),
    )
    .await
    .unwrap();
    let answers = through_the_shim(&dir, Some(&token), &[rpc(4, "ping", json!({}))]).await;
    assert_eq!(
        answers[0]["error"]["message"],
        tessera_runtime::mcp_stdio::REFUSED
    );

    h.shutdown().await.unwrap();
    let answers = through_the_shim(&dir, Some(&token), &[rpc(5, "ping", json!({}))]).await;
    assert_eq!(
        answers[0]["error"]["message"],
        tessera_runtime::mcp_stdio::NOT_RUNNING
    );
}

fn shim_process(dir: &Path, token: &str, input: &str) -> Vec<Value> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessera-runtime"))
        .args(["mcp-stdio", "--data-dir"])
        .arg(dir)
        .env("TESSERA_MCP_TOKEN", token)
        .env_remove("TESSERA_EXPECT_CHECKOUT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn tessera-runtime mcp-stdio");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{:?}", out.status);
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).expect("stdout carries JSON-RPC lines only"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shim_binary_answers_an_agent_and_says_when_tessera_is_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let input = format!(
        "{}\n{}\n",
        rpc(1, "initialize", json!({"protocolVersion": "2025-06-18"})),
        rpc(2, "tools/list", json!({}))
    );

    let (d, i) = (dir.clone(), input.clone());
    let answers = tokio::task::spawn_blocking(move || shim_process(&d, "tsk_test", &i))
        .await
        .unwrap();
    assert_eq!(answers.len(), 2);
    for a in &answers {
        let message = a["error"]["message"].as_str().unwrap();
        assert!(message.contains("Open Tessera"), "{message}");
    }

    let h = start(Some(&dir)).await;
    let (_, token) = connect(&h.state.invoker, "codex", None).await;
    wait_for_discovery(&dir).await;
    let (d, i) = (dir.clone(), input.clone());
    let answers = tokio::task::spawn_blocking(move || shim_process(&d, &token, &i))
        .await
        .unwrap();
    assert_eq!(answers.len(), 2, "{answers:?}");
    let by_id = |id: i64| answers.iter().find(|a| a["id"] == id).unwrap();
    assert_eq!(by_id(1)["result"]["serverInfo"]["name"], "tessera");
    assert!(by_id(2)["result"]["tools"].as_array().unwrap().len() > 10);
    h.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_tells_the_client_until_when_it_waits_and_that_it_expires_unsent() {
    let h = start(None).await;
    let inv = Arc::clone(&h.state.invoker);
    let (_, token) = connect(&inv, "other", None).await;
    let r = call(
        h.port,
        &token,
        "orders_submit",
        json!({"accountId": "paper-main", "instrument": "NQ", "side": "buy", "qty": 1, "orderType": "limit", "limitPrice": 100}),
    )
    .await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    let text = r["result"]["content"][0]["text"].as_str().unwrap();
    let draft = inv
        .approvals()
        .pending()
        .into_iter()
        .find(|a| a.tool == "orders.submit")
        .unwrap();
    let until = draft
        .stale_at
        .to_datetime()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    assert!(
        text.contains(&until),
        "names the time it waits until: {text}"
    );
    assert!(text.contains("60 s"), "{text}");
    assert!(
        text.contains("1000 more trades"),
        "names the trades that also end it: {text}"
    );
    assert!(
        text.contains("it expires and nothing is sent"),
        "says what happens then: {text}"
    );
    assert!(text.contains(draft.id.as_str()), "{text}");
}
