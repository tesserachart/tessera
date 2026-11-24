use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

pub const EXIT_DATA_DIR_LOCKED: i32 = 3;

pub const UPDATED_LINE: &str = r#"{"event":"updated"}"#;

#[cfg(windows)]
fn without_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn without_console_window(_: &mut Command) {}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeConnection {
    pub port: u16,
    pub token: String,
}

impl std::fmt::Debug for RuntimeConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeConnection")
            .field("port", &self.port)
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SidecarStatus {
    Starting,
    Ready(RuntimeConnection),
    Failed(String),
    Stopped,
}

#[derive(Deserialize)]
struct ReadyLine {
    event: String,
    port: u16,
    token: String,
}

pub fn parse_ready_line(line: &str) -> Option<RuntimeConnection> {
    let ready: ReadyLine = serde_json::from_str(line.trim()).ok()?;
    if ready.event != "ready" || ready.port == 0 || ready.token.is_empty() {
        return None;
    }
    Some(RuntimeConnection {
        port: ready.port,
        token: ready.token,
    })
}

#[derive(Clone, Debug)]
pub struct SidecarConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub ready_timeout: Duration,
    pub max_restarts: u32,
    pub env: Vec<(String, String)>,
}

const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    lifeline: Option<ChildStdin>,
    crashes: std::collections::VecDeque<std::time::Instant>,
}

impl Inner {
    fn crashed(&mut self, now: std::time::Instant) -> u32 {
        self.crashes
            .retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        self.crashes.push_back(now);
        u32::try_from(self.crashes.len()).unwrap_or(u32::MAX)
    }
}

pub struct Sidecar {
    config: SidecarConfig,
    status: watch::Sender<SidecarStatus>,
    inner: Mutex<Inner>,
    stopping: AtomicBool,
    generation: AtomicU64,
}

impl Sidecar {
    pub fn start(config: SidecarConfig) -> Arc<Self> {
        let sidecar = Arc::new(Self {
            config,
            status: watch::channel(SidecarStatus::Starting).0,
            inner: Mutex::new(Inner::default()),
            stopping: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        });
        sidecar.spawn();
        sidecar
    }

    pub fn failed(config: SidecarConfig, reason: String) -> Arc<Self> {
        Arc::new(Self {
            config,
            status: watch::channel(SidecarStatus::Failed(reason)).0,
            inner: Mutex::new(Inner::default()),
            stopping: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        })
    }

    pub fn status(&self) -> SidecarStatus {
        self.status.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<SidecarStatus> {
        self.status.subscribe()
    }

    pub async fn connection(&self, timeout: Duration) -> Result<RuntimeConnection, String> {
        let mut rx = self.status.subscribe();
        let settled = tokio::time::timeout(
            timeout,
            rx.wait_for(|s| !matches!(s, SidecarStatus::Starting)),
        )
        .await;
        match settled {
            Err(_) => Err(format!(
                "tessera-runtime is still starting after {}s",
                timeout.as_secs()
            )),
            Ok(Err(_)) => Err("sidecar supervisor stopped".into()),
            Ok(Ok(status)) => match &*status {
                SidecarStatus::Ready(c) => Ok(c.clone()),
                SidecarStatus::Failed(reason) => Err(reason.clone()),
                SidecarStatus::Stopped => Err("tessera-runtime was stopped".into()),
                SidecarStatus::Starting => unreachable!("wait_for excludes Starting"),
            },
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn spawn(self: &Arc<Self>) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.status.send_replace(SidecarStatus::Starting);
        let mut command = Command::new(&self.config.program);
        command
            .args(&self.config.args)
            .envs(self.config.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        without_console_window(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                self.status.send_replace(SidecarStatus::Failed(format!(
                    "could not start {}: {err}",
                    self.config.program.display()
                )));
                return;
            }
        };
        let stdout = child.stdout.take();
        {
            let mut inner = self.lock();
            if self.stopping.load(Ordering::SeqCst) {
                drop(inner);
                let _ = child.kill();
                let _ = child.wait();
                self.status.send_replace(SidecarStatus::Stopped);
                return;
            }
            inner.lifeline = child.stdin.take();
            inner.child = Some(child);
        }

        if let Some(stdout) = stdout {
            let me = Arc::clone(self);
            thread::Builder::new()
                .name("tessera-runtime-stdout".into())
                .spawn(move || {
                    for line in BufReader::new(stdout).lines() {
                        let Ok(line) = line else { break };
                        if me.generation.load(Ordering::SeqCst) != generation {
                            break;
                        }
                        if let Some(conn) = parse_ready_line(&line) {
                            me.status.send_replace(SidecarStatus::Ready(conn));
                        }
                    }
                })
                .ok();
        }

        {
            let me = Arc::clone(self);
            let timeout = self.config.ready_timeout;
            thread::Builder::new()
                .name("tessera-runtime-ready".into())
                .spawn(move || {
                    thread::sleep(timeout);
                    if me.generation.load(Ordering::SeqCst) == generation
                        && me.status() == SidecarStatus::Starting
                    {
                        me.status.send_replace(SidecarStatus::Failed(format!(
                            "tessera-runtime printed no ready line within {}s",
                            timeout.as_secs()
                        )));
                        me.kill_child();
                    }
                })
                .ok();
        }

        // `Child::wait` blocks while it borrows the `Child`, so polling leaves it free for `stop` to kill.
        let me = Arc::clone(self);
        thread::Builder::new()
            .name("tessera-runtime-wait".into())
            .spawn(move || me.watch_exit(generation))
            .ok();
    }

    fn watch_exit(self: Arc<Self>, generation: u64) {
        loop {
            thread::sleep(Duration::from_millis(200));
            if self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let exited = {
                let mut inner = self.lock();
                match inner.child.as_mut().map(Child::try_wait) {
                    Some(Ok(Some(status))) => {
                        inner.child = None;
                        inner.lifeline = None;
                        Some((status.to_string(), status.code()))
                    }
                    Some(Ok(None)) => None,
                    Some(Err(err)) => Some((err.to_string(), None)),
                    None => return,
                }
            };
            let Some((how, code)) = exited else { continue };
            if self.stopping.load(Ordering::SeqCst) {
                self.status.send_replace(SidecarStatus::Stopped);
                return;
            }
            if code == Some(EXIT_DATA_DIR_LOCKED) {
                self.status.send_replace(SidecarStatus::Failed(format!(
                    "tessera-runtime exited ({how}): its data directory is in use by another \
                     tessera-runtime (the shell's log names its PID); stop it or set TESSERA_DATA_DIR"
                )));
                return;
            }
            let restarts = self.lock().crashed(std::time::Instant::now());
            if restarts > self.config.max_restarts {
                self.status.send_replace(SidecarStatus::Failed(format!(
                    "tessera-runtime exited ({how}); gave up after {} restarts in {} minutes",
                    self.config.max_restarts,
                    RESTART_WINDOW.as_secs() / 60
                )));
                return;
            }
            eprintln!("[tessera-desktop] tessera-runtime exited ({how}); restart {restarts}");
            self.status.send_replace(SidecarStatus::Starting);
            thread::sleep(Duration::from_millis(500 * 2u64.pow(restarts.min(5) - 1)));
            if self.stopping.load(Ordering::SeqCst) {
                self.status.send_replace(SidecarStatus::Stopped);
                return;
            }
            self.spawn();
            return;
        }
    }

    fn kill_child(&self) {
        let mut inner = self.lock();
        inner.lifeline = None;
        if let Some(child) = inner.child.as_mut() {
            let _ = child.kill();
        }
    }

    pub fn stop_updated(&self, grace: Duration) {
        if let Some(lifeline) = self.lock().lifeline.as_mut() {
            let _ = writeln!(lifeline, "{UPDATED_LINE}").and_then(|()| lifeline.flush());
        }
        self.stop(grace);
    }

    pub fn stop(&self, grace: Duration) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut child = {
            let mut inner = self.lock();
            inner.lifeline = None;
            inner.child.take()
        };
        if let Some(child) = child.as_mut() {
            let deadline = std::time::Instant::now() + grace;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(25))
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        self.status.send_replace(SidecarStatus::Stopped);
    }
}

/// Tauri copies each `externalBin` sidecar next to the shell executable.
pub fn resolve_runtime() -> Result<(PathBuf, Vec<String>), String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let exe_name = format!("tessera-runtime{ext}");
    let program = if let Some(p) = std::env::var_os("TESSERA_RUNTIME_BIN") {
        PathBuf::from(p)
    } else {
        let bundled = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.join(&exe_name)));
        let dev = cfg!(debug_assertions).then(|| {
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
            dev_runtime_path(
                std::env::var_os("CARGO_TARGET_DIR").as_deref(),
                &repo,
                &exe_name,
            )
        });
        match [bundled, dev.clone()]
            .into_iter()
            .flatten()
            .find(|p| p.is_file())
        {
            Some(p) => p,
            None => {
                let looked = dev
                    .map(|d| format!(" (looked next to the shell and at {})", d.display()))
                    .unwrap_or_default();
                return Err(format!(
                    "tessera-runtime not found{looked}: build it (cargo build -p tessera-runtime) or set TESSERA_RUNTIME_BIN"
                ));
            }
        }
    };
    eprintln!("[tessera-desktop] runtime {}", program.display());
    let args = vec!["serve".to_string(), "--port".to_string(), "0".to_string()];
    Ok((program, args))
}

pub fn dev_runtime_path(target_dir: Option<&OsStr>, repo: &Path, exe: &str) -> PathBuf {
    let target = match target_dir.filter(|d| !d.is_empty()) {
        Some(d) => repo.join(d),
        None => repo.join("target"),
    };
    target.join("debug").join(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> SidecarConfig {
        SidecarConfig {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            ready_timeout: Duration::from_secs(5),
            max_restarts: 0,
            env: vec![],
        }
    }

    #[test]
    fn the_debug_fallback_follows_cargo_target_dir() {
        let repo = Path::new("/work/tessera");
        assert_eq!(
            dev_runtime_path(None, repo, "tessera-runtime"),
            PathBuf::from("/work/tessera/target/debug/tessera-runtime")
        );
        assert_eq!(
            dev_runtime_path(Some(OsStr::new("")), repo, "tessera-runtime"),
            PathBuf::from("/work/tessera/target/debug/tessera-runtime")
        );
        assert_eq!(
            dev_runtime_path(
                Some(OsStr::new("/tmp/tessera-target")),
                repo,
                "tessera-runtime"
            ),
            PathBuf::from("/tmp/tessera-target/debug/tessera-runtime")
        );
        assert_eq!(
            dev_runtime_path(Some(OsStr::new("build")), repo, "tessera-runtime"),
            PathBuf::from("/work/tessera/build/debug/tessera-runtime")
        );
    }

    #[test]
    fn knows_the_runtimes_data_dir_locked_exit_code() {
        let lock = include_str!("../../../../crates/tessera-runtime/src/lock.rs");
        let declared = format!("pub const EXIT_DATA_DIR_LOCKED: u8 = {EXIT_DATA_DIR_LOCKED};");
        assert!(
            lock.contains(&declared),
            "lock.rs no longer declares {declared}"
        );
    }

    #[test]
    fn parses_only_ready_lines() {
        let c =
            parse_ready_line(r#"{"event":"ready","port":7417,"token":"abc","version":"0.1.0"}"#)
                .unwrap();
        assert_eq!(
            c,
            RuntimeConnection {
                port: 7417,
                token: "abc".into()
            }
        );
        assert!(parse_ready_line("listening…").is_none());
        assert!(parse_ready_line(r#"{"event":"log","port":1,"token":"x"}"#).is_none());
        assert!(parse_ready_line(r#"{"event":"ready","port":0,"token":"x"}"#).is_none());
        assert!(parse_ready_line(r#"{"event":"ready","port":5,"token":""}"#).is_none());
        assert_eq!(
            format!("{:?}", SidecarStatus::Ready(c)),
            r#"Ready(RuntimeConnection { port: 7417, token: "[redacted]" })"#
        );
    }

    #[tokio::test]
    async fn reads_the_ready_line_and_ties_lifetime_to_stdin() {
        let sidecar = Sidecar::start(sh(
            r#"echo booting; echo '{"event":"ready","port":4242,"token":"t0k","version":"x"}'; cat >/dev/null; echo bye >&2"#,
        ));
        let conn = sidecar.connection(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            conn,
            RuntimeConnection {
                port: 4242,
                token: "t0k".into()
            }
        );
        let (stopped, back) = std::sync::mpsc::channel();
        thread::spawn(move || {
            sidecar.stop(Duration::from_secs(3_600));
            stopped.send(sidecar).ok();
        });
        let sidecar = back
            .recv_timeout(Duration::from_secs(60))
            .expect("the runtime ends with its stdin, long before the stop's grace runs out");
        assert_eq!(sidecar.status(), SidecarStatus::Stopped);
    }

    #[tokio::test]
    async fn after_an_update_the_runtime_hears_it_before_stdin_closes() {
        let heard =
            std::env::temp_dir().join(format!("tessera-sidecar-heard-{}", std::process::id()));
        let sidecar = Sidecar::start(sh(&format!(
            r#"echo '{{"event":"ready","port":4242,"token":"t0k","version":"x"}}'; cat > '{}'"#,
            heard.display()
        )));
        sidecar.connection(Duration::from_secs(5)).await.unwrap();
        sidecar.stop_updated(Duration::from_secs(5));
        assert_eq!(sidecar.status(), SidecarStatus::Stopped);
        let said = std::fs::read_to_string(&heard).unwrap();
        let _ = std::fs::remove_file(&heard);
        assert_eq!(said, format!("{UPDATED_LINE}\n"));
    }

    #[tokio::test]
    async fn reports_a_missing_program() {
        let sidecar = Sidecar::start(SidecarConfig {
            program: PathBuf::from("/nonexistent/tessera-runtime"),
            args: vec![],
            ready_timeout: Duration::from_secs(1),
            max_restarts: 0,
            env: vec![],
        });
        let err = sidecar
            .connection(Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(err.contains("could not start"), "{err}");
    }

    #[tokio::test]
    async fn a_locked_data_directory_fails_without_restarting() {
        let mut config = sh("echo 'data directory in use' >&2; exit 3");
        config.max_restarts = 3;
        let sidecar = Sidecar::start(config);
        let err = sidecar
            .connection(Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(err.contains("in use by another"), "{err}");
        assert!(sidecar.lock().crashes.is_empty(), "no restart");
    }

    #[tokio::test]
    async fn reports_an_exit_before_ready() {
        let sidecar = Sidecar::start(sh("exit 4"));
        let err = sidecar
            .connection(Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(err.contains("exited"), "{err}");
    }

    #[tokio::test]
    async fn times_out_without_a_ready_line() {
        let mut config = sh("sleep 30");
        config.ready_timeout = Duration::from_millis(300);
        let sidecar = Sidecar::start(config);
        let err = sidecar
            .connection(Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(err.contains("no ready line"), "{err}");
    }

    #[tokio::test]
    async fn restarts_after_an_unexpected_exit() {
        let dir = std::env::temp_dir().join(format!("tessera-sidecar-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("ran-once");
        let script = format!(
            r#"if [ -f '{m}' ]; then echo '{{"event":"ready","port":2,"token":"second"}}'; cat >/dev/null; else touch '{m}'; echo '{{"event":"ready","port":1,"token":"first"}}'; exit 0; fi"#,
            m = marker.display()
        );
        let mut config = sh(&script);
        config.max_restarts = 2;
        let sidecar = Sidecar::start(config);
        let mut rx = sidecar.subscribe();
        // `wait_for` returns a read guard on the channel: drop it (`is_ok`) before anything sends.
        let restarted = tokio::time::timeout(
            Duration::from_secs(10),
            rx.wait_for(|s| matches!(s, SidecarStatus::Ready(c) if c.token == "second")),
        )
        .await
        .is_ok();
        assert!(
            restarted,
            "runtime was not restarted: {:?}",
            sidecar.status()
        );
        sidecar.stop(Duration::from_secs(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_runtime_that_crashes_each_time_after_it_starts_is_given_up_on() {
        let mut config = sh(r#"echo '{"event":"ready","port":3,"token":"brief"}'; exit 1"#);
        config.max_restarts = 2;
        let sidecar = Sidecar::start(config);
        let mut rx = sidecar.subscribe();
        let gave_up = tokio::time::timeout(
            Duration::from_secs(15),
            rx.wait_for(|s| matches!(s, SidecarStatus::Failed(_))),
        )
        .await
        .is_ok();
        assert!(gave_up, "restarted forever: {:?}", sidecar.status());
        assert_eq!(sidecar.lock().crashes.len(), 3);
        sidecar.stop(Duration::from_secs(1));
    }

    #[tokio::test]
    async fn a_stop_while_a_restart_waits_leaves_no_runtime_running() {
        let mut config = sh("exit 1");
        config.max_restarts = 5;
        let sidecar = Sidecar::start(config);
        let mut rx = sidecar.subscribe();
        tokio::time::timeout(
            Duration::from_secs(5),
            rx.wait_for(|_| !sidecar.lock().crashes.is_empty()),
        )
        .await
        .unwrap()
        .unwrap();
        sidecar.stop(Duration::from_secs(1));
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(sidecar.status(), SidecarStatus::Stopped);
        assert!(
            sidecar.lock().child.is_none(),
            "no runtime was started after the stop"
        );
    }
}
