use tessera_core::Origin;
use tessera_core::accounts::Environment;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::{ApprovalKind, RiskTier, SessionMode};
use tessera_tools::gate::{DenyReason, GateDecision, SessionPolicy, SurfaceState, evaluate};
use tessera_tools::{ActionTarget, ToolMeta};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OriginKind {
    User,
    Agent,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lists {
    None,
    AllowHit,
    AllowNamespaceHit,
    AllowMiss,
    DenyHit,
    DenyNamespace,
    AllowHitDenyHit,
    DenyOther,
}

const TOOL: &str = "orders.submit";

fn policy(mode: SessionMode, lists: Lists) -> SessionPolicy {
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
    let (allow, deny) = match lists {
        Lists::None => (None, vec![]),
        Lists::AllowHit => (Some(s(&[TOOL, "market.get_quote"])), vec![]),
        Lists::AllowNamespaceHit => (Some(s(&["orders.*"])), vec![]),
        Lists::AllowMiss => (Some(s(&["market.*", "chart.set_symbol"])), vec![]),
        Lists::DenyHit => (None, s(&[TOOL])),
        Lists::DenyNamespace => (None, s(&["orders.*"])),
        Lists::AllowHitDenyHit => (Some(s(&["*"])), s(&[TOOL])),
        Lists::DenyOther => (None, s(&["research.open_window", "settings.*"])),
    };
    SessionPolicy { mode, allow, deny }
}

fn origin(kind: OriginKind) -> Origin {
    match kind {
        OriginKind::User => Origin::User,
        OriginKind::Agent => Origin::Agent {
            session_id: SessionId::new("S15"),
            provider: "codex".into(),
        },
        OriginKind::External => Origin::External {
            client_id: "claude-desktop".into(),
        },
    }
}

#[derive(Clone, Copy, Debug)]
struct Call {
    armed: bool,
    hold: bool,
    exit: bool,
    env: Option<Environment>,
}

impl Call {
    fn surface(self) -> SurfaceState {
        SurfaceState {
            armed: self.armed,
            hold_confirmed: self.hold,
        }
    }

    fn target(self) -> Option<ActionTarget> {
        (self.env.is_some() || self.exit).then(|| ActionTarget {
            account: "paper-main".into(),
            instrument: None,
            environment: self.env,
            exit: self.exit,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn expected(
    risk: RiskTier,
    user_only: bool,
    draft_only: bool,
    always_ask: bool,
    who: OriginKind,
    mode: SessionMode,
    call: Call,
    lists: Lists,
) -> GateDecision {
    use GateDecision::*;
    if who == OriginKind::User {
        if risk != RiskTier::Financial {
            return Allow;
        }
        let direct = !draft_only
            && (call.exit
                || match call.env {
                    Some(Environment::Paper) => call.armed || call.hold,
                    Some(_) => call.hold,
                    None => false,
                });
        return if direct {
            Allow
        } else {
            RequireApproval(ApprovalKind::Financial)
        };
    }
    if user_only {
        return Deny(DenyReason::UserOnly);
    }
    if matches!(
        lists,
        Lists::DenyHit | Lists::DenyNamespace | Lists::AllowHitDenyHit
    ) {
        return Deny(DenyReason::DenyList);
    }
    if lists == Lists::AllowMiss {
        return Deny(DenyReason::NotInAllowList);
    }
    match (risk, mode) {
        (RiskTier::Read, _) => Allow,
        (RiskTier::Modify, SessionMode::Supervised) => RequireApproval(ApprovalKind::Modify),
        (RiskTier::Modify, SessionMode::AutoModify | SessionMode::FullAccess) if always_ask => {
            RequireApproval(ApprovalKind::Modify)
        }
        (RiskTier::Modify, SessionMode::AutoModify | SessionMode::FullAccess) => Allow,
        (RiskTier::Modify, SessionMode::ReadOnly) => Deny(DenyReason::ReadOnlyMode),
        (RiskTier::Financial, SessionMode::ReadOnly) => Deny(DenyReason::ReadOnlyMode),
        (RiskTier::Financial, SessionMode::FullAccess) if !draft_only => Allow,
        (RiskTier::Financial, _) => RequireApproval(ApprovalKind::Financial),
    }
}

#[test]
fn gate_matrix_is_exhaustive_and_correct() {
    let risks = [RiskTier::Read, RiskTier::Modify, RiskTier::Financial];
    let origins = [OriginKind::User, OriginKind::Agent, OriginKind::External];
    let modes = [
        SessionMode::Supervised,
        SessionMode::AutoModify,
        SessionMode::ReadOnly,
        SessionMode::FullAccess,
    ];
    let envs = [
        None,
        Some(Environment::Paper),
        Some(Environment::Sim),
        Some(Environment::Eval),
        Some(Environment::Funded),
        Some(Environment::Live),
    ];
    let lists = [
        Lists::None,
        Lists::AllowHit,
        Lists::AllowNamespaceHit,
        Lists::AllowMiss,
        Lists::DenyHit,
        Lists::DenyNamespace,
        Lists::AllowHitDenyHit,
        Lists::DenyOther,
    ];
    let flags = [false, true];

    let mut cases = 0;
    for risk in risks {
        for user_only in flags {
            for draft_only in flags {
                for always_ask in flags {
                    let mut meta = ToolMeta::new(TOOL, "Submit", risk);
                    if user_only {
                        meta = meta.user_only();
                    }
                    if draft_only {
                        meta = meta.draft_only();
                    }
                    if always_ask {
                        meta = meta.always_ask();
                    }
                    let flags3 = (user_only, draft_only, always_ask);
                    for who in origins {
                        for mode in modes {
                            for armed in flags {
                                for hold in flags {
                                    for exit in flags {
                                        for env in envs {
                                            let call = Call {
                                                armed,
                                                hold,
                                                exit,
                                                env,
                                            };
                                            for l in lists {
                                                check(&meta, risk, flags3, who, mode, call, l);
                                                cases += 1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    assert_eq!(cases, 3 * 2 * 2 * 2 * 3 * 4 * 2 * 2 * 2 * 6 * 8);
}

fn check(
    meta: &ToolMeta,
    risk: RiskTier,
    (user_only, draft_only, always_ask): (bool, bool, bool),
    who: OriginKind,
    mode: SessionMode,
    call: Call,
    l: Lists,
) {
    let target = call.target();
    let got = evaluate(
        meta,
        &origin(who),
        &policy(mode, l),
        call.surface(),
        target.as_ref(),
    );
    let want = expected(risk, user_only, draft_only, always_ask, who, mode, call, l);
    assert_eq!(
        got, want,
        "risk={risk:?} user_only={user_only} draft_only={draft_only} always_ask={always_ask} origin={who:?} mode={mode:?} {call:?} lists={l:?}"
    );

    if who != OriginKind::User {
        if mode != SessionMode::FullAccess || draft_only {
            assert_ne!(
                (risk, got),
                (RiskTier::Financial, GateDecision::Allow),
                "a financial tool executes for a non-user origin only in Full access"
            );
        }
        if always_ask && risk == RiskTier::Modify {
            assert_ne!(
                got,
                GateDecision::Allow,
                "an always-ask change never runs for a non-user origin without the user"
            );
        }
        let paper_exit = ActionTarget {
            account: "paper-main".into(),
            instrument: None,
            environment: Some(Environment::Paper),
            exit: true,
        };
        let other = evaluate(
            meta,
            &origin(who),
            &policy(mode, l),
            SurfaceState {
                armed: true,
                hold_confirmed: true,
            },
            Some(&paper_exit),
        );
        assert_eq!(got, other);
        if mode == SessionMode::ReadOnly && risk != RiskTier::Read {
            assert!(matches!(got, GateDecision::Deny(_)));
        }
    } else {
        assert!(
            !matches!(got, GateDecision::Deny(_)),
            "the user is never denied by the gate"
        );
        if risk == RiskTier::Financial && got == GateDecision::Allow {
            assert!(!draft_only, "a draft-only tool always drafts");
            assert!(
                call.exit
                    || (call.env == Some(Environment::Paper) && (call.armed || call.hold))
                    || (call.env.is_some_and(|e| e != Environment::Paper) && call.hold),
                "an entry is sent at once only from an armed PAPER surface or after a hold"
            );
        }
    }
}

#[test]
fn deny_reasons_have_messages() {
    for r in [
        DenyReason::UserOnly,
        DenyReason::DenyList,
        DenyReason::NotInAllowList,
        DenyReason::ReadOnlyMode,
    ] {
        assert!(r.message("orders.submit").contains("orders.submit"));
    }
}
