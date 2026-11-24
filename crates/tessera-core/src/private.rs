use std::io;
use std::path::Path;

pub fn private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    restrict(dir)
}

#[cfg(unix)]
pub fn restrict(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path)?;
    let mode = if meta.is_dir() { 0o700 } else { 0o600 };
    if meta.permissions().mode() & 0o777 == mode {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// Windows: a new file takes the access list of its directory.
pub fn owner_only(options: &mut std::fs::OpenOptions) -> &mut std::fs::OpenOptions {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(options, 0o600);
    options
}

#[cfg(unix)]
pub fn is_private(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o077 == 0)
}

#[cfg(windows)]
pub use windows::{is_private, restrict};

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const SYSTEM_SID: &str = "S-1-5-18";
    const ADMINISTRATORS_SID: &str = "S-1-5-32-544";
    const ACCESS_RULES: &str = "(Get-Acl -LiteralPath $env:TESSERA_ACL_PATH).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { '{0} {1} {2}' -f $_.AccessControlType, ($_.PropagationFlags -replace ', ', '+'), $_.IdentityReference }";

    pub fn restrict(path: &Path) -> io::Result<()> {
        let sid = user_sid()?;
        let inherit = if path.is_dir() { "(OI)(CI)" } else { "" };
        let path = path.as_os_str();
        run("icacls.exe", &[path, "/reset".as_ref(), "/q".as_ref()])?;
        let user = format!("*{sid}:{inherit}F");
        let system = format!("*{SYSTEM_SID}:{inherit}F");
        run(
            "icacls.exe",
            &[
                path,
                "/inheritance:r".as_ref(),
                "/grant:r".as_ref(),
                user.as_ref(),
                system.as_ref(),
                "/q".as_ref(),
            ],
        )
        .map(drop)
    }

    pub fn is_private(path: &Path) -> bool {
        let (Ok(sid), Some(rules)) = (user_sid(), access_rules(path)) else {
            return false;
        };
        allowed_sids(&rules).all(|s| s == sid || s == SYSTEM_SID || s == ADMINISTRATORS_SID)
    }

    fn access_rules(path: &Path) -> Option<String> {
        let out = Command::new(system32(r"WindowsPowerShell\v1.0\powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", ACCESS_RULES])
            .env("TESSERA_ACL_PATH", path)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn allowed_sids(rules: &str) -> impl Iterator<Item = &str> {
        rules.lines().filter_map(|rule| {
            match rule.split_whitespace().collect::<Vec<_>>().as_slice() {
                ["Allow", propagation, sid] if !propagation.contains("InheritOnly") => Some(*sid),
                _ => None,
            }
        })
    }

    fn user_sid() -> io::Result<&'static str> {
        static SID: OnceLock<Option<String>> = OnceLock::new();
        SID.get_or_init(|| {
            run(
                "whoami.exe",
                &["/user", "/fo", "csv", "/nh"].map(OsStr::new),
            )
            .ok()
            .and_then(|out| parse_sid(&out))
        })
        .as_deref()
        .ok_or_else(|| io::Error::other("cannot read the current user's SID (whoami /user)"))
    }

    fn parse_sid(csv: &str) -> Option<String> {
        csv.trim()
            .rsplit(',')
            .next()
            .map(|s| s.trim_matches('"').to_owned())
            .filter(|s| s.starts_with("S-1-"))
    }

    fn run(exe: &str, args: &[&OsStr]) -> io::Result<String> {
        let out = Command::new(system32(exe))
            .args(args)
            .stdin(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(if out.stderr.is_empty() {
                &out.stdout
            } else {
                &out.stderr
            });
            return Err(io::Error::other(format!("{exe}: {}", why.trim())));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn system32(exe: &str) -> PathBuf {
        std::env::var_os("SystemRoot")
            .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from)
            .join("System32")
            .join(exe)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn reads_the_sid_whoami_prints() {
            assert_eq!(
                parse_sid("\"desk\\ana, b\",\"S-1-5-21-1-2-3-1001\"\r\n").as_deref(),
                Some("S-1-5-21-1-2-3-1001")
            );
            assert_eq!(parse_sid("nonsense"), None);
        }

        #[test]
        fn names_who_an_access_list_allows() {
            let rules = "Allow None S-1-5-18\r\nAllow InheritOnly S-1-3-0\r\nDeny None S-1-1-0\r\nAllow None S-1-5-20\r\n";
            assert_eq!(
                allowed_sids(rules).collect::<Vec<_>>(),
                ["S-1-5-18", "S-1-5-20"]
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn open_to_everyone(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = if path.is_dir() { 0o755 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(windows)]
    fn open_to_everyone(path: &Path) {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args(["/grant", "*S-1-1-0:R", "/q"])
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn a_private_directory_and_what_is_made_in_it_are_the_owners_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fresh/nested");
        private_dir(&dir).unwrap();
        assert!(is_private(&dir));
        let file = dir.join("token");
        std::fs::write(&file, "x").unwrap();
        restrict(&file).unwrap();
        assert!(is_private(&file));

        open_to_everyone(&file);
        assert!(!is_private(&file));
        restrict(&file).unwrap();
        assert!(is_private(&file));

        open_to_everyone(&dir);
        assert!(!is_private(&dir));
        private_dir(&dir).unwrap();
        assert!(is_private(&dir));
    }
}
