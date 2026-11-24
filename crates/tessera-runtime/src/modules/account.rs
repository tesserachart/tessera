use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_cloud::pkce::{self, Pkce};
use tessera_cloud::{
    Access, Checkin, CloudAccount, CloudClient, CloudError, CloudUser, SessionSink,
};
use tessera_core::accounts::{CredentialRef, CredentialStore};
use tessera_core::time::NANOS_PER_SEC;
use tessera_core::{SharedClock, Timestamp};
use tessera_host::{
    EventBus, KeyFilter, ModuleHost, RuntimeModule, Subscribed, TopicHandler, TopicKey,
    TopicSizing, TsExports,
};
use tessera_protocol::account::{
    AccountAccess, AccountPhase, AccountSignInInput, AccountSignInOutput, AccountSignOutInput,
    AccountState, AccountStatusInput, AccountUser,
};
use tessera_protocol::rpc::RpcError;
use tessera_protocol::tools::RiskTier;
use tessera_protocol::topics::{NoParams, names};
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};
use tokio::task::JoinHandle;

use crate::logging::Redactor;
use crate::secrets::Secrets;

mod page;

pub use page::CallbackPage;

pub const SESSION_KEY: &str = "account.session";

const CHANNEL: &str = if cfg!(debug_assertions) {
    "dev"
} else {
    "release"
};

pub const SIGN_IN_TTL: Duration = Duration::from_secs(10 * 60);

pub const CALLBACK_PATH: &str = "/auth/callback";

#[derive(Clone, Serialize, Deserialize)]
struct Kept {
    refresh_token: String,
    user: CloudUser,
    access: Access,
    #[serde(default)]
    entitlements: Vec<String>,
    verified_at: Timestamp,
}

impl std::fmt::Debug for Kept {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Kept")
            .field("user", &self.user.id)
            .field("access", &self.access)
            .finish_non_exhaustive()
    }
}

struct Pending {
    state: String,
    verifier: String,
    at: Timestamp,
}

fn access_of(a: Access) -> AccountAccess {
    match a {
        Access::Full => AccountAccess::Full,
        Access::Pending => AccountAccess::Pending,
        Access::Declined => AccountAccess::Declined,
        Access::None => AccountAccess::None,
    }
}

fn user_of(u: &CloudUser) -> AccountUser {
    Redactor::global().register_private(&u.email);
    AccountUser {
        email: u.email.clone(),
        name: u.name.clone(),
    }
}

struct Shared {
    secrets: Secrets,
    bus: Arc<EventBus>,
    clock: SharedClock,
    state: Mutex<AccountState>,
    kept: Mutex<Option<Kept>>,
    signing_out: AtomicBool,
}

impl Shared {
    fn state(&self) -> AccountState {
        self.state.lock().clone()
    }

    fn update(&self, f: impl FnOnce(&mut AccountState)) {
        let changed = {
            let mut s = self.state.lock();
            let before = s.clone();
            f(&mut s);
            (*s != before).then(|| s.clone())
        };
        if let Some(s) = changed {
            self.bus.publish(names::ACCOUNT, TopicKey::None, &s);
        }
    }

    fn session_ref(store: CredentialStore) -> CredentialRef {
        CredentialRef {
            store,
            key: SESSION_KEY.to_owned(),
        }
    }

    async fn read(&self) -> Result<Option<Kept>, String> {
        let primary = self.secrets.primary();
        let other = match primary {
            CredentialStore::Keyring => CredentialStore::DevFile,
            CredentialStore::DevFile => CredentialStore::Keyring,
        };
        let mut unreadable = None;
        for store in [primary, other] {
            let read = if store == primary {
                self.secrets
                    .get_patiently(&Self::session_ref(store), || {})
                    .await
            } else {
                self.secrets.get(&Self::session_ref(store)).await
            };
            match read {
                Ok(Some(v)) => match serde_json::from_str::<Kept>(&v) {
                    Ok(k) => {
                        Redactor::global().register(&k.refresh_token);
                        return Ok(Some(k));
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "the kept Tessera session could not be read")
                    }
                },
                Ok(None) => {}
                Err(e) if store == primary => unreadable = Some(e.to_string()),
                Err(e) => tracing::debug!(error = %e, "no Tessera session in this store"),
            }
        }
        unreadable.map_or(Ok(None), Err)
    }

    async fn write(&self, kept: &Kept) {
        match serde_json::to_string(kept) {
            Ok(v) => {
                if let Err(e) = self.secrets.put(SESSION_KEY, &v).await {
                    tracing::warn!(error = %e, "the Tessera session could not be kept: the next start signs in again");
                }
            }
            Err(e) => tracing::warn!(error = %e, "the Tessera session could not be written"),
        }
    }

    async fn erase(&self) -> Result<(), String> {
        self.secrets
            .delete_everywhere(&Self::session_ref(self.secrets.primary()))
            .await
            .map_err(|e| e.to_string())
    }

    fn apply(&self, account: &CloudAccount, at: Timestamp) {
        self.update(|s| {
            s.phase = AccountPhase::SignedIn;
            s.user = Some(user_of(&account.user));
            s.access = Some(access_of(account.access));
            s.entitlements = account.entitlements.clone();
            s.verified_at = Some(at);
            s.offline = false;
            s.problem = None;
        });
    }

    async fn verified(&self, account: &CloudAccount) {
        let now = self.clock.now();
        self.apply(account, now);
        let changed = {
            let mut kept = self.kept.lock();
            match kept.as_mut() {
                Some(k)
                    if k.user != account.user
                        || k.access != account.access
                        || k.entitlements != account.entitlements =>
                {
                    k.user = account.user.clone();
                    k.access = account.access;
                    k.entitlements = account.entitlements.clone();
                    k.verified_at = now;
                    Some(k.clone())
                }
                _ => None,
            }
        };
        if let Some(k) = changed {
            self.write(&k).await;
        }
    }

    fn signed_out(&self, problem: Option<String>) {
        *self.kept.lock() = None;
        self.update(|s| {
            let signing_in = s.signing_in;
            *s = AccountState::new(AccountPhase::SignedOut);
            s.signing_in = signing_in;
            s.problem = problem;
        });
    }
}

#[async_trait]
impl SessionSink for Shared {
    async fn renewed(&self, refresh_token: &str, account: &CloudAccount) {
        if self.signing_out.load(Ordering::SeqCst) {
            return;
        }
        Redactor::global().register(refresh_token);
        let now = self.clock.now();
        let kept = Kept {
            refresh_token: refresh_token.to_owned(),
            user: account.user.clone(),
            access: account.access,
            entitlements: account.entitlements.clone(),
            verified_at: now,
        };
        self.write(&kept).await;
        *self.kept.lock() = Some(kept);
        self.apply(account, now);
    }

    async fn rejected(&self) {
        if let Err(e) = self.erase().await {
            tracing::warn!(error = %e, "the ended Tessera session could not be deleted");
        }
        tracing::info!("Tessera Cloud ended the session: signed out");
        self.signed_out(Some("Your session ended. Sign in again.".into()));
    }
}

fn platform() -> Option<&'static str> {
    match std::env::consts::OS {
        "macos" => Some("mac"),
        "windows" => Some("windows"),
        "linux" => Some("linux"),
        _ => None,
    }
}

pub struct AccountService {
    shared: Arc<Shared>,
    client: Option<CloudClient>,
    pending: Mutex<Option<Pending>>,
    port: AtomicU16,
    app_version: Mutex<Option<String>>,
    checked_in: AtomicBool,
    checking_in: AtomicBool,
}

impl std::fmt::Debug for AccountService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountService")
            .field("phase", &self.shared.state.lock().phase)
            .finish_non_exhaustive()
    }
}

impl AccountService {
    pub fn new(
        cloud_url: Option<String>,
        secrets: Secrets,
        bus: Arc<EventBus>,
        clock: SharedClock,
    ) -> anyhow::Result<Arc<Self>> {
        let phase = if cloud_url.is_some() {
            AccountPhase::Loading
        } else {
            AccountPhase::Off
        };
        let shared = Arc::new(Shared {
            secrets,
            bus,
            clock,
            state: Mutex::new(AccountState::new(phase)),
            kept: Mutex::new(None),
            signing_out: AtomicBool::new(false),
        });
        let client = match cloud_url {
            Some(url) => Some(
                CloudClient::new(
                    url,
                    &format!("Tessera/{}", crate::VERSION),
                    Arc::clone(&shared) as Arc<dyn SessionSink>,
                )
                .map_err(|e| anyhow::anyhow!("the Tessera Cloud client: {e}"))?,
            ),
            None => None,
        };
        Ok(Arc::new(Self {
            shared,
            client,
            pending: Mutex::new(None),
            port: AtomicU16::new(0),
            app_version: Mutex::new(None),
            checked_in: AtomicBool::new(false),
            checking_in: AtomicBool::new(false),
        }))
    }

    pub fn enabled(&self) -> bool {
        self.client.is_some()
    }

    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
    }

    pub fn state(&self) -> AccountState {
        self.shared.state()
    }

    pub fn signed_in(&self) -> bool {
        self.state().phase == AccountPhase::SignedIn
    }

    pub async fn file_feedback(
        &self,
        report: &tessera_cloud::FeedbackReport,
    ) -> Result<tessera_cloud::FiledIssue, CloudError> {
        self.cloud()?.feedback(report).await
    }

    pub fn cloud(&self) -> Result<&CloudClient, CloudError> {
        match &self.client {
            Some(client) if self.signed_in() => Ok(client),
            _ => Err(CloudError::SignedOut),
        }
    }

    pub fn user_id(&self) -> Option<String> {
        self.shared.kept.lock().as_ref().map(|k| k.user.id.clone())
    }

    fn client(&self) -> Result<&CloudClient, ToolError> {
        self.client
            .as_ref()
            .ok_or_else(|| ToolError::unavailable("This build of Tessera has no accounts."))
    }

    pub async fn load(self: &Arc<Self>) {
        let Some(client) = &self.client else { return };
        let kept = match self.shared.read().await {
            Ok(Some(kept)) => kept,
            Ok(None) => {
                self.shared.signed_out(None);
                return;
            }
            Err(why) => {
                tracing::warn!(%why, "the kept Tessera session cannot be read");
                self.shared.update(|s| {
                    *s = AccountState::new(AccountPhase::Unreadable);
                    s.problem = Some(format!("The saved sign-in cannot be read: {why}."));
                });
                return;
            }
        };
        client.restore(kept.refresh_token.clone()).await;
        self.shared.update(|s| {
            s.phase = AccountPhase::SignedIn;
            s.user = Some(user_of(&kept.user));
            s.access = Some(access_of(kept.access));
            s.entitlements = kept.entitlements.clone();
            s.verified_at = Some(kept.verified_at);
            s.checking = true;
        });
        *self.shared.kept.lock() = Some(kept);
        self.check().await;
        self.check_in();
    }

    async fn check(&self) {
        let Some(client) = &self.client else { return };
        if !client.has_session().await {
            return;
        }
        self.shared.update(|s| s.checking = true);
        match client.me().await {
            Ok(account) => self.shared.verified(&account).await,
            Err(CloudError::Rejected) => {}
            Err(CloudError::SignedOut) => self.shared.signed_out(None),
            Err(e) => {
                tracing::info!(error = %e, "Tessera Cloud did not answer: the last known access stands");
                self.shared.update(|s| s.offline = true);
            }
        }
        self.shared.update(|s| s.checking = false);
    }

    pub async fn status(self: &Arc<Self>, check: bool) -> AccountState {
        match self.state().phase {
            AccountPhase::SignedIn if check => self.check().await,
            AccountPhase::Unreadable if check => {
                self.shared
                    .update(|s| *s = AccountState::new(AccountPhase::Loading));
                self.load().await;
            }
            _ => {}
        }
        self.state()
    }

    pub fn sign_in(self: &Arc<Self>) -> Result<String, ToolError> {
        let client = self.client()?;
        let port = self.port.load(Ordering::SeqCst);
        if port == 0 {
            return Err(ToolError::unavailable("Tessera is still starting."));
        }
        let pkce = Pkce::generate().map_err(|e| ToolError::internal(e.to_string()))?;
        let state = pkce::new_state().map_err(|e| ToolError::internal(e.to_string()))?;
        let redirect = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let url = client.start_url(&redirect, &state, &pkce.challenge);
        *self.pending.lock() = Some(Pending {
            state: state.clone(),
            verifier: pkce.verifier,
            at: self.shared.clock.now(),
        });
        self.shared.update(|s| {
            s.signing_in = true;
            s.problem = None;
        });
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(SIGN_IN_TTL).await;
            if let Some(me) = me.upgrade() {
                let mut pending = me.pending.lock();
                if pending.as_ref().is_some_and(|p| p.state == state) {
                    *pending = None;
                    drop(pending);
                    me.shared.update(|s| s.signing_in = false);
                }
            }
        });
        Ok(url)
    }

    fn take_pending(&self, state: &str) -> Option<Pending> {
        let mut pending = self.pending.lock();
        if !pending
            .as_ref()
            .is_some_and(|p| pkce::same_secret(&p.state, state))
        {
            return None;
        }
        let p = pending.take()?;
        let age = self.shared.clock.now().0.saturating_sub(p.at.0);
        (age <= SIGN_IN_TTL.as_secs() as i64 * NANOS_PER_SEC).then_some(p)
    }

    pub async fn callback(
        self: &Arc<Self>,
        query: &HashMap<String, String>,
    ) -> Option<CallbackPage> {
        let client = self.client.as_ref()?;
        let state = query.get("state").map(String::as_str).unwrap_or_default();
        let Some(pending) = self.take_pending(state) else {
            if self.pending.lock().is_none() {
                self.shared.update(|s| s.signing_in = false);
            }
            return Some(CallbackPage::Expired);
        };
        let failed = |problem: &str, page: CallbackPage| {
            self.shared.update(|s| {
                s.signing_in = false;
                s.problem = Some(problem.to_owned());
            });
            Some(page)
        };
        if let Some(error) = query.get("error") {
            return if error == "access_denied" {
                failed(
                    "Sign-in was cancelled in the browser.",
                    CallbackPage::Cancelled,
                )
            } else {
                failed(
                    "Sign-in didn’t finish in the browser.",
                    CallbackPage::Unfinished,
                )
            };
        }
        let Some(code) = query.get("code").filter(|c| !c.is_empty()) else {
            return failed(
                "Sign-in didn’t finish in the browser.",
                CallbackPage::Unfinished,
            );
        };
        self.shared.signing_out.store(false, Ordering::SeqCst);
        match client.exchange(code, &pending.verifier).await {
            Ok(account) => {
                tracing::info!(access = ?account.access, "signed in to Tessera");
                self.shared.update(|s| {
                    s.signing_in = false;
                    s.problem = None;
                });
                self.check_in();
                Some(CallbackPage::SignedIn)
            }
            Err(e) => {
                tracing::warn!(error = %e, "the sign-in's code could not be exchanged");
                match e {
                    CloudError::Unreachable(_) => failed(
                        "Tessera Cloud can’t be reached. Check your connection and try again.",
                        CallbackPage::Unreachable,
                    ),
                    CloudError::Rejected => failed(
                        "Tessera Cloud didn’t accept the sign-in. Try again.",
                        CallbackPage::Refused,
                    ),
                    e => failed(
                        &format!("Sign-in didn’t finish: {e}."),
                        CallbackPage::CloudFailed,
                    ),
                }
            }
        }
    }

    pub async fn sign_out(&self) -> Result<AccountState, ToolError> {
        let client = self.client()?;
        self.shared.signing_out.store(true, Ordering::SeqCst);
        if let Err(e) = client.sign_out().await {
            tracing::info!(error = %e, "the session was not ended at Tessera Cloud; it is forgotten here");
        }
        *self.pending.lock() = None;
        let erased = self.shared.erase().await;
        self.shared.signed_out(None);
        self.shared.update(|s| s.signing_in = false);
        self.checked_in.store(false, Ordering::SeqCst);
        self.shared.signing_out.store(false, Ordering::SeqCst);
        erased.map_err(|e| {
            ToolError::unavailable(format!(
                "Signed out, but the session could not be deleted: {e}"
            ))
        })?;
        Ok(self.state())
    }

    pub fn hello(self: &Arc<Self>, client_name: &str, version: Option<&str>) {
        if self.client.is_none() || client_name != "tessera-desktop" {
            return;
        }
        let Some(v) = version.map(str::trim).filter(|v| !v.is_empty()) else {
            return;
        };
        *self.app_version.lock() = Some(v.to_owned());
        self.check_in();
    }

    pub fn checking_in(&self) -> bool {
        self.checking_in.load(Ordering::SeqCst)
    }

    fn check_in(self: &Arc<Self>) {
        let Some(platform) = platform() else { return };
        let Some(version) = self.app_version.lock().clone() else {
            return;
        };
        if self.state().phase != AccountPhase::SignedIn
            || self.state().checking
            || self.checked_in.load(Ordering::SeqCst)
            || self.checking_in.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let checkin = Checkin {
                channel: CHANNEL.to_owned(),
                app_version: version,
                platform: platform.to_owned(),
                arch: std::env::consts::ARCH.to_owned(),
            };
            if let Some(client) = &me.client {
                match client.checkin(&checkin).await {
                    Ok(()) => {
                        me.checked_in.store(true, Ordering::SeqCst);
                        tracing::info!(version = %checkin.app_version, channel = %checkin.channel, "checked in");
                    }
                    Err(e) => tracing::info!(error = %e, "could not check in with Tessera Cloud"),
                }
            }
            me.checking_in.store(false, Ordering::SeqCst);
        });
    }
}

pub struct AccountModule {
    service: Arc<AccountService>,
}

impl std::fmt::Debug for AccountModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountModule").finish_non_exhaustive()
    }
}

impl AccountModule {
    pub fn new(service: Arc<AccountService>) -> Self {
        Self { service }
    }
}

impl RuntimeModule for AccountModule {
    fn name(&self) -> &'static str {
        "account"
    }

    fn register_tools(&self, r: &mut ToolRegistry) -> Result<(), RegistryError> {
        r.register(Status(Arc::clone(&self.service)))?;
        r.register(SignIn(Arc::clone(&self.service)))?;
        r.register(SignOut(Arc::clone(&self.service)))?;
        Ok(())
    }

    fn topics(&self, _host: &ModuleHost) -> Vec<Arc<dyn TopicHandler>> {
        vec![Arc::new(AccountTopic(Arc::clone(&self.service)))]
    }

    fn start(&self, _host: &ModuleHost) -> Vec<JoinHandle<()>> {
        if !self.service.enabled() {
            return Vec::new();
        }
        let s = Arc::clone(&self.service);
        vec![tokio::spawn(async move { s.load().await })]
    }
}

pub fn ts_exports() -> TsExports {
    TsExports::new("tessera-runtime (account)")
        .tool::<AccountStatusInput, AccountState>("account.status")
        .tool::<AccountSignInInput, AccountSignInOutput>("account.sign_in")
        .tool::<AccountSignOutInput, AccountState>("account.sign_out")
        .topic::<NoParams, AccountState>(names::ACCOUNT)
}

struct AccountTopic(Arc<AccountService>);

#[async_trait]
impl TopicHandler for AccountTopic {
    fn name(&self) -> &'static str {
        names::ACCOUNT
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::SNAPSHOT
    }

    async fn subscribe(&self, _params: Value) -> Result<Subscribed, RpcError> {
        Ok(Subscribed::new(KeyFilter::All).snapshot(&self.0.state()))
    }
}

struct Status(Arc<AccountService>);

#[async_trait]
impl Tool for Status {
    type Input = AccountStatusInput;
    type Output = AccountState;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("account.status", "Account status", RiskTier::Read)
            .description("The user's Tessera account on this machine: whether this build has accounts, who is signed in, and their access as Tessera Cloud last said it. `check` asks Cloud again first.")
            .user_only()
            .quiet()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AccountStatusInput,
    ) -> Result<AccountState, ToolError> {
        Ok(self.0.status(input.check.unwrap_or(false)).await)
    }
}

struct SignIn(Arc<AccountService>);

#[async_trait]
impl Tool for SignIn {
    type Input = AccountSignInInput;
    type Output = AccountSignInOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("account.sign_in", "Sign in", RiskTier::Modify)
            .description("Starts a sign-in to Tessera: the page to open in the system browser. The browser comes back to Tessera, which keeps the session in the keychain. Works once, for ten minutes.")
            .user_only()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: AccountSignInInput,
    ) -> Result<AccountSignInOutput, ToolError> {
        Ok(AccountSignInOutput {
            url: self.0.sign_in()?,
        })
    }
}

struct SignOut(Arc<AccountService>);

#[async_trait]
impl Tool for SignOut {
    type Input = AccountSignOutInput;
    type Output = AccountState;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("account.sign_out", "Sign out", RiskTier::Modify)
            .description("Signs out of Tessera on this machine: ends the session at Tessera Cloud and deletes it from the keychain.")
            .user_only()
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: AccountSignOutInput,
    ) -> Result<AccountState, ToolError> {
        self.0.sign_out().await
    }
}
