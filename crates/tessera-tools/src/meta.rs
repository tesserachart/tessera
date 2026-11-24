use tessera_protocol::tools::{RiskTier, UiHints};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateLimit {
    pub per_second: f64,
    pub burst: u32,
}

impl RateLimit {
    pub const fn new(per_second: f64, burst: u32) -> Self {
        Self { per_second, burst }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolMeta {
    pub name: String,
    pub title: String,
    pub description: String,
    pub risk: RiskTier,
    pub category: String,
    pub ui: UiHints,
    pub idempotent: bool,
    pub user_only: bool,
    pub draft_only: bool,
    pub always_ask: bool,
    pub rate_limit: Option<RateLimit>,
    pub quiet: bool,
    pub refreshes: Vec<String>,
    pub redact: Vec<String>,
    pub timeout_ms: u64,
}

impl ToolMeta {
    pub fn new(name: impl Into<String>, title: impl Into<String>, risk: RiskTier) -> Self {
        let name = name.into();
        let category = name.split('.').next().unwrap_or_default().to_owned();
        Self {
            name,
            title: title.into(),
            description: String::new(),
            risk,
            category,
            ui: UiHints::default(),
            idempotent: matches!(risk, RiskTier::Read),
            user_only: false,
            draft_only: false,
            always_ask: false,
            rate_limit: None,
            quiet: false,
            refreshes: Vec::new(),
            redact: Vec::new(),
            timeout_ms: 30_000,
        }
    }

    pub fn description(mut self, d: impl Into<String>) -> Self {
        self.description = d.into();
        self
    }

    pub fn category(mut self, c: impl Into<String>) -> Self {
        self.category = c.into();
        self
    }

    pub fn ui(mut self, ui: UiHints) -> Self {
        self.ui = ui;
        self
    }

    pub fn activity(mut self, label: impl Into<String>) -> Self {
        self.ui.activity_label = Some(label.into());
        self
    }

    pub fn result_view(mut self, view: impl Into<String>) -> Self {
        self.ui.result_view = Some(view.into());
        self
    }

    pub fn idempotent(mut self, v: bool) -> Self {
        self.idempotent = v;
        self
    }

    pub fn user_only(mut self) -> Self {
        self.user_only = true;
        self.ui.hidden = true;
        self
    }

    pub fn draft_only(mut self) -> Self {
        self.draft_only = true;
        self
    }

    pub fn always_ask(mut self) -> Self {
        self.always_ask = true;
        self
    }

    pub fn rate_limit(mut self, limit: RateLimit) -> Self {
        self.rate_limit = Some(limit);
        self
    }

    pub fn quiet(mut self) -> Self {
        self.quiet = true;
        self
    }

    pub fn refreshes(mut self, reads: &[&str]) -> Self {
        self.refreshes.extend(reads.iter().map(|s| (*s).to_owned()));
        self
    }

    pub fn redact(mut self, fields: &[&str]) -> Self {
        self.redact.extend(fields.iter().map(|s| (*s).to_owned()));
        self
    }

    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }

    pub fn mcp_name(&self) -> String {
        mcp_name(&self.name)
    }
}

pub fn mcp_name(name: &str) -> String {
    name.replace('.', "_")
}

pub fn is_valid_tool_name(name: &str) -> bool {
    let mut parts = 0;
    for seg in name.split('.') {
        parts += 1;
        let mut chars = seg.chars();
        match chars.next() {
            Some(c) if c.is_ascii_lowercase() => {}
            _ => return false,
        }
        if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
            return false;
        }
    }
    parts >= 2 && name.len() <= 64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(is_valid_tool_name("market.get_candles"));
        assert!(is_valid_tool_name("research.run_backtest2"));
        assert!(!is_valid_tool_name("market"));
        assert!(!is_valid_tool_name("Market.get"));
        assert!(!is_valid_tool_name("market..get"));
        assert!(!is_valid_tool_name("market.get-candles"));
        assert!(!is_valid_tool_name("market.1get"));
        assert_eq!(mcp_name("market.get_candles"), "market_get_candles");
        let m = ToolMeta::new("chart.report_viewport", "Report viewport", RiskTier::Modify)
            .user_only()
            .quiet();
        assert_eq!(m.category, "chart");
        assert!(m.ui.hidden && m.user_only && m.quiet && !m.idempotent);
    }
}
