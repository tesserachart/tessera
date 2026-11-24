use serde_json::{Map, Value};
use tessera_protocol::layout::{ChartState, Layout};

use super::DOCK_VIEW_KEY;

pub const VIEW_STATE_KEYS: [&str; 12] = [
    "size",
    "height",
    "width",
    "position",
    "headerPosition",
    "collapsed",
    "bounds",
    "monitor",
    "activeGroup",
    "activeView",
    "ticket",
    "title",
];

pub const DESK_STATE_KEYS: [&str; 4] = ["v", "maximised", "open", "ops"];

fn without(v: &Value, keys: &[&str]) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| !keys.contains(&k.as_str()))
                .map(|(k, x)| (k.clone(), without(x, keys)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|x| without(x, keys)).collect()),
        other => other.clone(),
    }
}

fn dock_content(dock: &Value) -> Value {
    let Value::Object(root) = without(dock, &VIEW_STATE_KEYS) else {
        return Value::Null;
    };
    let mut root: Map<String, Value> = root;
    if let Some(view) = root.remove(DOCK_VIEW_KEY) {
        let view = match view {
            Value::Object(v) => Value::Object(
                v.into_iter()
                    .filter(|(k, _)| !DESK_STATE_KEYS.contains(&k.as_str()))
                    .collect(),
            ),
            other => other,
        };
        root.insert(DOCK_VIEW_KEY.into(), view);
    }
    Value::Object(root)
}

fn chart_content(c: &ChartState) -> ChartState {
    ChartState {
        viewport: None,
        ..c.clone()
    }
}

pub fn same_document(saved: &Layout, shown: &Layout) -> bool {
    let charts = saved.charts.len() == shown.charts.len()
        && saved
            .charts
            .iter()
            .zip(&shown.charts)
            .all(|((ka, a), (kb, b))| ka == kb && chart_content(a) == chart_content(b));
    charts && (saved.dock.is_null() || dock_content(&saved.dock) == dock_content(&shown.dock))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;
    use tessera_core::{InstrumentId, Timeframe, Timestamp};
    use tessera_protocol::layout::Viewport;

    use super::*;

    fn layout(dock: Value) -> Layout {
        let chart = super::super::chart(
            "chart-1",
            "Chart 1",
            InstrumentId::new("NQ").unwrap(),
            Timeframe::M5,
            Vec::new(),
        );
        Layout {
            id: "default".into(),
            name: "Day".into(),
            revision: 1,
            updated_at: Timestamp(0),
            active_chart_id: Some("chart-1".into()),
            dock,
            charts: BTreeMap::from([("chart-1".to_owned(), chart)]),
            trade: Value::Null,
            unsaved: false,
        }
    }

    fn dock(size: u32, panels: Value) -> Value {
        json!({
            "grid": {"root": {"type": "branch", "size": size, "data": [{"type": "leaf", "size": size, "data": {"views": ["chart-1"], "activeView": "chart-1", "id": "1"}}]}, "width": size, "height": 900, "orientation": "HORIZONTAL"},
            "panels": panels,
            "activeGroup": "1",
            "edgeGroups": {"right": {"collapsed": true, "size": 320}},
            "tessera": {"v": 5, "collapsed": {"right": true}, "maximised": null, "open": [], "preset": null},
        })
    }

    fn chart_panel(ticket: bool) -> Value {
        json!({"chart-1": {"id": "chart-1", "contentComponent": "chart", "params": {"layoutId": "default", "tileId": "chart-1", "ticket": {"open": ticket}}}})
    }

    #[test]
    fn sizes_collapse_focus_tickets_and_scroll_are_not_changes() {
        let saved = layout(dock(1200, chart_panel(false)));
        let mut shown = layout(dock(800, chart_panel(true)));
        shown.dock["panels"]["chart-1"]["title"] = json!("NQ Z6 5m");
        shown.dock["activeGroup"] = json!("2");
        shown.dock["edgeGroups"]["right"]["collapsed"] = json!(false);
        shown.dock["tessera"]["collapsed"] = json!({"right": false});
        shown.dock["tessera"]["maximised"] = json!({"panelId": "chart-1", "returnTo": null});
        shown.dock["tessera"]["ops"] = json!([{"id": "op-2"}]);
        shown.active_chart_id = None;
        shown.charts.get_mut("chart-1").unwrap().viewport = Some(Viewport {
            from: Timestamp(1),
            to: Timestamp(2),
            price_min: None,
            price_max: None,
            bars: None,
            reported_at: Timestamp(3),
            follows: false,
            short: None,
            answers: None,
            profiles: Vec::new(),
        });
        assert!(same_document(&saved, &shown));
    }

    #[test]
    fn what_the_desk_holds_and_shows_is_a_change() {
        let saved = layout(dock(1200, chart_panel(false)));
        let mut tiles = layout(dock(1200, chart_panel(false)));
        tiles.dock["panels"]["dom-1"] = json!({"id": "dom-1", "contentComponent": "dom"});
        assert!(!same_document(&saved, &tiles));
        let mut symbol = layout(dock(1200, chart_panel(false)));
        symbol.charts.get_mut("chart-1").unwrap().instrument = InstrumentId::new("ES").unwrap();
        assert!(!same_document(&saved, &symbol));
        let mut preset = layout(dock(1200, chart_panel(false)));
        preset.dock["tessera"]["preset"] = json!("2h");
        assert!(!same_document(&saved, &preset));
    }

    #[test]
    fn a_saved_copy_without_a_dock_takes_the_first_dock_the_desk_builds() {
        let saved = layout(Value::Null);
        assert!(same_document(
            &saved,
            &layout(dock(1200, chart_panel(false)))
        ));
    }
}
