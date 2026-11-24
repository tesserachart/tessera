use serde::{Deserialize, Serialize};
use tessera_core::accounts::Environment;
use tessera_core::{InstrumentId, Timeframe};
use tessera_protocol::tools::SessionMode;
use tessera_tools::SessionPolicy;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "name")]
pub enum Preset {
    Trader,
    Quant,
    Risk,
    Researcher,
    Custom(String),
}

impl Preset {
    pub fn label(&self) -> &str {
        match self {
            Preset::Trader => "Trader",
            Preset::Quant => "Quant",
            Preset::Risk => "Risk",
            Preset::Researcher => "Researcher",
            Preset::Custom(n) => n,
        }
    }

    pub fn policy(&self, mode: SessionMode) -> SessionPolicy {
        let list = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let (allow, deny) = match self {
            Preset::Trader => (None, list(&["research.open_window"])),
            Preset::Quant => (
                Some(list(&[
                    "market.*",
                    "chart.*",
                    "levels.*",
                    "intel.*",
                    "research.*",
                    "strategy.*",
                    "concepts.*",
                    "indicators.*",
                    "workspace.*",
                    "alerts.*",
                    "agent.*",
                ])),
                list(&["research.open_window"]),
            ),
            Preset::Risk => (
                Some(list(&[
                    "market.*",
                    "portfolio.*",
                    "journal.*",
                    "levels.*",
                    "alerts.*",
                    "agent.*",
                ])),
                vec![],
            ),
            Preset::Researcher => (
                Some(list(&[
                    "market.*",
                    "chart.get_state",
                    "levels.*",
                    "intel.*",
                    "research.*",
                    "concepts.*",
                    "indicators.*",
                    "workspace.*",
                    "agent.*",
                ])),
                list(&["research.open_window"]),
            ),
            Preset::Custom(_) => (None, vec![]),
        };
        SessionPolicy { mode, allow, deny }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextPolicy {
    #[default]
    Workspace,
    ChartOnly,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub title: String,
    pub preset: Preset,
    pub provider: String,
    pub model: Option<String>,
    pub mode: SessionMode,
    pub context: ContextPolicy,
    pub allow: Option<Vec<String>>,
    pub deny: Vec<String>,
}

impl SessionConfig {
    pub fn policy(&self) -> SessionPolicy {
        let mut p = self.preset.policy(self.mode);
        if let Some(extra) = &self.allow {
            p.allow = Some(match p.allow {
                Some(base) => extra
                    .iter()
                    .filter(|e| {
                        base.iter().any(|b| {
                            tessera_tools::gate::pattern_matches(b, e.trim_end_matches(".*"))
                                || b == *e
                        })
                    })
                    .cloned()
                    .collect(),
                None => extra.clone(),
            });
        }
        p.deny.extend(self.deny.iter().cloned());
        p
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    pub chart_tile: Option<String>,
    pub instrument: Option<InstrumentId>,
    pub timeframe: Option<Timeframe>,
    pub layers: Vec<String>,
    pub account: Option<String>,
    pub environment: Option<Environment>,
    pub positions_summary: Option<String>,
    pub alerts: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_tools::gate::pattern_matches;

    #[test]
    fn presets_map_to_policies() {
        let t = Preset::Trader.policy(SessionMode::Supervised);
        assert!(t.allow.is_none());
        assert!(t.deny.contains(&"research.open_window".to_owned()));
        let r = Preset::Researcher.policy(SessionMode::ReadOnly);
        assert_eq!(r.mode, SessionMode::ReadOnly);
        let allow = r.allow.unwrap();
        assert!(
            allow
                .iter()
                .any(|p| pattern_matches(p, "research.run_backtest"))
        );
        assert!(!allow.iter().any(|p| pattern_matches(p, "orders.submit")));
    }

    #[test]
    fn config_narrows_the_preset() {
        let cfg = SessionConfig {
            title: "S15".into(),
            preset: Preset::Quant,
            provider: "codex".into(),
            model: None,
            mode: SessionMode::Supervised,
            context: ContextPolicy::Workspace,
            allow: Some(vec!["market.*".into(), "orders.submit".into()]),
            deny: vec!["chart.annotate".into()],
        };
        let p = cfg.policy();
        assert_eq!(
            p.allow,
            Some(vec!["market.*".to_owned()]),
            "cannot widen the preset"
        );
        assert!(p.deny.contains(&"chart.annotate".to_owned()));
    }
}
