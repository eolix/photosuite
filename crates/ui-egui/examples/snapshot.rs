//! Render the full PhotoSuite UI offscreen (no window, no focus stealing) and save a PNG.
//!
//! ```sh
//! cargo run --release -p photosuite-ui-egui --example snapshot -- \
//!     --out ui.png --size 1440x900 --scale 2 --open photo.jpg \
//!     --script '[["ui.set", {"tool": "type"}], ["ui.menu.invoke", {"id": "image.imageSize"}]]'
//! ```
//!
//! `--safe-gpu` draws the canvas on the CPU path, like the app's `--safe-gpu` launch.
//!
//! `--script` is a JSON array of `[method, params]` control-protocol calls (see
//! docs/control-protocol.md), applied in order with a few frames between them.

use photosuite_ui_egui::control::{ControlRequest, Outcome, handle};
use photosuite_ui_egui::{PhotosuiteApp, Services};
use serde_json::Value;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = arg(&args, "--out").unwrap_or_else(|| "snapshot.png".into());
    let (w, h) = arg(&args, "--size")
        .and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse::<f32>().ok()?, b.parse::<f32>().ok()?))))
        .unwrap_or((1440.0, 900.0));
    let scale: f32 = arg(&args, "--scale").and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let script: Vec<(String, Value)> =
        arg(&args, "--script").map(|s| serde_json::from_str::<Vec<(String, Value)>>(&s).expect("--script must be [[method, params], …]")).unwrap_or_default();

    let services = Services {
        import: Some(Box::new(|name: &str, bytes: &[u8]| photosuite_io::import(name, bytes).map(|r| (r.document, r.warnings)).map_err(|e| e.to_string()))),
        export: Some(Box::new(|doc: &photosuite_doc::Document, path: &str, settings: &photosuite_ui_egui::ExportSettings| {
            let mut opts = photosuite_io::ExportOptions::default();
            if let Some(q) = settings.jpeg_quality {
                opts.encode.jpeg_quality = q;
            }
            photosuite_io::export(doc, path, &opts).map(|r| (r.bytes, r.warnings)).map_err(|e| e.to_string())
        })),
        write: Some(Box::new(|path: &str, bytes: &[u8]| photosuite_format::atomic_write(std::path::Path::new(path), bytes).map_err(|e| e.to_string()))),
        ..Default::default()
    };
    let open = arg(&args, "--open");
    // Lens profiles from the source tree, as the app reads them from its resources.
    let lensdb = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/lensfun/lens-database.json");
    photosuite_engine::lens_cmds::set_lens_database_loader(Box::new(move || std::fs::read(&lensdb).ok()));
    let safe_gpu = args.iter().any(|a| a == "--safe-gpu");
    let mut harness =
        egui_kittest::Harness::builder().with_size(egui::vec2(w, h)).with_pixels_per_point(scale).with_max_steps(64).wgpu().build_eframe(move |cc| {
            PhotosuiteApp::setup_context(&cc.egui_ctx, Default::default());
            let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), services);
            // `--safe-gpu`: the CPU canvas, as the desktop app's `--safe-gpu` launch.
            if safe_gpu {
                app.perf.gpu_info.selected = "cpu".into();
                app.perf.gpu_info.canvas = "cpu".into();
                app.perf.gpu_info.fallback = Some("--safe-gpu: CPU renderer for this launch".into());
                if let Some(rs) = cc.wgpu_render_state.as_ref() {
                    app.perf.gpu_info.set_adapter(&rs.adapter.get_info());
                }
            } else if let Some(rs) = cc.wgpu_render_state.as_ref() {
                app.set_wgpu(rs.clone());
            }
            if let Some(path) = &open {
                app.open_path(path).expect("open --open file");
            }
            app
        });
    harness.run_steps(4);
    let ctx = harness.ctx.clone();
    let timing = std::env::var_os("SNAPSHOT_TIMING").is_some();
    for (method, params) in script {
        let t0 = std::time::Instant::now();
        let label = format!("{method} {}", params.get("command").and_then(Value::as_str).unwrap_or(""));
        let (req, _rx) = ControlRequest::new(&method, params);
        let outcome = handle(harness.state_mut(), &ctx, &req);
        if let Outcome::Done(v) = &outcome
            && v.get("ok") == Some(&Value::Bool(false))
        {
            eprintln!("{method}: {v}");
        }
        // The harness doesn't call raw_input_hook: feed queued synthetic input step by step.
        loop {
            let step = harness.state_mut().take_synthetic_step();
            if step.is_empty() {
                break;
            }
            for e in step {
                harness.event(e);
            }
            harness.step();
        }
        harness.run_steps(4);
        if timing {
            eprintln!("{:>8.1} ms  {label}", t0.elapsed().as_secs_f64() * 1000.0);
        }
    }
    // Let fade animations settle.
    for _ in 0..12 {
        harness.step();
    }
    let (req, _rx) = ControlRequest::new("ui.inspect", Value::Null);
    if let Outcome::Done(v) = handle(harness.state_mut(), &ctx, &req) {
        println!("perf: {}", v["result"]["perf"]["timings"]);
    }
    let img = harness.render().expect("render");
    img.save(&out).expect("save png");
    println!("wrote {out} ({}×{})", img.width(), img.height());
}
