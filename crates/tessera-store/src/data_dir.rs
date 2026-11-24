use std::path::{Path, PathBuf};

const DATABASE: &str = "tessera.db";
const BARS: &str = "bars.db";
const DEPTH: &str = "depth.db";
const TICKS_DIR: &str = "ticks";
const TICKS: &str = "ticks.db";
const BLOBS: &str = "blobs";
const LOGS: &str = "logs";
const AGENTS: &str = "agents";
const ATTACHMENTS: &str = "attachments";
const BACKUPS: &str = "backups";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDir(PathBuf);

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self(root.into())
    }

    pub fn root(&self) -> &Path {
        &self.0
    }

    pub fn database(&self) -> PathBuf {
        self.0.join(DATABASE)
    }

    pub fn bars(&self) -> PathBuf {
        self.0.join(BARS)
    }

    pub fn depth(&self) -> PathBuf {
        self.0.join(DEPTH)
    }

    pub fn ticks(&self) -> PathBuf {
        self.0.join(TICKS_DIR).join(TICKS)
    }

    pub fn blobs(&self) -> PathBuf {
        self.0.join(BLOBS)
    }

    pub fn logs(&self) -> PathBuf {
        self.0.join(LOGS)
    }

    pub fn agents(&self) -> PathBuf {
        self.0.join(AGENTS)
    }

    pub fn attachments(&self) -> PathBuf {
        self.0.join(ATTACHMENTS)
    }

    pub fn backups(&self) -> PathBuf {
        self.0.join(BACKUPS)
    }

    pub fn private_dirs(&self) -> [PathBuf; 3] {
        [self.blobs(), self.0.join(TICKS_DIR), self.logs()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_part_has_its_own_name_under_the_root() {
        let d = DataDir::new("/data");
        let names = [
            d.database(),
            d.bars(),
            d.depth(),
            d.ticks(),
            d.blobs(),
            d.logs(),
            d.agents(),
            d.attachments(),
            d.backups(),
        ];
        let names: Vec<Vec<&str>> = names
            .iter()
            .map(|p| {
                p.strip_prefix("/data")
                    .unwrap()
                    .components()
                    .map(|c| c.as_os_str().to_str().unwrap())
                    .collect()
            })
            .collect();
        let expected: [&[&str]; 9] = [
            &["tessera.db"],
            &["bars.db"],
            &["depth.db"],
            &["ticks", "ticks.db"],
            &["blobs"],
            &["logs"],
            &["agents"],
            &["attachments"],
            &["backups"],
        ];
        assert_eq!(names, expected);
        assert_eq!(
            d.private_dirs(),
            ["blobs", "ticks", "logs"].map(|n| Path::new("/data").join(n))
        );
    }
}
