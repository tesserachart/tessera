use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DISCOVERY_FILE: &str = "discovery.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub port: u16,
    pub pid: u32,
    pub version: String,
}

impl Discovery {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(DISCOVERY_FILE)
    }

    pub fn write(&self, data_dir: &Path) -> io::Result<()> {
        let path = Self::path(data_dir);
        let tmp = data_dir.join(format!(".{DISCOVERY_FILE}.tmp"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        tessera_core::private::owner_only(&mut options);
        let mut f = options.open(&tmp)?;
        let text = serde_json::to_string(self).map_err(io::Error::other)?;
        f.write_all(text.as_bytes())?;
        f.write_all(b"\n")?;
        drop(f);
        tessera_core::private::restrict(&tmp)?;
        std::fs::rename(&tmp, &path)
    }

    pub fn read(data_dir: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(Self::path(data_dir)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn remove_own(data_dir: &Path, pid: u32) {
        if Self::read(data_dir).is_some_and(|d| d.pid == pid) {
            let _ = std::fs::remove_file(Self::path(data_dir));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_read_and_removed_by_its_own_process_only() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(Discovery::read(tmp.path()), None);
        let d = Discovery {
            port: 4321,
            pid: 77,
            version: "0.1.0".into(),
        };
        d.write(tmp.path()).unwrap();
        assert_eq!(Discovery::read(tmp.path()), Some(d.clone()));
        let text = std::fs::read_to_string(Discovery::path(tmp.path())).unwrap();
        assert!(!text.to_lowercase().contains("token"));
        assert!(tessera_core::private::is_private(&Discovery::path(
            tmp.path()
        )));
        Discovery::remove_own(tmp.path(), 78);
        assert!(
            Discovery::read(tmp.path()).is_some(),
            "another process's file stays"
        );
        Discovery::remove_own(tmp.path(), 77);
        assert_eq!(Discovery::read(tmp.path()), None);
    }
}
