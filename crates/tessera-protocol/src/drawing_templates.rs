use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::drawings::{
    self, DrawingKind, DrawingLabel, DrawingLabelInput, DrawingStyle, DrawingStyleInput,
};
use crate::templates::{NAME_MAX, clean_name, new_id, same_name};

pub const KEY: &str = "chart.drawingTemplates";
pub const TOOLS_KEY: &str = "chart.drawingTools";
pub const DRAWING_TEMPLATES_MAX: usize = 200;

/// A named look for drawings of one kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawingTemplate {
    /// Stable id (`session-level`, `session-level-2`); a rename keeps it.
    pub id: String,
    /// The user's name for it (`Session level`), unique among its kind's ignoring case.
    pub name: String,
    /// The kind of drawing it styles.
    pub kind: DrawingKind,
    /// Colour, width, dash and extension.
    pub style: DrawingStyle,
    /// The label's look (never its words); absent: the kind's default label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<DrawingLabel>,
    /// A Fibonacci drawing's levels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub levels: Option<Vec<f64>>,
}

/// The `chart.drawingTemplates` setting, and what the template tools return: every template in
/// the order it was first saved.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawingTemplates {
    /// The templates, every kind's.
    #[serde(default)]
    pub templates: Vec<DrawingTemplate>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DrawingLook {
    pub style: DrawingStyle,
    pub label: Option<DrawingLabel>,
    pub levels: Option<Vec<f64>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartListDrawingTemplatesInput {
    /// Only this kind's (default: every kind's).
    #[serde(default)]
    pub kind: Option<DrawingKind>,
}

/// `chart.save_drawing_template` input: the look of a drawing on a chart (`drawingId`), or one
/// given here (`kind` with `style`, `label`, `levels` over the built-in look), under a name. A
/// template of that kind and name is replaced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSaveDrawingTemplateInput {
    /// Template name (1–48 characters). Its kind's template with this name (any case) is replaced.
    pub name: String,
    /// Save this drawing's look (from chart.get_state).
    #[serde(default)]
    pub drawing_id: Option<String>,
    /// The drawing's chart tile (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// Without a drawing: the kind it styles.
    #[serde(default)]
    pub kind: Option<DrawingKind>,
    /// Without a drawing: the style, over the kind's built-in one.
    #[serde(default)]
    pub style: Option<DrawingStyleInput>,
    /// Without a drawing: the label's look, over the kind's default (no text).
    #[serde(default)]
    pub label: Option<DrawingLabelInput>,
    /// Without a drawing: a Fibonacci drawing's levels.
    #[serde(default)]
    pub levels: Option<Vec<f64>>,
    /// Also make it what new drawings of its kind take.
    #[serde(default)]
    pub new_drawings: Option<bool>,
}

/// `chart.save_drawing_template` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawingTemplateSavedOutput {
    /// The saved template.
    pub template: DrawingTemplate,
    /// A template of that kind and name was replaced.
    pub replaced: bool,
    /// New drawings of its kind now take it.
    pub new_drawings: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartApplyDrawingTemplateInput {
    /// Chart tile id (default: the active chart).
    #[serde(default)]
    pub tile_id: Option<String>,
    /// Layout id (default: the active layout).
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The drawing (from chart.get_state).
    pub drawing_id: String,
    /// The template's id or name (of the drawing's kind), or `built-in` for the kind's built-in
    /// look.
    pub template: String,
}

/// `chart.set_default_drawing_template` input: what new drawings of a kind take.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartSetDefaultDrawingTemplateInput {
    /// The template's id or name; absent (with `kind`): the kind's built-in look again.
    #[serde(default)]
    pub template: Option<String>,
    /// The kind (needed without a template, or to tell two kinds' templates of one name apart).
    #[serde(default)]
    pub kind: Option<DrawingKind>,
}

/// `chart.set_default_drawing_template` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawingDefaultOutput {
    /// The kind.
    pub kind: DrawingKind,
    /// The template new drawings of the kind take now; none: the built-in look.
    pub template: Option<DrawingTemplate>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartRenameDrawingTemplateInput {
    /// The template's id or name.
    pub template: String,
    /// Its kind, to tell two kinds' templates of one name apart.
    #[serde(default)]
    pub kind: Option<DrawingKind>,
    /// The new name (1–48 characters, not another of its kind's).
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChartDeleteDrawingTemplateInput {
    /// The template's id or name.
    pub template: String,
    /// Its kind, to tell two kinds' templates of one name apart.
    #[serde(default)]
    pub kind: Option<DrawingKind>,
}

pub const BUILT_IN: &str = "built-in";

pub fn built_in(kind: DrawingKind) -> DrawingLook {
    DrawingLook {
        style: DrawingStyle::default_for(kind),
        label: kind.labels().then(|| DrawingLabel::default_for(kind)),
        levels: kind.default_levels().map(<[f64]>::to_vec),
    }
}

pub fn look_of(d: &drawings::Drawing) -> DrawingLook {
    DrawingLook {
        style: d.style.clone(),
        label: d.kind.labels().then(|| {
            d.label
                .as_ref()
                .map_or_else(|| DrawingLabel::default_for(d.kind), DrawingLabel::look)
        }),
        levels: d
            .kind
            .default_levels()
            .map(|base| d.levels.clone().unwrap_or_else(|| base.to_vec())),
    }
}

pub fn template_look(t: &DrawingTemplate) -> DrawingLook {
    let base = built_in(t.kind);
    DrawingLook {
        style: t.style.clone(),
        label: base
            .label
            .map(|l| t.label.as_ref().map_or(l, DrawingLabel::look)),
        levels: base.levels.map(|l| t.levels.clone().unwrap_or(l)),
    }
}

pub fn template_of(
    id: String,
    name: String,
    kind: DrawingKind,
    look: DrawingLook,
) -> DrawingTemplate {
    DrawingTemplate {
        id,
        name,
        kind,
        style: look.style,
        label: look.label.map(|l| l.look()),
        levels: look.levels,
    }
}

pub fn restyle_input(
    look: &DrawingLook,
) -> (
    DrawingStyleInput,
    Option<DrawingLabelInput>,
    Option<Vec<f64>>,
) {
    let s = &look.style;
    let style = DrawingStyleInput {
        color: Some(s.color.clone()),
        width: Some(s.width),
        line: Some(s.line),
        extend: Some(s.extend),
    };
    let label = look.label.as_ref().map(|l| DrawingLabelInput {
        text: None,
        color: Some(l.color.clone().unwrap_or_default()),
        size: Some(l.size),
        bold: Some(l.bold),
        italic: Some(l.italic),
        align: Some(l.align),
        position: Some(l.position),
        show_price: Some(l.show_price),
        show_levels: look.levels.as_ref().map(|_| l.show_levels),
    });
    (style, label, look.levels.clone())
}

pub fn new_drawing_value(look: &DrawingLook) -> Value {
    let mut v = json!({
        "color": look.style.color,
        "width": look.style.width,
        "line": look.style.line,
        "extend": look.style.extend,
    });
    if let Some(l) = &look.label {
        v["label"] = serde_json::to_value(l.look()).unwrap_or(Value::Null);
    }
    if let Some(levels) = &look.levels {
        v["levels"] = json!(levels);
    }
    v
}

pub fn new_drawing_look(kind: DrawingKind, entry: Option<&Value>) -> DrawingLook {
    let mut look = built_in(kind);
    let Some(e) = entry.and_then(Value::as_object) else {
        return look;
    };
    let field = |k: &str| e.get(k).cloned().unwrap_or(Value::Null);
    if let Ok(i) = serde_json::from_value::<DrawingStyleInput>(json!({
        "color": field("color"), "width": field("width"), "line": field("line"), "extend": field("extend"),
    })) {
        let mut style = look.style.clone();
        if drawings::apply_style(&mut style, &i).is_ok() {
            look.style = style;
        }
    }
    if let Some(label) = look.label.as_mut()
        && let Some(stored) = e
            .get("label")
            .and_then(|v| serde_json::from_value::<DrawingLabel>(v.clone()).ok())
        && let Ok(l) = drawings::check_label(kind, &stored.look())
    {
        *label = l;
    }
    if let Some(levels) = look.levels.as_mut()
        && let Some(stored) = e
            .get("levels")
            .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
        && let Ok(l) = drawings::clean_levels(&stored)
    {
        *levels = l;
    }
    look
}

pub fn look_from_input(
    kind: DrawingKind,
    style: Option<&DrawingStyleInput>,
    label: Option<&DrawingLabelInput>,
    levels: Option<&[f64]>,
) -> Result<DrawingLook, String> {
    let mut look = built_in(kind);
    if let Some(s) = style {
        drawings::apply_style(&mut look.style, s)?;
    }
    if let Some(i) = label {
        let Some(l) = look.label.as_mut() else {
            return Err(format!("{} takes no label", kind.as_str()));
        };
        drawings::apply_label(kind, l, i)?;
        l.text.clear();
    }
    if let Some(levels) = levels {
        let Some(l) = look.levels.as_mut() else {
            return Err(format!("{} takes no levels", kind.as_str()));
        };
        *l = drawings::clean_levels(levels)?;
    }
    Ok(look)
}

pub fn read(value: &Value) -> DrawingTemplates {
    let mut out = DrawingTemplates::default();
    for raw in value
        .get("templates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Ok(mut t) = serde_json::from_value::<DrawingTemplate>(raw.clone()) else {
            continue;
        };
        let Ok(name) = clean_name(&t.name) else {
            continue;
        };
        if t.id.is_empty()
            || out
                .templates
                .iter()
                .any(|x| x.id == t.id || (x.kind == t.kind && same_name(&x.name, &name)))
        {
            continue;
        }
        t.name = name;
        let mut style = DrawingStyle::default_for(t.kind);
        let given = DrawingStyleInput {
            color: Some(t.style.color.clone()),
            width: Some(t.style.width),
            line: Some(t.style.line),
            extend: Some(t.style.extend),
        };
        if drawings::apply_style(&mut style, &given).is_err() {
            continue;
        }
        t.style = style;
        t.label = if t.kind.labels() {
            t.label
                .and_then(|l| drawings::check_label(t.kind, &l.look()).ok())
        } else {
            None
        };
        t.levels = if t.kind.takes_levels() {
            t.levels.and_then(|l| drawings::clean_levels(&l).ok())
        } else {
            None
        };
        out.templates.push(t);
        if out.templates.len() == DRAWING_TEMPLATES_MAX {
            break;
        }
    }
    out
}

pub fn find<'a>(
    all: &'a DrawingTemplates,
    reference: &str,
    kind: Option<DrawingKind>,
) -> Result<&'a DrawingTemplate, String> {
    let of_kind = |t: &&DrawingTemplate| kind.is_none_or(|k| t.kind == k);
    if let Some(t) = all
        .templates
        .iter()
        .filter(of_kind)
        .find(|t| t.id == reference)
    {
        return Ok(t);
    }
    let named: Vec<&DrawingTemplate> = all
        .templates
        .iter()
        .filter(of_kind)
        .filter(|t| same_name(&t.name, reference))
        .collect();
    match named.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "no drawing template {reference}{}; chart.list_drawing_templates lists them",
            kind.map(|k| format!(" for {}", k.as_str()))
                .unwrap_or_default()
        )),
        many => Err(format!(
            "{} templates are named {reference} ({}): give its kind or its id",
            many.len(),
            many.iter()
                .map(|t| t.kind.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub fn fresh_id(all: &DrawingTemplates, name: &str) -> String {
    new_id(name, all.templates.iter().map(|t| t.id.as_str()))
}

pub fn put(
    all: &mut DrawingTemplates,
    template: DrawingTemplate,
) -> Result<(DrawingTemplate, bool), String> {
    if let Some(t) = all
        .templates
        .iter_mut()
        .find(|t| t.kind == template.kind && same_name(&t.name, &template.name))
    {
        *t = DrawingTemplate {
            id: t.id.clone(),
            ..template
        };
        return Ok((t.clone(), true));
    }
    if all.templates.len() >= DRAWING_TEMPLATES_MAX {
        return Err(format!(
            "at most {DRAWING_TEMPLATES_MAX} drawing templates: delete one first"
        ));
    }
    all.templates.push(template.clone());
    Ok((template, false))
}

pub fn new_drawings_template<'a>(
    all: &'a DrawingTemplates,
    kind: DrawingKind,
    entry: Option<&Value>,
) -> Option<&'a DrawingTemplate> {
    let look = new_drawing_look(kind, entry);
    all.templates
        .iter()
        .find(|t| t.kind == kind && template_look(t) == look)
}

pub fn styles_with(styles: Option<&Value>, kind: DrawingKind, look: Option<&DrawingLook>) -> Value {
    let mut map: BTreeMap<String, Value> = styles
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    match look {
        Some(l) => {
            map.insert(kind.as_str().to_owned(), new_drawing_value(l));
        }
        None => {
            map.remove(kind.as_str());
        }
    }
    json!(map)
}

pub fn label_schema() -> Value {
    json!({"type": "object", "additionalProperties": false, "properties": {
        "text": {"type": "string", "maxLength": drawings::LABEL_TEXT_MAX},
        "color": {"type": "string", "minLength": 1, "maxLength": 32},
        "size": {"type": "integer", "minimum": drawings::LABEL_SIZE_RANGE.0, "maximum": drawings::LABEL_SIZE_RANGE.1},
        "bold": {"type": "boolean"},
        "italic": {"type": "boolean"},
        "align": {"type": "string", "enum": ["left", "center", "right"]},
        "position": {"type": "string", "enum": ["above", "on", "below"]},
        "showPrice": {"type": "boolean"},
        "showLevels": {"type": "boolean"},
    }})
}

pub fn levels_schema() -> Value {
    json!({"type": "array", "maxItems": drawings::LEVELS_MAX, "items": {"type": "number", "minimum": -5, "maximum": 10}})
}

pub fn schema() -> Value {
    let kinds: Vec<&str> = DrawingKind::ALL.iter().map(|k| k.as_str()).collect();
    let style = json!({"type": "object", "additionalProperties": false, "required": ["color", "width", "line"],
    "properties": {
        "color": {"type": "string", "minLength": 1, "maxLength": 32},
        "width": {"type": "number", "minimum": 0.5, "maximum": 4},
        "line": {"type": "string", "enum": ["solid", "dash", "dot"]},
        "extend": {"type": "string", "enum": ["none", "left", "right", "both"]},
    }});
    let template = json!({"type": "object", "additionalProperties": false,
    "required": ["id", "name", "kind", "style"],
    "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 64},
        "name": {"type": "string", "minLength": 1, "maxLength": NAME_MAX},
        "kind": {"type": "string", "enum": kinds},
        "style": style,
        "label": label_schema(),
        "levels": levels_schema(),
    }});
    json!({"type": "object", "additionalProperties": false, "properties": {
        "templates": {"type": "array", "maxItems": DRAWING_TEMPLATES_MAX, "items": template},
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawings::{LabelAlign, LabelPosition};
    use crate::indicators::LineDash;

    fn template(id: &str, name: &str, kind: DrawingKind) -> DrawingTemplate {
        template_of(id.into(), name.into(), kind, built_in(kind))
    }

    #[test]
    fn a_stored_value_is_read_leniently() {
        let t = read(&json!({"templates": [
            {"id": "a", "name": " Session level ", "kind": "horizontal_line",
             "style": {"color": "brass", "width": 2, "line": "dash", "extend": "none"},
             "label": {"text": "Asia high", "align": "left", "showPrice": true}},
            {"id": "a", "name": "Same id", "kind": "ray", "style": {"color": "mist", "width": 1, "line": "solid"}},
            {"id": "b", "name": "SESSION LEVEL", "kind": "horizontal_line", "style": {"color": "mist", "width": 1, "line": "solid"}},
            {"id": "c", "name": "Session level", "kind": "horizontal_ray", "style": {"color": "mist", "width": 1, "line": "solid"}},
            {"id": "d", "name": "Bad colour", "kind": "ray", "style": {"color": "aqua", "width": 1, "line": "solid"}},
            {"id": "e", "name": "Golden", "kind": "fib_retracement", "style": {"color": "teal", "width": 1, "line": "solid"},
             "levels": [0.618, 0.5, 0.5], "label": {"showLevels": false}},
            {"id": "f", "name": "Note", "kind": "text", "style": {"color": "mist", "width": 1, "line": "solid"}, "label": {}},
            {"id": "g", "name": "Spiral", "kind": "spiral", "style": {"color": "mist", "width": 1, "line": "solid"}},
            "junk"
        ]}));
        let names: Vec<(&str, &str)> = t
            .templates
            .iter()
            .map(|t| (t.id.as_str(), t.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("a", "Session level"),
                ("c", "Session level"),
                ("e", "Golden"),
                ("f", "Note")
            ],
            "a name is its kind's alone; another kind may share it"
        );
        let level = &t.templates[0];
        let l = level.label.as_ref().unwrap();
        assert_eq!(l.text, "", "a template keeps no words");
        assert_eq!(l.align, LabelAlign::Left);
        assert!(l.show_price);
        assert_eq!(level.style.line, LineDash::Dash);
        let fib = &t.templates[2];
        assert_eq!(fib.levels.as_deref(), Some(&[0.5, 0.618][..]));
        assert!(!fib.label.as_ref().unwrap().show_levels);
        assert!(t.templates[3].label.is_none(), "a note takes no label");
        assert_eq!(read(&json!(null)), DrawingTemplates::default());
        assert!(validate_ok(
            &json!({"templates": [{"id": "a", "name": "A", "kind": "ray",
            "style": {"color": "mist", "width": 1, "line": "solid", "extend": "right"},
            "label": {"size": 14, "position": "on"}}]})
        ));
        assert!(!validate_ok(
            &json!({"templates": [{"id": "a", "name": "A", "kind": "spiral",
            "style": {"color": "mist", "width": 1, "line": "solid"}}]})
        ));
    }

    fn validate_ok(v: &Value) -> bool {
        serde_json::from_value::<DrawingTemplates>(v.clone()).is_ok()
    }

    #[test]
    fn templates_are_found_by_id_or_by_name_within_a_kind() {
        let all = DrawingTemplates {
            templates: vec![
                template("level", "Level", DrawingKind::HorizontalLine),
                template("level-2", "Level", DrawingKind::HorizontalRay),
                template("swing", "Swing", DrawingKind::TrendLine),
            ],
        };
        assert_eq!(find(&all, "swing", None).unwrap().name, "Swing");
        assert_eq!(find(&all, "SWING", None).unwrap().id, "swing");
        assert_eq!(
            find(&all, "level", None).unwrap().id,
            "level",
            "an id first"
        );
        let err = find(&all, "LEVEL", None).unwrap_err();
        assert!(err.contains("horizontal_line, horizontal_ray"), "{err}");
        assert_eq!(
            find(&all, "Level", Some(DrawingKind::HorizontalRay))
                .unwrap()
                .id,
            "level-2"
        );
        assert_eq!(
            find(&all, "level", Some(DrawingKind::HorizontalLine))
                .unwrap()
                .id,
            "level"
        );
        assert!(find(&all, "Swing", Some(DrawingKind::Ray)).is_err());
        assert_eq!(fresh_id(&all, "Level"), "level-3");
    }

    #[test]
    fn a_save_replaces_its_kinds_template_of_that_name() {
        let mut all = DrawingTemplates::default();
        let (a, replaced) = put(
            &mut all,
            template("a", "Level", DrawingKind::HorizontalLine),
        )
        .unwrap();
        assert!(!replaced);
        let mut look = built_in(DrawingKind::HorizontalLine);
        look.style.color = "brass".into();
        let (b, replaced) = put(
            &mut all,
            template_of(
                "b".into(),
                "LEVEL".into(),
                DrawingKind::HorizontalLine,
                look,
            ),
        )
        .unwrap();
        assert!(replaced);
        assert_eq!(b.id, a.id, "the replaced template keeps its id");
        assert_eq!(all.templates.len(), 1);
        assert_eq!(all.templates[0].style.color, "brass");
        put(&mut all, template("c", "Level", DrawingKind::Ray)).unwrap();
        assert_eq!(all.templates.len(), 2, "another kind's name is its own");
    }

    #[test]
    fn a_look_is_what_new_drawings_take_and_what_a_template_holds() {
        let kind = DrawingKind::TrendLine;
        assert_eq!(new_drawing_look(kind, None), built_in(kind));
        let remembered = json!({"color": "teal"});
        let look = new_drawing_look(kind, Some(&remembered));
        assert_eq!(look.style.color, "teal");
        assert_eq!(look.style.width, 1.0);
        assert_eq!(look.label, Some(DrawingLabel::default_for(kind)));
        let mut t = template("swing", "Swing", kind);
        t.style.width = 2.0;
        t.label = Some(DrawingLabel {
            position: LabelPosition::Below,
            bold: true,
            ..DrawingLabel::default_for(kind)
        });
        let entry = new_drawing_value(&template_look(&t));
        assert_eq!(entry["label"]["position"], "below");
        assert!(entry["label"].get("text").is_some_and(|v| v == ""));
        assert_eq!(new_drawing_look(kind, Some(&entry)), template_look(&t));
        let all = DrawingTemplates {
            templates: vec![t.clone()],
        };
        assert_eq!(
            new_drawings_template(&all, kind, Some(&entry)).map(|x| x.id.as_str()),
            Some("swing")
        );
        assert!(new_drawings_template(&all, kind, Some(&remembered)).is_none());
        let styles = styles_with(
            Some(&json!({"ray": {"color": "up"}})),
            kind,
            Some(&template_look(&t)),
        );
        assert_eq!(styles["ray"]["color"], "up", "other kinds keep theirs");
        assert_eq!(styles["trend_line"]["width"], 2.0);
        let reset = styles_with(Some(&styles), kind, None);
        assert!(reset.get("trend_line").is_none());
        let look = look_from_input(
            DrawingKind::FibRetracement,
            None,
            Some(&DrawingLabelInput {
                show_price: Some(false),
                ..DrawingLabelInput::default()
            }),
            Some(&[0.0, 0.5, 1.0]),
        )
        .unwrap();
        assert!(!look.label.unwrap().show_price);
        assert_eq!(look.levels.unwrap(), vec![0.0, 0.5, 1.0]);
        assert!(
            look_from_input(
                DrawingKind::Measure,
                None,
                Some(&DrawingLabelInput::default()),
                None
            )
            .is_err()
        );
        assert!(look_from_input(DrawingKind::Ray, None, None, Some(&[0.5])).is_err());
    }
}
