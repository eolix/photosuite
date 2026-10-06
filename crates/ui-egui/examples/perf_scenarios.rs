//! Scorecard performance scenarios (#221): the measurable rows of the targets in #209, #210 and
//! #211, each timed through the command path the UI, CLI and MCP share (`Session::execute`) plus
//! the canvas refresh the app does after it (the app's own `GpuCanvas`, on a device created the
//! way the app creates it; the CPU compositor without an adapter).
//!
//! ```sh
//! cargo run --release -p photosuite-ui-egui --example perf_scenarios -- [--quick] [--json out.json] [--only text] [--reps N] [--cpu]
//! ```
//!
//! `cargo xtask perf` runs this and maps the rows to scenario ids in `perf/budgets.toml`, so
//! keep row names stable. `--quick` uses small synthetic documents (seconds, for smoke runs);
//! its numbers are only comparable with other `--quick` runs. Every row records p50 / p95 / max
//! over its samples, the peak resident memory measured in-process while it ran, and the GPU
//! bytes the canvas holds for the document (texture + compositor) when there is a GPU.

use std::time::Instant;

use eframe::egui_wgpu::RenderState;
use photosuite_engine::Session;
use photosuite_testkit::perf::{RssSampler, report, row, write_report};
use photosuite_ui_egui::gpu_canvas::GpuCanvas;
use serde_json::{Value, json};

type Res<T> = Result<T, String>;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn exec(s: &mut Session, id: &str, p: Value) -> Res<Value> {
    s.execute(id, p).map_err(|e| format!("{id}: {e}"))
}

fn active_layer(s: &Session) -> Res<u64> {
    s.active().and_then(|d| d.active_layer).map(|l| l.0).ok_or_else(|| "no active layer".to_string())
}

/// A photo-like RGB image (gradients, soft blobs, fine noise) with a high-contrast disc as the
/// subject, encoded as JPEG so it opens like a real photo.
fn photo_jpeg(w: u32, h: u32) -> Res<Vec<u8>> {
    use rayon::prelude::*;
    let mut px = vec![0u8; w as usize * h as usize * 3];
    let (cx, cy, r) = (w as f32 * 0.55, h as f32 * 0.5, w.min(h) as f32 / 3.0);
    px.par_chunks_mut(w as usize * 3).enumerate().for_each(|(y, row)| {
        for x in 0..w as usize {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            let n = ((x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)) % 997) as f32 / 997.0 - 0.5;
            let blob = (-(((fx - 0.4) * 3.0).powi(2) + ((fy - 0.55) * 4.0).powi(2))).exp();
            let inside = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt() < r;
            let (r0, g0, b0) = if inside { (0.85, 0.3 + 0.2 * (fx * 40.0).sin(), 0.15) } else { (0.35, 0.45, 0.55) };
            let rgb = [r0 + 0.1 * blob + n * 0.08, g0 + 0.1 * blob + n * 0.08, b0 + 0.2 * fy + n * 0.08];
            for (c, v) in rgb.into_iter().enumerate() {
                row[x * 3 + c] = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    });
    let img =
        photosuite_codecs::Image::from_raw(w, h, photosuite_codecs::ChannelLayout::Rgb, photosuite_codecs::SampleType::U8, px).map_err(|e| e.to_string())?;
    photosuite_codecs::encode(&img, photosuite_codecs::Format::Jpeg, &Default::default()).map_err(|e| e.to_string())
}

fn open_photo(w: u32, h: u32) -> Res<Session> {
    let jpeg = photo_jpeg(w, h)?;
    let doc = photosuite_io::import("photo.jpg", &jpeg).map_err(|e| e.to_string())?.document;
    let mut s = Session::new();
    s.open_document(doc, Some("photo.jpg".into()));
    Ok(s)
}

/// How far an edit's composite change reaches beyond its damage (layer effects); mirrors
/// `canvas::effect_reach`.
fn reach(layers: &[photosuite_doc::Layer]) -> i32 {
    layers
        .iter()
        .map(|l| {
            let own = if photosuite_compose::effects::has_effects(l) { photosuite_compose::effects::margin(l) } else { 0 };
            let kids = match &l.content {
                photosuite_doc::LayerContent::Group(g) => reach(&g.children),
                _ => 0,
            };
            own + kids
        })
        .max()
        .unwrap_or(0)
}

struct Bench {
    gpu: Option<(GpuCanvas, RenderState)>,
    sampler: RssSampler,
    reps: usize,
    only: Option<String>,
    rows: Vec<Value>,
    /// Rows that couldn't run: (name, error).
    errors: Vec<(String, String)>,
    /// The row being timed, so a panic inside it is reported against that row.
    current: Option<String>,
}

impl Bench {
    fn wanted(&self, name: &str) -> bool {
        self.only.as_ref().is_none_or(|o| name.contains(o.as_str()))
    }

    /// The canvas refresh after an edit (`canvas::ensure_gpu`): the damage rect grown by the
    /// effect reach when the session reports one, else everything; waits for the GPU.
    fn refresh(&self, s: &Session, full: bool) -> Res<f64> {
        let st = s.active().ok_or("no document")?;
        let doc = &st.doc;
        let damage = if full { None } else { st.last_damage.map(|r| r.inflate(reach(&doc.layers)).intersect(&doc.bounds())) };
        let t = Instant::now();
        match &self.gpu {
            Some((g, rs)) => {
                g.refresh(doc.id.0, doc, damage, None);
                let _ = rs.device.poll(eframe::wgpu::PollType::Wait { submission_index: None, timeout: None });
            }
            None => {
                let r = damage.unwrap_or(doc.bounds()).intersect(&doc.bounds());
                if !r.is_empty() {
                    std::hint::black_box(photosuite_compose::render(doc, r));
                }
            }
        }
        Ok(ms(t))
    }

    fn gpu_bytes(&self, s: &Session) -> Option<u64> {
        let (g, _) = self.gpu.as_ref()?;
        let tex = s.active().and_then(|d| g.texture_info(d.doc.id.0)).map_or(0, |(_, b)| b);
        let (resident, fx) = g.compositor_bytes().unwrap_or((0, 0));
        Some(tex + resident + fx as u64)
    }

    /// Times `f` `reps` times after one untimed warm-up run; `f` returns its own time in ms.
    fn time(&mut self, name: &str, s: &mut Session, reps: usize, warm: bool, mut f: impl FnMut(&Self, &mut Session, usize) -> Res<f64>) {
        if !self.wanted(name) {
            return;
        }
        self.current = Some(name.to_string());
        self.sampler.reset();
        let mut samples = Vec::new();
        let mut run = || -> Res<()> {
            if warm {
                f(self, s, 0)?;
            }
            for i in 0..reps.max(1) {
                samples.push(f(self, s, i + 1)?);
            }
            Ok(())
        };
        let result = run();
        self.record(name, s, &samples, result);
    }

    fn record(&mut self, name: &str, s: &Session, samples: &[f64], result: Res<()>) {
        match result {
            Ok(()) => {
                let r = row(name, samples, self.sampler.peak(), self.gpu_bytes(s));
                println!(
                    "{name:<52} p50 {:>9.2} ms  p95 {:>9.2} ms  max {:>9.2} ms  (n {}, peak RSS {} MB)",
                    r["p50_ms"].as_f64().unwrap_or(f64::NAN),
                    r["p95_ms"].as_f64().unwrap_or(f64::NAN),
                    r["max_ms"].as_f64().unwrap_or(f64::NAN),
                    samples.len(),
                    r["peak_rss_bytes"].as_u64().unwrap_or(0) >> 20,
                );
                self.rows.push(r);
            }
            Err(e) => {
                println!("{name:<52} ERROR {e}");
                self.errors.push((name.to_string(), e));
            }
        }
    }
}

/// A headless GPU canvas on a device created like the app's.
fn canvas() -> Option<(GpuCanvas, RenderState)> {
    let setup = photosuite_ui_egui::gpu_canvas::wgpu_setup();
    let rs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| egui_kittest::wgpu::create_render_state(setup, Default::default()))).ok()?;
    eprintln!("adapter: {}", rs.adapter.get_info().name);
    Some((GpuCanvas::new(&rs), rs))
}

/// Sizes per mode.
struct Sizes {
    /// The layered document of #209 (20 MP).
    layered: (u32, u32),
    /// A layer of 12 MP to duplicate and paste.
    big_layer: (u32, u32),
    /// Layers in the "150-layer document".
    many_layers: usize,
    /// The 16-bit document (15000 × 10000).
    huge16: (u32, u32),
    /// The 32-bit document with 20 layers.
    float32: (u32, u32),
    /// 10 MP for Content-Aware Fill and Spot Healing.
    ten_mp: (u32, u32),
    /// 24 MP for the selection algorithms and Content-Aware Scale.
    big_photo: (u32, u32),
    /// A4 at 300 ppi.
    a4: (u32, u32),
}

const FULL: Sizes = Sizes {
    layered: (5472, 3648),
    big_layer: (4243, 2828),
    many_layers: 150,
    huge16: (15000, 10000),
    float32: (4000, 3000),
    ten_mp: (3872, 2592),
    big_photo: (6000, 4000),
    a4: (2480, 3508),
};

const QUICK: Sizes = Sizes {
    layered: (1600, 1066),
    big_layer: (1200, 800),
    many_layers: 40,
    huge16: (2400, 1600),
    float32: (1200, 900),
    ten_mp: (1200, 800),
    big_photo: (1600, 1066),
    a4: (1240, 1754),
};

/// The layered document of #209: a background, six pixel layers with a drop shadow and a stroke,
/// four type layers with a drop shadow, and a Levels adjustment on top. Returns the session and
/// the id of the styled layer the edits target.
fn layered_doc(w: u32, h: u32) -> Res<(Session, u64)> {
    let mut s = Session::new();
    exec(&mut s, "file.new", json!({"width": w, "height": h, "background": "white"}))?;
    let mut target = 0;
    for i in 0..6u32 {
        exec(&mut s, "layer.new.layer", json!({"name": format!("panel {i}")}))?;
        let (x, y) = ((i % 3) * w / 3 + w / 24, (i / 3) * h / 2 + h / 16);
        exec(&mut s, "select.rect", json!({"x": x, "y": y, "width": w / 4, "height": h / 3, "ellipse": i % 2 == 1}))?;
        exec(&mut s, "edit.fill", json!({"color": format!("#{:02x}6040", 40 + i * 30)}))?;
        exec(&mut s, "select.deselect", json!({}))?;
        exec(&mut s, "layer.layerStyle.dropShadow", json!({"distance": 12, "size": 16}))?;
        exec(&mut s, "layer.layerStyle.stroke", json!({"size": 3, "color": "#202020", "add": true}))?;
        if i == 1 {
            target = active_layer(&s)?;
        }
    }
    for i in 0..4u32 {
        exec(&mut s, "type.create", json!({"x": w / 10 + i * w / 5, "y": h * 9 / 10, "text": format!("Headline {i}"), "size": (h / 30).max(12)}))?;
        exec(&mut s, "layer.layerStyle.dropShadow", json!({"distance": 6, "size": 8}))?;
    }
    exec(&mut s, "layer.newAdjustmentLayer.levels", json!({"inBlack": 8, "inWhite": 245, "gamma": 1.05}))?;
    exec(&mut s, "layer.select", json!({"layer": target}))?;
    Ok((s, target))
}

/// A document with `n` layers: small painted rects, every fifth a type layer, every seventh
/// styled.
fn many_layers_doc(w: u32, h: u32, n: usize) -> Res<(Session, u64)> {
    let mut s = Session::new();
    exec(&mut s, "file.new", json!({"width": w, "height": h, "background": "white"}))?;
    let mut mid = 0;
    for i in 0..n as u32 {
        let (x, y) = ((i * 397) % (w - w / 8), (i * 211) % (h - h / 8));
        if i % 5 == 4 {
            exec(&mut s, "type.create", json!({"x": x, "y": y + 40, "text": format!("Label {i}"), "size": 28}))?;
        } else {
            exec(&mut s, "layer.new.layer", json!({"name": format!("item {i}")}))?;
            exec(&mut s, "select.rect", json!({"x": x, "y": y, "width": w / 10, "height": h / 10}))?;
            exec(&mut s, "edit.fill", json!({"color": format!("#{:02x}{:02x}80", (i * 37) % 256, (i * 91) % 256)}))?;
            exec(&mut s, "select.deselect", json!({}))?;
        }
        if i % 7 == 3 {
            exec(&mut s, "layer.layerStyle.dropShadow", json!({"distance": 6, "size": 8}))?;
        }
        if i as usize == n / 2 {
            mid = active_layer(&s)?;
        }
    }
    exec(&mut s, "layer.select", json!({"layer": mid}))?;
    Ok((s, mid))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let quick = args.iter().any(|a| a == "--quick");
    let sz = if quick { &QUICK } else { &FULL };
    let reps: usize = arg(&args, "--reps").and_then(|v| v.parse().ok()).unwrap_or(if quick { 7 } else { 15 }).max(1);
    let gpu = if args.iter().any(|a| a == "--cpu") { None } else { canvas() };
    let adapter = gpu.as_ref().map(|(_, rs)| rs.adapter.get_info().name);
    let mut b = Bench {
        gpu,
        sampler: RssSampler::start(std::time::Duration::from_millis(2)),
        reps,
        only: arg(&args, "--only"),
        rows: Vec::new(),
        errors: Vec::new(),
        current: None,
    };
    println!("perf_scenarios: {} mode, {} reps, {}", if quick { "quick" } else { "full" }, reps, adapter.as_deref().unwrap_or("CPU canvas"));
    let t_all = Instant::now();

    // A panic in one group (a crash the scenario found) is reported against the row that was
    // running, and the other groups still run.
    type Group = fn(&mut Bench, &Sizes);
    let groups: [(&str, Group); 5] = [
        ("layered", layered_scenarios),
        ("many layers", many_layer_scenarios),
        ("bit depths", depth_scenarios),
        ("long operations", job_scenarios),
        ("algorithms", algorithm_scenarios),
    ];
    let use_gpu = b.gpu.is_some();
    for (i, (group, run)) in groups.into_iter().enumerate() {
        b.current = None;
        // Each group starts on a fresh canvas device (one document open, as in the app), so
        // GPU memory or an error left by one group never carries into the next.
        if use_gpu && i > 0 {
            b.gpu = None;
            b.gpu = canvas();
        }
        if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut b, sz))) {
            let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into());
            let msg = format!("panicked: {}", msg.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" / "));
            let row = b.current.take().unwrap_or_else(|| group.to_string());
            println!("{row:<52} ERROR {msg}");
            b.errors.push((row, msg));
        }
    }

    println!("total {:.1} s", t_all.elapsed().as_secs_f64());
    if let Some(out) = arg(&args, "--json") {
        let context = json!({
            "mode": if quick { "quick" } else { "full" },
            "reps": reps,
            "gpu_adapter": adapter,
            "errors": b.errors.iter().map(|(n, e)| json!({"name": n, "error": e})).collect::<Vec<_>>(),
        });
        let rep = report("perf_scenarios", context, std::mem::take(&mut b.rows), Some(&b.sampler));
        if let Err(e) = write_report(&out, &rep) {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

/// #209 rows on the layered 20 MP document.
fn layered_scenarios(b: &mut Bench, sz: &Sizes) {
    let (w, h) = sz.layered;
    let (mut s, target) = match layered_doc(w, h) {
        Ok(v) => v,
        Err(e) => {
            b.errors.push(("layered document".into(), e));
            return;
        }
    };
    let _ = b.refresh(&s, true);
    let reps = b.reps;
    b.time("move styled layer 10 px + refresh", &mut s, reps, true, |b, s, i| {
        let d = if i % 2 == 0 { 10 } else { -10 };
        let t = Instant::now();
        exec(s, "layer.translate", json!({"layer": target, "dx": d, "dy": d / 2}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    b.time("set layer opacity + refresh", &mut s, reps, true, |b, s, i| {
        let t = Instant::now();
        exec(s, "layer.setProps", json!({"layer": target, "opacity": if i % 2 == 0 { 0.6 } else { 0.9 }}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    b.time("set layer fill + refresh", &mut s, reps, true, |b, s, i| {
        let t = Instant::now();
        exec(s, "layer.setProps", json!({"layer": target, "fill": if i % 2 == 0 { 0.5 } else { 1.0 }}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    b.time("set blend mode + refresh", &mut s, reps, true, |b, s, i| {
        let t = Instant::now();
        exec(s, "layer.setProps", json!({"layer": target, "blend": if i % 2 == 0 { "Multiply" } else { "Normal" }}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    b.time("toggle visibility + refresh", &mut s, reps, true, |b, s, i| {
        let t = Instant::now();
        exec(s, "layer.setProps", json!({"layer": target, "visible": i % 2 == 0}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    let _ = exec(&mut s, "layer.setProps", json!({"layer": target, "visible": true}));
    b.time("undo move + refresh", &mut s, reps, true, |b, s, _| {
        exec(s, "layer.translate", json!({"layer": target, "dx": 7, "dy": 3}))?;
        b.refresh(s, false)?;
        let t = Instant::now();
        exec(s, "edit.undo", json!({}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    b.time("redo opacity change + refresh", &mut s, reps, true, |b, s, i| {
        exec(s, "layer.setProps", json!({"layer": target, "opacity": 0.5 + 0.02 * i as f64}))?;
        exec(s, "edit.undo", json!({}))?;
        b.refresh(s, false)?;
        let t = Instant::now();
        exec(s, "edit.redo", json!({}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });

    // A 12 MP layer, duplicated and pasted: the first time (a fresh layer, cold caches) and
    // again (the same source).
    let (lw, lh) = sz.big_layer;
    let fresh_layer = |s: &mut Session| -> Res<u64> {
        exec(s, "layer.new.layer", json!({"name": "12 MP"}))?;
        exec(s, "select.rect", json!({"x": (w - lw) / 2, "y": (h - lh) / 2, "width": lw, "height": lh}))?;
        exec(s, "edit.fill", json!({"color": "#3070a0"}))?;
        exec(s, "select.deselect", json!({}))?;
        active_layer(s)
    };
    let reps_big = reps.min(5);
    let mut src = 0;
    b.time("duplicate 12 MP layer (first) + refresh", &mut s, reps_big, false, |b, s, _| {
        src = fresh_layer(s)?;
        b.refresh(s, false)?;
        let t = Instant::now();
        exec(s, "layer.duplicate", json!({"layer": src}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    b.time("duplicate 12 MP layer (repeat) + refresh", &mut s, reps_big, false, |b, s, _| {
        let t = Instant::now();
        exec(s, "layer.duplicate", json!({"layer": src}))?;
        let v = ms(t) + b.refresh(s, false)?;
        exec(s, "edit.undo", json!({}))?;
        b.refresh(s, false)?;
        Ok(v)
    });
    b.time("paste 12 MP layer (first) + refresh", &mut s, reps_big, false, |b, s, _| {
        let id = fresh_layer(s)?;
        exec(s, "layer.select", json!({"layer": id}))?;
        exec(s, "select.all", json!({}))?;
        exec(s, "edit.copy", json!({}))?;
        exec(s, "select.deselect", json!({}))?;
        b.refresh(s, false)?;
        let t = Instant::now();
        exec(s, "edit.paste", json!({}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
    b.time("paste 12 MP layer (repeat) + refresh", &mut s, reps_big, false, |b, s, _| {
        let t = Instant::now();
        exec(s, "edit.paste", json!({}))?;
        let v = ms(t) + b.refresh(s, false)?;
        exec(s, "edit.undo", json!({}))?;
        b.refresh(s, false)?;
        Ok(v)
    });
}

/// #209: arrow-key nudge in the 150-layer document.
fn many_layer_scenarios(b: &mut Bench, sz: &Sizes) {
    // Row names stay stable across modes: the layer count is in the mode, not the key.
    let name = "nudge 1 px in the many-layer document + refresh".to_string();
    if !b.wanted(&name) {
        return;
    }
    // The document's first refresh is part of this row (a crash there is reported against it).
    b.current = Some(name.clone());
    let (w, h) = sz.layered;
    let (mut s, mid) = match many_layers_doc(w, h, sz.many_layers) {
        Ok(v) => v,
        Err(e) => {
            b.errors.push((name, e));
            return;
        }
    };
    let _ = b.refresh(&s, true);
    let reps = b.reps;
    b.time(&name, &mut s, reps, true, |b, s, i| {
        let t = Instant::now();
        exec(s, "layer.translate", json!({"layer": mid, "dx": if i % 2 == 0 { 1 } else { -1 }, "dy": 0}))?;
        Ok(ms(t) + b.refresh(s, false)?)
    });
}

/// #209: edits on the 15000 × 10000 16-bit document and the 32-bit document with 20 layers.
fn depth_scenarios(b: &mut Bench, sz: &Sizes) {
    let reps = b.reps;
    for (label, (w, h), depth, layers) in [("16-bit 15000x10000", sz.huge16, 16, 1u32), ("32-bit 20 layers", sz.float32, 32, 20)] {
        let dab = format!("brush dab 60 px on {label} + refresh");
        let mv = format!("move layer on {label} + refresh");
        if !b.wanted(&dab) && !b.wanted(&mv) {
            continue;
        }
        let built = (|| -> Res<(Session, u64)> {
            let mut s = Session::new();
            exec(&mut s, "file.new", json!({"width": w, "height": h, "depth": depth, "background": "white"}))?;
            let mut first = 0;
            for i in 0..layers {
                exec(&mut s, "layer.new.layer", json!({"name": format!("layer {i}")}))?;
                let (x, y) = ((i * 173) % (w * 3 / 4), (i * 97) % (h * 3 / 4));
                exec(&mut s, "select.rect", json!({"x": x, "y": y, "width": w / 4, "height": h / 4}))?;
                exec(&mut s, "edit.fill", json!({"color": format!("#{:02x}8060", (i * 41) % 256)}))?;
                exec(&mut s, "select.deselect", json!({}))?;
                if i == 0 {
                    first = active_layer(&s)?;
                }
            }
            Ok((s, first))
        })();
        let (mut s, layer) = match built {
            Ok(v) => v,
            Err(e) => {
                b.errors.push((dab, e));
                continue;
            }
        };
        let _ = b.refresh(&s, true);
        let _ = exec(&mut s, "layer.select", json!({"layer": layer}));
        b.time(&dab, &mut s, reps, true, |b, s, i| {
            let (x, y) = (200 + (i as u32 * 97) % (w - 400), 200 + (i as u32 * 61) % (h - 400));
            let t = Instant::now();
            exec(s, "paint.stroke", json!({"points": [[x, y]], "size": 60, "hardness": 0.8, "color": "#c03020"}))?;
            Ok(ms(t) + b.refresh(s, false)?)
        });
        b.time(&mv, &mut s, reps, true, |b, s, i| {
            let t = Instant::now();
            exec(s, "layer.translate", json!({"layer": layer, "dx": if i % 2 == 0 { 10 } else { -10 }, "dy": 0}))?;
            Ok(ms(t) + b.refresh(s, false)?)
        });
    }
}

/// #210 rows that are measurable before the job system exists.
fn job_scenarios(b: &mut Bench, sz: &Sizes) {
    let reps = b.reps.min(5);
    let open = "open 20 MP layered PSD (decode + first composite)";
    if b.wanted(open) {
        let (w, h) = sz.layered;
        match layered_doc(w, h).and_then(|(s, _)| {
            let d = s.active().ok_or("no document")?.doc.clone();
            photosuite_io::export(&d, "layered.psd", &Default::default()).map(|o| o.bytes).map_err(|e| e.to_string())
        }) {
            Ok(psd) => {
                let mut holder = Session::new();
                b.time(open, &mut holder, reps, true, |b, s, _| {
                    let t = Instant::now();
                    let d = photosuite_io::import("layered.psd", &psd).map_err(|e| e.to_string())?.document;
                    *s = Session::new();
                    s.open_document(d, Some("layered.psd".into()));
                    Ok(ms(t) + b.refresh(s, true)?)
                });
            }
            Err(e) => b.errors.push((open.into(), e)),
        }
    }
    let caf = "Content-Aware Fill 10 MP (200 px hole)";
    let heal = "Spot Healing stroke 10 MP";
    if b.wanted(caf) || b.wanted(heal) {
        let (w, h) = sz.ten_mp;
        match open_photo(w, h) {
            Ok(mut s) => {
                b.time(caf, &mut s, reps, false, |_, s, i| {
                    exec(s, "select.rect", json!({"x": w / 3 + i as u32 * 40, "y": h / 3, "width": 200, "height": 200, "ellipse": true}))?;
                    let t = Instant::now();
                    exec(s, "edit.contentAwareFill", json!({"seed": i}))?;
                    let v = ms(t);
                    exec(s, "edit.undo", json!({}))?;
                    exec(s, "select.deselect", json!({}))?;
                    Ok(v)
                });
                b.time(heal, &mut s, reps, false, |b, s, i| {
                    let (x, y) = (w / 4 + i as u32 * 60, h / 4);
                    let pts: Vec<Value> = (0..10).map(|k| json!([x + k * 12, y + k * 4])).collect();
                    let t = Instant::now();
                    exec(s, "paint.spotHealing", json!({"points": pts, "size": 60}))?;
                    Ok(ms(t) + b.refresh(s, false)?)
                });
            }
            Err(e) => b.errors.push((caf.into(), e)),
        }
    }
}

/// #211 rows: selection algorithms, Content-Aware Scale and Select Subject on 24 MP, and a brush
/// dab on an A4 300 ppi CMYK document.
fn algorithm_scenarios(b: &mut Bench, sz: &Sizes) {
    let reps = b.reps.min(5);
    let names = [
        "Select > Modify > Smooth r 50 on 24 MP",
        "Select > Modify > Feather r 50 on 24 MP",
        "Select Subject 24 MP (repeat)",
        "Content-Aware Scale 24 MP to 90 % width",
    ];
    if names.iter().any(|n| b.wanted(n)) {
        let (w, h) = sz.big_photo;
        match open_photo(w, h) {
            Ok(mut s) => {
                for (name, op) in [(names[0], "select.modify.smooth"), (names[1], "select.modify.feather")] {
                    b.time(name, &mut s, reps, false, |_, s, _| {
                        exec(s, "select.rect", json!({"x": w / 6, "y": h / 6, "width": w * 2 / 3, "height": h * 2 / 3, "ellipse": true}))?;
                        let t = Instant::now();
                        exec(s, op, json!({"radius": 50}))?;
                        let v = ms(t);
                        exec(s, "select.deselect", json!({}))?;
                        Ok(v)
                    });
                }
                b.time(names[2], &mut s, reps, true, |_, s, _| {
                    let t = Instant::now();
                    exec(s, "select.subject", json!({}))?;
                    let v = ms(t);
                    exec(s, "select.deselect", json!({}))?;
                    Ok(v)
                });
                // One run: today this takes far longer than its budget.
                b.time(names[3], &mut s, 1, false, |_, s, _| {
                    let t = Instant::now();
                    exec(s, "edit.contentAwareScale", json!({"scaleX": 90, "scaleY": 100}))?;
                    let v = ms(t);
                    exec(s, "edit.undo", json!({}))?;
                    Ok(v)
                });
            }
            Err(e) => b.errors.push((names[0].into(), e)),
        }
    }
    let cmyk = "brush dab on A4 300 ppi CMYK + refresh";
    if b.wanted(cmyk) {
        let (w, h) = sz.a4;
        let mut s = Session::new();
        let setup = exec(&mut s, "file.new", json!({"width": w, "height": h, "mode": "cmyk", "resolution": 300, "background": "white"}))
            .and_then(|_| exec(&mut s, "layer.new.layer", json!({"name": "paint"})));
        if let Err(e) = setup {
            b.errors.push((cmyk.into(), e));
            return;
        }
        let _ = b.refresh(&s, true);
        let reps = b.reps;
        b.time(cmyk, &mut s, reps, true, |b, s, i| {
            let (x, y) = (200 + (i as u32 * 97) % (w - 400), 200 + (i as u32 * 61) % (h - 400));
            let t = Instant::now();
            exec(s, "paint.stroke", json!({"points": [[x, y]], "size": 40, "hardness": 0.8, "color": "#c03020"}))?;
            Ok(ms(t) + b.refresh(s, false)?)
        });
    }
}
