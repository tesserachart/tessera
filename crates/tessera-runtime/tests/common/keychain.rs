use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tessera_core::accounts::CredentialStore;
use tessera_runtime::secrets::{SecretError, SecretStore};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Pending,
    Allow,
    Deny,
}

#[derive(Debug)]
struct Item {
    value: String,
    builds: BTreeSet<String>,
}

#[derive(Debug)]
struct Shared {
    items: HashMap<String, Item>,
    answer: Answer,
    asked: usize,
    deletes_held: bool,
    deleting: usize,
}

#[derive(Debug)]
pub struct Keychain {
    shared: Mutex<Shared>,
    answered: Condvar,
}

impl Keychain {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            shared: Mutex::new(Shared {
                items: HashMap::new(),
                answer: Answer::Pending,
                asked: 0,
                deletes_held: false,
                deleting: 0,
            }),
            answered: Condvar::new(),
        })
    }

    pub fn build(self: &Arc<Self>, name: &str) -> Arc<dyn SecretStore> {
        Arc::new(Build {
            keychain: Arc::clone(self),
            name: name.to_owned(),
        })
    }

    pub fn answer(&self, answer: Answer) {
        self.shared.lock().unwrap().answer = answer;
        self.answered.notify_all();
    }

    pub fn hold_deletes(&self, held: bool) {
        self.shared.lock().unwrap().deletes_held = held;
        self.answered.notify_all();
    }

    pub fn deleting(&self) -> usize {
        self.shared.lock().unwrap().deleting
    }

    pub fn asked(&self) -> usize {
        self.shared.lock().unwrap().asked
    }

    pub fn builds(&self, key: &str) -> Vec<String> {
        self.shared
            .lock()
            .unwrap()
            .items
            .get(key)
            .map(|i| i.builds.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn open(&self, key: &str, build: &str) -> Result<Option<String>, SecretError> {
        let mut shared = self.shared.lock().unwrap();
        let Some(item) = shared.items.get(key) else {
            return Ok(None);
        };
        if item.builds.contains(build) {
            return Ok(Some(item.value.clone()));
        }
        shared.asked += 1;
        let (mut shared, _) = self
            .answered
            .wait_timeout_while(shared, Duration::from_secs(30), |s| {
                s.answer == Answer::Pending
            })
            .unwrap();
        match shared.answer {
            Answer::Allow => {
                let item = shared.items.get_mut(key).ok_or_else(|| {
                    SecretError::Failed("the item went while the user was asked".into())
                })?;
                item.builds.insert(build.to_owned());
                Ok(Some(item.value.clone()))
            }
            Answer::Deny | Answer::Pending => Err(SecretError::Unavailable(
                "the OS keyring is not available (the user did not allow it)".into(),
            )),
        }
    }
}

#[derive(Debug)]
struct Build {
    keychain: Arc<Keychain>,
    name: String,
}

impl SecretStore for Build {
    fn kind(&self) -> CredentialStore {
        CredentialStore::Keyring
    }

    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        self.keychain.open(key, &self.name)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        self.keychain.open(key, &self.name)?;
        let mut shared = self.keychain.shared.lock().unwrap();
        let item = shared.items.entry(key.to_owned()).or_insert_with(|| Item {
            value: String::new(),
            builds: BTreeSet::from([self.name.clone()]),
        });
        item.value = value.to_owned();
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        let mut shared = self.keychain.shared.lock().unwrap();
        shared.deleting += 1;
        let (mut shared, _) = self
            .keychain
            .answered
            .wait_timeout_while(shared, Duration::from_secs(30), |s| s.deletes_held)
            .unwrap();
        shared.deleting -= 1;
        shared.items.remove(key);
        Ok(())
    }

    fn bound_to_binary(&self) -> bool {
        true
    }
}
