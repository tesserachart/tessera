use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;
use ts_rs::TS;

/// Where the account stands on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AccountPhase {
    /// This build has no accounts (no Tessera Cloud address): nothing to sign in to.
    Off,
    /// The kept session is being read from the keychain.
    Loading,
    /// A session is kept but the keychain did not let Tessera read it (`problem` says why): read again on
    /// `account.status` with `check`.
    Unreadable,
    /// No one is signed in.
    SignedOut,
    /// Someone is signed in (their last known access below).
    SignedIn,
}

/// What the app may do, as Tessera Cloud says: `full` once the alpha is open to them, otherwise where their
/// application stands (`none`: they have not applied).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AccountAccess {
    /// The alpha is open to them.
    Full,
    /// They applied; not decided yet.
    Pending,
    /// Their application was declined.
    Declined,
    /// No application.
    None,
}

/// Who is signed in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    /// Their email.
    pub email: String,
    /// Their name, when the identity provider has one.
    pub name: Option<String>,
}

/// The account on this machine: `account.status`'s answer and every `account` event (each the whole state).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    /// Where it stands.
    pub phase: AccountPhase,
    /// Who is signed in (`signed_in` only).
    pub user: Option<AccountUser>,
    /// Their access as Tessera Cloud last said it; kept while Cloud cannot be reached.
    pub access: Option<AccountAccess>,
    /// Their entitlements (`early_access`), as Cloud last said them.
    pub entitlements: Vec<String>,
    /// When Cloud last answered for this account.
    pub verified_at: Option<Timestamp>,
    /// Tessera is asking Cloud now (at start, or asked to check again).
    pub checking: bool,
    /// Cloud could not be reached the last time it was asked: `access` is the last known.
    pub offline: bool,
    /// A sign-in is waiting for the browser to come back.
    pub signing_in: bool,
    /// Why the last sign-in did not finish, or why the session ended, in words.
    pub problem: Option<String>,
}

impl AccountState {
    pub fn new(phase: AccountPhase) -> Self {
        Self {
            phase,
            user: None,
            access: None,
            entitlements: Vec::new(),
            verified_at: None,
            checking: false,
            offline: false,
            signing_in: false,
            problem: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AccountStatusInput {
    /// Ask Tessera Cloud again before answering ("Check again"), or read an unreadable kept session again;
    /// otherwise the state as last known.
    #[serde(default)]
    pub check: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountSignInInput {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountSignInOutput {
    /// The page to open in the system browser. It works once, for ten minutes.
    pub url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountSignOutInput {}
