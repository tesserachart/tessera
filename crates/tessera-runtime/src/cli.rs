use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use clap::builder::FalseyValueParser;
use clap::{Args, Parser, Subcommand};
use tessera_broker::paper::{AccountSeed, default_seeds};
use tessera_core::{SharedClock, SystemClock};
use tessera_intel::source::http::HttpClient;

use crate::build_source::{self, EXIT_OTHER_CHECKOUT, EXPECT_CHECKOUT_ENV};
use crate::connectors::{NO_RITHMIC_ENV, NoRithmic, RithmicFactory};
use crate::from_install_dir::{DATA_DIR, MoveError, Moved, move_out_of_install_dir};
use crate::from_nightly::{NIGHTLY_KEYRING_SERVICE, copy_nightly_data, nightly_data_dir};
use crate::handover::UPDATED_LINE;
use crate::lock::{DataDirLock, EXIT_DATA_DIR_LOCKED, LockError};
use crate::secrets::{KeyringStore, Secrets};
use crate::{
    ModuleFactory, Runtime, RuntimeConfig, default_data_dir, logging, windows_install_dir,
};

pub struct Launch {
    pub modules: fn() -> Vec<ModuleFactory>,
    pub clock: Option<SharedClock>,
    pub credentials_files: bool,
    pub accounts: bool,
    pub paper_accounts: fn() -> Vec<AccountSeed>,
    pub secrets: fn() -> Secrets,
    pub rithmic: fn(SharedClock) -> Option<Arc<dyn RithmicFactory>>,
    pub level_http: fn() -> Option<Arc<dyn HttpClient>>,
}

impl Default for Launch {
    fn default() -> Self {
        Self {
            modules: Vec::new,
            clock: None,
            credentials_files: true,
            accounts: true,
            paper_accounts: default_seeds,
            secrets: Secrets::system,
            rithmic: |_| None,
            level_http: || None,
        }
    }
}

impl std::fmt::Debug for Launch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Launch")
            .field("clock", &self.clock)
            .field("credentials_files", &self.credentials_files)
            .field("accounts", &self.accounts)
            .finish_non_exhaustive()
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "tessera-runtime",
    version,
    about = "The Tessera runtime process"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Serve the UI protocol on 127.0.0.1.
    Serve(ServeArgs),
    /// MCP over stdio for your own agent: proxies to the running Tessera's /mcp (token in TESSERA_MCP_TOKEN).
    McpStdio(McpStdioArgs),
    /// Print the version and the checkout(s) this binary was built from, as one JSON line.
    BuildInfo,
    /// The trades saved on this machine (the tick store); works with the app open or closed.
    Ticks(TicksArgs),
    /// Keep the saved logins the build before hands over at an update, as this build's own.
    #[command(hide = true)]
    AdoptSecrets,
}

#[derive(Args, Debug)]
struct ServeArgs {
    /// Port on 127.0.0.1 (0 picks a free port).
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// Data directory (default: $XDG_DATA_HOME/tessera, else ~/Library/Application Support/Tessera on macOS,
    /// ~/.local/share/tessera elsewhere).
    #[arg(long, env = "TESSERA_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Serve the built UI from this directory at `/` (SPA fallback to index.html).
    #[arg(long)]
    ui_dir: Option<PathBuf>,
    /// Keep running when stdin closes.
    #[arg(long)]
    detached: bool,
    /// Development launchers: keep one launch ticket for a browser page and print it on stdout after the ready
    /// line, `{"event":"launch","ticket":"…"}`, and each next one as the last is taken (docs/dev.md §6).
    #[arg(long)]
    launch_tickets: bool,
    /// Extra allowed browser Origin (exact match), e.g. the private review URL. Repeatable.
    #[arg(
        long = "review-origin",
        env = "TESSERA_REVIEW_ORIGIN",
        value_delimiter = ','
    )]
    review_origins: Vec<String>,
    /// Development: connect the Rithmic login in this credentials file at start, for this run only
    /// (`RITHMIC_USERNAME`, `RITHMIC_PASSWORD`, `RITHMIC_SYSTEM`, `RITHMIC_GATEWAY` lines).
    #[arg(long, env = "TESSERA_RITHMIC_CREDENTIALS")]
    rithmic_credentials: Option<PathBuf>,
    /// Sign in to no Rithmic login this run: every login (typed, tested, saved or from
    /// --rithmic-credentials) is refused before it reaches Rithmic, so this runtime never ends
    /// another session's market data on the same login. The variable is on unless empty, `0`,
    /// `false`, `no` or `off`.
    #[arg(long, env = NO_RITHMIC_ENV, value_parser = FalseyValueParser::new())]
    no_rithmic: bool,
}

#[derive(Args, Debug)]
struct TicksArgs {
    #[command(subcommand)]
    command: TicksCommand,
}

#[derive(Subcommand, Debug)]
enum TicksCommand {
    /// Write saved prints to CSV, one file per trade date named <ROOT>-<YYYY-MM-DD>.csv with the
    /// header ts_ns,price,size,side (UTC nanoseconds; side 1 buyer aggressed, -1 seller, 0
    /// unknown), and print what was written as one JSON line. Asks no connection anything.
    Export(TicksExportArgs),
}

#[derive(Args, Debug)]
struct TicksExportArgs {
    /// Data directory (default: serve's).
    #[arg(long, env = "TESSERA_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// A dated contract (NQZ6, NQZ6.CME) or a futures root (NQ): a root writes each day from the
    /// contract that was the front month that day.
    #[arg(long)]
    instrument: String,
    /// First trade date, YYYY-MM-DD.
    #[arg(long)]
    from: chrono::NaiveDate,
    /// Last trade date, YYYY-MM-DD (inclusive).
    #[arg(long)]
    to: chrono::NaiveDate,
    /// Regular trading hours only (09:30 to 16:00 New York); without it, the whole session.
    #[arg(long)]
    rth: bool,
    /// Only the prints saved from this connection (rithmic-apex, mock).
    #[arg(long)]
    source: Option<String>,
    /// The folder to write into, created when missing; files of the same name are replaced.
    #[arg(long)]
    out: PathBuf,
}

#[derive(Args, Debug)]
struct McpStdioArgs {
    /// Data directory of the runtime to connect to (default: serve's).
    #[arg(long, env = "TESSERA_DATA_DIR")]
    data_dir: Option<PathBuf>,
}

pub fn main(launch: Launch) -> ExitCode {
    logging::install_panic_hook();
    let cli = Cli::parse();
    let built = build_source::build_checkouts(env!("CARGO_MANIFEST_DIR"));
    if let Command::BuildInfo = cli.command {
        let info = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "checkouts": built,
        });
        println!("{info}");
        return ExitCode::SUCCESS;
    }
    if let Some(expected) = std::env::var_os(EXPECT_CHECKOUT_ENV)
        && let Err(e) = build_source::check(std::path::Path::new(&expected), &built)
    {
        eprintln!(
            "{}",
            logging::Redactor::global().redact(&format!("tessera-runtime: {e}"))
        );
        return ExitCode::from(EXIT_OTHER_CHECKOUT);
    }
    match cli.command {
        Command::Serve(args) => serve(args, launch),
        Command::McpStdio(args) => mcp_stdio(args),
        Command::AdoptSecrets => adopt_secrets(),
        Command::Ticks(TicksArgs {
            command: TicksCommand::Export(args),
        }) => ticks_export(args),
        Command::BuildInfo => ExitCode::SUCCESS,
    }
}

fn ticks_export(args: TicksExportArgs) -> ExitCode {
    let Some(data_dir) = args.data_dir.or_else(default_data_dir) else {
        eprintln!(
            "tessera-runtime ticks export: cannot determine a data directory; pass --data-dir"
        );
        return ExitCode::from(2);
    };
    let file = tessera_store::DataDir::new(&data_dir).ticks();
    if !file.is_file() {
        eprintln!(
            "tessera-runtime ticks export: no saved trades in {}",
            data_dir.display()
        );
        return ExitCode::from(2);
    }
    let out = match std::path::absolute(&args.out) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("tessera-runtime ticks export: {}: {e}", args.out.display());
            return ExitCode::from(2);
        }
    };
    let store = match tessera_store::ticks::TickStore::open(&file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("tessera-runtime ticks export: {}: {e}", file.display());
            return ExitCode::FAILURE;
        }
    };
    let input = tessera_market::export::ExportTradesInput {
        instrument: args.instrument,
        from: args.from,
        to: args.to,
        scope: if args.rth {
            tessera_market::pull::Scope::Rth
        } else {
            tessera_market::pull::Scope::Session
        },
        dir: out.display().to_string(),
        source: args.source,
    };
    match tessera_market::export::export_trades(&store, &input) {
        Ok(done) => {
            println!(
                "{}",
                serde_json::to_string(&done).unwrap_or_else(|e| e.to_string())
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("tessera-runtime ticks export: {e}");
            ExitCode::FAILURE
        }
    }
}

fn adopt_secrets() -> ExitCode {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("tessera-runtime adopt-secrets: tokio: {e}");
            return ExitCode::FAILURE;
        }
    };
    let secrets = crate::secrets::Secrets::system()
        .without_fallback()
        .with_deadline(crate::handover::KEEP_DEADLINE);
    match rt.block_on(crate::handover::adopt(
        &secrets,
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    )) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("tessera-runtime adopt-secrets: {}", e.kind());
            ExitCode::FAILURE
        }
    }
}

fn mcp_stdio(args: McpStdioArgs) -> ExitCode {
    let Some(data_dir) = args.data_dir.or_else(default_data_dir) else {
        eprintln!("tessera-runtime mcp-stdio: cannot determine a data directory; pass --data-dir");
        return ExitCode::from(2);
    };
    let token = std::env::var(tessera_mcp::setup::TOKEN_ENV).ok();
    if token.as_deref().is_none_or(|t| t.trim().is_empty()) {
        eprintln!(
            "tessera-runtime mcp-stdio: {} is not set; connect this agent in Tessera (Settings › Analyst)",
            tessera_mcp::setup::TOKEN_ENV
        );
    }
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("tessera-runtime mcp-stdio: tokio: {e}");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(crate::mcp_stdio::run(
        data_dir,
        token,
        tokio::io::stdin(),
        tokio::io::stdout(),
    )) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!(
                "{}",
                logging::Redactor::global().redact(&format!("tessera-runtime mcp-stdio: {e}"))
            );
            ExitCode::FAILURE
        }
    }
}

fn serve(args: ServeArgs, launch: Launch) -> ExitCode {
    let data_dir = match args.data_dir.clone().or_else(default_data_dir) {
        Some(d) => d,
        None => {
            eprintln!("tessera-runtime: cannot determine a data directory; pass --data-dir");
            return ExitCode::from(2);
        }
    };
    if args.data_dir.is_none()
        && let Some(install_dir) = windows_install_dir().filter(|d| data_dir == d.join(DATA_DIR))
    {
        match move_out_of_install_dir(&install_dir) {
            Ok(Moved::Entries(n)) => eprintln!(
                "tessera-runtime: moved {n} data entries from {} into {}",
                install_dir.display(),
                data_dir.display()
            ),
            Ok(Moved::Kept) => eprintln!(
                "tessera-runtime: data in {} was left in place because {} already holds data",
                install_dir.display(),
                data_dir.display()
            ),
            Ok(Moved::Nothing) => {}
            Err(MoveError::Locked(e)) => {
                eprintln!(
                    "{}",
                    logging::Redactor::global().redact(&format!("tessera-runtime: {e}"))
                );
                return ExitCode::from(EXIT_DATA_DIR_LOCKED);
            }
            Err(MoveError::Io(e)) => {
                eprintln!(
                    "{}",
                    logging::Redactor::global().redact(&format!(
                        "tessera-runtime: moving the data from {} into {} failed: {e}; nothing was deleted and the next start finishes the move",
                        install_dir.display(),
                        data_dir.display()
                    ))
                );
                return ExitCode::FAILURE;
            }
        }
    }
    let after_nightly = args.data_dir.is_none() && nightly_data_dir(&data_dir).is_dir();
    if after_nightly {
        match copy_nightly_data(&data_dir) {
            Ok(true) => eprintln!(
                "tessera-runtime: copied Tessera Nightly's data into {}",
                data_dir.display()
            ),
            Ok(false) => {}
            Err(e) => eprintln!("tessera-runtime: Tessera Nightly's data was not copied: {e}"),
        }
    }
    let data_dir_lock = match DataDirLock::acquire(&data_dir) {
        Ok(lock) => Arc::new(lock),
        Err(e) => {
            eprintln!(
                "{}",
                logging::Redactor::global().redact(&format!("tessera-runtime: {e}"))
            );
            return match e {
                LockError::Held { .. } => ExitCode::from(EXIT_DATA_DIR_LOCKED),
                LockError::Io { .. } => ExitCode::FAILURE,
            };
        }
    };
    if let Err(e) = logging::init(&data_dir_lock) {
        eprintln!("tessera-runtime: logging setup failed: {e}");
    }
    let clock: SharedClock = launch.clock.unwrap_or_else(|| Arc::new(SystemClock));
    let files = launch.credentials_files;
    let cloud_url = launch
        .accounts
        .then(tessera_cloud::configured_url)
        .flatten();
    match &cloud_url {
        Some(url) => tracing::info!(cloud = %url, "accounts on"),
        None => tracing::info!("accounts off: no Tessera Cloud address"),
    }
    let secrets = (launch.secrets)();
    let secrets = if after_nightly {
        secrets.carrying_over_keyring(Arc::new(KeyringStore::new(NIGHTLY_KEYRING_SERVICE)))
    } else {
        secrets
    };
    let rithmic = if args.no_rithmic {
        Some(Arc::new(NoRithmic) as Arc<dyn RithmicFactory>)
    } else {
        (launch.rithmic)(Arc::clone(&clock))
    };
    let config = RuntimeConfig {
        port: args.port,
        data_dir: Some(data_dir.clone()),
        data_dir_lock: Some(data_dir_lock),
        ui_dir: args.ui_dir.clone(),
        review_origins: args.review_origins.clone(),
        agents: true,
        clock,
        paper_accounts: (launch.paper_accounts)(),
        secrets: Some(secrets.clone()),
        rithmic_credentials: args.rithmic_credentials.clone().filter(|_| files),
        rithmic,
        level_http: (launch.level_http)(),
        claude_desktop_config: tessera_mcp::setup::claude_desktop_config_path(),
        cloud_url,
        telemetry: crate::telemetry::Project::configured(),
        launch_tickets: args.launch_tickets.then(|| {
            Arc::new(|ticket: &tessera_core::token::Secret| {
                let line = serde_json::json!({"event": "launch", "ticket": ticket.expose()});
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{line}").and_then(|()| out.flush());
            }) as crate::auth::LaunchSink
        }),
        ..RuntimeConfig::default()
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("tessera-runtime: tokio: {e}");
            return ExitCode::FAILURE;
        }
    };
    let detached = args.detached;
    let result = rt.block_on(async move {
        let runtime = Runtime::build(config, (launch.modules)()).await?;
        let shutdown = Shutdown::install(detached)?;
        tracing::info!(
            port = runtime.port(),
            data_dir = %data_dir.display(),
            ui = ?args.ui_dir,
            "tessera runtime ready"
        );
        shutdown.announce_ready(&runtime)?;
        runtime.state().tickets.announce_launch();
        let updated = shutdown.updated();
        runtime
            .run(async move {
                shutdown.wait().await;
                if updated.load(Ordering::SeqCst) {
                    hand_over_to_update(&secrets).await;
                }
            })
            .await
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "runtime failed");
            eprintln!(
                "{}",
                logging::Redactor::global().redact(&format!("tessera-runtime: {e:#}"))
            );
            ExitCode::FAILURE
        }
    }
}

struct Shutdown {
    detached: bool,
    updated: Arc<AtomicBool>,
    signals: Signals,
}

impl Shutdown {
    fn install(detached: bool) -> std::io::Result<Self> {
        Ok(Self {
            detached,
            updated: Arc::default(),
            signals: Signals::install()?,
        })
    }

    fn announce_ready(&self, runtime: &Runtime) -> std::io::Result<()> {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{}", runtime.ready_line())?;
        out.flush()
    }

    fn updated(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.updated)
    }

    async fn wait(self) {
        tokio::select! {
            () = stdin_closed(self.detached, self.updated) => {},
            () = self.signals.recv() => tracing::info!("signal received"),
        }
    }
}

#[cfg(unix)]
struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    fn install() -> std::io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
        })
    }

    async fn recv(mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {},
            _ = self.terminate.recv() => {},
        }
    }
}

#[cfg(windows)]
struct Signals {
    ctrl_c: tokio::signal::windows::CtrlC,
    ctrl_break: tokio::signal::windows::CtrlBreak,
    close: tokio::signal::windows::CtrlClose,
    shutdown: tokio::signal::windows::CtrlShutdown,
}

#[cfg(windows)]
impl Signals {
    fn install() -> std::io::Result<Self> {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_shutdown};
        Ok(Self {
            ctrl_c: ctrl_c()?,
            ctrl_break: ctrl_break()?,
            close: ctrl_close()?,
            shutdown: ctrl_shutdown()?,
        })
    }

    async fn recv(mut self) {
        tokio::select! {
            _ = self.ctrl_c.recv() => {},
            _ = self.ctrl_break.recv() => {},
            _ = self.close.recv() => {},
            _ = self.shutdown.recv() => {},
        }
    }
}

/// Not `spawn_blocking`: a blocking task stuck in `read` would keep the tokio runtime from
/// dropping, so a signal-initiated shutdown would hang while the parent keeps the pipe open.
async fn stdin_closed(detached: bool, updated: Arc<AtomicBool>) {
    if detached {
        std::future::pending::<()>().await;
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let watcher = std::thread::Builder::new()
        .name("stdin-watch".into())
        .spawn(move || {
            watch_stdin(std::io::stdin().lock(), &updated);
            let _ = tx.send(());
        });
    match watcher {
        Ok(_) => {
            let _ = rx.await;
            tracing::info!("stdin closed");
        }
        Err(e) => {
            tracing::warn!(error = %e, "cannot watch stdin; lifetime coupling disabled");
            std::future::pending::<()>().await;
        }
    }
}

async fn hand_over_to_update(secrets: &crate::secrets::Secrets) {
    match std::env::current_exe() {
        Ok(program) => {
            crate::handover::after_update(secrets, &program).await;
        }
        Err(e) => tracing::warn!(error = %e, "the update cannot take the saved logins over"),
    }
}

fn watch_stdin(mut input: impl BufRead, updated: &AtomicBool) {
    let mut line = Vec::new();
    loop {
        line.clear();
        match std::io::Read::take(&mut input, 4096).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if line.trim_ascii() == UPDATED_LINE.as_bytes() {
                    updated.store(true, Ordering::SeqCst);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdin_says_when_an_update_was_installed_and_nothing_else_counts() {
        let heard = |input: &str| {
            let updated = AtomicBool::new(false);
            watch_stdin(input.as_bytes(), &updated);
            updated.load(Ordering::SeqCst)
        };
        assert!(heard("{\"event\":\"updated\"}\n"));
        assert!(heard("noise\r\n  {\"event\":\"updated\"}  \n"));
        assert!(heard("{\"event\":\"updated\"}"));
        assert!(!heard(""));
        assert!(!heard("{\"event\":\"ready\"}\n"));
        assert!(!heard(&format!(
            "{}{{\"event\":\"updated\"}}\n",
            "x".repeat(5000)
        )));
    }
}
