use std::sync::Arc;

use serde_json::{Value, json};
use tessera_core::Origin;
use tessera_core::ids::SessionId;
use tessera_protocol::tools::{SessionMode, ToolErrorCode};
use tessera_runtime::{Runtime, RuntimeConfig, VERSION};
use tessera_store::Store;
use tessera_testkit::Fakes;
use tessera_tools::{Audience, InvokeRequest, Invoker, SessionPolicy};

fn agent() -> Origin {
    Origin::Agent {
        session_id: SessionId::new("S-data"),
        provider: "codex".into(),
    }
}

async fn invoke(
    inv: &Invoker,
    name: &str,
    origin: Origin,
) -> Result<Value, (ToolErrorCode, String)> {
    let r = inv
        .invoke(InvokeRequest::new(name, json!({}), origin))
        .await;
    match (r.ok, r.output, r.error) {
        (true, Some(out), _) => Ok(out),
        (_, _, Some(e)) => Err((e.code, e.message)),
        other => panic!("{name}: {other:?}"),
    }
}

fn tables(store: &Store) -> Vec<String> {
    let conn = store.conn().unwrap();
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_data_directory_is_described_and_the_user_backs_it_up() {
    let dir = tempfile::tempdir().unwrap();
    let rt = Runtime::build(
        RuntimeConfig {
            data_dir: Some(dir.path().to_path_buf()),
            ..RuntimeConfig::default()
        },
        vec![Fakes::still(1).module()],
    )
    .await
    .unwrap();
    let state = Arc::clone(rt.state());
    let inv = Arc::clone(&state.invoker);
    inv.set_policy(&agent(), SessionPolicy::with_mode(SessionMode::AutoModify));

    let names: Vec<String> = inv
        .registry()
        .descriptors(Audience::Agent, None, true)
        .into_iter()
        .map(|d| d.name)
        .collect();
    assert!(names.iter().any(|n| n == "runtime.data_info"));
    assert!(!names.iter().any(|n| n == "runtime.backup"));
    let info = invoke(&inv, "runtime.data_info", agent()).await.unwrap();
    assert_eq!(info["dataDir"], dir.path().display().to_string());
    assert_eq!(info["version"], VERSION);
    assert_eq!(info["profile"], "debug");
    assert_eq!(info["secretStore"], "keyring");
    let files = info["files"].as_array().unwrap();
    assert_eq!(files[0]["what"], "database", "{info}");
    assert_eq!(
        files[0]["path"],
        dir.path().join("tessera.db").display().to_string()
    );
    assert!(files[0]["bytes"].as_u64().unwrap() > 0);
    assert!(
        files.iter().all(|f| f["what"] != "backups"),
        "no backups yet: {info}"
    );
    let total: u64 = files.iter().map(|f| f["bytes"].as_u64().unwrap()).sum();
    assert_eq!(info["totalBytes"], total);
    let counts: Vec<&str> = info["counts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["what"].as_str().unwrap())
        .collect();
    assert_eq!(
        counts,
        [
            "Workspaces",
            "Journal fills",
            "Research studies",
            "Analyst sessions",
            "Custom indicators",
            "Tool calls recorded"
        ]
    );

    for origin in [
        agent(),
        Origin::External {
            client_id: "mcp-client".into(),
        },
    ] {
        let (code, _) = invoke(&inv, "runtime.backup", origin).await.unwrap_err();
        assert_eq!(code, ToolErrorCode::PermissionDenied);
    }
    assert!(!dir.path().join("backups").exists());

    let out = invoke(&inv, "runtime.backup", Origin::User).await.unwrap();
    let path = std::path::PathBuf::from(out["path"].as_str().unwrap());
    assert_eq!(path.parent().unwrap(), dir.path().join("backups"));
    let name = path.file_name().unwrap().to_str().unwrap();
    assert!(
        name.starts_with("tessera-")
            && name.ends_with(".db")
            && name.len() == "tessera-20261009-153000.db".len(),
        "{name}"
    );
    assert_eq!(
        out["bytes"].as_u64().unwrap(),
        std::fs::metadata(&path).unwrap().len()
    );
    let original = tables(&state.store);
    assert!(original.iter().any(|t| t == "layouts"), "{original:?}");
    let copy = Store::open(&path).unwrap();
    assert_eq!(tables(&copy), original);
    let layouts = |s: &Store| -> i64 {
        s.conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM layouts", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(layouts(&copy), layouts(&state.store));
    let again = invoke(&inv, "runtime.backup", Origin::User).await.unwrap();
    assert_ne!(again["path"], out["path"]);

    let info = invoke(&inv, "runtime.data_info", Origin::User)
        .await
        .unwrap();
    let backups = info["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["what"] == "backups")
        .cloned()
        .unwrap();
    assert!(backups["bytes"].as_u64().unwrap() >= out["bytes"].as_u64().unwrap());
}

#[tokio::test]
async fn a_runtime_in_memory_has_no_files_and_no_backup() {
    let rt = Runtime::build(
        RuntimeConfig {
            ..RuntimeConfig::default()
        },
        vec![Fakes::still(1).module()],
    )
    .await
    .unwrap();
    let inv = Arc::clone(&rt.state().invoker);
    let info = invoke(&inv, "runtime.data_info", Origin::User)
        .await
        .unwrap();
    assert_eq!(info["dataDir"], Value::Null);
    assert_eq!(info["files"], json!([]));
    assert_eq!(info["totalBytes"], 0);
    assert!(!info["counts"].as_array().unwrap().is_empty());
    let (code, message) = invoke(&inv, "runtime.backup", Origin::User)
        .await
        .unwrap_err();
    assert_eq!(code, ToolErrorCode::Unavailable);
    assert_eq!(message, "this runtime keeps no data on disk");
}
