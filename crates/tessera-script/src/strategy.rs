use rquickjs::{Function, Object, TypedArray, Value as JsValue};
use serde_json::{Map, Value};
use tessera_protocol::indicators::IndicatorInput;

use crate::engine::{self, Host, Limits, ScriptError};
use crate::indicator::{BarArrays, check_code, columns, host};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StudyColumns {
    pub session: Vec<f64>,
    pub levels: Vec<(String, Vec<f64>, Vec<f64>)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Decisions {
    pub position: Vec<f64>,
    pub stop_distance: Vec<f64>,
    pub target_distance: Vec<f64>,
    pub logs: String,
}

pub fn describe_strategy(source: &str) -> Result<Vec<IndicatorInput>, ScriptError> {
    check_code(source)?;
    let (json, _) = engine::run(source, Limits::DESCRIBE, Host::default(), |_, loaded| {
        let describe: Function<'_> = loaded.runner.get("describeStrategy")?;
        let decl: JsValue<'_> = loaded.module.get("strategy")?;
        let positions: JsValue<'_> = loaded.module.get("positions")?;
        describe.call::<_, String>((decl, positions))
    })?;
    serde_json::from_str(&json)
        .map_err(|e| ScriptError::internal(format!("the strategy's inputs are unreadable: {e}")))
}

pub fn run_strategy(
    source: &str,
    bars: &BarArrays,
    study: &StudyColumns,
    given: &Map<String, Value>,
    limits: Limits,
) -> Result<Decisions, ScriptError> {
    check_code(source)?;
    bars.check()?;
    let n = bars.len();
    if study.session.len() != n
        || study
            .levels
            .iter()
            .any(|l| l.1.len() != n || l.2.len() != n)
    {
        return Err(ScriptError::invalid(
            "every bar needs its session and its levels",
        ));
    }
    let given = serde_json::to_string(given).map_err(|e| ScriptError::internal(e.to_string()))?;
    let (keyed, logs) = engine::run(source, limits, host(bars), |ctx, loaded| {
        let strategy: Function<'_> = loaded.runner.get("strategy")?;
        let decl: JsValue<'_> = loaded.module.get("strategy")?;
        let positions: JsValue<'_> = loaded.module.get("positions")?;
        let cols = columns(ctx, bars)?;
        cols.set(
            "session",
            TypedArray::<f64>::new(ctx.clone(), study.session.clone())?,
        )?;
        let levels = Object::new(ctx.clone())?;
        let as_of = Object::new(ctx.clone())?;
        for (name, values, at) in &study.levels {
            levels.set(
                name.as_str(),
                TypedArray::<f64>::new(ctx.clone(), values.clone())?,
            )?;
            as_of.set(
                name.as_str(),
                TypedArray::<f64>::new(ctx.clone(), at.clone())?,
            )?;
        }
        cols.set("levels", levels)?;
        cols.set("levelsAsOf", as_of)?;
        let given = ctx.json_parse(given.clone())?;
        let out: Object<'_> = strategy.call((decl, positions, cols, given))?;
        let keys: Vec<String> = out.get("keys")?;
        let values: Vec<Vec<f64>> = out.get("values")?;
        Ok(keys.into_iter().zip(values).collect::<Vec<_>>())
    })?;
    let mut d = Decisions {
        logs,
        ..Decisions::default()
    };
    for (k, v) in keyed {
        match k.as_str() {
            "position" => d.position = v,
            "stopDistance" => d.stop_distance = v,
            "targetDistance" => d.target_distance = v,
            _ => {}
        }
    }
    Ok(d)
}

pub fn read_records(
    source: &str,
    text: &str,
    name: &str,
    limits: Limits,
) -> Result<(Value, String), ScriptError> {
    check_code(source)?;
    let (json, logs) = engine::run(source, limits, Host::default(), |_, loaded| {
        let records: Function<'_> = loaded.runner.get("records")?;
        let entry: JsValue<'_> = loaded.module.get("records")?;
        records.call::<_, String>((entry, text, name))
    })?;
    let value = serde_json::from_str(&json).map_err(|e| {
        ScriptError::internal(format!("records() returned something unreadable: {e}"))
    })?;
    Ok((value, logs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::session::SessionCalendar;

    fn bars(close: &[f64]) -> BarArrays {
        let n = close.len();
        BarArrays {
            time: (0..n).map(|i| 1_790_000_000.0 + i as f64 * 300.0).collect(),
            open: close.to_vec(),
            high: close.iter().map(|c| c + 1.0).collect(),
            low: close.iter().map(|c| c - 1.0).collect(),
            close: close.to_vec(),
            volume: vec![10.0; n],
            buy_volume: None,
            calendar: SessionCalendar::ALL[0],
        }
    }

    fn study(n: usize) -> StudyColumns {
        StudyColumns {
            session: vec![0.0; n],
            levels: vec![("wall".into(), vec![101.5; n], vec![1_789_999_000.0; n])],
        }
    }

    #[test]
    fn a_strategy_decides_positions_and_brackets_from_its_inputs_and_levels() {
        let code = "export const strategy = { inputs: { above: 0.5, mult: 2 } };\n\
            export function positions(bars, inputs) {\n\
              const position = new Float64Array(bars.length).fill(NaN);\n\
              const targetDistance = new Float64Array(bars.length).fill(NaN);\n\
              for (let i = 0; i < bars.length; i++) {\n\
                if (bars.close[i] > bars.levels.wall[i] + inputs.above) { position[i] = 1; targetDistance[i] = inputs.mult; }\n\
              }\n\
              return { position, targetDistance };\n\
            }\n";
        let inputs = describe_strategy(code).unwrap();
        assert_eq!(inputs.len(), 2);
        let mut given = Map::new();
        given.insert("mult".into(), Value::from(3));
        let d = run_strategy(
            code,
            &bars(&[100.0, 103.0, 101.0]),
            &study(3),
            &given,
            Limits::STUDY,
        )
        .unwrap();
        assert!(d.position[0].is_nan());
        assert_eq!(d.position[1], 1.0);
        assert_eq!(d.target_distance[1], 3.0);
        assert!(d.stop_distance.is_empty());
    }

    #[test]
    fn a_plain_array_is_the_position_and_mistakes_are_said_in_words() {
        let ok =
            "export function positions(bars) { return bars.close.map((c) => (c > 101 ? 1 : 0)); }";
        let d = run_strategy(
            ok,
            &bars(&[100.0, 102.0]),
            &study(2),
            &Map::new(),
            Limits::STUDY,
        )
        .unwrap();
        assert_eq!(d.position, vec![0.0, 1.0]);
        let none = "export const strategy = {};";
        assert!(
            describe_strategy(none)
                .unwrap_err()
                .to_string()
                .contains("positions(bars, inputs)")
        );
        let short = "export function positions(bars) { return [1]; }";
        let e = run_strategy(
            short,
            &bars(&[1.0, 2.0]),
            &study(2),
            &Map::new(),
            Limits::STUDY,
        )
        .unwrap_err();
        assert!(e.to_string().contains("there are 2 bars"), "{e}");
        let extra = "export function positions(bars) { return { position: [1], size: [1] }; }";
        let e =
            run_strategy(extra, &bars(&[1.0]), &study(1), &Map::new(), Limits::STUDY).unwrap_err();
        assert!(e.to_string().contains("unknown fields: size"), "{e}");
    }

    #[test]
    fn an_adapter_reads_a_files_text_into_columns() {
        let code = "export function records(text, file) {\n\
              const rows = JSON.parse(text).rows;\n\
              console.log(file.name);\n\
              return { time: rows.map((r) => r.t), instrument: 'NDX', level: rows.map((r) => r.k), value: new Float64Array([1.5, NaN]) };\n\
            }\n";
        let (v, logs) = read_records(
            code,
            r#"{"rows": [{"t": 1, "k": "a"}, {"t": 2, "k": "b"}]}"#,
            "zeta.json",
            Limits::IMPORT,
        )
        .unwrap();
        assert_eq!(v["instrument"], "NDX");
        assert_eq!(v["value"], serde_json::json!([1.5, null]));
        assert_eq!(logs.trim(), "zeta.json");
    }
}
