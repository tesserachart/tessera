use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};

use serde_json::Value;
use tessera_core::settle::settle;

fn spawn(data_dir: &std::path::Path) -> (Child, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessera-runtime"))
        .args(["serve", "--port", "0", "--data-dir"])
        .arg(data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn tessera-runtime");
    let stdout = BufReader::new(child.stdout.take().unwrap());
    (child, stdout)
}

fn ready(stdout: &mut BufReader<ChildStdout>) -> Value {
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read ready line");
    let v: Value = serde_json::from_str(&line).expect("ready line is JSON");
    assert_eq!(v["event"], "ready");
    assert!(v["port"].as_u64().is_some_and(|p| p > 0));
    assert!(
        v["token"]
            .as_str()
            .is_some_and(|t| t.starts_with("tss_") && t.len() == 68)
    );
    v
}

fn exited(child: &mut Child, what: &str) -> ExitStatus {
    let clock = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let waited = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        clock.block_on(settle(what, || child.try_wait().unwrap(), Option::is_some))
    }));
    match waited {
        Ok(status) => status.expect(what),
        Err(stalled) => {
            let _ = child.kill();
            std::panic::resume_unwind(stalled)
        }
    }
}

#[test]
fn prints_one_ready_line_and_exits_when_stdin_closes() {
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join(tessera_runtime::auth::LAUNCH_LINK_FILE);
    std::fs::write(&link, "http://127.0.0.1:1/#ticket=tst_old").unwrap();
    let (mut child, mut stdout) = spawn(dir.path());
    ready(&mut stdout);
    assert!(!link.exists());
    std::fs::write(&link, "http://127.0.0.1:1/#ticket=tst_new").unwrap();
    drop(child.stdin.take());
    let status = exited(&mut child, "the runtime exits once its stdin closes");
    assert!(status.success(), "{status}");
    assert!(!link.exists());
    let mut rest = String::new();
    std::io::Read::read_to_string(&mut stdout, &mut rest).unwrap();
    assert!(
        rest.is_empty(),
        "stdout carries only the ready line, got {rest:?}"
    );
}

#[test]
fn an_installed_update_is_heard_on_stdin_and_the_runtime_still_exits() {
    let dir = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessera-runtime"))
        .args(["serve", "--port", "0", "--data-dir"])
        .arg(dir.path())
        .env(tessera_runtime::secrets::SECRET_STORE_ENV, "file")
        .env("XDG_CONFIG_HOME", config.path())
        .env_remove("TESSERA_CLOUD_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn tessera-runtime");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    ready(&mut stdout);
    let mut stdin = child.stdin.take().unwrap();
    std::io::Write::write_all(
        &mut stdin,
        format!("{}\n", tessera_runtime::handover::UPDATED_LINE).as_bytes(),
    )
    .unwrap();
    drop(stdin);
    let status = exited(&mut child, "the runtime exits once its stdin closes");
    assert!(status.success(), "{status}");
    let mut rest = String::new();
    std::io::Read::read_to_string(&mut stdout, &mut rest).unwrap();
    assert!(
        rest.is_empty(),
        "stdout carries only the ready line, got {rest:?}"
    );
}

#[cfg(unix)]
#[test]
fn sigterm_shuts_down_while_stdin_is_still_open() {
    let dir = tempfile::tempdir().unwrap();
    let (mut child, mut stdout) = spawn(dir.path());
    ready(&mut stdout);
    let kill = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(kill.success());
    let status = exited(&mut child, "SIGTERM stops the runtime");
    assert!(status.success(), "{status}");
    drop(child.stdin.take());
}

#[test]
fn launch_tickets_follow_the_ready_line() {
    use std::io::{Read, Write};

    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessera-runtime"))
        .args(["serve", "--port", "0", "--launch-tickets", "--data-dir"])
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn tessera-runtime");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let ready = ready(&mut stdout);
    let port = u16::try_from(ready["port"].as_u64().unwrap()).unwrap();
    let launch = |stdout: &mut BufReader<ChildStdout>| {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let v: Value = serde_json::from_str(&line).expect("a launch line is JSON");
        assert_eq!(v["event"], "launch", "{line}");
        v["ticket"].as_str().unwrap().to_owned()
    };
    let first = launch(&mut stdout);
    assert!(first.starts_with("tst_") && first.len() == 68, "{first}");

    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Origin: http://127.0.0.1:{port}\r\n\r\n"
    )
    .unwrap();
    let mut head = [0u8; 12];
    s.read_exact(&mut head).unwrap();
    assert_eq!(&head, b"HTTP/1.1 101");
    let hello = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{{"ticket":"{first}"}}}}"#
    );
    // one masked text frame (RFC 6455 §5.2): FIN + text, mask bit + 16-bit length, a zero mask
    let mut frame = vec![0x81, 0xFE];
    frame.extend_from_slice(&u16::try_from(hello.len()).unwrap().to_be_bytes());
    frame.extend_from_slice(&[0, 0, 0, 0]);
    frame.extend_from_slice(hello.as_bytes());
    s.write_all(&frame).unwrap();
    let next = launch(&mut stdout);
    assert!(next.starts_with("tst_") && next != first);

    drop(child.stdin.take());
    let status = exited(&mut child, "the runtime exits once its stdin closes");
    assert!(status.success(), "{status}");
}

#[test]
fn the_token_reaches_neither_stderr_nor_the_log_file() {
    use std::io::{Read, Write};

    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessera-runtime"))
        .args(["serve", "--port", "0", "--data-dir"])
        .arg(dir.path())
        .env_remove("RUST_LOG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn tessera-runtime");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let line = ready(&mut stdout);
    let port = u16::try_from(line["port"].as_u64().unwrap()).unwrap();
    let token = line["token"].as_str().unwrap().to_owned();
    let agent = tessera_core::token::mint(tessera_core::token::AGENT).unwrap();
    for secret in [token.as_str(), agent.expose()] {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Origin: https://evil.example/{secret}\r\nAuthorization: Bearer {token}\r\n\
             Connection: close\r\n\r\n"
        )
        .unwrap();
        let mut answer = String::new();
        s.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
    }
    drop(child.stdin.take());
    let status = exited(&mut child, "the runtime exits once its stdin closes");
    assert!(status.success(), "{status}");
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let log = std::fs::read_to_string(dir.path().join("logs/runtime.log")).unwrap();
    for (sink, text) in [("stderr", &stderr), ("runtime.log", &log)] {
        assert!(
            text.contains("origin not allowed") && text.contains("evil.example/[redacted]"),
            "{sink} logged the refusals: {text}"
        );
        assert!(
            !text.contains(&token[4..]),
            "{sink} holds the session token: {text}"
        );
        assert!(
            !text.contains(&agent.expose()[4..]),
            "{sink} holds an agent token: {text}"
        );
    }
}

#[test]
fn cargo_run_without_bin_starts_the_runtime() {
    let out = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--offline",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run cargo metadata");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let meta: Value = serde_json::from_slice(&out.stdout).unwrap();
    let pkg = meta["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "tessera-runtime")
        .expect("tessera-runtime in the workspace");
    let bins: Vec<&str> = pkg["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["kind"].as_array().unwrap().iter().any(|k| k == "bin"))
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(bins.contains(&"tessera-runtime"), "{bins:?}");
    if bins.len() > 1 {
        assert_eq!(
            pkg["default_run"], "tessera-runtime",
            "crates/tessera-runtime has several binaries ({bins:?}); `default-run` must name the runtime"
        );
    }
}

#[test]
fn a_second_runtime_on_the_same_data_dir_refuses_to_start() {
    let dir = tempfile::tempdir().unwrap();
    let (mut first, mut first_out) = spawn(dir.path());
    ready(&mut first_out);

    let second = Command::new(env!("CARGO_BIN_EXE_tessera-runtime"))
        .args(["serve", "--port", "0", "--data-dir"])
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the second runtime");
    let out = second.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(3), "{:?}", out.status);
    assert!(
        out.stdout.is_empty(),
        "no ready line from the second runtime"
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains(&format!("pid {}", first.id())),
        "the error names the holder: {err}"
    );
    assert!(err.contains("--data-dir"), "{err}");

    assert!(first.try_wait().unwrap().is_none(), "first runtime died");
    drop(first.stdin.take());
    exited(&mut first, "the first runtime exits once its stdin closes");
    let (mut third, mut third_out) = spawn(dir.path());
    ready(&mut third_out);
    drop(third.stdin.take());
    exited(&mut third, "the third runtime exits once its stdin closes");
}

#[test]
fn a_runtime_built_from_another_checkout_refuses_to_start() {
    let bin = env!("CARGO_BIN_EXE_tessera-runtime");
    let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let info = Command::new(bin).arg("build-info").output().unwrap();
    assert!(info.status.success());
    let info: Value = serde_json::from_slice(&info.stdout).unwrap();
    let built: Vec<std::path::PathBuf> = info["checkouts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().into())
        .collect();
    assert_eq!(built.len(), 1, "{info}");
    assert_eq!(
        built[0].canonicalize().unwrap(),
        checkout.canonicalize().unwrap()
    );

    let dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let out = Command::new(bin)
        .args(["serve", "--port", "0", "--data-dir"])
        .arg(dir.path())
        .env("TESSERA_EXPECT_CHECKOUT", elsewhere.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
        .wait_with_output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4), "{:?}", out.status);
    assert!(out.stdout.is_empty(), "no ready line");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("CARGO_TARGET_DIR"), "{err}");
    assert!(
        err.contains(&elsewhere.path().display().to_string()),
        "{err}"
    );
    assert!(
        std::fs::read_dir(dir.path()).unwrap().next().is_none(),
        "the data directory was not touched"
    );

    let mut own = Command::new(bin)
        .args(["serve", "--port", "0", "--data-dir"])
        .arg(dir.path())
        .env("TESSERA_EXPECT_CHECKOUT", &checkout)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(own.stdout.take().unwrap());
    ready(&mut out);
    drop(own.stdin.take());
    exited(&mut own, "the runtime exits once its stdin closes");
}
