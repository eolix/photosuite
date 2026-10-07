//! Move tool drags shown live (#128): while the pointer drags, the canvas shows the document with
//! the moving layers already at the pointer, exactly as `layer.translate` will leave them, and
//! recomposites only where they were and where they are. Releasing commits one `layer.translate`
//! (one history step) whose damage rect refreshes the same area.

use std::sync::Arc;

use photosuite_doc::{DocId, Document, LayerId};
use photosuite_geom::Rect;

use crate::PhotosuiteApp;
use crate::state::Tool;

/// Preview keys of move drags: `BASE + n`, one per offset shown (see `canvas::display_doc`).
const BASE: u64 = 1 << 39;

pub(crate) struct MovePreview {
    doc: DocId,
    revision: u64,
    /// Layers that move ([`photosuite_engine::layer_multi_cmds::move_targets`]).
    ids: Vec<LayerId>,
    /// What moving them can change at offset (0, 0), not clipped to the canvas: a layer larger
    /// than the canvas brings its pixels from beyond the edge into view (`None` = anything).
    bounds: Option<Rect>,
    canvas: Rect,
    /// Offsets shown so far, by preview key (`BASE + index`).
    offsets: Vec<(i32, i32)>,
    /// The document at the latest offset.
    shown: Option<Arc<Document>>,
    /// Shows a floating selection (`select.float`): offsets are the piece's, from where it was cut.
    floating: bool,
}

impl MovePreview {
    fn key(&self) -> u64 {
        BASE + self.offsets.len() as u64
    }
    fn offset_of(&self, key: u64) -> Option<(i32, i32)> {
        if key == 0 {
            return Some((0, 0));
        }
        let i = usize::try_from(key.checked_sub(BASE + 1)?).ok()?;
        self.offsets.get(i).copied()
    }
    fn area(&self, d: (i32, i32)) -> Option<Rect> {
        let b = self.bounds?;
        Some(if b.is_empty() { b } else { b.translate(d.0, d.1).inflate(1).intersect(&self.canvas) })
    }
}

/// The whole-pixel offset of the current Move drag on document `idx`, if one is under way.
fn drag_offset(app: &PhotosuiteApp) -> Option<(i32, i32)> {
    let d = app.drag.as_ref().filter(|d| d.tool == Tool::Move)?;
    let end = d.points.last().map_or(d.start, |p| [p[0], p[1]]);
    let dx = (end[0] - d.start[0]).round().clamp(-1e7, 1e7) as i32;
    let dy = (end[1] - d.start[1]).round().clamp(-1e7, 1e7) as i32;
    Some((dx, dy))
}

/// The document to show while a Move drag is under way on document `idx`: the moving layers at
/// the pointer. `None` without a drag (or when the layers can't move: locked, say; the drag then
/// shows its arrow and the release reports why).
pub(crate) fn display_doc(app: &mut PhotosuiteApp, idx: usize) -> Option<(Arc<Document>, u64)> {
    if app.session.active_index() == Some(idx)
        && let Some(st) = app.session.documents().get(idx)
        && photosuite_engine::float_cmds::floating(st).is_some()
    {
        return floating_doc(app, idx);
    }
    // Preferences › Interface › Show bounding box when dragging layer: outline and arrow only.
    if app.session.active_index() != Some(idx) || app.session.prefs().interface.show_bounding_box_when_dragging_layer {
        return None;
    }
    let Some(offset) = drag_offset(app) else {
        app.move_preview = None;
        return None;
    };
    let st = app.session.documents().get(idx)?;
    let (doc_id, revision, doc) = (st.doc.id, st.revision, st.doc.clone());
    let fresh = app.move_preview.as_ref().is_some_and(|p| p.doc == doc_id && p.revision == revision);
    if !fresh {
        let ids = photosuite_engine::layer_multi_cmds::move_targets(&doc, &st.selected_layers());
        if ids.is_empty() {
            return None;
        }
        let all = Rect::new(i32::MIN / 2, i32::MIN / 2, i32::MAX / 2, i32::MAX / 2);
        let bounds = ids.iter().try_fold(Rect::EMPTY, |acc, id| Some(acc.union(&photosuite_compose::change_bounds(doc.layer(*id)?, all)?)));
        let canvas = doc.bounds();
        app.move_preview = Some(MovePreview { doc: doc_id, revision, ids, bounds, canvas, offsets: Vec::new(), shown: None, floating: false });
    }
    let p = app.move_preview.as_mut()?;
    if offset == (0, 0) && p.offsets.is_empty() {
        return None;
    }
    if p.offsets.last() != Some(&offset) {
        let t0 = crate::gpu_canvas::now_ms();
        match photosuite_engine::layer_multi_cmds::moved(&doc, &p.ids, offset.0, offset.1) {
            Ok(d) => {
                // Duotone documents display through their inks.
                let d = photosuite_engine::mode_cmds::display_document(&d).unwrap_or(d);
                p.shown = Some(Arc::new(d));
                p.offsets.push(offset);
            }
            Err(_) => {
                p.shown = None;
                return None;
            }
        }
        app.perf.span("move preview", crate::gpu_canvas::now_ms() - t0);
    }
    let p = app.move_preview.as_ref()?;
    Some((p.shown.clone()?, p.key()))
}

/// A floating selection's offset plus a drag of it in progress (`canvas::selection_drag_delta`).
pub(crate) fn floating_offset(app: &PhotosuiteApp) -> Option<(i32, i32)> {
    let f = photosuite_engine::float_cmds::floating(app.session.active()?)?;
    let d = crate::canvas::selection_drag_delta(app).unwrap_or((0, 0));
    Some((f.offset.0 + d.0, f.offset.1 + d.1))
}

/// The document shown while a selection floats: the cut piece at its offset, over the cut-out
/// layer. Only the piece's area changes between offsets, so each move costs the piece, not the
/// layer.
fn floating_doc(app: &mut PhotosuiteApp, idx: usize) -> Option<(Arc<Document>, u64)> {
    let offset = floating_offset(app)?;
    let st = app.session.documents().get(idx)?;
    let f = photosuite_engine::float_cmds::floating(st)?;
    let (doc_id, revision) = (st.doc.id, st.revision);
    let fresh = app.move_preview.as_ref().is_some_and(|p| p.doc == doc_id && p.revision == revision && p.floating);
    if !fresh {
        let bounds = st.doc.selection.as_ref().map(|s| s.content_bounds());
        let canvas = st.doc.bounds();
        app.move_preview = Some(MovePreview { doc: doc_id, revision, ids: vec![f.layer], bounds, canvas, offsets: Vec::new(), shown: None, floating: true });
    }
    let st = app.session.documents().get(idx)?;
    let shown = app.move_preview.as_ref()?.offsets.last() != Some(&offset);
    if shown {
        let t0 = crate::gpu_canvas::now_ms();
        let d = photosuite_engine::float_cmds::displayed(st, crate::canvas::selection_drag_delta(app).unwrap_or((0, 0)))?;
        let d = photosuite_engine::mode_cmds::display_document(&d).unwrap_or(d);
        let p = app.move_preview.as_mut()?;
        p.shown = Some(Arc::new(d));
        p.offsets.push(offset);
        app.perf.span("floating preview", crate::gpu_canvas::now_ms() - t0);
    }
    let p = app.move_preview.as_ref()?;
    Some((p.shown.clone()?, p.key()))
}

/// What changed between preview (or document) key `seen` and `now` of the current Move drag on
/// document `doc` at `revision`: where the moving layers were in both. `None` when either key
/// isn't one of this drag's (the canvas then recomposites everything).
pub(crate) fn damage(app: &PhotosuiteApp, doc: DocId, revision: u64, seen: u64, now: u64) -> Option<Rect> {
    let p = app.move_preview.as_ref().filter(|p| p.doc == doc && p.revision == revision)?;
    if seen == now || (seen < BASE && seen != 0) || (now < BASE && now != 0) {
        return None;
    }
    let (a, b) = (p.area(p.offset_of(seen)?)?, p.area(p.offset_of(now)?)?);
    Some(if a.is_empty() {
        b
    } else if b.is_empty() {
        a
    } else {
        a.union(&b)
    })
}

/// Whether the canvas shows a Move drag's layers at the pointer.
pub(crate) fn showing(app: &PhotosuiteApp) -> bool {
    app.move_preview.as_ref().is_some_and(|p| p.shown.is_some())
}

/// Whether `key` is a Move drag preview key.
pub(crate) fn is_preview_key(key: u64) -> bool {
    key > BASE && key < BASE << 1
}

/// Release: one `layer.translate` by the drag's offset. The canvas already shows the result, so
/// its caches are told it showed the document: the command's damage rect refreshes that area.
pub(crate) fn finish(app: &mut PhotosuiteApp, dx: f64, dy: f64) {
    // Only when the canvas shows this very offset (else it recomposites everything once).
    let at = (dx.clamp(-1e7, 1e7) as i32, dy.clamp(-1e7, 1e7) as i32);
    let shown = app.move_preview.take().filter(|p| p.shown.is_some() && p.offsets.last() == Some(&at));
    if dx == 0.0 && dy == 0.0 {
        return;
    }
    if app.run("layer.translate", serde_json::json!({"dx": dx, "dy": dy})).is_err() {
        return;
    }
    let Some(p) = shown else { return };
    crate::canvas::shown_as_document(app, p.doc, is_preview_key);
}

#[cfg(test)]
mod tests {
    use photosuite_geom::Rect;
    use serde_json::json;

    use crate::PhotosuiteApp;
    use crate::canvas::ToolEvent;
    use crate::state::Tool;

    #[test]
    fn dragging_a_layer_larger_than_the_canvas_redraws_what_comes_in_from_beyond_the_edge() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session
            .edit("paint", |doc, a| {
                doc.layer_mut(a.unwrap()).unwrap().surface_mut().unwrap().fill_rect(Rect::new(-32, -32, 96, 96), &[1.0, 0.0, 0.0, 1.0]);
                Ok(())
            })
            .unwrap();
        app.ui.tool = Tool::Move;
        app.ui.extras.snap = false;
        app.ui.view.show.smart_guides = false;
        let m = egui::Modifiers::NONE;
        crate::canvas::tool_event(&mut app, ToolEvent::Down { x: 32.0, y: 32.0, pressure: 1.0 }, m);
        let mut keys = Vec::new();
        for x in [42.0, 52.0] {
            crate::canvas::tool_event(&mut app, ToolEvent::Move { x, y: 32.0, pressure: 1.0 }, m);
            keys.push(super::display_doc(&mut app, 0).unwrap().1);
        }
        let st = app.session.active().unwrap();
        // From +10 to +20 the strip x 0..10 shows pixels that were off the canvas a frame ago.
        let r = super::damage(&app, st.doc.id, st.revision, keys[0], keys[1]).unwrap();
        assert_eq!(r, Rect::new(0, 0, 64, 64));
    }

    /// Mid-drag on a painted layer: is the layer shown at the pointer?
    fn live(outline: bool) -> bool {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session.execute("select.rect", json!({"x": 8, "y": 8, "width": 16, "height": 16})).unwrap();
        app.session.execute("edit.fill", json!({"color": "#ff0000"})).unwrap();
        app.session.execute("select.deselect", json!({})).unwrap();
        app.session.edit_prefs(|p| p.interface.show_bounding_box_when_dragging_layer = outline);
        app.ui.tool = Tool::Move;
        let m = egui::Modifiers::NONE;
        crate::canvas::tool_event(&mut app, ToolEvent::Down { x: 16.0, y: 16.0, pressure: 1.0 }, m);
        crate::canvas::tool_event(&mut app, ToolEvent::Move { x: 30.0, y: 20.0, pressure: 1.0 }, m);
        let shown = super::display_doc(&mut app, 0).is_some();
        assert_eq!(shown, super::showing(&app));
        shown
    }

    #[test]
    fn bounding_box_preference_turns_the_live_drag_off() {
        assert!(live(false), "by default the layer follows the pointer");
        assert!(!live(true), "with the preference on, only the outline and arrow move");
    }
}
