//! Properties-panel editors for the Selective Color and Color Lookup adjustment layers.
//!
//! Both commit through `layer.setAdjustment` (which merges these kinds' params into the current
//! values). Selective Color previews live while a slider drags, via `app.live_adjust` carrying
//! the full parameter set; Color Lookup commits on every change (its table isn't in the params).

use photosuite_doc::{Adjustment, LayerId};
use photosuite_engine::adjust_cmds::RANGES;
use serde_json::{Value, json};

use crate::PhotosuiteApp;
use crate::theme::Tokens;
use crate::widgets;

const RANGE_LABELS: [&str; 9] = ["Reds", "Yellows", "Greens", "Cyans", "Blues", "Magentas", "Whites", "Neutrals", "Blacks"];

/// The full parameter set of a Selective Color adjustment (every range as `[c, m, y, k]`).
pub fn selective_values(adj: &Adjustment) -> Value {
    let Adjustment::SelectiveColor { relative, adjustments } = adj else {
        return json!({});
    };
    let mut v = json!({"method": if *relative { "relative" } else { "absolute" }});
    for (i, key) in RANGES.iter().enumerate() {
        v[*key] = json!(adjustments[i]);
    }
    v
}

pub fn selective_color_editor(app: &mut PhotosuiteApp, ui: &mut egui::Ui, id: LayerId, adj: &Adjustment) {
    let t = Tokens::get(ui.ctx());
    let committed = selective_values(adj);
    let mut values = match &app.live_adjust {
        Some((l, v)) if *l == id && v.get("reds").is_some() => v.clone(),
        _ => committed,
    };
    let key = egui::Id::new(("selc-range", id.0));
    let mut range: usize = ui.data(|d| d.get_temp(key)).unwrap_or(0);
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(tl!("Colors")).color(t.text_dim));
        let opts: Vec<(usize, &str)> = RANGE_LABELS.iter().copied().enumerate().collect();
        if widgets::dropdown(ui, &format!("selc-colors-{}", id.0), &mut range, &opts, 150.0) {
            ui.data_mut(|d| d.insert_temp(key, range));
        }
    });
    ui.add_space(4.0);
    let mut live = false;
    let mut commit = false;
    for (k, label) in [tl!("Cyan"), tl!("Magenta"), tl!("Yellow"), tl!("Black")].iter().enumerate() {
        let mut v = values[RANGES[range]][k].as_f64().unwrap_or(0.0) as f32;
        let r = widgets::slider_row(ui, label, &mut v, -100.0..=100.0, "%", None);
        if r.changed() {
            values[RANGES[range]][k] = json!(v.round());
            live = true;
        }
        if r.drag_stopped() || (r.changed() && !r.dragged()) {
            commit = true;
        }
    }
    ui.add_space(4.0);
    let mut method = values["method"].as_str().unwrap_or("relative").to_string();
    ui.horizontal(|ui| {
        for (m, label) in [("relative", tl!("Relative")), ("absolute", tl!("Absolute"))] {
            if ui.radio(method == m, label).clicked() && method != m {
                method = m.to_string();
                values["method"] = json!(m);
                commit = true;
            }
        }
    });
    if live {
        app.live_adjust = Some((id, values.clone()));
    }
    if commit {
        let mut p = values;
        p["layer"] = json!(id.0);
        let _ = app.run("layer.setAdjustment", p);
        app.live_adjust = None;
    }
}

/// Formats Color Lookup reads: 3D LUTs, and ICC abstract / device-link profiles (both cases, for
/// platforms whose pickers match exactly).
const LUT_EXTS: &[&str] = &["cube", "3dl", "look", "icc", "icm", "CUBE", "3DL", "LOOK", "ICC", "ICM"];
const LUT_LIST_KEY: &str = "color-lookup-luts";

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn is_lut(path: &std::path::Path) -> bool {
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    ["cube", "3dl", "look", "icc", "icm"].contains(&ext.as_str())
}

/// Every LUT the dropdown offers: the bundled ones (`resources/luts`) and the ones the user
/// loaded (`…/app.photosuite/libraries`), as (path, name shown), by name. Cached until a load
/// adds one; the folders don't change behind the application's back otherwise.
fn lut_list(app: &PhotosuiteApp, ctx: &egui::Context) -> std::sync::Arc<Vec<(String, String)>> {
    let key = egui::Id::new(LUT_LIST_KEY);
    if let Some(list) = ctx.data(|d| d.get_temp::<std::sync::Arc<Vec<(String, String)>>>(key)) {
        return list;
    }
    let mut list: Vec<(String, String)> = Vec::new();
    #[cfg(not(target_arch = "wasm32"))]
    {
        let dirs = [app.services.resources_dir.as_ref().map(|d| d.join("luts")), app.services.user_resources_dir.clone()];
        for dir in dirs.into_iter().flatten() {
            for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = e.path();
                if is_lut(&path) {
                    let label = path.file_stem().map(|s| s.to_string_lossy().replace('_', " ")).unwrap_or_default();
                    list.push((path.to_string_lossy().into_owned(), label));
                }
            }
        }
    }
    #[cfg(target_arch = "wasm32")]
    let _ = app;
    list.sort_by_key(|a| a.1.to_lowercase());
    let list = std::sync::Arc::new(list);
    ctx.data_mut(|d| d.insert_temp(key, list.clone()));
    list
}

/// Copy a LUT the user picked into their resources folder, so it is offered again next time;
/// returns the path to load. A name already taken by a different file gets a numbered suffix
/// rather than overwriting it. Falls back to the picked path if the copy is not possible.
#[cfg(not(target_arch = "wasm32"))]
fn keep_lut(app: &PhotosuiteApp, picked: &str) -> String {
    let Some(dir) = app.services.user_resources_dir.clone() else { return picked.to_string() };
    let src = std::path::Path::new(picked);
    if src.parent().is_some_and(|p| p == dir) || std::fs::create_dir_all(&dir).is_err() {
        return picked.to_string();
    }
    let Ok(bytes) = std::fs::read(src) else { return picked.to_string() };
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "lut".into());
    let ext = src.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "cube".into());
    for n in 1.. {
        let name = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem} {n}.{ext}") };
        let dest = dir.join(name);
        match std::fs::read(&dest) {
            Ok(existing) if existing == bytes => return dest.to_string_lossy().into_owned(),
            Ok(_) => continue,
            Err(_) => {
                return if std::fs::write(&dest, &bytes).is_ok() { dest.to_string_lossy().into_owned() } else { picked.to_string() };
            }
        }
    }
    picked.to_string()
}

/// The LUT dropdown shared by the Color Lookup adjustment layer and Image › Adjustments › Color
/// Lookup. `current` is the loaded LUT's file name, empty for none. Returns the parameters to
/// apply when the choice changes: `{"lut": "none"}` or `{"file": path}`.
fn lut_dropdown(app: &mut PhotosuiteApp, ui: &mut egui::Ui, salt: &str, current: &str) -> Option<Value> {
    let t = Tokens::get(ui.ctx());
    let list = lut_list(app, ui.ctx());
    let selected = if current.is_empty() {
        "none".to_string()
    } else {
        list.iter().find(|(path, _)| file_name(path) == current).map_or_else(|| "custom".to_string(), |(path, _)| format!("file:{path}"))
    };
    let mut opts: Vec<(String, &str)> = vec![("none".into(), tl!("None")), ("load".into(), tl!("Load 3D LUT…"))];
    opts.extend(list.iter().map(|(path, label)| (format!("file:{path}"), label.as_str())));
    if selected == "custom" {
        opts.push(("custom".into(), current));
    }
    let mut sel = selected.clone();
    let mut out: Option<Value> = None;
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(tl!("3D LUT File")).color(t.text_dim));
        if crate::widgets::dropdown(ui, salt, &mut sel, &opts, 170.0) && sel != selected && sel != "custom" {
            out = match sel.as_str() {
                "none" => Some(json!({"lut": "none"})),
                "load" => {
                    let picked = app.services.pick_file.as_mut().and_then(|pick| pick(tl!("3D LUT File"), LUT_EXTS));
                    #[cfg(not(target_arch = "wasm32"))]
                    let picked = picked.map(|p| keep_lut(app, &p));
                    if picked.is_some() {
                        ui.ctx().data_mut(|d| d.remove::<std::sync::Arc<Vec<(String, String)>>>(egui::Id::new(LUT_LIST_KEY)));
                    }
                    picked.map(|path| json!({"file": path}))
                }
                f => f.strip_prefix("file:").map(|path| json!({"file": path})),
            };
        }
    });
    // Without a platform file picker (the web build) a path field stands in for it.
    if app.services.pick_file.is_none() {
        let path_key = egui::Id::new(("lut-path", salt.to_string()));
        let mut path: String = ui.data(|d| d.get_temp(path_key)).unwrap_or_default();
        ui.horizontal(|ui| {
            if ui.add(egui::TextEdit::singleline(&mut path).hint_text(".cube / .3dl / .look").desired_width(170.0)).changed() {
                ui.data_mut(|d| d.insert_temp(path_key, path.clone()));
            }
            if crate::widgets::secondary_button(ui, tl!("Load"), 60.0).clicked() && !path.trim().is_empty() {
                out = Some(json!({"file": path.trim()}));
            }
        });
    }
    out
}

/// Image › Adjustments › Color Lookup gets this body instead of the generic one, so it can offer
/// the same dropdown and file dialog as the adjustment layer.
pub fn owns_lookup(f: &serde_json::Map<String, Value>) -> bool {
    f.get("__command").and_then(Value::as_str) == Some("image.adjustments.colorLookup")
}

pub fn lookup_dialog_body(app: &mut PhotosuiteApp, ui: &mut egui::Ui, f: &mut serde_json::Map<String, Value>) {
    // Upstream's generated looks are not offered: with no file chosen, nothing is applied.
    if !f.contains_key("file") {
        f.insert("lut".into(), json!("none"));
    }
    let current = f.get("file").and_then(Value::as_str).map(|p| file_name(p).to_string()).unwrap_or_default();
    if let Some(p) = lut_dropdown(app, ui, "lut-dialog", &current) {
        match p.get("file").and_then(Value::as_str) {
            Some(path) => {
                f.insert("file".into(), json!(path));
                f.remove("lut");
            }
            None => {
                f.remove("file");
                f.insert("lut".into(), json!("none"));
            }
        }
    }
    // Interpolation and Dither come from the generic body; the LUT keys are drawn above.
    f.insert("__skip".into(), json!(["lut", "file", "data", "fileName"]));
    crate::filter_dialog::body(ui, f);
}

pub fn color_lookup_editor(app: &mut PhotosuiteApp, ui: &mut egui::Ui, id: LayerId, adj: &Adjustment) {
    let t = Tokens::get(ui.ctx());
    let Adjustment::ColorLookup { name, lut, size, tetrahedral, dither } = adj else {
        return;
    };
    let _ = (&t, size);
    let current = if lut.is_none() { String::new() } else { name.clone() };
    let mut params: Option<Value> = lut_dropdown(app, ui, &format!("clrl-{}", id.0), &current);
    ui.add_space(4.0);
    let mut tet = *tetrahedral;
    ui.horizontal(|ui| {
        for (on, label) in [(false, tl!("Trilinear")), (true, tl!("Tetrahedral"))] {
            if ui.radio(tet == on, label).clicked() && tet != on {
                tet = on;
                params = Some(json!({"tetrahedral": on}));
            }
        }
    });
    let mut d = *dither;
    if widgets::toggle(ui, &mut d, tl!("Dither")).changed() {
        params = Some(json!({"dither": d}));
    }
    if let Some(mut p) = params {
        p["layer"] = json!(id.0);
        // Errors (an unreadable LUT file) land in the status bar.
        let _ = app.run("layer.setAdjustment", p);
    }
}
