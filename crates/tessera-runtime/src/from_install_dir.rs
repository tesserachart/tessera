use std::ffi::OsString;
use std::io;
use std::path::Path;

use crate::from_nightly::is_empty;
use crate::lock::{DataDirLock, LOCK_FILE, LockError, PID_FILE};

pub const DATA_DIR: &str = "Data";

const STAGING_DIR: &str = "Data.moving";

#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    Nothing,
    Kept,
    Entries(usize),
}

#[derive(Debug)]
pub enum MoveError {
    Locked(LockError),
    Io(io::Error),
}

impl std::fmt::Display for MoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MoveError::Locked(e) => e.fmt(f),
            MoveError::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for MoveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            MoveError::Locked(e) => Some(e),
            MoveError::Io(e) => Some(e),
        }
    }
}

impl From<io::Error> for MoveError {
    fn from(e: io::Error) -> Self {
        MoveError::Io(e)
    }
}

impl From<LockError> for MoveError {
    fn from(e: LockError) -> Self {
        MoveError::Locked(e)
    }
}

pub fn move_out_of_install_dir(install_dir: &Path) -> Result<Moved, MoveError> {
    let data = install_dir.join(DATA_DIR);
    let staging = install_dir.join(STAGING_DIR);
    if !staging.exists() && data_entries(install_dir)?.is_empty() {
        return Ok(Moved::Nothing);
    }
    if !is_empty(&data)? {
        return Ok(Moved::Kept);
    }
    let lock = DataDirLock::acquire(install_dir)?;
    crate::private::private_dir(&staging)?;
    for name in data_entries(install_dir)? {
        let destination = staging.join(&name);
        if destination.symlink_metadata().is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} already exists", destination.display()),
            )
            .into());
        }
        std::fs::rename(install_dir.join(&name), destination)?;
    }
    let moved = std::fs::read_dir(&staging)?.count();
    if data.exists() {
        std::fs::remove_dir(&data)?;
    }
    std::fs::rename(&staging, &data)?;
    drop(lock);
    let _ = std::fs::remove_file(install_dir.join(LOCK_FILE));
    Ok(Moved::Entries(moved))
}

fn data_entries(install_dir: &Path) -> io::Result<Vec<OsString>> {
    let entries = match std::fs::read_dir(install_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut names = Vec::new();
    for entry in entries {
        let name = entry?.file_name();
        if !stays_in_install_dir(&name) {
            names.push(name);
        }
    }
    Ok(names)
}

fn stays_in_install_dir(name: &OsString) -> bool {
    let path = Path::new(name);
    name == DATA_DIR
        || name == STAGING_DIR
        || name == LOCK_FILE
        || name == PID_FILE
        || path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("dll"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;

    type Tree = BTreeMap<PathBuf, Option<Vec<u8>>>;

    fn tree(dir: &Path) -> Tree {
        fn walk(root: &Path, dir: &Path, out: &mut Tree) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let relative = path.strip_prefix(root).unwrap().to_path_buf();
                if path.is_dir() {
                    out.insert(relative, None);
                    walk(root, &path, out);
                } else {
                    out.insert(relative, Some(std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Tree::new();
        walk(dir, dir, &mut out);
        out
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn read(path: PathBuf) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn program_files(dir: &Path) {
        write(dir, "tessera-desktop.exe", "shell");
        write(dir, "tessera-runtime.exe", "runtime");
        write(dir, "uninstall.exe", "uninstaller");
    }

    fn legacy_install_dir() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        program_files(dir);
        write(dir, "tessera.db", "workspaces");
        write(dir, "tessera.db-wal", "recent writes");
        write(dir, "logs/runtime.log", "a line");
        write(dir, "ticks/.keep", "");
        write(dir, "agents/x", "agent");
        write(dir, LOCK_FILE, "");
        tmp
    }

    #[test]
    fn a_legacy_install_folder_hands_its_data_to_data_once() {
        let tmp = legacy_install_dir();
        let dir = tmp.path();
        let before = tree(dir);

        assert_eq!(move_out_of_install_dir(dir).unwrap(), Moved::Entries(5));

        let data = dir.join(DATA_DIR);
        for name in [
            "tessera.db",
            "tessera.db-wal",
            "logs/runtime.log",
            "ticks/.keep",
            "agents/x",
        ] {
            assert_eq!(
                std::fs::read(data.join(name)).unwrap(),
                before[Path::new(name)].clone().unwrap(),
                "{name}"
            );
            assert!(!dir.join(name).exists(), "{name} left behind");
        }
        for name in [
            "tessera-desktop.exe",
            "tessera-runtime.exe",
            "uninstall.exe",
        ] {
            assert!(dir.join(name).is_file(), "{name}");
            assert!(!data.join(name).exists(), "{name}");
        }
        for name in [STAGING_DIR, LOCK_FILE, PID_FILE] {
            assert!(!dir.join(name).exists(), "{name}");
        }
        assert!(!data.join(LOCK_FILE).exists());

        let after = tree(dir);
        assert_eq!(move_out_of_install_dir(dir).unwrap(), Moved::Nothing);
        assert_eq!(tree(dir), after);
    }

    #[test]
    fn program_files_are_told_apart_by_extension_in_any_case() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write(dir, "TESSERA.EXE", "shell");
        write(dir, "WebView2Loader.Dll", "loader");
        write(dir, "tessera.db", "workspaces");

        assert_eq!(move_out_of_install_dir(dir).unwrap(), Moved::Entries(1));
        assert_eq!(read(dir.join("Data/tessera.db")), "workspaces");
        assert_eq!(read(dir.join("TESSERA.EXE")), "shell");
        assert_eq!(read(dir.join("WebView2Loader.Dll")), "loader");
    }

    #[test]
    fn a_fresh_install_has_nothing_to_move_and_nothing_is_made() {
        let only_programs = tempfile::tempdir().unwrap();
        program_files(only_programs.path());
        let with_empty_data = tempfile::tempdir().unwrap();
        program_files(with_empty_data.path());
        std::fs::create_dir(with_empty_data.path().join(DATA_DIR)).unwrap();

        for tmp in [&only_programs, &with_empty_data] {
            let before = tree(tmp.path());
            assert_eq!(move_out_of_install_dir(tmp.path()).unwrap(), Moved::Nothing);
            assert_eq!(tree(tmp.path()), before);
        }
    }

    #[test]
    fn data_already_in_data_is_kept_and_the_install_folder_s_is_left_alone() {
        let tmp = legacy_install_dir();
        let dir = tmp.path();
        write(dir, "Data/tessera.db", "the newer one");
        let before = tree(dir);

        assert_eq!(move_out_of_install_dir(dir).unwrap(), Moved::Kept);
        assert_eq!(tree(dir), before);
        assert_eq!(read(dir.join("tessera.db")), "workspaces");
        assert_eq!(read(dir.join("Data/tessera.db")), "the newer one");
    }

    #[test]
    fn a_move_cut_short_is_finished_by_the_next_start() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        program_files(dir);
        write(dir, "Data.moving/tessera.db", "workspaces");
        write(dir, "tessera.db-wal", "recent writes");
        write(dir, "logs/runtime.log", "a line");

        assert_eq!(move_out_of_install_dir(dir).unwrap(), Moved::Entries(3));
        assert_eq!(read(dir.join("Data/tessera.db")), "workspaces");
        assert_eq!(read(dir.join("Data/tessera.db-wal")), "recent writes");
        assert_eq!(read(dir.join("Data/logs/runtime.log")), "a line");
        assert!(!dir.join(STAGING_DIR).exists());
        assert!(!dir.join("tessera.db-wal").exists());
        assert!(!dir.join("logs").exists());
    }

    #[test]
    fn a_name_in_both_places_stops_the_move_and_overwrites_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        program_files(dir);
        write(dir, "Data.moving/tessera.db", "staged");
        write(dir, "tessera.db", "installed");

        let err = move_out_of_install_dir(dir).unwrap_err();
        match err {
            MoveError::Io(e) => assert_eq!(e.kind(), io::ErrorKind::AlreadyExists),
            other => panic!("expected Io, got {other:?}"),
        }
        assert_eq!(read(dir.join("Data.moving/tessera.db")), "staged");
        assert_eq!(read(dir.join("tessera.db")), "installed");
        assert!(!dir.join(DATA_DIR).exists());
    }

    #[test]
    fn an_older_runtime_still_on_the_folder_blocks_the_move() {
        let tmp = legacy_install_dir();
        let dir = tmp.path();
        let before = tree(dir);
        let older = DataDirLock::acquire(dir).unwrap();
        let result = move_out_of_install_dir(dir);
        drop(older);

        match result.unwrap_err() {
            MoveError::Locked(LockError::Held { pid, .. }) => {
                assert_eq!(pid, Some(std::process::id()))
            }
            other => panic!("expected Locked, got {other:?}"),
        }
        assert_eq!(tree(dir), before);
        assert!(!dir.join(DATA_DIR).exists());
        assert!(!dir.join(STAGING_DIR).exists());
    }
}
