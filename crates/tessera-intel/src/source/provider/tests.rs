use std::str::FromStr;

use chrono::NaiveDate;
use serde_json::json;
use tessera_core::Price;
use tessera_core::clock::ManualClock;
use tessera_core::time::NANOS_PER_SEC;

use super::*;
use crate::source::fake::FakeHttp;

fn ts(s: &str) -> Timestamp {
    Timestamp::parse(s).unwrap()
}

fn d(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap()
}

fn spec(extra: serde_json::Value) -> LevelSourceSpec {
    let mut v = json!({
        "version": 1,
        "id": "acme",
        "name": "Acme levels",
        "vendor": "Acme",
        "baseUrl": "https://api.acme.test/v1/",
        "auth": {"in": "header", "name": "Authorization", "prefix": "Bearer "},
        "headers": {"Accept": "application/json"},
        "instruments": [
            {"root": "NQ", "ticker": "NDX", "convert": {"model": "additive", "additive": 40.5}},
            {"root": "MNQ", "ticker": "NDX", "convert": {"model": "additive", "additive": 40.5}},
            {"root": "QQQ", "ticker": "QQQ"}
        ],
        "requests": [{
            "id": "main", "package": "Main", "path": "/levels/{ticker}",
            "asOf": {"path": "ts"},
            "fields": [
                {"field": "call_wall", "label": "Call Wall", "short": "CW", "path": "data.cw", "naIf": [0],
                 "concept": {"concept": "call_wall", "equivalence": "analogous"}},
                {"field": "put_wall", "label": "Put Wall", "path": "data.pw", "naIf": [0]}
            ]
        }],
        "schedule": {"everySeconds": 60, "window": {"session": "us_rth"}}
    });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in e {
            o.insert(k.clone(), x.clone());
        }
    }
    serde_json::from_value(v).unwrap()
}

#[derive(Default)]
struct Raw(Mutex<Vec<(usize, String)>>);

impl RawSink for Raw {
    fn put(&self, bytes: &[u8], _media: &str, source: &str) -> Option<String> {
        self.0.lock().push((bytes.len(), source.to_owned()));
        Some("ab".repeat(32))
    }
}

struct Rig {
    http: Arc<FakeHttp>,
    clock: Arc<ManualClock>,
    raw: Arc<Raw>,
    src: HttpLevelSource,
}

fn rig(spec: LevelSourceSpec, at: &str) -> Rig {
    let http = FakeHttp::new();
    let clock = Arc::new(ManualClock::new(ts(at)));
    let raw = Arc::new(Raw::default());
    let catalog = Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap());
    let src = HttpLevelSource::new(
        spec,
        Some(Secret::new("k-123")),
        Arc::clone(&http) as Arc<dyn HttpClient>,
        Arc::clone(&clock) as SharedClock,
    )
    .unwrap()
    .with_raw(Some(Arc::clone(&raw) as Arc<dyn RawSink>))
    .with_specs(Some(Arc::new(catalog) as Arc<dyn SpecLookup>));
    Rig {
        http,
        clock,
        raw,
        src,
    }
}

fn secs(n: i64) -> i64 {
    n * NANOS_PER_SEC
}

const RTH: &str = "2026-10-08T15:00:00-04:00";

#[tokio::test]
async fn a_spec_source_converts_caches_and_keeps_identity() {
    let r = rig(spec(json!({})), RTH);
    r.http.route(
        "/v1/levels/NDX",
        200,
        &json!({"ts": 1_791_486_000, "data": {"cw": 20850, "pw": 0}}),
    );
    r.http.route(
        "/v1/levels/QQQ",
        200,
        &json!({"ts": 1_791_486_000, "data": {"cw": 492.5, "pw": 480}}),
    );
    let nq = InstrumentId::new("NQZ6.CME").unwrap();
    let s = r.src.levels(&nq, None).await.unwrap();
    assert_eq!(s.instrument, nq);
    assert_eq!(s.as_of, Timestamp::from_secs(1_791_486_000));
    assert_eq!(s.raw_blob.as_deref(), Some("ab".repeat(32).as_str()));
    let cw = &s.levels[0];
    assert_eq!(cw.key, "acme.main.call_wall");
    assert_eq!(cw.label, "Call Wall");
    assert_eq!(cw.instrument, nq);
    assert_eq!(cw.price, Some(Price(d("20890.50"))));
    assert_eq!(cw.native_price, Some(Price(d("20850"))));
    assert_eq!(cw.source.vendor, "Acme");
    assert_eq!(cw.source.package, "Main");
    assert_eq!(cw.source.field, "call_wall");
    assert_eq!(cw.source.basis, "NDX");
    assert_eq!(cw.source.endpoint.as_deref(), Some("main"));
    let conv = cw.source.conversion.as_ref().unwrap();
    assert_eq!((conv.ratio, conv.additive), (Decimal::ONE, d("40.5")));
    assert_eq!(conv.method, "additive");
    assert_eq!(cw.concept.as_ref().unwrap().concept, "call_wall");
    let pw = &s.levels[1];
    assert_eq!(pw.price, None);
    assert_eq!(
        pw.unavailable_reason.as_deref(),
        Some("the vendor marks it not applicable")
    );

    let calls = r.http.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].url, "https://api.acme.test/v1/levels/NDX");
    assert!(
        calls[0]
            .headers
            .contains(&("Authorization".into(), "Bearer k-123".into()))
    );
    assert!(calls[0].query.is_empty());
    assert_eq!(r.raw.0.lock()[0].1, "acme:/levels/NDX");
    assert!(!format!("{:?}", r.src).contains("k-123"));

    r.src.levels(&nq, None).await.unwrap();
    let m = r
        .src
        .levels(&InstrumentId::new("MNQZ6.CME").unwrap(), None)
        .await
        .unwrap();
    assert_eq!(m.levels[0].price, Some(Price(d("20890.50"))));
    assert_eq!(r.http.calls_to("/levels/NDX"), 1);
    r.clock.advance(secs(60));
    r.src.levels(&nq, None).await.unwrap();
    assert_eq!(r.http.calls_to("/levels/NDX"), 2);

    let q = r
        .src
        .levels(&InstrumentId::new("QQQ").unwrap(), None)
        .await
        .unwrap();
    assert_eq!(q.levels[0].price, Some(Price(d("492.5"))));
    assert_eq!(q.levels[1].price, Some(Price(d("480"))));
    assert!(q.levels[0].source.conversion.is_none());

    assert!(matches!(
        r.src
            .levels(&nq, Some(Timestamp::from_secs(1_791_485_000)))
            .await,
        Err(IntelError::NoSnapshot(_))
    ));
    assert!(matches!(
        r.src
            .levels(&InstrumentId::new("ESZ6.CME").unwrap(), None)
            .await,
        Err(IntelError::NotCovered(_))
    ));
    let rec = r.src.conversion("NDX", &nq).await.unwrap();
    assert_eq!(rec.to_ref(), *conv);
    assert!(matches!(
        r.src.conversion("SPX", &nq).await,
        Err(IntelError::NotCovered(_))
    ));

    let caps = r.src.capabilities();
    assert_eq!(
        (caps.vendor.as_str(), caps.packages.as_slice()),
        ("Acme", &["Main".to_owned()][..])
    );
    assert!(caps.rth_only && caps.conversions);
    let info = r.src.info();
    assert_eq!(info.packages[0].key, "acme.main");
    assert_eq!(info.packages[0].levels[0].key, "acme.main.call_wall");
    assert_eq!(info.calls_today[0].used, 3);
    assert_eq!(
        info.schedule.as_deref(),
        Some("Every minute, US market hours")
    );
    assert_eq!(r.src.health().status, HealthStatus::Ok);
}

#[tokio::test]
async fn outside_the_window_it_asks_once_and_keeps_what_it_has() {
    let r = rig(spec(json!({})), "2026-10-08T17:00:00-04:00");
    r.http.route(
        "/levels/QQQ",
        200,
        &json!({"ts": 1_791_489_600, "data": {"cw": 492.5, "pw": 480}}),
    );
    let qqq = InstrumentId::new("QQQ").unwrap();
    r.src.levels(&qqq, None).await.unwrap();
    r.clock.advance(secs(3600));
    r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(r.http.calls_to("/levels/QQQ"), 1);
    let h = r.src.health();
    assert_eq!(h.status, HealthStatus::Ok);
    assert!(h.message.unwrap().starts_with("Market closed"));
    r.clock.set(ts("2026-10-09T10:00:00-04:00"));
    r.src.levels(&qqq, None).await.unwrap();
    r.clock.set(ts("2026-10-09T16:30:00-04:00"));
    r.src.levels(&qqq, None).await.unwrap();
    r.clock.set(ts("2026-10-09T20:30:00-04:00"));
    r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(r.http.calls_to("/levels/QQQ"), 3);

    let r = rig(
        spec(
            json!({"schedule": {"everySeconds": 60, "window": {"session": "us_rth"}, "offHours": "never"}}),
        ),
        "2026-10-10T12:00:00-04:00",
    );
    match r.src.levels(&qqq, None).await {
        Err(IntelError::Unavailable(why)) => assert!(why.contains("US market hours"), "{why}"),
        other => panic!("{other:?}"),
    }
    assert!(r.http.calls().is_empty());
}

#[tokio::test]
async fn errors_back_off_and_a_refused_key_stops_the_source() {
    let r = rig(spec(json!({})), RTH);
    let qqq = InstrumentId::new("QQQ").unwrap();
    r.http.route(
        "/levels/QQQ",
        500,
        &json!({"error": "Failed to get chart data."}),
    );
    match r.src.levels(&qqq, None).await {
        Err(IntelError::Unavailable(why)) => {
            assert_eq!(why, "Acme had a problem (500): Failed to get chart data.");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(r.src.health().status, HealthStatus::Down);
    r.src.levels(&qqq, None).await.unwrap_err();
    assert_eq!(r.http.calls_to("/levels/QQQ"), 1, "backing off");
    r.clock.advance(secs(2));
    r.http.route(
        "/levels/QQQ",
        200,
        &json!({"ts": 1_791_486_000, "data": {"cw": 492.5, "pw": 480}}),
    );
    r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(r.http.calls_to("/levels/QQQ"), 2);

    r.clock.advance(secs(60));
    r.http.route(
        "/levels/QQQ",
        429,
        &json!({"error": "Rate limit exceeded."}),
    );
    let kept = r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(kept.levels[0].price, Some(Price(d("492.5"))));
    let h = r.src.health();
    assert_eq!(h.status, HealthStatus::Degraded);
    assert!(h.message.unwrap().contains("rate limiting"));
    r.clock.advance(secs(30));
    r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(r.http.calls_to("/levels/QQQ"), 3);
    r.clock.advance(secs(31));
    r.http.answer(
        "/levels/QQQ",
        Ok(super::super::http::HttpResponse {
            status: 401,
            body: Vec::new(),
        }),
    );
    r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(r.http.calls_to("/levels/QQQ"), 4);
    r.clock.advance(secs(3600));
    r.src.levels(&qqq, None).await.unwrap();
    assert!(
        r.src
            .levels(&InstrumentId::new("NQZ6.CME").unwrap(), None)
            .await
            .is_err()
    );
    assert_eq!(r.http.calls().len(), 4);
    let h = r.src.health();
    assert_eq!(h.status, HealthStatus::Down);
    assert!(h.message.unwrap().contains("refused the key (401)"));

    let r = rig(spec(json!({})), RTH);
    r.http.route("/levels/QQQ", 403, &json!({}));
    match r.src.levels(&qqq, None).await {
        Err(IntelError::Unavailable(why)) => assert!(why.contains("not entitled"), "{why}"),
        other => panic!("{other:?}"),
    }
    r.clock.advance(secs(3600));
    r.src.levels(&qqq, None).await.unwrap_err();
    assert_eq!(r.http.calls().len(), 1);
}

#[tokio::test]
async fn a_request_the_vendor_refused_is_asked_again_after_a_long_wait() {
    let r = rig(spec(json!({})), RTH);
    let qqq = InstrumentId::new("QQQ").unwrap();
    r.http.route("/levels/QQQ", 403, &json!({}));
    r.src.levels(&qqq, None).await.unwrap_err();
    r.clock.advance(secs(3600));
    r.src.levels(&qqq, None).await.unwrap_err();
    assert_eq!(
        r.http.calls_to("/levels/QQQ"),
        1,
        "not asked again within hours"
    );
    r.clock.advance(secs(6 * 3600));
    r.http.route(
        "/levels/QQQ",
        200,
        &json!({"ts": 1_791_486_000, "data": {"cw": 492.5, "pw": 480}}),
    );
    let back = r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(back.levels[0].price, Some(Price(d("492.5"))));
    assert_eq!(r.http.calls_to("/levels/QQQ"), 2);
    assert_eq!(r.src.health().status, HealthStatus::Ok);
}

#[tokio::test]
async fn a_daily_cap_holds_until_the_reset() {
    let r = rig(
        spec(json!({
            "schedule": {"everySeconds": 5},
            "limits": {"dailyQuota": 2, "resetAt": "00:00", "timeZone": "America/New_York"}
        })),
        "2026-10-08T23:59:00-04:00",
    );
    r.http.route(
        "/levels/QQQ",
        200,
        &json!({"ts": 1, "data": {"cw": 1, "pw": 2}}),
    );
    let qqq = InstrumentId::new("QQQ").unwrap();
    for _ in 0..3 {
        r.src.levels(&qqq, None).await.unwrap();
        r.clock.advance(secs(5));
    }
    assert_eq!(r.http.calls().len(), 2);
    assert_eq!(
        r.src.calls_today(),
        vec![PoolCalls {
            pool: "default".into(),
            used: 2,
            cap: Some(2)
        }]
    );
    r.clock.set(ts("2026-10-09T00:00:30-04:00"));
    r.src.levels(&qqq, None).await.unwrap();
    assert_eq!(r.http.calls().len(), 3);
    assert_eq!(r.src.calls_today()[0].used, 1);
}

#[tokio::test]
async fn a_query_secret_and_conversion_terms_from_a_request() {
    let r = rig(
        spec(json!({
            "auth": {"in": "query", "name": "apikey"},
            "instruments": [{"root": "NQ", "ticker": "NDX", "convert": {"model": "request",
                "path": "/conversion", "query": {"from": "{ticker}", "to": "{root}"},
                "multiplier": "m", "additive": "a", "contract": "c", "method": "affine",
                "everySeconds": 600}}]
        })),
        RTH,
    );
    r.http.route(
        "/levels/NDX",
        200,
        &json!({"ts": 1_791_486_000, "data": {"cw": 20850, "pw": 20700}}),
    );
    let nq = InstrumentId::new("NQZ6.CME").unwrap();
    let s = r.src.levels(&nq, None).await.unwrap();
    assert_eq!(s.levels[0].price, None);
    assert_eq!(s.levels[0].native_price, Some(Price(d("20850"))));
    assert!(
        s.levels[0]
            .unavailable_reason
            .as_ref()
            .unwrap()
            .contains("no NDX → NQZ6 conversion yet")
    );
    r.http.route(
        "/conversion",
        200,
        &json!({"m": 1.0001, "a": 38.1, "c": "NQZ6"}),
    );
    r.clock.advance(secs(600));
    let s = r.src.levels(&nq, None).await.unwrap();
    assert_eq!(s.levels[0].price, Some(Price(d("20890.25"))));
    let rec = r.src.conversion("NDX", &nq).await.unwrap();
    assert_eq!(rec.contract.as_deref(), Some("NQZ6"));
    assert_eq!(rec.method, "affine");
    assert_eq!(rec.from_price, None);
    let calls = r.http.calls();
    let conv = calls
        .iter()
        .find(|c| c.url.ends_with("/conversion"))
        .unwrap();
    assert!(conv.query.contains(&("from".into(), "NDX".into())));
    assert!(conv.query.contains(&("to".into(), "NQ".into())));
    assert!(conv.query.contains(&("apikey".into(), "k-123".into())));
    assert!(conv.headers.iter().all(|(k, _)| k != "Authorization"));
    assert!(r.raw.0.lock().iter().all(|(_, s)| !s.contains("k-123")));
    assert!(
        r.src
            .info()
            .calls_today
            .iter()
            .all(|p| !p.pool.contains("k-123"))
    );
}

#[tokio::test]
async fn a_dry_run_reads_samples_without_the_network() {
    let s = spec(json!({}));
    let clock: SharedClock = Arc::new(ManualClock::new(ts(RTH)));
    let samples = BTreeMap::from([(
        "main".to_owned(),
        json!({"ts": 1_791_486_000, "data": {"cw": 20850}}),
    )]);
    let out = test_spec(&s, None, None, Arc::clone(&clock), &samples, Some("NQ")).await;
    assert!(out.ok, "{out:?}");
    assert_eq!(out.requests[0].url, "sample");
    assert_eq!(out.requests[0].levels[0].price, Some(Price(d("20850"))));
    assert_eq!(out.requests[0].levels[0].source.basis, "NDX");
    assert!(out.problems.iter().any(|p| p.contains("put_wall")));
    assert_eq!(out.conversion.as_ref().unwrap().additive, d("40.5"));

    let out = test_spec(
        &s,
        Some("k"),
        None,
        Arc::clone(&clock),
        &BTreeMap::new(),
        None,
    )
    .await;
    assert!(!out.ok);
    assert!(
        out.requests[0]
            .message
            .as_ref()
            .unwrap()
            .contains("paste a sample")
    );

    let mut bad = s.clone();
    bad.base_url = "ftp://x".into();
    let out = test_spec(&bad, None, None, clock, &samples, None).await;
    assert!(!out.ok && out.requests.is_empty() && !out.problems.is_empty());

    let http = FakeHttp::new();
    http.route(
        "/levels/QQQ",
        200,
        &json!({"ts": 1, "data": {"cw": 1, "pw": 2}}),
    );
    let out = test_spec(
        &s,
        Some("k"),
        Some(Arc::clone(&http) as Arc<dyn HttpClient>),
        Arc::new(ManualClock::new(ts(RTH))),
        &BTreeMap::new(),
        Some("QQQ"),
    )
    .await;
    assert!(out.ok, "{out:?}");
    assert_eq!(out.requests[0].url, "/levels/QQQ");
    assert_eq!(out.requests[0].status, Some(200));
}

#[test]
fn roots_from_dated_symbols() {
    let g = |s: &str| guess_root(&InstrumentId::new(s).unwrap());
    assert_eq!(g("NQZ6.CME").as_deref(), Some("NQ"));
    assert_eq!(g("MNQH27.CME-RITHMIC").as_deref(), Some("MNQ"));
    assert_eq!(g("QQQ"), None);
    assert_eq!(g("BTC-USD.COINBASE"), None);
}
