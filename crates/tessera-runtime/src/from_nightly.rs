use std::io;
use std::path::{Path, PathBuf};

use crate::lock::LOCK_FILE;

pub const NIGHTLY_KEYRING_SERVICE: &str = "tessera-nightly";

pub fn nightly_data_dir(data_dir: &Path) -> PathBuf {
    let name = if data_dir.ends_with("Tessera") {
        "Tessera Nightly"
    } else {
        "tessera-nightly"
    };
    data_dir.with_file_name(name)
}

pub fn copy_nightly_data(data_dir: &Path) -> io::Result<bool> {
    let nightly = nightly_data_dir(data_dir);
    if !nightly.is_dir() || !is_empty(data_dir)? {
        return Ok(false);
    }
    let copying = data_dir.with_extension("copying");
    if copying.exists() {
        std::fs::remove_dir_all(&copying)?;
    }
    copy_dir(&nightly, &copying)?;
    if data_dir.exists() {
        std::fs::remove_dir(data_dir)?;
    }
    std::fs::rename(&copying, data_dir)?;
    Ok(true)
}

pub(crate) fn is_empty(dir: &Path) -> io::Result<bool> {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => Ok(entries.next().is_none()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e),
    }
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if kind.is_dir() {
            copy_dir(&src, &dst)?;
        } else if kind.is_file() && entry.file_name() != LOCK_FILE {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: PathBuf) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn nightly_with_data(root: &Path) -> PathBuf {
        let nightly = root.join("tessera-nightly");
        std::fs::create_dir_all(nightly.join("logs")).unwrap();
        std::fs::write(nightly.join("tessera.db"), "workspaces").unwrap();
        std::fs::write(nightly.join("logs/runtime.log"), "a line").unwrap();
        std::fs::write(nightly.join(LOCK_FILE), "").unwrap();
        nightly
    }

    #[test]
    fn each_build_names_its_own_directory() {
        let mac = Path::new("/u/Library/Application Support/Tessera");
        assert_eq!(nightly_data_dir(mac), mac.with_file_name("Tessera Nightly"));
        let linux = Path::new("/u/.local/share/tessera");
        assert_eq!(
            nightly_data_dir(linux),
            linux.with_file_name("tessera-nightly")
        );
    }

    #[test]
    fn an_empty_or_missing_directory_takes_a_copy_of_nightly_s_once() {
        for make_empty_dir in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let nightly = nightly_with_data(root.path());
            let data_dir = root.path().join("tessera");
            if make_empty_dir {
                std::fs::create_dir(&data_dir).unwrap();
            }

            assert!(copy_nightly_data(&data_dir).unwrap());
            assert_eq!(read(data_dir.join("tessera.db")), "workspaces");
            assert_eq!(read(data_dir.join("logs/runtime.log")), "a line");
            assert!(!data_dir.join(LOCK_FILE).exists());
            assert_eq!(read(nightly.join("tessera.db")), "workspaces");

            std::fs::write(nightly.join("tessera.db"), "newer in Nightly").unwrap();
            assert!(!copy_nightly_data(&data_dir).unwrap());
            assert_eq!(read(data_dir.join("tessera.db")), "workspaces");
        }
    }

    #[test]
    fn without_nightly_s_directory_nothing_is_made() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("tessera");
        assert!(!copy_nightly_data(&data_dir).unwrap());
        assert!(!data_dir.exists());
    }

    #[test]
    fn a_copy_cut_short_starts_over() {
        let root = tempfile::tempdir().unwrap();
        nightly_with_data(root.path());
        let copying = root.path().join("tessera.copying");
        std::fs::create_dir(&copying).unwrap();
        std::fs::write(copying.join("tessera.db"), "half").unwrap();

        assert!(copy_nightly_data(&root.path().join("tessera")).unwrap());
        assert_eq!(read(root.path().join("tessera/tessera.db")), "workspaces");
        assert!(!copying.exists());
    }
}
