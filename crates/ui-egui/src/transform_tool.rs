//! Free Transform (⌘T): bounding box with handles over the canvas, live preview, commit via the
//! engine's `edit.transform` (one quad for scale/rotate/skew/distort/perspective).
//!
//! Gestures follow Photoshop CC: corner drag scales proportionally (⇧ for free), edges scale one
//! axis, ⌥ scales about the reference point, ⌘-drag a corner distorts (⌘⌥⇧: perspective), ⌘-drag
//! an edge skews (⇧ along the edge), drag outside rotates (⇧ snaps to 15°), drag inside moves
//! (⇧ locks to 8 directions), the reference point can be dragged and ⌥-click puts it under the
//! pointer. Arrow keys nudge the box (move_mods.rs). ↩ commits, Esc cancels. Undo and Redo step
//! through the session's own changes (`Steps`), not the document's history.

use std::sync::Arc;

use egui::{Color32, CursorIcon, Pos2, Stroke, pos2, vec2};
use photosuite_algo::transform::Homography;
use photosuite_doc::{Document, LayerContent, LayerId};
use photosuite_geom::warp::{BezierMesh, Warp, WarpStyle};
use serde_json::json;

use crate::PhotosuiteApp;
use crate::canvas::{ToolEvent, ViewXform};
use crate::state::{MadeLayer, Tool, TransformMode, TransformSession};

/// Which Split button is armed. The guide follows the pointer and the split is added on release.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SplitTool {
    Cross,
    Vertical,
    Horizontal,
}

impl SplitTool {
    fn command(self) -> &'static str {
        match self {
            SplitTool::Cross => "edit.transform.splitWarpCrosswise",
            SplitTool::Vertical => "edit.transform.splitWarpVertically",
            SplitTool::Horizontal => "edit.transform.splitWarpHorizontally",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            SplitTool::Cross => "cross",
            SplitTool::Vertical => "vertical",
            SplitTool::Horizontal => "horizontal",
        }
    }
}

/// Preview state that isn't serialisable: the document without the transformed pixels, and
/// full-resolution textures of those pixels (transform_tex.rs).
pub struct TransformPreview {
    pub session: u64,
    pub doc: Arc<Document>,
    pub texture: crate::transform_tex::PreviewTextures,
    pub opacity: f32,
    gesture: Option<Gesture>,
    /// Warp-mode drag: (control point, pointer start, mesh points at the start).
    warp_drag: Option<(usize, [f64; 2], Vec<[f64; 2]>)>,
    /// Armed split tool. None while the buttons are off and control points drag as usual.
    split_tool: Option<SplitTool>,
    /// Document point the split guide is following (a drag, or the hover while placing).
    split_pointer: Option<[f64; 2]>,
    split_placing: bool,
    /// Option-click places a split without a button armed.
    split_quick: bool,
    steps: Steps,
    /// The tool the session began with: picking another one applies the transform.
    tool: Tool,
}

/// Grab radius of the box's handles, in screen points. Generous, so a corner is easy to catch;
/// just beyond it, outside the box, a drag rotates.
pub const HANDLE_PX: f64 = 12.0;

/// [`HANDLE_PX`] in document pixels at the current zoom.
pub fn handle_tolerance(app: &PhotosuiteApp) -> f64 {
    HANDLE_PX / app.current_zoom().max(0.01) as f64
}

/// The box as one undo step restores it.
#[derive(Clone, Debug, PartialEq)]
struct Step {
    rect: [f64; 4],
    quad: [[f64; 2]; 4],
    pivot: [f64; 2],
    warp: Option<Warp>,
}

impl Step {
    fn of(t: &TransformSession) -> Self {
        Step { rect: t.rect, quad: t.quad, pivot: t.pivot, warp: t.warp.clone() }
    }

    fn restore(self, t: &mut TransformSession) {
        (t.rect, t.quad, t.pivot, t.warp) = (self.rect, self.quad, self.pivot, self.warp);
    }
}

/// The session's own history: inside Free Transform, Undo steps back through the
/// handle drags, nudges and option edits rather than the document's history.
#[derive(Default)]
struct Steps {
    /// The box when it last came to rest (set when the session starts).
    settled: Option<Step>,
    undo: Vec<Step>,
    redo: Vec<Step>,
}

impl Steps {
    /// Record a step if the box changed since it last came to rest.
    fn settle(&mut self, now: Step) {
        if self.settled.as_ref() == Some(&now) {
            return;
        }
        if let Some(prev) = self.settled.replace(now) {
            self.undo.push(prev);
            self.redo.clear();
        }
    }

    /// Something to undo, counting a change not yet recorded (a nudge this frame).
    fn can_undo(&self, now: &Step) -> bool {
        !self.undo.is_empty() || self.settled.as_ref().is_some_and(|p| p != now)
    }
}

fn corners(r: [f64; 4]) -> [[f64; 2]; 4] {
    [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]
}

/// Start Free Transform on the active layer (or its selected pixels), or on the targeted unlinked
/// layer mask, alpha channel or Quick Mask.
pub fn begin(app: &mut PhotosuiteApp, ctx: &egui::Context) -> Result<(), String> {
    let target = crate::canvas::paint_target(app);
    let st = app.session.active().ok_or("no document")?;
    let doc = st.doc.clone();
    let lone = photosuite_engine::transform_cmds::lone_target(&doc, st.active_layer, &json!({ "target": target })).map_err(|e| e.to_string())?.cloned();
    if let Some(surf) = lone {
        return begin_lone(app, ctx, doc, surf, target);
    }
    let id = st.active_layer.ok_or("no active layer")?;
    let layer = doc.layer(id).ok_or("no layer")?;
    if matches!(layer.content, LayerContent::Adjustment(_)) && layer.mask.is_none() {
        return Err("Adjustment layers have nothing to transform".into());
    }
    let b = photosuite_engine::transform_cmds::transform_bounds(&doc, layer);
    if b.is_empty() {
        return Err("Could not transform: the layer is empty".into());
    }
    crate::type_tool::commit(app);
    let rect = [b.x0 as f64, b.y0 as f64, b.x1 as f64, b.y1 as f64];
    let session = app.ui.alloc_id();
    // Preview document: the moving pixels removed (layer hidden, or the selection lifted out).
    let mut pd = (*doc).clone();
    let mut lifted = None;
    if let Some(sel) = doc.selection.clone().filter(|_| !layer.is_group() && layer.surface().is_some()) {
        if let Some(surf) = pd.layer_mut(id).and_then(|l| l.surface_mut()) {
            let (l, rest) = photosuite_engine::transform_cmds::split_selected(surf, &sel);
            *surf = rest;
            lifted = Some(l);
        }
    } else if let Some(l) = pd.layer_mut(id) {
        l.visible = false;
    }
    // egui reports the renderer's limit in the app; offscreen harnesses only through the device.
    let max_side = ctx.input(|i| i.max_texture_side).max(app.gpu.as_ref().map_or(1, |g| g.max_texture_side()));
    let (image, uv) = preview_image(&doc, id, lifted.as_ref(), b, max_side);
    let texture = crate::transform_tex::PreviewTextures::new(ctx, format!("transform-{session}"), image, uv);
    app.transform_preview = Some(TransformPreview {
        session,
        doc: Arc::new(pd),
        texture,
        opacity: layer.opacity * layer.fill_opacity,
        gesture: None,
        warp_drag: None,
        split_tool: None,
        split_pointer: None,
        split_placing: false,
        split_quick: false,
        steps: Steps::default(),
        tool: app.ui.tool,
    });
    app.ui.transform = Some(TransformSession {
        session,
        layer: id.0,
        rect,
        quad: corners(rect),
        pivot: [(rect[0] + rect[2]) / 2.0, (rect[1] + rect[3]) / 2.0],
        interpolation: "bicubic".into(),
        warp: None,
        selection: false,
        target: None,
        made: None,
        mode: Default::default(),
    });
    start_steps(app);
    Ok(())
}

/// Free Transform on a copy (⌥⌘T, no menu item): duplicates the active layer (with a selection,
/// its selected pixels, as Layer via Copy) and transforms the copy (#352).
pub fn begin_copy(app: &mut PhotosuiteApp, ctx: &egui::Context) -> Result<(), String> {
    let selection = app.session.active().is_some_and(|d| d.doc.selection.is_some());
    app.run(if selection { "layer.new.layerViaCopy" } else { "layer.duplicate" }, json!({}))?;
    if let Err(e) = begin(app, ctx) {
        take_back_made(app);
        return Err(e);
    }
    if let Some(t) = app.ui.transform.as_mut() {
        t.made = Some(MadeLayer::Copy);
    }
    Ok(())
}

/// Free Transform on the layer a file dropped on the canvas just placed, like the reference app's
/// Place: Esc takes the place back, ↩ makes the place and the transform one Place Embedded step.
pub fn begin_placed(app: &mut PhotosuiteApp, ctx: &egui::Context) -> Result<(), String> {
    begin(app, ctx)?;
    if let Some(t) = app.ui.transform.as_mut() {
        t.made = Some(MadeLayer::Place);
    }
    Ok(())
}

/// Undoes the layer a cancelled or failed session made (⌥⌘T's copy, a placed file), leaving
/// nothing to redo.
fn take_back_made(app: &mut PhotosuiteApp) {
    app.session.undo();
    if let Some(st) = app.session.active_mut() {
        st.history.clear_redo();
    }
    app.sync_views();
}

/// After the transform: the step that made the layer and the transform become one history step,
/// the transform's for a copy and Place Embedded for a placed file.
fn fold_made(app: &mut PhotosuiteApp, made: MadeLayer) {
    if let Some(st) = app.session.active_mut() {
        st.history.purge_last();
        if made == MadeLayer::Place {
            st.history.set_current_label(photosuite_engine::file_cmds::PLACE_EMBEDDED);
        }
    }
}

/// Free Transform of a targeted unlinked layer mask, alpha channel or Quick Mask by itself: the
/// box frames its content (within the selection) and previews the moving values in grey over the
/// document with them vacated.
fn begin_lone(
    app: &mut PhotosuiteApp,
    ctx: &egui::Context,
    doc: Arc<Document>,
    surf: photosuite_raster::Surface,
    target: serde_json::Value,
) -> Result<(), String> {
    use photosuite_engine::transform_cmds as tc;
    let b = tc::target_bounds(&doc, &surf);
    if b.is_empty() {
        return Err("Could not transform: nothing is selected".into());
    }
    let whole;
    let sel = match &doc.selection {
        Some(s) => s,
        None => {
            let mut s = photosuite_raster::Surface::new(photosuite_color::PixelFormat::GRAY8);
            s.fill_rect(b, &[1.0]);
            whole = s;
            &whole
        }
    };
    let (lifted, rest) = tc::split_gray_selected(&surf, sel).ok_or("this channel can't be transformed")?;
    crate::type_tool::commit(app);
    let layer = app.session.active().and_then(|st| st.active_layer).map_or(0, |l| l.0);
    let mut pd = (*doc).clone();
    let tp = json!({ "target": target });
    if let Ok(Some(s)) = tc::lone_target_mut(&mut pd, Some(LayerId(layer)), &tp) {
        *s = rest;
    }
    let rect = [b.x0 as f64, b.y0 as f64, b.x1 as f64, b.y1 as f64];
    let session = app.ui.alloc_id();
    let max_side = ctx.input(|i| i.max_texture_side).max(app.gpu.as_ref().map_or(1, |g| g.max_texture_side()));
    let (image, uv) = crate::transform_tex::read_surface(&lifted, None, b, max_side);
    let texture = crate::transform_tex::PreviewTextures::new(ctx, format!("transform-{session}"), image, uv);
    app.transform_preview = Some(TransformPreview {
        session,
        doc: Arc::new(pd),
        texture,
        opacity: 0.6,
        gesture: None,
        warp_drag: None,
        split_tool: None,
        split_pointer: None,
        split_placing: false,
        split_quick: false,
        steps: Steps::default(),
        tool: app.ui.tool,
    });
    app.ui.transform = Some(TransformSession {
        session,
        layer,
        rect,
        quad: corners(rect),
        pivot: [(rect[0] + rect[2]) / 2.0, (rect[1] + rect[3]) / 2.0],
        interpolation: "bicubic".into(),
        warp: None,
        selection: false,
        target: Some(target),
        made: None,
        mode: Default::default(),
    });
    start_steps(app);
    Ok(())
}

/// Start Select › Transform Selection: the same box over the selection's bounds, previewing the
/// selection mask (the marching ants are hidden meanwhile); commits `select.transformSelection`.
pub fn begin_selection(app: &mut PhotosuiteApp, ctx: &egui::Context) -> Result<(), String> {
    let st = app.session.active().ok_or("no document")?;
    let doc = st.doc.clone();
    let sel = doc.selection.clone().ok_or("no selection")?;
    let b = sel.content_bounds();
    if b.is_empty() {
        return Err("no selection".into());
    }
    let layer = st.active_layer.or_else(|| doc.layers.first().map(|l| l.id)).ok_or("no layer")?;
    crate::type_tool::commit(app);
    let rect = [b.x0 as f64, b.y0 as f64, b.x1 as f64, b.y1 as f64];
    let session = app.ui.alloc_id();
    let (w, h) = (b.width() as usize, b.height() as usize);
    let k = w.max(h).div_ceil(2048).max(1);
    let (tw, th) = (w.div_ceil(k), h.div_ceil(k));
    let mut px = vec![Color32::TRANSPARENT; tw * th];
    for ty in 0..th {
        for tx in 0..tw {
            let m = sel.sample_channel(b.x0 + (tx * k) as i32, b.y0 + (ty * k) as i32, 0).clamp(0.0, 1.0);
            px[ty * tw + tx] = Color32::from_rgba_unmultiplied(120, 170, 255, (m * 110.0) as u8);
        }
    }
    let uv = [w as f32 / (tw * k) as f32, h as f32 / (th * k) as f32];
    let texture = crate::transform_tex::PreviewTextures::new(ctx, format!("transform-{session}"), egui::ColorImage::new([tw, th], px), uv);
    let mut pd = (*doc).clone();
    pd.selection = None;
    app.transform_preview = Some(TransformPreview {
        session,
        doc: Arc::new(pd),
        texture,
        opacity: 1.0,
        gesture: None,
        warp_drag: None,
        split_tool: None,
        split_pointer: None,
        split_placing: false,
        split_quick: false,
        steps: Steps::default(),
        tool: app.ui.tool,
    });
    app.ui.transform = Some(TransformSession {
        session,
        layer: layer.0,
        rect,
        quad: corners(rect),
        pivot: [(rect[0] + rect[2]) / 2.0, (rect[1] + rect[3]) / 2.0],
        interpolation: "bilinear".into(),
        warp: None,
        selection: true,
        target: None,
        made: None,
        mode: Default::default(),
    });
    start_steps(app);
    Ok(())
}

/// Start (or switch an active Free Transform into) Warp mode.
pub fn begin_warp(app: &mut PhotosuiteApp, ctx: &egui::Context) -> Result<(), String> {
    let fresh = app.ui.transform.is_none();
    if fresh {
        begin(app, ctx)?;
    }
    enter_warp(app);
    // Started in Warp: that is where Undo stops. Switching an open transform to Warp is a step.
    if fresh {
        start_steps(app);
    }
    Ok(())
}

/// Switch to Warp mode: a smart object's existing warp (when the box is untouched), else a
/// custom mesh following the current box (so a transform made first carries over).
pub fn enter_warp(app: &mut PhotosuiteApp) {
    let existing =
        app.session.active().and_then(|d| d.doc.layer(LayerId(app.ui.transform.as_ref()?.layer)).and_then(photosuite_engine::warp_cmds::smart_warp_doc_space));
    let Some(t) = app.ui.transform.as_mut() else { return };
    // Warp moves layers only: a lone mask or channel keeps the box.
    if t.warp.is_some() || t.target.is_some() {
        return;
    }
    if t.quad == corners(t.rect)
        && !t.selection
        && let Some(w) = existing
    {
        t.rect = w.bounds;
        t.quad = corners(w.bounds);
        t.warp = Some(w);
        return;
    }
    let h = Homography::rect_to_quad(t.rect, t.quad).unwrap_or(Homography::IDENTITY);
    let mesh = BezierMesh::identity(t.rect, 1, 1).map_points(|p| {
        let (x, y) = h.apply(p[0], p[1]);
        [x, y]
    });
    t.warp = Some(Warp::custom(mesh, t.rect));
}

/// Leave Warp mode (back to the box; warp edits are dropped, like Photoshop's mode toggle on an
/// untouched warp).
pub fn leave_warp(app: &mut PhotosuiteApp) {
    if let Some(t) = app.ui.transform.as_mut() {
        t.warp = None;
    }
    if let Some(pv) = app.transform_preview.as_mut() {
        pv.split_tool = None;
        pv.split_pointer = None;
        pv.split_placing = false;
        pv.split_quick = false;
    }
}

/// Texels of the moving pixels over `b`: full resolution unless the long side exceeds the GPU's
/// `max_side` (#91: this used to be capped at 2048 px, so big layers previewed blurry), plus the
/// uv extent covering `b`.
fn preview_image(
    doc: &Document,
    id: LayerId,
    lifted: Option<&photosuite_raster::Surface>,
    b: photosuite_geom::Rect,
    max_side: usize,
) -> (egui::ColorImage, [f32; 2]) {
    let layer = doc.layer(id);
    // Linked masks move with the pixels, so the moving texels carry them (#205).
    let mask = layer.and_then(|l| preview_mask(l, b));
    // Groups and type/fill layers preview from a flattened render of just that layer.
    let rendered;
    let surf: Option<&photosuite_raster::Surface> = match (lifted, layer.and_then(|l| l.surface())) {
        (Some(s), _) => Some(s),
        (None, Some(s)) if layer.is_some_and(|l| matches!(l.content, LayerContent::Raster(_))) => Some(s),
        _ => {
            let mut solo = doc.clone();
            for l in solo.layers.iter_mut() {
                if l.id != id && doc.layer(id).is_some_and(|_| !contains(l, id)) {
                    l.visible = false;
                }
            }
            let buf = photosuite_compose::render(&solo, b);
            let mut s = photosuite_raster::Surface::new(photosuite_color::PixelFormat::RGBA8);
            let flat: Vec<f32> = buf.px.iter().flat_map(|p| *p).collect();
            s.write_region(b, &flat);
            rendered = s;
            Some(&rendered)
        }
    };
    let Some(surf) = surf else { return (egui::ColorImage::new([1, 1], vec![Color32::TRANSPARENT]), [1.0, 1.0]) };
    // A flattened render already has the masks applied.
    let raw = lifted.is_some() || layer.is_some_and(|l| matches!(l.content, LayerContent::Raster(_)));
    crate::transform_tex::read_surface(surf, mask.as_ref().filter(|_| raw), b, max_side)
}

/// The layer's masks as the moving texels carry them: the enabled masks when all of them are linked
/// (the vector mask and feathering folded in as the compositor applies them), else the linked
/// pixel mask alone. `None` when no enabled mask moves with the pixels.
fn preview_mask(l: &photosuite_doc::Layer, b: photosuite_geom::Rect) -> Option<crate::transform_tex::PreviewMask> {
    use crate::transform_tex::PreviewMask;
    let pixel = l.mask.as_ref().filter(|m| m.enabled);
    let vector = l.vector_mask.as_ref().filter(|v| v.enabled);
    let linked_pixel = pixel.filter(|m| m.linked);
    if pixel.is_none_or(|m| m.linked)
        && vector.is_some_and(|v| v.linked)
        && let Some(surface) = photosuite_compose::masks::combined_mask(l, b)
    {
        return Some(PreviewMask { surface, density: 1.0 });
    }
    linked_pixel.map(|m| PreviewMask { surface: m.surface.clone(), density: m.density })
}

fn contains(l: &photosuite_doc::Layer, id: LayerId) -> bool {
    l.id == id || matches!(&l.content, LayerContent::Group(g) if g.children.iter().any(|c| contains(c, id)))
}

pub fn commit(app: &mut PhotosuiteApp) {
    let Some(t) = app.ui.transform.take() else { return };
    app.transform_preview = None;
    if t.selection {
        let mut p = json!({"rect": t.rect, "interpolation": t.interpolation});
        match &t.warp {
            Some(w) if !w.is_identity() => p["warp"] = json!(w),
            Some(_) => return,
            None if t.quad == corners(t.rect) => return,
            None => p["quad"] = json!(t.quad),
        }
        if let Err(e) = app.run("select.transformSelection", p) {
            app.ui.status = e;
        }
        return;
    }
    let made = t.made;
    let r = if let Some(w) = &t.warp {
        if w.is_identity() {
            return;
        }
        app.run("edit.transform.warp", json!({"layer": t.layer, "rect": t.rect, "warp": w, "interpolation": t.interpolation}))
    } else {
        if t.quad == corners(t.rect) {
            return; // untouched: nothing to do and no history step; a ⌥⌘T copy or a place stays
        }
        let mut p = json!({"layer": t.layer, "rect": t.rect, "quad": t.quad, "interpolation": t.interpolation});
        if let Some(target) = t.target {
            p["target"] = target;
        }
        app.run("edit.transform", p)
    };
    match r {
        Ok(_) => {
            if let Some(made) = made {
                fold_made(app, made);
            }
        }
        Err(e) => {
            if made.is_some() {
                take_back_made(app);
            }
            app.ui.status = e;
        }
    }
}

/// A transform whose layer or document went away (undo, close) ends silently; picking another tool
/// applies it. Checked every frame and before each pointer event, so a press with a tool chosen
/// just before it (`ui.pointer`'s `tool`) goes to that tool.
pub fn end_if_left(app: &mut PhotosuiteApp) {
    let Some(t) = &app.ui.transform else { return };
    if app.session.active().and_then(|s| s.doc.layer(LayerId(t.layer))).is_none() {
        cancel(app);
    } else if app.transform_preview.as_ref().is_some_and(|pv| pv.tool != app.ui.tool) {
        commit(app);
    }
}

pub fn cancel(app: &mut PhotosuiteApp) {
    let made = app.ui.transform.take().is_some_and(|t| t.made.is_some());
    app.transform_preview = None;
    if made {
        take_back_made(app);
    }
}

/// The session's starting box: where Undo stops.
fn start_steps(app: &mut PhotosuiteApp) {
    if let (Some(t), Some(pv)) = (&app.ui.transform, app.transform_preview.as_mut()) {
        pv.steps = Steps { settled: Some(Step::of(t)), ..Steps::default() };
    }
}

/// Record the box as an undo step whenever it comes to rest in a new state: once per drag (on
/// release), nudge or option edit (once typing in its field ends). Call once per frame.
pub fn track_steps(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let (Some(t), Some(pv)) = (&app.ui.transform, app.transform_preview.as_mut()) else { return };
    if pv.gesture.is_some() || pv.warp_drag.is_some() || ctx.input(|i| i.pointer.any_down()) || ctx.text_edit_focused() {
        return;
    }
    pv.steps.settle(Step::of(t));
}

/// While transforming, Undo and Redo apply to the box: `Some(enabled)` for those commands (and
/// Toggle Last State, which would change the document under the box), `None` for the rest.
pub fn is_enabled(app: &PhotosuiteApp, id: &str) -> Option<bool> {
    let t = app.ui.transform.as_ref()?;
    let steps = app.transform_preview.as_ref().map(|pv| &pv.steps);
    match id {
        "edit.undo" => Some(steps.is_some_and(|s| s.can_undo(&Step::of(t)))),
        "edit.redo" => Some(steps.is_some_and(|s| !s.redo.is_empty())),
        "edit.toggleLastState" => Some(false),
        _ => None,
    }
}

/// While transforming, the box owns the history for every caller (menus, shortcuts, the control
/// channel, MCP): Undo and Redo step through it, and Toggle Last State, which would change the
/// document under the box, is refused. `None` for other commands or when not transforming.
pub fn intercept(app: &mut PhotosuiteApp, id: &str) -> Option<Result<serde_json::Value, String>> {
    app.ui.transform.as_ref()?;
    match id {
        "edit.undo" => Some(Ok(step(app, false))),
        "edit.redo" => Some(Ok(step(app, true))),
        "edit.toggleLastState" => Some(Err("Commit or cancel the transform first".into())),
        _ => None,
    }
}

/// Undo (or redo) one step of the open session; nothing mid-drag or with no step to take.
fn step(app: &mut PhotosuiteApp, redo: bool) -> serde_json::Value {
    let Some(t) = app.ui.transform.as_mut() else { return serde_json::Value::Null };
    let Some(pv) = app.transform_preview.as_mut().filter(|pv| pv.gesture.is_none() && pv.warp_drag.is_none()) else {
        return serde_json::Value::Null;
    };
    let s = &mut pv.steps;
    s.settle(Step::of(t));
    let (from, to) = if redo { (&mut s.redo, &mut s.undo) } else { (&mut s.undo, &mut s.redo) };
    let Some(step) = from.pop() else { return serde_json::Value::Null };
    to.push(Step::of(t));
    s.settled = Some(step.clone());
    step.restore(t);
    json!({"transform": t})
}

/// Which part of the box a document point hits.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Hit {
    Corner(usize),
    Edge(usize),
    Pivot,
    Inside,
    Outside,
}

/// The nearest handle within `tol` (on a small box their grab areas overlap), else inside or
/// outside the box.
fn hit(t: &TransformSession, p: [f64; 2], tol: f64) -> Hit {
    let d = |a: [f64; 2]| ((a[0] - p[0]).powi(2) + (a[1] - p[1]).powi(2)).sqrt();
    let mid = |i: usize| {
        let (a, b) = (t.quad[i], t.quad[(i + 1) % 4]);
        [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]
    };
    let handles = (0..4).map(|i| (t.quad[i], Hit::Corner(i))).chain((0..4).map(|i| (mid(i), Hit::Edge(i)))).chain([(t.pivot, Hit::Pivot)]);
    let nearest = handles.map(|(q, h)| (d(q), h)).filter(|(dist, _)| *dist < tol).min_by(|a, b| a.0.total_cmp(&b.0));
    match nearest {
        Some((_, h)) => h,
        None if inside(&t.quad, p) => Hit::Inside,
        None => Hit::Outside,
    }
}

fn inside(q: &[[f64; 2]; 4], p: [f64; 2]) -> bool {
    let mut c = false;
    for i in 0..4 {
        let (a, b) = (q[i], q[(i + 3) % 4]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
    }
    c
}

/// Transient drag state (kept in egui memory; not part of the serialised session).
#[derive(Clone, Copy, Debug)]
struct Gesture {
    hit: Hit,
    start: [f64; 2],
    quad0: [[f64; 2]; 4],
    pivot0: [f64; 2],
}

/// Pointer input while transforming. Returns false when no transform is active.
pub fn pointer(app: &mut PhotosuiteApp, ev: ToolEvent, mods: egui::Modifiers) -> bool {
    let Some(t) = app.ui.transform.clone() else { return false };
    let tol = handle_tolerance(app);
    if t.warp.is_some() {
        warp_pointer(app, ev, tol, mods);
        return true;
    }
    let Some(pv) = app.transform_preview.as_mut() else { return false };
    match ev {
        ToolEvent::Down { x, y, .. } => {
            let mut h = hit(&t, [x, y], tol);
            // ⌥-click away from the handles moves the reference point there (and drags it).
            if mods.alt
                && matches!(h, Hit::Inside | Hit::Outside)
                && let Some(s) = app.ui.transform.as_mut()
            {
                s.pivot = [x, y];
                h = Hit::Pivot;
            }
            // Distort only moves corners (and the whole box from inside): no rotating, no edges.
            pv.gesture = distort_allows(t.mode, h).then_some(Gesture { hit: h, start: [x, y], quad0: t.quad, pivot0: t.pivot });
        }
        ToolEvent::Move { x, y, .. } | ToolEvent::Up { x, y } => {
            let g = pv.gesture;
            if matches!(ev, ToolEvent::Up { .. }) {
                pv.gesture = None;
            }
            let legacy = app.session.prefs().general.use_legacy_free_transform;
            if let (Some(g), Some(s)) = (g, app.ui.transform.as_mut()) {
                apply_drag(s, g, [x, y], mode_mods(t.mode, g.hit, corner_mods(legacy, g.hit, mods)));
            }
        }
    }
    true
}

/// Preferences › General › Use Legacy Free Transform: corner drags stretch freely and ⇧ keeps
/// the proportions, the reverse of the default (proportional, ⇧ frees them).
fn corner_mods(legacy: bool, hit: Hit, mut mods: egui::Modifiers) -> egui::Modifiers {
    if legacy && matches!(hit, Hit::Corner(_)) && !mods.command {
        mods.shift = !mods.shift;
    }
    mods
}

/// Skew / Distort / Perspective modes: a handle drag acts as if that gesture's keys were held
/// (⌘-drag an edge skews, ⌘-drag a corner distorts, ⌘⌥⇧-drag a corner adds perspective).
fn mode_mods(mode: TransformMode, hit: Hit, mut mods: egui::Modifiers) -> egui::Modifiers {
    match (mode, hit) {
        (TransformMode::Skew, Hit::Edge(_)) | (TransformMode::Distort, Hit::Corner(_)) => mods.command = true,
        (TransformMode::Perspective, Hit::Corner(_)) => {
            mods.command = true;
            mods.alt = true;
            mods.shift = true;
        }
        _ => {}
    }
    mods
}

/// In Distort mode only corner drags (and moving the box from inside) do anything.
fn distort_allows(mode: TransformMode, h: Hit) -> bool {
    mode != TransformMode::Distort || !matches!(h, Hit::Outside | Hit::Edge(_))
}

fn apply_drag(s: &mut TransformSession, g: Gesture, p: [f64; 2], mods: egui::Modifiers) {
    let (dx, dy) = (p[0] - g.start[0], p[1] - g.start[1]);
    match g.hit {
        Hit::Inside => {
            // ⇧ locks the move to the axes and diagonals; the current offset keeps the lock stable.
            let (dx, dy) = if mods.shift {
                let prev = [s.quad[0][0] - g.quad0[0][0], s.quad[0][1] - g.quad0[0][1]];
                let d = crate::move_mods::constrain([dx, dy], Some(prev), crate::move_mods::TRANSFORM_DIRECTIONS);
                (d[0], d[1])
            } else {
                (dx, dy)
            };
            s.quad = g.quad0.map(|q| [q[0] + dx, q[1] + dy]);
            s.pivot = [g.pivot0[0] + dx, g.pivot0[1] + dy];
        }
        Hit::Pivot => s.pivot = p,
        Hit::Outside => {
            let a0 = (g.start[1] - g.pivot0[1]).atan2(g.start[0] - g.pivot0[0]);
            let a1 = (p[1] - g.pivot0[1]).atan2(p[0] - g.pivot0[0]);
            let mut da = a1 - a0;
            if mods.shift {
                // Snap the resulting angle to 15° steps.
                let base = (g.quad0[1][1] - g.quad0[0][1]).atan2(g.quad0[1][0] - g.quad0[0][0]);
                let step = 15f64.to_radians();
                da = ((base + da) / step).round() * step - base;
            }
            let (sn, cs) = da.sin_cos();
            let c = g.pivot0;
            s.quad = g.quad0.map(|q| {
                let (x, y) = (q[0] - c[0], q[1] - c[1]);
                [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs]
            });
        }
        Hit::Corner(i) if mods.command && mods.alt && mods.shift => {
            // Perspective: the corner moves along the dominant axis and the corner sharing that
            // side moves the opposite way.
            s.quad = g.quad0;
            let horizontal = dx.abs() >= dy.abs();
            // Corners 0..3 = TL, TR, BR, BL: horizontal drags pair along the top/bottom edge,
            // vertical ones along the left/right edge.
            let j = match (i, horizontal) {
                (0, true) => 1,
                (1, true) => 0,
                (2, true) => 3,
                (3, true) => 2,
                (0, false) => 3,
                (3, false) => 0,
                (1, false) => 2,
                _ => 1,
            };
            let (mx, my) = if horizontal { (dx, 0.0) } else { (0.0, dy) };
            s.quad[i] = [g.quad0[i][0] + mx, g.quad0[i][1] + my];
            s.quad[j] = [g.quad0[j][0] - mx, g.quad0[j][1] - my];
        }
        Hit::Corner(i) if mods.command => {
            // Distort: move the corner freely.
            s.quad = g.quad0;
            s.quad[i] = [g.quad0[i][0] + dx, g.quad0[i][1] + dy];
        }
        Hit::Edge(i) if mods.command => {
            // Skew: the edge's two corners move together (⇧: only along the edge).
            let (a, b) = (i, (i + 1) % 4);
            let (mut mx, mut my) = (dx, dy);
            if mods.shift {
                let e = [g.quad0[b][0] - g.quad0[a][0], g.quad0[b][1] - g.quad0[a][1]];
                let l2 = e[0] * e[0] + e[1] * e[1];
                let t = if l2 > 0.0 { (dx * e[0] + dy * e[1]) / l2 } else { 0.0 };
                (mx, my) = (t * e[0], t * e[1]);
            }
            s.quad = g.quad0;
            s.quad[a] = [g.quad0[a][0] + mx, g.quad0[a][1] + my];
            s.quad[b] = [g.quad0[b][0] + mx, g.quad0[b][1] + my];
            if mods.alt {
                // ⌥: the opposite edge skews the other way (about the centre).
                let (c, d) = ((i + 2) % 4, (i + 3) % 4);
                s.quad[c] = [g.quad0[c][0] - mx, g.quad0[c][1] - my];
                s.quad[d] = [g.quad0[d][0] - mx, g.quad0[d][1] - my];
            }
        }
        Hit::Corner(_) | Hit::Edge(_) => {
            // Work in the box's own (unit) frame so rotated/skewed boxes scale along their axes.
            let Some(h) = Homography::rect_to_quad([0.0, 0.0, 1.0, 1.0], g.quad0) else { return };
            let Some(inv) = h.inverse() else { return };
            let (u, v) = inv.apply(p[0], p[1]);
            let (pu, pv) = inv.apply(g.pivot0[0], g.pivot0[1]);
            // Moving edges/corner in unit space: [u0, v0, u1, v1] starting as [0, 0, 1, 1].
            let mut r = [0.0f64, 0.0, 1.0, 1.0];
            let (mu, mv) = match g.hit {
                Hit::Corner(0) => ((true, false), (true, false)),
                Hit::Corner(1) => ((false, true), (true, false)),
                Hit::Corner(2) => ((false, true), (false, true)),
                Hit::Corner(3) => ((true, false), (false, true)),
                Hit::Edge(0) => ((false, false), (true, false)),
                Hit::Edge(1) => ((false, true), (false, false)),
                Hit::Edge(2) => ((false, false), (false, true)),
                _ => ((true, false), (false, false)),
            };
            if mu.0 {
                r[0] = u;
            }
            if mu.1 {
                r[2] = u;
            }
            if mv.0 {
                r[1] = v;
            }
            if mv.1 {
                r[3] = v;
            }
            // ⌥: symmetric about the reference point.
            if mods.alt {
                if mu.0 {
                    r[2] = 2.0 * pu - r[0];
                }
                if mu.1 {
                    r[0] = 2.0 * pu - r[2];
                }
                if mv.0 {
                    r[3] = 2.0 * pv - r[1];
                }
                if mv.1 {
                    r[1] = 2.0 * pv - r[3];
                }
            }
            // Corners scale proportionally by default; ⇧ frees them (the legacy preference swaps
            // the two, `corner_mods`).
            let corner = matches!(g.hit, Hit::Corner(_));
            if corner && !mods.shift {
                let (sx, sy) = (r[2] - r[0], r[3] - r[1]);
                let k = if sx.abs() > sy.abs() { sx.abs() } else { sy.abs() };
                let (nx, ny) = (k * sx.signum(), k * sy.signum());
                let (ax, ay) = if mods.alt { (pu, pv) } else { (if mu.0 { r[2] } else { r[0] }, if mv.0 { r[3] } else { r[1] }) };
                let fx = if mods.alt {
                    0.5
                } else if mu.0 {
                    1.0
                } else {
                    0.0
                };
                let fy = if mods.alt {
                    0.5
                } else if mv.0 {
                    1.0
                } else {
                    0.0
                };
                r[0] = ax - nx * fx;
                r[2] = r[0] + nx;
                r[1] = ay - ny * fy;
                r[3] = r[1] + ny;
            }
            let map = |a: f64, b: f64| {
                let (x, y) = h.apply(a, b);
                [x, y]
            };
            s.quad = [map(r[0], r[1]), map(r[2], r[1]), map(r[2], r[3]), map(r[0], r[3])];
            let (x, y) = h.apply(pu, pv);
            s.pivot = [x, y];
        }
    }
}

/// An anchor or a handle on a section line. The inner control points of a patch are not shown.
fn on_section_edge(i: usize, j: usize) -> bool {
    i.is_multiple_of(3) || j.is_multiple_of(3)
}

/// Index of the warp control point within `tol` of `p` (nearest anchor or handle).
fn warp_hit(w: &Warp, p: [f64; 2], tol: f64) -> Option<usize> {
    let m = w.mesh.as_ref()?;
    let nx = m.nx();
    m.points
        .iter()
        .enumerate()
        .filter(|(i, _)| on_section_edge(i % nx, i / nx))
        .map(|(i, q)| (i, ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt()))
        .filter(|(_, d)| *d < tol)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// A 1×1 mesh (Grid › Default) draws rule-of-thirds guides. Denser presets are real patch
/// boundaries only — a 3×3 is three cells, not a third-line lattice inside every cell.
fn single_patch(mesh: &BezierMesh) -> bool {
    mesh.us.len() == 2 && mesh.vs.len() == 2
}

/// Option-click picks the split: crosswise in the open, and the perpendicular split when the
/// pointer is close to an existing grid line.
fn quick_split_kind(mesh: &BezierMesh, bounds: [f64; 4], p: [f64; 2]) -> SplitTool {
    let (s, t) = mesh.param_at(p);
    let w = (bounds[2] - bounds[0]).abs().max(1.0);
    let h = (bounds[3] - bounds[1]).abs().max(1.0);
    let su = (8.0 / w).clamp(0.02, 0.12);
    let sv = (8.0 / h).clamp(0.02, 0.12);
    let thirds = single_patch(mesh);
    let near = |knots: &[f64], v: f64, tol: f64| {
        knots.iter().any(|k| *k > 0.0 && *k < 1.0 && (k - v).abs() < tol) || (thirds && [1.0 / 3.0, 2.0 / 3.0].iter().any(|k| (k - v).abs() < tol))
    };
    match (near(&mesh.us, s, su), near(&mesh.vs, t, sv)) {
        (true, false) => SplitTool::Horizontal,
        (false, true) => SplitTool::Vertical,
        _ => SplitTool::Cross,
    }
}

fn split_cursor(tool: SplitTool) -> CursorIcon {
    match tool {
        SplitTool::Vertical => CursorIcon::ResizeHorizontal,
        SplitTool::Horizontal => CursorIcon::ResizeVertical,
        SplitTool::Cross => CursorIcon::Crosshair,
    }
}

/// Armed split tool, or Option held: the guide tracks the pointer and the split lands on release.
/// Returns false when this event is an ordinary control-point drag.
fn split_gesture(app: &mut PhotosuiteApp, ev: ToolEvent, mods: egui::Modifiers) -> bool {
    let armed = app.transform_preview.as_ref().and_then(|p| p.split_tool);
    let placing = app.transform_preview.as_ref().is_some_and(|p| p.split_placing);
    match ev {
        ToolEvent::Down { x, y, .. } if armed.is_some() || mods.alt => {
            if let Some(pv) = app.transform_preview.as_mut() {
                pv.split_placing = true;
                pv.split_pointer = Some([x, y]);
                pv.split_quick = armed.is_none();
            }
            true
        }
        ToolEvent::Move { x, y, .. } if placing => {
            if let Some(pv) = app.transform_preview.as_mut() {
                pv.split_pointer = Some([x, y]);
            }
            true
        }
        ToolEvent::Up { x, y } if placing => {
            let quick = app.transform_preview.as_ref().is_some_and(|p| p.split_quick);
            if let Some(pv) = app.transform_preview.as_mut() {
                pv.split_placing = false;
                pv.split_pointer = None;
                pv.split_quick = false;
            }
            let kind = if let Some(tool) = armed {
                Some(tool)
            } else if quick {
                app.ui.transform.as_ref().and_then(|t| t.warp.as_ref()).map(|w| quick_split_kind(&w.to_mesh(1, 1), w.bounds, [x, y]))
            } else {
                None
            };
            if let Some(kind) = kind {
                // On an existing line, or a click the drag path also delivers, this is a no-op.
                let _ = split(app, kind.command(), Some([x, y]));
            }
            true
        }
        _ => false,
    }
}

/// Drags a warp control point. Anchors (patch corners) carry their handles along. Preset warps
/// turn into a custom mesh on the first drag. An armed split tool (or Option) places a split
/// where the pointer is released instead of moving a point.
fn warp_pointer(app: &mut PhotosuiteApp, ev: ToolEvent, tol: f64, mods: egui::Modifiers) {
    if split_gesture(app, ev, mods) {
        return;
    }
    let (Some(t), Some(pv)) = (app.ui.transform.as_mut(), app.transform_preview.as_mut()) else { return };
    let Some(w) = t.warp.as_mut() else { return };
    match ev {
        ToolEvent::Down { x, y, .. } => {
            // A preset warp becomes a custom mesh only when the press grabs one of its points.
            let custom = if w.mesh.is_none() || w.style != WarpStyle::Custom { Warp::custom(w.to_mesh(1, 1), w.bounds) } else { w.clone() };
            pv.warp_drag = warp_hit(&custom, [x, y], tol).map(|i| (i, [x, y], custom.mesh.as_ref().map(|m| m.points.clone()).unwrap_or_default()));
            if pv.warp_drag.is_some() {
                *w = custom;
            }
        }
        ToolEvent::Move { x, y, .. } | ToolEvent::Up { x, y } => {
            if let (Some((i, start, pts0)), Some(m)) = (&pv.warp_drag, w.mesh.as_mut()) {
                let (dx, dy) = (x - start[0], y - start[1]);
                let nx = m.nx();
                let (ci, cj) = (i % nx, i / nx);
                let ny = m.ny();
                let mut moved = vec![*i];
                if ci % 3 == 0 && cj % 3 == 0 {
                    for (di, dj) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                        let (a, b) = (ci as i64 + di, cj as i64 + dj);
                        if a >= 0 && b >= 0 && (a as usize) < nx && (b as usize) < ny {
                            moved.push(b as usize * nx + a as usize);
                        }
                    }
                }
                for k in moved {
                    m.points[k] = [pts0[k][0] + dx, pts0[k][1] + dy];
                }
            }
            if matches!(ev, ToolEvent::Up { .. }) {
                pv.warp_drag = None;
            }
        }
    }
}

/// Runs a warp-edit command against the mesh in the open Warp session and writes the mesh back.
pub fn edit_session_warp(app: &mut PhotosuiteApp, id: &str, params: &serde_json::Value) -> Result<(), String> {
    let Some(w) = app.ui.transform.as_ref().and_then(|t| t.warp.clone()) else { return Err("not warping".into()) };
    let mut p = if params.is_object() { params.clone() } else { json!({}) };
    if p.get("warp").is_none() {
        p["warp"] = serde_json::to_value(&w).map_err(|e| e.to_string())?;
    }
    let r = app.session.execute(id, p).map_err(|e| e.to_string())?;
    let raw = r.get("warp").cloned().ok_or_else(|| "warp command returned no mesh".to_string())?;
    let nw: Warp = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    // A warp-edit command can replace the mesh while pointer input is split across control
    // requests. Any drag index captured from the old mesh is invalid once that happens.
    if let Some(pv) = app.transform_preview.as_mut() {
        pv.warp_drag = None;
    }
    if let Some(t) = app.ui.transform.as_mut() {
        t.warp = Some(nw);
    }
    Ok(())
}

/// Applies a split-warp command to the mesh being edited (at the box centre unless `at`).
pub fn split(app: &mut PhotosuiteApp, id: &str, at: Option<[f64; 2]>) -> Result<(), String> {
    let mut p = json!({});
    if let Some(a) = at {
        p["at"] = json!(a);
    }
    edit_session_warp(app, id, &p)
}

/// Cursor for hovering a document point while transforming. `alt` is Option, which arms a quick
/// split while a warp is active.
pub fn cursor(app: &PhotosuiteApp, p: [f64; 2], alt: bool) -> Option<CursorIcon> {
    let t = app.ui.transform.as_ref()?;
    let tol = handle_tolerance(app);
    if let Some(w) = &t.warp {
        if let Some(tool) = app.transform_preview.as_ref().and_then(|pv| pv.split_tool) {
            return Some(split_cursor(tool));
        }
        if alt {
            return Some(split_cursor(quick_split_kind(&w.to_mesh(1, 1), w.bounds, p)));
        }
        return Some(if w.style != WarpStyle::Custom || warp_hit(w, p, tol).is_some() { CursorIcon::Crosshair } else { CursorIcon::Default });
    }
    let h = hit(t, p, tol);
    if !distort_allows(t.mode, h) {
        return Some(CursorIcon::Default);
    }
    Some(match h {
        Hit::Corner(0 | 2) => CursorIcon::ResizeNwSe,
        Hit::Corner(_) => CursorIcon::ResizeNeSw,
        Hit::Edge(0 | 2) => CursorIcon::ResizeVertical,
        Hit::Edge(_) => CursorIcon::ResizeHorizontal,
        Hit::Pivot => CursorIcon::Crosshair,
        Hit::Inside => CursorIcon::Move,
        Hit::Outside => CursorIcon::Alias,
    })
}

/// Warped preview of the moving pixels plus the box, handles and reference point.
pub fn draw_overlay(app: &PhotosuiteApp, painter: &egui::Painter, xf: &ViewXform) {
    let (Some(t), Some(pv)) = (&app.ui.transform, &app.transform_preview) else { return };
    let scr = |q: [f64; 2]| xf.to_screen(q[0] as f32, q[1] as f32);
    if let Some(w) = &t.warp {
        let over_canvas = painter.ctx().input(|i| i.pointer.hover_pos()).filter(|p| xf.rect.contains(*p)).map(|p| xf.to_doc(p));
        let at = pv.split_pointer.or(over_canvas);
        let alt = painter.ctx().input(|i| i.modifiers.alt);
        let guide = at.and_then(|p| {
            let tool = pv.split_tool.or_else(|| (alt || pv.split_quick).then(|| quick_split_kind(&w.to_mesh(1, 1), w.bounds, p)));
            tool.map(|tool| (tool, p))
        });
        draw_warp(painter, xf, t, w, pv, guide);
        return;
    }
    if let Some(h) = Homography::rect_to_quad([0.0, 0.0, 1.0, 1.0], t.quad) {
        // A 24×24 grid keeps perspective previews straight.
        let n = 24;
        let (tex, uv) = pv.texture.pick(painter.ctx(), xf.zoom * painter.ctx().pixels_per_point(), quad_scale(t), t.interpolation == "nearest");
        let mut mesh = egui::Mesh::with_texture(tex);
        let tint = Color32::from_white_alpha((pv.opacity.clamp(0.0, 1.0) * 255.0) as u8);
        for j in 0..=n {
            for i in 0..=n {
                let (u, v) = (i as f64 / n as f64, j as f64 / n as f64);
                let (x, y) = h.apply(u, v);
                mesh.vertices.push(egui::epaint::Vertex { pos: xf.to_screen(x as f32, y as f32), uv: pos2(u as f32 * uv[0], v as f32 * uv[1]), color: tint });
            }
        }
        for j in 0..n {
            for i in 0..n {
                let a = (j * (n + 1) + i) as u32;
                mesh.add_triangle(a, a + 1, a + n as u32 + 2);
                mesh.add_triangle(a, a + n as u32 + 2, a + n as u32 + 1);
            }
        }
        painter.add(mesh);
    }
    let accent = crate::theme::Tokens::get(painter.ctx()).accent;
    let pts: Vec<Pos2> = t.quad.iter().map(|q| scr(*q)).collect();
    painter.add(egui::Shape::closed_line(pts.clone(), Stroke::new(1.0, accent)));
    let mids: Vec<Pos2> = (0..4).map(|i| pts[i].lerp(pts[(i + 1) % 4], 0.5)).collect();
    for p in pts.iter().chain(mids.iter()) {
        let r = egui::Rect::from_center_size(*p, vec2(7.0, 7.0));
        painter.rect_filled(r, 0.0, Color32::WHITE);
        painter.rect_stroke(r, 0.0, Stroke::new(1.0, accent), egui::StrokeKind::Inside);
    }
    // Reference point (Photoshop's crosshair circle).
    let c = scr(t.pivot);
    painter.circle_stroke(c, 5.0, Stroke::new(1.0, Color32::WHITE));
    painter.circle_stroke(c, 5.0, Stroke::new(0.5, Color32::BLACK));
    painter.line_segment([c - vec2(8.0, 0.0), c + vec2(8.0, 0.0)], Stroke::new(1.0, Color32::WHITE));
    painter.line_segment([c - vec2(0.0, 8.0), c + vec2(0.0, 8.0)], Stroke::new(1.0, Color32::WHITE));
}

/// Warp preview (the moving pixels on a fine textured mesh) plus the control mesh. Patch
/// boundaries are solid. A single patch (Grid › Default) also draws its rule-of-thirds guides;
/// 3×3, 4×4 and 5×5 are just those even cells, with an anchor at every intersection. `guide` is
/// the split line following the pointer.
fn draw_warp(painter: &egui::Painter, xf: &ViewXform, t: &TransformSession, w: &Warp, pv: &TransformPreview, guide: Option<(SplitTool, [f64; 2])>) {
    let scr = |q: [f64; 2]| xf.to_screen(q[0] as f32, q[1] as f32);
    let r = t.rect;
    let n = 32;
    let (tex, uv) = pv.texture.pick(painter.ctx(), xf.zoom * painter.ctx().pixels_per_point(), 1.0, t.interpolation == "nearest");
    let mut mesh = egui::Mesh::with_texture(tex);
    let tint = Color32::from_white_alpha((pv.opacity.clamp(0.0, 1.0) * 255.0) as u8);
    for j in 0..=n {
        for i in 0..=n {
            let (u, v) = (i as f64 / n as f64, j as f64 / n as f64);
            let (x, y) = w.map(r[0] + u * (r[2] - r[0]), r[1] + v * (r[3] - r[1]));
            mesh.vertices.push(egui::epaint::Vertex { pos: xf.to_screen(x as f32, y as f32), uv: pos2(u as f32 * uv[0], v as f32 * uv[1]), color: tint });
        }
    }
    for j in 0..n {
        for i in 0..n {
            let a = (j * (n + 1) + i) as u32;
            mesh.add_triangle(a, a + 1, a + n as u32 + 2);
            mesh.add_triangle(a, a + n as u32 + 2, a + n as u32 + 1);
        }
    }
    painter.add(mesh);
    let accent = crate::theme::Tokens::get(painter.ctx()).accent;
    let line = Stroke::new(1.0, accent);
    let thin = Stroke::new(0.75, accent.gamma_multiply(0.7));
    let m = w.to_mesh(1, 1);
    let curve = |fixed_u: Option<f64>, fixed_v: Option<f64>| -> Vec<Pos2> {
        (0..=40)
            .map(|k| {
                let s = k as f64 / 40.0;
                let p = m.eval(fixed_u.unwrap_or(s), fixed_v.unwrap_or(s));
                scr(p)
            })
            .collect()
    };
    // Patch boundaries are the grid. Only Default (one patch) draws the rule-of-thirds guides;
    // a 3×3 preset is three even cells, not those guides repeated inside every cell.
    let thirds = single_patch(&m);
    for (k, win) in m.us.windows(2).enumerate() {
        if thirds {
            for third in [1.0, 2.0] {
                painter.add(egui::Shape::line(curve(Some(win[0] + (win[1] - win[0]) * third / 3.0), None), thin));
            }
        }
        if k == 0 {
            painter.add(egui::Shape::line(curve(Some(win[0]), None), line));
        }
        painter.add(egui::Shape::line(curve(Some(win[1]), None), line));
    }
    for (k, win) in m.vs.windows(2).enumerate() {
        if thirds {
            for third in [1.0, 2.0] {
                painter.add(egui::Shape::line(curve(None, Some(win[0] + (win[1] - win[0]) * third / 3.0)), thin));
            }
        }
        if k == 0 {
            painter.add(egui::Shape::line(curve(None, Some(win[0])), line));
        }
        painter.add(egui::Shape::line(curve(None, Some(win[1])), line));
    }
    if w.style == WarpStyle::Custom {
        let (nx, ny) = (m.nx(), m.ny());
        for j in 0..ny {
            for i in 0..nx {
                if !on_section_edge(i, j) {
                    continue;
                }
                let p = scr(m.point(i, j));
                let anchor = i.is_multiple_of(3) && j.is_multiple_of(3);
                if anchor {
                    let r = egui::Rect::from_center_size(p, vec2(7.0, 7.0));
                    painter.rect_filled(r, 0.0, Color32::WHITE);
                    painter.rect_stroke(r, 0.0, line, egui::StrokeKind::Inside);
                } else {
                    // Arm to the nearest anchor along the row/column.
                    let (ai, aj) = if i.is_multiple_of(3) { (i, if j % 3 == 1 { j - 1 } else { j + 1 }) } else { (if i % 3 == 1 { i - 1 } else { i + 1 }, j) };
                    painter.line_segment([scr(m.point(ai, aj)), p], line);
                    painter.circle_filled(p, 3.5, Color32::WHITE);
                    painter.circle_stroke(p, 3.5, line);
                }
            }
        }
    }
    if let Some((tool, p)) = guide {
        let (s, t) = m.param_at(p);
        let under = Stroke::new(3.0, Color32::BLACK);
        let over = Stroke::new(1.25, Color32::WHITE);
        let mut strokes = Vec::new();
        if matches!(tool, SplitTool::Vertical | SplitTool::Cross) {
            strokes.push(curve(Some(s), None));
        }
        if matches!(tool, SplitTool::Horizontal | SplitTool::Cross) {
            strokes.push(curve(None, Some(t)));
        }
        for pts in strokes {
            painter.add(egui::Shape::line(pts.clone(), under));
            painter.add(egui::Shape::line(pts, over));
        }
    }
}

/// How much the box enlarges its pixels: the longest edge relative to the original (picks the
/// preview's texture level and filter).
fn quad_scale(t: &TransformSession) -> f32 {
    let (w0, h0) = ((t.rect[2] - t.rect[0]).max(1e-9), (t.rect[3] - t.rect[1]).max(1e-9));
    let len = |a: [f64; 2], b: [f64; 2]| (b[0] - a[0]).hypot(b[1] - a[1]);
    let q = &t.quad;
    let s = (len(q[0], q[1]) / w0).max(len(q[3], q[2]) / w0).max(len(q[0], q[3]) / h0).max(len(q[1], q[2]) / h0);
    if s.is_finite() { s as f32 } else { 1.0 }
}

/// Scale (%), angle (°) and translation implied by the current quad (affine readout).
fn readout(t: &TransformSession) -> (f64, f64, f64, f64) {
    let (w0, h0) = (t.rect[2] - t.rect[0], t.rect[3] - t.rect[1]);
    let e = [t.quad[1][0] - t.quad[0][0], t.quad[1][1] - t.quad[0][1]];
    let f = [t.quad[3][0] - t.quad[0][0], t.quad[3][1] - t.quad[0][1]];
    let sx = (e[0].hypot(e[1]) / w0.max(1e-9)) * 100.0;
    let sy = (f[0].hypot(f[1]) / h0.max(1e-9)) * 100.0;
    (sx, sy, e[1].atan2(e[0]).to_degrees(), 0.0)
}

/// Width of the mode, cancel and commit cluster kept on the right of the options bar.
const ACTIONS_W: f32 = 140.0;

/// Options bar while transforming: reference point X/Y, W/H %, angle, interpolation, and, pinned
/// to the right, the warp switch, cancel and commit.
pub fn options_bar(app: &mut PhotosuiteApp, ui: &mut egui::Ui) {
    let Some(t) = app.ui.transform.clone() else { return };
    let bar = ui.available_rect_before_wrap();
    let split = (bar.right() - ACTIONS_W).max(bar.left());
    let fields = egui::Rect::from_min_max(bar.min, egui::pos2(split, bar.bottom()));
    let actions = egui::Rect::from_min_max(egui::pos2(split, bar.top()), bar.max);
    {
        let mut row =
            ui.new_child(egui::UiBuilder::new().id_salt("transform-fields").max_rect(fields).layout(egui::Layout::left_to_right(egui::Align::Center)));
        row.set_clip_rect(fields);
        if let Some(w) = t.warp.clone() {
            warp_fields(app, &mut row, &w);
        } else {
            transform_fields(app, &mut row, &t);
        }
    }
    let mut row = ui.new_child(egui::UiBuilder::new().id_salt("transform-actions").max_rect(actions).layout(egui::Layout::right_to_left(egui::Align::Center)));
    transform_actions(app, &mut row, t.warp.is_some());
}

fn transform_fields(app: &mut PhotosuiteApp, ui: &mut egui::Ui, t: &TransformSession) {
    let tk = crate::theme::Tokens::get(ui.ctx());
    let (sx, sy, angle, _) = readout(t);
    let lbl = |ui: &mut egui::Ui, s: &str| {
        ui.label(egui::RichText::new(s).color(tk.text_dim).size(12.0));
    };
    let mut px = t.pivot[0] as f32;
    let mut py = t.pivot[1] as f32;
    lbl(ui, "X:");
    let rx = crate::widgets::value_field(ui, &mut px, -30000.0..=30000.0, "px", 72.0);
    lbl(ui, "Y:");
    let ry = crate::widgets::value_field(ui, &mut py, -30000.0..=30000.0, "px", 72.0);
    if (rx.changed() || ry.changed())
        && let Some(s) = app.ui.transform.as_mut()
    {
        let (dx, dy) = (px as f64 - s.pivot[0], py as f64 - s.pivot[1]);
        s.quad = s.quad.map(|q| [q[0] + dx, q[1] + dy]);
        s.pivot = [px as f64, py as f64];
    }
    crate::widgets::vline(ui, 22.0);
    let (mut w, mut h) = (sx as f32, sy as f32);
    lbl(ui, "W:");
    let rw = crate::widgets::value_field(ui, &mut w, -10000.0..=10000.0, "%", 66.0);
    let link_id = egui::Id::new("transform-link");
    let mut link: bool = ui.data(|d| d.get_temp(link_id)).unwrap_or(true);
    if crate::icons::button(ui, if link { "link" } else { "unlink" }, 22.0, link, tl!("Maintain aspect ratio")).clicked() {
        link = !link;
        ui.data_mut(|d| d.insert_temp(link_id, link));
    }
    lbl(ui, "H:");
    let rh = crate::widgets::value_field(ui, &mut h, -10000.0..=10000.0, "%", 66.0);
    if rw.changed() || rh.changed() {
        let (kx, ky) = if link {
            let k = if rw.changed() { w as f64 / sx.max(1e-9) } else { h as f64 / sy.max(1e-9) };
            (k, k)
        } else {
            (w as f64 / sx.max(1e-9), h as f64 / sy.max(1e-9))
        };
        scale_about_pivot(app, kx, ky);
    }
    crate::widgets::vline(ui, 22.0);
    let mut a = angle as f32;
    let (r, resp) = ui.allocate_exact_size(vec2(18.0, 22.0), egui::Sense::hover());
    crate::icons::paint(ui, r, "rotate-cw", 13.0, tk.text_dim);
    resp.on_hover_text(tl!("Rotate"));
    if crate::widgets::value_field(ui, &mut a, -180.0..=180.0, "°", 60.0).changed() {
        rotate_about_pivot(app, (a as f64 - angle).to_radians());
    }
    crate::widgets::vline(ui, 22.0);
    lbl(ui, tl!("Interpolation:"));
    let mut interp = t.interpolation.clone();
    let opts = [("bicubic".to_string(), tl!("Bicubic")), ("bilinear".to_string(), tl!("Bilinear")), ("nearest".to_string(), tl!("Nearest Neighbor"))];
    if crate::widgets::dropdown(ui, "transform-interp", &mut interp, &opts, 130.0)
        && let Some(s) = app.ui.transform.as_mut()
    {
        s.interpolation = interp;
    }
}

/// Options bar fields in Warp mode: style, bend, the split icons and the grid menu.
fn warp_fields(app: &mut PhotosuiteApp, ui: &mut egui::Ui, w: &Warp) {
    let tk = crate::theme::Tokens::get(ui.ctx());
    let lbl = |ui: &mut egui::Ui, s: &str| {
        ui.label(egui::RichText::new(s).color(tk.text_dim).size(12.0));
    };
    lbl(ui, tl!("Warp:"));
    let mut style = w.style;
    let opts: Vec<(WarpStyle, &str)> = WarpStyle::all().map(|s| (s, s.label())).collect();
    if crate::widgets::dropdown(ui, "warp-style", &mut style, &opts, 120.0)
        && let Some(t) = app.ui.transform.as_mut()
    {
        let b = t.rect;
        t.warp = Some(match style {
            WarpStyle::Custom => Warp::custom(w.to_mesh(1, 1), b),
            WarpStyle::None => Warp::custom(BezierMesh::identity(b, 1, 1), b),
            s => Warp { style: s, bend: if w.style.is_preset() { w.bend } else { 50.0 }, ..Warp::none(b) },
        });
    }
    if w.style.is_preset() {
        let mut vertical = w.vertical;
        if crate::widgets::checkbox(ui, &mut vertical, tl!("Vertical")).changed()
            && let Some(Some(cur)) = app.ui.transform.as_mut().map(|t| t.warp.as_mut())
        {
            cur.vertical = vertical;
        }
        let fields: [(&str, f64); 3] = [(tl!("Bend:"), w.bend), ("H:", w.h_distort), ("V:", w.v_distort)];
        for (k, (name, v)) in fields.iter().enumerate() {
            lbl(ui, name);
            let mut f = *v as f32;
            if crate::widgets::value_field(ui, &mut f, -100.0..=100.0, "%", 58.0).changed()
                && let Some(Some(cur)) = app.ui.transform.as_mut().map(|t| t.warp.as_mut())
            {
                match k {
                    0 => cur.bend = f64::from(f),
                    1 => cur.h_distort = f64::from(f),
                    _ => cur.v_distort = f64::from(f),
                }
            }
        }
    } else {
        crate::widgets::vline(ui, 22.0);
        lbl(ui, tl!("Split:"));
        let armed = app.transform_preview.as_ref().and_then(|p| p.split_tool);
        for (tool, tip) in [
            (SplitTool::Cross, tl!("Split Warp Crosswise")),
            (SplitTool::Vertical, tl!("Split Warp Vertically")),
            (SplitTool::Horizontal, tl!("Split Warp Horizontally")),
        ] {
            let on = armed == Some(tool);
            if split_icon(ui, tool.icon(), tip, on).clicked()
                && let Some(pv) = app.transform_preview.as_mut()
            {
                pv.split_tool = if on { None } else { Some(tool) };
                pv.split_placing = false;
                pv.split_pointer = None;
                pv.split_quick = false;
            }
        }
        crate::widgets::vline(ui, 22.0);
        lbl(ui, tl!("Grid:"));
        let mesh = w.mesh.clone().unwrap_or_else(|| BezierMesh::identity(w.bounds, 1, 1));
        let mut grid = warp_grid_id(&mesh).to_string();
        let opts = [
            ("custom".to_string(), tl!("Custom")),
            ("default".to_string(), tl!("Default")),
            ("3".to_string(), tl!("3 x 3")),
            ("4".to_string(), tl!("4 x 4")),
            ("5".to_string(), tl!("5 x 5")),
        ];
        if crate::widgets::dropdown(ui, "warp-grid", &mut grid, &opts, 92.0)
            && let Some(n) = match grid.as_str() {
                "default" => Some(1),
                "3" => Some(3),
                "4" => Some(4),
                "5" => Some(5),
                _ => None,
            }
        {
            let _ = edit_session_warp(app, "edit.transform.warpGrid", &json!({ "size": n }));
        }
    }
}

/// Grid menu readout: Default is 1×1, the numbered entries are uniform n×n patches, and anything
/// split by hand reads as Custom.
fn warp_grid_id(mesh: &BezierMesh) -> &'static str {
    let cols = mesh.us.len().saturating_sub(1);
    let rows = mesh.vs.len().saturating_sub(1);
    let even = |k: &[f64]| {
        let n = k.len().saturating_sub(1);
        n > 0 && k.iter().enumerate().all(|(i, v)| (v - i as f64 / n as f64).abs() < 1e-4)
    };
    if cols == rows && even(&mesh.us) && even(&mesh.vs) {
        match cols {
            1 => "default",
            3 => "3",
            4 => "4",
            5 => "5",
            _ => "custom",
        }
    } else {
        "custom"
    }
}

/// One of the three Split icons. `on` is the armed tool: the line then follows the pointer.
fn split_icon(ui: &mut egui::Ui, kind: &str, tip: &str, on: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(vec2(22.0, 22.0), egui::Sense::click());
    let ink = crate::icons::button_chrome(ui, rect, on, resp.hovered());
    let c = rect.center();
    let stroke = Stroke::new(1.15, ink);
    let box_r = egui::Rect::from_center_size(c, vec2(13.0, 13.0));
    ui.painter().rect_stroke(box_r, 2.0, stroke, egui::StrokeKind::Inside);
    let h = 5.2;
    match kind {
        "vertical" => {
            ui.painter().line_segment([c - vec2(0.0, h), c + vec2(0.0, h)], stroke);
        }
        "horizontal" => {
            ui.painter().line_segment([c - vec2(h, 0.0), c + vec2(h, 0.0)], stroke);
        }
        _ => {
            ui.painter().line_segment([c - vec2(h, 0.0), c + vec2(h, 0.0)], stroke);
            ui.painter().line_segment([c - vec2(0.0, h), c + vec2(0.0, h)], stroke);
        }
    }
    if kind == "cross" {
        ui.painter().circle_filled(c, 1.5, ink);
    } else {
        ui.painter().circle_stroke(c, 2.1, stroke);
    }
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, tip));
    resp.on_hover_text(tip)
}

/// Warp switch, cancel and commit, kept on the right of the options bar.
fn transform_actions(app: &mut PhotosuiteApp, ui: &mut egui::Ui, warping: bool) {
    ui.add_space(8.0);
    let commit_tip = if warping {
        crate::i18n::fmt(tl!("Commit warp ({key})"), &[("key", &crate::shortcuts::pretty("Enter"))])
    } else {
        crate::i18n::fmt(tl!("Commit transform ({key})"), &[("key", &crate::shortcuts::pretty("Enter"))])
    };
    let commit_btn = crate::icons::button(ui, "check", 26.0, false, &commit_tip);
    commit_btn.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, "Commit transform"));
    if commit_btn.clicked() {
        commit(app);
    }
    let cancel_tip = if warping { tl!("Cancel warp (Esc)") } else { tl!("Cancel transform (Esc)") };
    let cancel_btn = crate::icons::button(ui, "ban", 26.0, false, cancel_tip);
    cancel_btn.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, "Cancel transform"));
    if cancel_btn.clicked() {
        cancel(app);
    }
    crate::widgets::vline(ui, 22.0);
    let mode = crate::icons::button(ui, "grid-3x3", 26.0, warping, tl!("Switch between free transform and warp modes"));
    mode.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, "Switch between free transform and warp modes"));
    if mode.clicked() {
        if warping {
            leave_warp(app);
        } else {
            enter_warp(app);
        }
    }
}

/// Scale the box along its own axes about the reference point.
fn scale_about_pivot(app: &mut PhotosuiteApp, kx: f64, ky: f64) {
    let Some(s) = app.ui.transform.as_mut() else { return };
    let Some(h) = Homography::rect_to_quad([0.0, 0.0, 1.0, 1.0], s.quad) else { return };
    let Some(inv) = h.inverse() else { return };
    let (pu, pv) = inv.apply(s.pivot[0], s.pivot[1]);
    let m = |u: f64, v: f64| {
        let (x, y) = h.apply(pu + (u - pu) * kx, pv + (v - pv) * ky);
        [x, y]
    };
    s.quad = [m(0.0, 0.0), m(1.0, 0.0), m(1.0, 1.0), m(0.0, 1.0)];
}

fn rotate_about_pivot(app: &mut PhotosuiteApp, da: f64) {
    let Some(s) = app.ui.transform.as_mut() else { return };
    let (sn, cs) = da.sin_cos();
    let c = s.pivot;
    s.quad = s.quad.map(|q| {
        let (x, y) = (q[0] - c[0], q[1] - c[1]);
        [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs]
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> TransformSession {
        TransformSession {
            session: 1,
            layer: 1,
            rect: [0.0, 0.0, 100.0, 50.0],
            quad: corners([0.0, 0.0, 100.0, 50.0]),
            pivot: [50.0, 25.0],
            interpolation: "bicubic".into(),
            warp: None,
            selection: false,
            target: None,
            made: None,
            mode: Default::default(),
        }
    }

    #[test]
    fn transform_bar_pins_warp_cancel_and_commit() {
        use egui_kittest::Harness;
        use egui_kittest::kittest::Queryable;
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.ui.transform = Some(session());
        let width = 720.0;
        let mut h = Harness::builder().with_size(vec2(width, 48.0)).build_ui_state(
            |ui, app: &mut PhotosuiteApp| {
                if !ui.ctx().fonts(|f| f.families().contains(&egui::FontFamily::Name("medium".into()))) {
                    return;
                }
                ui.horizontal_centered(|ui| options_bar(app, ui));
            },
            app,
        );
        PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::Anthracite);
        h.run_steps(6);
        let commit = h.get_by_label("Commit transform").rect();
        let cancel = h.get_by_label("Cancel transform").rect();
        let mode = h.get_by_label("Switch between free transform and warp modes").rect();
        assert!(commit.right() > width - 36.0, "commit sits on the right: {commit:?}");
        assert!(cancel.right() < commit.left() + 1.0, "cancel is left of commit");
        assert!(mode.right() < cancel.left() + 1.0, "warp switch is left of cancel");
        h.get_by_label("Switch between free transform and warp modes").click();
        h.run_steps(2);
        assert!(h.state().ui.transform.as_ref().unwrap().warp.is_some());
        h.get_by_label("Switch between free transform and warp modes").click();
        h.run_steps(2);
        assert!(h.state().ui.transform.as_ref().unwrap().warp.is_none());
        h.get_by_label("Cancel transform").click();
        h.run_steps(2);
        assert!(h.state().ui.transform.is_none());
    }

    fn drag(s: &mut TransformSession, from: [f64; 2], to: [f64; 2], mods: egui::Modifiers) {
        let g = Gesture { hit: hit(s, from, 8.0), start: from, quad0: s.quad, pivot0: s.pivot };
        apply_drag(s, g, to, mods);
    }

    fn close(a: [[f64; 2]; 4], b: [[f64; 2]; 4]) -> bool {
        a.iter().flatten().zip(b.iter().flatten()).all(|(x, y)| (x - y).abs() < 1e-6)
    }

    /// On a box smaller than the handles' grab areas the nearest handle wins, so the reference
    /// point at the centre doesn't take presses on the corners and edges.
    #[test]
    fn the_nearest_handle_wins_on_a_small_box() {
        let mut s = session();
        s.quad = corners([0.0, 0.0, 16.0, 16.0]);
        s.pivot = [8.0, 8.0];
        assert_eq!(hit(&s, [0.0, 0.0], 12.0), Hit::Corner(0));
        assert_eq!(hit(&s, [16.0, 17.0], 12.0), Hit::Corner(2));
        assert_eq!(hit(&s, [8.0, -1.0], 12.0), Hit::Edge(0));
        assert_eq!(hit(&s, [8.0, 8.0], 12.0), Hit::Pivot);
        assert_eq!(hit(&s, [40.0, 40.0], 12.0), Hit::Outside);
    }

    #[test]
    fn interior_patch_points_are_hidden_and_grid_anchors_stay() {
        assert!(on_section_edge(0, 0) && on_section_edge(1, 0) && on_section_edge(0, 2));
        assert!(!on_section_edge(1, 1) && !on_section_edge(2, 2));
        let b = [0.0, 0.0, 30.0, 30.0];
        let w = Warp::custom(BezierMesh::identity(b, 1, 1), b);
        assert!(warp_hit(&w, [10.0, 10.0], 4.0).is_none(), "the point inside the patch is not shown");
        assert_eq!(warp_hit(&w, [0.0, 0.0], 4.0), Some(0));
        let grid = Warp::custom(BezierMesh::identity(b, 3, 3), b);
        assert_eq!(warp_hit(&grid, [10.0, 10.0], 4.0), Some(33), "a grid-corner anchor stays draggable");
        assert!(warp_hit(&grid, [30.0 / 9.0, 30.0 / 9.0], 2.0).is_none());
    }

    #[test]
    fn grid_menu_reads_default_and_even_presets() {
        let b = [0.0, 0.0, 100.0, 80.0];
        let plain = BezierMesh::identity(b, 1, 1);
        assert_eq!(warp_grid_id(&plain), "default");
        assert_eq!(warp_grid_id(&BezierMesh::identity(b, 3, 3)), "3");
        assert_eq!(warp_grid_id(&BezierMesh::identity(b, 4, 4)), "4");
        assert_eq!(warp_grid_id(&BezierMesh::identity(b, 5, 5)), "5");
        assert_eq!(warp_grid_id(&BezierMesh::identity(b, 2, 2)), "custom");
        let mut split = plain.clone();
        assert!(split.split_u(0.5));
        assert_eq!(warp_grid_id(&split), "custom");
        assert!(single_patch(&plain));
        assert!(!single_patch(&BezierMesh::identity(b, 3, 3)));
    }

    #[test]
    fn split_tool_places_the_line_where_the_pointer_releases() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session
            .edit("paint", |doc, a| {
                doc.layer_mut(a.unwrap()).unwrap().surface_mut().unwrap().fill_rect(photosuite_geom::Rect::new(8, 8, 32, 32), &[1.0, 0.0, 0.0, 1.0]);
                Ok(())
            })
            .unwrap();
        begin_warp(&mut app, &egui::Context::default()).unwrap();
        app.transform_preview.as_mut().unwrap().split_tool = Some(SplitTool::Vertical);
        let knots = |app: &PhotosuiteApp| app.ui.transform.as_ref().unwrap().warp.as_ref().unwrap().mesh.as_ref().unwrap().us.clone();
        assert_eq!(knots(&app).len(), 2);
        let mods = egui::Modifiers::NONE;
        warp_pointer(&mut app, ToolEvent::Down { x: 20.0, y: 20.0, pressure: 1.0 }, 2.0, mods);
        warp_pointer(&mut app, ToolEvent::Move { x: 14.0, y: 20.0, pressure: 1.0 }, 2.0, mods);
        assert_eq!(knots(&app).len(), 2, "the line is only a guide until release");
        warp_pointer(&mut app, ToolEvent::Up { x: 14.0, y: 20.0 }, 2.0, mods);
        let us = knots(&app);
        let has = |ks: &[f64], u: f64| ks.iter().any(|k| (k - u).abs() < 0.02);
        // The default grid's thirds stay; the release cuts the section that contains it.
        assert!(has(&us, 0.25) && has(&us, 1.0 / 3.0) && has(&us, 2.0 / 3.0), "{us:?}");
        let vs = app.ui.transform.as_ref().unwrap().warp.as_ref().unwrap().mesh.as_ref().unwrap().vs.clone();
        assert!(has(&vs, 1.0 / 3.0) && has(&vs, 2.0 / 3.0), "horizontal sections stay: {vs:?}");
        assert!(app.transform_preview.as_ref().unwrap().split_tool.is_some(), "the tool stays armed");
        // Option-click in the open places both lines, without a button armed.
        app.transform_preview.as_mut().unwrap().split_tool = None;
        let alt = egui::Modifiers::ALT;
        warp_pointer(&mut app, ToolEvent::Down { x: 20.0, y: 20.0, pressure: 1.0 }, 2.0, alt);
        warp_pointer(&mut app, ToolEvent::Up { x: 20.0, y: 20.0 }, 2.0, alt);
        let m = app.ui.transform.as_ref().unwrap().warp.as_ref().unwrap().mesh.as_ref().unwrap();
        assert!(m.us.len() == us.len() + 1 && has(&m.vs, 0.5), "crosswise cuts the open section: us {:?} vs {:?}", m.us, m.vs);
    }

    #[test]
    fn split_of_a_grid_cuts_one_section_and_keeps_the_rest() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session
            .edit("paint", |doc, a| {
                doc.layer_mut(a.unwrap()).unwrap().surface_mut().unwrap().fill_rect(photosuite_geom::Rect::new(8, 8, 32, 32), &[1.0, 0.0, 0.0, 1.0]);
                Ok(())
            })
            .unwrap();
        begin_warp(&mut app, &egui::Context::default()).unwrap();
        let rect = app.ui.transform.as_ref().unwrap().rect;
        let before = BezierMesh::identity(rect, 3, 3);
        app.ui.transform.as_mut().unwrap().warp = Some(Warp::custom(before.clone(), rect));
        // Middle of the centre column (s = 0.5), inside the top row of cells.
        let x = rect[0] + 0.5 * (rect[2] - rect[0]);
        let y = rect[1] + (1.0 / 6.0) * (rect[3] - rect[1]);
        app.transform_preview.as_mut().unwrap().split_tool = Some(SplitTool::Vertical);
        let mods = egui::Modifiers::NONE;
        warp_pointer(&mut app, ToolEvent::Down { x, y, pressure: 1.0 }, 2.0, mods);
        warp_pointer(&mut app, ToolEvent::Up { x, y }, 2.0, mods);
        let m = app.ui.transform.as_ref().unwrap().warp.as_ref().unwrap().mesh.as_ref().unwrap();
        assert_eq!(m.vs.len(), before.vs.len(), "horizontal sections are not rebuilt: {:?}", m.vs);
        for (a, b) in m.vs.iter().zip(&before.vs) {
            assert!((a - b).abs() < 1e-6, "{:?} vs {:?}", m.vs, before.vs);
        }
        assert_eq!(m.us.len(), before.us.len() + 1, "one cut: {:?}", m.us);
        for u in [0.0, 1.0 / 3.0, 0.5, 2.0 / 3.0, 1.0] {
            assert!(m.us.iter().any(|k| (k - u).abs() < 1e-3), "missing {u} in {:?}", m.us);
        }
        let (nx0, nx1) = (before.nx(), m.nx());
        for j in 0..before.ny() {
            for i in 0..3 {
                let a = before.points[j * nx0 + i];
                let b = m.points[j * nx1 + i];
                assert!((a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6, "left section moved");
            }
        }
    }

    #[test]
    fn corner_drag_scales_proportionally_about_opposite_corner() {
        let mut s = session();
        drag(&mut s, [100.0, 50.0], [200.0, 60.0], egui::Modifiers::NONE);
        assert!(close(s.quad, corners([0.0, 0.0, 200.0, 100.0])), "{:?}", s.quad);
        let mut s = session();
        drag(&mut s, [100.0, 50.0], [200.0, 60.0], egui::Modifiers::SHIFT);
        assert!(close(s.quad, corners([0.0, 0.0, 200.0, 60.0])), "shift = free: {:?}", s.quad);
    }

    #[test]
    fn alt_scales_about_reference_point_and_edges_scale_one_axis() {
        let mut s = session();
        drag(&mut s, [100.0, 25.0], [150.0, 25.0], egui::Modifiers::ALT);
        assert!(close(s.quad, corners([-50.0, 0.0, 150.0, 50.0])), "{:?}", s.quad);
        let mut s = session();
        drag(&mut s, [50.0, 50.0], [50.0, 80.0], egui::Modifiers::NONE);
        assert!(close(s.quad, corners([0.0, 0.0, 100.0, 80.0])), "{:?}", s.quad);
    }

    #[test]
    fn move_rotate_and_distort() {
        let mut s = session();
        drag(&mut s, [40.0, 20.0], [50.0, 30.0], egui::Modifiers::NONE);
        assert!(close(s.quad, corners([10.0, 10.0, 110.0, 60.0])));
        assert_eq!(s.pivot, [60.0, 35.0]);
        // Rotate 90° about the centre (drag from right of the box to below it).
        let mut s = session();
        drag(&mut s, [150.0, 25.0], [50.0, 125.0], egui::Modifiers::NONE);
        let (_, _, angle, _) = readout(&s);
        assert!((angle - 90.0).abs() < 1e-6, "{angle}");
        // ⇧ snaps: a 50° drag lands on 45°.
        let mut s = session();
        let a = 50f64.to_radians();
        drag(&mut s, [150.0, 25.0], [50.0 + 100.0 * a.cos(), 25.0 + 100.0 * a.sin()], egui::Modifiers::SHIFT);
        assert!((readout(&s).2 - 45.0).abs() < 1e-6);
        // ⌘ corner = distort.
        let mut s = session();
        drag(&mut s, [100.0, 0.0], [120.0, -10.0], egui::Modifiers::COMMAND);
        assert_eq!(s.quad[1], [120.0, -10.0]);
        assert_eq!(s.quad[0], [0.0, 0.0]);
    }

    #[test]
    fn begin_and_commit_through_the_engine() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session
            .edit("paint", |doc, a| {
                doc.layer_mut(a.unwrap()).unwrap().surface_mut().unwrap().fill_rect(photosuite_geom::Rect::new(8, 8, 24, 24), &[1.0, 0.0, 0.0, 1.0]);
                Ok(())
            })
            .unwrap();
        let ctx = egui::Context::default();
        begin(&mut app, &ctx).unwrap();
        assert_eq!(app.ui.transform.as_ref().unwrap().rect, [8.0, 8.0, 24.0, 24.0]);
        scale_about_pivot(&mut app, 2.0, 2.0);
        commit(&mut app);
        let st = app.session.active().unwrap();
        let b = st.doc.layer(st.active_layer.unwrap()).unwrap().surface().unwrap().content_bounds();
        assert!(b.width().abs_diff(32) <= 2 && b.x0.abs_diff(0) <= 1, "{b:?}");
        assert!(app.ui.transform.is_none() && app.transform_preview.is_none());
    }

    /// #352: ⌥⌘T transforms a copy. OK leaves the original and a moved copy as one history step;
    /// Cancel leaves no copy and nothing to redo; with a selection the copy holds the selected
    /// pixels only.
    #[test]
    fn free_transform_a_copy() {
        let ctx = egui::Context::default();
        let bounds = |app: &PhotosuiteApp, i: usize| app.session.active().unwrap().doc.layers[i].surface().unwrap().content_bounds();
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
        let (layers, steps) = (app.session.active().unwrap().doc.layers.len(), app.session.active().unwrap().history.past_len());
        crate::menus::invoke(&mut app, &ctx, "edit.freeTransformCopy", json!({})).unwrap();
        assert_eq!(app.ui.transform.as_ref().unwrap().made, Some(MadeLayer::Copy));
        assert!(!crate::menus::is_enabled(&app, "edit.freeTransformCopy"), "one transform at a time");
        // Esc: the copy goes too.
        cancel(&mut app);
        let st = app.session.active().unwrap();
        assert_eq!((st.doc.layers.len(), st.history.past_len()), (layers, steps));
        assert!(!st.history.can_redo(), "nothing to redo");
        // OK: original in place, a moved copy, one step.
        crate::menus::invoke(&mut app, &ctx, "edit.freeTransformCopy", json!({})).unwrap();
        if let Some(t) = app.ui.transform.as_mut() {
            t.quad = t.quad.map(|[x, y]| [x + 20.0, y]);
        }
        commit(&mut app);
        let st = app.session.active().unwrap();
        assert_eq!((st.doc.layers.len(), st.history.past_len()), (layers + 1, steps + 1));
        assert_eq!(bounds(&app, layers - 1), photosuite_geom::Rect::new(8, 8, 24, 24), "the original stays");
        assert_eq!(bounds(&app, layers), photosuite_geom::Rect::new(28, 8, 44, 24), "the copy moved");
        app.session.undo();
        assert_eq!(app.session.active().unwrap().doc.layers.len(), layers, "one undo removes copy and move");
        // With a selection: Layer via Copy, so only the selected pixels are copied.
        app.run("select.rect", json!({"x": 8, "y": 8, "width": 8, "height": 16})).unwrap();
        crate::menus::invoke(&mut app, &ctx, "edit.freeTransformCopy", json!({})).unwrap();
        assert_eq!(app.ui.transform.as_ref().unwrap().rect, [8.0, 8.0, 16.0, 24.0]);
        cancel(&mut app);
        assert_eq!(app.session.active().unwrap().doc.layers.len(), layers);
    }

    /// #670: picking another tool applies the open transform, as one history step.
    #[test]
    fn picking_another_tool_applies_the_transform() {
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
        app.ui.tool = Tool::Move;
        let steps = app.session.active().unwrap().history.past_len();
        let mut h = egui_kittest::Harness::builder().with_size(vec2(1200.0, 800.0)).with_max_steps(64).build_eframe(move |cc| {
            PhotosuiteApp::setup_context(&cc.egui_ctx, Default::default());
            app
        });
        h.run_steps(4);
        let ctx = h.ctx.clone();
        crate::menus::invoke(h.state_mut(), &ctx, "edit.freeTransform", json!({})).unwrap();
        if let Some(t) = h.state_mut().ui.transform.as_mut() {
            t.quad = t.quad.map(|[x, y]| [x + 20.0, y]);
        }
        h.run_steps(2);
        assert!(h.state().ui.transform.is_some(), "open while the tool stays");
        h.key_press(egui::Key::B);
        h.run_steps(2);
        let app = h.state();
        assert_eq!(app.ui.tool, Tool::Brush);
        assert!(app.ui.transform.is_none() && app.transform_preview.is_none());
        let st = app.session.active().unwrap();
        assert_eq!(st.history.past_len(), steps + 1);
        assert_eq!(st.doc.layer(st.active_layer.unwrap()).unwrap().surface().unwrap().content_bounds(), photosuite_geom::Rect::new(28, 8, 44, 24));
    }

    /// A control-channel stroke that picks another tool applies the box first, then paints.
    #[test]
    fn a_pointer_request_with_another_tool_applies_the_transform_first() {
        let ctx = egui::Context::default();
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
        app.ui.tool = Tool::Move;
        crate::menus::invoke(&mut app, &ctx, "edit.freeTransform", json!({})).unwrap();
        if let Some(t) = app.ui.transform.as_mut() {
            t.quad = t.quad.map(|[x, y]| [x + 20.0, y]);
        }
        let steps = app.session.active().unwrap().history.past_len();
        let ev = |kind: &str, x: f64| json!({"kind": kind, "x": x, "y": 50.0});
        let events = json!([ev("down", 4.0), ev("move", 32.0), ev("move", 60.0), ev("up", 60.0)]);
        let (req, _rx) = crate::control::ControlRequest::new("ui.pointer", json!({"tool": "brush", "events": events}));
        let _ = crate::control::handle(&mut app, &ctx, &req);
        assert!(app.ui.transform.is_none());
        let st = app.session.active().unwrap();
        assert_eq!(st.history.past_len(), steps + 2, "the transform, then the stroke");
        let b = st.doc.layer(st.active_layer.unwrap()).unwrap().surface().unwrap().content_bounds();
        assert!(b.x0 < 8 && b.x1 >= 44 && b.y0 == 8 && b.y1 > 50, "moved square and stroke: {b:?}");
    }

    /// Drags with real pointer events (snapping off so the drops land exactly).
    fn press_drag(app: &mut PhotosuiteApp, from: [f64; 2], to: [f64; 2], m: egui::Modifiers) {
        crate::canvas::tool_event(app, ToolEvent::Down { x: from[0], y: from[1], pressure: 1.0 }, m);
        crate::canvas::tool_event(app, ToolEvent::Up { x: to[0], y: to[1] }, m);
    }

    #[test]
    fn distort_mode_moves_one_corner_and_ignores_rotate_and_edges() {
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
        app.ui.extras.snap = false;
        let ctx = egui::Context::default();
        crate::menus::invoke(&mut app, &ctx, "edit.transform.distort", json!({})).unwrap();
        let q0 = app.ui.transform.as_ref().unwrap().quad;
        assert_eq!(app.ui.transform.as_ref().unwrap().mode, TransformMode::Distort);
        // Outside (rotate) and an edge handle do nothing in Distort.
        press_drag(&mut app, [44.0, 44.0], [54.0, 10.0], egui::Modifiers::NONE);
        press_drag(&mut app, [24.0, 16.0], [34.0, 16.0], egui::Modifiers::NONE);
        assert_eq!(app.ui.transform.as_ref().unwrap().quad, q0);
        // A corner moves alone, with no keys held.
        press_drag(&mut app, q0[1], [q0[1][0] + 7.0, q0[1][1] - 5.0], egui::Modifiers::NONE);
        let q = app.ui.transform.as_ref().unwrap().quad;
        assert_eq!(q[1], [q0[1][0] + 7.0, q0[1][1] - 5.0]);
        assert_eq!([q[0], q[2], q[3]], [q0[0], q0[2], q0[3]]);
        // Free Transform from the menu switches the live box back.
        crate::menus::invoke(&mut app, &ctx, "edit.freeTransform", json!({})).unwrap();
        assert_eq!(app.ui.transform.as_ref().unwrap().mode, TransformMode::Free);
    }

    #[test]
    fn the_legacy_preference_swaps_corner_proportions() {
        let none = egui::Modifiers::NONE;
        let corner = Hit::Corner(1);
        // Default: proportional (⇧ frees), so the drag keeps its keys.
        assert!(!corner_mods(false, corner, none).shift);
        // Legacy: free by default, ⇧ keeps proportions; edges and ⌘ gestures are left alone.
        assert!(corner_mods(true, corner, none).shift);
        assert!(!corner_mods(true, corner, egui::Modifiers::SHIFT).shift);
        assert!(!corner_mods(true, Hit::Edge(1), none).shift);
        assert!(!corner_mods(true, corner, egui::Modifiers::COMMAND).shift);
        // Through the box: a plain corner drag on a 16×16 square.
        for (legacy, proportional) in [(false, true), (true, false)] {
            let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
            app.ui.extras.snap = false;
            app.session.prefs.edit(|p| p.general.use_legacy_free_transform = legacy);
            begin(&mut app, &egui::Context::default()).unwrap();
            let q0 = app.ui.transform.as_ref().unwrap().quad;
            press_drag(&mut app, q0[2], [q0[2][0] + 16.0, q0[2][1]], none);
            let q = app.ui.transform.as_ref().unwrap().quad;
            let (w, h) = (q[2][0] - q[0][0], q[2][1] - q[0][1]);
            assert_eq!((w - h).abs() < 1e-6, proportional, "legacy {legacy}: {w} × {h}");
        }
    }

    #[test]
    fn right_click_while_transforming_switches_the_mode() {
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
        let ctx = egui::Context::default();
        begin(&mut app, &ctx).unwrap();
        assert!(crate::canvas_tool_menu::open_transform(&mut app, [10.0, 10.0]));
        let menu = app.ui.canvas_tool_menu.clone().unwrap();
        let ids: Vec<&str> = crate::canvas_tool_menu::menu_entries(&menu).iter().map(|e| e.1).collect();
        assert!(ids.contains(&"edit.transform.distort") && ids.contains(&"edit.freeTransform"));
        crate::canvas_tool_menu::choose(&mut app, &ctx, "edit.transform.distort");
        assert_eq!(app.ui.transform.as_ref().unwrap().mode, TransformMode::Distort);
    }

    fn app_with_square(size: u32, fill: photosuite_geom::Rect) -> PhotosuiteApp {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": size, "height": size})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session
            .edit("paint", |doc, a| {
                doc.layer_mut(a.unwrap()).unwrap().surface_mut().unwrap().fill_rect(fill, &[1.0, 0.0, 0.0, 1.0]);
                Ok(())
            })
            .unwrap();
        app
    }

    /// A context that reports a real GPU's texture limit (the default reports 2048).
    fn gpu_ctx() -> egui::Context {
        let ctx = egui::Context::default();
        // Clear the font atlas delta: epaint panics on dropping unapplied deltas in debug builds.
        let mut out = ctx.run_ui(egui::RawInput { max_texture_side: Some(16384), ..Default::default() }, |_| {});
        out.textures_delta.clear();
        ctx
    }

    #[test]
    fn preview_texture_is_full_resolution() {
        // #91: the preview used to be sampled down to 2048 px, so big layers looked blurry at 100%.
        let mut app = app_with_square(3000, photosuite_geom::Rect::new(10, 20, 2810, 2420));
        let ctx = gpu_ctx();
        begin(&mut app, &ctx).unwrap();
        let pv = app.transform_preview.as_ref().unwrap();
        assert_eq!(pv.texture.size(), [2800, 2400], "one texel per layer pixel");
        // At 100% the texture has at least as many texels as the box covers screen pixels.
        let t = app.ui.transform.as_ref().unwrap();
        assert!(pv.texture.size()[0] as f64 >= t.rect[2] - t.rect[0]);
    }

    #[test]
    fn shift_body_drag_locks_to_eight_directions_and_switches() {
        let mut s = session();
        let g = Gesture { hit: Hit::Inside, start: [40.0, 20.0], quad0: s.quad, pivot0: s.pivot };
        apply_drag(&mut s, g, [60.0, 23.0], egui::Modifiers::SHIFT);
        assert!(close(s.quad, corners([20.0, 0.0, 120.0, 50.0])), "horizontal: {:?}", s.quad);
        apply_drag(&mut s, g, [60.0, 39.0], egui::Modifiers::SHIFT);
        assert!((s.quad[0][0] - s.quad[0][1]).abs() < 1e-9 && s.quad[0][0] > 15.0, "diagonal: {:?}", s.quad[0]);
        apply_drag(&mut s, g, [41.0, 60.0], egui::Modifiers::SHIFT);
        assert!(close(s.quad, corners([0.0, 40.0, 100.0, 90.0])), "vertical: {:?}", s.quad);
    }

    #[test]
    fn alt_click_moves_the_reference_point_and_edges_skew() {
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
        let ctx = egui::Context::default();
        begin(&mut app, &ctx).unwrap();
        assert!(pointer(&mut app, ToolEvent::Down { x: 40.0, y: 40.0, pressure: 1.0 }, egui::Modifiers::ALT));
        pointer(&mut app, ToolEvent::Up { x: 40.0, y: 40.0 }, egui::Modifiers::ALT);
        let t = app.ui.transform.as_ref().unwrap();
        assert_eq!(t.pivot, [40.0, 40.0]);
        assert_eq!(t.quad, corners(t.rect), "the box didn't move");
        // ⌘ on an edge skews: both corners of the top edge move.
        let mut s = session();
        drag(&mut s, [50.0, 0.0], [70.0, 5.0], egui::Modifiers::COMMAND);
        assert_eq!((s.quad[0], s.quad[1], s.quad[2]), ([20.0, 5.0], [120.0, 5.0], [100.0, 50.0]));
        // ⌘⇧: only along the edge.
        let mut s = session();
        drag(&mut s, [50.0, 0.0], [70.0, 5.0], egui::Modifiers::COMMAND | egui::Modifiers::SHIFT);
        assert_eq!((s.quad[0], s.quad[1]), ([20.0, 0.0], [120.0, 0.0]));
        // ⌘⌥⇧ on a corner: perspective (the paired corner mirrors).
        let mut s = session();
        drag(&mut s, [100.0, 0.0], [101.0, -10.0], egui::Modifiers::COMMAND | egui::Modifiers::ALT | egui::Modifiers::SHIFT);
        assert_eq!((s.quad[1], s.quad[2]), ([100.0, -10.0], [100.0, 60.0]));
    }

    /// `cargo test --release -p photosuite-ui-egui transform_preview_bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn transform_preview_bench() {
        let (w, h) = (6000, 4000);
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": w, "height": h})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session.execute("filter.render.clouds", json!({})).unwrap();
        let ctx = gpu_ctx();
        let t0 = std::time::Instant::now();
        begin(&mut app, &ctx).unwrap();
        let begin_ms = t0.elapsed().as_secs_f64() * 1e3;
        // The same with a linked layer mask applied to the texels (#205).
        cancel(&mut app);
        app.session.execute("layer.layerMask.revealAll", json!({})).unwrap();
        app.session.execute("paint.gradient", json!({"from": [0, 0], "to": [w, 0], "colors": ["#000000", "#ffffff"], "target": "mask"})).unwrap();
        let t0 = std::time::Instant::now();
        begin(&mut app, &ctx).unwrap();
        let masked_ms = t0.elapsed().as_secs_f64() * 1e3;
        eprintln!("transform preview begin {w}x{h}: {begin_ms:.1} ms, with a linked mask {masked_ms:.1} ms");
        let size = app.transform_preview.as_ref().unwrap().texture.size();
        rotate_about_pivot(&mut app, 0.05);
        let frame = |zoom: f32| {
            let t0 = std::time::Instant::now();
            let _ = ctx.run_ui(egui::RawInput { max_texture_side: Some(16384), ..Default::default() }, |ui| {
                let painter = ui.ctx().layer_painter(egui::LayerId::background());
                let xf = ViewXform { rect: egui::Rect::from_min_size(egui::Pos2::ZERO, vec2(1600.0, 1000.0)), zoom, center: [3000.0, 2000.0], flip: false };
                draw_overlay(&app, &painter, &xf);
            });
            t0.elapsed().as_secs_f64() * 1e3
        };
        let first: Vec<f64> = [1.0, 0.25, 3.0].iter().map(|z| frame(*z)).collect();
        let n = 50;
        let steady = (0..n).map(|i| frame([1.0, 0.25, 3.0][i % 3])).sum::<f64>() / n as f64;
        eprintln!(
            "transform preview {w}x{h}: texture {size:?}, begin {begin_ms:.1} ms, first frame per level (1x, 0.25x, 3x) {first:.1?} ms, steady frame {steady:.3} ms"
        );
    }

    #[test]
    fn transform_selection_moves_only_the_outline() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("select.rect", json!({"x": 8, "y": 8, "width": 16, "height": 16})).unwrap();
        let px0 = app.session.active().unwrap().doc.layers[0].surface().unwrap().read_region(photosuite_geom::Rect::new(0, 0, 64, 64));
        let ctx = egui::Context::default();
        crate::menus::invoke(&mut app, &ctx, "select.transformSelection", json!({})).unwrap();
        let t = app.ui.transform.as_ref().unwrap();
        assert!(t.selection && t.rect == [8.0, 8.0, 24.0, 24.0]);
        assert!(app.transform_preview.as_ref().unwrap().doc.selection.is_none(), "ants hidden while transforming");
        scale_about_pivot(&mut app, 2.0, 2.0);
        commit(&mut app);
        let st = app.session.active().unwrap();
        let b = st.doc.selection.as_ref().unwrap().content_bounds();
        assert!(b.width().abs_diff(32) <= 2 && b.x0.abs_diff(0) <= 1, "{b:?}");
        assert_eq!(st.doc.layers[0].surface().unwrap().read_region(photosuite_geom::Rect::new(0, 0, 64, 64)), px0);
    }

    #[test]
    fn warp_mode_drags_anchor_with_handles_splits_and_commits() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session
            .edit("paint", |doc, a| {
                doc.layer_mut(a.unwrap()).unwrap().surface_mut().unwrap().fill_rect(photosuite_geom::Rect::new(8, 8, 32, 32), &[1.0, 0.0, 0.0, 1.0]);
                Ok(())
            })
            .unwrap();
        let ctx = egui::Context::default();
        begin_warp(&mut app, &ctx).unwrap();
        let w = app.ui.transform.as_ref().unwrap().warp.clone().unwrap();
        assert!(w.is_identity());
        // Drag the bottom-right anchor (point 15) by (+10, +6): its two handles follow.
        warp_pointer(&mut app, ToolEvent::Down { x: 32.0, y: 32.0, pressure: 1.0 }, 2.0, egui::Modifiers::NONE);
        warp_pointer(&mut app, ToolEvent::Up { x: 42.0, y: 38.0 }, 2.0, egui::Modifiers::NONE);
        let m = app.ui.transform.as_ref().unwrap().warp.as_ref().unwrap().mesh.clone().unwrap();
        assert_eq!(m.points[15], [42.0, 38.0]);
        let near = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9;
        assert!(near(m.points[14], [24.0 + 10.0, 38.0]), "{:?}", m.points[14]);
        assert!(near(m.points[11], [42.0, 24.0 + 6.0]), "{:?}", m.points[11]);
        split(&mut app, "edit.transform.splitWarpCrosswise", None).unwrap();
        let split_m = app.ui.transform.as_ref().unwrap().warp.as_ref().unwrap().mesh.as_ref().unwrap();
        assert_eq!(split_m.points.last().copied(), Some([42.0, 38.0]), "the corner survives the cut");
        assert!(split_m.us.iter().any(|u| (u - 1.0 / 3.0).abs() < 1e-6) && split_m.us.iter().any(|u| (u - 0.5).abs() < 1e-6));
        commit(&mut app);
        let st = app.session.active().unwrap();
        let b = st.doc.layer(st.active_layer.unwrap()).unwrap().surface().unwrap().content_bounds();
        assert!(b.x1 >= 41 && b.y1 >= 37, "{b:?}");
        assert!(app.ui.transform.is_none());
        // Toggling back to the box drops the warp.
        begin_warp(&mut app, &ctx).unwrap();
        leave_warp(&mut app);
        assert!(app.ui.transform.as_ref().unwrap().warp.is_none());
    }

    #[test]
    fn replacing_the_warp_mesh_cancels_a_pending_point_drag() {
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 32, 32));
        let ctx = egui::Context::default();
        begin_warp(&mut app, &ctx).unwrap();
        for _ in 0..3 {
            split(&mut app, "edit.transform.splitWarpCrosswise", None).unwrap();
        }

        pointer(&mut app, ToolEvent::Down { x: 32.0, y: 32.0, pressure: 1.0 }, egui::Modifiers::NONE);
        assert!(app.transform_preview.as_ref().unwrap().warp_drag.is_some(), "the anchor drag is armed");

        split(&mut app, "edit.transform.removeWarpSplit", None).unwrap();
        assert!(app.transform_preview.as_ref().unwrap().warp_drag.is_none(), "the old mesh index is discarded");

        // A later control-channel move belongs to the old gesture and must be harmless.
        pointer(&mut app, ToolEvent::Move { x: 40.0, y: 40.0, pressure: 1.0 }, egui::Modifiers::NONE);
    }

    /// A press on a preset warp that misses its points leaves the preset alone (no invisible undo
    /// step); grabbing a point turns it into a custom mesh.
    #[test]
    fn a_press_on_a_preset_warp_converts_it_only_when_it_grabs_a_point() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.session.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        app.sync_views();
        app.session.execute("layer.new.layer", json!({})).unwrap();
        app.session
            .edit("paint", |doc, a| {
                doc.layer_mut(a.unwrap()).unwrap().surface_mut().unwrap().fill_rect(photosuite_geom::Rect::new(8, 8, 32, 32), &[1.0, 0.0, 0.0, 1.0]);
                Ok(())
            })
            .unwrap();
        begin_warp(&mut app, &egui::Context::default()).unwrap();
        let t = app.ui.transform.as_mut().unwrap();
        let preset = Warp::preset(WarpStyle::Arc, 50.0, t.rect);
        t.warp = Some(preset.clone());
        warp_pointer(&mut app, ToolEvent::Down { x: 20.0, y: 20.0, pressure: 1.0 }, 2.0, egui::Modifiers::NONE);
        warp_pointer(&mut app, ToolEvent::Up { x: 20.0, y: 20.0 }, 2.0, egui::Modifiers::NONE);
        assert_eq!(app.ui.transform.as_ref().unwrap().warp.as_ref(), Some(&preset), "a miss changes nothing");
        let corner = preset.to_mesh(1, 1).points[15];
        warp_pointer(&mut app, ToolEvent::Down { x: corner[0], y: corner[1], pressure: 1.0 }, 2.0, egui::Modifiers::NONE);
        assert_eq!(app.ui.transform.as_ref().unwrap().warp.as_ref().unwrap().style, WarpStyle::Custom);
    }

    // ---- Layer masks (#205) ----

    /// `app_with_square` (red over 8..24) plus a reveal-all mask hiding x < 16.
    fn masked_app(linked: bool) -> PhotosuiteApp {
        let mut app = app_with_square(64, photosuite_geom::Rect::new(8, 8, 24, 24));
        app.session.execute("layer.layerMask.revealAll", json!({})).unwrap();
        app.session
            .edit("mask", |doc, a| {
                let m = doc.layer_mut(a.unwrap()).unwrap().mask.as_mut().unwrap();
                m.surface.fill_rect(photosuite_geom::Rect::new(0, 0, 16, 64), &[0.0]);
                m.linked = linked;
                Ok(())
            })
            .unwrap();
        app
    }

    fn texel_alpha(img: &egui::ColorImage, x: usize, y: usize) -> u8 {
        img.pixels[y * img.size[0] + x].a()
    }

    #[test]
    fn preview_applies_the_linked_mask() {
        for linked in [true, false] {
            let app = masked_app(linked);
            let st = app.session.active().unwrap();
            let id = st.active_layer.unwrap();
            let b = photosuite_geom::Rect::new(8, 8, 24, 24);
            let (img, _) = preview_image(&st.doc, id, None, b, 4096);
            // Texel x = doc x − 8: x 10 is hidden by the mask, x 20 shows.
            assert_eq!(texel_alpha(&img, 12, 4), 255);
            assert_eq!(texel_alpha(&img, 2, 4), if linked { 0 } else { 255 }, "linked={linked}");
        }
        // With a selection the lifted pixels carry the mask too.
        let mut app = masked_app(true);
        app.session.execute("select.rect", json!({"x": 8, "y": 8, "width": 12, "height": 16})).unwrap();
        let ctx = egui::Context::default();
        begin(&mut app, &ctx).unwrap();
        let st = app.session.active().unwrap();
        let sel = st.doc.selection.clone().unwrap();
        let id = st.active_layer.unwrap();
        let (lifted, _) = photosuite_engine::transform_cmds::split_selected(st.doc.layer(id).unwrap().surface().unwrap(), &sel);
        let b = photosuite_geom::Rect::new(8, 8, 20, 24);
        let (img, _) = preview_image(&st.doc, id, Some(&lifted), b, 4096);
        assert_eq!(texel_alpha(&img, 2, 4), 0, "masked");
        assert_eq!(texel_alpha(&img, 10, 4), 255, "revealed");
    }

    #[test]
    fn targeted_unlinked_mask_transforms_alone_through_the_box() {
        let mut app = masked_app(false);
        app.ui.mask_target = true;
        let ctx = egui::Context::default();
        begin(&mut app, &ctx).unwrap();
        let t = app.ui.transform.as_ref().unwrap();
        assert_eq!(t.target, Some(json!("mask")));
        assert_eq!(t.rect, [0.0, 0.0, 16.0, 64.0], "the box frames the mask's content");
        // The preview document shows the mask vacated (revealed).
        let pd = &app.transform_preview.as_ref().unwrap().doc;
        assert!(pd.layer(app.session.active().unwrap().active_layer.unwrap()).unwrap().mask.as_ref().unwrap().surface.sample_channel(4, 4, 0) > 0.99);
        // Move the box 20 px right and commit.
        let t = app.ui.transform.as_mut().unwrap();
        t.quad = t.quad.map(|[x, y]| [x + 20.0, y]);
        commit(&mut app);
        assert!(!app.ui.status_error, "{}", app.ui.status);
        let st = app.session.active().unwrap();
        let l = st.doc.layer(st.active_layer.unwrap()).unwrap();
        let m = &l.mask.as_ref().unwrap().surface;
        assert!(m.sample_channel(4, 30, 0) > 0.99 && m.sample_channel(30, 30, 0) < 0.01, "mask moved 20 px right");
        assert_eq!(l.surface().unwrap().content_bounds(), photosuite_geom::Rect::new(8, 8, 24, 24), "pixels untouched");
        // Warp mode doesn't apply to a lone mask.
        app.ui.mask_target = true;
        begin(&mut app, &ctx).unwrap();
        enter_warp(&mut app);
        assert!(app.ui.transform.as_ref().unwrap().warp.is_none());
    }

    #[test]
    fn linked_mask_target_transforms_the_layer() {
        let mut app = masked_app(true);
        app.ui.mask_target = true;
        let ctx = egui::Context::default();
        begin(&mut app, &ctx).unwrap();
        assert_eq!(app.ui.transform.as_ref().unwrap().target, None);
        assert_eq!(app.ui.transform.as_ref().unwrap().rect, [8.0, 8.0, 24.0, 24.0]);
    }
}
