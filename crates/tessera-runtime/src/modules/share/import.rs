use serde_json::{Value, json};
use tessera_protocol::layers::LayerKind;
use tessera_protocol::layout::{ChartLayer, OverlayNamespace};

use super::setup::{PortableLayer, custom_index};

pub const SHARE_ID_LEN: usize = 12;

pub fn share_id(pasted: &str, base: &str) -> Option<String> {
    let mut link = pasted.trim();
    if let Some(at) = link.find('#') {
        link = &link[..at];
    }
    if let Some(at) = link.find('?') {
        link = &link[..at];
    }
    let link = link.strip_suffix('/').unwrap_or(link);
    let (scheme, rest) = link.split_once("://")?;
    let (own_scheme, own_rest) = base.trim().trim_end_matches('/').split_once("://")?;
    let (host, path) = rest.split_once('/')?;
    let (own_host, own_path) = own_rest.split_once('/').unwrap_or((own_rest, ""));
    if !scheme.eq_ignore_ascii_case(own_scheme) || !host.eq_ignore_ascii_case(own_host) {
        return None;
    }
    let shares = if own_path.is_empty() {
        "s/".to_owned()
    } else {
        format!("{own_path}/s/")
    };
    let id = path.strip_prefix(shares.as_str())?;
    (id.len() == SHARE_ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric()))
        .then(|| id.to_owned())
}

pub fn share_url(base: &str, id: &str) -> String {
    format!("{}/s/{id}", base.trim().trim_end_matches('/'))
}

pub fn retargeted(dock: &Value, layout_id: &str) -> Value {
    let mut dock = dock.clone();
    if let Some(panels) = dock.get_mut("panels").and_then(Value::as_object_mut) {
        for panel in panels.values_mut() {
            if let Some(params) = panel.get_mut("params").and_then(Value::as_object_mut)
                && params.contains_key("layoutId")
            {
                params.insert("layoutId".into(), json!(layout_id));
            }
        }
    }
    dock
}

pub fn with_custom_ids(layer: &PortableLayer, ids: &[Option<String>]) -> Option<Value> {
    let mut params = layer.params.clone();
    if let Some(n) = custom_index(layer) {
        let id = ids.get(n)?.clone()?;
        params
            .as_object_mut()?
            .insert("indicator".into(), json!(id));
    }
    Some(params)
}

pub fn chart_layers(layers: Vec<(LayerKind, Value, bool)>) -> Vec<ChartLayer> {
    let mut out: Vec<ChartLayer> = Vec::with_capacity(layers.len());
    for (kind, params, visible) in layers {
        let kind = kind.as_str().to_owned();
        let id = (1..)
            .map(|n| format!("{kind}-{n}"))
            .find(|cand| out.iter().all(|x| &x.id != cand))
            .expect("unbounded");
        out.push(ChartLayer {
            id,
            kind,
            params,
            visible,
            namespace: OverlayNamespace::User,
            session_id: None,
        });
    }
    out
}
