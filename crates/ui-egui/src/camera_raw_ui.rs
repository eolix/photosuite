//! Filter › Camera Raw Filter…: a large dialog like Adobe Camera Raw's (preview on the left,
//! edit panels on the right: Basic, Curve, Detail, Color Mixer, Color Grading, Effects).
//!
//! The dialog is a large modal over the document, at most 1400 × 900 pt. The preview runs
//! [`photosuite_algo::camera_raw::develop`] on a CPU proxy of the layer, sized to the preview
//! (`pixel_scale` keeps pixel radii true to the full image), recomputed when a
//! control changes. OK runs `filter.cameraRaw` with the non-default settings, so the result is
//! one history step (or a smart filter on a smart object) and exactly replayable.
//!
//! Control channel: `ui.menu.invoke {"id":"filter.cameraRaw","params":{"ui":{"set":{…},
//! "autoWhiteBalance":true, "whiteBalanceAt":[u, v] (0..=1 of the image), "commit":true |
//! "cancel":true}}}`; the reply describes the dialog.

use egui::{Color32, FontId, Pos2, Rect as ERect, Sense, Stroke, TextureHandle, pos2, vec2};
use photosuite_algo::camera_raw::{CameraRaw, Wheel, curve_lut};
use photosuite_doc::LayerId;
use photosuite_geom::Rect;
use serde_json::{Value, json};

use crate::PhotosuiteApp;
use crate::theme::Tokens;
use crate::widgets;

/// The preview's long side is at most this (physical pixels), and at least `MIN_PROXY_SIDE`.
const MAX_PROXY_SIDE: usize = 4096;
const MIN_PROXY_SIDE: usize = 256;
const PANEL_W: f32 = 330.0;
const BANDS: [&str; 8] = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];

pub struct CameraRawDialog {
    pub layer: LayerId,
    layer_name: String,
    pub params: CameraRaw,
    /// Proxy pixels (straight RGBA) and size.
    proxy: Vec<[f32; 4]>,
    pw: usize,
    ph: usize,
    full_w: usize,
    full_h: usize,
    float: bool,
    tex: Option<TextureHandle>,
    before_tex: Option<TextureHandle>,
    dirty: bool,
    pub show_before: bool,
    mixer_tab: usize,
    pub render_ms: f64,
    /// The White Balance eyedropper is armed: a click on the preview neutralises that spot.
    pub wb_pick: bool,
    /// Opened on a camera file as it was opened: OK says Open, Cancel closes the file again.
    pub opened_file: Option<photosuite_doc::DocId>,
    /// The one expanded panel (an accordion), by its shown title; Basic to begin with.
    pub open_section: Option<String>,
    /// The developed preview's red, green and blue histograms (alpha-weighted, display levels).
    hist: Box<[[f32; 256]; 3]>,
    /// The histogram's Channel menu: 0 RGB, 1 Red, 2 Green, 3 Blue, 4 Colours (the three overlaid).
    pub hist_channel: usize,
}

/// Camera file extensions (the raw formats File › Open reads).
const RAW_EXTS: &[&str] = &["dng", "cr2", "cr3", "nef", "nrw", "arw", "pef", "orf", "rw2", "raf"];

/// Whether `name` is a camera raw file, by extension.
pub fn is_raw_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, e)| RAW_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

impl CameraRawDialog {
    pub fn describe(&self) -> Value {
        json!({"layer": self.layer.0, "params": serde_json::to_value(&self.params).unwrap_or(Value::Null), "proxy": [self.pw, self.ph], "renderMs": self.render_ms, "before": self.show_before, "openSection": self.open_section, "histogramChannel": self.hist_channel})
    }

    /// Params for the engine: only the settings that differ from the defaults.
    pub fn command_params(&self) -> Value {
        let full = serde_json::to_value(&self.params).unwrap_or(json!({}));
        let def = serde_json::to_value(CameraRaw::default()).unwrap_or(json!({}));
        let mut out = serde_json::Map::new();
        if let (Value::Object(f), Value::Object(d)) = (full, def) {
            for (k, v) in f {
                if k != "pixelScale" && d.get(&k) != Some(&v) {
                    out.insert(k, v);
                }
            }
        }
        Value::Object(out)
    }

    /// Sets Temperature / Tint so the proxy's colour around (`x`, `y`) — or, with `None`, the
    /// whole image's average (Auto) — comes out neutral.
    pub fn neutralise(&mut self, at: Option<(usize, usize)>) {
        let (mut sum, mut n) = ([0.0f32; 3], 0.0f32);
        for (i, q) in self.proxy.iter().enumerate() {
            let (x, y) = (i % self.pw.max(1), i / self.pw.max(1));
            if at.is_some_and(|(cx, cy)| x.abs_diff(cx) > 1 || y.abs_diff(cy) > 1) || q[3] <= 0.0 {
                continue;
            }
            for c in 0..3 {
                sum[c] += q[c] * q[3];
            }
            n += q[3];
        }
        if n > 0.0 {
            let (t, tn) = photosuite_algo::camera_raw::neutral_white_balance(sum.map(|v| v / n));
            self.params.temperature = t;
            self.params.tint = tn;
            self.dirty = true;
        }
    }

    fn image(px: &[[f32; 4]], w: usize, h: usize) -> egui::ColorImage {
        let enc = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        egui::ColorImage::new([w, h], px.iter().map(|q| Color32::from_rgba_unmultiplied(enc(q[0]), enc(q[1]), enc(q[2]), enc(q[3]))).collect())
    }

    fn render(&mut self, ctx: &egui::Context) {
        let t0 = crate::gpu_canvas::now_ms();
        let mut px = self.proxy.clone();
        let mut p = self.params.clone();
        p.pixel_scale = (self.pw as f32 / self.full_w.max(1) as f32).min(1.0);
        photosuite_algo::camera_raw::develop(&mut px, self.pw, self.ph, &p, self.float);
        let img = Self::image(&px, self.pw, self.ph);
        *self.hist = colour_histogram(&px);
        match &mut self.tex {
            Some(t) => t.set(img, egui::TextureOptions::LINEAR),
            None => self.tex = Some(ctx.load_texture("camera-raw-after", img, egui::TextureOptions::LINEAR)),
        }
        if self.before_tex.is_none() {
            self.before_tex = Some(ctx.load_texture("camera-raw-before", Self::image(&self.proxy, self.pw, self.ph), egui::TextureOptions::LINEAR));
        }
        self.render_ms = crate::gpu_canvas::now_ms() - t0;
        self.dirty = false;
    }
}

/// The proxy's long side for an image of `w × h`: what the preview draws it at, in physical
/// pixels, so it is shown 1:1 — neither magnified (soft) nor shrunk without mipmaps (grainy).
fn preview_side(ctx: &egui::Context, w: usize, h: usize) -> usize {
    let screen = widgets::tool_dialog_rect(ctx, DIALOG_MAX);
    let (vw, vh) = ((screen.width() - PANEL_W - 32.0).max(64.0), (screen.height() - 30.0 - 48.0 - 32.0).max(64.0));
    let fit = (vw / w.max(1) as f32).min(vh / h.max(1) as f32);
    let side = (w.max(h) as f32 * fit * ctx.pixels_per_point()).round() as usize;
    side.clamp(MIN_PROXY_SIDE, MAX_PROXY_SIDE).min(w.max(h).max(1))
}

/// Area-averaged proxy of `area` with long side `side`: every source pixel lands in exactly one
/// proxy pixel, averaged premultiplied so transparent pixels don't bleed their colour.
pub(crate) fn build_proxy(surf: &photosuite_raster::Surface, area: Rect, side: usize) -> (Vec<[f32; 4]>, usize, usize) {
    let (w, h) = (area.width().max(1) as usize, area.height().max(1) as usize);
    let k = (w.max(h) as f64 / side.max(1) as f64).max(1.0);
    let (pw, ph) = (((w as f64 / k).ceil() as usize).max(1), ((h as f64 / k).ceil() as usize).max(1));
    let mut proxy = vec![[0.0f32; 4]; pw * ph];
    let mut row = vec![[0.0f32; 4]; w];
    let mut acc = vec![[0.0f32; 5]; pw];
    let mut py_prev = 0usize;
    let flush = |acc: &mut Vec<[f32; 5]>, line: &mut [[f32; 4]]| {
        for (q, a) in line.iter_mut().zip(acc.iter_mut()) {
            *q = if a[3] > 0.0 { [a[0] / a[3], a[1] / a[3], a[2] / a[3], a[3] / a[4].max(1.0)] } else { [0.0; 4] };
            *a = [0.0; 5];
        }
    };
    for y in 0..h {
        let py = ((y as f64 / k) as usize).min(ph - 1);
        if py != py_prev {
            flush(&mut acc, &mut proxy[py_prev * pw..(py_prev + 1) * pw]);
            py_prev = py;
        }
        let sy = area.y0 + y as i32;
        surf.read_rgba_into(Rect::new(area.x0, sy, area.x1, sy + 1), &mut row);
        for (x, q) in row.iter().enumerate() {
            let a = &mut acc[((x as f64 / k) as usize).min(pw - 1)];
            for c in 0..3 {
                a[c] += q[c] * q[3];
            }
            a[3] += q[3];
            a[4] += 1.0;
        }
    }
    flush(&mut acc, &mut proxy[py_prev * pw..(py_prev + 1) * pw]);
    (proxy, pw, ph)
}

/// Rebuilds the proxy when the preview's size on screen has changed noticeably (window resized,
/// moved to a display of another density).
fn refit_proxy(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let Some(d) = app.camera_raw.as_ref() else { return };
    let want = preview_side(ctx, d.full_w, d.full_h);
    let have = d.pw.max(d.ph);
    if (want as f64 - have as f64).abs() < have as f64 * 0.15 {
        return;
    }
    let layer = d.layer;
    let Ok((l, surf, _)) = crate::distort_ui::active_pixels(app) else { return };
    let Some(canvas) = app.session.active().map(|s| s.doc.bounds()) else { return };
    if l != layer {
        return;
    }
    let area = surf.content_bounds().intersect(&canvas);
    let area = if area.is_empty() { canvas } else { area };
    let (proxy, pw, ph) = build_proxy(&surf, area, want);
    if let Some(d) = app.camera_raw.as_mut() {
        (d.proxy, d.pw, d.ph) = (proxy, pw, ph);
        d.before_tex = None;
        d.dirty = true;
    }
}

/// Opens the dialog on the active layer.
pub fn open(app: &mut PhotosuiteApp, ctx: &egui::Context) -> Result<(), String> {
    photosuite_engine::commands::find("filter.cameraRaw").map(|c| (c.enabled)(&app.session)).unwrap_or(Err("unknown command".into()))?;
    let (layer, surf, _) = crate::distort_ui::active_pixels(app)?;
    let st = app.session.active().ok_or("no document")?;
    let canvas = st.doc.bounds();
    let name = st.doc.layer(layer).map(|l| l.name.clone()).unwrap_or_default();
    let area = surf.content_bounds().intersect(&canvas);
    let area = if area.is_empty() { canvas } else { area };
    let (w, h) = (area.width() as usize, area.height() as usize);
    let (proxy, pw, ph) = build_proxy(&surf, area, preview_side(ctx, w, h));
    let float = surf.format().sample == photosuite_color::SampleType::F32;
    let mut d = CameraRawDialog {
        layer,
        layer_name: name,
        params: CameraRaw::default(),
        proxy,
        pw,
        ph,
        full_w: w,
        full_h: h,
        float,
        tex: None,
        before_tex: None,
        dirty: true,
        show_before: false,
        mixer_tab: 1,
        render_ms: 0.0,
        wb_pick: false,
        opened_file: None,
        open_section: Some(tl!("Basic").to_string()),
        hist: Box::new([[0.0; 256]; 3]),
        hist_channel: HIST_COLOURS,
    };
    d.render(ctx);
    app.camera_raw = Some(d);
    Ok(())
}

/// Menu / control-channel entry point. `None` when the call isn't for this dialog.
pub fn menu(app: &mut PhotosuiteApp, ctx: &egui::Context, id: &str, params: &Value) -> Option<Result<Value, String>> {
    if id != "filter.cameraRaw" {
        return None;
    }
    let empty = params.as_object().is_none_or(|o| o.is_empty());
    if empty {
        return Some(open(app, ctx).map(|_| app.camera_raw.as_ref().map(|d| d.describe()).unwrap_or(Value::Null)));
    }
    let ui = params.get("ui")?;
    if app.camera_raw.is_none()
        && let Err(e) = open(app, ctx)
    {
        return Some(Err(e));
    }
    if let Some(set) = ui.get("set") {
        let d = app.camera_raw.as_mut()?;
        let mut cur = serde_json::to_value(&d.params).unwrap_or(json!({}));
        if let (Value::Object(c), Value::Object(s)) = (&mut cur, set) {
            for (k, v) in s {
                c.insert(k.clone(), v.clone());
            }
        }
        match serde_json::from_value::<CameraRaw>(cur) {
            Ok(p) => {
                d.params = p;
                d.render(ctx);
            }
            Err(e) => return Some(Err(format!("bad Camera Raw settings: {e}"))),
        }
    }
    if let Some(d) = app.camera_raw.as_mut() {
        if let Some(s) = ui.get("openSection") {
            d.open_section = s.as_str().map(str::to_string);
        }
        if ui.get("autoWhiteBalance").and_then(Value::as_bool) == Some(true) {
            d.neutralise(None);
        }
        if let Some([u, v]) = ui.get("whiteBalanceAt").and_then(Value::as_array).and_then(|a| <[Value; 2]>::try_from(a.clone()).ok()) {
            let (Some(u), Some(v)) = (u.as_f64(), v.as_f64()) else {
                return Some(Err("whiteBalanceAt is [u, v] in 0..=1".into()));
            };
            let x = ((u.clamp(0.0, 1.0) * d.pw as f64) as usize).min(d.pw.saturating_sub(1));
            let y = ((v.clamp(0.0, 1.0) * d.ph as f64) as usize).min(d.ph.saturating_sub(1));
            d.neutralise(Some((x, y)));
        }
        if d.dirty {
            d.render(ctx);
        }
    }
    if let Some(b) = ui.get("before").and_then(Value::as_bool)
        && let Some(d) = app.camera_raw.as_mut()
    {
        d.show_before = b;
    }
    if ui.get("cancel").and_then(Value::as_bool) == Some(true) {
        cancel(app, ctx);
        return Some(Ok(json!({"cancelled": true})));
    }
    if ui.get("commit").and_then(Value::as_bool) == Some(true) {
        return Some(commit(app));
    }
    Some(Ok(app.camera_raw.as_ref().map(|d| d.describe()).unwrap_or(Value::Null)))
}

fn commit(app: &mut PhotosuiteApp) -> Result<Value, String> {
    let d = app.camera_raw.take().ok_or(tl!("Camera Raw isn't open"))?;
    if d.params.is_identity() {
        return Ok(json!({"unchanged": true}));
    }
    let mut p = d.command_params();
    p["layer"] = json!(d.layer.0);
    app.run("filter.cameraRaw", p)
}

fn temp_stops() -> Vec<Color32> {
    vec![Color32::from_rgb(70, 120, 230), Color32::from_rgb(200, 200, 200), Color32::from_rgb(235, 200, 60)]
}
fn tint_stops() -> Vec<Color32> {
    vec![Color32::from_rgb(70, 190, 80), Color32::from_rgb(200, 200, 200), Color32::from_rgb(210, 80, 200)]
}

/// One labelled slider; marks the dialog dirty when it moves. Double-click resets it to 0.
fn row(ui: &mut egui::Ui, dirty: &mut bool, label: &str, v: &mut f32, range: std::ops::RangeInclusive<f32>, grad: Option<&[Color32]>) {
    row_reset(ui, dirty, label, v, range, grad, 0.0);
}

/// [`row`] for a slider whose rest value isn't 0.
fn row_reset(ui: &mut egui::Ui, dirty: &mut bool, label: &str, v: &mut f32, range: std::ops::RangeInclusive<f32>, grad: Option<&[Color32]>, rest: f32) {
    let r = widgets::slider_row(ui, label, v, range, "", grad);
    if r.changed() {
        *dirty = true;
    }
    if r.double_clicked() {
        *v = rest;
        *dirty = true;
    }
}

/// One panel of the accordion: only the section named by `open` is expanded; clicking a header
/// opens it and closes the rest (or closes it, when it was the open one).
fn section(ui: &mut egui::Ui, open: &mut Option<String>, title: &str, body: impl FnOnce(&mut egui::Ui)) {
    let is_open = open.as_deref() == Some(title);
    let r = egui::CollapsingHeader::new(egui::RichText::new(tl!(&title)).font(FontId::proportional(13.0)))
        .id_salt(("cr-section", title))
        .open(Some(is_open))
        .show(ui, body);
    if r.header_response.clicked() {
        *open = if is_open { None } else { Some(title.to_string()) };
    }
}

fn wheel(ui: &mut egui::Ui, dirty: &mut bool, title: &str, w: &mut Wheel) {
    widgets::section_label(ui, title);
    let hs = widgets::hue_stops();
    row(ui, dirty, tl!("Hue"), &mut w.hue, 0.0..=360.0, Some(&hs));
    row(ui, dirty, tl!("Saturation"), &mut w.sat, 0.0..=100.0, None);
    row(ui, dirty, tl!("Luminance"), &mut w.lum, -100.0..=100.0, None);
}

/// Small point-curve editor (master channel): click to add, drag to move, right-click to delete.
fn curve_editor(ui: &mut egui::Ui, p: &mut CameraRaw, dirty: &mut bool) {
    let t = Tokens::get(ui.ctx());
    let side = ui.available_width().min(260.0);
    let (rect, resp) = ui.allocate_exact_size(vec2(side, side), Sense::click_and_drag());
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, 2.0, t.field);
    for i in 1..4 {
        let f = i as f32 / 4.0;
        painter.line_segment([pos2(rect.left() + f * side, rect.top()), pos2(rect.left() + f * side, rect.bottom())], Stroke::new(1.0, t.separator));
        painter.line_segment([pos2(rect.left(), rect.top() + f * side), pos2(rect.right(), rect.top() + f * side)], Stroke::new(1.0, t.separator));
    }
    let to_screen = |x: f32, y: f32| pos2(rect.left() + x / 255.0 * side, rect.bottom() - y / 255.0 * side);
    let from_screen = |q: Pos2| [((q.x - rect.left()) / side * 255.0).clamp(0.0, 255.0), ((rect.bottom() - q.y) / side * 255.0).clamp(0.0, 255.0)];
    if p.point_curve.len() < 2 {
        p.point_curve = vec![[0.0, 0.0], [255.0, 255.0]];
    }
    // Interaction.
    let drag_id = ui.id().with("cr-curve-drag");
    // Stored as `Option<usize>`, so read back as one: reading it as `usize` found nothing, and
    // the point stopped following the pointer after the drag's first frame.
    let mut dragging: Option<usize> = ui.data(|d| d.get_temp::<Option<usize>>(drag_id)).flatten();
    if let Some(pos) = resp.interact_pointer_pos() {
        let q = from_screen(pos);
        if resp.drag_started() || resp.clicked() {
            // Where the press started, not where the pointer is once it has moved far enough to
            // count as a drag: grabbing a point mustn't add a new one beside it.
            let at = ui.input(|i| i.pointer.press_origin()).filter(|o| rect.contains(*o)).unwrap_or(pos);
            let near = p.point_curve.iter().position(|c| (to_screen(c[0], c[1]) - at).length() < 8.0);
            if resp.secondary_clicked() {
                if let Some(i) = near.filter(|i| *i != 0 && *i + 1 != p.point_curve.len()) {
                    p.point_curve.remove(i);
                    *dirty = true;
                }
            } else {
                let q = from_screen(at);
                dragging = Some(near.unwrap_or_else(|| {
                    p.point_curve.push(q);
                    p.point_curve.sort_by(|a, b| a[0].total_cmp(&b[0]));
                    *dirty = true;
                    p.point_curve.iter().position(|c| *c == q).unwrap_or(0)
                }));
            }
        }
        if resp.dragged()
            && let Some(i) = dragging
        {
            let n = p.point_curve.len();
            let lo = if i == 0 { 0.0 } else { p.point_curve[i - 1][0] + 1.0 };
            let hi = if i + 1 == n { 255.0 } else { p.point_curve[i + 1][0] - 1.0 };
            p.point_curve[i] = [q[0].clamp(lo, hi.max(lo)), q[1]];
            *dirty = true;
        }
    }
    if resp.drag_stopped() {
        dragging = None;
    }
    ui.data_mut(|d| d.insert_temp(drag_id, dragging));
    // Curve (point curve after the parametric one).
    let lut = curve_lut(&p.point_curve, 256);
    let pts: Vec<Pos2> = (0..256).map(|i| to_screen(i as f32, lut[i] * 255.0)).collect();
    painter.add(egui::Shape::line(pts, Stroke::new(1.5, t.text)));
    for c in &p.point_curve {
        painter.circle_stroke(to_screen(c[0], c[1]), 4.0, Stroke::new(1.5, t.accent));
    }
}

/// The dialog's largest size; smaller windows get a smaller one ([`widgets::tool_dialog_rect`]).
const DIALOG_MAX: egui::Vec2 = vec2(1400.0, 900.0);

pub fn show(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    open_pending(app, ctx);
    if app.camera_raw.is_none() {
        return;
    }
    refit_proxy(app, ctx);
    let t = Tokens::get(ctx);
    let rect = widgets::tool_dialog_rect(ctx, DIALOG_MAX);
    let mut action: Option<&str> = None;
    let heading = match app.camera_raw.as_ref() {
        Some(d) if d.opened_file.is_some() => format!("Camera Raw ({})", d.layer_name),
        Some(d) => format!("Camera Raw Filter ({})", d.layer_name),
        None => return,
    };
    // The dialogs' own frame (title bar, dragging, kept below the app's title bar), at a fixed size.
    crate::dialogs::frame(ctx, egui::Id::new("camera-raw-dialog"), &heading, crate::dialogs::FrameSize::Fixed(rect.size()), |ui, size| {
        let Some(d) = app.camera_raw.as_mut() else { return };
        if d.dirty {
            d.render(ctx);
        }
        let (full, _) = ui.allocate_exact_size(size.unwrap_or(rect.size()), Sense::click());
        let painter = ui.painter().clone();
        let footer_h = 48.0;
        let body = ERect::from_min_max(full.min, pos2(full.right(), full.bottom() - footer_h));
        // Preview.
        let view = ERect::from_min_max(body.min, pos2(body.right() - PANEL_W, body.bottom())).shrink(16.0);
        painter.rect_filled(view, 0.0, t.canvas);
        let tex = if d.show_before { d.before_tex.as_ref() } else { d.tex.as_ref() };
        if let Some(tex) = tex {
            let s = (view.width() / d.pw as f32).min(view.height() / d.ph as f32);
            let r = ERect::from_center_size(view.center(), vec2(d.pw as f32 * s, d.ph as f32 * s));
            widgets::checker(&painter, r, 8.0);
            painter.image(tex.id(), r, ERect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
            // White Balance eyedropper: click a neutral spot.
            if d.wb_pick
                && let Some(pos) = ui.ctx().pointer_hover_pos().filter(|p| r.contains(*p))
            {
                ui.ctx().set_cursor_icon(egui::CursorIcon::Crosshair);
                if ui.ctx().input(|i| i.pointer.primary_clicked()) {
                    let x = (((pos.x - r.left()) / s) as usize).min(d.pw.saturating_sub(1));
                    let y = (((pos.y - r.top()) / s) as usize).min(d.ph.saturating_sub(1));
                    d.neutralise(Some((x, y)));
                }
            }
        }
        // Panels.
        let right = ERect::from_min_max(pos2(body.right() - PANEL_W, body.top()), body.max);
        painter.rect_filled(right, 0.0, t.dock);
        painter.line_segment([right.left_top(), right.left_bottom()], Stroke::new(1.0, t.separator));
        let inner = right.shrink2(vec2(14.0, 10.0));
        // Histogram at the top, the panels scrolling below it.
        let head = ERect::from_min_size(inner.min, vec2(inner.width(), HIST_HEADER));
        let mut hu = ui.new_child(egui::UiBuilder::new().max_rect(head));
        histogram(&mut hu, d);
        painter.line_segment([pos2(right.left(), head.bottom() + 5.0), pos2(right.right(), head.bottom() + 5.0)], Stroke::new(1.0, t.separator));
        let mut props = ui.new_child(egui::UiBuilder::new().max_rect(ERect::from_min_max(pos2(inner.left(), head.bottom() + 12.0), inner.max)));
        let mut dirty = false;
        let (mut pick, mut auto) = (d.wb_pick, false);
        let mut open = d.open_section.clone();
        egui::ScrollArea::vertical().id_salt("camera-raw-props").show(&mut props, |ui| {
            ui.spacing_mut().item_spacing.y = 4.0;
            let p = &mut d.params;
            let (ts, tn) = (temp_stops(), tint_stops());
            section(ui, &mut open, tl!("Basic"), |ui| {
                ui.horizontal(|ui| {
                    widgets::section_label(ui, tl!("White Balance: As Shot"));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if crate::icons::button(ui, "tools-eyedropper", 22.0, pick, tl!("Eyedropper Tool")).clicked() {
                            pick = !pick;
                        }
                        auto = ui.small_button(tl!("Auto")).clicked();
                    });
                });
                row(ui, &mut dirty, tl!("Temperature"), &mut p.temperature, -100.0..=100.0, Some(&ts));
                row(ui, &mut dirty, tl!("Tint"), &mut p.tint, -100.0..=100.0, Some(&tn));
                row(ui, &mut dirty, tl!("Exposure"), &mut p.exposure, -5.0..=5.0, None);
                row(ui, &mut dirty, tl!("Contrast"), &mut p.contrast, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Highlights"), &mut p.highlights, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Shadows"), &mut p.shadows, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Whites"), &mut p.whites, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Blacks"), &mut p.blacks, -100.0..=100.0, None);
                widgets::hairline(ui);
                row(ui, &mut dirty, tl!("Texture"), &mut p.texture, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Clarity"), &mut p.clarity, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Dehaze"), &mut p.dehaze, -100.0..=100.0, None);
                widgets::hairline(ui);
                row(ui, &mut dirty, tl!("Vibrance"), &mut p.vibrance, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Saturation"), &mut p.saturation, -100.0..=100.0, None);
            });
            section(ui, &mut open, tl!("Curve"), |ui| {
                curve_editor(ui, p, &mut dirty);
                row(ui, &mut dirty, tl!("Highlights"), &mut p.curve_highlights, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Lights"), &mut p.curve_lights, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Darks"), &mut p.curve_darks, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Shadows"), &mut p.curve_shadows, -100.0..=100.0, None);
            });
            section(ui, &mut open, tl!("Detail"), |ui| {
                widgets::section_label(ui, tl!("Sharpening"));
                row(ui, &mut dirty, tl!("Amount"), &mut p.sharpen_amount, 0.0..=150.0, None);
                row(ui, &mut dirty, tl!("Radius"), &mut p.sharpen_radius, 0.5..=3.0, None);
                row(ui, &mut dirty, tl!("Detail"), &mut p.sharpen_detail, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Masking"), &mut p.sharpen_masking, 0.0..=100.0, None);
                widgets::section_label(ui, tl!("Noise Reduction"));
                row(ui, &mut dirty, tl!("Luminance"), &mut p.noise_luminance, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Luminance Detail"), &mut p.noise_luminance_detail, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Color"), &mut p.noise_color, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Color Detail"), &mut p.noise_color_detail, 0.0..=100.0, None);
            });
            section(ui, &mut open, tl!("Color Mixer"), |ui| {
                ui.horizontal(|ui| {
                    for (i, name) in [tl!("Hue"), tl!("Saturation"), tl!("Luminance")].iter().enumerate() {
                        if widgets::pill_tab(ui, name, d.mixer_tab == i).clicked() {
                            d.mixer_tab = i;
                        }
                    }
                });
                let arr = match d.mixer_tab {
                    0 => &mut p.hsl_hue,
                    1 => &mut p.hsl_sat,
                    _ => &mut p.hsl_lum,
                };
                for (k, name) in BANDS.iter().enumerate() {
                    let c = photosuite_algo::camera_raw::HSL_BANDS[k];
                    let base = hue_color(c);
                    let grad = [Color32::from_gray(128), base];
                    row(ui, &mut dirty, name, &mut arr[k], -100.0..=100.0, Some(&grad));
                }
            });
            section(ui, &mut open, tl!("Color Grading"), |ui| {
                wheel(ui, &mut dirty, tl!("Shadows"), &mut p.grade_shadows);
                wheel(ui, &mut dirty, tl!("Midtones"), &mut p.grade_midtones);
                wheel(ui, &mut dirty, tl!("Highlights"), &mut p.grade_highlights);
                wheel(ui, &mut dirty, tl!("Global"), &mut p.grade_global);
                row(ui, &mut dirty, tl!("Blending"), &mut p.grade_blending, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Balance"), &mut p.grade_balance, -100.0..=100.0, None);
            });
            section(ui, &mut open, tl!("Optics"), |ui| {
                row(ui, &mut dirty, tl!("Distortion"), &mut p.optics_distortion, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Vignetting"), &mut p.optics_vignetting, -100.0..=100.0, None);
            });
            section(ui, &mut open, tl!("Geometry"), |ui| {
                row(ui, &mut dirty, tl!("Vertical"), &mut p.geometry_vertical, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Horizontal"), &mut p.geometry_horizontal, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Rotate"), &mut p.geometry_rotate, -10.0..=10.0, None);
                row_reset(ui, &mut dirty, tl!("Scale"), &mut p.geometry_scale, 50.0..=150.0, None, 100.0);
            });
            section(ui, &mut open, tl!("Effects"), |ui| {
                widgets::section_label(ui, tl!("Grain"));
                row(ui, &mut dirty, tl!("Amount"), &mut p.grain_amount, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Size"), &mut p.grain_size, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Roughness"), &mut p.grain_roughness, 0.0..=100.0, None);
                widgets::section_label(ui, tl!("Vignetting"));
                let mut style = p.vignette_style.clone();
                if widgets::dropdown(
                    ui,
                    "cr-vig-style",
                    &mut style,
                    &[
                        ("highlightPriority".to_string(), tl!("Highlight Priority")),
                        ("colorPriority".to_string(), tl!("Color Priority")),
                        ("paintOverlay".to_string(), tl!("Paint Overlay")),
                    ],
                    200.0,
                ) {
                    p.vignette_style = style;
                    dirty = true;
                }
                row(ui, &mut dirty, tl!("Amount"), &mut p.vignette_amount, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Midpoint"), &mut p.vignette_midpoint, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Roundness"), &mut p.vignette_roundness, -100.0..=100.0, None);
                row(ui, &mut dirty, tl!("Feather"), &mut p.vignette_feather, 0.0..=100.0, None);
                row(ui, &mut dirty, tl!("Highlights"), &mut p.vignette_highlights, 0.0..=100.0, None);
            });
            section(ui, &mut open, tl!("Calibration"), |ui| {
                widgets::section_label(ui, tl!("Shadows"));
                let tint = tint_stops();
                row(ui, &mut dirty, tl!("Tint"), &mut p.calibration_shadow_tint, -100.0..=100.0, Some(&tint));
                for (title, hue, (h, s)) in [
                    (tl!("Red Primary"), 0.0, (&mut p.calibration_red_hue, &mut p.calibration_red_saturation)),
                    (tl!("Green Primary"), 120.0, (&mut p.calibration_green_hue, &mut p.calibration_green_saturation)),
                    (tl!("Blue Primary"), 240.0, (&mut p.calibration_blue_hue, &mut p.calibration_blue_saturation)),
                ] {
                    widgets::section_label(ui, title);
                    let hues = [hue_color(hue - 30.0), hue_color(hue), hue_color(hue + 30.0)];
                    row(ui, &mut dirty, tl!("Hue"), h, -100.0..=100.0, Some(&hues));
                    let sats = [Color32::from_gray(128), hue_color(hue)];
                    row(ui, &mut dirty, tl!("Saturation"), s, -100.0..=100.0, Some(&sats));
                }
            });
        });
        d.dirty |= dirty;
        d.wb_pick = pick;
        d.open_section = open;
        if auto {
            d.neutralise(None);
        }
        // Footer.
        let foot = ERect::from_min_max(pos2(full.left(), full.bottom() - footer_h), full.max);
        painter.rect_filled(foot, 0.0, t.dock);
        painter.line_segment([foot.left_top(), foot.right_top()], Stroke::new(1.0, t.separator));
        let mut fu = ui.new_child(egui::UiBuilder::new().max_rect(foot.shrink2(vec2(16.0, 9.0))).layout(egui::Layout::right_to_left(egui::Align::Center)));
        let ok = if d.opened_file.is_some() { tl!("Open") } else { tl!("OK") };
        if widgets::primary_button(&mut fu, ok, 90.0).clicked() {
            action = Some("ok");
        }
        if widgets::secondary_button(&mut fu, tl!("Cancel"), 90.0).clicked() {
            action = Some("cancel");
        }
        fu.add_space(12.0);
        widgets::checkbox(&mut fu, &mut d.show_before, tl!("Before (Y)"));
        fu.label(egui::RichText::new(format!("{:.0} ms", d.render_ms)).color(t.text_faint));
    });
    if ctx.input(|i| i.key_pressed(egui::Key::Y))
        && let Some(d) = app.camera_raw.as_mut()
    {
        d.show_before = !d.show_before;
    }
    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        action = Some("cancel");
    }
    match action {
        Some("ok") => {
            if let Err(e) = commit(app) {
                app.ui.status = e;
            }
        }
        Some("cancel") => cancel(app, ctx),
        _ => {}
    }
}

/// The Channel menu's Colours entry: red, green and blue overlaid.
const HIST_COLOURS: usize = 4;
/// Height of the histogram header (Channel menu and plot) above the panels.
const HIST_HEADER: f32 = 132.0;
/// The plot's height, and a bin holding this share of the pixels reaches its top.
const HIST_HEIGHT: f32 = 100.0;
const HIST_PEAK_SHARE: f32 = 1.0 / 60.0;
/// The develop output is 8-bit for display, so the bins comb; the plot smooths them over ±2.
const HIST_SMOOTH: usize = 2;

/// Red, green and blue histograms of straight-alpha pixels, at the 8-bit levels the preview
/// shows, each pixel counted by its alpha.
fn colour_histogram(px: &[[f32; 4]]) -> [[f32; 256]; 3] {
    let mut h = [[0.0f32; 256]; 3];
    let bin = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as usize;
    for q in px {
        let a = q[3].clamp(0.0, 1.0);
        if a <= 0.0 {
            continue;
        }
        for (c, hc) in h.iter_mut().enumerate() {
            if let Some(b) = hc.get_mut(bin(q[c])) {
                *b += a;
            }
        }
    }
    h
}

/// A triangular blur over ±`radius` bins (display only).
fn smooth_bins(bins: &[f32; 256], radius: usize) -> [f32; 256] {
    let r = radius as i64;
    let total: f32 = (-r..=r).map(|o| (r + 1 - o.abs()) as f32).sum();
    let mut out = [0.0f32; 256];
    for (i, o) in out.iter_mut().enumerate() {
        let sum: f32 = (-r..=r)
            .filter_map(|off| {
                let j = usize::try_from(i as i64 + off).ok()?;
                Some(bins.get(j)? * (r + 1 - off.abs()) as f32)
            })
            .sum();
        *o = sum / total.max(1.0);
    }
    out
}

/// One filled band: bin `i`'s height is `bins[i] * scale` of the plot, at most all of it.
/// Drawn with zero alpha (premultiplied), so bands add up: red and green overlap as yellow,
/// all three as white.
fn draw_band(p: &egui::Painter, r: ERect, bins: &[f32; 256], scale: f32, color: Color32) {
    let add = Color32::from_rgba_premultiplied(color.r(), color.g(), color.b(), 0);
    let mut mesh = egui::Mesh::default();
    let x = |i: usize| r.left() + i as f32 / 255.0 * r.width();
    let y = |v: f32| r.bottom() - (v * scale).clamp(0.0, 1.0) * r.height();
    for i in 0..255 {
        let (a, b) = (bins[i], bins[i + 1]);
        let n = mesh.vertices.len() as u32;
        for q in [pos2(x(i), r.bottom()), pos2(x(i), y(a)), pos2(x(i + 1), y(b)), pos2(x(i + 1), r.bottom())] {
            mesh.colored_vertex(q, add);
        }
        mesh.add_triangle(n, n + 1, n + 2);
        mesh.add_triangle(n, n + 2, n + 3);
    }
    p.add(mesh);
}

/// The histogram header: Channel menu, then the plot of the developed preview.
fn histogram(ui: &mut egui::Ui, d: &mut CameraRawDialog) {
    let t = Tokens::get(ui.ctx());
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(tl!("Channel:")).color(t.text_dim));
        let opts = [(0usize, "RGB"), (1, "Red"), (2, "Green"), (3, "Blue"), (HIST_COLOURS, "Colours")];
        widgets::dropdown(ui, "camera-raw-hist-channel", &mut d.hist_channel, &opts, ui.available_width().min(220.0));
    });
    ui.add_space(4.0);
    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), HIST_HEIGHT), Sense::hover());
    let p = ui.painter_at(r);
    // The bands add light, so the plot is dark and the bands light on every theme.
    p.rect_filled(r, t.radius_sm, Color32::from_gray(18));
    let fill = Color32::from_gray(205);
    let plot = r.shrink2(vec2(2.0, 1.0));
    let n = (d.pw * d.ph).max(1) as f32;
    let scale = 1.0 / (HIST_PEAK_SHARE * n);
    let h = d.hist.as_ref().map(|c| smooth_bins(&c, HIST_SMOOTH));
    match d.hist_channel {
        // RGB: the three channels' sum, at a third of the scale.
        0 => {
            let mut sum = [0.0f32; 256];
            for (i, v) in sum.iter_mut().enumerate() {
                *v = h[0][i] + h[1][i] + h[2][i];
            }
            draw_band(&p, plot, &sum, scale / 3.0, fill);
        }
        c @ 1..=3 => draw_band(&p, plot, &h[c - 1], scale, fill),
        _ => {
            for (c, color) in [Color32::from_rgb(255, 0, 0), Color32::from_rgb(0, 255, 0), Color32::from_rgb(0, 0, 255)].into_iter().enumerate() {
                draw_band(&p, plot, &h[c], scale, color);
            }
        }
    }
}

/// Opens Camera Raw on a camera file opened last frame, when it is still the active document.
fn open_pending(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let Some(id) = app.camera_raw_on_open.take() else { return };
    if app.camera_raw.is_some() || app.session.active().map(|d| d.doc.id) != Some(id) {
        return;
    }
    match open(app, ctx) {
        Ok(()) => {
            if let Some(d) = app.camera_raw.as_mut() {
                d.opened_file = Some(id);
                d.layer_name = app.session.active().map(|s| s.doc.name.clone()).unwrap_or_default();
            }
        }
        Err(e) => app.ui.status = e,
    }
}

/// Cancel: close the dialog; on a camera file being opened, close the file too (as Photoshop).
fn cancel(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let Some(d) = app.camera_raw.take() else { return };
    if let Some(id) = d.opened_file
        && let Some(i) = app.session.documents().iter().position(|s| s.doc.id == id)
        && let Err(e) = crate::menus::invoke(app, ctx, "file.close", json!({"document": i}))
    {
        app.ui.status = e;
    }
}

fn hue_color(h: f32) -> Color32 {
    let h6 = (h.rem_euclid(360.0)) / 60.0;
    let x = 1.0 - ((h6 % 2.0) - 1.0).abs();
    let (r, g, b) = match h6 as u32 {
        0 => (1.0, x, 0.0),
        1 => (x, 1.0, 0.0),
        2 => (0.0, 1.0, x),
        3 => (0.0, x, 1.0),
        4 => (x, 0.0, 1.0),
        _ => (1.0, 0.0, x),
    };
    Color32::from_rgb((r * 220.0) as u8, (g * 220.0) as u8, (b * 220.0) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_drives_the_engine() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
        let ctx = egui::Context::default();
        app.run("file.new", json!({"width": 64, "height": 48})).unwrap();
        app.run("layer.new.layer", json!({})).unwrap();
        app.run("edit.fill", json!({"color": "#808080"})).unwrap();
        let r = menu(&mut app, &ctx, "filter.cameraRaw", &json!({})).unwrap().unwrap();
        assert_eq!(r["proxy"], json!([64, 48]));
        let r = menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"set": {"exposure": 1.0, "vignetteAmount": -40}}})).unwrap().unwrap();
        assert_eq!(r["params"]["exposure"], 1.0);
        assert_eq!(app.camera_raw.as_ref().unwrap().command_params(), json!({"exposure": 1.0, "vignetteAmount": -40.0}));
        let before = app.session.active().unwrap().doc.layer(app.session.active().unwrap().active_layer.unwrap()).unwrap().surface().unwrap().rgba(32, 24);
        menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"commit": true}})).unwrap().unwrap();
        assert!(app.camera_raw.is_none());
        let after = app.session.active().unwrap().doc.layer(app.session.active().unwrap().active_layer.unwrap()).unwrap().surface().unwrap().rgba(32, 24);
        assert!(after[0] > before[0] + 0.1, "{before:?} → {after:?}");
        // Cancel leaves the document alone.
        menu(&mut app, &ctx, "filter.cameraRaw", &json!({})).unwrap().unwrap();
        let r = menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"cancel": true}})).unwrap().unwrap();
        assert_eq!(r["cancelled"], true);
        assert!(menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"set": {"exposure": "x"}}})).unwrap().is_err());
    }

    /// A dialog over the document, not a takeover: its OK button sits inside the centred
    /// dialog, short of the window's corner.
    #[test]
    fn camera_raw_is_a_dialog_over_the_document() {
        use egui_kittest::kittest::Queryable;
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
        app.run("file.new", json!({"width": 64, "height": 48})).unwrap();
        let mut h =
            egui_kittest::Harness::builder().with_size(egui::vec2(1600.0, 1000.0)).build_ui_state(|ui, app: &mut PhotosuiteApp| show(app, ui.ctx()), app);
        PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
        let ctx = h.ctx.clone();
        menu(h.state_mut(), &ctx, "filter.cameraRaw", &json!({})).unwrap().unwrap();
        h.run_steps(3);
        let ok = h.get_by_label("OK").rect();
        let dialog = widgets::tool_dialog_rect(&ctx, DIALOG_MAX);
        assert!(dialog.contains_rect(ok), "OK {ok:?} inside the dialog {dialog:?}");
        assert!(ok.right() < 1600.0 - 32.0 && ok.bottom() < 1000.0 - 32.0, "not in the window's corner: {ok:?}");
        // Dragging the title bar moves it, like the other dialogs.
        let from = pos2(dialog.center().x, dialog.top() + 12.0);
        h.hover_at(from);
        h.drag_at(from);
        h.run_steps(2);
        for i in 1..=10 {
            h.hover_at(from + vec2(-8.0, 5.0) * i as f32);
            h.run_steps(1);
        }
        h.drop_at(from + vec2(-80.0, 50.0));
        h.run_steps(3);
        let moved = h.get_by_label("OK").rect();
        assert!(moved.left() < ok.left() - 40.0 && moved.top() > ok.top() + 20.0, "{ok:?} → {moved:?}");
        // However far it is dragged, it stays on screen.
        let from = moved.center() - (ok.center() - from);
        h.hover_at(from);
        h.drag_at(from);
        h.run_steps(2);
        for i in 1..=10 {
            h.hover_at(from + vec2(-200.0, 200.0) * i as f32);
            h.run_steps(1);
        }
        h.drop_at(from + vec2(-2000.0, 2000.0));
        h.run_steps(3);
        let far = h.get_by_label("OK").rect();
        assert!(far.bottom() <= 1000.0, "{far:?}");
        // Nor into the title bar: on macOS that is the system's, under the traffic lights, and a
        // drag there would move the whole window.
        let from = far.center() - (ok.center() - pos2(dialog.center().x, dialog.top() + 12.0));
        h.hover_at(from);
        h.drag_at(from);
        h.run_steps(2);
        for i in 1..=10 {
            h.hover_at(from + vec2(0.0, -200.0) * i as f32);
            h.run_steps(1);
        }
        h.drop_at(from + vec2(0.0, -2000.0));
        h.run_steps(3);
        // The title sits a frame margin (and a point) below the dialog's top edge.
        let margin = f32::from(ctx.global_style().spacing.menu_margin.top) + 1.0;
        let top = h.get_by_label_contains("Camera Raw Filter").rect().top() - margin;
        let bar = crate::panels::title_bar_height(&ctx);
        assert!((top - bar).abs() < 1.5, "dialog top {top} stops at the title bar ({bar})");
    }

    /// Dragging on the curve adds a point there and it follows the pointer for the whole drag
    /// (it used to stop after the first frame), and dragging it again moves it rather than
    /// adding another beside it.
    #[test]
    fn curve_point_follows_a_long_drag_and_can_be_dragged_again() {
        use egui_kittest::kittest::Queryable;
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
        app.run("file.new", json!({"width": 64, "height": 48})).unwrap();
        let mut h =
            egui_kittest::Harness::builder().with_size(egui::vec2(1600.0, 1000.0)).build_ui_state(|ui, app: &mut PhotosuiteApp| show(app, ui.ctx()), app);
        PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
        let ctx = h.ctx.clone();
        menu(h.state_mut(), &ctx, "filter.cameraRaw", &json!({})).unwrap().unwrap();
        h.state_mut().camera_raw.as_mut().unwrap().open_section = Some("Curve".into());
        h.run_steps(3);
        let curve = |h: &egui_kittest::Harness<'_, PhotosuiteApp>| h.state().camera_raw.as_ref().unwrap().params.point_curve.clone();
        // Drags by `by` in 30 steps; returns the curve after the first step (the drag has begun).
        let drag = |h: &mut egui_kittest::Harness<'_, PhotosuiteApp>, from: Pos2, by: egui::Vec2| {
            h.hover_at(from);
            h.drag_at(from);
            h.run_steps(2);
            let mut early = Vec::new();
            for i in 1..=30 {
                h.hover_at(from + by * (i as f32 / 30.0));
                h.run_steps(1);
                if i == 3 {
                    early = h.state().camera_raw.as_ref().unwrap().params.point_curve.clone();
                }
            }
            h.drop_at(from + by);
            h.run_steps(2);
            early
        };
        // The editor's square starts just under the header, at the panel's left edge.
        let header = h.get_by_label("Curve").rect();
        let from = pos2(header.left() + 100.0, header.bottom() + 130.0);
        let early = drag(&mut h, from, vec2(45.0, -60.0));
        let c = curve(&h);
        assert_eq!(c.len(), 3, "one point added: {c:?}");
        let (added, first) = (early[1], c[1]);
        // Most of the 45 x 60 pt came after the drag's first frames: the point kept following.
        assert!(first[0] - added[0] > 20.0 && first[1] - added[1] > 30.0, "followed the whole drag: {added:?} → {first:?}");
        // Grab it where it ended up and drag it back down: it moves, nothing is added.
        drag(&mut h, from + vec2(45.0, -60.0), vec2(-20.0, 40.0));
        let c = curve(&h);
        assert_eq!(c.len(), 3, "no point added beside it: {c:?}");
        assert!(c[1][0] < first[0] - 10.0 && c[1][1] < first[1] - 20.0, "{first:?} → {:?}", c[1]);
    }

    #[test]
    fn histogram_counts_the_preview_by_alpha_and_smooths_for_display() {
        let px = [[1.0, 0.0, 0.5, 1.0], [1.0, 0.0, 0.5, 0.5], [0.2, 0.2, 0.2, 0.0], [f32::NAN, 2.0, -1.0, 1.0]];
        let h = colour_histogram(&px);
        assert_eq!((h[0][255], h[1][0], h[2][128]), (1.5, 1.5, 1.5), "half-transparent pixels count half");
        assert_eq!(h[0][51], 0.0, "fully transparent pixels don't count");
        assert_eq!((h[0][0], h[1][255], h[2][0]), (1.0, 1.0, 1.0), "out-of-range and NaN values land in the end bins");
        let mut spike = [0.0; 256];
        spike[100] = 9.0;
        let sm = smooth_bins(&spike, 2);
        assert_eq!((sm[100], sm[99], sm[98], sm[97]), (3.0, 2.0, 1.0, 0.0));
        assert!((sm.iter().sum::<f32>() - 9.0).abs() < 1e-4, "smoothing keeps the total away from the ends");
        assert_eq!(smooth_bins(&spike, 0), spike);
        smooth_bins(&[1.0; 256], 300);
    }

    #[test]
    fn camera_files_open_into_camera_raw_and_cancel_closes_them() {
        let services = crate::Services {
            import: Some(Box::new(|name: &str, _: &[u8]| {
                let mut d = photosuite_doc::Document::new(
                    name,
                    photosuite_geom::Size::new(32, 24),
                    photosuite_color::ColorMode::Rgb,
                    photosuite_color::SampleType::U16,
                );
                d.layers
                    .push(photosuite_doc::Layer::new("Background", photosuite_doc::LayerContent::Raster(photosuite_raster::Surface::new(d.pixel_format()))));
                Ok((d, Vec::new()))
            })),
            ..Default::default()
        };
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), services);
        let ctx = egui::Context::default();
        crate::theme::install_fonts(&ctx);
        let frame = |app: &mut PhotosuiteApp| {
            ctx.run_ui(egui::RawInput::default(), |ui| show(app, ui.ctx())).textures_delta.clear();
        };
        app.open_file("/shoot/IMG_0001.CR3", b"raw").unwrap();
        frame(&mut app);
        let d = app.camera_raw.as_ref().expect("Camera Raw opened on the camera file");
        assert!(d.opened_file.is_some());
        // Cancel closes the file again.
        menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"cancel": true}})).unwrap().unwrap();
        assert!(app.camera_raw.is_none());
        assert!(app.session.documents().is_empty());
        // Ordinary files open as they always did.
        app.open_file("/shoot/flat.png", b"png").unwrap();
        frame(&mut app);
        assert!(app.camera_raw.is_none());
        assert!(is_raw_name("a.nef") && !is_raw_name("a.psd") && !is_raw_name("dng"));
    }

    #[test]
    fn white_balance_auto_and_eyedropper() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
        let ctx = egui::Context::default();
        app.run("file.new", json!({"width": 64, "height": 48})).unwrap();
        app.run("layer.new.layer", json!({})).unwrap();
        app.run("edit.fill", json!({"color": "#8c8073"})).unwrap(); // a warm grey
        menu(&mut app, &ctx, "filter.cameraRaw", &json!({})).unwrap().unwrap();
        let r = menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"autoWhiteBalance": true}})).unwrap().unwrap();
        let t = r["params"]["temperature"].as_f64().unwrap();
        assert!(t < -5.0, "a warm cast is cooled: {t}");
        // The eyedropper on the same colour lands on the same setting.
        menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"set": {"temperature": 0, "tint": 0}}})).unwrap().unwrap();
        let r = menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"whiteBalanceAt": [0.5, 0.5]}})).unwrap().unwrap();
        assert_eq!(r["params"]["temperature"].as_f64().unwrap(), t);
        assert!(menu(&mut app, &ctx, "filter.cameraRaw", &json!({"ui": {"whiteBalanceAt": ["a", 1]}})).unwrap().is_err());
    }
}
