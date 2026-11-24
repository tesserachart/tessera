use std::io;
use std::path::Path;

pub use tessera_core::private::private_dir;

pub fn protect_data_dir(dir: &Path) -> io::Result<()> {
    private_dir(dir)?;
    protect_entries(dir, 2)
}

#[cfg(unix)]
fn protect_entries(dir: &Path, depth: u8) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() || kind.is_file() {
            tessera_core::private::restrict(&path)?;
        }
        if kind.is_dir() && depth > 1 {
            protect_entries(&path, depth - 1)?;
        }
    }
    Ok(())
}

/// Windows: a directory's entries inherit its access list.
#[cfg(windows)]
fn protect_entries(_dir: &Path, _depth: u8) -> io::Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn the_data_directory_and_what_it_holds_become_the_owners_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("tessera");
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::create_dir_all(dir.join("agents/sessions")).unwrap();
        for f in ["tessera.db", "tessera.db-wal", "logs/runtime.log"] {
            std::fs::write(dir.join(f), "x").unwrap();
            std::fs::set_permissions(dir.join(f), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        protect_data_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("logs")), 0o700);
        assert_eq!(mode(&dir.join("agents/sessions")), 0o700);
        for f in ["tessera.db", "tessera.db-wal", "logs/runtime.log"] {
            assert_eq!(mode(&dir.join(f)), 0o600, "{f}");
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use tessera_core::private::is_private;

    use super::*;

    #[test]
    fn the_data_directory_and_what_it_holds_become_the_owners_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("tessera");
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::create_dir_all(dir.join("agents/sessions")).unwrap();
        let everyone = std::process::Command::new("icacls")
            .arg(&dir)
            .args(["/grant", "*S-1-1-0:(OI)(CI)R", "/q"])
            .status()
            .unwrap();
        assert!(everyone.success());
        for f in ["tessera.db", "tessera.db-wal", "logs/runtime.log"] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        assert!(!is_private(&dir.join("logs/runtime.log")));
        protect_data_dir(&dir).unwrap();
        for p in [
            "",
            "logs",
            "agents/sessions",
            "tessera.db",
            "tessera.db-wal",
            "logs/runtime.log",
        ] {
            assert!(is_private(&dir.join(p)), "{p}");
        }
    }
}
