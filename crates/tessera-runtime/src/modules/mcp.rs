use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use tessera_core::ids::numbered;
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{Origin, SharedClock, Timestamp};
use tessera_host::{RuntimeModule, TsExports};
use tessera_mcp::setup::{self, Launch};
use tessera_mcp::tokens;
use tessera_protocol::mcp::{
    CLIENT_NAME_MAX, McpAddClientInput, McpAddClientOutput, McpAddToClaudeDesktopInput,
    McpAddToClaudeDesktopOutput, McpClientInfo, McpClientKind, McpClientPolicy,
    McpListClientsInput, McpListClientsOutput, McpRevokeClientInput, McpRevokeClientOutput,
    McpSetClientPolicyInput, McpSetClientPolicyOutput,
};
use tessera_protocol::tools::{RiskTier, SessionMode};
use tessera_store::{McpClientRecord, Store};
use tessera_tools::{
    RegistryError, SessionPolicy, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry,
};

const TOUCH_EVERY_NANOS: i64 = 60 * NANOS_PER_SEC;
const CLIENTS_OF_A_KIND_MAX: usize = 9_999;

pub const CLIENT_TURN_NANOS: i64 = 60 * NANOS_PER_SEC;

#[derive(Clone)]
struct Live {
    info: McpClientInfo,
    token_hash: String,
    touched: Option<Timestamp>,
    turn: Option<Timestamp>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpCaller {
    pub origin: Origin,
    pub policy: SessionPolicy,
    pub new_turn: bool,
}

pub struct McpClients {
    store: Store,
    clock: SharedClock,
    live: RwLock<Vec<Live>>,
    launch: Launch,
    claude_desktop: Option<PathBuf>,
    invoker: std::sync::OnceLock<std::sync::Weak<tessera_tools::Invoker>>,
}

impl std::fmt::Debug for McpClients {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClients")
            .field("clients", &self.live.read().len())
            .finish_non_exhaustive()
    }
}

fn store_err(e: impl std::fmt::Display) -> ToolError {
    ToolError::internal(format!("the database: {e}"))
}

fn info_of(r: &McpClientRecord) -> McpClientInfo {
    McpClientInfo {
        id: r.id.clone(),
        name: r.name.clone(),
        kind: McpClientKind::parse(&r.kind).unwrap_or(McpClientKind::Other),
        policy: McpClientPolicy::parse(&r.policy).unwrap_or_default(),
        created_at: r.created_at,
        last_used_at: r.last_used_at,
    }
}

pub fn session_policy(policy: McpClientPolicy) -> SessionPolicy {
    SessionPolicy::with_mode(match policy {
        McpClientPolicy::ReadOnly => SessionMode::ReadOnly,
        McpClientPolicy::Supervised => SessionMode::Supervised,
    })
}

impl McpClients {
    pub fn load(
        store: Store,
        clock: SharedClock,
        launch: Launch,
        claude_desktop: Option<PathBuf>,
    ) -> anyhow::Result<Arc<Self>> {
        let live = store
            .mcp_clients()
            .active()?
            .into_iter()
            .map(|r| Live {
                info: info_of(&r),
                touched: r.last_used_at,
                token_hash: r.token_hash,
                turn: None,
            })
            .collect();
        Ok(Arc::new(Self {
            store,
            clock,
            live: RwLock::new(live),
            launch,
            claude_desktop,
            invoker: std::sync::OnceLock::new(),
        }))
    }

    pub fn attach_invoker(&self, invoker: &Arc<tessera_tools::Invoker>) {
        let _ = self.invoker.set(Arc::downgrade(invoker));
    }

    pub fn resolve(&self, token: &str) -> Option<McpCaller> {
        let hash = tokens::hash(token);
        let now = self.clock.now();
        let (id, policy, touch, new_turn) = {
            let mut live = self.live.write();
            let mut hit = None;
            for (i, c) in live.iter().enumerate() {
                if tessera_core::token::constant_time_eq(c.token_hash.as_bytes(), hash.as_bytes()) {
                    hit = Some(i);
                }
            }
            let c = &mut live[hit?];
            c.info.last_used_at = Some(now);
            let touch = c
                .touched
                .is_none_or(|t| now.0.saturating_sub(t.0) >= TOUCH_EVERY_NANOS);
            if touch {
                c.touched = Some(now);
            }
            let new_turn = c
                .turn
                .is_none_or(|t| now.0.saturating_sub(t.0) >= CLIENT_TURN_NANOS);
            if new_turn {
                c.turn = Some(now);
            }
            (c.info.id.clone(), c.info.policy, touch, new_turn)
        };
        if touch {
            let store = self.store.clone();
            let client = id.clone();
            let write = move || {
                if let Err(e) = store.mcp_clients().touch(&client, now) {
                    tracing::warn!(client = %client, error = %e, "could not note an MCP client's use");
                }
            };
            match tokio::runtime::Handle::try_current() {
                Ok(h) => drop(h.spawn_blocking(write)),
                Err(_) => write(),
            }
        }
        Some(McpCaller {
            origin: Origin::External { client_id: id },
            policy: session_policy(policy),
            new_turn,
        })
    }

    pub fn list(&self) -> Vec<McpClientInfo> {
        self.live.read().iter().map(|c| c.info.clone()).collect()
    }

    fn new_id(&self, kind: McpClientKind) -> Result<String, ToolError> {
        let taken = self.store.mcp_clients().ids().map_err(store_err)?;
        let base = kind.as_str();
        numbered(base, "-")
            .take(CLIENTS_OF_A_KIND_MAX)
            .find(|id| !taken.contains(id))
            .ok_or_else(|| ToolError::conflict("too many clients of this kind"))
    }

    pub fn add(&self, input: McpAddClientInput) -> Result<McpAddClientOutput, ToolError> {
        let name = match input.name.as_deref().map(str::trim) {
            None | Some("") => input.kind.label().to_owned(),
            Some(n) if n.chars().count() > CLIENT_NAME_MAX => {
                return Err(ToolError::invalid_input(format!(
                    "a client's name is at most {CLIENT_NAME_MAX} characters"
                )));
            }
            Some(n) => n.to_owned(),
        };
        let token = tokens::mint().map_err(|e| ToolError::internal(e.to_string()))?;
        let record = McpClientRecord {
            id: self.new_id(input.kind)?,
            name,
            kind: input.kind.as_str().to_owned(),
            token_hash: tokens::hash(&token),
            policy: input.policy.unwrap_or_default().as_str().to_owned(),
            created_at: self.clock.now(),
            last_used_at: None,
            revoked_at: None,
        };
        self.store
            .mcp_clients()
            .insert(&record)
            .map_err(store_err)?;
        let info = info_of(&record);
        self.live.write().push(Live {
            info: info.clone(),
            token_hash: record.token_hash,
            touched: None,
            turn: None,
        });
        tracing::info!(client = %info.id, kind = info.kind.as_str(), "MCP client connected");
        Ok(McpAddClientOutput {
            snippets: setup::snippets(input.kind, &self.launch, &token),
            client: info,
            token,
        })
    }

    pub fn revoke(&self, id: &str) -> Result<bool, ToolError> {
        let revoked = self
            .store
            .mcp_clients()
            .revoke(id, self.clock.now())
            .map_err(store_err)?;
        let mut live = self.live.write();
        let before = live.len();
        live.retain(|c| c.info.id != id);
        let dropped = live.len() != before;
        drop(live);
        if let Some(inv) = self.invoker.get().and_then(std::sync::Weak::upgrade) {
            inv.close(&Origin::External {
                client_id: id.to_owned(),
            });
        }
        if revoked || dropped {
            tracing::info!(client = %id, "MCP client revoked");
        }
        Ok(revoked || dropped)
    }

    pub fn set_policy(
        &self,
        id: &str,
        policy: McpClientPolicy,
    ) -> Result<McpClientInfo, ToolError> {
        if !self
            .store
            .mcp_clients()
            .set_policy(id, policy.as_str())
            .map_err(store_err)?
        {
            return Err(ToolError::not_found(format!("no connected client {id}")));
        }
        let mut live = self.live.write();
        let c = live
            .iter_mut()
            .find(|c| c.info.id == id)
            .ok_or_else(|| ToolError::not_found(format!("no connected client {id}")))?;
        c.info.policy = policy;
        Ok(c.info.clone())
    }

    pub fn add_to_claude_desktop(
        &self,
        id: &str,
        token: &str,
    ) -> Result<McpAddToClaudeDesktopOutput, ToolError> {
        let Some(path) = &self.claude_desktop else {
            return Err(ToolError::unavailable(
                "Tessera doesn’t know where Claude Desktop’s config is on this computer",
            ));
        };
        let hash = tokens::hash(token);
        let ok = self.live.read().iter().any(|c| {
            c.info.id == id
                && tessera_core::token::constant_time_eq(c.token_hash.as_bytes(), hash.as_bytes())
        });
        if !ok {
            return Err(ToolError::invalid_input(format!(
                "that token is not connected client {id}’s"
            )));
        }
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let merged = setup::merge_claude_desktop(path, &self.launch, token, &stamp)
            .map_err(|e| ToolError::unavailable(e.to_string()))?;
        tracing::info!(client = %id, path = %merged.path.display(), "added to Claude Desktop's config");
        Ok(McpAddToClaudeDesktopOutput {
            path: merged.path.display().to_string(),
            backup: merged.backup.map(|b| b.display().to_string()),
        })
    }
}

pub struct McpModule {
    clients: Arc<McpClients>,
}

impl std::fmt::Debug for McpModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpModule").finish_non_exhaustive()
    }
}

impl McpModule {
    pub fn new(clients: Arc<McpClients>) -> Self {
        Self { clients }
    }
}

impl RuntimeModule for McpModule {
    fn name(&self) -> &'static str {
        "mcp"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(ListClients(Arc::clone(&self.clients)))?;
        r.register(AddClient(Arc::clone(&self.clients)))?;
        r.register(RevokeClient(Arc::clone(&self.clients)))?;
        r.register(SetClientPolicy(Arc::clone(&self.clients)))?;
        r.register(AddToClaudeDesktop(Arc::clone(&self.clients)))?;
        Ok(())
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (mcp)")
        .tool::<McpListClientsInput, McpListClientsOutput>("mcp.list_clients")
        .tool::<McpAddClientInput, McpAddClientOutput>("mcp.add_client")
        .tool::<McpRevokeClientInput, McpRevokeClientOutput>("mcp.revoke_client")
        .tool::<McpSetClientPolicyInput, McpSetClientPolicyOutput>("mcp.set_client_policy")
        .tool::<McpAddToClaudeDesktopInput, McpAddToClaudeDesktopOutput>(
            "mcp.add_to_claude_desktop",
        )
}

struct ListClients(Arc<McpClients>);

#[async_trait]
impl Tool for ListClients {
    type Input = McpListClientsInput;
    type Output = McpListClientsOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("mcp.list_clients", "List connected agents", RiskTier::Read)
            .description("The user's own agents connected to Tessera as MCP clients (Claude Desktop, Claude Code, Codex, Cursor…): each one's name, kind, policy and when it was connected and last used. Never a token.")
            .user_only()
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: McpListClientsInput,
    ) -> Result<McpListClientsOutput, ToolError> {
        Ok(McpListClientsOutput {
            clients: self.0.list(),
        })
    }
}

struct AddClient(Arc<McpClients>);

#[async_trait]
impl Tool for AddClient {
    type Input = McpAddClientInput;
    type Output = McpAddClientOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("mcp.add_client", "Connect an agent", RiskTier::Modify)
            .description("Connects one of the user's own agents (Claude Desktop, Claude Code, Codex, Cursor or another MCP client) to Tessera: a bearer token, shown this once and kept only as its hash, and ready-to-use setup for that client carrying it. It runs Supervised unless told Read only.")
            .user_only()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: McpAddClientInput,
    ) -> Result<McpAddClientOutput, ToolError> {
        self.0.add(input)
    }

    fn summarize(&self, out: &McpAddClientOutput) -> Option<String> {
        Some(out.client.name.clone())
    }
}

struct RevokeClient(Arc<McpClients>);

#[async_trait]
impl Tool for RevokeClient {
    type Input = McpRevokeClientInput;
    type Output = McpRevokeClientOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("mcp.revoke_client", "Revoke an agent", RiskTier::Modify)
            .description(
                "Disconnects one of the user's agents: its token is refused from its next request.",
            )
            .user_only()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: McpRevokeClientInput,
    ) -> Result<McpRevokeClientOutput, ToolError> {
        Ok(McpRevokeClientOutput {
            revoked: self.0.revoke(&input.id)?,
        })
    }
}

struct SetClientPolicy(Arc<McpClients>);

#[async_trait]
impl Tool for SetClientPolicy {
    type Input = McpSetClientPolicyInput;
    type Output = McpSetClientPolicyOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "mcp.set_client_policy",
            "Set what an agent may do",
            RiskTier::Modify,
        )
        .description("Sets one of the user's connected agents to Read only (it reads; changes and orders are not even listed to it) or Supervised (a change asks the user first; an order is a draft the user approves), from its next call.")
        .user_only()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: McpSetClientPolicyInput,
    ) -> Result<McpSetClientPolicyOutput, ToolError> {
        Ok(McpSetClientPolicyOutput {
            client: self.0.set_policy(&input.id, input.policy)?,
        })
    }
}

struct AddToClaudeDesktop(Arc<McpClients>);

#[async_trait]
impl Tool for AddToClaudeDesktop {
    type Input = McpAddToClaudeDesktopInput;
    type Output = McpAddToClaudeDesktopOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "mcp.add_to_claude_desktop",
            "Add to Claude Desktop",
            RiskTier::Modify,
        )
        .description("Puts a just-connected client's entry (mcpServers.tessera) into Claude Desktop's config file, keeping everything else in it, after copying the file to a backup beside it. Only when the user asks.")
        .user_only()
        .redact(&["token"])
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: McpAddToClaudeDesktopInput,
    ) -> Result<McpAddToClaudeDesktopOutput, ToolError> {
        let clients = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || clients.add_to_claude_desktop(&input.id, &input.token))
            .await
            .map_err(|e| ToolError::internal(e.to_string()))?
    }

    fn summarize(&self, out: &McpAddToClaudeDesktopOutput) -> Option<String> {
        Some(out.path.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::Redactor;
    use tessera_core::Clock;
    use tessera_core::clock::ManualClock;

    fn clients(claude_desktop: Option<PathBuf>) -> (Store, Arc<ManualClock>, Arc<McpClients>) {
        let store = Store::open_in_memory().unwrap();
        let clock = Arc::new(ManualClock::new(Timestamp(1_000 * NANOS_PER_SEC)));
        let launch = Launch::new(
            std::path::Path::new("/opt/tessera/tessera-runtime"),
            None,
            None,
        );
        let c = McpClients::load(store.clone(), clock.clone(), launch, claude_desktop).unwrap();
        (store, clock, c)
    }

    fn add(c: &McpClients, kind: McpClientKind) -> McpAddClientOutput {
        c.add(McpAddClientInput {
            kind,
            name: None,
            policy: None,
        })
        .unwrap()
    }

    #[test]
    fn a_client_is_kept_as_a_hash_and_comes_back_after_a_restart() {
        let (store, clock, c) = clients(None);
        let out = add(&c, McpClientKind::ClaudeDesktop);
        assert_eq!(out.client.id, "claude-desktop");
        assert_eq!(out.client.name, "Claude Desktop");
        assert_eq!(out.client.policy, McpClientPolicy::Supervised);
        assert!(out.token.starts_with("tsk_") && out.token.len() == 68);
        assert!(out.snippets[0].text.contains(&out.token));
        let conn = store.conn().unwrap();
        let dump: String = conn
            .query_row(
                "SELECT client_id || name || kind || token_hash || policy FROM mcp_clients",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!dump.contains(&out.token[4..]));
        assert!(dump.contains(&tokens::hash(&out.token)));
        assert!(
            !Redactor::global()
                .redact(&out.token)
                .contains(&out.token[4..])
        );

        assert_eq!(
            add(&c, McpClientKind::ClaudeDesktop).client.id,
            "claude-desktop-2"
        );

        let again = McpClients::load(
            store.clone(),
            clock.clone(),
            Launch::new(std::path::Path::new("/x"), None, None),
            None,
        )
        .unwrap();
        let caller = again.resolve(&out.token).unwrap();
        assert_eq!(
            caller.origin,
            Origin::External {
                client_id: "claude-desktop".into()
            }
        );
        assert_eq!(caller.policy.mode, SessionMode::Supervised);
        assert!(again.resolve("tsk_0000").is_none());
        assert!(again.resolve(&format!("{}0", out.token)).is_none());
    }

    #[test]
    fn revoking_a_client_cancels_what_it_left_waiting_for_approval() {
        let (_store, clock, c) = clients(None);
        let inv = Arc::new(tessera_tools::Invoker::new(
            Arc::new(ToolRegistry::new()),
            Arc::new(tessera_tools::NullObserver),
            clock.clone(),
            tessera_tools::InvokerConfig::default(),
        ));
        c.attach_invoker(&inv);
        let out = add(&c, McpClientKind::Cursor);
        let origin = c.resolve(&out.token).unwrap().origin;
        let asked = inv.approvals().create(
            tessera_tools::approvals::NewApproval {
                kind: tessera_protocol::tools::ApprovalKind::Financial,
                origin,
                call_id: tessera_core::ids::CallId::generate(),
                tool: "orders.submit".into(),
                risk: RiskTier::Financial,
                input: serde_json::json!({"qty": 1}),
                preview: serde_json::json!({"restatement": "BUY 1 NQ MKT"}),
                draft_id: None,
                environment: None,
                instrument: None,
                replaces: None,
            },
            clock.now(),
        );
        assert!(c.revoke(&out.client.id).unwrap());
        assert_eq!(
            inv.approvals().get(&asked.id).unwrap().status,
            tessera_protocol::tools::ApprovalStatus::Cancelled
        );
    }

    #[test]
    fn revoking_takes_effect_at_once_and_never_frees_the_id() {
        let (store, _clock, c) = clients(None);
        let out = add(&c, McpClientKind::Cursor);
        assert!(c.resolve(&out.token).is_some());
        assert!(c.revoke("cursor").unwrap());
        assert!(
            c.resolve(&out.token).is_none(),
            "refused from the next request"
        );
        assert!(!c.revoke("cursor").unwrap());
        assert!(c.list().is_empty());
        assert_eq!(add(&c, McpClientKind::Cursor).client.id, "cursor-2");
        let again = McpClients::load(
            store,
            Arc::new(ManualClock::new(Timestamp(0))),
            Launch::new(std::path::Path::new("/x"), None, None),
            None,
        )
        .unwrap();
        assert!(again.resolve(&out.token).is_none());
    }

    #[test]
    fn the_policy_applies_from_the_next_call_and_is_kept() {
        let (store, clock, c) = clients(None);
        let out = c
            .add(McpAddClientInput {
                kind: McpClientKind::Other,
                name: Some("  My script ".into()),
                policy: Some(McpClientPolicy::ReadOnly),
            })
            .unwrap();
        assert_eq!(
            (out.client.id.as_str(), out.client.name.as_str()),
            ("other", "My script")
        );
        assert_eq!(
            c.resolve(&out.token).unwrap().policy.mode,
            SessionMode::ReadOnly
        );
        let set = c.set_policy("other", McpClientPolicy::Supervised).unwrap();
        assert_eq!(set.policy, McpClientPolicy::Supervised);
        assert_eq!(
            c.resolve(&out.token).unwrap().policy.mode,
            SessionMode::Supervised
        );
        assert!(c.set_policy("nobody", McpClientPolicy::ReadOnly).is_err());
        let again = McpClients::load(
            store,
            clock,
            Launch::new(std::path::Path::new("/x"), None, None),
            None,
        )
        .unwrap();
        assert_eq!(again.list()[0].policy, McpClientPolicy::Supervised);
        assert!(
            c.add(McpAddClientInput {
                kind: McpClientKind::Other,
                name: Some("x".repeat(CLIENT_NAME_MAX + 1)),
                policy: None,
            })
            .is_err()
        );
    }

    #[test]
    fn last_use_is_noted_and_written_at_most_once_a_minute_and_a_turn_lasts_a_minute() {
        let (store, clock, c) = clients(None);
        let out = add(&c, McpClientKind::Codex);
        assert_eq!(c.list()[0].last_used_at, None);
        assert!(
            c.resolve(&out.token).unwrap().new_turn,
            "its first call begins a turn"
        );
        let first = clock.now();
        assert_eq!(c.list()[0].last_used_at, Some(first));
        let stored = || {
            store
                .mcp_clients()
                .get("codex")
                .unwrap()
                .unwrap()
                .last_used_at
        };
        assert_eq!(stored(), Some(first));
        clock.advance(10 * NANOS_PER_SEC);
        assert!(!c.resolve(&out.token).unwrap().new_turn, "the same turn");
        assert_eq!(c.list()[0].last_used_at, Some(clock.now()), "said at once");
        assert_eq!(
            stored(),
            Some(first),
            "written a minute after the last write"
        );
        clock.advance(60 * NANOS_PER_SEC);
        assert!(
            c.resolve(&out.token).unwrap().new_turn,
            "a minute on, a new turn"
        );
        assert_eq!(stored(), Some(clock.now()));
    }

    #[test]
    fn claude_desktop_is_written_only_with_the_clients_own_token() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("claude_desktop_config.json");
        std::fs::write(&path, r#"{"mcpServers": {"other": {"command": "x"}}}"#).unwrap();
        let (_store, _clock, c) = clients(Some(path.clone()));
        let a = add(&c, McpClientKind::ClaudeDesktop);
        let b = add(&c, McpClientKind::Cursor);
        assert!(c.add_to_claude_desktop("claude-desktop", &b.token).is_err());
        assert!(
            c.add_to_claude_desktop("claude-desktop", "tsk_nope")
                .is_err()
        );
        let out = c.add_to_claude_desktop("claude-desktop", &a.token).unwrap();
        assert_eq!(out.path, path.display().to_string());
        assert!(out.backup.is_some());
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(
            v["mcpServers"]["tessera"]["env"]["TESSERA_MCP_TOKEN"],
            a.token
        );
        let (_s, _c, none) = clients(None);
        let t = add(&none, McpClientKind::ClaudeDesktop);
        assert_eq!(
            none.add_to_claude_desktop("claude-desktop", &t.token)
                .unwrap_err()
                .code,
            tessera_protocol::tools::ToolErrorCode::Unavailable
        );
    }
}
