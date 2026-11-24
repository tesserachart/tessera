use tessera_protocol::agent::{AgentEffort, AgentModel};

pub fn effort_label(id: &str) -> String {
    match id {
        "none" => "None".into(),
        "minimal" => "Minimal".into(),
        "low" => "Low".into(),
        "medium" => "Medium".into(),
        "high" => "High".into(),
        "xhigh" => "Extra high".into(),
        "max" => "Max".into(),
        "ultra" => "Ultra".into(),
        other => {
            let mut c = other.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        }
    }
}

fn efforts(ids: &[&str]) -> Vec<AgentEffort> {
    ids.iter()
        .map(|id| AgentEffort {
            id: (*id).to_owned(),
            label: effort_label(id),
        })
        .collect()
}

fn model(id: &str, label: &str, description: &str, levels: &[&str], default: &str) -> AgentModel {
    AgentModel {
        id: id.into(),
        label: label.into(),
        description: Some(description.into()).filter(|d: &String| !d.is_empty()),
        efforts: efforts(levels),
        default_effort: Some(default.into()).filter(|d: &String| !d.is_empty()),
    }
}

const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

struct ClaudeModel {
    model: fn() -> AgentModel,
    min_version: (u32, u32, u32),
}

const CLAUDE_MODELS: [ClaudeModel; 4] = [
    ClaudeModel {
        model: || {
            model(
                "claude-fable-5-1",
                "Claude Fable 5.1",
                "",
                &CLAUDE_EFFORTS,
                "medium",
            )
        },
        min_version: (2, 1, 257),
    },
    ClaudeModel {
        model: || {
            model(
                "claude-opus-5-5",
                "Claude Opus 5.5",
                "",
                &CLAUDE_EFFORTS,
                "medium",
            )
        },
        min_version: (2, 1, 280),
    },
    ClaudeModel {
        model: || {
            model(
                "claude-sonnet-5-5",
                "Claude Sonnet 5.5",
                "",
                &CLAUDE_EFFORTS,
                "high",
            )
        },
        min_version: (2, 1, 284),
    },
    ClaudeModel {
        model: || {
            model(
                "claude-haiku-5-5",
                "Claude Haiku 5.5",
                "",
                &CLAUDE_EFFORTS,
                "medium",
            )
        },
        min_version: (2, 1, 293),
    },
];

pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|word| {
            let mut parts = word.split('.').map(str::parse::<u32>);
            match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some(Ok(a)), Some(Ok(b)), Some(Ok(c)), None) => Some((a, b, c)),
                _ => None,
            }
        })
}

pub fn claude_models(version: Option<(u32, u32, u32)>) -> Vec<AgentModel> {
    CLAUDE_MODELS
        .iter()
        .filter(|m| version.is_none_or(|v| v >= m.min_version))
        .map(|m| (m.model)())
        .collect()
}

pub fn codex_fallback_models() -> Vec<AgentModel> {
    let levels = ["low", "medium", "high", "xhigh"];
    vec![
        model("gpt-6-astra", "GPT-6 Astra", "", &levels, "medium"),
        model("gpt-6.1-sol", "GPT-6.1 Sol", "", &levels, "medium"),
        model("gpt-6-luna", "GPT-6 Luna", "", &levels, "medium"),
    ]
}

pub fn codex_models_from(list: &serde_json::Value) -> Vec<AgentModel> {
    let Some(data) = list.get("data").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<(bool, AgentModel)> = data
        .iter()
        .filter(|m| m.get("hidden").and_then(serde_json::Value::as_bool) != Some(true))
        .filter_map(|m| {
            let id = m
                .get("model")
                .or_else(|| m.get("id"))
                .and_then(serde_json::Value::as_str)?;
            let label = m
                .get("displayName")
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(id);
            let levels: Vec<AgentEffort> = m
                .get("supportedReasoningEfforts")
                .and_then(serde_json::Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|e| {
                            e.get("reasoningEffort")
                                .or(Some(e))
                                .and_then(serde_json::Value::as_str)
                        })
                        .map(|id| AgentEffort {
                            id: id.to_owned(),
                            label: effort_label(id),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let default_effort = m
                .get("defaultReasoningEffort")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let model = AgentModel {
                id: id.to_owned(),
                label: label.to_owned(),
                description: m
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .filter(|d| !d.is_empty())
                    .map(str::to_owned),
                efforts: levels,
                default_effort,
            };
            let default = m.get("isDefault").and_then(serde_json::Value::as_bool) == Some(true);
            Some((default, model))
        })
        .collect();
    out.sort_by_key(|(default, _)| !*default);
    out.into_iter().map(|(_, m)| m).collect()
}

pub fn takes_effort(model: &AgentModel, effort: &str) -> bool {
    model.efforts.iter().any(|e| e.id == effort)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_models_follow_the_installed_version() {
        assert_eq!(parse_version("2.1.289 (Claude Code)"), Some((2, 1, 289)));
        assert_eq!(parse_version("claude v2.1.3"), Some((2, 1, 3)));
        assert_eq!(parse_version("nothing"), None);
        let ids = |v| {
            claude_models(v)
                .into_iter()
                .map(|m| m.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(Some((2, 1, 289))),
            vec!["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]
        );
        assert_eq!(ids(None).len(), 4);
        let opus = &claude_models(None)[1];
        assert_eq!(opus.efforts[3].label, "Extra high");
        assert!(takes_effort(opus, "max") && !takes_effort(opus, "ultra"));
    }

    #[test]
    fn codex_lists_its_visible_models_default_first() {
        let list = json!({"data": [
            {"id": "a", "model": "gpt-6-luna", "displayName": "GPT-6 Luna", "hidden": false,
             "supportedReasoningEfforts": [{"reasoningEffort": "low", "description": ""}],
             "defaultReasoningEffort": "low", "isDefault": false},
            {"id": "b", "model": "gpt-hidden", "displayName": "x", "hidden": true, "isDefault": false},
            {"id": "c", "model": "gpt-6-astra", "displayName": "GPT-6 Astra", "hidden": false,
             "supportedReasoningEfforts": [{"reasoningEffort": "medium"}, {"reasoningEffort": "xhigh"}],
             "defaultReasoningEffort": "medium", "isDefault": true}
        ], "nextCursor": null});
        let models = codex_models_from(&list);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-6-astra");
        assert_eq!(models[0].efforts[1].label, "Extra high");
        assert_eq!(models[1].default_effort.as_deref(), Some("low"));
    }
}
