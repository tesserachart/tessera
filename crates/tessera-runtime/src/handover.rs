use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

use crate::secrets::{Adopter, HandOver, NotKept, Secrets};

pub const UPDATED_LINE: &str = r#"{"event":"updated"}"#;

pub const ADOPT_COMMAND: &str = "adopt-secrets";

pub const ADOPT_DEADLINE: Duration = Duration::from_secs(10);

pub const KEEP_DEADLINE: Duration = Duration::from_secs(4);

#[derive(Deserialize)]
struct Offer {
    key: String,
    value: String,
}

#[derive(Serialize, Deserialize)]
struct Ack {
    key: String,
    kept: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    why: Option<String>,
}

pub async fn adopt(
    secrets: &Secrets,
    input: impl AsyncBufRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
) -> std::io::Result<()> {
    let mut lines = input.lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let ack = match serde_json::from_str::<Offer>(&line) {
            Ok(o) => match secrets.adopt(&o.key, &o.value).await {
                Ok(()) => Ack {
                    key: o.key,
                    kept: true,
                    why: None,
                },
                Err(e) => Ack {
                    key: o.key,
                    kept: false,
                    why: Some(e.to_string()),
                },
            },
            Err(_) => Ack {
                key: String::new(),
                kept: false,
                why: Some("not a secret handed over".into()),
            },
        };
        let mut reply = serde_json::to_string(&ack)?;
        reply.push('\n');
        output.write_all(reply.as_bytes()).await?;
        output.flush().await?;
    }
    Ok(())
}

pub struct Child {
    process: tokio::process::Child,
    stdin: Option<ChildStdin>,
    acks: Lines<BufReader<ChildStdout>>,
}

impl std::fmt::Debug for Child {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Child")
            .field("pid", &self.process.id())
            .finish_non_exhaustive()
    }
}

impl Child {
    pub fn spawn(mut program: Command) -> std::io::Result<Self> {
        let mut process = program
            .arg(ADOPT_COMMAND)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let missing = || std::io::Error::other("the new build's pipes are missing");
        let stdin = process.stdin.take().ok_or_else(missing)?;
        let stdout = process.stdout.take().ok_or_else(missing)?;
        Ok(Self {
            process,
            stdin: Some(stdin),
            acks: BufReader::new(stdout).lines(),
        })
    }

    pub async fn finish(mut self) {
        self.stdin = None;
        if tokio::time::timeout(ADOPT_DEADLINE, self.process.wait())
            .await
            .is_err()
        {
            let _ = self.process.kill().await;
        }
    }

    async fn offer(&mut self, key: &str, value: &str) -> Result<Ack, String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or("the new build is no longer listening")?;
        let mut line = serde_json::json!({ "key": key, "value": value }).to_string();
        line.push('\n');
        let sent = stdin.write_all(line.as_bytes()).await;
        sent.and(stdin.flush().await)
            .map_err(|e| format!("the new build stopped listening ({})", e.kind()))?;
        let reply = tokio::time::timeout(ADOPT_DEADLINE, self.acks.next_line())
            .await
            .map_err(|_| "the new build did not answer in time".to_owned())?
            .map_err(|e| format!("the new build's answer cannot be read ({})", e.kind()))?
            .ok_or("the new build stopped")?;
        serde_json::from_str(&reply).map_err(|_| "the new build's answer is unreadable".to_owned())
    }
}

#[async_trait::async_trait]
impl Adopter for Child {
    async fn adopt(&mut self, key: &str, value: &str) -> Result<(), NotKept> {
        let ack = match self.offer(key, value).await {
            Ok(a) if a.key == key => a,
            Ok(_) => {
                self.stdin = None;
                return Err(NotKept::Gone(
                    "the new build answered for another secret".into(),
                ));
            }
            Err(why) => {
                self.stdin = None;
                return Err(NotKept::Gone(why));
            }
        };
        if ack.kept {
            Ok(())
        } else {
            Err(NotKept::Refused(
                ack.why
                    .unwrap_or_else(|| "the new build did not keep it".into()),
            ))
        }
    }
}

pub async fn after_update(secrets: &Secrets, program: &Path) -> HandOver {
    if !secrets.bound_to_binary() {
        return HandOver::default();
    }
    let mut child = match Child::spawn(Command::new(program)) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "the update cannot take the saved logins over: it will ask for each once");
            return HandOver::default();
        }
    };
    let out = secrets.hand_over(&mut child).await;
    child.finish().await;
    tracing::info!(
        handed = out.handed.len(),
        left = out.left.len(),
        "the saved logins are handed over to the update"
    );
    out
}
