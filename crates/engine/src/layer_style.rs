//! `layer.layerStyle.*` commands: add/replace layer effects on a layer.

use photosuite_color::{BlendMode, Color};
use photosuite_doc::adjust::CurvePoint;
use photosuite_doc::{
    Bevel, BevelStyle, BevelTechnique, Contour, Effect, FxCommon, FxPaint, Glow, GlowSource, GlowTechnique, Gradient, GradientStyle, Satin, Shadow, StrokeFx,
    StrokePosition,
};
use serde_json::{Value, json};

use crate::commands::{CommandSpec, blend_from_str};
use crate::presets::{always, bad};
use crate::{EngineError, Result, Session};

/// Parses a gradient style name (`linear`, `radial`, `angle`, `reflected`, `diamond`).
pub fn gradient_style(s: &str) -> GradientStyle {
    match s.to_ascii_lowercase().as_str() {
        "radial" => GradientStyle::Radial,
        "angle" => GradientStyle::Angle,
        "reflected" => GradientStyle::Reflected,
        "diamond" => GradientStyle::Diamond,
        _ => GradientStyle::Linear,
    }
}

fn f(p: &Value, k: &str, d: f32) -> f32 {
    p.get(k).and_then(Value::as_f64).map_or(d, |v| v as f32)
}
fn b(p: &Value, k: &str, d: bool) -> bool {
    p.get(k).and_then(Value::as_bool).unwrap_or(d)
}
fn f_of(p: &Value, k: &str) -> Option<f32> {
    p.get(k).and_then(Value::as_f64).map(|v| v as f32)
}
fn b_of(p: &Value, k: &str) -> Option<bool> {
    p.get(k).and_then(Value::as_bool)
}
fn color_of(p: &Value, k: &str) -> Option<Color> {
    match p.get(k) {
        Some(Value::Array(a)) if a.len() >= 3 => {
            Some(Color::rgb(a[0].as_f64().unwrap_or(0.0) as f32, a[1].as_f64().unwrap_or(0.0) as f32, a[2].as_f64().unwrap_or(0.0) as f32))
        }
        Some(Value::String(s)) => {
            let s = s.trim_start_matches('#');
            let h = |i: usize| s.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok()).map_or(0.0, |v| f32::from(v) / 255.0);
            (s.len() >= 6).then_some(Color::rgb(h(0), h(2), h(4)))
        }
        _ => None,
    }
}
fn color(p: &Value, k: &str, d: [f32; 3]) -> Color {
    let c = color_of(p, k).map_or(d, |c| c.to_rgb());
    Color::rgb(c[0], c[1], c[2])
}
fn gradient(p: &Value) -> Gradient {
    Gradient {
        stops: vec![(0.0, color(p, "from", [0.0; 3])), (1.0, color(p, "to", [1.0; 3]))],
        style: gradient_style(p.get("style").and_then(Value::as_str).unwrap_or("linear")),
        angle: f(p, "angle", 90.0),
        scale: f(p, "scale", 100.0) / 100.0,
        reverse: b(p, "reverse", false),
        ..Gradient::default()
    }
}

/// Factory defaults for each effect kind, in the command's parameter units
/// (what the Layer Style dialog starts a new effect from).
pub fn effect_defaults(kind: &str) -> Value {
    match kind {
        "dropShadow" => {
            json!({"blend": "Multiply", "color": "#000000", "opacity": 75, "angle": 120, "useGlobalLight": true, "distance": 5, "spread": 0, "size": 5, "contour": "Linear", "noise": 0, "knocksOut": true})
        }
        "innerShadow" => {
            json!({"blend": "Multiply", "color": "#000000", "opacity": 75, "angle": 120, "useGlobalLight": true, "distance": 5, "choke": 0, "size": 5, "contour": "Linear", "noise": 0})
        }
        "outerGlow" => json!({"blend": "Screen", "opacity": 75, "color": "#ffffbe", "spread": 0, "size": 5, "range": 50, "contour": "Linear", "noise": 0}),
        "innerGlow" => json!({"blend": "Screen", "opacity": 75, "color": "#ffffbe", "source": "edge", "choke": 0, "size": 5, "contour": "Linear", "noise": 0}),
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

/// Built-in contour presets (our own transfer curves; imported PSD contours keep
/// their own points). Points are (input, output) in 0..=1, sorted by input.
pub const CONTOURS: &[(&str, &[(f32, f32)])] = &[
    ("Linear", &[(0.0, 0.0), (1.0, 1.0)]),
    ("Cone", &[(0.0, 0.0), (0.5, 1.0), (1.0, 1.0)]),
    ("Cone (Inverted)", &[(0.0, 1.0), (0.5, 0.0), (1.0, 0.0)]),
    ("Domed", &[(0.0, 0.0), (0.25, 1.0), (0.75, 1.0), (1.0, 0.0)]),
    ("Domed (Inverted)", &[(0.0, 1.0), (0.25, 0.0), (0.75, 0.0), (1.0, 1.0)]),
    ("Diagonal (Descending)", &[(0.0, 1.0), (1.0, 0.0)]),
];

/// The built-in contour called `name` (`Linear` is the identity); `None` for
/// names we don't ship, so imported contours are carried rather than clobbered.
pub fn builtin_contour(name: &str) -> Option<Contour> {
    if name.eq_ignore_ascii_case("Linear") {
        return Some(Contour::Linear);
    }
    CONTOURS.iter().skip(1).find(|(n, _)| *n == name).map(|(n, pts)| Contour::Custom {
        name: (*n).to_string(),
        points: pts.iter().map(|(input, output)| CurvePoint { input: *input, output: *output }).collect(),
    })
}

/// The param naming a contour (`"Linear"` or a preset/custom contour's name).
pub fn contour_param(c: &Contour) -> Value {
    match c {
        Contour::Linear => json!("Linear"),
        Contour::Custom { name, .. } => json!(name),
    }
}

/// An effect of `kind` with its factory settings (before params are applied).
fn fresh_effect(kind: &str) -> Option<Effect> {
    let shadow = |inner: bool| Shadow {
        common: FxCommon::new(BlendMode::Multiply, 0.75),
        color: Color::BLACK,
        angle: 120.0,
        use_global_light: true,
        distance: 5.0,
        spread: 0.0,
        size: 5.0,
        contour: Contour::Linear,
        anti_alias: false,
        noise: 0.0,
        knocks_out: !inner,
    };
    let glow = || Glow {
        common: FxCommon::new(BlendMode::Screen, 0.75),
        paint: FxPaint::Color(Color::rgb(1.0, 1.0, 190.0 / 255.0)),
        technique: GlowTechnique::Softer,
        spread: 0.0,
        size: 5.0,
        contour: Contour::Linear,
        anti_alias: false,
        range: 0.5,
        jitter: 0.0,
        noise: 0.0,
        source: GlowSource::Edge,
    };
    Some(match kind {
        "dropShadow" => Effect::DropShadow(shadow(false)),
        "innerShadow" => Effect::InnerShadow(shadow(true)),
        "outerGlow" => Effect::OuterGlow(glow()),
        "innerGlow" => Effect::InnerGlow(glow()),
        "stroke" => Effect::Stroke(StrokeFx {
            common: FxCommon::new(BlendMode::Normal, 1.0),
            size: 3.0,
            position: StrokePosition::Outside,
            paint: FxPaint::Color(Color::rgb(1.0, 0.0, 0.0)),
        }),
        "colorOverlay" => Effect::ColorOverlay { common: FxCommon::new(BlendMode::Normal, 1.0), color: Color::rgb(1.0, 0.0, 0.0) },
        "gradientOverlay" => Effect::GradientOverlay { common: FxCommon::new(BlendMode::Normal, 1.0), gradient: Gradient::default(), dither: false },
        "patternOverlay" => Effect::PatternOverlay {
            common: FxCommon::new(BlendMode::Normal, 1.0),
            name: String::new(),
            id: String::new(),
            scale: 1.0,
            angle: 0.0,
            link: true,
            phase: (0.0, 0.0),
        },
        "satin" => Effect::Satin(Satin {
            common: FxCommon::new(BlendMode::Multiply, 0.5),
            color: Color::BLACK,
            angle: 19.0,
            distance: 11.0,
            size: 14.0,
            contour: Contour::Linear,
            anti_alias: true,
            invert: true,
        }),
        "bevelEmboss" => Effect::BevelEmboss(Bevel {
            enabled: true,
            style: BevelStyle::InnerBevel,
            technique: BevelTechnique::Smooth,
            depth: 1.0,
            up: true,
            size: 5.0,
            soften: 0.0,
            angle: 120.0,
            altitude: 30.0,
            use_global_light: true,
            gloss_contour: Contour::Linear,
            highlight: FxCommon::new(BlendMode::Screen, 0.75),
            highlight_color: Color::WHITE,
            shadow: FxCommon::new(BlendMode::Multiply, 0.75),
            shadow_color: Color::BLACK,
            contour: None,
            texture: None,
        }),
        _ => return None,
    })
}

/// Edits an existing gradient in place: only the end colours and geometry.
/// Intermediate stops, opacity stops, alignment and offset survive a round trip.
fn overlay_gradient(g: &mut Gradient, p: &Value) {
    if let Some(c) = color_of(p, "from")
        && let Some(first) = g.stops.first_mut()
    {
        first.1 = c;
    }
    if let Some(c) = color_of(p, "to")
        && let Some(last) = g.stops.last_mut()
    {
        last.1 = c;
    }
    if let Some(s) = p.get("style").and_then(Value::as_str) {
        g.style = gradient_style(s);
    }
    if let Some(x) = f_of(p, "angle") {
        g.angle = x;
    }
    if let Some(x) = f_of(p, "scale") {
        g.scale = (x / 100.0).clamp(0.01, 10.0);
    }
    if let Some(x) = b_of(p, "reverse") {
        g.reverse = x;
    }
}

/// Applies the params present in `p` onto an existing effect, in the command's
/// parameter units. Absent (or unparseable) keys leave the effect unchanged, so
/// a dialog round trip never touches what it doesn't model: an imported
/// gradient stroke keeps its gradient while its opacity is edited.
pub fn overlay_effect(fx: &mut Effect, p: &Value) {
    fn set_color(p: &Value, k: &str, c: &mut Color) {
        if let Some(x) = color_of(p, k) {
            *c = x;
        }
    }
    fn set_contour(p: &Value, c: &mut Contour) {
        if let Some(name) = p.get("contour").and_then(Value::as_str)
            && let Some(x) = builtin_contour(name)
        {
            *c = x;
        }
    }
    fn common(c: &mut FxCommon, p: &Value) {
        if let Some(x) = b_of(p, "enabled") {
            c.enabled = x;
        }
        if let Some(x) = p.get("blend").and_then(Value::as_str).and_then(blend_from_str) {
            c.blend = x;
        }
        if let Some(x) = f_of(p, "opacity") {
            c.opacity = (x / 100.0).clamp(0.0, 1.0);
        }
    }
    let inner_shadow = matches!(fx, Effect::InnerShadow(_));
    let inner_glow = matches!(fx, Effect::InnerGlow(_));
    match fx {
        Effect::DropShadow(s) | Effect::InnerShadow(s) => {
            let inner = inner_shadow;
            common(&mut s.common, p);
            set_color(p, "color", &mut s.color);
            if let Some(x) = f_of(p, "angle") {
                s.angle = x;
            }
            if let Some(x) = b_of(p, "useGlobalLight") {
                s.use_global_light = x;
            }
            if let Some(x) = f_of(p, "distance") {
                s.distance = x;
            }
            if let Some(x) = f_of(p, if inner { "choke" } else { "spread" }) {
                s.spread = (x / 100.0).clamp(0.0, 1.0);
            }
            if let Some(x) = f_of(p, "size") {
                s.size = x;
            }
            set_contour(p, &mut s.contour);
            if let Some(x) = f_of(p, "noise") {
                s.noise = (x / 100.0).clamp(0.0, 1.0);
            }
            if !inner && let Some(x) = b_of(p, "knocksOut") {
                s.knocks_out = x;
            }
        }
        Effect::OuterGlow(g) | Effect::InnerGlow(g) => {
            let inner = inner_glow;
            common(&mut g.common, p);
            if let Some(c) = color_of(p, "color") {
                g.paint = FxPaint::Color(c);
            }
            if let Some(t) = p.get("technique").and_then(Value::as_str) {
                g.technique = if t == "precise" { GlowTechnique::Precise } else { GlowTechnique::Softer };
            }
            if let Some(x) = f_of(p, if inner { "choke" } else { "spread" }) {
                g.spread = (x / 100.0).clamp(0.0, 1.0);
            }
            if let Some(x) = f_of(p, "size") {
                g.size = x;
            }
            set_contour(p, &mut g.contour);
            if let Some(x) = f_of(p, "range") {
                g.range = (x / 100.0).clamp(0.01, 1.0);
            }
            if let Some(x) = f_of(p, "noise") {
                g.noise = (x / 100.0).clamp(0.0, 1.0);
            }
            if inner && let Some(s) = p.get("source").and_then(Value::as_str) {
                g.source = if s == "center" { GlowSource::Center } else { GlowSource::Edge };
            }
        }
        Effect::Stroke(s) => {
            common(&mut s.common, p);
            if let Some(x) = f_of(p, "size") {
                s.size = x;
            }
            if let Some(pos) = p.get("position").and_then(Value::as_str) {
                s.position = match pos {
                    "inside" => StrokePosition::Inside,
                    "center" => StrokePosition::Center,
                    _ => StrokePosition::Outside,
                };
            }
            if p.get("from").is_some() {
                s.paint = FxPaint::Gradient(gradient(p));
            } else if let Some(c) = color_of(p, "color") {
                s.paint = FxPaint::Color(c);
            }
        }
        Effect::ColorOverlay { common: c, color } => {
            common(c, p);
            set_color(p, "color", color);
        }
        Effect::GradientOverlay { common: c, gradient: g, dither } => {
            common(c, p);
            overlay_gradient(g, p);
            if let Some(x) = b_of(p, "dither") {
                *dither = x;
            }
        }
        Effect::PatternOverlay { common: c, name, id, scale, angle, link, phase } => {
            common(c, p);
            if let Some(x) = p.get("pattern").and_then(Value::as_str) {
                *name = x.to_string();
                *id = String::new();
            }
            if let Some(x) = f_of(p, "scale") {
                *scale = (x / 100.0).clamp(0.01, 10.0);
            }
            if let Some(x) = f_of(p, "angle") {
                *angle = x;
            }
            if let Some(x) = b_of(p, "link") {
                *link = x;
            }
            if let Some(x) = f_of(p, "phaseX") {
                phase.0 = x;
            }
            if let Some(x) = f_of(p, "phaseY") {
                phase.1 = x;
            }
        }
        Effect::Satin(s) => {
            common(&mut s.common, p);
            set_color(p, "color", &mut s.color);
            if let Some(x) = f_of(p, "angle") {
                s.angle = x;
            }
            if let Some(x) = f_of(p, "distance") {
                s.distance = x;
            }
            if let Some(x) = f_of(p, "size") {
                s.size = x;
            }
            if let Some(x) = b_of(p, "invert") {
                s.invert = x;
            }
        }
        Effect::BevelEmboss(bv) => {
            if let Some(x) = b_of(p, "enabled") {
                bv.enabled = x;
            }
            if let Some(s) = p.get("style").and_then(Value::as_str) {
                bv.style = match s {
                    "outer" => BevelStyle::OuterBevel,
                    "emboss" => BevelStyle::Emboss,
                    "pillow" => BevelStyle::PillowEmboss,
                    "stroke" => BevelStyle::StrokeEmboss,
                    _ => BevelStyle::InnerBevel,
                };
            }
            if let Some(t) = p.get("technique").and_then(Value::as_str) {
                bv.technique = match t {
                    "chiselHard" => BevelTechnique::ChiselHard,
                    "chiselSoft" => BevelTechnique::ChiselSoft,
                    _ => BevelTechnique::Smooth,
                };
            }
            if let Some(x) = f_of(p, "depth") {
                bv.depth = x / 100.0;
            }
            if let Some(d) = p.get("direction").and_then(Value::as_str) {
                bv.up = d != "down";
            }
            if let Some(x) = f_of(p, "size") {
                bv.size = x;
            }
            if let Some(x) = f_of(p, "soften") {
                bv.soften = x;
            }
            if let Some(x) = f_of(p, "angle") {
                bv.angle = x;
            }
            if let Some(x) = f_of(p, "altitude") {
                bv.altitude = x;
            }
            if let Some(x) = b_of(p, "useGlobalLight") {
                bv.use_global_light = x;
            }
            if let Some(x) = p.get("glossContour").and_then(Value::as_str)
                && let Some(c) = builtin_contour(x)
            {
                bv.gloss_contour = c;
            }
            if let Some(x) = b_of(p, "contour") {
                bv.contour = x.then(|| photosuite_doc::BevelContour {
                    contour: builtin_contour(p.get("contourName").and_then(Value::as_str).unwrap_or("Linear")).unwrap_or(Contour::Linear),
                    range: (f(p, "contourRange", 50.0) / 100.0).clamp(0.01, 1.0),
                    anti_alias: false,
                });
            } else if let Some(c) = &mut bv.contour
                && let Some(x) = builtin_contour(p.get("contourName").and_then(Value::as_str).unwrap_or(""))
            {
                c.contour = x;
            }
            if let Some(t) = p.get("texture").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                bv.texture = Some(photosuite_doc::BevelTexture {
                    name: t.to_string(),
                    id: t.to_string(),
                    scale: (f(p, "textureScale", 100.0) / 100.0).clamp(0.01, 10.0),
                    depth: (f(p, "textureDepth", 100.0) / 100.0).clamp(-10.0, 10.0),
                    invert: b(p, "textureInvert", false),
                    link: b(p, "textureLink", true),
                    phase: (0.0, 0.0),
                });
            }
        }
    }
}

/// Builds an effect of `kind` from JSON params (Photoshop units: opacity,
/// spread, range in percent; sizes in px; angles in degrees).
pub fn effect_from_params(kind: &str, p: &Value) -> Option<Effect> {
    let mut fx = fresh_effect(kind)?;
    overlay_effect(&mut fx, p);
    Some(fx)
}

/// The effect's kind as the commands and dialog name it.
pub fn kind_of(e: &Effect) -> &'static str {
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

fn same_kind(a: &Effect, b: &Effect) -> bool {
    std::mem::discriminant(a) == std::mem::discriminant(b)
}
/// Upper bound on the effects one `layer.layerStyle.replace` call accepts, so an
/// automation mistake can't ask for an unbounded document change.
const MAX_EFFECTS: usize = 256;

/// Replaces a layer's whole effect list in one history step: the Layer Style dialog's
/// apply. Each entry builds an effect from `params`, or edits the snapshot it carried
/// (`fx`: the effect JSON as the dialog loaded it, kept verbatim for everything the
/// dialog doesn't model) with the params present. Unknown kinds, kind/snapshot
/// mismatches and malformed snapshots are errors, never panics.
fn replace_effects(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "layer.layerStyle.replace";
    let id = match p.get("layer").and_then(Value::as_u64) {
        Some(id) => photosuite_doc::LayerId(id),
        None => s.active().and_then(|d| d.active_layer).ok_or(EngineError::Other("no active layer".into()))?,
    };
    let entries = p.get("effects").and_then(Value::as_array).ok_or_else(|| bad(CMD, "need `effects`: [{kind, params, fx?}]"))?;
    if entries.len() > MAX_EFFECTS {
        return Err(bad(CMD, format!("at most {MAX_EFFECTS} effects")));
    }
    let mut list = Vec::with_capacity(entries.len());
    let mut pats = Vec::new();
    for e in entries {
        let kind = e.get("kind").and_then(Value::as_str).ok_or_else(|| bad(CMD, "each effect needs a `kind` string"))?;
        let params = match e.get("params") {
            None | Some(Value::Null) => json!({}),
            Some(Value::Object(_)) => e.get("params").cloned().unwrap_or_default(),
            Some(_) => return Err(bad(CMD, "`params` must be an object")),
        };
        let fx = match e.get("fx") {
            Some(fx_json) => {
                let mut fx: Effect = serde_json::from_value(fx_json.clone()).map_err(|err| bad(CMD, format!("bad effect snapshot: {err}")))?;
                if kind_of(&fx) != kind {
                    return Err(bad(CMD, format!("effect snapshot is a {}, not `{kind}`", kind_of(&fx))));
                }
                overlay_effect(&mut fx, &params);
                fx
            }
            None => effect_from_params(kind, &params).ok_or_else(|| bad(CMD, format!("unknown effect {kind}")))?,
        };
        let (fx, pat) = crate::pattern_cmds::resolve_effect(s, fx)?;
        if let Some(pat) = pat {
            pats.push(pat);
        }
        list.push(fx);
    }
    let count = list.len();
    let label = if list.is_empty() { "Clear Layer Style" } else { "Edit Layer Style" };
    s.edit(label, |doc, _| {
        for pat in &pats {
            crate::pattern_cmds::ensure_in_doc(doc, pat);
        }
        let l = doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?;
        l.effects.items = list;
        l.effects.enabled = true;
        Ok(())
    })?;
    Ok(json!({ "layer": id.0, "effects": count }))
}

fn set_effect(s: &mut Session, p: &Value, kind: &str) -> Result<Value> {
    let fx = effect_from_params(kind, p).ok_or_else(|| EngineError::Other(format!("unknown effect {kind}")))?;
    let (fx, pattern) = crate::pattern_cmds::resolve_effect(s, fx)?;
    let label = format!("Layer Style: {}", fx.label());
    let add = b(p, "add", false);
    let id = match p.get("layer").and_then(Value::as_u64) {
        Some(id) => photosuite_doc::LayerId(id),
        None => s.active().and_then(|d| d.active_layer).ok_or(EngineError::Other("no active layer".into()))?,
    };
    s.edit(&label, |doc, _| {
        if let Some(pat) = &pattern {
            crate::pattern_cmds::ensure_in_doc(doc, pat);
        }
        let l = doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?;
        l.effects.enabled = true;
        match l.effects.items.iter_mut().find(|e| same_kind(e, &fx)) {
            Some(slot) if !add => *slot = fx,
            _ => l.effects.items.push(fx),
        }
        Ok(())
    })?;
    Ok(json!({ "layer": id.0 }))
}

/// Stores the user default for one effect kind ("Make Default" in the Layer Style dialog).
fn make_default(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "layer.layerStyle.makeDefault";
    let kind = req_str_kind(p, CMD)?;
    let params = match p.get("params") {
        Some(v) if v.is_object() => v.clone(),
        _ => return Err(bad(CMD, "`params` must be an object")),
    };
    s.presets.layer_defaults.insert(kind.to_string(), params);
    s.presets_changed();
    Ok(json!({"kind": kind}))
}

/// The user default for one effect kind, else its factory defaults.
fn default_for(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "layer.layerStyle.defaultFor";
    let kind = req_str_kind(p, CMD)?;
    match s.presets.layer_defaults.get(kind) {
        Some(v) if v.is_object() => Ok(json!({"params": v, "user": true})),
        _ => Ok(json!({"params": effect_defaults(kind), "user": false})),
    }
}

fn req_str_kind<'a>(p: &'a Value, cmd: &str) -> Result<&'a str> {
    let kind = p.get("kind").and_then(Value::as_str).ok_or_else(|| bad(cmd, "need `kind`"))?;
    if effect_from_params(kind, &Value::Null).is_none() {
        return Err(bad(cmd, format!("unknown effect {kind}")));
    }
    Ok(kind)
}

fn has_layer(s: &Session) -> std::result::Result<(), String> {
    let d = s.active().ok_or("no document open")?;
    d.active_layer.filter(|id| d.doc.layer(*id).is_some()).map(|_| ()).ok_or_else(|| "no active layer".into())
}

macro_rules! style_cmd {
    ($kind:literal, $label:literal, $params:literal) => {
        CommandSpec {
            id: concat!("layer.layerStyle.", $kind),
            label: $label,
            menu: &["Layer", "Layer Style"],
            shortcut: None,
            params: $params,
            enabled: has_layer,
            run: |s, p| set_effect(s, p, $kind),
            journal: true,
        }
    };
}

/// The `layer.layerStyle.*` command specs.
pub fn specs() -> Vec<CommandSpec> {
    vec![
        style_cmd!(
            "dropShadow",
            "Drop Shadow…",
            r##"{"color":"#rrggbb","opacity":0..100=75,"blend":str="multiply","angle":deg=120,"useGlobalLight":bool,"distance":px=5,"spread":0..100,"size":px=5,"contour":"Linear|Cone|Cone (Inverted)|Domed|Domed (Inverted)|Diagonal (Descending)"="Linear","noise":0..100,"knocksOut":bool,"add":bool,"layer":id}"##
        ),
        style_cmd!(
            "innerShadow",
            "Inner Shadow…",
            r##"{"color":"#rrggbb","opacity":0..100=75,"blend":str,"angle":deg,"distance":px,"choke":0..100,"size":px,"contour":name,"noise":0..100,"add":bool}"##
        ),
        style_cmd!(
            "outerGlow",
            "Outer Glow…",
            r##"{"color":"#rrggbb","opacity":0..100=75,"blend":str="screen","technique":"softer|precise","spread":0..100,"size":px,"range":0..100,"contour":name,"noise":0..100,"add":bool}"##
        ),
        style_cmd!(
            "innerGlow",
            "Inner Glow…",
            r##"{"color":"#rrggbb","opacity":0..100=75,"blend":str="screen","technique":"softer|precise","source":"edge|center","choke":0..100,"size":px,"contour":name,"noise":0..100,"add":bool}"##
        ),
        style_cmd!(
            "stroke",
            "Stroke…",
            r##"{"size":px=3,"position":"outside|inside|center","color":"#rrggbb","from":"#rrggbb","to":"#rrggbb","style":str,"angle":deg,"opacity":0..100,"blend":str,"add":bool}"##
        ),
        style_cmd!("colorOverlay", "Color Overlay…", r##"{"color":"#rrggbb","opacity":0..100=100,"blend":str,"add":bool}"##),
        style_cmd!(
            "gradientOverlay",
            "Gradient Overlay…",
            r##"{"from":"#rrggbb","to":"#rrggbb","style":"linear|radial|angle|reflected|diamond","angle":deg=90,"scale":10..150=100,"reverse":bool,"opacity":0..100,"blend":str,"add":bool}"##
        ),
        style_cmd!(
            "patternOverlay",
            "Pattern Overlay…",
            r##"{"pattern":id|name?=first library pattern,"opacity":0..100=100,"blend":str,"scale":1..1000=100,"angle":deg=0,"link":bool=true,"phaseX":px,"phaseY":px,"add":bool}"##
        ),
        style_cmd!(
            "bevelEmboss",
            "Bevel & Emboss…",
            r##"{"style":"inner|outer|emboss|pillow|stroke","technique":"smooth|chiselHard|chiselSoft","contour":bool,"contourRange":1..100=50,"texture":pattern id|name?,"textureScale":1..1000=100,"textureDepth":-1000..1000=100,"textureInvert":bool,"textureLink":bool=true,"depth":1..1000=100,"direction":"up|down","size":px=5,"soften":px,"angle":deg,"altitude":deg,"add":bool}"##
        ),
        style_cmd!("satin", "Satin…", r##"{"color":"#rrggbb","opacity":0..100=50,"blend":str,"angle":deg,"distance":px,"size":px,"invert":bool,"add":bool}"##),
        CommandSpec {
            id: "layer.layerStyle.replace",
            label: "Edit Layer Style",
            menu: &[],
            shortcut: None,
            params: r##"{"layer":id,"effects":[{"kind":"dropShadow|innerShadow|outerGlow|innerGlow|stroke|colorOverlay|gradientOverlay|patternOverlay|satin|bevelEmboss","params":{…layer.layerStyle.<kind> params…},"fx":<effect snapshot carried through the Layer Style dialog, optional>}]} (replaces the layer's whole effect list; an entry with `fx` edits that effect with the params present, one without builds from params)"##,
            enabled: has_layer,
            run: replace_effects,
            journal: true,
        },
        CommandSpec {
            id: "layer.layerStyle.makeDefault",
            label: "Make Layer Style Default",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":"stroke|dropShadow|innerShadow|outerGlow|innerGlow|colorOverlay|gradientOverlay|patternOverlay|satin|bevelEmboss","params":{…param set…}} (stores the user default the Layer Style dialog's Reset to Default restores)"##,
            enabled: always,
            run: make_default,
            journal: false,
        },
        CommandSpec {
            id: "layer.layerStyle.defaultFor",
            label: "Layer Style Default",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":str} → {"params":{…},"user":bool} (the saved user default, else the factory defaults)"##,
            enabled: always,
            run: default_for,
            journal: false,
        },
        CommandSpec {
            id: "layer.layerStyle.clear",
            label: "Clear Layer Style",
            menu: &["Layer", "Layer Style"],
            shortcut: None,
            params: r##"{"layer":id}"##,
            enabled: has_layer,
            run: |s, p| {
                let id = match p.get("layer").and_then(Value::as_u64) {
                    Some(id) => photosuite_doc::LayerId(id),
                    None => s.active().and_then(|d| d.active_layer).ok_or(EngineError::Other("no active layer".into()))?,
                };
                s.edit("Clear Layer Style", |doc, _| {
                    let l = doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?;
                    l.effects = photosuite_doc::Effects { enabled: true, ..Default::default() };
                    Ok(())
                })?;
                Ok(Value::Null)
            },
            journal: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 32, "height": 32})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        s
    }

    fn effects(s: &Session) -> Vec<Effect> {
        let d = s.active().unwrap();
        d.doc.layer(d.active_layer.unwrap()).unwrap().effects.items.clone()
    }

    #[test]
    fn bevel_command_sets_technique_contour_and_texture() {
        let mut s = session();
        s.execute("layer.layerStyle.bevelEmboss", json!({"style": "pillow", "technique": "chiselHard", "contour": true, "contourRange": 70, "texture": "Bubbles", "textureDepth": -200, "textureInvert": true})).unwrap();
        let fx = effects(&s);
        let Effect::BevelEmboss(b) = &fx[0] else { panic!("{fx:?}") };
        assert_eq!((b.style, b.technique), (photosuite_doc::BevelStyle::PillowEmboss, BevelTechnique::ChiselHard));
        assert!((b.contour.as_ref().unwrap().range - 0.7).abs() < 1e-6);
        let t = b.texture.as_ref().unwrap();
        assert_eq!((t.name.as_str(), t.depth, t.invert), ("Bubbles", -2.0, true));
    }

    #[test]
    fn every_style_command_adds_its_effect() {
        for kind in ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "stroke", "colorOverlay", "gradientOverlay", "bevelEmboss", "satin"] {
            let mut s = session();
            s.execute(&format!("layer.layerStyle.{kind}"), json!({})).unwrap();
            let fx = effects(&s);
            assert_eq!(fx.len(), 1, "{kind}");
            assert!(fx[0].enabled());
        }
    }

    #[test]
    fn params_are_applied_and_replace_or_add() {
        let mut s = session();
        s.execute("layer.layerStyle.stroke", json!({"size": 7, "position": "inside", "color": "#00ff00", "opacity": 50})).unwrap();
        match &effects(&s)[0] {
            Effect::Stroke(st) => {
                assert_eq!(st.size, 7.0);
                assert_eq!(st.position, StrokePosition::Inside);
                assert_eq!(st.common.opacity, 0.5);
                assert_eq!(st.paint, FxPaint::Color(Color::rgb(0.0, 1.0, 0.0)));
            }
            other => panic!("{other:?}"),
        }
        s.execute("layer.layerStyle.stroke", json!({"size": 2})).unwrap();
        assert_eq!(effects(&s).len(), 1, "replaces");
        s.execute("layer.layerStyle.stroke", json!({"size": 4, "add": true})).unwrap();
        assert_eq!(effects(&s).len(), 2, "adds a second instance");
        s.execute("layer.layerStyle.dropShadow", json!({"blend": "normal", "distance": 12})).unwrap();
        assert!(matches!(&effects(&s)[2], Effect::DropShadow(sh) if sh.common.blend == BlendMode::Normal && sh.distance == 12.0));
    }

    #[test]
    fn clear_and_undo() {
        let mut s = session();
        s.execute("layer.layerStyle.colorOverlay", json!({"color": "#ff0000"})).unwrap();
        s.execute("layer.layerStyle.clear", json!({})).unwrap();
        assert!(effects(&s).is_empty());
        s.execute("edit.undo", json!({})).unwrap();
        assert_eq!(effects(&s).len(), 1);
    }

    #[test]
    fn color_overlay_renders() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
        s.execute("layer.layerStyle.colorOverlay", json!({"color": "#ff0000"})).unwrap();
        let px: Vec<f32> = serde_json::from_value(s.execute("document.pixel", json!({"x": 3, "y": 3})).unwrap()).unwrap();
        assert!(px[0] > 0.99 && px[1] < 0.01, "{px:?}");
    }

    #[test]
    fn gradient_styles_parse() {
        assert_eq!(gradient_style("Radial"), GradientStyle::Radial);
        assert_eq!(gradient_style("diamond"), GradientStyle::Diamond);
        assert_eq!(gradient_style("?"), GradientStyle::Linear);
    }

    fn snapshot(fx: &Effect) -> Value {
        serde_json::to_value(fx).unwrap()
    }

    #[test]
    fn every_kind_has_factory_defaults() {
        for kind in
            ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "stroke", "colorOverlay", "gradientOverlay", "patternOverlay", "satin", "bevelEmboss"]
        {
            assert!(effect_defaults(kind).as_object().is_some_and(|o| !o.is_empty()), "{kind}");
            assert!(effect_from_params(kind, &json!({})).is_some(), "{kind}");
        }
        assert!(effect_from_params("nope", &json!({})).is_none());
    }

    #[test]
    fn replace_builds_edits_and_preserves_instances() {
        let mut s = session();
        // Two strokes: the first edits a snapshot (params overlay), the second is fresh.
        let first = Effect::Stroke(StrokeFx {
            common: photosuite_doc::FxCommon::new(BlendMode::Normal, 1.0),
            size: 7.0,
            position: StrokePosition::Outside,
            paint: FxPaint::Gradient(Gradient { stops: vec![(0.0, Color::rgb(0.0, 0.0, 1.0)), (1.0, Color::WHITE)], ..Gradient::default() }),
        });
        let r = s
            .execute(
                "layer.layerStyle.replace",
                json!({"effects": [
                    {"kind": "stroke", "fx": snapshot(&first), "params": {"opacity": 50}},
                    {"kind": "stroke", "params": {"size": 2, "color": "#ffffff"}},
                ]}),
            )
            .unwrap();
        assert_eq!(r["effects"], 2);
        let fx = effects(&s);
        assert_eq!(fx.len(), 2, "order preserved");
        match (&fx[0], &fx[1]) {
            (Effect::Stroke(a), Effect::Stroke(b)) => {
                assert_eq!(a.common.opacity, 0.5);
                // The overlay must not clobber the gradient paint it doesn't model.
                assert!(matches!(&a.paint, FxPaint::Gradient(g) if g.stops.len() == 2 && g.stops[0].1 == Color::rgb(0.0, 0.0, 1.0)));
                assert_eq!(b.size, 2.0);
                assert_eq!(b.paint, FxPaint::Color(Color::rgb(1.0, 1.0, 1.0)));
            }
            other => panic!("{other:?}"),
        }
        // Replacing with an empty list clears the layer.
        s.execute("layer.layerStyle.replace", json!({"effects": []})).unwrap();
        assert!(effects(&s).is_empty());
    }

    #[test]
    fn replace_rejects_bad_entries_gracefully() {
        let mut s = session();
        let stroke = Effect::Stroke(StrokeFx {
            common: photosuite_doc::FxCommon::new(BlendMode::Normal, 1.0),
            size: 3.0,
            position: StrokePosition::Outside,
            paint: FxPaint::Color(Color::BLACK),
        });
        for p in [
            json!({}),
            json!({"effects": "nope"}),
            json!({"effects": [{"params": {}}]}),
            json!({"effects": [{"kind": "nope"}]}),
            json!({"effects": [{"kind": "stroke", "fx": {"Bogus": {}}}]}),
            json!({"effects": [{"kind": "stroke", "fx": 3}]}),
            json!({"effects": [{"kind": "dropShadow", "fx": snapshot(&stroke)}]}),
            json!({"effects": [{"kind": "stroke", "fx": snapshot(&stroke), "params": "nope"}]}),
        ] {
            assert!(s.execute("layer.layerStyle.replace", p).is_err());
        }
        // A long list is refused, not run.
        let many: Vec<_> = (0..257).map(|_| json!({"kind": "stroke"})).collect();
        assert!(s.execute("layer.layerStyle.replace", json!({"effects": many})).is_err());
        assert!(effects(&s).is_empty(), "nothing was applied");
    }

    #[test]
    fn contour_and_noise_params_edit_existing_effects() {
        let mut s = session();
        s.execute("layer.layerStyle.dropShadow", json!({})).unwrap();
        let before = effects(&s);
        let Effect::DropShadow(_) = &before[0] else { panic!("{before:?}") };
        let fx0 = snapshot(&before[0]);
        // Unknown contour names are carried, not clobbered to Linear.
        s.execute("layer.layerStyle.replace", json!({"effects": [{"kind": "dropShadow", "fx": fx0, "params": {"contour": "Cone", "noise": 30}}]})).unwrap();
        let fx = effects(&s);
        let Effect::DropShadow(sh) = &fx[0] else { panic!("{fx:?}") };
        assert_eq!(sh.contour, builtin_contour("Cone").unwrap(), "known preset applies");
        assert!((sh.noise - 0.3).abs() < 1e-6, "noise in percent");
        // An imported contour with an unknown name survives the same round trip.
        let imported = Contour::Custom {
            name: "Photoshop contour".into(),
            points: vec![photosuite_doc::adjust::CurvePoint { input: 0.0, output: 1.0 }, photosuite_doc::adjust::CurvePoint { input: 1.0, output: 0.0 }],
        };
        let mut carried = before[0].clone();
        if let Effect::DropShadow(c) = &mut carried {
            c.contour = imported.clone();
        }
        overlay_effect(&mut carried, &json!({"contour": "Photoshop contour"}));
        let Effect::DropShadow(after) = &carried else { panic!() };
        assert_eq!(after.contour, imported);
        // Linear applies by name.
        let mut back = carried;
        overlay_effect(&mut back, &json!({"contour": "Linear"}));
        let Effect::DropShadow(lin) = &back else { panic!() };
        assert_eq!(lin.contour, Contour::Linear);
    }

    #[test]
    fn make_default_then_reset_restores_it() {
        let mut s = session();
        // Factory default first: Reset without a saved default gives the factory set.
        let r = s.execute("layer.layerStyle.defaultFor", json!({"kind": "stroke"})).unwrap();
        assert_eq!(r["user"], json!(false));
        assert_eq!(r["params"]["size"], json!(3));
        s.execute(
            "layer.layerStyle.makeDefault",
            json!({"kind": "stroke", "params": {"size": 9, "position": "inside", "blend": "Normal", "opacity": 100, "color": "#000000"}}),
        )
        .unwrap();
        let r = s.execute("layer.layerStyle.defaultFor", json!({"kind": "stroke"})).unwrap();
        assert_eq!(r["user"], json!(true));
        assert_eq!(r["params"]["size"], json!(9));
        // Bad kinds and params are graceful errors.
        assert!(s.execute("layer.layerStyle.makeDefault", json!({"kind": "nope", "params": {}})).is_err());
        assert!(s.execute("layer.layerStyle.makeDefault", json!({"kind": "stroke", "params": "x"})).is_err());
        assert!(s.execute("layer.layerStyle.defaultFor", json!({"kind": "nope"})).is_err());
    }

    #[test]
    fn layer_style_defaults_persist_with_presets() {
        let mut s = session();
        s.execute("layer.layerStyle.makeDefault", json!({"kind": "stroke", "params": {"size": 9}})).unwrap();
        let blob = s.presets.to_json(&s);
        let mut t = Session::new();
        t.load_presets_json(blob);
        let r = t.execute("layer.layerStyle.defaultFor", json!({"kind": "stroke"})).unwrap();
        assert_eq!(r["user"], json!(true));
        assert_eq!(r["params"]["size"], json!(9));
    }

    #[test]
    fn double_stroke_bands_render_and_survive_an_edit() {
        // The manga/typesetting case (#157): a 7 px white stroke under a 3 px black one.
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 48, "height": 48})).unwrap();
        s.execute("layer.new.layer", json!({})).unwrap();
        s.execute("select.rect", json!({"x": 16, "y": 16, "width": 16, "height": 16})).unwrap();
        s.execute("edit.fill", json!({"color": "#000000"})).unwrap();
        s.execute("select.deselect", json!({})).unwrap();
        s.execute("layer.layerStyle.stroke", json!({"size": 3, "color": "#000000", "position": "outside"})).unwrap();
        s.execute("layer.layerStyle.stroke", json!({"size": 7, "color": "#ffffff", "position": "outside", "add": true})).unwrap();
        let px = |s: &mut Session, x: i32, y: i32| -> [f32; 4] {
            let mut v: Vec<f32> = serde_json::from_value(s.execute("document.pixel", json!({"x": x, "y": y})).unwrap()).unwrap();
            v.resize(4, 1.0);
            [v[0], v[1], v[2], v[3]]
        };
        // Bands from the square edge outward: 0..3 px black (the first stroke renders on top),
        // 3..7 px white, then the white background.
        assert!(px(&mut s, 24, 24)[0] < 0.1, "the square is black");
        assert!(px(&mut s, 24, 14)[0] < 0.1, "the first stroke covers the wider one");
        assert!(px(&mut s, 24, 11)[0] > 0.9, "the second stroke shows outside it");
        assert!(px(&mut s, 24, 5)[0] > 0.9, "background beyond both");
        // A dialog round trip (replace with the same snapshots) keeps both bands.
        let before = px(&mut s, 24, 14);
        let st = s.active().unwrap();
        let id = st.active_layer.unwrap();
        let items = st.doc.layer(id).unwrap().effects.items.clone();
        let entries: Vec<Value> = items.iter().map(|fx| json!({"kind": "stroke", "fx": serde_json::to_value(fx).unwrap(), "params": {}})).collect();
        s.execute("layer.layerStyle.replace", json!({"layer": id.0, "effects": entries})).unwrap();
        assert_eq!(px(&mut s, 24, 14), before, "both strokes render identically after the round trip");
    }
}
