use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::CallId;
use tessera_protocol::tools::{RiskTier, ToolOutcome, ToolResult};
use tessera_tools::gate::pattern_matches;
use tessera_tools::{Audience, InvokeRequest, Invoker};

use crate::{MCP_PROTOCOL_VERSION, McpToolMap};

pub const SUPPORTED_VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];

pub trait McpHook: Send + Sync {
    fn calling(&self, origin: &Origin, call: &CallId, tool: &str, risk: RiskTier, args: &Value);
    fn called(
        &self,
        origin: &Origin,
        call: &CallId,
        tool: &str,
        risk: RiskTier,
        result: &ToolResult,
    );
}

pub struct McpService {
    invoker: Arc<Invoker>,
    hook: Option<Arc<dyn McpHook>>,
    version: String,
}

impl std::fmt::Debug for McpService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpService").finish_non_exhaustive()
    }
}

fn reply(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn fail(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

impl McpService {
    pub fn new(
        invoker: Arc<Invoker>,
        hook: Option<Arc<dyn McpHook>>,
        version: impl Into<String>,
    ) -> Self {
        Self {
            invoker,
            hook,
            version: version.into(),
        }
    }

    fn tools(&self, origin: &Origin) -> McpToolMap {
        let policy = self.invoker.policy_for(origin);
        let ro = matches!(policy.mode, tessera_protocol::tools::SessionMode::ReadOnly);
        McpToolMap::new(
            self.invoker
                .registry()
                .descriptors(Audience::Agent, None, false)
                .into_iter()
                .filter(|d| !policy.deny.iter().any(|p| pattern_matches(p, &d.name)))
                .filter(|d| {
                    policy
                        .allow
                        .as_ref()
                        .is_none_or(|a| a.iter().any(|p| pattern_matches(p, &d.name)))
                })
                .filter(|d| !ro || d.risk == RiskTier::Read),
        )
    }

    pub async fn handle(&self, origin: &Origin, msg: Value) -> Option<Value> {
        let method = msg
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let id = msg.get("id").cloned()?;
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        Some(match method.as_str() {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str);
                let version = asked
                    .filter(|v| SUPPORTED_VERSIONS.contains(v))
                    .unwrap_or(MCP_PROTOCOL_VERSION);
                reply(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": "tessera", "title": "Tessera", "version": self.version},
                        "instructions": "Tessera's trading workspace. Read the chart and the market before \
                            you act; orders are drafts the user approves in Tessera unless the user put your \
                            session in Full access, and a change to the Trade panel (trade_set_panel) always asks the user too. Everything else the user can do \
                            in the app has a tool: areas (ui_show_area), the desk (workspace_*), charts (chart_*), \
                            markets and watchlists (market_*, watchlists_*), every preference (settings_get, settings_set), the journal, research and indicators. \
                            Present research as measured statistics, hypotheses or interpretation, never as \
                            guaranteed outcomes."
                    }),
                )
            }
            "ping" => reply(&id, json!({})),
            "tools/list" => reply(&id, json!({"tools": self.tools(origin).definitions()})),
            "tools/call" => self.call(&id, origin, &params).await,
            _ => fail(&id, -32601, format!("unknown method {method}")),
        })
    }

    async fn call(&self, id: &Value, origin: &Origin, params: &Value) -> Value {
        let Some(mcp) = params.get("name").and_then(Value::as_str) else {
            return fail(id, -32602, "tools/call needs a name");
        };
        let map = self.tools(origin);
        let Some(name) = map.resolve(mcp).map(str::to_owned) else {
            return fail(id, -32602, format!("no tool {mcp}"));
        };
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let risk = self
            .invoker
            .registry()
            .descriptors(Audience::Agent, None, true)
            .into_iter()
            .find(|d| d.name == name)
            .map_or(RiskTier::Read, |d| d.risk);
        let call = CallId::generate();
        if let Some(h) = &self.hook {
            h.calling(origin, &call, &name, risk, &args);
        }
        let result = self
            .invoker
            .invoke(
                InvokeRequest::new(name.clone(), args, origin.clone()).with_call_id(call.clone()),
            )
            .await;
        if let Some(h) = &self.hook {
            h.called(origin, &call, &name, risk, &result);
        }
        reply(id, content(&result))
    }
}

fn content(r: &ToolResult) -> Value {
    let text = match r.status {
        ToolOutcome::Ok => r
            .output
            .as_ref()
            .map_or_else(|| "ok".to_owned(), Value::to_string),
        ToolOutcome::PendingApproval => {
            let id = r
                .approval
                .as_ref()
                .map(|a| a.approval_id.to_string())
                .unwrap_or_default();
            let waits = r
                .output
                .as_ref()
                .and_then(|o| o["message"].as_str())
                .unwrap_or("Drafted, not sent.");
            format!(
                "{waits} The user approves or rejects it in Tessera (approval {id}). Tell the user it waits \
                 for them until then, and do not retry."
            )
        }
        ToolOutcome::Denied | ToolOutcome::Error => r.error.as_ref().map_or_else(
            || "refused".to_owned(),
            |e| format!("{:?}: {}", e.code, e.message),
        ),
    };
    let mut out = json!({"content": [{"type": "text", "text": text}], "isError": !r.ok && r.status != ToolOutcome::PendingApproval});
    if let (ToolOutcome::Ok, Some(Value::Object(o))) = (r.status, &r.output) {
        out["structuredContent"] = Value::Object(o.clone());
    }
    out
}
