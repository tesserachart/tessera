use serde_json::Value;

#[derive(Clone, Copy, Debug)]
pub enum Field {
    Copied(&'static str),
    Has(&'static str),
    Count(&'static str),
}

impl Field {
    pub fn name(self) -> &'static str {
        match self {
            Field::Copied(n) | Field::Has(n) | Field::Count(n) => n,
        }
    }

    pub fn read(self, input: &Value) -> Option<Value> {
        let v = input.get(self.name())?;
        match self {
            Field::Copied(_) => matches!(v, Value::String(_) | Value::Bool(_)).then(|| v.clone()),
            Field::Has(_) => Some(Value::Bool(!v.is_null())),
            Field::Count(_) => v.as_array().map(|a| Value::from(a.len())),
        }
    }
}

pub struct Tracked {
    pub tool: &'static str,
    pub event: &'static str,
    pub fields: &'static [Field],
    pub set: &'static [(&'static str, &'static str)],
}

const fn row(tool: &'static str, event: &'static str, fields: &'static [Field]) -> Tracked {
    Tracked {
        tool,
        event,
        fields,
        set: &[],
    }
}

use Field::{Copied, Count, Has};

pub const TRACKED: &[Tracked] = &[
    row(
        "orders.submit",
        "order placed",
        &[
            Copied("instrument"),
            Copied("orderType"),
            Copied("tif"),
            Has("bracket"),
        ],
    ),
    row("orders.modify", "order modified", &[]),
    Tracked {
        set: &[("scope", "one")],
        ..row("orders.cancel", "order cancelled", &[])
    },
    Tracked {
        set: &[("scope", "all")],
        ..row(
            "orders.cancel_all",
            "order cancelled",
            &[Copied("instrument")],
        )
    },
    row("orders.flatten", "position flattened", &[Has("instrument")]),
    row(
        "orders.reverse",
        "position reversed",
        &[Copied("instrument"), Has("bracket")],
    ),
    row("orders.breakeven", "stop moved to breakeven", &[]),
    Tracked {
        set: &[("kind", "rithmic")],
        ..row("connections.add_rithmic", "connection added", &[])
    },
    Tracked {
        set: &[("kind", "levels")],
        ..row(
            "connections.add_level_source",
            "connection added",
            &[Copied("builtin")],
        )
    },
    row("connections.remove", "connection removed", &[]),
    row(
        "mcp.add_client",
        "agent client connected",
        &[Copied("kind")],
    ),
    Tracked {
        set: &[("kind", "chat")],
        ..row(
            "agent.start_session",
            "analyst session started",
            &[
                Copied("provider"),
                Copied("model"),
                Copied("effort"),
                Copied("mode"),
            ],
        )
    },
    Tracked {
        set: &[("kind", "trading")],
        ..row(
            "agent.start_trading_session",
            "analyst session started",
            &[],
        )
    },
    row("research.save_study", "study saved", &[]),
    row("research.run_study", "research run", &[]),
    row(
        "copy.create",
        "copy group created",
        &[Count("followers"), Copied("enabled")],
    ),
    row("copy.update", "copy group changed", &[Has("followers")]),
    row("copy.enable", "copy group enabled", &[]),
    row("copy.disable", "copy group disabled", &[]),
    row("copy.flatten", "copy group flattened", &[]),
    row("copy.resync", "copy group resynced", &[]),
    row("copy.delete", "copy group deleted", &[]),
    row(
        "journal.import_csv",
        "journal imported",
        &[Copied("platform")],
    ),
    row(
        "journal.log_trade",
        "journal trade logged",
        &[Copied("symbol")],
    ),
    row(
        "journal.update_trade",
        "journal trade reviewed",
        &[
            Has("notes"),
            Has("setupId"),
            Has("rating"),
            Copied("reviewed"),
            Has("emotion"),
            Has("exitReason"),
            Has("tagIds"),
            Has("rules"),
        ],
    ),
    row(
        "journal.bulk_update",
        "journal trades edited",
        &[Count("ids")],
    ),
    row(
        "journal.save_day",
        "journal day reviewed",
        &[Has("content"), Has("checks")],
    ),
    row("journal.save_setup", "journal setup saved", &[]),
    row("journal.save_tag", "journal tag saved", &[]),
    row("journal.save_checklist", "journal checklist saved", &[]),
    row("journal.add_attachment", "journal attachment added", &[]),
    row("journal.export_trades", "journal exported", &[]),
    row(
        "alerts.create",
        "alert created",
        &[Copied("instrument"), Count("steps"), Copied("askAnalyst")],
    ),
    row("alerts.set_discord", "discord connected", &[]),
    row("indicators.create_custom", "custom indicator created", &[]),
    row(
        "market.open_replay",
        "replay opened",
        &[Copied("instrument"), Copied("source")],
    ),
    row(
        "market.pull_trades",
        "trades pulled",
        &[Copied("instrument")],
    ),
    row("watchlists.create", "watchlist created", &[]),
    row(
        "workspace.apply_preset",
        "workspace preset applied",
        &[Copied("preset")],
    ),
];

pub fn tracked(tool: &str) -> Option<&'static Tracked> {
    TRACKED.iter().find(|t| t.tool == tool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_field_never_carries_a_number_an_id_or_words() {
        let input = json!({"qty": 3, "limitPrice": 20641.25, "accountId": "APEX-1", "instrument": "NQZ6",
                           "bracket": {"stopTicks": 8}, "notes": "my words", "followers": [{"accountId": "A"}, {}]});
        assert_eq!(Copied("qty").read(&input), None);
        assert_eq!(Copied("limitPrice").read(&input), None);
        assert_eq!(Copied("instrument").read(&input), Some(json!("NQZ6")));
        assert_eq!(Has("bracket").read(&input), Some(json!(true)));
        assert_eq!(Has("notes").read(&input), Some(json!(true)));
        assert_eq!(Count("followers").read(&input), Some(json!(2)));
        assert_eq!(Has("setupId").read(&input), None);
    }

    #[test]
    fn no_row_names_a_private_field() {
        const PRIVATE: &[&str] = &[
            "account", "price", "qty", "size", "balance", "pnl", "notes", "content", "text",
            "message", "csv", "name", "prompt", "login", "password", "key", "email",
        ];
        for t in TRACKED {
            for f in t.fields {
                let lower = f.name().to_lowercase();
                let copies = matches!(f, Copied(_));
                assert!(
                    !(copies && PRIVATE.iter().any(|p| lower.contains(p))),
                    "{} copies {}",
                    t.tool,
                    f.name()
                );
            }
        }
    }
}
