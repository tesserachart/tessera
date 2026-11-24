mod support;

use std::sync::Arc;

use serde_json::json;
use tessera_core::clock::ManualClock;
use tessera_core::{InstrumentId, Origin, Timeframe, Timestamp};
use tessera_host::{EventBus, KeyFilter, TopicKey, TopicSizing};
use tessera_indicators::io::{IndicatorSeries, Replaces, SeriesUpdate};
use tessera_indicators::{CATALOG_TOPIC, IndicatorsModule, IndicatorsService, SERIES_TOPIC};
use tessera_market::{MarketRouter, MockConfig, MockMarket};
use tessera_protocol::indicators::{
    LabelAlong, LabelPlacement, LabelSide, LabelSize, LineDash, MAX_OBJECTS, ObjectExtend,
};
use tessera_protocol::topics::names;
use tessera_store::Store;

const SESSION_LEVELS: &str = include_str!("../js/session_levels.js");
const EMA_CROSS: &str = include_str!("../js/ema_cross.js");

fn now() -> Timestamp {
    "2026-10-02T14:42:30-04:00".parse().unwrap()
}

fn world() -> (Arc<IndicatorsService>, Arc<EventBus>) {
    let clock = Arc::new(ManualClock::new(now()));
    let mut cfg = MockConfig::new(Arc::clone(&clock) as _);
    cfg.intraday_sessions = 12;
    cfg.daily_sessions = 10;
    let market = MarketRouter::new();
    market.add(Arc::new(MockMarket::new(cfg))).unwrap();
    let bus = Arc::new(EventBus::new());
    bus.register(names::MARKET_BARS, TopicSizing::MARKET)
        .unwrap();
    bus.register(SERIES_TOPIC, TopicSizing::LOW_RATE).unwrap();
    bus.register(CATALOG_TOPIC, TopicSizing::SNAPSHOT).unwrap();
    let svc = IndicatorsService::load(
        Store::open_in_memory().unwrap(),
        market,
        None,
        Arc::clone(&bus),
        clock,
    )
    .unwrap();
    (svc, bus)
}

async fn preview(svc: &IndicatorsService, code: &str, limit: u32) -> IndicatorSeries {
    svc.preview(support::preview(code, "NQ", Timeframe::M5, limit, None))
        .await
        .unwrap()
}

async fn refused(svc: &IndicatorsService, code: &str) -> (String, Option<u64>) {
    let e = svc
        .preview(support::preview(code, "NQ", Timeframe::M5, 50, None))
        .await
        .unwrap_err();
    let line = e.details.as_ref().and_then(|d| d["line"].as_u64());
    (e.message, line)
}

#[tokio::test]
async fn lines_labels_and_boxes_are_drawn_from_compute() {
    let (svc, _) = world();
    let code = r##"
export const indicator = { title: "Marks", placement: "overlay", plots: [] };

export function compute(bars) {
  const t = bars.time;
  const n = bars.length;
  const a = draw.line(t[2], bars.high[2], { color: "#ff8800", width: 2, label: "High", labelSide: "below" });
  const b = draw.line(t[5], 100.5, t[9], 101.25, {
    style: "dot", extend: "right", label: "Ray", labelAt: "middle", labelColor: "teal",
  });
  const gone = draw.line(t[3], 1.0);
  gone.delete();
  a.time2 = t[n - 1];
  draw.label(t[4], bars.low[4], "Low", { size: "large", side: "below" });
  draw.box(t[1], 99.0, null, 98.0, { fill: "teal", opacity: 0.2, label: "Range", width: 0 });
  console.log(a.time2 === t[n - 1], b.style, a.kind);
}
"##;
    let s = preview(&svc, code, 60).await;
    assert!(s.plots.is_empty(), "an indicator may draw without plots");
    assert_eq!(
        s.logs, "true dot line\n",
        "a handle reads back what was set"
    );
    let o = &s.objects;
    assert_eq!(
        (o.lines.len(), o.labels.len(), o.boxes.len()),
        (2, 1, 1),
        "a deleted line is gone"
    );
    let t = &s.time;
    let a = &o.lines[0];
    assert_eq!(
        (a.time1, a.time2),
        (t[2], Some(t[59])),
        "changed after it was made"
    );
    assert_eq!(a.price1, a.price2, "a level when price2 is not given");
    assert_eq!(a.color.as_deref(), Some("#ff8800"));
    assert_eq!(
        (a.width, a.line, a.extend),
        (2.0, LineDash::Solid, ObjectExtend::None)
    );
    let la = a.label.as_ref().unwrap();
    assert_eq!(
        (la.text.as_str(), la.at, la.side, la.color.as_deref()),
        ("High", LabelAlong::End, LabelSide::Below, None),
        "a label takes its line's colour unless given one"
    );
    let b = &o.lines[1];
    assert_eq!((b.price1, b.price2, b.time2), (100.5, 101.25, Some(t[9])));
    assert_eq!((b.line, b.extend), (LineDash::Dot, ObjectExtend::Right));
    assert_eq!(b.color, None, "the indicator's colour when none is given");
    let lb = b.label.as_ref().unwrap();
    assert_eq!(
        (lb.at, lb.color.as_deref()),
        (LabelAlong::Middle, Some("teal"))
    );
    let l = &o.labels[0];
    assert_eq!(
        (l.time, l.text.as_str(), l.size, l.side),
        (t[4], "Low", LabelSize::Large, LabelPlacement::Below)
    );
    let x = &o.boxes[0];
    assert_eq!(
        (x.time1, x.time2, x.price1, x.price2),
        (t[1], None, 99.0, 98.0)
    );
    assert_eq!(
        (x.width, x.fill.as_deref(), x.opacity),
        (0.0, Some("teal"), 0.2)
    );
    assert_eq!(x.label.as_ref().unwrap().at, LabelAlong::Start);

    let tail = svc
        .preview(support::preview(code, "NQ", Timeframe::M5, 60, Some(5)))
        .await
        .unwrap();
    assert_eq!(tail.time.len(), 5);
    assert_eq!(
        tail.objects.lines.len(),
        2,
        "one runs to the end, one extends right"
    );
    assert!(
        tail.objects.labels.is_empty(),
        "the label is before the tail"
    );
    assert_eq!(tail.objects.boxes.len(), 1, "the box runs until now");
}

#[tokio::test]
async fn each_kind_keeps_its_newest_500() {
    let (svc, _) = world();
    let code = r#"
export const indicator = { plots: [] };

export function compute(bars) {
  for (let k = 0; k < 700; k++) draw.label(bars.time[k % bars.length], 1.0, String(k));
  draw.line(bars.time[0], 1.0);
}
"#;
    let s = preview(&svc, code, 50).await;
    assert_eq!(s.objects.labels.len(), MAX_OBJECTS);
    assert_eq!(s.objects.labels[0].text, "200", "the oldest are dropped");
    assert_eq!(s.objects.labels[MAX_OBJECTS - 1].text, "699");
    assert_eq!(s.objects.lines.len(), 1, "each kind has its own cap");
}

#[tokio::test]
async fn bad_objects_are_refused_at_their_line() {
    let (svc, _) = world();
    let head = "export const indicator = { plots: [] };\n\nexport function compute(bars) {\n";
    let cases: [(&str, &str); 10] = [
        (
            "  draw.line(bars.time[0], 1.0, { color: 'blue' });\n",
            "line.color: 'blue' is not a colour (use #rrggbb or one of mist, t1, t2, t3, t4, up, down, brass, teal)",
        ),
        (
            "  draw.line(3, 1.0);\n",
            "line.time1 is 3: a time is UTC seconds, as in bars.time (bars.time[i] for bar i)",
        ),
        (
            "  draw.line(bars.time[0], NaN);\n",
            "line.price1 must be a number, not NaN",
        ),
        (
            "  draw.line(bars.time[0], 1.0, { extend: 'up' });\n",
            "line.extend is 'none', 'left', 'right' or 'both', not 'up'",
        ),
        (
            "  draw.label(bars.time[0], 1.0, 42);\n",
            "label.text is a string, not 42",
        ),
        (
            "  draw.label(bars.time[0], 1.0, 'x', { side: 'over' });\n",
            "label.side is 'above', 'below' or 'at', not 'over'",
        ),
        (
            "  draw.box(bars.time[0], 1.0, null, 2.0, { labelSide: 'left' });\n",
            "box.labelSide is 'above' or 'below', not 'left'",
        ),
        (
            "  const l = draw.line(bars.time[0], 1.0);\n  l.colour = 'teal';\n",
            "a line has no 'colour'; it has time1, price1, time2, price2, color, style, extend, label, labelAt, labelSide, labelColor, width",
        ),
        (
            "  const l = draw.line(bars.time[0], 1.0);\n  l.time2 = 'later';\n",
            "line.time2 is a bar time (bars.time[i], UTC seconds), not 'later'",
        ),
        (
            "  draw.line(bars.time[0], 1.0, { colour: 'teal' });\n",
            "draw.line: no option 'colour'; the options are time2, price2, color, width, style, extend, label, labelAt, labelSide, labelColor",
        ),
    ];
    for (body, want) in cases {
        let code = format!("{head}{body}}}\n");
        let (message, line) = refused(&svc, &code).await;
        assert!(message.ends_with(want), "{code}\n→ {message}");
        let at = line.unwrap_or_else(|| panic!("{message} names its line"));
        assert_eq!(
            code.lines().nth(at as usize - 1).unwrap(),
            body.lines().last().unwrap(),
            "{message}"
        );
    }
    let (message, line) = refused(
        &svc,
        "export const indicator = { plots: [] };\ndraw.line(1.7e9, 1.0);\nexport function compute(bars) {}\n",
    )
    .await;
    assert!(
        message.contains("draw.line() draws from inside compute"),
        "{message}"
    );
    assert_eq!(line, Some(2));
    let (message, _) = refused(
        &svc,
        "export const indicator = { plots: ['v'] };\nexport function compute(bars) {\n  draw.line(bars.time[0], 1.0);\n}\n",
    )
    .await;
    assert!(
        message.contains("compute() returned undefined; return an object with v"),
        "{message}"
    );
}

#[tokio::test]
async fn plots_only_indicators_are_unchanged() {
    let (svc, _) = world();
    let s = preview(&svc, EMA_CROSS, 200).await;
    assert!(s.objects.is_empty());
    assert_eq!(s.plots.len(), 2);
    let c = svc
        .create(EMA_CROSS, None, &Origin::User, now())
        .await
        .unwrap()
        .custom
        .unwrap();
    let module = IndicatorsModule::new(Arc::clone(&svc));
    let topics = module.topic_handlers();
    let series = topics.iter().find(|t| t.name() == SERIES_TOPIC).unwrap();
    let sub = series
        .subscribe(json!({"indicator": c.id, "instrument": "QQQ", "tf": "5m"}))
        .await
        .unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    assert!(snap.replaces == Replaces::All && snap.objects.is_none());
    let wire: serde_json::Value = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    assert_eq!(wire["objects"], serde_json::Value::Null);
}

#[tokio::test]
async fn the_session_levels_example_draws_labelled_levels_until_swept() {
    let (svc, _) = world();
    let s = preview(&svc, SESSION_LEVELS, 2000).await;
    assert!(s.plots.is_empty());
    let lines = &s.objects.lines;
    assert!(lines.len() >= 8, "{} levels", lines.len());
    let ohlc = svc
        .preview(support::preview(
            "export const indicator = { plots: ['h', 'l'] };\nexport function compute(bars) {\n  return { h: bars.high, l: bars.low };\n}\n",
            "NQ",
            Timeframe::M5,
            2000,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(ohlc.time, s.time);
    let high: Vec<f64> = ohlc.plots[0].values.iter().map(|v| v.unwrap()).collect();
    let low: Vec<f64> = ohlc.plots[1].values.iter().map(|v| v.unwrap()).collect();
    let at = |t: Timestamp| s.time.iter().position(|x| *x == t).unwrap();
    let colours = [
        ("Asia", "t3"),
        ("London", "t2"),
        ("NY AM", "mist"),
        ("PD", "t1"),
        ("PW", "t2"),
    ];
    let (mut swept, mut open) = (0, 0);
    for l in lines {
        let label = l.label.as_ref().expect("each level is named");
        assert_eq!(
            (label.at, label.side, &label.color),
            (LabelAlong::End, LabelSide::Above, &None)
        );
        let colour = colours
            .iter()
            .find(|(name, _)| label.text.starts_with(name))
            .unwrap_or_else(|| panic!("{} is a session's level", label.text))
            .1;
        assert_eq!(l.color.as_deref(), Some(colour), "{}", label.text);
        assert_eq!(l.price1, l.price2, "levels are flat");
        let is_high = label.text.ends_with('H');
        let from = at(l.time1);
        let traded = |i: usize| {
            if is_high {
                high[i] > l.price1
            } else {
                low[i] < l.price1
            }
        };
        assert!(
            (if is_high { high[from] } else { low[from] }) == l.price1,
            "{} starts at the bar that made it",
            label.text
        );
        match l.time2 {
            None => {
                open += 1;
                assert!(
                    (from..s.time.len()).all(|i| !traded(i)),
                    "{} is not swept",
                    label.text
                );
                assert_eq!(l.line, LineDash::Solid);
            }
            Some(t2) => {
                swept += 1;
                let to = at(t2);
                assert!(traded(to), "{} ends where it was swept", label.text);
                assert!(
                    (from..to).all(|i| !traded(i)),
                    "{} ends at the first sweep",
                    label.text
                );
                assert_eq!(l.line, LineDash::Dash);
            }
        }
    }
    assert!(swept > 0 && open > 0, "{swept} swept, {open} open");

    let named = |lines: &[tessera_protocol::indicators::IndicatorLineObject], name: &str| {
        lines
            .iter()
            .filter(|l| l.label.as_ref().unwrap().text.starts_with(name))
            .count()
    };
    for name in ["Asia", "London", "NY AM", "PD"] {
        assert!(named(lines, name) > 0, "{name} levels");
    }
    assert!(s.compute_ms < 1000.0, "{} ms", s.compute_ms);
    let weeks = svc
        .preview(support::preview(
            SESSION_LEVELS,
            "NQ",
            Timeframe::M15,
            2000,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(named(&weeks.objects.lines, "PWH"), 1, "one whole week");
    assert_eq!(named(&weeks.objects.lines, "PWL"), 1);

    let guide = include_str!("../../../docs/indicators.md");
    assert!(
        guide.contains(SESSION_LEVELS.trim_end()),
        "docs/indicators.md shows a different session-levels example"
    );
}

#[tokio::test]
async fn series_carry_objects_only_when_they_change() {
    let (svc, bus) = world();
    let c = svc
        .create(SESSION_LEVELS, None, &Origin::User, now())
        .await
        .unwrap()
        .custom
        .unwrap();
    let module = IndicatorsModule::new(Arc::clone(&svc));
    let topics = module.topic_handlers();
    let series = topics.iter().find(|t| t.name() == SERIES_TOPIC).unwrap();
    let (mut rx, _) = bus.subscribe(SERIES_TOPIC).unwrap();
    let sub = series
        .subscribe(json!({"indicator": c.id, "instrument": "NQ", "tf": "5m"}))
        .await
        .unwrap();
    let snap: SeriesUpdate = serde_json::from_str(sub.snapshot[0].get()).unwrap();
    assert_eq!(snap.replaces, Replaces::All);
    let drawn = snap
        .objects
        .clone()
        .expect("a snapshot carries the objects");
    assert!(!drawn.lines.is_empty());
    let KeyFilter::Id(key) = sub.filter.clone() else {
        panic!("an id filter")
    };

    let last = Timestamp(*support::times_ms(&snap).last().unwrap() * 1_000_000);
    let id: InstrumentId = snap.instrument.clone();
    let bar = json!({
        "instrument": id, "tf": "5m",
        "bar": [last.0 + 300_000_000_000, 1e6, 1e6, 1e6, 1e6, 10.0, 5.0],
        "closed": true, "source": {"provider": "mock-market"}
    });
    bus.publish(
        names::MARKET_BARS,
        TopicKey::Bars(id.clone(), Timeframe::M5),
        &bar,
    );
    let u = next(&mut rx, &key).await;
    assert_ne!(u.replaces, Replaces::All);
    let after = u.objects.expect("the sweep changed the levels");
    let open = |o: &tessera_protocol::indicators::IndicatorObjects| {
        o.lines
            .iter()
            .filter(|l| l.time2.is_none() && l.label.as_ref().unwrap().text.ends_with('H'))
            .count()
    };
    assert!(open(&drawn) > 0);
    assert_eq!(open(&after), 0, "every open high is swept by the new bar");

    bus.publish(
        names::MARKET_BARS,
        TopicKey::Bars(id.clone(), Timeframe::M5),
        &bar,
    );
    let after_it = last.0 + 600_000_000_000;
    let sentinel = json!({
        "instrument": id, "tf": "5m",
        "bar": [after_it, 1e6, 1e6, 1e6, 1e6, 10.0, 5.0],
        "closed": true, "source": {"provider": "mock-market"}
    });
    bus.publish(
        names::MARKET_BARS,
        TopicKey::Bars(id, Timeframe::M5),
        &sentinel,
    );
    let later = next(&mut rx, &key).await;
    assert!(
        support::times_ms(&later).contains(&(after_it / 1_000_000)),
        "the bar after it is sent"
    );
    assert_eq!(later.rev, u.rev + 1, "nothing changed, nothing is sent");
    drop(sub);
}

use support::next;
