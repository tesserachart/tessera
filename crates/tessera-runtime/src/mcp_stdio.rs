use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tessera_mcp::{Discovery, MCP_PATH};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, mpsc};

pub const NOT_RUNNING: &str = "Tessera isn’t running. Open Tessera, then try again.";

pub const NO_TOKEN: &str = "TESSERA_MCP_TOKEN is not set. Connect this agent in Tessera (Settings › Analyst › Use Tessera \
                            from your agent) and use the setup it gives.";

pub const REFUSED: &str = "Tessera refused this agent’s token: it was revoked, or belongs to another Tessera. Connect \
                           the agent again in Tessera (Settings › Analyst).";

const SERVER_ERROR: i64 = -32000;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

struct Shim {
    data_dir: PathBuf,
    token: Option<String>,
    checked: Mutex<Option<(u16, u32)>>,
}

struct Answer {
    status: u16,
    body: Vec<u8>,
}

async fn http(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &[u8],
) -> std::io::Result<Answer> {
    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port)))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timed out"))??;
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json, text/event-stream\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(t) = token {
        head.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await?;
    parse_response(&raw)
}

fn bad(what: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, what.to_owned())
}

fn parse_response(raw: &[u8]) -> std::io::Result<Answer> {
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| bad("no HTTP header"))?;
    let head = std::str::from_utf8(&raw[..end]).map_err(|_| bad("HTTP header not UTF-8"))?;
    let rest = &raw[end + 4..];
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| bad("no HTTP status"))?;
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
    }
    let body = if chunked {
        dechunk(rest)?
    } else {
        match length {
            Some(n) => rest
                .get(..n)
                .ok_or_else(|| bad("short HTTP body"))?
                .to_vec(),
            None => rest.to_vec(),
        }
    };
    Ok(Answer { status, body })
}

fn dechunk(mut rest: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| bad("bad chunk"))?;
        let size_text = std::str::from_utf8(&rest[..line_end]).map_err(|_| bad("bad chunk"))?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| bad("bad chunk size"))?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        out.extend_from_slice(rest.get(..size).ok_or_else(|| bad("short chunk"))?);
        rest = rest.get(size + 2..).ok_or_else(|| bad("short chunk"))?;
    }
}

impl Shim {
    async fn runtime(&self) -> Option<Discovery> {
        let d = Discovery::read(&self.data_dir)?;
        let mut checked = self.checked.lock().await;
        if *checked == Some((d.port, d.pid)) {
            return Some(d);
        }
        let health = http(d.port, "GET", "/healthz", None, b"").await.ok()?;
        let is_tessera = health.status == 200
            && serde_json::from_slice::<Value>(&health.body)
                .ok()
                .is_some_and(|v| v["status"] == "ok" && v["version"].is_string());
        if !is_tessera {
            return None;
        }
        *checked = Some((d.port, d.pid));
        Some(d)
    }

    async fn handle(&self, line: &str) -> Option<Value> {
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Array(batch)) => {
                let mut answers = Vec::new();
                for msg in batch {
                    if let Some(a) = self.forward(msg).await {
                        answers.push(a);
                    }
                }
                (!answers.is_empty()).then_some(Value::Array(answers))
            }
            Ok(msg) => self.forward(msg).await,
            Err(e) => Some(error(Value::Null, -32700, &format!("not JSON: {e}"))),
        }
    }

    async fn forward(&self, msg: Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let fail = |code: i64, message: &str| id.clone().map(|id| error(id, code, message));
        let Some(token) = self.token.as_deref() else {
            return fail(SERVER_ERROR, NO_TOKEN);
        };
        let Some(runtime) = self.runtime().await else {
            return fail(SERVER_ERROR, NOT_RUNNING);
        };
        let body = serde_json::to_vec(&msg).unwrap_or_default();
        let answer = match http(runtime.port, "POST", MCP_PATH, Some(token), &body).await {
            Ok(a) => a,
            Err(_) => {
                *self.checked.lock().await = None;
                return fail(SERVER_ERROR, NOT_RUNNING);
            }
        };
        match answer.status {
            200 => match serde_json::from_slice::<Value>(&answer.body) {
                Ok(v) => Some(v),
                Err(_) => fail(-32603, "Tessera’s answer was not JSON"),
            },
            202 | 204 => None,
            401 => fail(SERVER_ERROR, REFUSED),
            status => match serde_json::from_slice::<Value>(&answer.body) {
                Ok(v) if v.get("jsonrpc").is_some() => id.map(|_| v),
                _ => fail(
                    SERVER_ERROR,
                    &format!(
                        "Tessera answered HTTP {status}: {}",
                        String::from_utf8_lossy(&answer.body).trim()
                    ),
                ),
            },
        }
    }
}

pub async fn run<R, W>(
    data_dir: PathBuf,
    token: Option<String>,
    input: R,
    output: W,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let shim = Arc::new(Shim {
        data_dir,
        token: token.filter(|t| !t.trim().is_empty()),
        checked: Mutex::new(None),
    });
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut output = output;
        while let Some(answer) = rx.recv().await {
            let mut line = serde_json::to_vec(&answer).unwrap_or_default();
            line.push(b'\n');
            output.write_all(&line).await?;
            output.flush().await?;
        }
        std::io::Result::Ok(())
    });
    let mut lines = BufReader::new(input).lines();
    let mut inflight = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let shim = Arc::clone(&shim);
        let tx = tx.clone();
        inflight.spawn(async move {
            if let Some(answer) = shim.handle(&line).await {
                let _ = tx.send(answer);
            }
        });
        while inflight.try_join_next().is_some() {}
    }
    while inflight.join_next().await.is_some() {}
    drop(tx);
    writer.await.map_err(std::io::Error::other)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_are_read_by_length_chunked_or_to_the_end() {
        let a = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}extra").unwrap();
        assert_eq!((a.status, a.body.as_slice()), (200, b"{}".as_slice()));
        let b = parse_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4;x=1\r\n\":1}\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(b.body, br#"{"a":1}"#);
        let c = parse_response(b"HTTP/1.1 202 Accepted\r\n\r\n").unwrap();
        assert_eq!((c.status, c.body.len()), (202, 0));
        assert!(parse_response(b"garbage").is_err());
    }

    async fn ask(data_dir: PathBuf, token: Option<&str>, input: &str) -> Vec<Value> {
        let (mut client, server) = tokio::io::duplex(1 << 16);
        let (read, write) = tokio::io::split(server);
        let task = tokio::spawn(run(data_dir, token.map(str::to_owned), read, write));
        client.write_all(input.as_bytes()).await.unwrap();
        client.shutdown().await.unwrap();
        let mut text = String::new();
        client.read_to_string(&mut text).await.unwrap();
        task.await.unwrap().unwrap();
        text.lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn without_a_runtime_every_request_says_to_open_tessera() {
        let dir = tempfile::tempdir().unwrap();
        let answers = ask(
            dir.path().to_path_buf(),
            Some("tsk_test"),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n\
             {\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n\
             not json\n",
        )
        .await;
        assert_eq!(answers.len(), 2, "{answers:?}");
        let by_id = |id: Value| answers.iter().find(|a| a["id"] == id).unwrap().clone();
        assert_eq!(by_id(json!(1))["error"]["message"], NOT_RUNNING);
        assert_eq!(by_id(Value::Null)["error"]["code"], -32700);

        Discovery {
            port: 1,
            pid: 1,
            version: "0".into(),
        }
        .write(dir.path())
        .unwrap();
        let answers = ask(
            dir.path().to_path_buf(),
            Some("tsk_test"),
            "{\"jsonrpc\":\"2.0\",\"id\":\"a\",\"method\":\"ping\"}\n",
        )
        .await;
        assert_eq!(answers[0]["error"]["message"], NOT_RUNNING);

        let answers = ask(
            dir.path().to_path_buf(),
            None,
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n",
        )
        .await;
        assert_eq!(answers[0]["error"]["message"], NO_TOKEN);
    }
}
