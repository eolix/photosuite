//! Magnetic Lasso Tool: a click starts the outline; moving the pointer (no button held) draws
//! a live wire from the last anchor that snaps to the strongest edge within Width
//! ([`photosuite_algo::livewire`]); a click fixes it with an anchor, and anchors also fall by
//! themselves as the wire grows (Frequency). Backspace removes the last anchor; Enter, a
//! double-click or a click on the first point closes the outline, and Esc cancels. The closed
//! outline becomes a selection through `select.lasso`, like the other lassos.
//!
//! The outline in progress lives in `app.ui.polygon` (as the Polygonal Lasso's does), so
//! Enter / Esc and the Polygonal Lasso's drawing apply; this module adds the anchors, the edge
//! image and the wire.

use std::sync::Arc;

use photosuite_algo::livewire::{self, EdgeImage};
use photosuite_doc::DocId;

use crate::PhotosuiteApp;
use crate::state::Tool;

/// The outline being traced.
pub struct Magnetic {
    doc: DocId,
    edges: Arc<EdgeImage>,
    /// Indices into `app.ui.polygon` of the anchors (the first point is one).
    pub anchors: Vec<usize>,
    /// The live wire from the last point to the snapped pointer (excludes the last point).
    pub wire: Vec<[f64; 2]>,
    /// Pixel the wire was last computed to.
    target: Option<[i64; 2]>,
    /// When and where (document px) the last click was, for double-clicks.
    last_click: (f64, [f64; 2]),
}

/// Seconds between the clicks of a double-click.
const DOUBLE_CLICK: f64 = 0.4;

fn centre(p: [i64; 2]) -> [f64; 2] {
    [p[0] as f64 + 0.5, p[1] as f64 + 0.5]
}

fn contrast(app: &PhotosuiteApp) -> f32 {
    (app.ui.tool_options.magnetic_contrast / 100.0).clamp(0.01, 1.0)
}

fn width(app: &PhotosuiteApp) -> f64 {
    f64::from(app.ui.tool_options.magnetic_width).clamp(1.0, 256.0)
}

/// Path length between automatic anchors: Frequency 100 places them every 10 px, 0 every 210.
fn anchor_spacing(app: &PhotosuiteApp) -> f64 {
    10.0 + (100.0 - f64::from(app.ui.tool_options.magnetic_frequency).clamp(0.0, 100.0)) * 2.0
}

/// The active document's composite as an edge image.
fn edge_image(app: &PhotosuiteApp) -> Option<(DocId, Arc<EdgeImage>)> {
    let st = app.session.active()?;
    let buf = photosuite_compose::flatten(&st.doc);
    let (w, h) = (buf.rect.width() as usize, buf.rect.height() as usize);
    Some((st.doc.id, Arc::new(EdgeImage::from_rgba(&buf.px, w, h))))
}

/// The tool's state, dropped when its outline is gone (Esc, a commit) or belongs to another
/// document.
fn live(app: &mut PhotosuiteApp) -> Option<&mut Magnetic> {
    let doc = app.session.active().map(|d| d.doc.id);
    if app.ui.polygon.is_empty() || app.magnetic.as_ref().is_some_and(|m| Some(m.doc) != doc) {
        app.magnetic = None;
    }
    app.magnetic.as_mut()
}

/// A click at document point (`x`, `y`).
pub fn click(app: &mut PhotosuiteApp, x: f64, y: f64, mods: egui::Modifiers) {
    let now = crate::gpu_canvas::now_ms() / 1000.0;
    if live(app).is_none() {
        let Some((doc, edges)) = edge_image(app) else { return };
        let p = edges.snap([x, y], width(app), contrast(app));
        app.ui.polygon = vec![centre(p)];
        app.magnetic = Some(Magnetic { doc, edges, anchors: vec![0], wire: Vec::new(), target: None, last_click: (now, [x, y]) });
        return;
    }
    let zoom = app.current_zoom().max(0.01) as f64;
    let near_start = app.ui.polygon.first().is_some_and(|p0| app.ui.polygon.len() >= 3 && (p0[0] - x).hypot(p0[1] - y) < 8.0 / zoom);
    // A double-click: two clicks in quick succession at the same spot.
    let double = app.magnetic.as_ref().is_some_and(|m| now - m.last_click.0 < DOUBLE_CLICK && (m.last_click.1[0] - x).hypot(m.last_click.1[1] - y) < 4.0 / zoom);
    if near_start || double {
        close(app, mods);
        return;
    }
    hover(app, [x, y]);
    if let Some(m) = app.magnetic.as_mut() {
        app.ui.polygon.append(&mut m.wire);
        m.anchors.push(app.ui.polygon.len() - 1);
        m.target = None;
        m.last_click = (now, [x, y]);
    }
}

/// The pointer is over document point `p`: recompute the wire, placing anchors as it grows.
pub fn hover(app: &mut PhotosuiteApp, p: [f64; 2]) {
    if app.ui.tool != Tool::MagneticLasso {
        return;
    }
    let (w, c, spacing) = (width(app), contrast(app), anchor_spacing(app));
    let Some(last) = app.ui.polygon.last().copied() else { return };
    let Some(m) = live(app) else { return };
    let target = m.edges.snap(p, w, c);
    if m.target == Some(target) {
        return;
    }
    m.target = Some(target);
    let from = [last[0].floor() as i64, last[1].floor() as i64];
    let mut path = m.edges.wire(from, target, w.ceil() as i64 + 4, c);
    // Frequency: fix the wire every `spacing` px with an anchor.
    let mut fixed: Vec<Vec<[f64; 2]>> = Vec::new();
    while livewire::path_length(&path) > spacing * 1.5 {
        let mut len = 0.0;
        let mut cut = path.len() - 1;
        for (i, s) in path.windows(2).enumerate() {
            len += ((s[1][0] - s[0][0]) as f64).hypot((s[1][1] - s[0][1]) as f64);
            if len >= spacing {
                cut = i + 1;
                break;
            }
        }
        fixed.push(path[1..=cut].iter().map(|q| centre(*q)).collect());
        path.drain(..cut);
    }
    m.wire = path.iter().skip(1).map(|q| centre(*q)).collect();
    for seg in fixed {
        app.ui.polygon.extend(seg);
        let n = app.ui.polygon.len() - 1;
        if let Some(m) = app.magnetic.as_mut() {
            m.anchors.push(n);
        }
    }
}

/// Close the outline (a wire back to the first point) and make the selection.
pub fn close(app: &mut PhotosuiteApp, mods: egui::Modifiers) {
    let c = contrast(app);
    let w = width(app);
    if let (Some(m), Some(first), Some(last)) = (app.magnetic.as_ref(), app.ui.polygon.first().copied(), app.ui.polygon.last().copied()) {
        let a = [last[0].floor() as i64, last[1].floor() as i64];
        let b = [first[0].floor() as i64, first[1].floor() as i64];
        let back = m.edges.wire(a, b, w.ceil() as i64 + 4, c);
        let pts: Vec<[f64; 2]> = back.iter().skip(1).map(|q| centre(*q)).collect();
        app.ui.polygon.extend(pts);
    }
    app.magnetic = None;
    crate::canvas::commit_polygon(app, mods);
}

/// Backspace / Delete: drop the last anchor (and the wire to it); the first one cancels.
pub fn remove_anchor(app: &mut PhotosuiteApp) {
    let Some(m) = live(app) else { return };
    m.anchors.pop();
    m.wire.clear();
    m.target = None;
    match m.anchors.last().copied() {
        Some(i) => app.ui.polygon.truncate(i + 1),
        None => {
            app.ui.polygon.clear();
            app.magnetic = None;
        }
    }
}

/// Whether the Magnetic Lasso has an outline in progress.
pub fn active(app: &PhotosuiteApp) -> bool {
    app.magnetic.is_some() && !app.ui.polygon.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A document with a white disc (radius 30) on black.
    fn app() -> PhotosuiteApp {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
        app.run("file.new", json!({"width": 100, "height": 100, "background": "black"})).unwrap();
        app.run("select.rect", json!({"x": 20, "y": 20, "width": 60, "height": 60, "ellipse": true, "antiAlias": false})).unwrap();
        app.run("edit.fill", json!({"color": "#ffffff"})).unwrap();
        app.run("select.deselect", json!({})).unwrap();
        app.ui.tool = Tool::MagneticLasso;
        app.ui.tool_options.magnetic_frequency = 0.0;
        app
    }

    #[test]
    fn traces_the_edge_and_selects_the_shape() {
        let mut app = app();
        let m = egui::Modifiers::NONE;
        click(&mut app, 78.0, 50.0, m); // near the rim at the right
        hover(&mut app, [50.0, 78.0]);
        assert!(!app.magnetic.as_ref().unwrap().wire.is_empty(), "a live wire");
        click(&mut app, 50.0, 78.0, m);
        hover(&mut app, [22.0, 50.0]);
        click(&mut app, 22.0, 50.0, m);
        hover(&mut app, [50.0, 22.0]);
        click(&mut app, 50.0, 22.0, m);
        assert_eq!(app.magnetic.as_ref().unwrap().anchors.len(), 4);
        // Every outline point hugs the rim.
        let off = app.ui.polygon.iter().map(|p| ((p[0] - 50.0).hypot(p[1] - 50.0) - 30.0).abs()).fold(0.0f64, f64::max);
        assert!(off < 3.0, "outline strays {off} px from the edge");
        close(&mut app, m);
        assert!(app.ui.polygon.is_empty() && app.magnetic.is_none());
        let sel = app.session.active().unwrap().doc.selection.clone().expect("a selection");
        let b = sel.content_bounds();
        assert!(b.width().abs_diff(60) <= 4 && b.height().abs_diff(60) <= 4, "{b:?}");
    }

    #[test]
    fn anchors_fall_by_themselves_and_backspace_removes_them() {
        let mut app = app();
        app.ui.tool_options.magnetic_frequency = 100.0; // every 10 px
        click(&mut app, 78.0, 50.0, egui::Modifiers::NONE);
        // The pointer moves along the rim in small steps, as a hand does.
        for k in 1..=18 {
            let a = f64::from(k) * 10f64.to_radians();
            hover(&mut app, [50.0 + 29.0 * a.cos(), 50.0 + 29.0 * a.sin()]);
        }
        let n = app.magnetic.as_ref().unwrap().anchors.len();
        assert!(n >= 4, "automatic anchors along a half circle: {n}");
        remove_anchor(&mut app);
        assert_eq!(app.magnetic.as_ref().unwrap().anchors.len(), n - 1);
        for _ in 0..n {
            remove_anchor(&mut app);
        }
        assert!(app.ui.polygon.is_empty() && app.magnetic.is_none(), "removing the first anchor cancels");
    }
}
