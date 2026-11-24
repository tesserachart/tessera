#[cfg(not(windows))]
pub const ENV_ALLOW: &[&str] = &[
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "SSL_CERT_FILE",
    "USER",
];

/// Windows: a program started without `SystemRoot` cannot load Winsock or the system's crypto
/// providers, and Node's `os.homedir()`, temporary files and the CLIs' settings come from
/// `USERPROFILE`, `TEMP` and `APPDATA`.
#[cfg(windows)]
pub const ENV_ALLOW: &[&str] = &[
    "HOME",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "LANG",
    "TERM",
    "SSL_CERT_FILE",
];

const WITHHELD_PREFIXES: [&str; 2] = ["TESSERA_", "RITHMIC_"];

pub fn withheld(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    WITHHELD_PREFIXES.iter().any(|p| upper.starts_with(p))
}

pub fn child_env(
    extra: &[String],
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for name in ENV_ALLOW
        .iter()
        .map(|k| (*k).to_owned())
        .chain(extra.iter().cloned())
    {
        if withheld(&name) || out.iter().any(|(k, _)| *k == name) {
            continue;
        }
        if let Some(v) = lookup(&name) {
            out.push((name, v));
        }
    }
    out
}

pub fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    tessera_core::private::private_dir(dir)?;
    if let Some(parent) = dir.parent().filter(|p| p.ends_with("agents")) {
        tessera_core::private::restrict(parent)?;
    }
    Ok(())
}

pub fn from_process(extra: &[String]) -> Vec<(String, String)> {
    child_env(extra, |k| std::env::var(k).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent(k: &str) -> Option<String> {
        let vars = [
            ("HOME", "/home/u"),
            ("PATH", "/usr/bin"),
            ("TESSERA_MCP_TOKEN", "tsk_0123abcd"),
            (
                "TESSERA_RITHMIC_CREDENTIALS",
                "/home/u/.config/tessera/rithmic.env",
            ),
            ("TESSERA_DATA_DIR", "/home/u/.local/share/tessera"),
            ("RITHMIC_PASSWORD", "hunter2"),
            ("MY_PROVIDER_KEY", "sk-provider"),
            ("AWS_SECRET_ACCESS_KEY", "aws"),
        ];
        vars.iter()
            .find(|(n, _)| *n == k)
            .map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn the_child_gets_the_allowlist_and_the_named_provider_keys_and_never_tesseras_own() {
        let extra = [
            "MY_PROVIDER_KEY".to_owned(),
            "TESSERA_MCP_TOKEN".to_owned(),
            "tessera_data_dir".to_owned(),
            "RITHMIC_PASSWORD".to_owned(),
            "HOME".to_owned(),
        ];
        let env = child_env(&extra, parent);
        let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["HOME", "PATH", "MY_PROVIDER_KEY"]);
        assert!(
            env.iter()
                .all(|(_, v)| !v.contains("0123abcd") && v != "hunter2")
        );
        assert!(!names.contains(&"AWS_SECRET_ACCESS_KEY"), "nothing unnamed");
    }

    #[test]
    fn the_allowlist_holds_nothing_withheld() {
        assert!(ENV_ALLOW.iter().all(|k| !withheld(k)));
        assert!(
            withheld("TESSERA_CODEX_HOME") && withheld("Tessera_x") && withheld("RITHMIC_USER")
        );
    }
}
