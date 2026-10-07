//! Photoshop-style Layer Style dialog: effect list with checkboxes on the left, parameters on the right.
//! State lives in the dialog's `fields` (JSON), so automation can drive it like any other dialog.

use egui::{Color32, RichText, Sense, Stroke, StrokeKind, vec2};
use photosuite_color::ColorMode;
use photosuite_doc::blend_if::BlendRange;
use photosuite_doc::effects::{FxPaint, StrokePosition};
use photosuite_doc::{Effect, Layer};
use serde_json::{Map, Value, json};

use crate::theme::Tokens;
use crate::{PhotosuiteApp, widgets};

#[derive(Clone, Copy)]
enum P {
    Slider(f32, f32, &'static str),
    Color,
    Blend,
    Choice(&'static [(&'static str, &'static str)]),
    Check,
    /// A pattern from the dialog's `patternList` field (`[[id, name], …]`).
    Pattern,
}

/// Effect kinds in Photoshop's list order: (command kind, label, params).
/// The Blending Options page id (not an effect).
pub const BLENDING: &str = "blendingOptions";

pub const KINDS: &[(&str, &str)] = &[
    ("bevelEmboss", "Bevel & Emboss"),
    ("stroke", "Stroke"),
    ("innerShadow", "Inner Shadow"),
    ("innerGlow", "Inner Glow"),
    ("satin", "Satin"),
    ("colorOverlay", "Color Overlay"),
    ("gradientOverlay", "Gradient Overlay"),
    ("patternOverlay", "Pattern Overlay"),
    ("outerGlow", "Outer Glow"),
    ("dropShadow", "Drop Shadow"),
];

fn spec(kind: &str) -> &'static [(&'static str, &'static str, P)] {
    const POS: &[(&str, &str)] = &[("outside", "Outside"), ("inside", "Inside"), ("center", "Center")];
    const GSTYLE: &[(&str, &str)] = &[("linear", "Linear"), ("radial", "Radial"), ("angle", "Angle"), ("reflected", "Reflected"), ("diamond", "Diamond")];
    const BSTYLE: &[(&str, &str)] = &[("inner", "Inner Bevel"), ("outer", "Outer Bevel"), ("emboss", "Emboss"), ("pillow", "Pillow Emboss")];
    const DIR: &[(&str, &str)] = &[("up", "Up"), ("down", "Down")];
    const SRC: &[(&str, &str)] = &[("edge", "Edge"), ("center", "Center")];
    match kind {
        "dropShadow" => &[
            ("blend", "Blend Mode", P::Blend),
            ("color", "Color", P::Color),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("angle", "Angle", P::Slider(-180.0, 180.0, "°")),
            ("useGlobalLight", "Use Global Light", P::Check),
            ("distance", "Distance", P::Slider(0.0, 300.0, "px")),
            ("spread", "Spread", P::Slider(0.0, 100.0, "%")),
            ("size", "Size", P::Slider(0.0, 250.0, "px")),
            ("knocksOut", "Layer Knocks Out Drop Shadow", P::Check),
        ],
        "innerShadow" => &[
            ("blend", "Blend Mode", P::Blend),
            ("color", "Color", P::Color),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("angle", "Angle", P::Slider(-180.0, 180.0, "°")),
            ("useGlobalLight", "Use Global Light", P::Check),
            ("distance", "Distance", P::Slider(0.0, 300.0, "px")),
            ("choke", "Choke", P::Slider(0.0, 100.0, "%")),
            ("size", "Size", P::Slider(0.0, 250.0, "px")),
        ],
        "outerGlow" => &[
            ("blend", "Blend Mode", P::Blend),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("color", "Color", P::Color),
            ("spread", "Spread", P::Slider(0.0, 100.0, "%")),
            ("size", "Size", P::Slider(0.0, 250.0, "px")),
            ("range", "Range", P::Slider(1.0, 100.0, "%")),
        ],
        "innerGlow" => &[
            ("blend", "Blend Mode", P::Blend),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("color", "Color", P::Color),
            ("source", "Source", P::Choice(SRC)),
            ("choke", "Choke", P::Slider(0.0, 100.0, "%")),
            ("size", "Size", P::Slider(0.0, 250.0, "px")),
        ],
        "stroke" => &[
            ("size", "Size", P::Slider(1.0, 250.0, "px")),
            ("position", "Position", P::Choice(POS)),
            ("blend", "Blend Mode", P::Blend),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("color", "Color", P::Color),
        ],
        "colorOverlay" => &[("blend", "Blend Mode", P::Blend), ("color", "Color", P::Color), ("opacity", "Opacity", P::Slider(0.0, 100.0, "%"))],
        "gradientOverlay" => &[
            ("blend", "Blend Mode", P::Blend),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("from", "From", P::Color),
            ("to", "To", P::Color),
            ("reverse", "Reverse", P::Check),
            ("style", "Style", P::Choice(GSTYLE)),
            ("angle", "Angle", P::Slider(-180.0, 180.0, "°")),
            ("scale", "Scale", P::Slider(10.0, 150.0, "%")),
        ],
        "patternOverlay" => &[
            ("blend", "Blend Mode", P::Blend),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("pattern", "Pattern", P::Pattern),
            ("angle", "Angle", P::Slider(-180.0, 180.0, "°")),
            ("scale", "Scale", P::Slider(1.0, 1000.0, "%")),
            ("link", "Link with Layer", P::Check),
        ],
        "bevelEmboss" => &[
            ("style", "Style", P::Choice(BSTYLE)),
            ("depth", "Depth", P::Slider(1.0, 1000.0, "%")),
            ("direction", "Direction", P::Choice(DIR)),
            ("size", "Size", P::Slider(0.0, 250.0, "px")),
            ("soften", "Soften", P::Slider(0.0, 16.0, "px")),
            ("angle", "Angle", P::Slider(-180.0, 180.0, "°")),
            ("useGlobalLight", "Use Global Light", P::Check),
            ("altitude", "Altitude", P::Slider(0.0, 90.0, "°")),
        ],
        "satin" => &[
            ("blend", "Blend Mode", P::Blend),
            ("color", "Color", P::Color),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("angle", "Angle", P::Slider(-180.0, 180.0, "°")),
            ("distance", "Distance", P::Slider(0.0, 250.0, "px")),
            ("size", "Size", P::Slider(0.0, 250.0, "px")),
            ("invert", "Invert", P::Check),
        ],
        BLENDING => &[
            ("blend", "Blend Mode", P::Blend),
            ("opacity", "Opacity", P::Slider(0.0, 100.0, "%")),
            ("fillOpacity", "Fill Opacity", P::Slider(0.0, 100.0, "%")),
        ],
        _ => &[],
    }
}

fn defaults(kind: &str) -> Value {
    match kind {
        "dropShadow" => {
            json!({"blend": "Multiply", "color": "#000000", "opacity": 75, "angle": 120, "useGlobalLight": true, "distance": 5, "spread": 0, "size": 5, "knocksOut": true})
        }
        "innerShadow" => {
            json!({"blend": "Multiply", "color": "#000000", "opacity": 75, "angle": 120, "useGlobalLight": true, "distance": 5, "choke": 0, "size": 5})
        }
        "outerGlow" => json!({"blend": "Screen", "opacity": 75, "color": "#ffffbe", "spread": 0, "size": 5, "range": 50}),
        "innerGlow" => json!({"blend": "Screen", "opacity": 75, "color": "#ffffbe", "source": "edge", "choke": 0, "size": 5}),
        "stroke" => json!({"size": 3, "position": "outside", "blend": "Normal", "opacity": 100, "color": "#000000"}),
        "colorOverlay" => json!({"blend": "Normal", "color": "#ff0000", "opacity": 100}),
        "gradientOverlay" => {
            json!({"blend": "Normal", "opacity": 100, "from": "#000000", "to": "#ffffff", "reverse": false, "style": "linear", "angle": 90, "scale": 100})
        }
        "patternOverlay" => json!({"blend": "Normal", "opacity": 100, "pattern": "", "angle": 0, "scale": 100, "link": true}),
        "bevelEmboss" => {
            json!({"style": "inner", "depth": 100, "direction": "up", "size": 5, "soften": 0, "angle": 120, "useGlobalLight": true, "altitude": 30})
        }
        "satin" => json!({"blend": "Multiply", "color": "#000000", "opacity": 50, "angle": 19, "distance": 11, "size": 14, "invert": true}),
        _ => json!({}),
    }
}

fn hex(c: &photosuite_doc::Color) -> String {
    let [r, g, b, _] = c.to_rgba8();
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn kind_of(e: &Effect) -> &'static str {
    match e {
        Effect::DropShadow(_) => "dropShadow",
        Effect::InnerShadow(_) => "innerShadow",
        Effect::OuterGlow(_) => "outerGlow",
        Effect::InnerGlow(_) => "innerGlow",
        Effect::Stroke(_) => "stroke",
        Effect::ColorOverlay { .. } => "colorOverlay",
        Effect::GradientOverlay { .. } => "gradientOverlay",
        Effect::PatternOverlay { .. } => "patternOverlay",
        Effect::Satin(_) => "satin",
        Effect::BevelEmboss(_) => "bevelEmboss",
    }
}

/// Current values of an existing effect, in the command's parameter units.
/// `light` is the document's global light angle: an effect that uses it shows that angle.
fn values_of(e: &Effect, light: f32) -> Value {
    let mut v = defaults(kind_of(e));
    let set = |v: &mut Value, k: &str, x: Value| {
        v[k] = x;
    };
    match e {
        Effect::DropShadow(s) | Effect::InnerShadow(s) => {
            set(&mut v, "blend", json!(s.common.blend.label()));
            set(&mut v, "opacity", json!((s.common.opacity * 100.0).round()));
            set(&mut v, "color", json!(hex(&s.color)));
            set(&mut v, "angle", json!(if s.use_global_light { light } else { s.angle }));
            set(&mut v, "useGlobalLight", json!(s.use_global_light));
            set(&mut v, "distance", json!(s.distance));
            set(&mut v, if matches!(e, Effect::DropShadow(_)) { "spread" } else { "choke" }, json!((s.spread * 100.0).round()));
            set(&mut v, "size", json!(s.size));
        }
        Effect::OuterGlow(g) | Effect::InnerGlow(g) => {
            set(&mut v, "blend", json!(g.common.blend.label()));
            set(&mut v, "opacity", json!((g.common.opacity * 100.0).round()));
            if let FxPaint::Color(c) = &g.paint {
                set(&mut v, "color", json!(hex(c)));
            }
            set(&mut v, if matches!(e, Effect::OuterGlow(_)) { "spread" } else { "choke" }, json!((g.spread * 100.0).round()));
            set(&mut v, "size", json!(g.size));
            set(&mut v, "range", json!((g.range * 100.0).round()));
        }
        Effect::Stroke(s) => {
            set(&mut v, "blend", json!(s.common.blend.label()));
            set(&mut v, "opacity", json!((s.common.opacity * 100.0).round()));
            set(&mut v, "size", json!(s.size));
            set(
                &mut v,
                "position",
                json!(match s.position {
                    StrokePosition::Inside => "inside",
                    StrokePosition::Center => "center",
                    _ => "outside",
                }),
            );
            if let FxPaint::Color(c) = &s.paint {
                set(&mut v, "color", json!(hex(c)));
            }
        }
        Effect::ColorOverlay { common, color } => {
            set(&mut v, "blend", json!(common.blend.label()));
            set(&mut v, "opacity", json!((common.opacity * 100.0).round()));
            set(&mut v, "color", json!(hex(color)));
        }
        Effect::GradientOverlay { common, .. } => {
            set(&mut v, "blend", json!(common.blend.label()));
            set(&mut v, "opacity", json!((common.opacity * 100.0).round()));
        }
        Effect::Satin(s) => {
            set(&mut v, "blend", json!(s.common.blend.label()));
            set(&mut v, "opacity", json!((s.common.opacity * 100.0).round()));
            set(&mut v, "color", json!(hex(&s.color)));
            set(&mut v, "angle", json!(s.angle));
            set(&mut v, "distance", json!(s.distance));
            set(&mut v, "size", json!(s.size));
            set(&mut v, "invert", json!(s.invert));
        }
        Effect::BevelEmboss(b) => {
            set(&mut v, "depth", json!(b.depth));
            set(&mut v, "size", json!(b.size));
            set(&mut v, "soften", json!(b.soften));
            set(&mut v, "angle", json!(if b.use_global_light { light } else { b.angle }));
            set(&mut v, "useGlobalLight", json!(b.use_global_light));
            set(&mut v, "altitude", json!(b.altitude));
            set(&mut v, "direction", json!(if b.up { "up" } else { "down" }));
        }
        Effect::PatternOverlay { common, name, id, scale, angle, link, phase } => {
            set(&mut v, "blend", json!(common.blend.label()));
            set(&mut v, "opacity", json!((common.opacity * 100.0).round()));
            set(&mut v, "pattern", json!(if id.is_empty() { name } else { id }));
            set(&mut v, "scale", json!((scale * 100.0).round()));
            set(&mut v, "angle", json!(angle));
            set(&mut v, "link", json!(link));
            set(&mut v, "phaseX", json!(phase.0));
            set(&mut v, "phaseY", json!(phase.1));
        }
    }
    v
}

/// Which Advanced Blending controls a mode gets: the compositor applies Channels and Blend If to
/// RGB, Grayscale and Duotone documents only, so other modes don't show them.
fn blend_mode_key(mode: ColorMode) -> Option<&'static str> {
    match mode {
        ColorMode::Rgb => Some("rgb"),
        ColorMode::Grayscale | ColorMode::Duotone => Some("gray"),
        _ => None,
    }
}

/// Dialog fields for a layer: selected kind, and per kind {enabled, params}. `light` is the
/// document's global light angle, shown by effects that use it.
pub fn initial_fields(layer: &Layer, mode: ColorMode, select: Option<&str>, light: f32) -> Map<String, Value> {
    let mut f = Map::new();
    f.insert("layer".into(), json!(layer.id.0));
    f.insert("globalLight".into(), json!(light));
    let mut bo = json!({"blend": layer.blend.label(), "opacity": (layer.opacity * 100.0).round(), "fillOpacity": (layer.fill_opacity * 100.0).round()});
    if let Some(key) = blend_mode_key(mode) {
        let n = mode.color_channels();
        bo["channels"] = json!((0..n).map(|i| layer.excluded_channels & 1 << i == 0).collect::<Vec<_>>());
        let entry = |i: usize, [this, under]: [BlendRange; 2]| json!({"channel": i, "thisLayer": this.to_bytes(), "underlying": under.to_bytes()});
        bo["blendIf"] = if key == "gray" {
            // One channel: the dialog edits entry 1 (what the command calls "gray"); entry 0 (the
            // PSD composite, honoured too) is read when 1 is unset and reset on OK.
            let one = if layer.blend_if.get(1).iter().all(BlendRange::is_full) { layer.blend_if.get(0) } else { layer.blend_if.get(1) };
            json!([entry(0, [BlendRange::FULL; 2]), entry(1, one)])
        } else {
            Value::Array((0..=n).map(|i| entry(i, layer.blend_if.get(i))).collect())
        };
        f.insert("__mode".into(), json!(key));
        f.insert("__blendIfChannel".into(), json!(usize::from(key == "gray")));
    }
    f.insert(format!("p:{BLENDING}"), bo);
    f.insert("__preview".into(), json!(true));
    let mut first = None;
    for &(kind, _) in KINDS {
        let existing = layer.effects.items.iter().find(|e| kind_of(e) == kind);
        if existing.is_some() && first.is_none() {
            first = Some(kind);
        }
        f.insert(format!("on:{kind}"), json!(existing.is_some_and(|e| e.enabled())));
        let params = existing.map(|e| values_of(e, light)).unwrap_or_else(|| {
            let mut params = defaults(kind);
            if params.get("useGlobalLight").and_then(Value::as_bool) == Some(true) {
                params["angle"] = json!(light);
            }
            params
        });
        f.insert(format!("p:{kind}"), params);
    }
    let sel = select.or(first).unwrap_or("dropShadow");
    f.insert("selected".into(), json!(sel));
    if select.is_some() {
        f.insert(format!("on:{sel}"), json!(true));
    }
    f
}

pub fn open(app: &mut PhotosuiteApp, select: Option<&str>) -> Option<u64> {
    let st = app.session.active()?;
    let layer = st.doc.layer(st.active_layer?)?.clone();
    let light = st.doc.global_light.angle;
    let mut f = initial_fields(&layer, st.doc.mode, select, light);
    f.insert("patternList".into(), pattern_list(app));
    Some(app.ui.open_dialog(crate::state::DialogKind::LayerStyle, f))
}

/// `[[id, name], …]` of the patterns a style can use (document's, then the library's).
pub fn pattern_list(app: &PhotosuiteApp) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let doc_pats = app.session.active().map(|d| d.doc.patterns.clone()).unwrap_or_default();
    for p in doc_pats.iter().chain(app.session.patterns.items.iter()) {
        if seen.insert(p.id.clone()) {
            out.push(json!([p.id, p.display_name()]));
        }
    }
    Value::Array(out)
}

/// Apply the dialog: replace the layer's effects with the enabled ones.
pub fn confirm(app: &mut PhotosuiteApp, f: &Map<String, Value>) -> Result<Value, String> {
    apply(f, |id, p| app.run(id, p))
}

/// Runs the dialog's commands through `run`: blending options, clear, then each enabled effect.
fn apply(f: &Map<String, Value>, mut run: impl FnMut(&str, Value) -> Result<Value, String>) -> Result<Value, String> {
    let layer = f.get("layer").cloned().unwrap_or(Value::Null);
    let initial_light_angle = f.get("globalLight").and_then(Value::as_f64);
    if let Some(Value::Object(bo)) = f.get(&format!("p:{BLENDING}")) {
        let mut p = Value::Object(bo.clone());
        p["layer"] = layer.clone();
        run("layer.layerStyle.blendingOptions", p)?;
    }
    let _ = run("layer.layerStyle.clear", json!({"layer": layer}));
    // An effect lit by the global light follows the document's light angle, so the Angle slider
    // drives that shared angle rather than the per-effect angle the compositor ignores.
    let mut light_angle: Option<f64> = None;
    for &(kind, _) in KINDS {
        if f.get(&format!("on:{kind}")).and_then(Value::as_bool) == Some(true) {
            let mut p = f.get(&format!("p:{kind}")).cloned().unwrap_or_else(|| json!({}));
            p["layer"] = layer.clone();
            if p.get("useGlobalLight").and_then(Value::as_bool) == Some(true)
                && let Some(angle) = p.get("angle").and_then(Value::as_f64)
                && initial_light_angle.is_none_or(|initial| angle != initial)
            {
                light_angle = Some(angle);
            }
            run(&format!("layer.layerStyle.{kind}"), p)?;
        }
    }
    if let Some(angle) = light_angle {
        run("layer.layerStyle.globalLight", json!({"angle": angle}))?;
    }
    Ok(Value::Null)
}

/// Hash of the fields that change the rendered style (not the selected page).
pub fn preview_hash(f: &Map<String, Value>) -> u64 {
    f.iter()
        .filter(|(k, _)| k.as_str() == "layer" || k.starts_with("on:") || k.starts_with("p:"))
        .flat_map(|(k, v)| k.bytes().chain(v.to_string().into_bytes()))
        .fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3))
}

/// `doc` with the dialog's style applied, run on a scratch session (no history) for the live preview.
pub fn preview_document(
    doc: &photosuite_doc::Document,
    patterns: &photosuite_engine::pattern_cmds::PatternLibrary,
    f: &Map<String, Value>,
) -> Option<photosuite_doc::Document> {
    let mut s = photosuite_engine::Session::new();
    s.patterns = patterns.clone();
    s.add_document(doc.clone(), None);
    apply(f, |id, p| s.execute(id, p).map_err(|e| e.to_string())).ok()?;
    s.active().map(|d| (*d.doc).clone())
}

/// Dialog body (left list, right parameters).
pub fn body(ui: &mut egui::Ui, f: &mut Map<String, Value>, patterns: &photosuite_engine::pattern_cmds::PatternLibrary) {
    let t = Tokens::get(ui.ctx());
    let selected = f.get("selected").and_then(Value::as_str).unwrap_or("dropShadow").to_string();
    // Column separators: gaps laid out with the columns, drawn afterwards over the row's full height.
    let mut seps = Vec::new();
    let gap = |ui: &mut egui::Ui| ui.allocate_exact_size(vec2(17.0, 1.0), Sense::hover()).0.center().x;
    let row = ui.horizontal_top(|ui| {
        // The same height on every page, so switching pages doesn't resize the dialog.
        ui.set_min_height(BODY_HEIGHT);
        // Left: effect list.
        ui.vertical(|ui| {
            ui.set_width(190.0);
            ui.label(RichText::new(tl!("Styles")).color(t.text_faint));
            // Blending Options page (layer blend mode, opacity and fill opacity).
            let bo = ui.add(
                egui::Label::new(RichText::new(tl!("Blending Options")).color(if selected == BLENDING { t.text } else { t.text_dim })).sense(Sense::click()),
            );
            if bo.clicked() {
                f.insert("selected".into(), json!(BLENDING));
            }
            ui.add_space(4.0);
            for &(kind, label) in KINDS {
                let (rect, resp) = ui.allocate_exact_size(vec2(190.0, 26.0), Sense::click());
                let is_sel = kind == selected;
                if is_sel {
                    ui.painter().rect_filled(rect, t.radius_sm, t.row_selected.gamma_multiply(if t.pro { 1.0 } else { 0.0 }).max_alpha(t.hover));
                } else if resp.hovered() {
                    ui.painter().rect_filled(rect, t.radius_sm, t.hover.gamma_multiply(0.5));
                }
                let key = format!("on:{kind}");
                let mut on = f.get(&key).and_then(Value::as_bool).unwrap_or(false);
                let cb = egui::Rect::from_min_size(rect.min + vec2(6.0, 6.0), vec2(14.0, 14.0));
                let cresp = ui.interact(cb, ui.id().with(("fxcb", kind)), Sense::click());
                if on {
                    ui.painter().rect_filled(cb, 2.0, t.accent);
                    ui.painter().line_segment([cb.left_center() + vec2(3.0, 0.5), cb.center_bottom() + vec2(-1.0, -3.5)], Stroke::new(1.8, Color32::WHITE));
                    ui.painter().line_segment([cb.center_bottom() + vec2(-1.0, -3.5), cb.right_top() + vec2(-3.0, 3.5)], Stroke::new(1.8, Color32::WHITE));
                } else {
                    ui.painter().rect_stroke(cb, 2.0, Stroke::new(1.5, t.text_faint), StrokeKind::Inside);
                }
                ui.painter().text(
                    rect.left_center() + vec2(28.0, 0.0),
                    egui::Align2::LEFT_CENTER,
                    tl!(label),
                    egui::FontId::proportional(12.5),
                    if on || is_sel { t.text } else { t.text_dim },
                );
                if cresp.clicked() {
                    on = !on;
                    f.insert(key, json!(on));
                    f.insert("selected".into(), json!(kind));
                } else if resp.clicked() {
                    f.insert("selected".into(), json!(kind));
                    f.insert(key, json!(true));
                }
            }
        });
        seps.push(gap(ui));
        // Right: parameters of the selected effect.
        ui.vertical(|ui| {
            ui.set_width(330.0);
            let label = KINDS.iter().find(|k| k.0 == selected).map(|k| k.1).unwrap_or(if selected == BLENDING { "Blending Options" } else { "" });
            ui.label(RichText::new(tl!(&label)).font(crate::theme::semibold(14.0)).color(t.text));
            ui.add_space(6.0);
            let pkey = format!("p:{selected}");
            let mut p = f.get(&pkey).cloned().unwrap_or_else(|| defaults(&selected));
            for &(key, label, kind) in spec(&selected) {
                match (selected.as_str(), key) {
                    (BLENDING, "blend") => group(ui, "General Blending", false),
                    (BLENDING, "fillOpacity") => group(ui, "Advanced Blending", true),
                    _ => {}
                }
                match kind {
                    P::Slider(min, max, unit) => {
                        let mut v = p.get(key).and_then(Value::as_f64).unwrap_or(min as f64) as f32;
                        if widgets::slider_row(ui, label, &mut v, min..=max, unit, None).changed() {
                            p[key] = json!(v.round());
                        }
                    }
                    P::Color => {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(tl!(&label)).color(t.text_dim));
                            let hexs = p.get(key).and_then(Value::as_str).unwrap_or("#000000").to_string();
                            let mut c = parse_hex(&hexs);
                            if ui.color_edit_button_srgba(&mut c).changed() {
                                p[key] = json!(format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b()));
                            }
                        });
                    }
                    P::Blend => {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(tl!(&label)).color(t.text_dim));
                            let mut cur = p.get(key).and_then(Value::as_str).unwrap_or("Normal").to_string();
                            let opts: Vec<(String, &str)> =
                                photosuite_color::BlendMode::LAYER_MODES.iter().map(|m| (m.label().to_string(), m.label())).collect();
                            if widgets::dropdown(ui, &format!("fx-blend-{selected}"), &mut cur, &opts, 150.0) {
                                p[key] = json!(cur);
                            }
                        });
                    }
                    P::Choice(options) => {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(tl!(&label)).color(t.text_dim));
                            let mut cur = p.get(key).and_then(Value::as_str).unwrap_or(options[0].0).to_string();
                            let opts: Vec<(String, &str)> = options.iter().map(|(v, l)| (v.to_string(), *l)).collect();
                            if widgets::dropdown(ui, &format!("fx-{selected}-{key}"), &mut cur, &opts, 150.0) {
                                p[key] = json!(cur);
                            }
                        });
                    }
                    P::Pattern => {
                        let list: Vec<(String, String)> = f
                            .get("patternList")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(|e| Some((e.get(0)?.as_str()?.to_string(), e.get(1)?.as_str()?.to_string()))).collect())
                            .unwrap_or_default();
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(tl!(&label)).color(t.text_dim));
                            let mut cur = p
                                .get(key)
                                .and_then(Value::as_str)
                                .filter(|c| !c.is_empty())
                                .map(str::to_string)
                                .or_else(|| list.first().map(|l| l.0.clone()))
                                .unwrap_or_default();
                            let opts: Vec<(String, &str)> = list.iter().map(|(id, n)| (id.clone(), n.as_str())).collect();
                            if widgets::dropdown(ui, &format!("fx-{selected}-{key}"), &mut cur, &opts, 180.0)
                                || p.get(key).and_then(Value::as_str).is_none_or(str::is_empty)
                            {
                                p[key] = json!(cur);
                            }
                        });
                    }
                    P::Check => {
                        let mut b = p.get(key).and_then(Value::as_bool).unwrap_or(false);
                        if widgets::checkbox(ui, &mut b, label).changed() {
                            p[key] = json!(b);
                        }
                    }
                }
                ui.add_space(2.0);
            }
            if selected == BLENDING {
                advanced_blending(ui, f, &mut p);
            }
            f.insert(pkey, p);
        });
        seps.push(gap(ui));
        // Preview: the live canvas preview, and a swatch of the style on a grey square.
        ui.vertical(|ui| {
            ui.set_width(SWATCH);
            let mut on = f.get("__preview").and_then(Value::as_bool).unwrap_or(true);
            if widgets::checkbox(ui, &mut on, "Preview").changed() {
                f.insert("__preview".into(), json!(on));
            }
            ui.add_space(6.0);
            swatch(ui, f, patterns);
        });
    });
    let r = row.response.rect;
    for x in seps {
        ui.painter().line_segment([egui::pos2(x, r.top()), egui::pos2(x, r.bottom())], Stroke::new(1.0, t.separator));
    }
}

/// Height of the dialog body: the tallest page (Blending Options in an RGB document).
const BODY_HEIGHT: f32 = 500.0;

/// A group heading inside a page (Photoshop's General Blending, Advanced Blending, …), with a
/// rule above it unless it opens the page.
fn group(ui: &mut egui::Ui, title: &str, rule: bool) {
    if rule {
        ui.add_space(6.0);
        widgets::hairline(ui);
        ui.add_space(8.0);
    }
    widgets::section_label(ui, title);
    ui.add_space(4.0);
}

/// Side of the style swatch, in points (and in pixels of its scratch document).
const SWATCH: f32 = 96.0;

/// The swatch: the dialog's effects, opacity and fill on a grey square, re-rendered when they change.
fn swatch(ui: &mut egui::Ui, f: &Map<String, Value>, patterns: &photosuite_engine::pattern_cmds::PatternLibrary) {
    let t = Tokens::get(ui.ctx());
    let (rect, _) = ui.allocate_exact_size(vec2(SWATCH, SWATCH), Sense::hover());
    ui.painter().rect_filled(rect, t.radius_sm, t.field);
    let id = egui::Id::new("layer-style-swatch");
    let key = preview_hash(f);
    let cached = ui.ctx().data(|d| d.get_temp::<(u64, Option<egui::TextureHandle>)>(id)).filter(|c| c.0 == key);
    let tex = match cached {
        Some((_, tex)) => tex,
        None => {
            let tex = swatch_image(f, patterns).map(|img| ui.ctx().load_texture("layer-style-swatch", img, egui::TextureOptions::LINEAR));
            ui.ctx().data_mut(|d| d.insert_temp(id, (key, tex.clone())));
            tex
        }
    };
    if let Some(tex) = tex {
        ui.painter().image(tex.id(), rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), Color32::WHITE);
    }
    ui.painter().rect_stroke(rect, t.radius_sm, Stroke::new(1.0, t.field_border), StrokeKind::Inside);
}

/// Renders the swatch: a mid-grey square on a transparent RGB document, with the dialog's style.
/// The layer's blend mode, Channels and Blend If are left out: with nothing beneath they show nothing.
fn swatch_image(f: &Map<String, Value>, patterns: &photosuite_engine::pattern_cmds::PatternLibrary) -> Option<egui::ColorImage> {
    let side = SWATCH as u32;
    let mut doc = photosuite_doc::Document::new("Swatch", photosuite_geom::Size::new(side, side), ColorMode::Rgb, photosuite_color::SampleType::U8);
    let mut surface = photosuite_raster::Surface::new(doc.pixel_format());
    let q = (side / 4) as i32;
    surface.fill_rect(photosuite_geom::Rect::new(q, q, side as i32 - q, side as i32 - q), &[0.5, 0.5, 0.5, 1.0]);
    let layer = Layer::new("Swatch", photosuite_doc::LayerContent::Raster(surface));
    let lid = layer.id.0;
    doc.layers.push(layer);
    let mut sf = f.clone();
    sf.insert("layer".into(), json!(lid));
    if let Some(Value::Object(bo)) = sf.get_mut(&format!("p:{BLENDING}")) {
        for k in ["blend", "channels", "blendIf"] {
            bo.remove(k);
        }
    }
    let shown = preview_document(&doc, patterns, &sf)?;
    Some(crate::canvas::buffer_to_image(&photosuite_compose::flatten(&shown)))
}

/// Blending Options › Advanced Blending (Channels) and Blend If, for the modes the compositor applies them to.
fn advanced_blending(ui: &mut egui::Ui, f: &mut Map<String, Value>, p: &mut Value) {
    let t = Tokens::get(ui.ctx());
    let Some(mode) = f.get("__mode").and_then(Value::as_str).map(str::to_string) else { return };
    let names: &[(&str, &str)] = if mode == "gray" { &[("Gray", "Gray")] } else { &[("R", "Red"), ("G", "Green"), ("B", "Blue")] };
    ui.horizontal(|ui| {
        ui.label(RichText::new(tl!("Channels:")).color(t.text_dim));
        for (i, (short, _)) in names.iter().enumerate() {
            let mut on = p.get("channels").and_then(|c| c.get(i)).and_then(Value::as_bool).unwrap_or(true);
            if widgets::checkbox(ui, &mut on, short).changed()
                && let Some(c) = p.get_mut("channels").and_then(|c| c.get_mut(i))
            {
                *c = json!(on);
            }
        }
    });
    ui.add_space(6.0);
    widgets::hairline(ui);
    ui.add_space(8.0);
    // Dropdown entries: (position in the `blendIf` list, label). Gray documents edit entry 1.
    let opts: Vec<(usize, &str)> = if mode == "gray" { vec![(1, "Gray")] } else { std::iter::once((0, "Gray")).chain(names.iter().enumerate().map(|(i, n)| (i + 1, n.1))).collect() };
    let mut ch = f.get("__blendIfChannel").and_then(Value::as_u64).and_then(|c| usize::try_from(c).ok()).unwrap_or(0);
    ui.horizontal(|ui| {
        ui.label(RichText::new(tl!("Blend If:")).color(t.text_dim));
        if widgets::dropdown(ui, "fx-blendIf-channel", &mut ch, &opts, 150.0) {
            f.insert("__blendIfChannel".into(), json!(ch));
        }
    });
    ui.add_space(4.0);
    let ramp = match (mode.as_str(), ch) {
        ("rgb", 1) => Color32::from_rgb(255, 0, 0),
        ("rgb", 2) => Color32::from_rgb(0, 255, 0),
        ("rgb", 3) => Color32::from_rgb(0, 0, 255),
        _ => Color32::WHITE,
    };
    for (key, label) in [("thisLayer", "This Layer:"), ("underlying", "Underlying Layer:")] {
        let Some(slot) = p.get_mut("blendIf").and_then(|b| b.get_mut(ch)).and_then(|e| e.get_mut(key)) else { continue };
        let mut q = range_bytes(slot);
        if blend_if_slider(ui, key, label, &mut q, ramp) {
            *slot = json!(q);
        }
    }
    ui.label(RichText::new(tl!("Alt-drag a point to split it.")).color(t.text_faint).size(11.0));
}

/// `[blackLow, blackHigh, whiteLow, whiteHigh]` from a field, full range when malformed.
fn range_bytes(v: &Value) -> [u8; 4] {
    let a: Vec<u8> = v.as_array().map(|a| a.iter().filter_map(|x| x.as_u64().and_then(|x| u8::try_from(x).ok())).collect()).unwrap_or_default();
    match a.as_slice() {
        [a, b, c, d] if a <= b && b <= c && c <= d => [*a, *b, *c, *d],
        _ => BlendRange::FULL.to_bytes(),
    }
}

/// Which handle a Blend If drag holds: `point` 0 = black, 1 = white; `half` None = both halves,
/// Some(0|1) = the low or high half, Some(2) = split, half picked by the first move's direction.
#[derive(Clone, Copy)]
struct BlendIfDrag {
    point: usize,
    half: Option<usize>,
    start: [u8; 4],
    x: f32,
}

/// The values after dragging `drag`'s handle by `d` (0..=255 units) from where the drag started.
fn drag_points(drag: BlendIfDrag, d: i32) -> [u8; 4] {
    let s = drag.start.map(i32::from);
    let mut n = s;
    let point = drag.point.min(1);
    let (lo, hi) = (2 * point, 2 * point + 1);
    // Bounds of the point being moved: the black point can't pass the white one.
    let (min, max) = if point == 0 { (0, s[2]) } else { (s[1], 255) };
    let half = match drag.half {
        Some(2) if d != 0 => Some(usize::from(d > 0)),
        h => h,
    };
    match half {
        None => {
            let d = d.max(min - s[lo]).min(max - s[hi]);
            n[lo] = s[lo] + d;
            n[hi] = s[hi] + d;
        }
        Some(0) => n[lo] = (s[lo] + d).max(min).min(s[hi]),
        Some(1) => n[hi] = (s[hi] + d).max(s[lo]).min(max),
        Some(_) => {}
    }
    n.map(|v| v.clamp(0, 255) as u8)
}

/// Photoshop's Blend If slider: values above a gradient bar, a black and a white point below it.
/// Dragging a point moves both its halves; Alt-dragging moves one half, splitting the point.
fn blend_if_slider(ui: &mut egui::Ui, id: &str, label: &str, q: &mut [u8; 4], ramp: Color32) -> bool {
    let t = Tokens::get(ui.ctx());
    let show = |a: u8, b: u8| if a == b { a.to_string() } else { format!("{a}/{b}") };
    // Full width, inset like the sliders' tracks so the handles line up with their knobs.
    let width = ui.available_width().max(60.0);
    // Photoshop's header: the label right-aligned in a column as wide as the longest one, the
    // black point's value then the white point's at fixed places after it.
    let font = egui::FontId::proportional(12.0);
    let (head, _) = ui.allocate_exact_size(vec2(width, 18.0), Sense::hover());
    let column = ui.painter().layout_no_wrap(tl!("Underlying Layer:").to_string(), font.clone(), t.text_dim).size().x;
    let label_end = head.left() + 7.0 + column;
    let y = head.center().y;
    ui.painter().text(egui::pos2(label_end, y), egui::Align2::RIGHT_CENTER, tl!(label), font.clone(), t.text_dim);
    let span = (head.right() - 7.0 - label_end).max(0.0);
    ui.painter().text(egui::pos2(label_end + 0.16 * span, y), egui::Align2::CENTER_CENTER, show(q[0], q[1]), font.clone(), t.text);
    ui.painter().text(egui::pos2(label_end + 0.55 * span, y), egui::Align2::CENTER_CENTER, show(q[2], q[3]), font, t.text);
    ui.add_space(2.0);
    let (rect, resp) = ui.allocate_exact_size(vec2(width, 24.0), Sense::drag());
    let bar = egui::Rect::from_min_size(rect.min + vec2(7.0, 0.0), vec2((rect.width() - 14.0).max(1.0), 12.0));
    let x_of = |v: u8| bar.left() + bar.width() * f32::from(v) / 255.0;
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(bar.left_top(), Color32::BLACK);
    mesh.colored_vertex(bar.right_top(), ramp);
    mesh.colored_vertex(bar.right_bottom(), ramp);
    mesh.colored_vertex(bar.left_bottom(), Color32::BLACK);
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(0, 2, 3);
    ui.painter().add(mesh);
    ui.painter().rect_stroke(bar, 0.0, Stroke::new(1.0, t.field_border), StrokeKind::Outside);
    let mut changed = false;
    let mem = ui.id().with(("blend-if-drag", id));
    if resp.drag_started()
        && let Some(pos) = resp.interact_pointer_pos()
    {
        let centre = |p: usize| (x_of(q[2 * p]) + x_of(q[2 * p + 1])) / 2.0;
        let point = usize::from((pos.x - centre(1)).abs() < (pos.x - centre(0)).abs());
        let half = ui.input(|i| i.modifiers.alt).then(|| {
            let (lo, hi) = (q[2 * point], q[2 * point + 1]);
            if lo == hi { 2 } else { usize::from((pos.x - x_of(hi)).abs() < (pos.x - x_of(lo)).abs()) }
        });
        ui.data_mut(|d| d.insert_temp(mem, BlendIfDrag { point, half, start: *q, x: pos.x }));
    }
    if resp.dragged()
        && let (Some(drag), Some(pos)) = (ui.data(|d| d.get_temp::<BlendIfDrag>(mem)), resp.interact_pointer_pos())
    {
        let d = ((pos.x - drag.x) / bar.width().max(1.0) * 255.0).round() as i32;
        let n = drag_points(drag, d);
        if n != *q {
            *q = n;
            changed = true;
        }
    }
    // Handles: a whole triangle per point, or a left and a right half when it's split.
    let y = bar.bottom() + 2.0;
    for (point, fill) in [(0, Color32::from_gray(20)), (1, Color32::from_gray(235))] {
        let (lo, hi) = (x_of(q[2 * point]), x_of(q[2 * point + 1]));
        let tri = |pts: Vec<egui::Pos2>| egui::Shape::convex_polygon(pts, fill, Stroke::new(1.0, t.text_dim));
        if q[2 * point] == q[2 * point + 1] {
            ui.painter().add(tri(vec![egui::pos2(lo, y), egui::pos2(lo + 5.0, y + 9.0), egui::pos2(lo - 5.0, y + 9.0)]));
        } else {
            ui.painter().add(tri(vec![egui::pos2(lo, y), egui::pos2(lo, y + 9.0), egui::pos2(lo - 5.0, y + 9.0)]));
            ui.painter().add(tri(vec![egui::pos2(hi, y), egui::pos2(hi + 5.0, y + 9.0), egui::pos2(hi, y + 9.0)]));
        }
    }
    ui.add_space(4.0);
    changed
}

fn parse_hex(s: &str) -> Color32 {
    let s = s.trim_start_matches('#');
    let b = |i: usize| u8::from_str_radix(s.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    Color32::from_rgb(b(0), b(2), b(4))
}

trait MaxAlpha {
    fn max_alpha(self, other: Color32) -> Color32;
}

impl MaxAlpha for Color32 {
    /// Fall back to `other` when this colour is fully transparent (non-Pro themes have no row colour).
    fn max_alpha(self, other: Color32) -> Color32 {
        if self.a() == 0 { other } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_has_spec_and_defaults() {
        for &(kind, _) in KINDS {
            assert!(!spec(kind).is_empty(), "{kind}");
            let d = defaults(kind);
            for &(key, _, _) in spec(kind) {
                assert!(d.get(key).is_some(), "{kind}.{key} has no default");
            }
        }
    }

    #[test]
    fn initial_fields_select_requested_kind() {
        let l = Layer::raster("x", photosuite_doc::PixelFormat::RGBA8);
        let f = initial_fields(&l, ColorMode::Rgb, Some("stroke"), 120.0);
        assert_eq!(f["globalLight"], json!(120.0));
        assert_eq!(f["selected"], "stroke");
        assert_eq!(f["on:stroke"], true);
        assert_eq!(f["on:dropShadow"], false);
    }

    #[test]
    fn preview_applies_the_style_without_touching_the_document() {
        let mut s = photosuite_engine::Session::new();
        s.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        let st = s.active().unwrap();
        let mut f = initial_fields(st.doc.layer(st.active_layer.unwrap()).unwrap(), st.doc.mode, Some("colorOverlay"), st.doc.global_light.angle);
        let h = preview_hash(&f);
        f.insert("selected".into(), json!("stroke"));
        assert_eq!(preview_hash(&f), h, "switching pages doesn't re-render");
        f.insert("on:stroke".into(), json!(true));
        assert_ne!(preview_hash(&f), h);
        let shown = preview_document(&st.doc, &s.patterns, &f).unwrap();
        let fx = |d: &photosuite_doc::Document| d.layer(st.active_layer.unwrap()).unwrap().effects.items.len();
        assert_eq!((fx(&shown), fx(&st.doc)), (2, 0));
    }

    /// The dialog's Channels and Blend If fields reach the layer through the command, in RGB and gray.
    #[test]
    fn channels_and_blend_if_round_trip_through_the_engine() {
        for (mode, entry) in [("rgb", 2usize), ("grayscale", 1)] {
            let mut s = photosuite_engine::Session::new();
            s.execute("file.new", json!({"width": 16, "height": 16, "mode": mode})).unwrap();
            s.execute("layer.new.layer", json!({})).unwrap();
            let st = s.active().unwrap();
            let id = st.active_layer.unwrap();
            let mut f = initial_fields(st.doc.layer(id).unwrap(), st.doc.mode, Some(BLENDING), st.doc.global_light.angle);
            let bo = f.get_mut(&format!("p:{BLENDING}")).unwrap();
            assert_eq!(bo["channels"].as_array().unwrap().len(), st.doc.mode.color_channels(), "{mode}");
            bo["channels"][0] = json!(false);
            bo["blendIf"][entry]["thisLayer"] = json!([10, 40, 200, 255]);
            bo["blendIf"][entry]["underlying"] = json!([0, 0, 128, 128]);
            apply(&f, |c, p| s.execute(c, p).map(|_| Value::Null).map_err(|e| e.to_string())).unwrap();
            let st = s.active().unwrap();
            let l = st.doc.layer(id).unwrap();
            assert_eq!(l.excluded_channels, 1, "{mode}");
            assert_eq!(l.blend_if.get(entry), [BlendRange::from_bytes([10, 40, 200, 255]), BlendRange::from_bytes([0, 0, 128, 128])], "{mode}");
            // Reopening shows what was set.
            let again = initial_fields(l, st.doc.mode, None, st.doc.global_light.angle);
            assert_eq!(again[&format!("p:{BLENDING}")]["blendIf"][entry]["thisLayer"], json!([10, 40, 200, 255]), "{mode}");
            assert_eq!(again[&format!("p:{BLENDING}")]["channels"][0], json!(false), "{mode}");
        }
        // CMYK and Lab: the compositor doesn't apply them, so the dialog doesn't offer them.
        let l = Layer::raster("x", photosuite_doc::PixelFormat::RGBA8);
        let f = initial_fields(&l, ColorMode::Cmyk, None, 120.0);
        assert!(f[&format!("p:{BLENDING}")].get("blendIf").is_none() && !f.contains_key("__mode"));
    }

    #[test]
    fn malformed_blend_if_fields_read_as_the_full_range() {
        assert_eq!(range_bytes(&json!([1, 2, 3, 4])), [1, 2, 3, 4]);
        for bad in [json!([4, 3, 2, 1]), json!([1, 2, 3]), json!([0, 0, 0, 300]), json!("x"), Value::Null] {
            assert_eq!(range_bytes(&bad), [0, 0, 255, 255], "{bad}");
        }
    }

    #[test]
    fn blend_if_drags_move_split_and_stop_at_the_other_point() {
        let drag = |point, half, start, d| drag_points(BlendIfDrag { point, half, start, x: 0.0 }, d);
        // A plain drag moves both halves; the black point stops at the white one, and at 0.
        assert_eq!(drag(0, None, [10, 40, 200, 255], 20), [30, 60, 200, 255]);
        assert_eq!(drag(0, None, [10, 40, 200, 255], 500), [170, 200, 200, 255]);
        assert_eq!(drag(0, None, [10, 40, 200, 255], -500), [0, 30, 200, 255]);
        // Alt on an unsplit point: the first move's direction picks the half.
        assert_eq!(drag(1, Some(2), [0, 0, 255, 255], -55), [0, 0, 200, 255]);
        assert_eq!(drag(0, Some(2), [0, 0, 255, 255], 30), [0, 30, 255, 255]);
        assert_eq!(drag(0, Some(2), [0, 0, 255, 255], 0), [0, 0, 255, 255]);
        // Alt on a split half: that half only, never past its partner or the other point.
        assert_eq!(drag(0, Some(0), [10, 40, 200, 255], 100), [40, 40, 200, 255]);
        assert_eq!(drag(1, Some(0), [10, 40, 200, 255], -500), [10, 40, 40, 255]);
        assert_eq!(drag(1, Some(1), [10, 40, 200, 230], 500), [10, 40, 200, 255]);
        // Out-of-range state from a hostile field doesn't panic.
        assert_eq!(drag(7, Some(9), [255, 0, 255, 0], i32::MAX / 2), [255, 0, 255, 0]);
        for half in [None, Some(0), Some(1), Some(2)] {
            drag(0, half, [255, 0, 255, 0], 9);
            drag(1, half, [200, 100, 50, 0], -9);
        }
    }

    #[test]
    fn swatch_renders_the_style() {
        let mut s = photosuite_engine::Session::new();
        s.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        let st = s.active().unwrap();
        let mut f = initial_fields(st.doc.layer(st.active_layer.unwrap()).unwrap(), st.doc.mode, Some("colorOverlay"), 120.0);
        f[&format!("p:{BLENDING}")]["blend"] = json!("Pass Through");
        let img = swatch_image(&f, &s.patterns).expect("swatch");
        let c = img.pixels[img.width() * img.height() / 2 + img.width() / 2];
        assert_eq!((c.r(), c.g(), c.b()), (255, 0, 0), "the red overlay on the square");
        assert_eq!(img.pixels[0].a(), 0, "transparent around it");
    }

    #[test]
    fn percent_fields_round_trip_through_the_engine() {
        let mut s = photosuite_engine::Session::new();
        s.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        s.execute("layer.layerStyle.outerGlow", json!({"spread": 6, "range": 40})).unwrap();
        s.execute("layer.layerStyle.dropShadow", json!({"spread": 12, "add": true})).unwrap();
        let st = s.active().unwrap();
        let l = st.doc.layer(st.active_layer.unwrap()).unwrap();
        let f = initial_fields(l, st.doc.mode, None, st.doc.global_light.angle);
        assert_eq!(f["p:outerGlow"]["spread"], json!(6.0));
        assert_eq!(f["p:outerGlow"]["range"], json!(40.0));
        assert_eq!(f["p:dropShadow"]["spread"], json!(12.0));
    }

    #[test]
    fn drop_shadow_angle_reaches_the_effect() {
        // #350: the Angle slider was dead — the dialog never sent `useGlobalLight`, so the engine
        // defaulted it to true and the compositor used the fixed global light angle, ignoring the slider.
        let mut s = photosuite_engine::Session::new();
        s.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        let id = s.active().unwrap().active_layer.unwrap();
        let shadow = |s: &photosuite_engine::Session| {
            s.active().unwrap().doc.layer(id).unwrap().effects.items.iter().find_map(|e| match e {
                Effect::DropShadow(sh) => Some(sh.clone()),
                _ => None,
            })
        };

        // Use Global Light off: the per-effect angle is stored and used.
        let mut f = Map::new();
        f.insert("layer".into(), json!(id));
        f.insert("on:dropShadow".into(), json!(true));
        f.insert("p:dropShadow".into(), json!({"angle": 45.0, "useGlobalLight": false, "distance": 5, "size": 5}));
        apply(&f, |cmd, p| s.execute(cmd, p).map_err(|e| e.to_string())).unwrap();
        let eff = shadow(&s).unwrap();
        assert!(!eff.use_global_light, "Use Global Light off keeps the per-effect angle");
        assert_eq!(eff.angle, 45.0);

        // Use Global Light on: the Angle slider drives the document's shared light angle.
        let mut f = Map::new();
        f.insert("layer".into(), json!(id));
        f.insert("on:dropShadow".into(), json!(true));
        f.insert("p:dropShadow".into(), json!({"angle": 30.0, "useGlobalLight": true, "distance": 5, "size": 5}));
        apply(&f, |cmd, p| s.execute(cmd, p).map_err(|e| e.to_string())).unwrap();
        assert_eq!(s.active().unwrap().doc.global_light.angle, 30.0, "the Angle slider moves the shared light");
        assert!(shadow(&s).unwrap().use_global_light);

        // Reopening the dialog shows the effective angle and the checkbox state.
        let st = s.active().unwrap();
        let f = initial_fields(st.doc.layer(id).unwrap(), st.doc.mode, None, st.doc.global_light.angle);
        assert_eq!(f["p:dropShadow"]["useGlobalLight"], json!(true));
        assert_eq!(f["p:dropShadow"]["angle"], json!(30.0));
    }

    #[test]
    fn bevel_angle_change_is_not_overridden_by_unchanged_drop_shadow_angle() {
        let mut s = photosuite_engine::Session::new();
        s.execute("file.new", json!({"width": 64, "height": 64})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        let (id, mut f, initial_light) = {
            let st = s.active().unwrap();
            let id = st.active_layer.unwrap();
            let f = initial_fields(st.doc.layer(id).unwrap(), st.doc.mode, None, st.doc.global_light.angle);
            (id, f, st.doc.global_light.angle)
        };
        f.insert("on:bevelEmboss".into(), json!(true));
        f["p:bevelEmboss"]["angle"] = json!(45.0);
        f.insert("on:dropShadow".into(), json!(true));
        assert_eq!(f["p:dropShadow"]["angle"].as_f64(), Some(f64::from(initial_light)));

        apply(&f, |cmd, p| s.execute(cmd, p).map_err(|e| e.to_string())).unwrap();

        assert_eq!(s.active().unwrap().doc.global_light.angle, 45.0);
        assert_eq!(s.active().unwrap().doc.layer(id).unwrap().effects.items.len(), 2);
    }

    #[test]
    fn unchanged_global_light_angle_is_not_applied() {
        let layer = Layer::raster("x", photosuite_doc::PixelFormat::RGBA8);
        let mut f = initial_fields(&layer, ColorMode::Rgb, None, 47.5);
        f.insert("on:bevelEmboss".into(), json!(true));
        assert_eq!(f["p:bevelEmboss"]["angle"].as_f64(), Some(47.5));
        let mut commands = Vec::new();

        apply(&f, |cmd, _| {
            commands.push(cmd.to_string());
            Ok(Value::Null)
        })
        .unwrap();

        assert!(!commands.iter().any(|cmd| cmd == "layer.layerStyle.globalLight"));
    }
}
