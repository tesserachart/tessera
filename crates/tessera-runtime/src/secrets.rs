//! Keyring calls block (D-Bus) and may wait on an unlock prompt.

use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tessera_core::accounts::{CredentialRef, CredentialStore};

pub const KEYRING_SERVICE: &str = "tessera";

pub const KEYRING_SERVICE_ENV: &str = "TESSERA_KEYRING_SERVICE";

pub const SECRET_STORE_ENV: &str = "TESSERA_SECRET_STORE";

pub const KEYRING_DEADLINE: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Failed(String),
}

pub trait SecretStore: Send + Sync + std::fmt::Debug {
    fn kind(&self) -> CredentialStore;
    fn get(&self, key: &str) -> Result<Option<String>, SecretError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SecretError>;
    fn delete(&self, key: &str) -> Result<(), SecretError>;
    fn location(&self, key: &str) -> String {
        default_location(self.kind(), key)
    }
    fn secrets_dir(&self) -> Option<PathBuf> {
        None
    }
    fn keyring_service(&self) -> Option<String> {
        None
    }
    fn bound_to_binary(&self) -> bool {
        false
    }
}

fn default_location(kind: CredentialStore, key: &str) -> String {
    match kind {
        CredentialStore::Keyring => format!("OS keyring, service {KEYRING_SERVICE}, key {key}"),
        CredentialStore::DevFile => format!("development secrets file, key {key}"),
    }
}

#[derive(Debug)]
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(keyring_service(
            std::env::var(KEYRING_SERVICE_ENV).ok().as_deref(),
        ))
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new(KEYRING_SERVICE)
    }
}

pub fn keyring_service(var: Option<&str>) -> String {
    var.map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(KEYRING_SERVICE)
        .to_owned()
}

fn keyring_error(e: keyring::Error) -> SecretError {
    match e {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            SecretError::Unavailable(format!("the OS keyring is not available ({e})"))
        }
        other => SecretError::Failed(format!("the OS keyring failed: {other}")),
    }
}

impl SecretStore for KeyringStore {
    fn kind(&self) -> CredentialStore {
        CredentialStore::Keyring
    }

    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        let entry = keyring::Entry::new(&self.service, key).map_err(keyring_error)?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_error(e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        keyring::Entry::new(&self.service, key)
            .and_then(|e| e.set_password(value))
            .map_err(keyring_error)
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        let entry = keyring::Entry::new(&self.service, key).map_err(keyring_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keyring_error(e)),
        }
    }

    fn location(&self, key: &str) -> String {
        format!("OS keyring, service {}, key {key}", self.service)
    }

    fn keyring_service(&self) -> Option<String> {
        Some(self.service.clone())
    }

    fn bound_to_binary(&self) -> bool {
        cfg!(target_os = "macos")
    }
}

#[derive(Debug)]
pub struct CarriedOver {
    own: Arc<dyn SecretStore>,
    previous: Arc<dyn SecretStore>,
}

impl SecretStore for CarriedOver {
    fn kind(&self) -> CredentialStore {
        self.own.kind()
    }

    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        if let Some(v) = self.own.get(key)? {
            return Ok(Some(v));
        }
        let Some(v) = self.previous.get(key)? else {
            return Ok(None);
        };
        self.own.set(key, &v)?;
        if let Err(e) = self.previous.delete(key) {
            tracing::warn!(key = %key, error = %e, "a carried-over secret stays in the previous store too");
        }
        Ok(Some(v))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        self.own.set(key, value)
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        self.own.delete(key)
    }

    fn location(&self, key: &str) -> String {
        self.own.location(key)
    }

    fn keyring_service(&self) -> Option<String> {
        self.own.keyring_service()
    }

    fn bound_to_binary(&self) -> bool {
        self.own.bound_to_binary()
    }
}

#[derive(Debug)]
pub struct FileStore {
    dir: PathBuf,
}

pub fn default_secrets_dir() -> Option<PathBuf> {
    let config = || {
        if cfg!(windows) {
            std::env::var_os("APPDATA").map(PathBuf::from)
        } else {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
        }
    };
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(config)
        .map(|p| p.join("tessera").join("secrets"))
}

fn file_name(key: &str) -> Result<String, SecretError> {
    let ok = !key.is_empty()
        && !key.starts_with('.')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(format!("{key}.secret"))
    } else {
        Err(SecretError::Failed(format!(
            "{key:?} is not a valid secret key"
        )))
    }
}

impl FileStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, key: &str) -> Result<PathBuf, SecretError> {
        Ok(self.dir.join(file_name(key)?))
    }

    fn io(&self, what: &str, e: &std::io::Error) -> SecretError {
        SecretError::Failed(format!(
            "cannot {what} in {}: {}",
            self.dir.display(),
            e.kind()
        ))
    }
}

fn private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    tessera_core::private::owner_only(&mut options);
    options.open(path)
}

impl SecretStore for FileStore {
    fn kind(&self) -> CredentialStore {
        CredentialStore::DevFile
    }

    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        match std::fs::read_to_string(self.path(key)?) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(self.io("read a secret", &e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        let path = self.path(key)?;
        tessera_core::private::private_dir(&self.dir)
            .map_err(|e| self.io("create the secrets directory", &e))?;
        let tmp = path.with_extension("tmp");
        let mut f = private_file(&tmp).map_err(|e| self.io("write a secret", &e))?;
        f.write_all(value.as_bytes())
            .and_then(|()| f.sync_all())
            .map_err(|e| self.io("write a secret", &e))?;
        drop(f);
        std::fs::rename(&tmp, &path).map_err(|e| self.io("write a secret", &e))
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        match std::fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(self.io("delete a secret", &e)),
        }
    }

    fn location(&self, key: &str) -> String {
        self.path(key)
            .unwrap_or_else(|_| self.dir.join(key))
            .display()
            .to_string()
    }

    fn secrets_dir(&self) -> Option<PathBuf> {
        Some(self.dir.clone())
    }
}

#[derive(Debug)]
pub struct MemoryStore {
    kind: CredentialStore,
    values: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    pub fn new(kind: CredentialStore) -> Self {
        Self {
            kind,
            values: Mutex::new(HashMap::new()),
        }
    }
}

impl SecretStore for MemoryStore {
    fn kind(&self) -> CredentialStore {
        self.kind
    }

    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        Ok(self.values.lock().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        self.values.lock().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        self.values.lock().remove(key);
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Secrets {
    keyring: Option<Arc<dyn SecretStore>>,
    file: Option<Arc<dyn SecretStore>>,
    fallback: bool,
    deadline: Duration,
    known: Arc<Mutex<BTreeSet<String>>>,
}

#[async_trait::async_trait]
pub trait Adopter: Send {
    async fn adopt(&mut self, key: &str, value: &str) -> Result<(), NotKept>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotKept {
    Refused(String),
    Gone(String),
}

impl std::fmt::Display for NotKept {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) | Self::Gone(why) => f.write_str(why),
        }
    }
}

pub const HAND_OVER_BUDGET: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandOver {
    pub handed: Vec<String>,
    pub left: Vec<String>,
}

impl Secrets {
    pub fn system() -> Self {
        let keyring = (std::env::var(SECRET_STORE_ENV).as_deref() != Ok("file"))
            .then(|| Arc::new(KeyringStore::from_env()) as Arc<dyn SecretStore>);
        let file =
            default_secrets_dir().map(|d| Arc::new(FileStore::new(d)) as Arc<dyn SecretStore>);
        Self {
            keyring,
            file,
            fallback: cfg!(debug_assertions),
            deadline: KEYRING_DEADLINE,
            known: Arc::default(),
        }
    }

    pub fn in_memory() -> Self {
        Self::with_stores(
            Some(Arc::new(MemoryStore::new(CredentialStore::Keyring))),
            Some(Arc::new(MemoryStore::new(CredentialStore::DevFile))),
        )
    }

    pub fn with_stores(
        keyring: Option<Arc<dyn SecretStore>>,
        file: Option<Arc<dyn SecretStore>>,
    ) -> Self {
        Self {
            keyring,
            file,
            fallback: true,
            deadline: KEYRING_DEADLINE,
            known: Arc::default(),
        }
    }

    #[must_use]
    pub fn without_fallback(mut self) -> Self {
        self.fallback = false;
        self
    }

    #[must_use]
    pub fn carrying_over_keyring(mut self, previous: Arc<dyn SecretStore>) -> Self {
        self.keyring = self
            .keyring
            .map(|own| Arc::new(CarriedOver { own, previous }) as Arc<dyn SecretStore>);
        self
    }

    #[must_use]
    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }

    fn store(&self, kind: CredentialStore) -> Option<&Arc<dyn SecretStore>> {
        match kind {
            CredentialStore::Keyring => self.keyring.as_ref(),
            CredentialStore::DevFile => self.file.as_ref(),
        }
    }

    pub async fn put(&self, key: &str, value: &str) -> Result<CredentialRef, SecretError> {
        crate::logging::Redactor::global().register(value);
        let mut why = None;
        if let Some(k) = &self.keyring {
            let call = spawn_call(k, |s, key, value| s.set(key, value), key, value);
            match settle(call, k.kind(), self.deadline).await {
                Settled::Done(Ok(())) => {
                    self.known.lock().insert(key.to_owned());
                    return Ok(CredentialRef {
                        store: CredentialStore::Keyring,
                        key: key.to_owned(),
                    });
                }
                Settled::Done(Err(e)) => why = Some(e),
                Settled::Late(call, e) => {
                    take_back_late_write(Arc::clone(k), key.to_owned(), call);
                    why = Some(e);
                }
            }
        }
        let file = self
            .file
            .as_ref()
            .filter(|_| self.fallback || self.keyring.is_none());
        let Some(f) = file else {
            return Err(match why {
                Some(e) => SecretError::Unavailable(format!(
                    "{e}. Unlock the OS keyring (or set it up) and try again; the login was not \
                     stored"
                )),
                None => SecretError::Unavailable("no secret store is available".into()),
            });
        };
        if let Some(e) = &why {
            tracing::warn!(error = %e, "OS keyring unavailable; using the development secrets file");
        }
        blocking(
            f,
            |s, key, value| s.set(key, value),
            key,
            value,
            self.deadline,
        )
        .await?;
        Ok(CredentialRef {
            store: CredentialStore::DevFile,
            key: key.to_owned(),
        })
    }

    pub async fn get(&self, r: &CredentialRef) -> Result<Option<String>, SecretError> {
        self.read(r, None::<fn()>).await
    }

    pub async fn get_patiently(
        &self,
        r: &CredentialRef,
        waiting: impl FnOnce(),
    ) -> Result<Option<String>, SecretError> {
        let patient = r.store == CredentialStore::Keyring && self.bound_to_binary();
        self.read(r, patient.then_some(waiting)).await
    }

    async fn read(
        &self,
        r: &CredentialRef,
        waiting: Option<impl FnOnce()>,
    ) -> Result<Option<String>, SecretError> {
        let s = self.store(r.store).ok_or_else(|| {
            SecretError::Unavailable(format!(
                "the {} store is not available",
                store_name(r.store)
            ))
        })?;
        let call = spawn_call(s, |s, key, _| s.get(key), &r.key, "");
        let v = match (settle(call, s.kind(), self.deadline).await, waiting) {
            (Settled::Done(v), _) => v,
            (Settled::Late(call, _), Some(waiting)) => {
                waiting();
                joined(call.await)
            }
            (Settled::Late(_, e), None) => Err(e),
        }?;
        if let Some(v) = &v {
            crate::logging::Redactor::global().register(v);
        }
        if r.store == CredentialStore::Keyring {
            let mut known = self.known.lock();
            if v.is_some() {
                known.insert(r.key.clone());
            } else {
                known.remove(&r.key);
            }
        }
        Ok(v)
    }

    pub async fn adopt(&self, key: &str, value: &str) -> Result<(), SecretError> {
        file_name(key)?;
        crate::logging::Redactor::global().register(value);
        let s = self
            .store(self.primary())
            .ok_or_else(|| SecretError::Unavailable("no secret store is available".into()))?;
        blocking(
            s,
            |s, key, value| s.set(key, value),
            key,
            value,
            self.deadline,
        )
        .await?;
        match blocking(s, |s, key, _| s.get(key), key, "", self.deadline).await? {
            Some(v) if v == value => Ok(()),
            _ => Err(SecretError::Failed(
                "it does not read back as it was written".into(),
            )),
        }
    }

    pub fn note(&self, r: &CredentialRef) {
        if r.store == CredentialStore::Keyring {
            self.known.lock().insert(r.key.clone());
        }
    }

    pub fn bound_to_binary(&self) -> bool {
        self.keyring.as_ref().is_some_and(|k| k.bound_to_binary())
    }

    pub async fn hand_over(&self, adopter: &mut dyn Adopter) -> HandOver {
        let mut out = HandOver::default();
        let Some(k) = &self.keyring else {
            return out;
        };
        let until = tokio::time::Instant::now() + HAND_OVER_BUDGET;
        let mut listening = true;
        let keys: Vec<String> = self.known.lock().iter().cloned().collect();
        for key in keys {
            if !listening {
                out.left.push(key);
                continue;
            }
            let value = match blocking(k, |s, key, _| s.get(key), &key, "", self.deadline).await {
                Ok(Some(v)) => v,
                Ok(None) => continue,
                Err(e) => {
                    tracing::warn!(key = %key, error = %e, "a saved secret is not handed over: it cannot be read");
                    out.left.push(key);
                    continue;
                }
            };
            if tokio::time::Instant::now() >= until {
                out.left.push(key);
                continue;
            }
            if let Err(e) = joined(spawn_call(k, |s, key, _| s.delete(key), &key, "").await) {
                tracing::warn!(key = %key, error = %e, "a saved secret is not handed over: it cannot be taken out");
                out.left.push(key);
                continue;
            }
            match adopter.adopt(&key, &value).await {
                Ok(()) => out.handed.push(key),
                Err(why) => {
                    listening = !matches!(why, NotKept::Gone(_));
                    tracing::warn!(key = %key, %why, "the update did not keep a saved secret: it stays here");
                    if let Err(e) =
                        joined(spawn_call(k, |s, key, value| s.set(key, value), &key, &value).await)
                    {
                        tracing::error!(key = %key, error = %e, "a saved secret could not be put back");
                    }
                    out.left.push(key);
                }
            }
        }
        out
    }

    pub fn location(&self, r: &CredentialRef) -> String {
        self.store(r.store)
            .map_or_else(|| default_location(r.store, &r.key), |s| s.location(&r.key))
    }

    pub fn primary(&self) -> CredentialStore {
        if self.keyring.is_some() {
            CredentialStore::Keyring
        } else {
            CredentialStore::DevFile
        }
    }

    pub fn secrets_dir(&self) -> Option<PathBuf> {
        self.file.as_ref().and_then(|f| f.secrets_dir())
    }

    pub fn keyring_service(&self) -> Option<String> {
        self.keyring.as_ref().and_then(|k| k.keyring_service())
    }

    pub async fn delete_in_own_store(&self, r: &CredentialRef) -> Result<(), SecretError> {
        if r.store == CredentialStore::Keyring {
            self.known.lock().remove(&r.key);
        }
        match self.store(r.store) {
            Some(s) => blocking(s, |s, key, _| s.delete(key), &r.key, "", self.deadline).await,
            None => Ok(()),
        }
    }

    pub async fn delete_everywhere(&self, r: &CredentialRef) -> Result<(), SecretError> {
        self.known.lock().remove(&r.key);
        let other = match r.store {
            CredentialStore::Keyring => self.file.as_ref(),
            CredentialStore::DevFile => self.keyring.as_ref(),
        };
        if let Some(o) = other {
            let store = store_name(o.kind());
            let call = spawn_call(o, |s, key, _| s.delete(key), &r.key, "");
            tokio::spawn(async move {
                if let Err(e) = joined(call.await) {
                    tracing::warn!(store, error = %e, "a copy of a secret could not be deleted");
                }
            });
        }
        match self.store(r.store) {
            Some(s) => blocking(s, |s, key, _| s.delete(key), &r.key, "", self.deadline).await,
            None => Ok(()),
        }
    }
}

pub fn store_name(kind: CredentialStore) -> &'static str {
    match kind {
        CredentialStore::Keyring => "OS keyring",
        CredentialStore::DevFile => "development secrets file",
    }
}

type Call<T> = tokio::task::JoinHandle<Result<T, SecretError>>;

fn take_back_late_write(store: Arc<dyn SecretStore>, key: String, call: Call<()>) {
    tokio::spawn(async move {
        if let Ok(Ok(())) = call.await {
            let undo = spawn_call(&store, |s, key, _| s.delete(key), &key, "");
            if let Ok(Err(e)) = undo.await {
                tracing::warn!(error = %e, "a late keyring write could not be taken back");
            }
        }
    });
}

fn spawn_call<T: Send + 'static>(
    store: &Arc<dyn SecretStore>,
    f: fn(&dyn SecretStore, &str, &str) -> Result<T, SecretError>,
    key: &str,
    value: &str,
) -> Call<T> {
    let (s, key, value) = (Arc::clone(store), key.to_owned(), value.to_owned());
    tokio::task::spawn_blocking(move || f(s.as_ref(), &key, &value))
}

enum Settled<T> {
    Done(Result<T, SecretError>),
    /// A blocking thread cannot be cancelled: the call may still finish.
    Late(Call<T>, SecretError),
}

fn joined<T>(r: Result<Result<T, SecretError>, tokio::task::JoinError>) -> Result<T, SecretError> {
    r.unwrap_or_else(|e| {
        Err(SecretError::Failed(format!(
            "the secret store call failed: {e}"
        )))
    })
}

async fn settle<T>(mut call: Call<T>, kind: CredentialStore, deadline: Duration) -> Settled<T> {
    match tokio::time::timeout(deadline, &mut call).await {
        Ok(r) => Settled::Done(joined(r)),
        Err(_) => Settled::Late(
            call,
            SecretError::Unavailable(format!(
                "the {} did not answer within {}s",
                store_name(kind),
                deadline.as_secs_f32()
            )),
        ),
    }
}

async fn blocking<T: Send + 'static>(
    store: &Arc<dyn SecretStore>,
    f: fn(&dyn SecretStore, &str, &str) -> Result<T, SecretError>,
    key: &str,
    value: &str,
    deadline: Duration,
) -> Result<T, SecretError> {
    let call = spawn_call(store, f, key, value);
    match settle(call, store.kind(), deadline).await {
        Settled::Done(r) => r,
        Settled::Late(_, e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use tessera_core::private::is_private;

    use super::*;

    #[derive(Debug)]
    struct NoKeyring;

    impl SecretStore for NoKeyring {
        fn kind(&self) -> CredentialStore {
            CredentialStore::Keyring
        }
        fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
            Err(SecretError::Unavailable("no keyring".into()))
        }
        fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
            Err(SecretError::Unavailable("no keyring".into()))
        }
        fn delete(&self, _: &str) -> Result<(), SecretError> {
            Err(SecretError::Unavailable("no keyring".into()))
        }
    }

    #[tokio::test]
    async fn the_keyring_is_used_when_it_answers() {
        let s = Secrets::in_memory();
        let r = s.put("rithmic.a", "v1").await.unwrap();
        assert_eq!(r.store, CredentialStore::Keyring);
        assert_eq!(s.get(&r).await.unwrap().as_deref(), Some("v1"));
        s.delete_everywhere(&r).await.unwrap();
        assert_eq!(s.get(&r).await.unwrap(), None);
    }

    #[tokio::test]
    async fn without_a_keyring_secrets_go_to_private_files() {
        let dir = tempfile::tempdir().unwrap();
        let secrets_dir = dir.path().join("tessera/secrets");
        let s = Secrets::with_stores(
            Some(Arc::new(NoKeyring)),
            Some(Arc::new(FileStore::new(&secrets_dir))),
        );
        let r = s.put("rithmic.apex", "{\"user\":\"x\"}").await.unwrap();
        assert_eq!(r.store, CredentialStore::DevFile);
        assert_eq!(
            s.get(&r).await.unwrap().as_deref(),
            Some("{\"user\":\"x\"}")
        );
        assert!(is_private(&secrets_dir));
        assert!(is_private(&secrets_dir.join("rithmic.apex.secret")));
        s.delete_everywhere(&r).await.unwrap();
        assert_eq!(s.get(&r).await.unwrap(), None);
        s.delete_everywhere(&r).await.unwrap();
    }

    #[derive(Debug)]
    struct GatedKeyring {
        store: MemoryStore,
        gate: Mutex<std::sync::mpsc::Receiver<()>>,
        writes: Mutex<u32>,
    }

    impl GatedKeyring {
        fn new() -> (Self, std::sync::mpsc::Sender<()>) {
            let (open, gate) = std::sync::mpsc::channel();
            let keyring = Self {
                store: MemoryStore::new(CredentialStore::Keyring),
                gate: Mutex::new(gate),
                writes: Mutex::new(0),
            };
            (keyring, open)
        }
    }

    impl SecretStore for GatedKeyring {
        fn kind(&self) -> CredentialStore {
            CredentialStore::Keyring
        }
        fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
            self.store.get(key)
        }
        fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
            let _ = self.gate.lock().recv();
            self.store.set(key, value)?;
            *self.writes.lock() += 1;
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), SecretError> {
            self.store.delete(key)
        }
    }

    #[tokio::test]
    async fn without_the_development_fallback_a_failing_keyring_stores_nothing() {
        let file = Arc::new(MemoryStore::new(CredentialStore::DevFile));
        let s = Secrets::with_stores(Some(Arc::new(NoKeyring)), Some(Arc::clone(&file) as _))
            .without_fallback();
        let e = s.put("rithmic.apex", "secret").await.unwrap_err();
        assert!(e.to_string().contains("Unlock the OS keyring"), "{e}");
        assert_eq!(file.get("rithmic.apex").unwrap(), None);
    }

    #[tokio::test]
    async fn a_keyring_write_that_lands_late_is_taken_back() {
        let (keyring, open) = GatedKeyring::new();
        let keyring = Arc::new(keyring);
        let s = Secrets::with_stores(
            Some(Arc::clone(&keyring) as _),
            Some(Arc::new(MemoryStore::new(CredentialStore::DevFile))),
        )
        .with_deadline(Duration::from_millis(250));
        let r = s.put("rithmic.apex", "secret").await.unwrap();
        assert_eq!(r.store, CredentialStore::DevFile);
        open.send(()).unwrap();
        let (writes, kept) = tessera_core::settle::settle(
            "the late keyring write is taken back",
            || (*keyring.writes.lock(), keyring.get("rithmic.apex").unwrap()),
            |(writes, kept)| *writes == 1 && kept.is_none(),
        )
        .await;
        assert_eq!((writes, kept), (1, None));
        assert_eq!(s.get(&r).await.unwrap().as_deref(), Some("secret"));
    }

    #[tokio::test]
    async fn deleting_a_login_clears_both_stores() {
        let keyring = Arc::new(MemoryStore::new(CredentialStore::Keyring));
        let file = Arc::new(MemoryStore::new(CredentialStore::DevFile));
        keyring.set("rithmic.apex", "stray").unwrap();
        let s = Secrets::with_stores(
            Some(Arc::clone(&keyring) as _),
            Some(Arc::clone(&file) as _),
        );
        let r = CredentialRef {
            store: CredentialStore::DevFile,
            key: "rithmic.apex".into(),
        };
        file.set("rithmic.apex", "kept").unwrap();
        s.delete_everywhere(&r).await.unwrap();
        assert_eq!(file.get("rithmic.apex").unwrap(), None);
        let stray = tessera_core::settle::settle(
            "the stray keyring copy is deleted",
            || keyring.get("rithmic.apex").unwrap(),
            Option::is_none,
        )
        .await;
        assert_eq!(stray, None);
    }

    #[test]
    fn a_named_keyring_service_keeps_its_logins_apart() {
        assert_eq!(keyring_service(None), "tessera");
        assert_eq!(keyring_service(Some("  ")), "tessera");
        assert_eq!(keyring_service(Some("tessera-test")), "tessera-test");
        let other = KeyringStore::new("tessera-test");
        assert_eq!(
            other.location("rithmic.rithmic-apex"),
            "OS keyring, service tessera-test, key rithmic.rithmic-apex"
        );
        let s = Secrets::with_stores(Some(Arc::new(other)), None);
        assert_eq!(s.keyring_service().as_deref(), Some("tessera-test"));
        assert_eq!(
            KeyringStore::default().keyring_service().as_deref(),
            Some("tessera")
        );
    }

    #[test]
    fn a_secret_is_located_in_words_never_by_its_value() {
        let dir = tempfile::tempdir().unwrap();
        let file = FileStore::new(dir.path().join("secrets"));
        let s = Secrets::with_stores(
            Some(Arc::new(MemoryStore::new(CredentialStore::Keyring))),
            Some(Arc::new(file)),
        );
        let keyring = CredentialRef {
            store: CredentialStore::Keyring,
            key: "rithmic.rithmic-apex".into(),
        };
        assert_eq!(
            s.location(&keyring),
            "OS keyring, service tessera, key rithmic.rithmic-apex"
        );
        let dev = CredentialRef {
            store: CredentialStore::DevFile,
            key: "levels.acme".into(),
        };
        assert_eq!(
            s.location(&dev),
            dir.path()
                .join("secrets")
                .join("levels.acme.secret")
                .display()
                .to_string()
        );
        assert_eq!(s.secrets_dir(), Some(dir.path().join("secrets")));
        assert_eq!(s.primary(), CredentialStore::Keyring);
        let file_only = Secrets::with_stores(None, Some(Arc::new(FileStore::new("/x"))));
        assert_eq!(file_only.primary(), CredentialStore::DevFile);
    }

    #[test]
    fn keys_cannot_leave_the_directory() {
        let f = FileStore::new("/nonexistent");
        for bad in ["", "../x", "a/b", ".hidden", "a b"] {
            assert!(f.get(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            file_name("rithmic.rithmic-apex").unwrap(),
            "rithmic.rithmic-apex.secret"
        );
    }

    #[tokio::test]
    async fn a_login_kept_by_the_build_before_moves_over_on_its_first_read() {
        let own = Arc::new(MemoryStore::new(CredentialStore::Keyring));
        let previous = Arc::new(MemoryStore::new(CredentialStore::Keyring));
        previous
            .set("rithmic.rithmic-apex", "nightly login")
            .unwrap();
        previous.set("account.session", "nightly session").unwrap();
        own.set("account.session", "own session").unwrap();
        let s = Secrets::with_stores(Some(Arc::clone(&own) as Arc<dyn SecretStore>), None)
            .carrying_over_keyring(Arc::clone(&previous) as Arc<dyn SecretStore>);
        let r = |key: &str| CredentialRef {
            store: CredentialStore::Keyring,
            key: key.into(),
        };

        assert_eq!(
            s.get(&r("account.session")).await.unwrap().as_deref(),
            Some("own session")
        );
        assert_eq!(
            s.get(&r("rithmic.rithmic-apex")).await.unwrap().as_deref(),
            Some("nightly login")
        );
        assert_eq!(
            own.get("rithmic.rithmic-apex").unwrap().as_deref(),
            Some("nightly login")
        );
        assert_eq!(previous.get("rithmic.rithmic-apex").unwrap(), None);
        assert_eq!(s.get(&r("levels.acme")).await.unwrap(), None);

        s.delete_in_own_store(&r("rithmic.rithmic-apex"))
            .await
            .unwrap();
        assert_eq!(s.get(&r("rithmic.rithmic-apex")).await.unwrap(), None);
    }
}
