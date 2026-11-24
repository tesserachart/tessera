use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowKind {
    Development,
    Validation,
    Lockbox,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchWindow {
    pub kind: WindowKind,
    pub start: Timestamp,
    pub end: Timestamp,
    pub opened: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kind:?} window is sealed; data at {at} cannot be read until it is opened with approval")]
pub struct SealedRead {
    pub kind: WindowKind,
    pub at: Timestamp,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGuard {
    windows: Vec<ResearchWindow>,
}

impl WindowGuard {
    pub fn new(windows: Vec<ResearchWindow>) -> Self {
        Self { windows }
    }

    pub fn check(&self, t: Timestamp) -> Result<(), SealedRead> {
        match self
            .windows
            .iter()
            .find(|w| !w.opened && w.kind != WindowKind::Development && t >= w.start && t < w.end)
        {
            Some(w) => Err(SealedRead {
                kind: w.kind,
                at: t,
            }),
            None => Ok(()),
        }
    }

    pub fn check_all(&self, ts: impl IntoIterator<Item = Timestamp>) -> Result<(), SealedRead> {
        ts.into_iter().try_for_each(|t| self.check(t))
    }

    pub fn open(&mut self, kind: WindowKind) -> bool {
        let mut changed = false;
        for w in self.windows.iter_mut().filter(|w| w.kind == kind) {
            changed |= !w.opened;
            w.opened = true;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_until_opened() {
        let t = |s: &str| Timestamp::parse(s).unwrap();
        let mut g = WindowGuard::new(vec![
            ResearchWindow {
                kind: WindowKind::Development,
                start: t("2022-01-03"),
                end: t("2025-01-01"),
                opened: false,
            },
            ResearchWindow {
                kind: WindowKind::Validation,
                start: t("2025-01-01"),
                end: t("2026-01-01"),
                opened: false,
            },
            ResearchWindow {
                kind: WindowKind::Lockbox,
                start: t("2026-01-01"),
                end: t("2026-10-01"),
                opened: false,
            },
        ]);
        assert!(g.check(t("2023-06-01")).is_ok());
        assert_eq!(
            g.check(t("2025-06-01")).unwrap_err().kind,
            WindowKind::Validation
        );
        assert!(g.check_all([t("2024-01-01"), t("2026-02-01")]).is_err());
        assert!(g.open(WindowKind::Validation));
        assert!(!g.open(WindowKind::Validation));
        assert!(g.check(t("2025-06-01")).is_ok());
        assert!(g.check(t("2026-02-01")).is_err(), "lockbox still sealed");
    }
}
