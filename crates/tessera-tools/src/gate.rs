use tessera_core::Origin;
use tessera_core::accounts::Environment;
use tessera_protocol::tools::{ApprovalKind, RiskTier, SessionMode};

use crate::meta::ToolMeta;
use crate::tool::ActionTarget;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionPolicy {
    pub mode: SessionMode,
    pub allow: Option<Vec<String>>,
    pub deny: Vec<String>,
}

impl SessionPolicy {
    pub fn with_mode(mode: SessionMode) -> Self {
        Self {
            mode,
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SurfaceState {
    pub armed: bool,
    pub hold_confirmed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenyReason {
    UserOnly,
    DenyList,
    NotInAllowList,
    ReadOnlyMode,
}

impl DenyReason {
    pub fn message(self, tool: &str) -> String {
        match self {
            DenyReason::UserOnly => format!("{tool} can only be used by you in the app"),
            DenyReason::DenyList => format!("{tool} is blocked for this session"),
            DenyReason::NotInAllowList => {
                format!("{tool} is not in this session's allowed tools")
            }
            DenyReason::ReadOnlyMode => {
                format!("{tool} changes state and this session is read-only")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    Deny(DenyReason),
    RequireApproval(ApprovalKind),
}

pub fn pattern_matches(pattern: &str, tool: &str) -> bool {
    if pattern == "*" || pattern == tool {
        return true;
    }
    match pattern.strip_suffix(".*") {
        Some(ns) => tool
            .strip_prefix(ns)
            .is_some_and(|rest| rest.starts_with('.')),
        None => false,
    }
}

pub fn evaluate(
    meta: &ToolMeta,
    origin: &Origin,
    policy: &SessionPolicy,
    surface: SurfaceState,
    target: Option<&ActionTarget>,
) -> GateDecision {
    if origin.is_user() {
        return match meta.risk {
            RiskTier::Read | RiskTier::Modify => GateDecision::Allow,
            RiskTier::Financial => {
                let environment = target.and_then(|t| t.environment);
                let direct = !meta.draft_only
                    && (target.is_some_and(|t| t.exit)
                        || environment.is_some_and(|e: Environment| {
                            e.allows_direct_send(surface.armed, surface.hold_confirmed)
                        }));
                if direct {
                    GateDecision::Allow
                } else {
                    GateDecision::RequireApproval(ApprovalKind::Financial)
                }
            }
        };
    }
    if meta.user_only {
        return GateDecision::Deny(DenyReason::UserOnly);
    }
    if policy.deny.iter().any(|p| pattern_matches(p, &meta.name)) {
        return GateDecision::Deny(DenyReason::DenyList);
    }
    if let Some(allow) = &policy.allow
        && !allow.iter().any(|p| pattern_matches(p, &meta.name))
    {
        return GateDecision::Deny(DenyReason::NotInAllowList);
    }
    match (meta.risk, policy.mode) {
        (RiskTier::Read, _) => GateDecision::Allow,
        (_, SessionMode::ReadOnly) => GateDecision::Deny(DenyReason::ReadOnlyMode),
        (RiskTier::Modify, SessionMode::Supervised) => {
            GateDecision::RequireApproval(ApprovalKind::Modify)
        }
        (RiskTier::Modify, SessionMode::AutoModify | SessionMode::FullAccess)
            if meta.always_ask =>
        {
            GateDecision::RequireApproval(ApprovalKind::Modify)
        }
        (RiskTier::Modify, SessionMode::AutoModify | SessionMode::FullAccess) => {
            GateDecision::Allow
        }
        (RiskTier::Financial, SessionMode::FullAccess) if !meta.draft_only => GateDecision::Allow,
        (RiskTier::Financial, _) => GateDecision::RequireApproval(ApprovalKind::Financial),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        assert!(pattern_matches("*", "market.get_quote"));
        assert!(pattern_matches("market.*", "market.get_quote"));
        assert!(pattern_matches("market.get_quote", "market.get_quote"));
        assert!(!pattern_matches("market.*", "marketing.get"));
        assert!(!pattern_matches("market.get", "market.get_quote"));
        assert!(!pattern_matches("orders.*", "market.get_quote"));
    }
}
