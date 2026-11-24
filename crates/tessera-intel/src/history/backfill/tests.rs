use std::io::Write as _;
use std::sync::Arc;

use serde_json::json;
use tessera_core::SharedClock;
use tessera_core::Timestamp;
use tessera_core::clock::ManualClock;

use super::backfill;
use crate::history::LevelHistory;
use crate::history::file::Roots;
use crate::history::io::BackfillLevelHistoryInput;
use crate::router::IntelRouter;
use crate::source::fake::FakeHttp;
use crate::source::http::{HttpClient, HttpResponse};
use crate::source::{HttpLevelSource, LevelSourceSpec, Secret};
use crate::{IntelligenceProvider, history};

fn spec(history: serde_json::Value) -> LevelSourceSpec {
    serde_json::from_value(json!({
        "version": 1,
        "id": "acme",
        "name": "Acme levels",
        "vendor": "Acme",
        "baseUrl": "https://api.acme.test",
        "auth": {"in": "header", "name": "Authorization", "prefix": "Bearer "},
        "instruments": [{"root": "NQ", "ticker": "NDX"}],
        "requests": [
            {"id": "state", "package": "State", "endpoint": "state/gamma_zero",
             "path": "/{ticker}/state/gamma_zero", "asOf": {"path": "timestamp"},
             "fields": [
                {"field": "major_positive", "naIf": [0]},
                {"field": "major_long_gamma"},
                {"field": "major_short_gamma"},
                {"field": "never_sent"}
             ]},
            {"id": "classic", "package": "Classic", "endpoint": "classic/gex_full",
             "path": "/{ticker}/classic/gex_full", "asOf": {"path": "timestamp"},
             "fields": [{"field": "zero_gamma"}]}
        ],
        "schedule": {"everySeconds": 60},
        "history": history
    }))
    .unwrap()
}

fn history_api() -> serde_json::Value {
    json!({
        "path": "/hist/{ticker}/{endpoint}/{date}",
        "query": {"noredirect": "true"},
        "link": "url",
        "daysBack": 90,
        "pool": "history_cache",
        "dailyCap": 20
    })
}

fn input(dry: bool, packages: &[&str]) -> BackfillLevelHistoryInput {
    BackfillLevelHistoryInput {
        provider: None,
        ticker: "NDX".into(),
        instrument: None,
        from: "2026-10-07".into(),
        to: None,
        packages: Some(packages.iter().map(|p| (*p).to_owned()).collect()),
        dry_run: Some(dry),
    }
}

fn gzip(v: &serde_json::Value) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&serde_json::to_vec(v).unwrap()).unwrap();
    gz.finish().unwrap()
}

#[tokio::test]
async fn a_specs_history_api_is_backfilled_through_a_signed_link_that_never_gets_the_key() {
    let http = FakeHttp::new();
    let clock = Arc::new(ManualClock::new(
        Timestamp::parse("2026-10-09T17:00:00-04:00").unwrap(),
    ));
    let src = HttpLevelSource::new(
        spec(history_api()),
        Some(Secret::new("acme_custom_k")),
        Arc::clone(&http) as Arc<dyn HttpClient>,
        Arc::clone(&clock) as SharedClock,
    )
    .unwrap();
    assert!(src.capabilities().history);
    let reach = src.level_source().unwrap().history.unwrap();
    assert_eq!(reach.pool, "history_cache");
    assert_eq!(reach.tickers[0].ticker, "NDX");

    let base = 1_791_379_800;
    let snaps: Vec<serde_json::Value> = (0..180)
        .map(|i| {
            json!({"timestamp": base + i, "major_positive": 0,
                   "major_long_gamma": 20_850 + (i / 60) * 10, "major_short_gamma": 20_300})
        })
        .collect();
    let link = "https://files.example.test/dl/2026-10-07_NDX_state.json.gz?sig=a%2Fb&se=1";
    http.route(
        "/hist/NDX/state/gamma_zero/2026-10-07",
        200,
        &json!({ "url": link }),
    );
    http.answer(
        "dl/2026-10-07_NDX_state.json.gz?sig=a%2Fb&se=1",
        Ok(HttpResponse {
            status: 200,
            body: gzip(&json!(snaps)),
        }),
    );

    let router = IntelRouter::new();
    router.add(Arc::new(src)).unwrap();
    let store = tessera_store::Store::open_in_memory().unwrap();
    let svc = LevelHistory::new(store.clone(), clock, Roots::default(), router);
    let dry = backfill(&svc, &input(true, &["State", "Classic"]), "user")
        .await
        .unwrap();
    assert_eq!(dry.files.len(), 2);
    assert!(dry.files.iter().all(|f| f.status == "would_ask"));
    assert!(http.calls().is_empty());

    let done = backfill(&svc, &input(false, &["State", "Classic"]), "user")
        .await
        .unwrap();
    assert_eq!(done.files[0].status, "stored", "{:?}", done.files[0]);
    assert_eq!(
        done.files[0].imported, 9,
        "three fields, the last of each minute"
    );
    assert_eq!(done.files[1].status, "failed");
    assert!(
        done.files[1]
            .message
            .as_deref()
            .unwrap()
            .contains("not a trading day")
    );
    let calls = http.calls();
    let hist = calls
        .iter()
        .find(|c| c.url.ends_with("/hist/NDX/state/gamma_zero/2026-10-07"))
        .unwrap();
    assert!(hist.headers.iter().any(|(k, _)| k == "Authorization"));
    assert!(
        hist.query
            .contains(&("noredirect".to_owned(), "true".to_owned()))
    );
    let dl = calls
        .iter()
        .find(|c| c.url.starts_with("https://files.example.test/"))
        .unwrap();
    assert_eq!(dl.url, link, "the signed link is kept exactly");
    assert!(
        !dl.headers
            .iter()
            .any(|(k, v)| k == "Authorization" || v.contains("acme_custom_k"))
    );

    let h = store.level_history();
    let series = h.all_series().unwrap();
    assert!(series.iter().all(|s| s.info.level != "never_sent"));
    let mlg = series
        .into_iter()
        .find(|s| s.info.level == "major_long_gamma")
        .unwrap();
    assert_eq!(mlg.info.vendor, "Acme");
    assert_eq!(mlg.info.package, "State");
    assert_eq!(mlg.info.instrument, "NDX");
    assert_eq!(mlg.info.endpoint.as_deref(), Some("state/gamma_zero"));
    let obs = h.observations(mlg.id, None, None, 10).unwrap();
    assert_eq!(
        obs.iter().map(|o| o.value.unwrap()).collect::<Vec<_>>(),
        [20_850.0, 20_860.0, 20_870.0]
    );
    assert!(
        obs.iter()
            .all(|o| o.origin == "backfill" && o.known_at == o.as_of)
    );
    let again = backfill(&svc, &input(false, &["State"]), "user")
        .await
        .unwrap();
    assert_eq!(again.files[0].status, "already");
}

#[tokio::test]
async fn a_key_the_history_api_refuses_stops_the_source_as_the_levels_api_does() {
    let http = FakeHttp::new();
    let clock = Arc::new(ManualClock::new(
        Timestamp::parse("2026-10-09T17:00:00-04:00").unwrap(),
    ));
    let src = Arc::new(
        HttpLevelSource::new(
            spec(history_api()),
            Some(Secret::new("acme_custom_k")),
            Arc::clone(&http) as Arc<dyn HttpClient>,
            Arc::clone(&clock) as SharedClock,
        )
        .unwrap(),
    );
    http.answer(
        "/hist/NDX/state/gamma_zero/2026-10-07",
        Ok(HttpResponse {
            status: 401,
            body: Vec::new(),
        }),
    );
    let router = IntelRouter::new();
    router
        .add(Arc::clone(&src) as Arc<dyn IntelligenceProvider>)
        .unwrap();
    let store = tessera_store::Store::open_in_memory().unwrap();
    let svc = LevelHistory::new(store, clock, Roots::default(), router);
    let _ = backfill(&svc, &input(false, &["State"]), "user").await;
    let h = src.health();
    assert_eq!(h.status, tessera_core::health::HealthStatus::Down);
    assert!(
        h.message
            .unwrap_or_default()
            .contains("refused the key (401)"),
        "the key is the same key for levels and history"
    );
}

#[tokio::test]
async fn a_spec_without_a_history_api_is_not_offered_for_a_backfill() {
    let http = FakeHttp::new();
    let clock = Arc::new(ManualClock::new(
        Timestamp::parse("2026-10-09T17:00:00-04:00").unwrap(),
    ));
    let src = HttpLevelSource::new(
        spec(serde_json::Value::Null),
        Some(Secret::new("k")),
        Arc::clone(&http) as Arc<dyn HttpClient>,
        Arc::clone(&clock) as SharedClock,
    )
    .unwrap();
    assert!(!src.capabilities().history);
    let router = IntelRouter::new();
    router.add(Arc::new(src)).unwrap();
    let svc = history::LevelHistory::new(
        tessera_store::Store::open_in_memory().unwrap(),
        clock,
        Roots::default(),
        router,
    );
    let e = backfill(&svc, &input(false, &["State"]), "user")
        .await
        .unwrap_err();
    assert!(e.contains("history API"), "{e}");
}
