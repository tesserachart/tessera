//! Unlinking a lock file while another process waits on it lets two processes hold the lock.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

pub const LOCK_FILE: &str = "tessera.lock";

/// Windows: no other handle can read a locked file.
pub const PID_FILE: &str = "tessera.pid";

pub const EXIT_DATA_DIR_LOCKED: u8 = 3;

#[derive(Debug)]
pub enum LockError {
    Held {
        dir: PathBuf,
        pid: Option<u32>,
    },
    Io {
        dir: PathBuf,
        source: std::io::Error,
    },
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held { dir, pid } => {
                write!(
                    f,
                    "data directory {} is in use by another tessera-runtime",
                    dir.display()
                )?;
                match pid {
                    Some(pid) => write!(f, " (pid {pid})")?,
                    None => f.write_str(" (pid unknown)")?,
                }
                f.write_str(
                    "; stop that runtime, or give this one its own directory with --data-dir or TESSERA_DATA_DIR",
                )
            }
            LockError::Io { dir, source } => {
                write!(f, "cannot lock data directory {}: {source}", dir.display())
            }
        }
    }
}

impl std::error::Error for LockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LockError::Held { .. } => None,
            LockError::Io { source, .. } => Some(source),
        }
    }
}

#[derive(Debug)]
pub struct DataDirLock {
    file: File,
    dir: PathBuf,
}

impl DataDirLock {
    pub fn acquire(dir: &Path) -> Result<Self, LockError> {
        let io = |source| LockError::Io {
            dir: dir.to_path_buf(),
            source,
        };
        crate::private::private_dir(dir).map_err(io)?;
        let mut options = OpenOptions::new();
        tessera_core::private::owner_only(&mut options);
        let file = options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(LOCK_FILE))
            .map_err(io)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                let text = std::fs::read_to_string(dir.join(PID_FILE)).unwrap_or_default();
                return Err(LockError::Held {
                    dir: dir.to_path_buf(),
                    pid: text.lines().next().and_then(|l| l.trim().parse().ok()),
                });
            }
            Err(TryLockError::Error(e)) => return Err(io(e)),
        }
        std::fs::write(dir.join(PID_FILE), format!("{}\n", std::process::id())).map_err(io)?;
        Ok(Self {
            file,
            dir: dir.to_path_buf(),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

impl Drop for DataDirLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.dir.join(PID_FILE));
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_holder_at_a_time_and_the_error_names_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data");
        let first = DataDirLock::acquire(&dir).unwrap();
        assert_eq!(first.dir(), dir);
        assert_eq!(
            std::fs::read_to_string(dir.join(PID_FILE)).unwrap().trim(),
            std::process::id().to_string()
        );

        let err = DataDirLock::acquire(&dir).unwrap_err();
        match &err {
            LockError::Held { pid, .. } => assert_eq!(*pid, Some(std::process::id())),
            other => panic!("expected Held, got {other:?}"),
        }
        let msg = err.to_string();
        assert!(msg.contains(&dir.display().to_string()), "{msg}");
        assert!(
            msg.contains(&format!("pid {}", std::process::id())),
            "{msg}"
        );
        assert!(msg.contains("--data-dir"), "{msg}");

        drop(first);
        assert!(
            !dir.join(PID_FILE).exists(),
            "the PID is cleared on release"
        );
        let again = DataDirLock::acquire(&dir).unwrap();
        drop(again);
    }
}
