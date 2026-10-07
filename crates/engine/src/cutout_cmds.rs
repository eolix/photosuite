//! Layer › Remove Background: isolate the subject of a pixel layer in one history step.
//!
//! The subject is found with the same classical saliency + GrabCut path as Select › Subject, then
//! optionally refined. The default result is a layer mask (original pixels stay recoverable);
//! `"output":"transparency"` bakes coverage into pixel alpha. An optional `"fill"` colour inserts a
//! solid Color Fill layer immediately below the subject in that same step.

use photosuite_algo::matting::{self, RefineParams};
use photosuite_algo::segment::{Sampler, SurfaceSampler, subject};
use photosuite_color::Color;
use photosuite_doc::{Document, Fill, Layer, LayerContent, LayerId, LayerMask};
use photosuite_geom::Rect;
use serde_json::{Value, json};

use crate::commands::{CommandSpec, layer_param};
use crate::{EngineError, Result, Session};

const CMD: &str = "layer.removeBackground";

fn bad(msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: CMD.into(), msg: msg.into() }
}

/// Composite of all visible layers (same split as `select.subject`).
struct CompositeSampler<'a>(&'a Document);

impl Sampler for CompositeSampler<'_> {
    fn rgba(&self, r: Rect) -> Vec<[f32; 4]> {
        photosuite_compose::render(self.0, r).px
    }
}

fn enabled(s: &Session) -> std::result::Result<(), String> {
    let l = crate::active_layer_of(s)?;
    if !matches!(l.content, LayerContent::Raster(_)) {
        return Err(format!("active layer is a {} layer, not a pixel layer", l.content.kind_name()));
    }
    if l.locks.pixels || l.locks.all {
        return Err(format!("the layer \"{}\" is locked", l.name));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Output {
    Mask,
    Transparency,
}

impl Output {
    fn as_str(self) -> &'static str {
        match self {
            Output::Mask => "mask",
            Output::Transparency => "transparency",
        }
    }
}

fn output_param(p: &Value) -> Result<Output> {
    match p.get("output") {
        None => Ok(Output::Mask),
        Some(Value::String(s)) => match s.as_str() {
            "mask" => Ok(Output::Mask),
            "transparency" => Ok(Output::Transparency),
            _ => Err(bad("output must be mask|transparency")),
        },
        Some(_) => Err(bad("output must be mask|transparency")),
    }
}

fn radius_param(p: &Value) -> Result<f32> {
    match p.get("radius") {
        None => Ok(2.0),
        Some(v) => {
            let Some(x) = v.as_f64() else {
                return Err(bad("radius must be a finite number in 0..=64"));
            };
            if !x.is_finite() || x < 0.0 {
                return Err(bad("radius must be a finite number in 0..=64"));
            }
            Ok((x as f32).clamp(0.0, 64.0))
        }
    }
}

fn fill_param(p: &Value) -> Result<Option<Color>> {
    match p.get("fill") {
        None => Ok(None),
        Some(Value::String(s)) => {
            let [r, g, b] = crate::prefs::parse_hex(s).ok_or_else(|| bad("fill must be #rrggbb"))?;
            Ok(Some(Color::rgb(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0)))
        }
        Some(_) => Err(bad("fill must be #rrggbb")),
    }
}

fn bool_or(p: &Value, key: &str, default: bool) -> bool {
    p.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn target_layer(s: &Session, p: &Value) -> Result<LayerId> {
    let _ = s.active().ok_or(EngineError::NoDocument)?;
    let id = layer_param(s, p)?;
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let l = st.doc.layer(id).ok_or(EngineError::NoLayer(id))?;
    if !matches!(l.content, LayerContent::Raster(_)) {
        return Err(EngineError::Other(format!("the layer is a {} layer, not a pixel layer", l.content.kind_name())));
    }
    if l.locks.pixels || l.locks.all {
        return Err(EngineError::Other(format!("Could not complete your request because the layer \"{}\" is locked", l.name)));
    }
    Ok(id)
}

fn find_subject(doc: &Document, id: LayerId, sample_all: bool) -> Result<Option<photosuite_algo::selection::Region>> {
    let canvas = doc.bounds();
    if sample_all {
        return Ok(subject::select_subject(&CompositeSampler(doc), canvas));
    }
    let surf = doc.layer(id).and_then(photosuite_doc::Layer::surface).ok_or_else(|| EngineError::Other("not a pixel layer".into()))?;
    Ok(subject::select_subject(&SurfaceSampler(surf), canvas))
}

fn refine_subject(
    doc: &Document,
    id: LayerId,
    sample_all: bool,
    region: photosuite_algo::selection::Region,
    radius: f32,
) -> Result<photosuite_algo::selection::Region> {
    let canvas = doc.bounds();
    let params = RefineParams { radius, smart_radius: true, smooth: 10.0, feather: 0.5, contrast: 10.0, shift_edge: 0.0 };
    let refined = if sample_all {
        matting::refine_mask(&CompositeSampler(doc), &matting::region_reader(&region), region.bbox, canvas, &params)
    } else {
        let surf = doc.layer(id).and_then(photosuite_doc::Layer::surface).ok_or_else(|| EngineError::Other("not a pixel layer".into()))?;
        matting::refine_mask(&SurfaceSampler(surf), &matting::region_reader(&region), region.bbox, canvas, &params)
    };
    Ok(refined.unwrap_or(region))
}

fn apply_cutout(doc: &mut Document, id: LayerId, region: &photosuite_algo::selection::Region, output: Output) -> Result<()> {
    match output {
        Output::Transparency => {
            let src = doc.layer(id).and_then(photosuite_doc::Layer::surface).cloned().ok_or_else(|| EngineError::Other("not a pixel layer".into()))?;
            let pixels = matting::masked_copy(&src, region);
            let l = doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?;
            l.content = LayerContent::Raster(pixels);
            l.mask = None;
        }
        Output::Mask => {
            let surface = matting::region_surface(region);
            let l = doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?;
            l.mask = Some(LayerMask { surface, ..LayerMask::reveal_all() });
        }
    }
    doc.selection = None;
    Ok(())
}

fn insert_fill_below(doc: &mut Document, subject: LayerId, color: Color) -> LayerId {
    let layer = Layer::new(doc.next_layer_name("Color Fill"), LayerContent::Fill(Fill::Solid(color)));
    let fid = doc.insert_above(Some(subject), layer);
    let _ = doc.shift(fid, -1);
    fid
}

struct CutoutOut {
    layer: u64,
    output: &'static str,
    fill_layer: Option<u64>,
    bounds: [i32; 4],
}

fn run(s: &mut Session, p: &Value) -> Result<Value> {
    let output = output_param(p)?;
    let radius = radius_param(p)?;
    let fill = fill_param(p)?;
    let sample_all = bool_or(p, "sampleAllLayers", true);
    let refine = bool_or(p, "refine", true);
    let id = target_layer(s, p)?;
    crate::jobs::edit_job(
        s,
        "Remove Background",
        move |doc, _active, ctx| {
            crate::extra_cmds::background_to_layer_for_mask(doc, id);
            if ctx.cancelled() {
                return Err(EngineError::Cancelled);
            }
            ctx.progress(0.15, "Finding subject");
            let mut region = find_subject(doc, id, sample_all)?.ok_or_else(|| EngineError::Other("no subject found".into()))?;
            if ctx.cancelled() {
                return Err(EngineError::Cancelled);
            }
            if refine {
                ctx.progress(0.55, "Refining edge");
                region = refine_subject(doc, id, sample_all, region, radius)?;
                if ctx.cancelled() {
                    return Err(EngineError::Cancelled);
                }
            }
            ctx.progress(0.85, "Applying");
            apply_cutout(doc, id, &region, output)?;
            let fill_layer = fill.map(|color| insert_fill_below(doc, id, color).0);
            let b = region.bbox;
            Ok(CutoutOut { layer: id.0, output: output.as_str(), fill_layer, bounds: [b.x0, b.y0, b.width() as i32, b.height() as i32] })
        },
        |r| {
            let mut v = json!({ "layer": r.layer, "output": r.output, "bounds": r.bounds });
            if let Some(fid) = r.fill_layer {
                v["fillLayer"] = json!(fid);
            }
            v
        },
    )
}

/// Remove Background command spec.
pub fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: CMD,
        label: "Remove Background",
        menu: &["Layer"],
        shortcut: None,
        params: r##"{"layer":id?,"sampleAllLayers":bool=true,"output":"mask|transparency"="mask","refine":bool=true,"radius":px=2,"fill":"#rrggbb?"}"##,
        enabled,
        run,
        journal: true,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use photosuite_algo::segment::Rng;

    fn session_with(w: u32, h: u32, depth: u32, px: impl Fn(u32, u32) -> [f32; 3]) -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": w, "height": h, "depth": depth})).unwrap();
        s.edit("paint", |doc, _| {
            let bg = doc.layers[0].surface_mut().unwrap();
            let n = bg.channels();
            let mut data = Vec::with_capacity((w * h) as usize * n);
            for y in 0..h {
                for x in 0..w {
                    let c = px(x, y);
                    data.extend_from_slice(&c[..n.min(3)]);
                    if n == 4 {
                        data.push(1.0);
                    }
                }
            }
            bg.write_region(Rect::new(0, 0, w as i32, h as i32), &data);
            Ok(())
        })
        .unwrap();
        s
    }

    fn noise_field(w: u32, h: u32, seed: u64) -> Vec<f32> {
        let mut rng = Rng::new(seed);
        (0..w * h).map(|_| rng.normal()).collect()
    }

    /// Textured disc (centre (100, 80), radius 45) on a noisy background.
    fn disc(depth: u32) -> (Session, impl Fn(i32, i32) -> bool) {
        let nz = noise_field(200, 160, 2);
        let inside = |x: i32, y: i32| {
            let (dx, dy) = (x as f32 + 0.5 - 100.0, y as f32 + 0.5 - 80.0);
            dx * dx + dy * dy <= 45.0 * 45.0
        };
        let s = session_with(200, 160, depth, move |x, y| {
            let n = 0.05 * nz[(y * 200 + x) as usize];
            if inside(x as i32, y as i32) {
                let t = ((x + y) as f32 * 0.35).sin() * 0.5 + 0.5;
                [0.85 + 0.05 * t + n, 0.2 + 0.3 * t + n, 0.15 + n]
            } else {
                [0.25 + n, 0.45 + n, 0.7 + n]
            }
            .map(|v| v.clamp(0.0, 1.0))
        });
        (s, inside)
    }

    fn active_id(s: &Session) -> LayerId {
        s.active().unwrap().active_layer.unwrap()
    }

    fn layer(s: &Session, id: LayerId) -> &photosuite_doc::Layer {
        s.active().unwrap().doc.layer(id).unwrap()
    }

    fn mask_cov(s: &Session, x: i32, y: i32) -> f32 {
        let id = active_id(s);
        layer(s, id).mask.as_ref().map_or(0.0, |m| m.value(x, y))
    }

    fn mask_iou(s: &Session, w: i32, h: i32, truth: impl Fn(i32, i32) -> bool) -> f32 {
        let (mut i, mut u) = (0, 0);
        for y in 0..h {
            for x in 0..w {
                let (a, b) = (mask_cov(s, x, y) >= 0.5, truth(x, y));
                i += (a && b) as i32;
                u += (a || b) as i32;
            }
        }
        i as f32 / u.max(1) as f32
    }

    fn corner_alpha(s: &Session) -> f32 {
        let doc = &s.active().unwrap().doc;
        photosuite_compose::render(doc, Rect::new(0, 0, 1, 1)).px.first().map(|p| p[3]).unwrap_or(0.0)
    }

    fn corner_rgb(s: &Session) -> [f32; 3] {
        let doc = &s.active().unwrap().doc;
        let p = photosuite_compose::render(doc, Rect::new(0, 0, 1, 1)).px.first().copied().unwrap_or([0.0; 4]);
        [p[0], p[1], p[2]]
    }

    #[test]
    fn remove_background_mask_depths_and_undo() {
        for depth in [8, 16, 32] {
            let (mut s, inside) = disc(depth);
            assert!(s.is_enabled(CMD));
            let before_rev = s.active().unwrap().revision;
            let r = s.execute(CMD, json!({})).unwrap();
            assert_eq!(r["output"], "mask");
            assert_eq!(r["layer"], active_id(&s).0);
            let id = active_id(&s);
            assert!(layer(&s, id).mask.is_some(), "depth {depth}: expected a layer mask");
            let v = mask_iou(&s, 200, 160, &inside);
            assert!(v >= 0.75, "depth {depth}: IoU {v}");
            assert!(mask_cov(&s, 0, 0) < 0.2, "depth {depth}: background corner still revealed");
            assert!(mask_cov(&s, 100, 80) >= 0.8, "depth {depth}: disc centre hidden");
            assert!(corner_alpha(&s) < 0.2, "depth {depth}: composite corner alpha {}", corner_alpha(&s));
            assert!(s.active().unwrap().doc.selection.is_none());
            assert!(s.active().unwrap().revision > before_rev);
            s.execute("edit.undo", json!({})).unwrap();
            assert!(layer(&s, id).mask.is_none(), "depth {depth}: mask remained after undo");
            s.execute("edit.redo", json!({})).unwrap();
            assert!(layer(&s, id).mask.is_some(), "depth {depth}: mask missing after redo");
        }
    }

    #[test]
    fn remove_background_transparency_and_fill() {
        let (mut s, _) = disc(8);
        let subject = active_id(&s);
        let layers_before = s.active().unwrap().doc.layer_count();
        let r = s.execute(CMD, json!({"output": "transparency", "fill": "#00aa44"})).unwrap();
        assert_eq!(r["output"], "transparency");
        assert_eq!(r["layer"], subject.0);
        let fill_id = LayerId(r["fillLayer"].as_u64().unwrap());
        assert_eq!(s.active().unwrap().doc.layer_count(), layers_before + 1);
        assert_eq!(active_id(&s), subject);
        let l = layer(&s, subject);
        assert!(l.mask.is_none(), "transparency output should drop the mask");
        let surf = l.surface().unwrap();
        assert!(surf.format().alpha);
        let a = |x: i32, y: i32| {
            let p = surf.pixel(x, y);
            *p.last().unwrap_or(&0.0)
        };
        assert!(a(0, 0) < 0.2, "corner alpha {}", a(0, 0));
        assert!(a(100, 80) >= 0.8, "centre alpha {}", a(100, 80));
        let fl = layer(&s, fill_id);
        assert!(matches!(&fl.content, LayerContent::Fill(Fill::Solid(c)) if (c.c[1] - 170.0 / 255.0).abs() < 0.02));
        let walk: Vec<LayerId> = s.active().unwrap().doc.walk().into_iter().map(|(_, _, l)| l.id).collect();
        let fi = walk.iter().position(|x| *x == fill_id).unwrap();
        let si = walk.iter().position(|x| *x == subject).unwrap();
        assert!(fi < si, "fill layer should sit below the subject");
        let rgb = corner_rgb(&s);
        assert!((rgb[0] - 0.0).abs() < 0.08 && (rgb[1] - 170.0 / 255.0).abs() < 0.08 && (rgb[2] - 68.0 / 255.0).abs() < 0.08, "fill colour at corner {rgb:?}");
        s.execute("edit.undo", json!({})).unwrap();
        assert_eq!(s.active().unwrap().doc.layer_count(), layers_before);
        assert!(s.active().unwrap().doc.layer(fill_id).is_none());
        assert!(layer(&s, subject).mask.is_none());
        let orig = layer(&s, subject).surface().unwrap().pixel(0, 0);
        let oa = if orig.len() >= 4 { orig[3] } else { 1.0 };
        assert!(oa > 0.9, "undo should restore opaque pixels, alpha {oa}");
    }

    #[test]
    fn remove_background_promotes_background() {
        let (mut s, _) = disc(8);
        let id = active_id(&s);
        let l = layer(&s, id);
        assert_eq!(l.name, "Background");
        assert!(l.locks.transparency && l.locks.position);
        s.execute(CMD, json!({})).unwrap();
        let l = layer(&s, id);
        assert!(
            l.name != "Background" || !l.locks.transparency || !l.locks.position,
            "still the Background: {} locks t={} p={}",
            l.name,
            l.locks.transparency,
            l.locks.position
        );
        assert_eq!(l.name, "Layer 0");
        assert!(!l.locks.transparency && !l.locks.position);
        assert!(l.mask.is_some());
    }

    #[test]
    fn remove_background_no_subject_leaves_document() {
        let mut s = session_with(32, 32, 8, |_, _| [0.5, 0.5, 0.5]);
        let before = s.active().unwrap().revision;
        let id = active_id(&s);
        assert!(s.execute(CMD, json!({})).is_err());
        assert_eq!(s.active().unwrap().revision, before);
        assert!(layer(&s, id).mask.is_none());
    }

    #[test]
    fn remove_background_disabled_and_bad_params() {
        assert!(!Session::new().is_enabled(CMD));
        assert!(Session::new().execute(CMD, json!({})).is_err());

        let (mut s, _) = disc(8);
        s.execute("type.create", json!({"text": "Hi", "size": 24, "x": 10, "y": 20})).unwrap();
        assert!(!s.is_enabled(CMD));
        assert!(s.execute(CMD, json!({})).is_err());

        let (mut s, _) = disc(8);
        s.execute("shape.create", json!({"kind": "rect", "rect": [10, 10, 40, 20], "fill": "#ff0000"})).unwrap();
        assert!(!s.is_enabled(CMD));
        assert!(s.execute(CMD, json!({})).is_err());

        let (mut s, _) = disc(8);
        let id = active_id(&s);
        s.edit("lock", |doc, _| {
            doc.layer_mut(id).unwrap().locks.pixels = true;
            Ok(())
        })
        .unwrap();
        assert!(!s.is_enabled(CMD));
        assert!(s.execute(CMD, json!({})).is_err());

        let (mut s, _) = disc(8);
        assert!(s.execute(CMD, json!({"output": "bogus"})).is_err());
        assert!(s.execute(CMD, json!({"fill": "nope"})).is_err());
        assert!(s.execute(CMD, json!({"radius": -1})).is_err());
        assert!(s.execute(CMD, json!({"radius": f64::NAN})).is_err());
        assert!(s.execute(CMD, json!({"radius": f64::INFINITY})).is_err());
        assert!(s.execute(CMD, json!({"layer": 999999})).is_err());
        let before = s.active().unwrap().revision;
        assert!(s.execute(CMD, json!({"fill": "nope"})).is_err());
        assert_eq!(s.active().unwrap().revision, before, "bad fill must not edit");
    }

    #[test]
    fn remove_background_ignores_hidden_lower_layer_when_not_sampling_all() {
        let (mut s, _) = disc(8);
        let bottom = active_id(&s);
        s.execute("layer.new.layer", json!({"name": "Empty"})).unwrap();
        let top = active_id(&s);
        s.edit("hide", |doc, _| {
            doc.layer_mut(bottom).unwrap().visible = false;
            Ok(())
        })
        .unwrap();
        s.execute("layer.select", json!({"layer": top.0})).unwrap();
        let before = s.active().unwrap().revision;
        assert!(s.execute(CMD, json!({"sampleAllLayers": false})).is_err());
        assert_eq!(s.active().unwrap().revision, before);
        assert!(layer(&s, top).mask.is_none());
        assert!(layer(&s, bottom).mask.is_none());
    }

    #[test]
    fn remove_background_twice_keeps_one_mask() {
        let (mut s, _) = disc(8);
        s.execute(CMD, json!({})).unwrap();
        s.execute(CMD, json!({})).unwrap();
        let id = active_id(&s);
        assert!(layer(&s, id).mask.is_some());
        let masks = s.active().unwrap().doc.walk().into_iter().filter(|(_, _, l)| l.mask.is_some()).count();
        assert_eq!(masks, 1);
    }
}
