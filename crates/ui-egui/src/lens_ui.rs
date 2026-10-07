//! Filter › Lens Correction…: Photoshop's dialog. A tool strip (grid, straighten, hand) and a
//! zoomable preview on the left; Auto Correction (profile corrections, auto scale, edge, and the
//! camera / lens search over the measured profiles) and Custom (distortion, chromatic
//! aberration, vignette, transform, grid) tabs on the right.
//!
//! The preview runs the same [`photosuite_algo::lens::correct`] the command does, on a proxy of
//! the layer sized to the dialog (a large modal over the document). OK runs `filter.lensCorrection` with the dialog's params (one
//! history step; a smart filter on a smart object).
//!
//! Control channel: `ui.menu.invoke {"id":"filter.lensCorrection","params":{"ui":{"set":{…},
//! "tab":"auto|custom", "straighten":[[x,y],[x,y]] (0..=1 of the image), "commit":true |
//! "cancel":true}}}`; the reply describes the dialog.

use egui::{Align2, Color32, FontId, Pos2, Rect as ERect, Sense, Stroke, TextureHandle, pos2, vec2};
use photosuite_doc::LayerId;
use photosuite_geom::Rect;
use photosuite_raster::Surface;
use serde_json::{Map, Value, json};

use crate::PhotosuiteApp;
use crate::theme::Tokens;
use crate::widgets;

const PANEL_W: f32 = 330.0;
const STRIP_W: f32 = 40.0;
const CMD: &str = "filter.lensCorrection";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Auto,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Hand,
    Straighten,
}

pub struct LensDialog {
    pub layer: LayerId,
    /// The command's params as the dialog edits them.
    pub params: Map<String, Value>,
    pub tab: Tab,
    pub tool: Tool,
    pub show_grid: bool,
    pub grid_size: f32,
    pub preview: bool,
    /// 0 = fit; otherwise screen points per proxy pixel.
    zoom: f32,
    pan: egui::Vec2,
    proxy: Surface,
    pw: usize,
    ph: usize,
    /// The layer's full width (the zoom readout is relative to it, like the canvas's).
    full_w: usize,
    info: Option<photosuite_algo::exif::CameraInfo>,
    /// Camera search (maker, model) for the Lens Model list.
    maker: String,
    model: String,
    tex: Option<TextureHandle>,
    before: Option<TextureHandle>,
    dirty: bool,
    /// Straighten drag in proxy pixels.
    line: Option<([f32; 2], [f32; 2])>,
    pub render_ms: f64,
}

fn defaults() -> Map<String, Value> {
    let v = json!({
        "profile": "none", "correctDistortion": true, "correctCA": true, "correctVignette": true, "autoScale": false, "edge": "transparency",
        "distortion": 0.0, "redCyan": 0.0, "greenMagenta": 0.0, "blueYellow": 0.0, "vignetteAmount": 0.0, "vignetteMidpoint": 50.0,
        "vertical": 0.0, "horizontal": 0.0, "angle": 0.0, "scale": 100.0
    });
    v.as_object().cloned().unwrap_or_default()
}

impl LensDialog {
    pub fn describe(&self) -> Value {
        json!({"layer": self.layer.0, "params": Value::Object(self.params.clone()), "tab": if self.tab == Tab::Auto { "auto" } else { "custom" }, "proxy": [self.pw, self.ph], "renderMs": self.render_ms})
    }

    fn num(&self, k: &str) -> f32 {
        self.params.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32
    }

    fn flag(&self, k: &str) -> bool {
        self.params.get(k).and_then(Value::as_bool).unwrap_or(false)
    }

    fn render(&mut self, ctx: &egui::Context) {
        let t0 = crate::gpu_canvas::now_ms();
        let frame = Rect::new(0, 0, self.pw as i32, self.ph as i32);
        let p = Value::Object(self.params.clone());
        let out = match photosuite_engine::lens_cmds::lens_params(CMD, &p, frame, self.info.as_ref()) {
            Ok(lc) => photosuite_algo::lens::correct(&self.proxy, frame, &lc),
            Err(_) => self.proxy.clone(),
        };
        let img = image(&out, self.pw, self.ph);
        match &mut self.tex {
            Some(t) => t.set(img, egui::TextureOptions::LINEAR),
            None => self.tex = Some(ctx.load_texture("lens-correction-after", img, egui::TextureOptions::LINEAR)),
        }
        if self.before.is_none() {
            self.before = Some(ctx.load_texture("lens-correction-before", image(&self.proxy, self.pw, self.ph), egui::TextureOptions::LINEAR));
        }
        self.render_ms = crate::gpu_canvas::now_ms() - t0;
        self.dirty = false;
    }
}

fn image(s: &Surface, w: usize, h: usize) -> egui::ColorImage {
    let mut px = vec![[0.0f32; 4]; w * h];
    s.read_rgba_into(Rect::new(0, 0, w as i32, h as i32), &mut px);
    let enc = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    egui::ColorImage::new([w, h], px.iter().map(|q| Color32::from_rgba_unmultiplied(enc(q[0]), enc(q[1]), enc(q[2]), enc(q[3]))).collect())
}

/// Opens the dialog on the active layer.
pub fn open(app: &mut PhotosuiteApp, ctx: &egui::Context) -> Result<(), String> {
    photosuite_engine::commands::find(CMD).map(|c| (c.enabled)(&app.session)).unwrap_or(Err("unknown command".into()))?;
    let (layer, surf, _) = crate::distort_ui::active_pixels(app)?;
    let st = app.session.active().ok_or("no document")?;
    let canvas = st.doc.bounds();
    let info = st.doc.metadata.exif.as_ref().map(|e| photosuite_algo::exif::read(e));
    let (w, h) = (canvas.width() as usize, canvas.height() as usize);
    let screen = crate::widgets::tool_dialog_rect(ctx, DIALOG_MAX);
    let fit = ((screen.width() - PANEL_W - STRIP_W - 32.0) / w.max(1) as f32).min((screen.height() - 120.0) / h.max(1) as f32);
    let side = ((w.max(h) as f32 * fit * ctx.pixels_per_point()).round() as usize).clamp(256, 2400);
    let (px, pw, ph) = crate::camera_raw_ui::build_proxy(&surf, canvas, side);
    let mut proxy = Surface::new(photosuite_color::PixelFormat::RGBA32F);
    let flat: Vec<f32> = px.iter().flat_map(|q| *q).collect();
    proxy.write_region(Rect::new(0, 0, pw as i32, ph as i32), &flat);
    let mut d = LensDialog {
        layer,
        params: defaults(),
        tab: Tab::Custom,
        tool: Tool::Hand,
        show_grid: false,
        grid_size: 64.0,
        preview: true,
        zoom: 0.0,
        pan: egui::Vec2::ZERO,
        proxy,
        pw,
        ph,
        full_w: w,
        info,
        maker: String::new(),
        model: String::new(),
        tex: None,
        before: None,
        dirty: true,
        line: None,
        render_ms: 0.0,
    };
    // The photograph's own camera and lens, when the profiles know them (Auto Correction).
    if let (Some(db), Some(i)) = (photosuite_engine::lens_cmds::lens_database(), d.info.as_ref())
        && let Some(cal) = db.for_photo(i)
    {
        if let Some(c) = db.match_camera(i.make.as_deref(), i.model.as_deref()) {
            d.maker = c.maker.clone();
            d.model = c.model.clone();
        }
        d.params.insert("profile".into(), json!("measured"));
        d.params.insert("lens".into(), json!(cal.lens));
        d.tab = Tab::Auto;
    }
    d.render(ctx);
    app.lens = Some(d);
    Ok(())
}

/// Menu / control-channel entry point. `None` when the call isn't for this dialog.
pub fn menu(app: &mut PhotosuiteApp, ctx: &egui::Context, id: &str, params: &Value) -> Option<Result<Value, String>> {
    if id != CMD {
        return None;
    }
    let empty = params.as_object().is_none_or(|o| o.is_empty());
    if empty {
        return Some(open(app, ctx).map(|_| app.lens.as_ref().map(|d| d.describe()).unwrap_or(Value::Null)));
    }
    // Scripts with real params run the command directly.
    let ui = params.get("ui")?;
    if app.lens.is_none()
        && let Err(e) = open(app, ctx)
    {
        return Some(Err(e));
    }
    let d = app.lens.as_mut()?;
    if let Some(Value::Object(set)) = ui.get("set") {
        for (k, v) in set {
            d.params.insert(k.clone(), v.clone());
        }
        d.dirty = true;
    }
    match ui.get("tab").and_then(Value::as_str) {
        Some("auto") => d.tab = Tab::Auto,
        Some("custom") => d.tab = Tab::Custom,
        _ => {}
    }
    if let Some(Value::Array(line)) = ui.get("straighten") {
        let pt = |v: &Value| -> Option<[f64; 2]> { Some([v.get(0)?.as_f64()? * d.pw as f64, v.get(1)?.as_f64()? * d.ph as f64]) };
        if let (Some(a), Some(b)) = (line.first().and_then(pt), line.get(1).and_then(pt)) {
            straighten(d, a, b);
        }
    }
    if d.dirty {
        d.render(ctx);
    }
    if ui.get("cancel").and_then(Value::as_bool) == Some(true) {
        app.lens = None;
        return Some(Ok(json!({"cancelled": true})));
    }
    if ui.get("commit").and_then(Value::as_bool) == Some(true) {
        return Some(commit(app));
    }
    Some(Ok(app.lens.as_ref().map(|d| d.describe()).unwrap_or(Value::Null)))
}

/// The Straighten tool: turn the image so the line `a → b` (proxy px) is level or plumb.
fn straighten(d: &mut LensDialog, a: [f64; 2], b: [f64; 2]) {
    if (b[0] - a[0]).hypot(b[1] - a[1]) < 3.0 {
        return;
    }
    let angle = f64::from(d.num("angle")) + photosuite_algo::lens::straighten_angle(a, b);
    d.params.insert("angle".into(), json!((angle * 100.0).round() / 100.0));
    d.dirty = true;
}

fn commit(app: &mut PhotosuiteApp) -> Result<Value, String> {
    let d = app.lens.take().ok_or("Lens Correction isn't open")?;
    let mut p = d.params.clone();
    p.insert("layer".into(), json!(d.layer.0));
    // Search fields only steer the dialog's lens list.
    if d.params.get("profile").and_then(Value::as_str) == Some("measured") && !d.model.is_empty() {
        p.insert("cameraMaker".into(), json!(d.maker));
        p.insert("cameraModel".into(), json!(d.model));
    }
    app.run(CMD, Value::Object(p))
}

fn slider(ui: &mut egui::Ui, d: &mut LensDialog, key: &str, label: &str, range: std::ops::RangeInclusive<f32>, unit: &str, rest: f32) {
    let mut v = d.params.get(key).and_then(Value::as_f64).map_or(rest, |x| x as f32);
    let r = widgets::slider_row(ui, label, &mut v, range, unit, None);
    if r.double_clicked() {
        v = rest;
    }
    if r.changed() || r.double_clicked() {
        d.params.insert(key.into(), json!((v * 100.0).round() / 100.0));
        d.dirty = true;
    }
}

fn check(ui: &mut egui::Ui, d: &mut LensDialog, key: &str, label: &str) {
    let mut b = d.flag(key);
    if widgets::checkbox(ui, &mut b, label).changed() {
        d.params.insert(key.into(), json!(b));
        d.dirty = true;
    }
}

fn heading(ui: &mut egui::Ui, text: &str) {
    let t = Tokens::get(ui.ctx());
    ui.add_space(6.0);
    ui.label(egui::RichText::new(text).font(crate::theme::semibold(13.0)).color(t.text));
}

/// The angle dial: drag around it to turn the image (0° at the top, clockwise).
fn angle_dial(ui: &mut egui::Ui, d: &mut LensDialog) {
    let t = Tokens::get(ui.ctx());
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(format!("{}:", tl!("Angle"))).color(t.text_dim));
        let (r, resp) = ui.allocate_exact_size(vec2(44.0, 44.0), Sense::click_and_drag());
        let c = r.center();
        let a = d.num("angle").to_radians();
        ui.painter().circle_stroke(c, 20.0, Stroke::new(1.5, t.text_dim));
        ui.painter().line_segment([c, c + vec2(a.sin(), -a.cos()) * 18.0], Stroke::new(1.5, t.accent));
        if let Some(p) = resp.interact_pointer_pos().filter(|_| resp.dragged() || resp.clicked()) {
            let v = p - c;
            let deg = v.x.atan2(-v.y).to_degrees();
            let deg = if deg > 180.0 { deg - 360.0 } else { deg };
            d.params.insert("angle".into(), json!((deg * 100.0).round() / 100.0));
            d.dirty = true;
        }
        let mut v = d.num("angle");
        if widgets::value_field(ui, &mut v, -180.0..=180.0, "°", 64.0).changed() {
            d.params.insert("angle".into(), json!(v));
            d.dirty = true;
        }
    });
}

fn custom_tab(ui: &mut egui::Ui, d: &mut LensDialog) {
    heading(ui, tl!("Geometric Distortion"));
    slider(ui, d, "distortion", tl!("Remove Distortion"), -100.0..=100.0, "", 0.0);
    heading(ui, tl!("Chromatic Aberration"));
    slider(ui, d, "redCyan", tl!("Fix Red/Cyan Fringe"), -100.0..=100.0, "", 0.0);
    slider(ui, d, "greenMagenta", tl!("Fix Green/Magenta Fringe"), -100.0..=100.0, "", 0.0);
    slider(ui, d, "blueYellow", tl!("Fix Blue/Yellow Fringe"), -100.0..=100.0, "", 0.0);
    heading(ui, tl!("Vignette"));
    slider(ui, d, "vignetteAmount", tl!("Amount"), -100.0..=100.0, "", 0.0);
    slider(ui, d, "vignetteMidpoint", tl!("Midpoint"), 0.0..=100.0, "", 50.0);
    heading(ui, tl!("Transform"));
    slider(ui, d, "vertical", tl!("Vertical Perspective"), -100.0..=100.0, "", 0.0);
    slider(ui, d, "horizontal", tl!("Horizontal Perspective"), -100.0..=100.0, "", 0.0);
    angle_dial(ui, d);
    slider(ui, d, "scale", tl!("Scale"), 50.0..=150.0, "%", 100.0);
    ui.add_space(6.0);
    widgets::checkbox(ui, &mut d.show_grid, tl!("Show Grid"));
    widgets::slider_row(ui, tl!("Size"), &mut d.grid_size, 4.0..=200.0, "px", None);
}

fn auto_tab(ui: &mut egui::Ui, d: &mut LensDialog) {
    let t = Tokens::get(ui.ctx());
    heading(ui, tl!("Correction"));
    check(ui, d, "correctDistortion", tl!("Geometric Distortion"));
    check(ui, d, "correctCA", tl!("Chromatic Aberration"));
    check(ui, d, "correctVignette", tl!("Vignette"));
    check(ui, d, "autoScale", tl!("Auto Scale Image"));
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(tl!("Edge")).color(t.text_dim));
        let mut e = d.params.get("edge").and_then(Value::as_str).unwrap_or("transparency").to_string();
        let opts = [
            ("edgeExtension".to_string(), tl!("Edge Extension")),
            ("transparency".to_string(), tl!("Transparency")),
            ("black".to_string(), tl!("Black Color")),
            ("white".to_string(), tl!("White Color")),
        ];
        if widgets::dropdown(ui, "lens-edge", &mut e, &opts, 170.0) {
            d.params.insert("edge".into(), json!(e));
            d.dirty = true;
        }
    });
    heading(ui, tl!("Search Criteria"));
    let Some(db) = photosuite_engine::lens_cmds::lens_database() else {
        ui.label(egui::RichText::new(tl!("Lens profiles aren't available")).color(t.text_faint));
        return;
    };
    let field = |ui: &mut egui::Ui, label: &str, id: &str, cur: &mut String, opts: Vec<String>, none: &str| -> bool {
        let mut changed = false;
        ui.horizontal(|ui| {
            ui.add_sized([96.0, 20.0], egui::Label::new(egui::RichText::new(label).color(t.text_dim)));
            let o: Vec<(String, &str)> = opts.iter().map(|n| (n.clone(), if n.is_empty() { none } else { n.as_str() })).collect();
            changed = widgets::dropdown(ui, id, cur, &o, 200.0);
        });
        changed
    };
    let mut makers: Vec<String> = db.cameras.iter().map(|c| c.maker.clone()).collect();
    makers.sort_by_key(|m| m.to_lowercase());
    makers.dedup();
    makers.insert(0, String::new());
    if field(ui, tl!("Camera Make"), "lens-maker", &mut d.maker, makers, tl!("All")) {
        d.model.clear();
    }
    let mut models: Vec<String> = db.cameras.iter().filter(|c| c.maker == d.maker).map(|c| c.model.clone()).collect();
    models.sort_by_key(|m| m.to_lowercase());
    models.insert(0, String::new());
    field(ui, tl!("Camera Model"), "lens-model", &mut d.model, models, tl!("All"));
    let camera = db.cameras.iter().find(|c| c.maker == d.maker && c.model == d.model);
    let focal = d.info.as_ref().and_then(|i| i.focal_length).unwrap_or(0.0);
    let mut lenses = vec![String::new()];
    lenses.extend(db.lenses_for(camera).into_iter().filter(|l| l.covers_focal_length(focal)).map(|l| l.display_name()));
    let mut lens = d.params.get("lens").and_then(Value::as_str).unwrap_or("").to_string();
    if field(ui, tl!("Lens Model"), "lens-lens", &mut lens, lenses, tl!("None")) {
        if lens.is_empty() {
            d.params.remove("lens");
            d.params.insert("profile".into(), json!("none"));
        } else {
            d.params.insert("lens".into(), json!(lens));
            d.params.insert("profile".into(), json!("measured"));
        }
        d.dirty = true;
    }
    ui.add_space(6.0);
    let note = match d.params.get("profile").and_then(Value::as_str) {
        Some("measured") => lens,
        _ => tl!("No lens profile selected").to_string(),
    };
    ui.label(egui::RichText::new(note).color(t.text_faint).size(11.5));
}

/// The dialog's largest size; smaller windows get a smaller one.
const DIALOG_MAX: egui::Vec2 = vec2(1280.0, 860.0);

/// Draws the dialog (a large modal over the document) while it is open.
pub fn show(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    if app.lens.is_none() {
        return;
    }
    let t = Tokens::get(ctx);
    let rect = crate::widgets::tool_dialog_rect(ctx, DIALOG_MAX);
    let mut action: Option<&str> = None;
    crate::widgets::tool_dialog(ctx, egui::Id::new("lens-correction-dialog"), rect, 34.0, |ui, full| {
        let Some(d) = app.lens.as_mut() else { return };
        if d.dirty {
            d.render(ctx);
        }
        let painter = ui.painter().clone();
        let title = ERect::from_min_size(full.min, vec2(full.width(), 34.0));
        painter.rect_filled(title, crate::widgets::tool_dialog_corners(ctx, true, true, true), t.dock);
        painter.line_segment([title.left_bottom(), title.right_bottom()], Stroke::new(1.0, t.separator));
        painter.text(pos2(title.left() + 16.0, title.center().y), Align2::LEFT_CENTER, tl!("Lens Correction"), crate::theme::semibold(14.0), t.text);
        let body = ERect::from_min_max(pos2(full.left(), title.bottom()), full.max);
        // Tool strip.
        let strip = ERect::from_min_max(body.min, pos2(body.left() + STRIP_W, body.bottom()));
        painter.rect_filled(strip, crate::widgets::tool_dialog_corners(ctx, false, true, false), t.dock);
        let mut su = ui.new_child(egui::UiBuilder::new().max_rect(strip.shrink2(vec2(6.0, 10.0))).layout(egui::Layout::top_down(egui::Align::Center)));
        if crate::icons::button(&mut su, "tools-grid-4x4", 28.0, d.show_grid, tl!("Show Grid")).clicked() {
            d.show_grid = !d.show_grid;
        }
        if crate::icons::button(&mut su, "tools-keyframe-align-horizontal", 28.0, d.tool == Tool::Straighten, tl!("Straighten Tool")).clicked() {
            d.tool = Tool::Straighten;
        }
        if crate::icons::button(&mut su, "tools-hand", 28.0, d.tool == Tool::Hand, tl!("Hand Tool")).clicked() {
            d.tool = Tool::Hand;
        }
        // Preview.
        let view = ERect::from_min_max(pos2(strip.right(), body.top()), pos2(body.right() - PANEL_W, body.bottom()));
        painter.rect_filled(view, 0.0, t.canvas);
        let fit = (view.width() / d.pw as f32).min(view.height() / d.ph as f32) * 0.95;
        let k = if d.zoom > 0.0 { d.zoom } else { fit };
        let img = ERect::from_center_size(view.center() + d.pan, vec2(d.pw as f32 * k, d.ph as f32 * k));
        let vp = ui.interact(view, egui::Id::new("lens-view"), Sense::click_and_drag());
        let clip = painter.with_clip_rect(view);
        widgets::checker(&clip, img, 8.0);
        let tex = if d.preview { d.tex.as_ref() } else { d.before.as_ref() };
        if let Some(tex) = tex {
            clip.image(tex.id(), img, ERect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0)), Color32::WHITE);
        }
        if d.show_grid {
            let step = (d.grid_size * k).max(4.0);
            let col = Color32::from_rgba_unmultiplied(128, 128, 128, 140);
            let mut x = img.left();
            while x <= img.right() {
                clip.line_segment([pos2(x, img.top()), pos2(x, img.bottom())], Stroke::new(1.0, col));
                x += step;
            }
            let mut y = img.top();
            while y <= img.bottom() {
                clip.line_segment([pos2(img.left(), y), pos2(img.right(), y)], Stroke::new(1.0, col));
                y += step;
            }
        }
        let to_px = |p: Pos2| [(p.x - img.left()) / k, (p.y - img.top()) / k];
        match d.tool {
            Tool::Hand => {
                if vp.dragged() {
                    d.pan += vp.drag_delta();
                }
            }
            Tool::Straighten => {
                if let Some(p) = vp.interact_pointer_pos() {
                    if vp.drag_started() {
                        d.line = Some((to_px(p), to_px(p)));
                    } else if vp.dragged()
                        && let Some(l) = d.line.as_mut()
                    {
                        l.1 = to_px(p);
                    }
                }
                if vp.drag_stopped()
                    && let Some((a, b)) = d.line.take()
                {
                    straighten(d, [f64::from(a[0]), f64::from(a[1])], [f64::from(b[0]), f64::from(b[1])]);
                }
                if let Some((a, b)) = d.line {
                    let s = |q: [f32; 2]| pos2(img.left() + q[0] * k, img.top() + q[1] * k);
                    clip.line_segment([s(a), s(b)], Stroke::new(1.5, t.accent));
                }
            }
        }
        // Zoom control.
        let zr = ERect::from_min_size(pos2(view.left(), view.bottom() - 26.0), vec2(118.0, 26.0));
        painter.rect_filled(zr, 0.0, Color32::from_black_alpha(200));
        let mut zu = ui.new_child(egui::UiBuilder::new().max_rect(zr.shrink2(vec2(6.0, 3.0))).layout(egui::Layout::left_to_right(egui::Align::Center)));
        // Screen points per document pixel, as the canvas's zoom.
        let pct = k * d.pw as f32 / d.full_w.max(1) as f32;
        if zu.small_button("−").clicked() {
            d.zoom = (k / 1.25).max(0.05);
        }
        zu.label(egui::RichText::new(format!("{:.0}%", pct * 100.0)).color(t.text).font(FontId::monospace(11.0)));
        if zu.small_button("+").clicked() {
            d.zoom = (k * 1.25).min(16.0);
        }
        // Panel.
        let right = ERect::from_min_max(pos2(body.right() - PANEL_W, body.top()), body.max);
        painter.rect_filled(right, crate::widgets::tool_dialog_corners(ctx, false, false, true), t.dock);
        painter.line_segment([right.left_top(), right.left_bottom()], Stroke::new(1.0, t.separator));
        let foot_h = 92.0;
        let mut pu = ui
            .new_child(egui::UiBuilder::new().max_rect(ERect::from_min_max(right.min + vec2(14.0, 10.0), pos2(right.right() - 14.0, right.bottom() - foot_h))));
        pu.horizontal(|ui| {
            for (tab, label) in [(Tab::Auto, tl!("Auto Correction")), (Tab::Custom, tl!("Custom"))] {
                if ui.selectable_label(d.tab == tab, label).clicked() {
                    d.tab = tab;
                }
            }
        });
        pu.separator();
        egui::ScrollArea::vertical().id_salt("lens-props").show(&mut pu, |ui| match d.tab {
            Tab::Auto => auto_tab(ui, d),
            Tab::Custom => custom_tab(ui, d),
        });
        let foot = ERect::from_min_max(pos2(right.left() + 14.0, right.bottom() - foot_h + 6.0), right.max - vec2(14.0, 10.0));
        let mut fu = ui.new_child(egui::UiBuilder::new().max_rect(foot).layout(egui::Layout::top_down_justified(egui::Align::Min)));
        widgets::checkbox(&mut fu, &mut d.preview, tl!("Preview"));
        fu.horizontal(|ui| {
            if widgets::secondary_button(ui, tl!("Reset"), 90.0).clicked() {
                d.params = defaults();
                d.dirty = true;
            }
            if widgets::secondary_button(ui, tl!("Cancel"), 90.0).clicked() {
                action = Some("cancel");
            }
            if widgets::primary_button(ui, tl!("OK"), 90.0).clicked() {
                action = Some("ok");
            }
        });
    });
    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        action = Some("cancel");
    }
    match action {
        Some("ok") => {
            if let Err(e) = commit(app) {
                app.ui.status = e;
            }
        }
        Some("cancel") => app.lens = None,
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_previews_and_commits_the_command() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
        let ctx = egui::Context::default();
        app.run("file.new", json!({"width": 120, "height": 80})).unwrap();
        app.run("layer.new.layer", json!({})).unwrap();
        app.run("edit.fill", json!({"color": "#808080"})).unwrap();
        let r = menu(&mut app, &ctx, CMD, &json!({})).unwrap().unwrap();
        assert_eq!(r["tab"], "custom");
        // Straighten a line 5° off level: the angle turns it back.
        let a = 5f64.to_radians();
        let r = menu(&mut app, &ctx, CMD, &json!({"ui": {"straighten": [[0.1, 0.5], [0.1 + 0.8 * a.cos(), 0.5 + 0.8 * a.sin() * 120.0 / 80.0]]}}))
            .unwrap()
            .unwrap();
        let angle = r["params"]["angle"].as_f64().unwrap();
        assert!((angle.abs() - 5.0).abs() < 0.5, "{angle}");
        let r = menu(&mut app, &ctx, CMD, &json!({"ui": {"set": {"vignetteAmount": -60, "greenMagenta": 20}, "tab": "auto"}})).unwrap().unwrap();
        assert_eq!(r["tab"], "auto");
        let before = app.session.active().unwrap().doc.layers.len();
        menu(&mut app, &ctx, CMD, &json!({"ui": {"commit": true}})).unwrap().unwrap();
        assert!(app.lens.is_none());
        assert_eq!(app.session.active().unwrap().doc.layers.len(), before);
        assert!(app.session.undo(), "one history step to undo");
        // Cancel leaves the document alone.
        menu(&mut app, &ctx, CMD, &json!({})).unwrap().unwrap();
        let r = menu(&mut app, &ctx, CMD, &json!({"ui": {"cancel": true}})).unwrap().unwrap();
        assert_eq!(r["cancelled"], true);
    }
}
