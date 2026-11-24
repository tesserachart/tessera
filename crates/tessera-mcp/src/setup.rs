use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tessera_protocol::mcp::{McpClientKind, McpSnippet, McpSnippetFormat};

use crate::json::Json;

pub const SERVER_NAME: &str = "tessera";

pub const TOKEN_ENV: &str = "TESSERA_MCP_TOKEN";

pub const STDIO_COMMAND: &str = "mcp-stdio";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
}

impl Launch {
    pub fn new(exe: &Path, data_dir: Option<&Path>, default_dir: Option<&Path>) -> Self {
        let mut args = vec![STDIO_COMMAND.to_owned()];
        if let Some(dir) = data_dir
            && Some(dir) != default_dir
        {
            args.push("--data-dir".to_owned());
            args.push(dir.display().to_string());
        }
        Self {
            command: exe.display().to_string(),
            args,
        }
    }
}

pub fn server_entry(launch: &Launch, token: &str) -> Json {
    Json::object([
        ("command", Json::str(&launch.command)),
        (
            "args",
            Json::Array(launch.args.iter().map(Json::str).collect()),
        ),
        ("env", Json::object([(TOKEN_ENV, Json::str(token))])),
    ])
}

pub fn mcp_servers_json(launch: &Launch, token: &str) -> String {
    Json::object([(
        "mcpServers",
        Json::object([(SERVER_NAME, server_entry(launch, token))]),
    )])
    .pretty()
}

fn shell_word(s: &str) -> String {
    let safe = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./:=@%+,".contains(c));
    if safe {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

pub fn claude_code_command(launch: &Launch, token: &str) -> String {
    let mut words = vec![
        "claude".to_owned(),
        "mcp".to_owned(),
        "add".to_owned(),
        "--scope".to_owned(),
        "user".to_owned(),
        SERVER_NAME.to_owned(),
        "--env".to_owned(),
        shell_word(&format!("{TOKEN_ENV}={token}")),
        "--".to_owned(),
        shell_word(&launch.command),
    ];
    words.extend(launch.args.iter().map(|a| shell_word(a)));
    words.join(" ")
}

fn toml_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn codex_toml(launch: &Launch, token: &str) -> String {
    let args: Vec<String> = launch.args.iter().map(|a| toml_str(a)).collect();
    format!(
        "[mcp_servers.{SERVER_NAME}]\ncommand = {}\nargs = [{}]\nenv = {{ {TOKEN_ENV} = {} }}\n",
        toml_str(&launch.command),
        args.join(", "),
        toml_str(token),
    )
}

pub fn claude_desktop_config_shown() -> &'static str {
    if cfg!(target_os = "macos") {
        "~/Library/Application Support/Claude/claude_desktop_config.json"
    } else if cfg!(windows) {
        r"%APPDATA%\Claude\claude_desktop_config.json"
    } else {
        "~/.config/Claude/claude_desktop_config.json"
    }
}

pub fn claude_desktop_config_path() -> Option<PathBuf> {
    const FILE: &str = "claude_desktop_config.json";
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return home.map(|h| h.join("Library/Application Support/Claude").join(FILE));
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Claude").join(FILE));
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(|h| h.join(".config")))
        .map(|c| c.join("Claude").join(FILE))
}

pub fn snippets(kind: McpClientKind, launch: &Launch, token: &str) -> Vec<McpSnippet> {
    let json = |label: &str, file: Option<&str>| McpSnippet {
        label: label.to_owned(),
        file: file.map(str::to_owned),
        format: McpSnippetFormat::Json,
        text: mcp_servers_json(launch, token),
    };
    match kind {
        McpClientKind::ClaudeDesktop => vec![json(
            "Add to Claude Desktop’s config, then restart Claude Desktop",
            Some(claude_desktop_config_shown()),
        )],
        McpClientKind::Cursor => vec![json(
            "Add to Cursor’s MCP config",
            Some(if cfg!(windows) {
                r"%USERPROFILE%\.cursor\mcp.json"
            } else {
                "~/.cursor/mcp.json"
            }),
        )],
        McpClientKind::ClaudeCode => vec![McpSnippet {
            label: "Run in a terminal".to_owned(),
            file: None,
            format: McpSnippetFormat::Shell,
            text: claude_code_command(launch, token),
        }],
        McpClientKind::Codex => vec![McpSnippet {
            label: "Add to Codex’s config".to_owned(),
            file: Some(
                if cfg!(windows) {
                    r"%USERPROFILE%\.codex\config.toml"
                } else {
                    "~/.codex/config.toml"
                }
                .to_owned(),
            ),
            format: McpSnippetFormat::Toml,
            text: codex_toml(launch, token),
        }],
        McpClientKind::Other => vec![json("Add to your client’s MCP config", None)],
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SetupError {
    #[error(
        "Claude Desktop isn’t set up on this computer ({0} is missing). Open Claude Desktop once, then try again."
    )]
    NoClaudeDesktop(String),
    #[error(
        "{0} isn’t valid JSON, so Tessera left it alone. Fix it, or add the setup by hand: {1}"
    )]
    NotJson(String, String),
    #[error("{0} isn’t laid out as Claude Desktop expects, so Tessera left it alone: {1}")]
    Unexpected(String, &'static str),
    #[error("{0}: {1}")]
    Io(String, io::Error),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Merged {
    pub path: PathBuf,
    pub backup: Option<PathBuf>,
}

pub fn merge_claude_desktop(
    path: &Path,
    launch: &Launch,
    token: &str,
    stamp: &str,
) -> Result<Merged, SetupError> {
    let shown = path.display().to_string();
    let dir = path
        .parent()
        .filter(|d| d.is_dir())
        .ok_or_else(|| {
            SetupError::NoClaudeDesktop(
                path.parent()
                    .map_or_else(|| shown.clone(), |d| d.display().to_string()),
            )
        })?
        .to_path_buf();
    let earlier = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(SetupError::Io(shown, e)),
    };
    let mut root = match earlier.as_deref() {
        Some(text) if !text.trim().is_empty() => serde_json::from_str::<Json>(text)
            .map_err(|e| SetupError::NotJson(shown.clone(), e.to_string()))?,
        _ => Json::Object(Vec::new()),
    };
    let Json::Object(fields) = &mut root else {
        return Err(SetupError::Unexpected(shown, "it is not a JSON object"));
    };
    let servers = Json::entry(fields, "mcpServers", Json::Object(Vec::new()));
    if matches!(servers, Json::Null) {
        *servers = Json::Object(Vec::new());
    }
    let Json::Object(servers) = servers else {
        return Err(SetupError::Unexpected(
            shown,
            "its mcpServers is not an object",
        ));
    };
    Json::set(servers, SERVER_NAME, server_entry(launch, token));

    let backup = match &earlier {
        Some(_) => {
            let copy = (0..100)
                .map(|n| {
                    dir.join(if n == 0 {
                        format!("claude_desktop_config.backup-{stamp}.json")
                    } else {
                        format!("claude_desktop_config.backup-{stamp}-{n}.json")
                    })
                })
                .find(|p| !p.exists())
                .ok_or_else(|| {
                    SetupError::Io(
                        shown.clone(),
                        io::Error::new(
                            io::ErrorKind::AlreadyExists,
                            "too many backups this second",
                        ),
                    )
                })?;
            std::fs::copy(path, &copy)
                .map_err(|e| SetupError::Io(copy.display().to_string(), e))?;
            Some(copy)
        }
        None => None,
    };

    let tmp = dir.join(".claude_desktop_config.json.tessera-tmp");
    let write = || -> io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        tessera_core::private::owner_only(&mut options);
        let mut f = options.open(&tmp)?;
        f.write_all(root.pretty().as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        drop(f);
        tessera_core::private::restrict(&tmp)?;
        std::fs::rename(&tmp, path)
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(SetupError::Io(shown, e));
    }
    Ok(Merged {
        path: path.to_path_buf(),
        backup,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "tsk_0000000000000000000000000000000000000000000000000000000000000000";

    fn launch() -> Launch {
        Launch::new(
            Path::new("/Applications/Tessera.app/Contents/MacOS/tessera-runtime"),
            None,
            None,
        )
    }

    #[test]
    fn the_shim_is_told_the_data_directory_only_when_it_is_not_the_default() {
        let exe = Path::new("/opt/tessera/tessera-runtime");
        let default = Path::new("/home/me/.local/share/tessera");
        assert_eq!(
            Launch::new(exe, Some(default), Some(default)).args,
            ["mcp-stdio"]
        );
        let dev = Path::new("/home/me/.local/share/tessera-dev/x");
        assert_eq!(
            Launch::new(exe, Some(dev), Some(default)).args,
            [
                "mcp-stdio",
                "--data-dir",
                "/home/me/.local/share/tessera-dev/x"
            ]
        );
    }

    #[test]
    fn json_setup_is_the_mcp_servers_entry_in_order() {
        let text = mcp_servers_json(&launch(), TOKEN);
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"mcpServers": {"tessera": {
                "command": "/Applications/Tessera.app/Contents/MacOS/tessera-runtime",
                "args": ["mcp-stdio"],
                "env": {"TESSERA_MCP_TOKEN": TOKEN},
            }}})
        );
        let command = text.find("\"command\"").unwrap();
        assert!(command < text.find("\"args\"").unwrap());
        assert!(text.find("\"args\"").unwrap() < text.find("\"env\"").unwrap());
    }

    #[test]
    fn claude_code_gets_one_command_quoted_for_the_shell() {
        assert_eq!(
            claude_code_command(&launch(), TOKEN),
            format!(
                "claude mcp add --scope user tessera --env TESSERA_MCP_TOKEN={TOKEN} -- \
                 /Applications/Tessera.app/Contents/MacOS/tessera-runtime mcp-stdio"
            )
        );
        let spaced = Launch::new(
            Path::new("/Users/me/My Apps/Tessera.app/Contents/MacOS/tessera-runtime"),
            Some(Path::new("/tmp/it's")),
            None,
        );
        assert!(
            claude_code_command(&spaced, TOKEN).ends_with(
                "-- '/Users/me/My Apps/Tessera.app/Contents/MacOS/tessera-runtime' mcp-stdio --data-dir '/tmp/it'\\''s'"
            ),
            "{}",
            claude_code_command(&spaced, TOKEN)
        );
    }

    #[test]
    fn codex_gets_its_toml_block() {
        assert_eq!(
            codex_toml(&launch(), TOKEN),
            format!(
                "[mcp_servers.tessera]\ncommand = \"/Applications/Tessera.app/Contents/MacOS/tessera-runtime\"\n\
                 args = [\"mcp-stdio\"]\nenv = {{ TESSERA_MCP_TOKEN = \"{TOKEN}\" }}\n"
            )
        );
        let odd = Launch::new(Path::new("C:\\Tessera\\tessera \"rt\".exe"), None, None);
        assert!(codex_toml(&odd, TOKEN).contains(r#"command = "C:\\Tessera\\tessera \"rt\".exe""#));
    }

    #[test]
    fn each_kind_gets_its_own_setup_with_the_token() {
        for kind in McpClientKind::ALL {
            let s = snippets(kind, &launch(), TOKEN);
            assert_eq!(s.len(), 1, "{kind:?}");
            assert!(s[0].text.contains(TOKEN), "{kind:?}");
            let format = match kind {
                McpClientKind::ClaudeCode => McpSnippetFormat::Shell,
                McpClientKind::Codex => McpSnippetFormat::Toml,
                _ => McpSnippetFormat::Json,
            };
            assert_eq!(s[0].format, format, "{kind:?}");
        }
        assert_eq!(
            snippets(McpClientKind::ClaudeDesktop, &launch(), TOKEN)[0]
                .file
                .as_deref(),
            Some(claude_desktop_config_shown())
        );
    }

    #[test]
    fn claude_desktop_keeps_everything_else_and_a_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("claude_desktop_config.json");
        let before = r#"{
  "globalShortcut": "Ctrl+Space",
  "mcpServers": {
    "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]},
    "tessera": {"command": "old", "args": [], "env": {"TESSERA_MCP_TOKEN": "tsk_old"}}
  },
  "zebra": [1, 2.5, null]
}"#;
        std::fs::write(&path, before).unwrap();
        let merged = merge_claude_desktop(&path, &launch(), TOKEN, "20261011-120000").unwrap();
        let backup = merged.backup.clone().expect("a backup");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), before);
        assert!(backup.ends_with("claude_desktop_config.backup-20261011-120000.json"));

        let after = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["globalShortcut"], "Ctrl+Space");
        assert_eq!(v["zebra"], serde_json::json!([1, 2.5, null]));
        assert_eq!(v["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(
            v["mcpServers"]["tessera"]["env"]["TESSERA_MCP_TOKEN"],
            TOKEN
        );
        assert_eq!(
            v["mcpServers"]["tessera"]["args"],
            serde_json::json!(["mcp-stdio"])
        );
        assert!(after.find("globalShortcut").unwrap() < after.find("mcpServers").unwrap());
        assert!(after.find("filesystem").unwrap() < after.find("\"tessera\"").unwrap());
        assert!(after.find("mcpServers").unwrap() < after.find("zebra").unwrap());
        assert!(tessera_core::private::is_private(&path), "it holds a token");

        let again = merge_claude_desktop(&path, &launch(), TOKEN, "20261011-120000").unwrap();
        assert!(
            again
                .backup
                .unwrap()
                .ends_with("claude_desktop_config.backup-20261011-120000-1.json")
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), before);
    }

    #[test]
    fn claude_desktop_without_a_file_gets_one_and_no_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("claude_desktop_config.json");
        let merged = merge_claude_desktop(&path, &launch(), TOKEN, "s").unwrap();
        assert_eq!(merged.backup, None);
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["tessera"]["command"], launch().command);
    }

    #[test]
    fn a_file_claude_desktop_could_not_read_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("claude_desktop_config.json");
        for bad in ["{ not json", "[1, 2]", r#"{"mcpServers": []}"#] {
            std::fs::write(&path, bad).unwrap();
            let err = merge_claude_desktop(&path, &launch(), TOKEN, "s").unwrap_err();
            assert!(
                matches!(err, SetupError::NotJson(..) | SetupError::Unexpected(..)),
                "{bad}: {err}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bad);
        }
        let entries = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(entries, 1, "no backup, no temporary file");
        let missing = tmp.path().join("Claude/claude_desktop_config.json");
        assert!(matches!(
            merge_claude_desktop(&missing, &launch(), TOKEN, "s"),
            Err(SetupError::NoClaudeDesktop(_))
        ));
    }
}
