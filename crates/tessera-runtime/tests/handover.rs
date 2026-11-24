use std::sync::Arc;

use tessera_core::accounts::{CredentialRef, CredentialStore};
use tessera_runtime::handover::{ADOPT_COMMAND, Child};
use tessera_runtime::secrets::{MemoryStore, SECRET_STORE_ENV, SecretStore, Secrets};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const RUNTIME: &str = env!("CARGO_BIN_EXE_tessera-runtime");

const LOGIN: &str = r#"{"user":"someone","password":"correct-horse-battery"}"#;

fn new_build(config: &std::path::Path) -> Command {
    let mut c = Command::new(RUNTIME);
    c.env(SECRET_STORE_ENV, "file")
        .env("XDG_CONFIG_HOME", config)
        .env_remove("TESSERA_KEYRING_SERVICE");
    c
}

fn kept(config: &std::path::Path, key: &str) -> Option<String> {
    std::fs::read_to_string(config.join("tessera/secrets").join(format!("{key}.secret"))).ok()
}

#[tokio::test]
async fn the_new_build_keeps_what_the_build_before_hands_over() {
    let config = tempfile::tempdir().unwrap();
    let before = Arc::new(MemoryStore::new(CredentialStore::Keyring));
    let secrets = Secrets::with_stores(Some(Arc::clone(&before) as Arc<dyn SecretStore>), None);
    secrets.put("rithmic.rithmic-test", LOGIN).await.unwrap();
    secrets.put("account.session", "r0").await.unwrap();
    secrets.note(&CredentialRef {
        store: CredentialStore::Keyring,
        key: "levels.acme".into(),
    });

    let mut child = Child::spawn(new_build(config.path())).unwrap();
    let out = secrets.hand_over(&mut child).await;
    child.finish().await;

    assert_eq!(out.handed, ["account.session", "rithmic.rithmic-test"]);
    assert!(out.left.is_empty(), "{out:?}");
    assert_eq!(before.get("rithmic.rithmic-test").unwrap(), None);
    assert_eq!(before.get("account.session").unwrap(), None);
    assert_eq!(
        kept(config.path(), "rithmic.rithmic-test").as_deref(),
        Some(LOGIN)
    );
    assert_eq!(
        kept(config.path(), "account.session").as_deref(),
        Some("r0")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(config.path().join("tessera/secrets/account.session.secret"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[tokio::test]
async fn what_the_new_build_cannot_keep_stays_with_the_build_before() {
    let config = tempfile::tempdir().unwrap();
    let before = Arc::new(MemoryStore::new(CredentialStore::Keyring));
    let secrets = Secrets::with_stores(Some(Arc::clone(&before) as Arc<dyn SecretStore>), None);
    secrets.put("../outside", "v1").await.unwrap();
    secrets.put("rithmic.rithmic-test", LOGIN).await.unwrap();

    let mut child = Child::spawn(new_build(config.path())).unwrap();
    let out = secrets.hand_over(&mut child).await;
    child.finish().await;
    assert_eq!(out.handed, ["rithmic.rithmic-test"]);
    assert_eq!(out.left, ["../outside"]);
    assert_eq!(before.get("../outside").unwrap().as_deref(), Some("v1"));
    assert!(!config.path().join("outside.secret").exists());

    assert!(Child::spawn(Command::new("/nonexistent/tessera-runtime")).is_err());
    let mut quits = Command::new(RUNTIME);
    quits.arg("--version");
    let mut child = Child::spawn(quits).unwrap();
    secrets.put("account.session", "r0").await.unwrap();
    let out = secrets.hand_over(&mut child).await;
    child.finish().await;
    assert!(out.handed.is_empty(), "{out:?}");
    assert_eq!(
        out.left,
        ["../outside", "account.session", "rithmic.rithmic-test"]
    );
    assert_eq!(
        before.get("account.session").unwrap().as_deref(),
        Some("r0")
    );
    assert_eq!(before.get("../outside").unwrap().as_deref(), Some("v1"));
}

#[tokio::test]
async fn adopt_secrets_answers_each_line_and_never_echoes_one() {
    let config = tempfile::tempdir().unwrap();
    let mut child = new_build(config.path())
        .arg(ADOPT_COMMAND)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut acks = BufReader::new(child.stdout.take().unwrap()).lines();
    stdin
        .write_all(b"not json correct-horse-battery\n{\"key\":\"a b\",\"value\":\"correct-horse-battery\"}\n")
        .await
        .unwrap();
    stdin
        .write_all(b"{\"key\":\"account.session\",\"value\":\"correct-horse-battery\"}\n")
        .await
        .unwrap();
    drop(stdin);
    let mut said = Vec::new();
    while let Some(line) = acks.next_line().await.unwrap() {
        said.push(serde_json::from_str::<serde_json::Value>(&line).unwrap());
    }
    assert!(child.wait().await.unwrap().success());
    assert_eq!(said.len(), 3, "{said:?}");
    assert_eq!(said[0]["kept"], false);
    assert_eq!(said[1]["kept"], false);
    assert_eq!(said[1]["key"], "a b");
    assert_eq!(said[2]["kept"], true);
    assert_eq!(said[2]["key"], "account.session");
    let all = serde_json::to_string(&said).unwrap();
    assert!(!all.contains("correct-horse-battery"), "{all}");
    assert_eq!(
        kept(config.path(), "account.session").as_deref(),
        Some("correct-horse-battery")
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "uses the login keychain of the Mac it runs on"]
async fn on_the_macos_keychain_the_new_build_reads_what_was_handed_over_without_asking() {
    use tessera_runtime::secrets::{KEYRING_SERVICE_ENV, KeyringStore};

    let service = format!("tessera-handover-test-{}", std::process::id());
    let key = "rithmic.rithmic-test";
    let this_build = Arc::new(KeyringStore::new(&service));
    let secrets = Secrets::with_stores(Some(Arc::clone(&this_build) as Arc<dyn SecretStore>), None)
        .without_fallback();
    assert!(secrets.bound_to_binary());
    secrets.put(key, LOGIN).await.unwrap();
    let runtime = || {
        let mut c = Command::new(RUNTIME);
        c.env(KEYRING_SERVICE_ENV, &service)
            .env_remove(SECRET_STORE_ENV);
        c
    };
    let rewrite = || async {
        let mut child = Child::spawn(runtime()).unwrap();
        let r = tessera_runtime::secrets::Adopter::adopt(&mut child, key, LOGIN).await;
        child.finish().await;
        r
    };

    let before = rewrite().await;
    assert!(
        before.is_err(),
        "another build used this one's item without the user: {before:?}"
    );

    let mut child = Child::spawn(runtime()).unwrap();
    let out = secrets.hand_over(&mut child).await;
    child.finish().await;
    assert_eq!(out.handed, [key], "{out:?}");

    let after = rewrite().await;
    let _ = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", &service, "-a", key])
        .output();
    assert_eq!(after, Ok(()), "the new build could not use its own item");
}
