use std::collections::{BTreeMap, BTreeSet};

use tessera_core::{Origin, Timestamp};
use tessera_protocol::drawings::{
    self, ChartAddDrawingInput, ChartDrawingOutput, ChartRemoveDrawingInput,
    ChartUpdateDrawingInput, DRAWINGS_MAX,
};
use tessera_protocol::io::{PulledDrawing, RemovedOutput};
use tessera_protocol::layout::{ChartState, Layout, OverlayNamespace};
use tessera_tools::ToolError;

use super::{LayoutService, namespace_of};

pub(super) fn normalize_drawings(charts: &mut BTreeMap<String, ChartState>) {
    let tiles: BTreeSet<String> = charts.keys().cloned().collect();
    for c in charts.values_mut() {
        drawings::migrate_annotations(c);
        let mut seen = BTreeSet::new();
        let own = c.tile_id.clone();
        c.drawings_from
            .retain(|t| *t != own && tiles.contains(t) && seen.insert(t.clone()));
    }
}

pub(super) fn pulled(l: &Layout, tile: &str) -> Vec<PulledDrawing> {
    let Some(c) = l.charts.get(tile) else {
        return Vec::new();
    };
    c.drawings_from
        .iter()
        .filter_map(|from| l.charts.get(from).map(|s| (from, s)))
        .flat_map(|(from, s)| {
            s.drawings
                .iter()
                .filter(|d| d.instrument == c.instrument)
                .map(|d| PulledDrawing {
                    tile_id: from.clone(),
                    drawing: d.clone(),
                })
        })
        .collect()
}

fn home_of(l: &Layout, tile: &str, id: &str) -> Option<String> {
    let c = l.charts.get(tile)?;
    if c.drawings.iter().any(|d| d.id == id) {
        return Some(tile.to_owned());
    }
    pulled(l, tile)
        .into_iter()
        .find(|p| p.drawing.id == id)
        .map(|p| p.tile_id)
}

impl LayoutService {
    pub async fn add_drawing(
        &self,
        input: ChartAddDrawingInput,
        origin: &Origin,
    ) -> Result<ChartDrawingOutput, ToolError> {
        let (namespace, session_id) = namespace_of(origin);
        let now: Timestamp = self.clock.now();
        let tile = input.tile_id.clone();
        let mut target = String::new();
        let (layout, drawing) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.add_drawing",
                origin,
                tile.as_deref(),
                |l| {
                    target = Self::tile_of(l, tile.as_deref())?;
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    if c.drawings.len() >= DRAWINGS_MAX {
                        return Err(ToolError::invalid_input(format!(
                            "a chart keeps at most {DRAWINGS_MAX} drawings"
                        )));
                    }
                    let d = drawings::build(
                        drawings::new_id(),
                        c.instrument.clone(),
                        &input,
                        namespace,
                        session_id,
                        now,
                    )
                    .map_err(ToolError::invalid_input)?;
                    c.drawings.push(d.clone());
                    Ok(d)
                },
            )
            .await?;
        Ok(ChartDrawingOutput {
            layout_id: layout.id,
            tile_id: target,
            revision: layout.revision,
            drawing,
        })
    }

    pub async fn update_drawing(
        &self,
        input: ChartUpdateDrawingInput,
        origin: &Origin,
    ) -> Result<ChartDrawingOutput, ToolError> {
        let tile = input.tile_id.clone();
        let mut target = String::new();
        let (layout, drawing) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.update_drawing",
                origin,
                tile.as_deref(),
                |l| {
                    let shown_on = Self::tile_of(l, tile.as_deref())?;
                    target = home_of(l, &shown_on, &input.drawing_id).ok_or_else(|| {
                        ToolError::not_found(format!(
                            "no drawing {} on {shown_on}",
                            input.drawing_id
                        ))
                    })?;
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    let d = c
                        .drawings
                        .iter_mut()
                        .find(|d| d.id == input.drawing_id)
                        .expect("its home chart has it");
                    if d.locked && input.locked != Some(false) && input.points.is_some() {
                        return Err(ToolError::invalid_input(format!(
                            "drawing {} is locked: unlock it to move it (locked: false)",
                            d.id
                        )));
                    }
                    drawings::update(d, &input).map_err(ToolError::invalid_input)?;
                    Ok(d.clone())
                },
            )
            .await?;
        Ok(ChartDrawingOutput {
            layout_id: layout.id,
            tile_id: target,
            revision: layout.revision,
            drawing,
        })
    }

    pub async fn remove_drawing(
        &self,
        input: ChartRemoveDrawingInput,
        origin: &Origin,
    ) -> Result<RemovedOutput, ToolError> {
        let all = input.all.unwrap_or(false);
        if all == input.drawing_id.is_some() {
            return Err(ToolError::invalid_input(
                "give either drawingId or all: true",
            ));
        }
        if input.include_user.is_some() && !all {
            return Err(ToolError::invalid_input("includeUser goes with all: true"));
        }
        let tile = input.tile_id.clone();
        let user = origin.is_user() || input.include_user == Some(true);
        let (layout, removed) = self
            .mutate(
                input.layout_id.as_deref(),
                "chart.remove_drawing",
                origin,
                tile.as_deref(),
                |l| {
                    let shown_on = Self::tile_of(l, tile.as_deref())?;
                    let target = match &input.drawing_id {
                        Some(id) => home_of(l, &shown_on, id).ok_or_else(|| {
                            ToolError::not_found(format!("no drawing {id} on {shown_on}"))
                        })?,
                        None => shown_on,
                    };
                    let c = l.charts.get_mut(&target).expect("tile exists");
                    let before = c.drawings.len();
                    if let Some(id) = &input.drawing_id {
                        c.drawings.retain(|d| &d.id != id);
                    } else {
                        let instrument = c.instrument.clone();
                        c.drawings.retain(|d| {
                            let mine = user || d.namespace == OverlayNamespace::Agent;
                            !(mine && d.instrument == instrument)
                        });
                    }
                    Ok((before - c.drawings.len()) as u32)
                },
            )
            .await?;
        Ok(RemovedOutput {
            removed,
            revision: layout.revision,
        })
    }
}
