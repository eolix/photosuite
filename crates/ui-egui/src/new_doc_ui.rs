//! File › New: Photoshop's New Document dialog. Category tabs with blank-document presets on the
//! left, Preset Details on the right. Values live in the dialog fields (`width`/`height` in pixels,
//! `resolution` in ppi, `mode`, `depth`, `background`, `name`), so `ui.dialog.set` drives it and
//! Create runs `file.new` with them.

use egui::{Align2, Rect, RichText, Sense, Stroke, StrokeKind, pos2, vec2};
use serde_json::{Map, Value, json};

use crate::theme::Tokens;
use crate::{icons, widgets};

/// A blank-document preset: (name, width px, height px, ppi).
pub type Preset = (&'static str, u32, u32, f32);

/// Photoshop's New Document categories and their blank-document presets. Recent has none of
/// its own: it lists the documents created in this dialog ([`recent`]), and is empty until then.
pub const CATEGORIES: &[(&str, &[Preset])] = &[
    ("Recent", &[]),
    (
        "Photo",
        &[
            ("Landscape, 6 x 4", 1800, 1200, 300.0),
            ("Landscape, 7 x 5", 2100, 1500, 300.0),
            ("Landscape, 10 x 8", 3000, 2400, 300.0),
            ("Portrait, 4 x 6", 1200, 1800, 300.0),
            ("Portrait, 5 x 7", 1500, 2100, 300.0),
            ("Square, 5 x 5", 1500, 1500, 300.0),
        ],
    ),
    (
        "Print",
        &[
            ("Letter", 2550, 3300, 300.0),
            ("Legal", 2550, 4200, 300.0),
            ("Tabloid", 3300, 5100, 300.0),
            ("A4", 2480, 3508, 300.0),
            ("A3", 3508, 4961, 300.0),
            ("A5", 1748, 2480, 300.0),
        ],
    ),
    (
        "Art & Illustration",
        &[("Poster", 5400, 7200, 300.0), ("Postcard", 1800, 1200, 300.0), ("Comic Book", 1988, 3075, 300.0), ("Square, 12 x 12", 3600, 3600, 300.0)],
    ),
    (
        "Web",
        &[
            ("Web Most Common", 1366, 768, 72.0),
            ("Web Minimum", 1024, 768, 72.0),
            ("Web Large", 1920, 1080, 72.0),
            ("MacBook Pro 16\"", 3456, 2234, 72.0),
            ("iMac 24\"", 4480, 2520, 72.0),
        ],
    ),
    (
        "Mobile",
        &[
            ("iPhone 16", 1179, 2556, 72.0),
            ("iPhone 16 Pro Max", 1320, 2868, 72.0),
            ("iPad Pro 13\"", 2064, 2752, 72.0),
            ("Android 1080p", 1080, 1920, 72.0),
            ("Apple Watch 45mm", 396, 484, 72.0),
        ],
    ),
    (
        "Film & Video",
        &[
            ("HDTV 1080p", 1920, 1080, 72.0),
            ("HDTV 720p", 1280, 720, 72.0),
            ("UHD 4K", 3840, 2160, 72.0),
            ("DCI 4K", 4096, 2160, 72.0),
            ("UHD 8K", 7680, 4320, 72.0),
        ],
    ),
];

/// Width/Height units: (key, label, units per inch; 0 = pixels).
pub const UNITS: &[(&str, &str, f32)] =
    &[("px", "Pixels", 0.0), ("in", "Inches", 1.0), ("cm", "Centimeters", 2.54), ("mm", "Millimeters", 25.4), ("pt", "Points", 72.0), ("pica", "Picas", 6.0)];

/// Pixels to the display unit at `ppi`.
pub fn to_unit(px: f32, unit: &str, ppi: f32) -> f32 {
    match UNITS.iter().find(|u| u.0 == unit) {
        Some((_, _, per_in)) if *per_in > 0.0 => px / ppi.max(1.0) * per_in,
        _ => px,
    }
}

/// Display unit back to pixels at `ppi`.
pub fn from_unit(v: f32, unit: &str, ppi: f32) -> f32 {
    match UNITS.iter().find(|u| u.0 == unit) {
        Some((_, _, per_in)) if *per_in > 0.0 => (v / per_in * ppi.max(1.0)).round(),
        _ => v.round(),
    }
}

/// A typed size as the whole pixel count `file.new` takes (#254: a float like `512.0` isn't one, so
/// the command fell back to its 1920 x 1080 default). Clamped to the command's 1–300000 range.
pub fn px_value(px: f32) -> Value {
    json!(if px.is_finite() { px.round().clamp(1.0, 300_000.0) as u32 } else { 1 })
}

/// Apply a preset to the dialog fields.
pub fn apply_preset(f: &mut Map<String, Value>, p: &Preset) {
    f.insert("width".into(), json!(p.1));
    f.insert("height".into(), json!(p.2));
    f.insert("resolution".into(), json!(p.3));
    f.insert("__preset".into(), json!(p.0));
    // Print and photo presets are specified in inches, screen presets in pixels.
    f.insert("__unit".into(), json!(if p.3 >= 300.0 { "in" } else { "px" }));
}

/// How many documents the Recent tab keeps.
pub const RECENT_MAX: usize = 20;

/// The document settings Recent remembers (`file.new`'s params, plus the preset's name and the
/// size unit shown).
const RECENT_KEYS: [&str; 6] = ["width", "height", "resolution", "mode", "depth", "background"];

/// A Recent card: a document made in this dialog, read back from the preferences.
#[derive(Clone, Debug, PartialEq)]
pub struct RecentDoc {
    /// The preset it was made from, or "Custom".
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub ppi: f32,
    /// Its settings as dialog fields (sizes, mode, depth, background, size unit).
    pub fields: Map<String, Value>,
}

/// One stored entry, or `None` when it is unusable (hand-edited or from another version).
fn recent_doc(v: &Value) -> Option<RecentDoc> {
    let o = v.as_object()?;
    let px = |k: &str| o.get(k).and_then(Value::as_u64).filter(|n| (1..=300_000).contains(n)).map(|n| n as u32);
    let (width, height) = (px("width")?, px("height")?);
    // No resolution: `file.new`'s 72 ppi.
    let ppi = match o.get("resolution") {
        None => 72.0,
        Some(r) => r.as_f64().filter(|r| r.is_finite() && (1.0..=30_000.0).contains(r))? as f32,
    };
    let mut fields = Map::new();
    for k in RECENT_KEYS {
        if let Some(v) = o.get(k) {
            fields.insert(k.into(), v.clone());
        }
    }
    fields.insert("resolution".into(), json!(ppi));
    let unit = o.get("unit").and_then(Value::as_str).filter(|u| UNITS.iter().any(|x| x.0 == *u)).unwrap_or("px");
    fields.insert("__unit".into(), json!(unit));
    let label = o.get("preset").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("Custom").to_string();
    Some(RecentDoc { label, width, height, ppi, fields })
}

/// The Recent tab's documents, newest first.
pub fn recent(app: &crate::PhotosuiteApp) -> Vec<RecentDoc> {
    app.session.prefs().recent_new_documents.iter().filter_map(recent_doc).take(RECENT_MAX).collect()
}

/// After Create: put this document's settings at the top of Recent (once: making the same
/// document again moves it up), and keep the newest [`RECENT_MAX`].
pub fn remember(app: &mut crate::PhotosuiteApp, f: &Map<String, Value>) {
    let mut entry = Map::new();
    for k in RECENT_KEYS {
        if let Some(v) = f.get(k) {
            entry.insert(k.into(), v.clone());
        }
    }
    if let Some(p) = f.get("__preset").and_then(Value::as_str).filter(|p| !p.starts_with("__")) {
        entry.insert("preset".into(), json!(p));
    }
    if let Some(u) = f.get("__unit").and_then(Value::as_str) {
        entry.insert("unit".into(), json!(u));
    }
    let entry = Value::Object(entry);
    let Some(doc) = recent_doc(&entry) else { return };
    app.session.prefs.edit(|p| {
        let same = |v: &Value| recent_doc(v).is_some_and(|r| r.fields == doc.fields);
        p.recent_new_documents.retain(|v| !same(v));
        p.recent_new_documents.insert(0, entry);
        p.recent_new_documents.truncate(RECENT_MAX);
    });
}

/// The New Document dialog's starting fields: the last document made here (Photoshop opens on
/// it), else the defaults.
pub fn initial_fields(app: &crate::PhotosuiteApp) -> Map<String, Value> {
    let mut f = crate::state::UiState::new_document_fields();
    if let Some(r) = recent(app).into_iter().next() {
        f.extend(r.fields);
        // Its card shows as the selected one.
        f.insert("__preset".into(), json!("__recent0"));
    }
    f
}

/// Fields `file.new` takes (drops the dialog's `__` UI keys).
pub fn command_params(f: &Map<String, Value>) -> Value {
    Value::Object(f.iter().filter(|(k, _)| !k.starts_with("__")).map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn get_f(f: &Map<String, Value>, k: &str, d: f32) -> f32 {
    f.get(k).and_then(Value::as_f64).map_or(d, |v| v as f32)
}

fn get_s(f: &Map<String, Value>, k: &str, d: &str) -> String {
    f.get(k).and_then(Value::as_str).unwrap_or(d).to_string()
}

fn small_label(ui: &mut egui::Ui, s: &str) {
    let t = Tokens::get(ui.ctx());
    ui.label(RichText::new(s).size(11.5).color(t.text_dim));
}

/// Paint a page thumbnail with the preset's aspect ratio.
fn page_icon(ui: &egui::Ui, r: Rect, w: u32, h: u32, t: &Tokens) {
    let s = 30.0 / (w.max(h) as f32);
    let page = Rect::from_center_size(r.center(), vec2(w as f32 * s, h as f32 * s));
    ui.painter().rect_stroke(page, 1.0, Stroke::new(1.2, t.text_dim), StrokeKind::Inside);
}

/// One card in the preset grid: what it shows, and the fields a click sets.
struct Card {
    /// Unique among the shown cards (the `__preset` it selects).
    key: String,
    label: String,
    width: u32,
    height: u32,
    ppi: f32,
    unit: &'static str,
    fields: Map<String, Value>,
}

fn preset_card(p: &Preset) -> Card {
    let mut fields = Map::new();
    apply_preset(&mut fields, p);
    let unit = if p.3 >= 300.0 { "in" } else { "px" };
    Card { key: p.0.to_string(), label: tl!(p.0).to_string(), width: p.1, height: p.2, ppi: p.3, unit, fields }
}

fn recent_card(i: usize, r: &RecentDoc) -> Card {
    let key = format!("__recent{i}");
    let mut fields = r.fields.clone();
    fields.insert("__preset".into(), json!(key));
    let unit = if r.fields.get("__unit").and_then(Value::as_str) == Some("in") { "in" } else { "px" };
    Card { key, label: tl!(r.label.as_str()).to_string(), width: r.width, height: r.height, ppi: r.ppi, unit, fields }
}

pub fn body(ui: &mut egui::Ui, f: &mut Map<String, Value>, recent: &[RecentDoc]) {
    let t = Tokens::get(ui.ctx());
    // Recent first, as Photoshop; while it is empty, Film & Video.
    let cat = get_s(f, "__category", if recent.is_empty() { "Film & Video" } else { "Recent" });
    // Category tabs.
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 18.0;
        for (name, _) in CATEGORIES {
            let on = cat == *name;
            let r = ui.add(egui::Label::new(RichText::new(tl!(name)).size(13.0).color(if on { t.text } else { t.text_dim })).sense(Sense::click()));
            if on {
                ui.painter().line_segment([r.rect.left_bottom() + vec2(0.0, 3.0), r.rect.right_bottom() + vec2(0.0, 3.0)], Stroke::new(2.0, t.text));
            }
            if r.clicked() {
                f.insert("__category".into(), json!(name));
            }
        }
    });
    ui.add_space(6.0);
    widgets::hairline(ui);
    ui.add_space(8.0);
    let cards: Vec<Card> = if cat == "Recent" {
        recent.iter().enumerate().map(|(i, r)| recent_card(i, r)).collect()
    } else {
        CATEGORIES.iter().find(|c| c.0 == cat).map_or(CATEGORIES[0].1, |c| c.1).iter().map(preset_card).collect()
    };
    let chosen = get_s(f, "__preset", "");
    ui.horizontal_top(|ui| {
        // Left: preset grid.
        ui.vertical(|ui| {
            ui.set_width(520.0);
            // An empty Recent tab is just empty.
            if !cards.is_empty() {
                let heading = if cat == "Recent" {
                    format!("{} ({})", tl!("Recent").to_uppercase(), cards.len())
                } else {
                    crate::i18n::fmt(tl!("BLANK DOCUMENT PRESETS ({n})"), &[("n", &cards.len().to_string())])
                };
                ui.label(RichText::new(heading).size(11.0).color(t.text_faint));
                ui.add_space(6.0);
            }
            let card = vec2(164.0, 112.0);
            for row in cards.chunks(3) {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    for p in row {
                        let (r, resp) = ui.allocate_exact_size(card, Sense::click());
                        let on = chosen == p.key;
                        ui.painter().rect_filled(
                            r,
                            t.radius,
                            if on {
                                t.row_selected
                            } else if resp.hovered() {
                                t.hover
                            } else {
                                t.field
                            },
                        );
                        if on {
                            ui.painter().rect_stroke(r, t.radius, Stroke::new(1.5, t.accent), StrokeKind::Inside);
                        }
                        page_icon(ui, Rect::from_center_size(pos2(r.center().x, r.top() + 34.0), vec2(40.0, 40.0)), p.width, p.height, &t);
                        ui.painter().text(pos2(r.center().x, r.top() + 72.0), Align2::CENTER_CENTER, &p.label, egui::FontId::proportional(12.0), t.text);
                        let ppi = widgets::fmt_num(f64::from(p.ppi));
                        let size = if p.unit == "in" {
                            format!(
                                "{} x {} in @ {ppi} ppi",
                                widgets::fmt_num(to_unit(p.width as f32, "in", p.ppi) as f64),
                                widgets::fmt_num(to_unit(p.height as f32, "in", p.ppi) as f64),
                            )
                        } else {
                            format!("{} x {} px @ {ppi} ppi", p.width, p.height)
                        };
                        ui.painter().text(pos2(r.center().x, r.top() + 90.0), Align2::CENTER_CENTER, size, egui::FontId::proportional(10.5), t.text_faint);
                        if resp.clicked() {
                            f.extend(p.fields.clone());
                        }
                    }
                });
                ui.add_space(8.0);
            }
        });
        ui.add_space(10.0);
        // Right: Preset Details.
        ui.vertical(|ui| {
            ui.set_width(260.0);
            ui.label(RichText::new(tl!("PRESET DETAILS")).size(11.0).color(t.text_faint));
            ui.add_space(4.0);
            let mut name = get_s(f, "name", tl!("Untitled-1"));
            if ui.add(egui::TextEdit::singleline(&mut name).desired_width(250.0).font(egui::FontId::proportional(15.0))).changed() {
                f.insert("name".into(), json!(name));
            }
            ui.add_space(8.0);
            let ppi = get_f(f, "resolution", 72.0);
            let mut unit = get_s(f, "__unit", "px");
            small_label(ui, tl!("Width"));
            ui.horizontal(|ui| {
                let mut w = to_unit(get_f(f, "width", 1920.0), &unit, ppi);
                if widgets::value_field(ui, &mut w, 0.01..=300_000.0, "", 110.0).changed() {
                    f.insert("width".into(), px_value(from_unit(w, &unit, ppi)));
                    f.remove("__preset");
                }
                let opts: Vec<(String, &str)> = UNITS.iter().map(|u| (u.0.to_string(), u.1)).collect();
                if widgets::dropdown(ui, "nd-unit", &mut unit, &opts, 120.0) {
                    f.insert("__unit".into(), json!(unit));
                }
            });
            small_label(ui, tl!("Height"));
            ui.horizontal(|ui| {
                let mut h = to_unit(get_f(f, "height", 1080.0), &unit, ppi);
                if widgets::value_field(ui, &mut h, 0.01..=300_000.0, "", 110.0).changed() {
                    f.insert("height".into(), px_value(from_unit(h, &unit, ppi)));
                    f.remove("__preset");
                }
                ui.add_space(6.0);
                small_label(ui, tl!("Orientation"));
                let (w, h) = (get_f(f, "width", 1920.0), get_f(f, "height", 1080.0));
                for (icon, portrait) in [("rectangle-vertical", true), ("rectangle-horizontal", false)] {
                    if icons::button(ui, icon, 24.0, (h > w) == portrait, if portrait { "Portrait" } else { "Landscape" }).clicked() && (h > w) != portrait {
                        f.insert("width".into(), px_value(h));
                        f.insert("height".into(), px_value(w));
                    }
                }
            });
            ui.add_space(4.0);
            small_label(ui, tl!("Resolution"));
            ui.horizontal(|ui| {
                let per_cm = get_s(f, "__resUnit", "in") == "cm";
                let mut r = if per_cm { ppi / 2.54 } else { ppi };
                if widgets::value_field(ui, &mut r, 1.0..=30_000.0, "", 110.0).changed() {
                    f.insert("resolution".into(), json!(if per_cm { r * 2.54 } else { r }));
                }
                let mut ru = get_s(f, "__resUnit", "in");
                if widgets::dropdown(ui, "nd-resunit", &mut ru, &[("in".to_string(), tl!("Pixels/Inch")), ("cm".to_string(), tl!("Pixels/Centimeter"))], 120.0)
                {
                    f.insert("__resUnit".into(), json!(ru));
                }
            });
            ui.add_space(4.0);
            small_label(ui, tl!("Color Mode"));
            ui.horizontal(|ui| {
                let mut mode = get_s(f, "mode", "rgb");
                if widgets::dropdown(
                    ui,
                    "nd-mode",
                    &mut mode,
                    &[
                        ("gray".to_string(), tl!("Grayscale")),
                        ("rgb".to_string(), tl!("RGB Color")),
                        ("cmyk".to_string(), tl!("CMYK Color")),
                        ("lab".to_string(), tl!("Lab Color")),
                    ],
                    110.0,
                ) {
                    f.insert("mode".into(), json!(mode));
                }
                let mut depth = f.get("depth").and_then(Value::as_u64).unwrap_or(8);
                if widgets::dropdown(ui, "nd-depth", &mut depth, &[(8u64, "8 bit"), (16, "16 bit"), (32, "32 bit")], 120.0) {
                    f.insert("depth".into(), json!(depth));
                }
            });
            ui.add_space(4.0);
            small_label(ui, tl!("Background Contents"));
            let mut bg = get_s(f, "background", "white");
            let opts = [
                ("white".to_string(), tl!("White")),
                ("black".to_string(), tl!("Black")),
                ("backgroundColor".to_string(), tl!("Background Color")),
                ("transparent".to_string(), tl!("Transparent")),
            ];
            if widgets::dropdown(ui, "nd-bg", &mut bg, &opts, 240.0) {
                f.insert("background".into(), json!(bg));
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_round_trip_through_pixels() {
        assert_eq!(to_unit(2100.0, "in", 300.0), 7.0);
        assert_eq!(from_unit(7.0, "in", 300.0), 2100.0);
        assert_eq!(from_unit(2.54, "cm", 300.0), 300.0);
        assert_eq!(to_unit(640.0, "px", 72.0), 640.0);
    }

    #[test]
    fn preset_sets_size_resolution_and_create_params_drop_ui_keys() {
        let mut f = crate::state::UiState::new_document_fields();
        let a4 = CATEGORIES.iter().find(|c| c.0 == "Print").unwrap().1.iter().find(|p| p.0 == "A4").unwrap();
        apply_preset(&mut f, a4);
        let p = command_params(&f);
        assert_eq!(p["width"], 2480);
        assert_eq!(p["height"], 3508);
        assert_eq!(p["resolution"], 300.0);
        assert!(p.get("__preset").is_none() && p.get("__unit").is_none());
        let mut s = photosuite_engine::Session::new();
        s.execute("file.new", p).unwrap();
        let d = &s.active().unwrap().doc;
        assert_eq!((d.size.width, d.size.height, d.resolution_dpi), (2480, 3508, 300.0));
    }
    fn app() -> crate::PhotosuiteApp {
        crate::PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default())
    }

    #[test]
    fn recent_lists_created_documents_newest_first_once_each() {
        let mut app = app();
        assert!(recent(&app).is_empty(), "nothing made yet");
        let mut a = crate::state::UiState::new_document_fields();
        a.insert("width".into(), json!(640));
        a.insert("height".into(), json!(480));
        a.insert("resolution".into(), json!(72.0));
        remember(&mut app, &a);
        let mut b = a.clone();
        let a4 = CATEGORIES.iter().find(|c| c.0 == "Print").unwrap().1.iter().find(|p| p.0 == "A4").unwrap();
        apply_preset(&mut b, a4);
        b.insert("mode".into(), json!("cmyk"));
        b.insert("depth".into(), json!(16));
        remember(&mut app, &b);
        let r = recent(&app);
        assert_eq!(r.iter().map(|d| (d.label.as_str(), d.width, d.height)).collect::<Vec<_>>(), [("A4", 2480, 3508), ("Custom", 640, 480)]);
        assert_eq!((r[0].fields["mode"].as_str(), r[0].fields["depth"].as_u64(), r[0].fields["__unit"].as_str()), (Some("cmyk"), Some(16), Some("in")));
        // Making the 640 x 480 one again moves it up instead of adding a copy.
        remember(&mut app, &a);
        let r = recent(&app);
        assert_eq!((r.len(), r[0].width), (2, 640));
        // The dialog opens on the last one, with the default name.
        let f = initial_fields(&app);
        assert_eq!((f["width"].as_u64(), f["height"].as_u64(), f["name"].as_str()), (Some(640), Some(480), Some("Untitled-1")));
        // It keeps the newest RECENT_MAX.
        for w in 1..=(RECENT_MAX as u64 + 5) {
            let mut c = a.clone();
            c.insert("width".into(), json!(w));
            remember(&mut app, &c);
        }
        let r = recent(&app);
        assert_eq!((r.len(), r[0].width), (RECENT_MAX, RECENT_MAX as u32 + 5));
    }

    #[test]
    fn unusable_stored_entries_are_skipped() {
        let mut app = app();
        app.session.prefs.edit(|p| {
            p.recent_new_documents = vec![
                json!("junk"),
                json!({"width": 0, "height": 10, "resolution": 72.0}),
                json!({"width": 10, "height": 10, "resolution": f64::MAX}),
                json!({"width": 10, "height": 10, "resolution": "high"}),
                json!({"width": 99, "height": 77, "resolution": 150.0, "unit": "furlong", "preset": ""}),
            ]
        });
        let r = recent(&app);
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].label.as_str(), r[0].width, r[0].fields["__unit"].as_str()), ("Custom", 99, Some("px")));
        // A dialog whose fields can't make a document records nothing.
        let mut bad = Map::new();
        bad.insert("width".into(), json!("wide"));
        remember(&mut app, &bad);
        assert_eq!(app.session.prefs().recent_new_documents.len(), 5);
    }

    /// The real dialog (#254): a typed size must reach `file.new`, however it is confirmed.
    mod dialog {
        use super::super::{CATEGORIES, apply_preset};
        use crate::PhotosuiteApp;
        use crate::state::{DialogKind, UiState};
        use egui::accesskit::Role;
        use egui_kittest::{Harness, kittest::Queryable};

        fn harness() -> Harness<'static, PhotosuiteApp> {
            let app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
            let mut h = Harness::builder().with_size(egui::vec2(1400.0, 900.0)).build_ui_state(|ui, app| crate::dialogs::show(app, ui.ctx()), app);
            PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
            h.state_mut().ui.open_dialog(DialogKind::NewDocument, UiState::new_document_fields());
            h.run_steps(3);
            h
        }

        fn click_at(h: &mut Harness<'static, PhotosuiteApp>, at: egui::Pos2) {
            h.hover_at(at);
            h.run_steps(1);
            h.drag_at(at);
            h.run_steps(1);
            h.drop_at(at);
            h.run_steps(2);
        }

        /// The Width (0), Height (1) and Resolution (2) fields.
        fn field(h: &Harness<'static, PhotosuiteApp>, i: usize) -> egui::Rect {
            h.query_all_by_role(Role::SpinButton).nth(i).map(|n| n.rect()).expect("a size field")
        }

        /// Click into field `i` (which selects its text) and type `text`, as a user does.
        fn type_into(h: &mut Harness<'static, PhotosuiteApp>, i: usize, text: &str) {
            let r = field(h, i);
            click_at(h, r.center());
            for c in text.chars() {
                h.event(egui::Event::Text(c.to_string()));
                h.run_steps(1);
            }
        }

        fn fields(h: &Harness<'static, PhotosuiteApp>) -> serde_json::Map<String, serde_json::Value> {
            h.state().ui.dialogs.first().map(|d| d.fields.clone()).expect("the dialog is open")
        }

        fn set_fields(h: &mut Harness<'static, PhotosuiteApp>, f: serde_json::Map<String, serde_json::Value>) {
            h.state_mut().ui.dialogs[0].fields = f;
            h.run_steps(2);
        }

        fn enter(h: &mut Harness<'static, PhotosuiteApp>) {
            h.key_press(egui::Key::Enter);
            h.run_steps(3);
        }

        fn created(h: &Harness<'static, PhotosuiteApp>) -> (u32, u32, f32) {
            assert!(h.state().ui.dialogs.is_empty(), "the dialog closed");
            let d = &h.state().session.active().expect("a new document").doc;
            (d.size.width, d.size.height, d.resolution_dpi)
        }

        #[test]
        fn typed_size_then_enter_creates_that_size() {
            let mut h = harness();
            type_into(&mut h, 0, "512");
            type_into(&mut h, 1, "512");
            let f = fields(&h);
            assert_eq!((f["width"].as_u64(), f["height"].as_u64()), (Some(512), Some(512)), "whole pixels: {f:?}");
            enter(&mut h);
            assert_eq!(created(&h), (512, 512, 72.0));
        }

        #[test]
        fn typed_size_then_create_without_leaving_the_field_creates_that_size() {
            let mut h = harness();
            type_into(&mut h, 0, "512");
            type_into(&mut h, 1, "300");
            // Still editing Height: click Create straight away.
            let create = h.get_by_label("Create").rect();
            click_at(&mut h, create.center());
            assert_eq!(created(&h), (512, 300, 72.0));
        }

        #[test]
        fn typing_over_a_preset_wins() {
            let mut h = harness();
            let mut f = fields(&h);
            let web = CATEGORIES.iter().find(|c| c.0 == "Web").unwrap().1.iter().find(|p| p.0 == "Web Minimum").unwrap();
            apply_preset(&mut f, web);
            set_fields(&mut h, f);
            type_into(&mut h, 0, "512");
            type_into(&mut h, 1, "512");
            assert!(fields(&h).get("__preset").is_none(), "typing deselects the preset");
            enter(&mut h);
            assert_eq!(created(&h), (512, 512, 72.0));
        }

        #[test]
        fn clicking_a_preset_card_after_typing_sets_its_size() {
            let mut h = harness();
            type_into(&mut h, 0, "512");
            h.get_by_label("Photo").click();
            h.run_steps(2);
            // The first card ("Landscape, 6 x 4") sits under the presets heading.
            let heading = h.get_by_label_contains("BLANK DOCUMENT PRESETS").rect();
            click_at(&mut h, heading.left_bottom() + egui::vec2(80.0, 60.0));
            assert_eq!(fields(&h).get("__preset").and_then(|v| v.as_str()), Some("Landscape, 6 x 4"));
            enter(&mut h);
            assert_eq!(created(&h), (1800, 1200, 300.0));
        }

        #[test]
        fn typed_size_in_inches_converts_at_the_resolution() {
            let mut h = harness();
            type_into(&mut h, 2, "300");
            let mut f = fields(&h);
            f.insert("__unit".into(), serde_json::json!("in"));
            set_fields(&mut h, f);
            type_into(&mut h, 0, "2");
            type_into(&mut h, 1, "1.5");
            enter(&mut h);
            assert_eq!(created(&h), (600, 450, 300.0));
        }

        #[test]
        fn changing_units_keeps_the_typed_pixel_size() {
            let mut h = harness();
            type_into(&mut h, 0, "512");
            type_into(&mut h, 1, "512");
            for unit in ["in", "cm", "mm", "pt", "pica", "px"] {
                let mut f = fields(&h);
                f.insert("__unit".into(), serde_json::json!(unit));
                set_fields(&mut h, f);
            }
            enter(&mut h);
            assert_eq!(created(&h), (512, 512, 72.0));
        }

        /// Create records the document under Recent; the next dialog opens on it, and its card
        /// sets every setting back.
        #[test]
        fn created_documents_appear_under_recent() {
            let mut h = harness();
            // Nothing made yet: the dialog opens on Film & Video, and Recent shows nothing.
            let film = CATEGORIES.iter().find(|c| c.0 == "Film & Video").map_or(0, |c| c.1.len());
            assert!(h.query_by_label(&format!("BLANK DOCUMENT PRESETS ({film})")).is_some(), "Film & Video presets show");
            assert!(h.query_by_label_contains("RECENT").is_none());
            type_into(&mut h, 0, "640");
            type_into(&mut h, 1, "480");
            let mut f = fields(&h);
            f.insert("mode".into(), serde_json::json!("gray"));
            set_fields(&mut h, f);
            enter(&mut h);
            assert_eq!(created(&h), (640, 480, 72.0));
            let fields = super::super::initial_fields(h.state());
            h.state_mut().ui.open_dialog(DialogKind::NewDocument, fields);
            h.run_steps(3);
            assert!(h.query_by_label_contains("RECENT (1)").is_some(), "Recent lists it");
            let f = self::fields(&h);
            assert_eq!((f["width"].as_u64(), f["mode"].as_str()), (Some(640), Some("gray")), "opens on the last document");
            assert_eq!(f["__preset"].as_str(), Some("__recent0"), "with its card selected");
            // Change the size, then click the Recent card: its settings come back.
            let mut f2 = f.clone();
            f2.insert("width".into(), serde_json::json!(100));
            f2.insert("mode".into(), serde_json::json!("rgb"));
            set_fields(&mut h, f2);
            let heading = h.get_by_label_contains("RECENT (1)").rect();
            click_at(&mut h, heading.left_bottom() + egui::vec2(80.0, 60.0));
            let f = self::fields(&h);
            assert_eq!((f["width"].as_u64(), f["mode"].as_str()), (Some(640), Some("gray")));
        }

        #[test]
        fn orientation_swap_keeps_whole_pixels() {
            let mut h = harness();
            type_into(&mut h, 0, "512");
            type_into(&mut h, 1, "256");
            // The Portrait icon button follows the "Orientation" label (icons have tooltips only).
            let label = h.get_by_label("Orientation").rect();
            let gap = h.ctx.global_style().spacing.item_spacing.x;
            click_at(&mut h, egui::pos2(label.right() + gap + 12.0, label.center().y));
            enter(&mut h);
            assert_eq!(created(&h), (256, 512, 72.0));
        }
    }
}
