use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;

const GH_TIMEOUT: Duration = Duration::from_secs(60);

#[async_trait]
pub trait IssueFiler: Send + Sync + 'static {
    async fn file(&self, repo: &str, title: &str, body: &str) -> Result<String, String>;
}

pub fn check_repo(repo: &str) -> Result<(), String> {
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    match repo.split_once('/') {
        Some((owner, name)) if ok(owner) && ok(name) => Ok(()),
        _ => Err(format!("{repo} is not a repository as owner/name")),
    }
}

#[derive(Debug, Default)]
pub struct GhCli;

#[derive(Deserialize)]
struct Listed {
    number: u64,
    title: String,
    url: String,
}

async fn gh(args: &[&str]) -> Result<String, String> {
    let bin = std::env::var("TESSERA_GH_BIN")
        .ok()
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "gh".into());
    let run = Command::new(&bin).args(args).kill_on_drop(true).output();
    let out = tokio::time::timeout(GH_TIMEOUT, run)
        .await
        .map_err(|_| "gh did not answer within a minute".to_owned())?
        .map_err(|e| {
            format!("gh could not run ({e}): install the GitHub CLI and sign in with gh auth login")
        })?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(if why.is_empty() {
            format!("gh ended with {}", out.status)
        } else {
            why
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[async_trait]
impl IssueFiler for GhCli {
    async fn file(&self, repo: &str, title: &str, body: &str) -> Result<String, String> {
        check_repo(repo)?;
        let search = format!("\"{}\" in:title", title.replace('"', ""));
        let listed = gh(&[
            "issue",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--search",
            &search,
            "--json",
            "number,title,url",
            "--limit",
            "30",
        ])
        .await?;
        let open: Vec<Listed> = serde_json::from_str(&listed).unwrap_or_default();
        if let Some(same) = open.iter().find(|i| i.title == title) {
            gh(&[
                "issue",
                "comment",
                &same.number.to_string(),
                "--repo",
                repo,
                "--body",
                body,
            ])
            .await?;
            return Ok(same.url.clone());
        }
        let made = gh(&[
            "issue", "create", "--repo", repo, "--title", title, "--body", body,
        ])
        .await?;
        made.lines()
            .rev()
            .find(|l| l.starts_with("https://"))
            .map(str::to_owned)
            .ok_or_else(|| format!("gh did not say where the issue is: {made}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repository_is_owner_slash_name() {
        assert!(check_repo("tesserachart/tessera").is_ok());
        assert!(check_repo("me/my.repo_2-x").is_ok());
        for bad in ["tessera", "/tessera", "a/b/c", "a/b c", "a/$(x)", ""] {
            assert!(check_repo(bad).is_err(), "{bad}");
        }
    }
}
