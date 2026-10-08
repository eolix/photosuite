//! Direct Selection tool (A, #790), and the Pen's ⌘/Ctrl (Direct Selection) and ⌥/Alt (Convert
//! Point) modifiers, as in Photoshop. It edits the paths the canvas shows: the targeted vector
//! mask or the active shape layer's path, and the work path.
//!
//! * Click an anchor to select it (⇧ adds or removes, ⌥ selects its whole subpath), drag on empty
//!   canvas to marquee-select anchors, click empty canvas to deselect.
//! * Drag selected anchors to move them, a direction handle to turn it (a smooth point keeps its
//!   handles collinear; ⌥ breaks them apart), or a segment to bend it (straight segments move).
//! * Pen + ⌥: click an anchor to make it a corner, drag from it to pull out smooth handles, drag a
//!   handle to move it alone.
//!
//! A drag previews with `photosuite_vector::edit` and commits once on release through the engine
//! (`path.moveAnchors`, `path.moveHandle`, `path.bendSegment`, `path.convertPoint`): one history
//! step per drag, and the same commands drive it over MCP and the control channel.

use egui::{Color32, Modifiers, Pos2};
use photosuite_doc::vector::Path;
use photosuite_geom::Point;
use photosuite_vector::edit::{self, Handle, Hit};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::PhotosuiteApp;
use crate::canvas::ToolEvent;
use crate::state::Tool;

/// A path Direct Selection edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathRef {
    Work,
    /// A layer's shape path, or its vector mask.
    Layer(u64),
}

impl PathRef {
    /// The engine's target params for this path.
    fn params(self) -> Value {
        match self {
            PathRef::Work => json!({"name": "work"}),
            PathRef::Layer(id) => json!({"name": "layer", "layer": id}),
        }
    }
}

/// Direct Selection state: which anchors are selected and the drag in progress.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DirectSelection {
    /// The path whose anchors are selected.
    pub target: Option<PathRef>,
    /// Selected anchors as `[subpath, knot]`.
    pub anchors: Vec<[usize; 2]>,
    /// A clicked segment (`[subpath, knot]` it leaves): its two handles show.
    pub segment: Option<[usize; 2]>,
    #[serde(skip)]
    pub drag: Option<Drag>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Drag {
    /// Editing `target`: `base` is its path at the press, `preview` the edit so far.
    Edit { target: PathRef, base: Path, edit: Edit, start: [f64; 2], end: [f64; 2], preview: Option<Path> },
    /// Marquee-selecting anchors (⇧ adds to the selection).
    Marquee { start: [f64; 2], end: [f64; 2], add: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Edit {
    Anchors(Vec<[usize; 2]>),
    /// A handle, where it was at the press, and whether it moves alone (⌥).
    Handle([usize; 2], Handle, Point, bool),
    Segment([usize; 2], f64),
    /// Pen + ⌥ on an anchor: a click makes a corner, a drag pulls out smooth handles.
    Convert([usize; 2]),
}

impl Edit {
    /// The edit for a drag from `start` to `end`, as a command and its params (without target).
    fn command(&self, start: [f64; 2], end: [f64; 2]) -> (&'static str, Value) {
        let d = [end[0] - start[0], end[1] - start[1]];
        match self {
            Edit::Anchors(a) => ("path.moveAnchors", json!({"anchors": a, "move": d})),
            Edit::Handle([s, k], h, from, independent) => {
                ("path.moveHandle", json!({"subpath": s, "knot": k, "handle": h.name(), "to": [from.x + d[0], from.y + d[1]], "independent": independent}))
            }
            Edit::Segment([s, k], t) => ("path.bendSegment", json!({"subpath": s, "knot": k, "t": t, "move": d})),
            Edit::Convert([s, k]) => ("path.convertPoint", json!({"subpath": s, "knot": k, "out": end})),
        }
    }

    /// `base` edited as the command would: the drag preview.
    fn preview(&self, base: &Path, start: [f64; 2], end: [f64; 2]) -> Option<Path> {
        let d = [end[0] - start[0], end[1] - start[1]];
        let mut p = base.clone();
        match self {
            Edit::Anchors(a) => edit::move_anchors(&mut p, a, d),
            Edit::Handle(k, h, from, independent) => edit::move_handle(&mut p, *k, *h, Point::new(from.x + d[0], from.y + d[1]), *independent),
            Edit::Segment(k, t) => edit::bend_segment(&mut p, *k, *t, d),
            Edit::Convert(k) => edit::convert_point(&mut p, *k, Some(Point::new(end[0], end[1]))),
        }
        .ok()?;
        Some(p)
    }
}

/// Is Direct Selection what the pointer does now: its own tool, or the Pen with ⌘/Ctrl held.
fn direct(tool: Tool, mods: Modifiers) -> bool {
    tool == Tool::DirectSelection || (tool == Tool::Pen && mods.command)
}

/// Does the canvas draw Direct Selection's overlay instead of the plain path outlines?
pub fn shows(app: &PhotosuiteApp, mods: Modifiers) -> bool {
    direct(app.ui.tool, mods) || app.ui.direct_selection.drag.is_some()
}

/// The paths Direct Selection edits, front first: the targeted vector mask or the active shape
/// layer's path, then the work path.
fn candidates(app: &PhotosuiteApp) -> Vec<(PathRef, Path)> {
    let layer = crate::vector_ui::targeted_vector_mask(app).or_else(|| crate::vector_ui::active_shape_path(app));
    let work = app.session.active().and_then(|st| st.doc.work_path.clone());
    layer.map(|(id, p)| (PathRef::Layer(id), p)).into_iter().chain(work.map(|p| (PathRef::Work, p))).collect()
}

fn retracted(k: &photosuite_doc::Knot, h: Handle) -> bool {
    let c = if h == Handle::In { k.in_ctrl } else { k.out_ctrl };
    (c.x - k.anchor.x).abs() < 1e-9 && (c.y - k.anchor.y).abs() < 1e-9
}

/// The handles shown on `path`: both of every selected anchor and the two of a clicked segment
/// (retracted handles sit on their anchor and don't show).
fn shown_handles(ds: &DirectSelection, path: &Path) -> Vec<([usize; 2], Handle)> {
    let knot = |r: [usize; 2]| path.subpaths.get(r[0]).and_then(|s| s.knots.get(r[1]));
    let mut out: Vec<([usize; 2], Handle)> = ds.anchors.iter().flat_map(|&r| [(r, Handle::In), (r, Handle::Out)]).collect();
    if let Some([s, k]) = ds.segment
        && let Some(sp) = path.subpaths.get(s)
    {
        let n = sp.knots.len();
        let next = k.checked_add(1).filter(|&j| j < n).or((sp.closed && n > 1).then_some(0));
        out.push(([s, k], Handle::Out));
        out.extend(next.map(|j| ([s, j], Handle::In)));
    }
    out.retain(|&(r, h)| knot(r).is_some_and(|k| !retracted(k, h)));
    out
}

/// Canvas pointer events for Direct Selection and the Pen's ⌘ / ⌥ modes; false when the event is
/// not theirs.
pub fn pointer(app: &mut PhotosuiteApp, ev: ToolEvent, mods: Modifiers) -> bool {
    let tool = app.ui.tool;
    match ev {
        ToolEvent::Down { x, y, .. } => {
            let pen_idle = app.ui.pen.is_none();
            // Pen + ⌥ is Convert Point only while no path is being drawn.
            let convert = tool == Tool::Pen && mods.alt && !mods.command && pen_idle;
            if !(direct(tool, mods) || convert) {
                return false;
            }
            if tool == Tool::Pen && !pen_idle {
                // ⌘-click ends the path being drawn, which becomes editable, as in Photoshop.
                crate::vector_ui::pen_commit(app, false);
            }
            press(app, [x, y], mods, convert)
        }
        ToolEvent::Move { x, y, .. } => {
            let ds = &mut app.ui.direct_selection;
            match &mut ds.drag {
                Some(Drag::Edit { base, edit, start, end, preview, .. }) => {
                    *end = [x, y];
                    *preview = edit.preview(base, *start, *end);
                }
                Some(Drag::Marquee { end, .. }) => *end = [x, y],
                None => return tool == Tool::DirectSelection,
            }
            true
        }
        ToolEvent::Up { x, y } => match app.ui.direct_selection.drag.take() {
            Some(Drag::Edit { target, edit, start, .. }) => {
                release(app, target, &edit, start, [x, y]);
                true
            }
            Some(Drag::Marquee { start, add, .. }) => {
                marquee(app, start, [x, y], add);
                true
            }
            None => tool == Tool::DirectSelection,
        },
    }
}

/// A press: pick what's under the pointer and start a drag. False lets the Pen handle a ⌥-press
/// that hit nothing.
fn press(app: &mut PhotosuiteApp, p: [f64; 2], mods: Modifiers, convert: bool) -> bool {
    let tol = 6.0 / f64::from(app.current_zoom().max(0.01));
    let ds = &app.ui.direct_selection;
    let found = candidates(app).into_iter().find_map(|(r, path)| {
        let handles = if ds.target == Some(r) { shown_handles(ds, &path) } else { Vec::new() };
        edit::hit(&path, Point::new(p[0], p[1]), tol, &handles).map(|h| (r, path, h))
    });
    let ds = &mut app.ui.direct_selection;
    let Some((target, base, hit)) = found else {
        if convert {
            return false;
        }
        ds.drag = Some(Drag::Marquee { start: p, end: p, add: mods.shift });
        return true;
    };
    if ds.target != Some(target) {
        *ds = DirectSelection { target: Some(target), ..Default::default() };
    }
    let edit = match hit {
        Hit::Handle(k, h) => {
            let kn = base.subpaths.get(k[0]).and_then(|s| s.knots.get(k[1]));
            let from = kn.map_or(Point::new(p[0], p[1]), |kn| if h == Handle::In { kn.in_ctrl } else { kn.out_ctrl });
            Edit::Handle(k, h, from, mods.alt)
        }
        Hit::Anchor(k) if convert => Edit::Convert(k),
        // Pen + ⌥ on a segment does nothing.
        Hit::Segment(..) if convert => return true,
        Hit::Anchor(k) => {
            ds.segment = None;
            if mods.alt {
                ds.anchors = edit::subpath_anchors(&base, k[0]);
            } else if mods.shift {
                // ⇧-click toggles the anchor; a click that deselects drags nothing.
                if let Some(i) = ds.anchors.iter().position(|a| *a == k) {
                    ds.anchors.remove(i);
                    return true;
                }
                ds.anchors.push(k);
            } else if !ds.anchors.contains(&k) {
                ds.anchors = vec![k];
            }
            Edit::Anchors(ds.anchors.clone())
        }
        Hit::Segment(k, _) if mods.alt => {
            ds.segment = None;
            ds.anchors = edit::subpath_anchors(&base, k[0]);
            Edit::Anchors(ds.anchors.clone())
        }
        Hit::Segment(k, t) => {
            ds.anchors.clear();
            ds.segment = Some(k);
            Edit::Segment(k, t)
        }
    };
    ds.drag = Some(Drag::Edit { target, base, edit, start: p, end: p, preview: None });
    true
}

/// End of an edit drag: commit it as one command. A click (no movement) commits nothing, except
/// Pen + ⌥ on an anchor, which makes it a corner.
fn release(app: &mut PhotosuiteApp, target: PathRef, edit: &Edit, start: [f64; 2], end: [f64; 2]) {
    let moved = (end[0] - start[0]).hypot(end[1] - start[1]) * f64::from(app.current_zoom()) >= 1.0;
    let (id, mut params) = match edit {
        Edit::Convert([s, k]) if !moved => ("path.convertPoint", json!({"subpath": s, "knot": k})),
        _ if !moved => return,
        e => e.command(start, end),
    };
    if let (Some(p), Some(t)) = (params.as_object_mut(), target.params().as_object()) {
        p.extend(t.clone());
    }
    if let Err(e) = app.run(id, params) {
        app.ui.status = e;
        app.ui.status_error = true;
    }
}

/// End of a marquee: select the anchors inside it on the frontmost path that has any (⇧ adds).
/// A click on empty canvas deselects.
fn marquee(app: &mut PhotosuiteApp, start: [f64; 2], end: [f64; 2], add: bool) {
    let rect = [start[0], start[1], end[0], end[1]];
    let hits = candidates(app).into_iter().map(|(r, path)| (r, edit::anchors_in(&path, rect))).find(|(_, a)| !a.is_empty());
    let ds = &mut app.ui.direct_selection;
    match hits {
        Some((r, anchors)) if add && ds.target == Some(r) => {
            for a in anchors {
                if !ds.anchors.contains(&a) {
                    ds.anchors.push(a);
                }
            }
            ds.segment = None;
        }
        Some((r, anchors)) => *ds = DirectSelection { target: Some(r), anchors, ..Default::default() },
        None if add => {}
        None => {
            ds.anchors.clear();
            ds.segment = None;
        }
    }
}

/// Paths with their anchors (selected ones filled), the shown handles, the drag's preview in
/// place of its path, and the marquee.
pub fn draw_overlay(app: &PhotosuiteApp, painter: &egui::Painter, to_scr: &dyn Fn([f64; 2]) -> Pos2, accent: Color32) {
    let ds = &app.ui.direct_selection;
    for (r, path) in candidates(app) {
        let path = match &ds.drag {
            Some(Drag::Edit { target, preview: Some(p), .. }) if *target == r => p.clone(),
            _ => path,
        };
        crate::vector_ui::draw_outline(painter, &path, to_scr, accent);
        let ours = ds.target == Some(r);
        for &(k, h) in if ours { shown_handles(ds, &path) } else { Vec::new() }.iter() {
            if let Some(kn) = path.subpaths.get(k[0]).and_then(|s| s.knots.get(k[1])) {
                let c = if h == Handle::In { kn.in_ctrl } else { kn.out_ctrl };
                crate::vector_ui::draw_handle(painter, to_scr([kn.anchor.x, kn.anchor.y]), to_scr([c.x, c.y]), accent);
            }
        }
        for (s, sp) in path.subpaths.iter().enumerate() {
            for (k, kn) in sp.knots.iter().enumerate() {
                crate::vector_ui::draw_anchor(painter, to_scr([kn.anchor.x, kn.anchor.y]), ours && ds.anchors.contains(&[s, k]), accent);
            }
        }
    }
    if let Some(Drag::Marquee { start, end, .. }) = &ds.drag {
        let pts = [*start, [end[0], start[1]], *end, [start[0], end[1]]].map(to_scr);
        crate::tool_feedback::draw_ants(painter, &pts, true);
    }
}

#[cfg(test)]
#[path = "direct_select_tests.rs"]
mod tests;
