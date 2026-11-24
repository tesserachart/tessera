//! An app opened from the Finder or the Dock does not start from a terminal: macOS gives it only
//! `/usr/bin:/bin:/usr/sbin:/sbin` as its `PATH`.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "__TESSERA_PATH__";

const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

const USUAL_DIRS: [&str; 9] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ".local/bin",
    ".claude/local",
    ".npm-global/bin",
    ".bun/bin",
    ".volta/bin",
    ".cargo/bin",
    "Library/pnpm",
];

pub fn runtime_path() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let login = login_shell_path(&shell);
    let current = std::env::var("PATH").ok();
    Some(merge(
        [login.as_deref(), current.as_deref()],
        home.as_deref(),
        |p| p.is_dir(),
    ))
}

/// Interactive and login (`-il`), so both `.zprofile` and `.zshrc` run, where nvm, Homebrew and the
/// CLIs' installers add to `PATH`.
fn login_shell_path(shell: &str) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '\\n{MARKER}%s\\n' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < SHELL_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    parse_marked(&out)
}

fn parse_marked(out: &str) -> Option<String> {
    out.lines()
        .rev()
        .find_map(|l| l.strip_prefix(MARKER))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from)
}

fn merge(paths: [Option<&str>; 2], home: Option<&Path>, exists: impl Fn(&Path) -> bool) -> String {
    let mut seen: Vec<String> = Vec::new();
    let mut push = |dir: String| {
        if !dir.is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    };
    for path in paths.into_iter().flatten() {
        for dir in path.split(':') {
            push(dir.to_string());
        }
    }
    for dir in USUAL_DIRS {
        let full = if dir.starts_with('/') {
            Some(PathBuf::from(dir))
        } else {
            home.map(|h| h.join(dir))
        };
        if let Some(full) = full.filter(|p| exists(p)) {
            push(full.to_string_lossy().into_owned());
        }
    }
    seen.join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn reads_the_marked_line_past_what_a_profile_prints() {
        let out = format!("Welcome!\nnvm: using node 24\n\n{MARKER}/opt/homebrew/bin:/usr/bin\n");
        assert_eq!(
            parse_marked(&out).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(parse_marked("no marker here"), None);
        assert_eq!(parse_marked(&format!("{MARKER}\n")), None);
    }

    #[test]
    fn keeps_the_order_and_adds_the_usual_directories_that_exist() {
        let home = Path::new("/Users/t");
        let merged = merge(
            [
                Some("/Users/t/.nvm/versions/node/v24/bin:/usr/bin"),
                Some("/usr/bin:/bin"),
            ],
            Some(home),
            |p| p == Path::new("/opt/homebrew/bin") || p == Path::new("/Users/t/.local/bin"),
        );
        assert_eq!(
            merged,
            "/Users/t/.nvm/versions/node/v24/bin:/usr/bin:/bin:/opt/homebrew/bin:/Users/t/.local/bin"
        );
    }

    #[test]
    fn without_a_login_shell_the_current_path_and_the_usual_directories_remain() {
        let merged = merge([None, Some("/usr/bin:/bin")], None, |p| {
            p == Path::new("/usr/local/bin")
        });
        assert_eq!(merged, "/usr/bin:/bin:/usr/local/bin");
    }

    #[test]
    fn a_shell_that_hangs_is_given_up_on() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("tessera-login-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shell = dir.join("slow-shell");
        std::fs::write(&shell, "#!/bin/sh\nexec sleep 3600\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (answered, answer) = std::sync::mpsc::channel();
        let path = shell.to_str().unwrap().to_owned();
        std::thread::spawn(move || answered.send(login_shell_path(&path)).ok());
        let path = answer
            .recv_timeout(Duration::from_secs(60))
            .expect("the hung shell is given up on long before it ends");
        assert_eq!(path, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn asks_a_real_shell_for_its_path() {
        let path = login_shell_path("/bin/sh").expect("sh prints its PATH");
        assert!(path.contains("/bin"), "{path}");
    }
}
