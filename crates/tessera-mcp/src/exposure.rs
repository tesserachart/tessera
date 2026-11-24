use std::collections::BTreeMap;

use serde_json::{Value, json};
use tessera_protocol::tools::{RiskTier, ToolDescriptor};
use tessera_tools::mcp_name;

#[derive(Clone, Debug, Default)]
pub struct McpToolMap {
    by_mcp: BTreeMap<String, ToolDescriptor>,
}

impl McpToolMap {
    pub fn new(descriptors: impl IntoIterator<Item = ToolDescriptor>) -> Self {
        Self {
            by_mcp: descriptors
                .into_iter()
                .filter(|d| !d.user_only)
                .map(|d| (mcp_name(&d.name), d))
                .collect(),
        }
    }

    pub fn resolve(&self, mcp: &str) -> Option<&str> {
        self.by_mcp.get(mcp).map(|d| d.name.as_str())
    }

    pub fn len(&self) -> usize {
        self.by_mcp.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_mcp.is_empty()
    }

    pub fn definitions(&self) -> Vec<Value> {
        self.by_mcp.iter().map(|(n, d)| definition(n, d)).collect()
    }
}

pub fn definition(mcp: &str, d: &ToolDescriptor) -> Value {
    let mut schema = d.input_schema.clone();
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        schema = json!({ "type": "object", "properties": {} });
    }
    if let Some(obj) = schema.as_object_mut() {
        obj.remove("$schema");
    }
    let risk_note = match d.risk {
        RiskTier::Read => "Read-only.",
        RiskTier::Modify => "Changes Tessera state; may require the user's approval.",
        RiskTier::Financial => {
            "Financial: never executes directly. Creates a draft that the user must approve in Tessera."
        }
    };
    json!({
        "name": mcp,
        "title": d.title,
        "description": format!("{} {}", d.description, risk_note).trim().to_owned(),
        "inputSchema": schema,
        "annotations": {
            "title": d.title,
            "readOnlyHint": d.risk == RiskTier::Read,
            "destructiveHint": d.risk == RiskTier::Financial,
            "idempotentHint": d.idempotent,
            "openWorldHint": false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_protocol::tools::UiHints;

    fn desc(name: &str, risk: RiskTier, user_only: bool) -> ToolDescriptor {
        ToolDescriptor {
            name: name.into(),
            mcp_name: mcp_name(name),
            title: "T".into(),
            description: "Does things.".into(),
            risk,
            category: name.split('.').next().unwrap().into(),
            input_schema: json!({"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {"a": {"type": "string"}}}),
            output_schema: json!({}),
            ui_hints: UiHints::default(),
            idempotent: risk == RiskTier::Read,
            user_only,
        }
    }

    #[test]
    fn maps_names_and_hides_user_only_tools() {
        let m = McpToolMap::new([
            desc("market.get_candles", RiskTier::Read, false),
            desc("orders.submit", RiskTier::Financial, false),
            desc("chart.report_viewport", RiskTier::Modify, true),
        ]);
        assert_eq!(m.len(), 2);
        assert_eq!(m.resolve("market_get_candles"), Some("market.get_candles"));
        assert_eq!(m.resolve("chart_report_viewport"), None);
        let defs = m.definitions();
        let submit = defs.iter().find(|d| d["name"] == "orders_submit").unwrap();
        assert_eq!(submit["annotations"]["destructiveHint"], true);
        assert!(
            submit["description"]
                .as_str()
                .unwrap()
                .contains("must approve")
        );
        assert!(submit["inputSchema"].get("$schema").is_none());
        let candles = defs
            .iter()
            .find(|d| d["name"] == "market_get_candles")
            .unwrap();
        assert_eq!(candles["annotations"]["readOnlyHint"], true);
    }
}
