//! Dialogs rendered from `UiState::dialogs`. Field values live in the dialog data, so automation can
//! set them (`ui.dialog.set`) and confirm (`ui.dialog.confirm`) exactly like a user.

use serde_json::{Value, json};

use crate::PhotosuiteApp;
use crate::state::{Dialog, DialogKind};

/// Where this frame's dialogs are on screen (the canvas reads last frame's: it draws first).
const RECTS: &str = "pc-dialog-rects";

fn rects(ctx: &egui::Context) -> Vec<egui::Rect> {
    ctx.data(|m| m.get_temp(egui::Id::new(RECTS))).unwrap_or_default()
}

/// With a dialog open the rest of the window is inert (egui's modal layer), but like Photoshop the
/// image can still be panned and zoomed under it. The pointer position when it is over `canvas`
/// and not over a dialog or one of its popups.
pub fn free_pointer_over(ctx: &egui::Context, canvas: egui::Rect) -> Option<egui::Pos2> {
    if egui::Popup::is_any_open(ctx) {
        return None;
    }
    let p = ctx.pointer_hover_pos()?;
    let rects = rects(ctx);
    (canvas.contains(p) && !rects.iter().any(|r| r.contains(p))).then_some(p)
}

/// Pan drag under an open dialog: Space-drag, middle-drag, or a drag with the Hand tool, started on
/// the free canvas. Returns this frame's pointer movement.
pub fn pan_delta(ctx: &egui::Context, canvas: egui::Rect, hand: bool) -> Option<egui::Vec2> {
    let rects = rects(ctx);
    let (origin, panning, delta) = ctx.input(|i| {
        let p = &i.pointer;
        (p.press_origin(), p.middle_down() || (p.primary_down() && (hand || i.key_down(egui::Key::Space))), p.delta())
    });
    let origin = origin?;
    (panning && canvas.contains(origin) && !rects.iter().any(|r| r.contains(origin))).then_some(delta)
}

/// How a dialog's frame is sized: a width range for the content to fill (the ordinary
/// dialogs), or a fixed outer size (Camera Raw, Lens Correction).
#[derive(Clone, Copy, Debug)]
pub enum FrameSize {
    Width(f32, f32),
    Fixed(egui::Vec2),
}

/// Every dialog's frame: a modal over the document (not dimmed: Photoshop doesn't, so previews
/// are judged at true contrast), a title bar in the window title bar's colour, dragged by that
/// title bar and kept on screen below the app's title bar (on macOS the system's: a dialog there
/// would sit under the traffic lights, and a drag would move the window).
///
/// `body` gets the frame's content `Ui` and, for a fixed size, the body's size below the title
/// bar. The response says whether it should close (Esc is the caller's).
pub fn frame<R>(
    ctx: &egui::Context,
    id: egui::Id,
    title: &str,
    size: FrameSize,
    body: impl FnOnce(&mut egui::Ui, Option<egui::Vec2>) -> R,
) -> egui::ModalResponse<R> {
    // Offset from centre (below the title bar), moved by dragging the title bar (view state
    // only, so egui memory).
    let bounds = crate::widgets::dialog_bounds(ctx);
    let offset: egui::Vec2 = ctx.data(|m| m.get_temp(id)).unwrap_or_default();
    let mut drag = egui::Vec2::ZERO;
    let centre = bounds.center() - ctx.content_rect().center();
    // Kept inside the bounds by a correction worked out from last frame's size, never stored:
    // on its first frame a dialog's size isn't known yet, and storing a correction made from that
    // pinned the dialog to a corner.
    let size_id = id.with("size");
    let correction = ctx
        .data(|m| m.get_temp::<egui::Vec2>(size_id))
        .map(|sz| crate::widgets::keep_inside(egui::Rect::from_center_size(ctx.content_rect().center() + centre + offset, sz), bounds))
        .unwrap_or_default();
    let area = egui::Modal::default_area(id).anchor(egui::Align2::CENTER_CENTER, centre + offset + correction);
    let modal = egui::Modal::new(id).area(area).backdrop_color(egui::Color32::TRANSPARENT).show(ctx, |ui| {
        let margin = ui.spacing().menu_margin;
        let chrome = margin.sum() + egui::vec2(2.0, 2.0);
        let (min_w, max_w) = match size {
            FrameSize::Width(lo, hi) => (lo, hi),
            FrameSize::Fixed(outer) => ((outer.x - chrome.x).max(1.0), (outer.x - chrome.x).max(1.0)),
        };
        ui.set_min_width(min_w);
        ui.set_max_width(max_w);
        // Title bar: a strip across the dialog's top in the window title bar's colour, its
        // bottom edge the separator. Painted behind the title, so its slot is reserved first.
        let tk = crate::theme::Tokens::get(ui.ctx());
        let strip = ui.painter().clone().with_clip_rect(ui.ctx().content_rect());
        let strip_bg = strip.add(egui::Shape::Noop);
        ui.add_space(1.0);
        let t = ui.add(egui::Label::new(egui::RichText::new(title).font(crate::theme::semibold(13.0)).color(tk.text)).selectable(false)).rect;
        let frame_top = ui.max_rect().top() - f32::from(margin.top);
        let band = egui::Rect::from_min_max(
            egui::pos2(ui.max_rect().left() - f32::from(margin.left), frame_top),
            egui::pos2(ui.max_rect().right() + f32::from(margin.right), t.bottom() + 7.0),
        );
        let r = ui.visuals().menu_corner_radius;
        strip.set(strip_bg, egui::Shape::rect_filled(band, egui::CornerRadius { nw: r.nw, ne: r.ne, sw: 0, se: 0 }, tk.chrome));
        strip.line_segment([band.left_bottom(), band.right_bottom()], egui::Stroke::new(1.0, tk.separator));
        drag = ui.interact(band, id.with("title"), egui::Sense::drag()).drag_delta();
        ui.add_space(band.bottom() - t.bottom() + 10.0);
        let body_size = match size {
            FrameSize::Width(..) => None,
            FrameSize::Fixed(outer) => {
                let used = ui.min_rect().height() + ui.spacing().item_spacing.y;
                Some(egui::vec2(max_w, (outer.y - chrome.y - used).max(1.0)))
            }
        };
        body(ui, body_size)
    });
    ctx.data_mut(|m| m.insert_temp(size_id, modal.response.rect.size()));
    // A drag moves it from where it is shown, and stops at the bounds.
    if drag != egui::Vec2::ZERO {
        let moved = modal.response.rect.translate(drag);
        let to = offset + correction + drag + crate::widgets::keep_inside(moved, bounds);
        ctx.data_mut(|m| m.insert_temp(id, to));
    }
    modal
}

pub fn show(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let dialogs = app.ui.dialogs.clone();
    let mut shown = Vec::new();
    for d in dialogs {
        let mut fields = d.fields.clone();
        let mut outcome: Option<bool> = None; // Some(true)=OK, Some(false)=Cancel
        let title = display_title(&d);
        let id = egui::Id::new(("dialog", d.id));
        let wide = crate::prefs_ui::width(&d.fields);
        let mut min_w = wide.map_or(380.0, |w| w.clamp(380.0, 460.0));
        if d.kind == DialogKind::NewDocument {
            min_w = min_w.max(800.0);
        }
        let mut max_w = wide.unwrap_or(if d.kind == DialogKind::NewDocument {
            800.0
        } else if d.kind == DialogKind::LayerStyle {
            // Effect list, parameters, and the Preview swatch column.
            680.0
        } else if d.fields.contains_key("__export") || crate::color_picker_ui::owns(&d.fields) {
            600.0
        } else {
            440.0
        });
        if let Some(w) = crate::file_ui::dialog_width(&d.fields) {
            min_w = min_w.max(w);
            max_w = w;
        }
        let modal = frame(ctx, id, &title, FrameSize::Width(min_w, max_w), |ui, _| {
            match d.kind {
                DialogKind::NewDocument => {
                    let recent = crate::new_doc_ui::recent(app);
                    crate::new_doc_ui::body(ui, &mut fields, &recent)
                }
                DialogKind::About if fields.get("systemInfo").and_then(Value::as_bool) == Some(true) => {
                    let lines = crate::gpu_status::system_info(app);
                    for l in &lines {
                        ui.add(egui::Label::new(egui::RichText::new(l).font(crate::theme::mono(12.0))).selectable(true));
                    }
                    ui.add_space(8.0);
                    if crate::widgets::secondary_button(ui, "Copy", 84.0).clicked() {
                        ui.ctx().copy_text(lines.join("\n"));
                    }
                }
                DialogKind::About => {
                    ui.label(tl!("PhotoSuite — an open-source, native image editor written in Rust."));
                    ui.label(crate::i18n::fmt(tl!("Version {version}"), &[("version", &photosuite_engine::build_info::long_version())]));
                    ui.add_space(12.0);
                    ui.vertical_centered(|ui| {
                        crate::links::link_row(app, ui);
                    });
                    ui.add_space(10.0);
                    ui.weak("egui · wgpu · photosuite-engine");
                }
                DialogKind::Command if crate::fill_ui::owns(&fields) => crate::fill_ui::body(app, ui, &mut fields),
                DialogKind::Command if crate::rasterize_prompt::owns(&fields) => crate::rasterize_prompt::body(ui, &fields),
                DialogKind::Command if crate::variables_ui::owns(&fields) => crate::variables_ui::body(app, ui, &mut fields),
                DialogKind::Command if crate::file_ui::owns(&fields) => crate::file_ui::body(app, ui, &mut fields),
                DialogKind::Command if crate::color_picker_ui::owns(&fields) => crate::color_picker_ui::body(ui, &mut fields),
                DialogKind::Command if crate::color_range_ui::owns(&fields) => crate::color_range_ui::body(app, ui, &mut fields),
                DialogKind::Command if crate::prefs_ui::owns(&fields) => crate::prefs_ui::body(app, ui, &mut fields),
                DialogKind::Command if fields.contains_key("__export") => crate::export_dialog::body(app, ui, &mut fields),
                DialogKind::Command if fields.contains_key("__sizing") => crate::sizing::body(ui, &mut fields),
                DialogKind::Command if crate::adjust_ui::owns_lookup(&fields) => crate::adjust_ui::lookup_dialog_body(app, ui, &mut fields),
                DialogKind::Command if crate::adjust_dialog::owns(&fields) => crate::adjust_dialog::body(app, ui, &mut fields),
                DialogKind::Command if fields.contains_key("__filter") => crate::filter_dialog::body(ui, &mut fields),
                DialogKind::Command if fields.contains_key("__form") => crate::view_cmds::form_body(ui, &mut fields),
                DialogKind::Command => {}
                DialogKind::LayerStyle => crate::layer_style::body(ui, &mut fields, &app.session.patterns),
                DialogKind::Error => {
                    ui.label(fields.get("message").and_then(Value::as_str).unwrap_or("Error"));
                }
            }
            ui.add_space(8.0);
            // Align::Min, not Center: a centred row fills the height left over from last frame's
            // (larger) size, so a dialog whose body gets shorter would never shrink back.
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                if matches!(d.kind, DialogKind::About | DialogKind::Error) {
                    if crate::widgets::primary_button(ui, tl!("OK"), 84.0).clicked() {
                        outcome = Some(false);
                    }
                } else {
                    let ok_label = if d.kind == DialogKind::NewDocument {
                        tl!("Create")
                    } else if d.fields.contains_key("__export") {
                        tl!("Export")
                    } else {
                        crate::file_ui::ok_label(&d.fields).unwrap_or("OK")
                    };
                    if crate::widgets::primary_button(ui, ok_label, 84.0).clicked() || ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                        outcome = Some(true);
                    }
                    if crate::widgets::secondary_button(ui, if d.kind == DialogKind::NewDocument { "Close" } else { "Cancel" }, 84.0).clicked() {
                        outcome = Some(false);
                    }
                }
            });
            // The frame around the content (Frame::popup's margin and stroke).
            ui.min_rect().expand(ui.spacing().menu_margin.sum().max_elem() + 2.0)
        });
        shown.push(modal.inner);
        // Esc cancels (topmost dialog, no popup open). A click outside does nothing: Photoshop keeps
        // the dialog, and the pointer may be panning or zooming the canvas under it.
        if outcome.is_none()
            && (modal.response.should_close()
                || (modal.is_top_modal && !modal.any_popup_open && ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Escape))))
        {
            outcome = Some(false);
        }
        if let Some(dm) = app.ui.dialog_mut(d.id) {
            dm.fields = fields;
        }
        match outcome {
            Some(true) => {
                let _ = confirm(app, d.id);
            }
            Some(false) => {
                app.ui.close_dialog(d.id);
                app.filter_preview = None;
                app.color_range = None;
            }
            None => {}
        }
    }
    ctx.data_mut(|m| m.insert_temp(egui::Id::new(RECTS), shown));
}

/// The dialog title as shown: [`title`] in the UI language.
fn display_title(d: &Dialog) -> String {
    match d.kind {
        DialogKind::Command => {
            let label = d.fields.get("__label").and_then(Value::as_str).unwrap_or("Command");
            // Dialog labels are catalogued with their "…" ("Export As…"); some commands omit it.
            let with_dots = format!("{}…", label.trim_end_matches('…'));
            let shown = if crate::i18n::has(crate::i18n::current(), label) { tl!(label) } else { tl!(&with_dots) };
            shown.trim_end_matches('…').to_string()
        }
        _ => tl!(&title(d)).to_string(),
    }
}

pub fn title(d: &Dialog) -> String {
    match d.kind {
        DialogKind::NewDocument => "New Document".into(),
        DialogKind::About if d.fields.get("systemInfo").and_then(Value::as_bool) == Some(true) => "System Info".into(),
        DialogKind::About => "About PhotoSuite".into(),
        DialogKind::LayerStyle => "Layer Style".into(),
        DialogKind::Command => d.fields.get("__label").and_then(Value::as_str).unwrap_or("Command").trim_end_matches('…').to_string(),
        DialogKind::Error => "Error".into(),
    }
}

/// Confirm a dialog: run its action and close it. Used by the OK button and by automation.
pub fn confirm(app: &mut PhotosuiteApp, id: u64) -> Result<Value, String> {
    let d = app.ui.close_dialog(id).ok_or_else(|| format!("no dialog {id}"))?;
    match d.kind {
        DialogKind::NewDocument => {
            let r = app.run("file.new", crate::new_doc_ui::command_params(&d.fields));
            if r.is_ok() {
                crate::new_doc_ui::remember(app, &d.fields);
            }
            if let Some(i) = app.session.active_index() {
                app.ui.views[i].fit_pending = true;
            }
            r
        }
        DialogKind::Command if crate::fill_ui::owns(&d.fields) => crate::fill_ui::confirm(app, &d.fields),
        DialogKind::Command if crate::rasterize_prompt::owns(&d.fields) => crate::rasterize_prompt::confirm(app, &d.fields),
        DialogKind::Command if crate::variables_ui::owns(&d.fields) => crate::variables_ui::confirm(app, &d.fields),
        DialogKind::Command if crate::file_ui::owns(&d.fields) => crate::file_ui::confirm(app, &d.fields),
        DialogKind::Command if crate::color_picker_ui::owns(&d.fields) => crate::color_picker_ui::confirm(app, &d.fields),
        DialogKind::Command if crate::color_range_ui::owns(&d.fields) => crate::color_range_ui::confirm(app, &d.fields),
        DialogKind::Command if crate::prefs_ui::owns(&d.fields) => crate::prefs_ui::confirm(app, &d.fields),
        DialogKind::Command if d.fields.contains_key("__export") => crate::export_dialog::confirm(app, &d.fields),
        DialogKind::Command => {
            app.filter_preview = None;
            let cmd = d.fields.get("__command").and_then(|v| v.as_str().map(str::to_string)).ok_or("dialog has no command")?;
            let (cmd, params) = crate::smart_ui::confirm_command(&d.fields, cmd, crate::filter_dialog::params_of(&d.fields));
            app.run(&cmd, params)
        }
        DialogKind::LayerStyle => crate::layer_style::confirm(app, &d.fields),
        DialogKind::About | DialogKind::Error => Ok(Value::Null),
    }
}

/// Open the parameter dialog of `command`: the adjustment editor for `image.adjustments.*`, the
/// schema dialog for filters, the Color Range dialog for `select.colorRange`, otherwise a bare
/// confirm dialog.
pub fn open_command_dialog(app: &mut PhotosuiteApp, command: &str, label: &str) -> u64 {
    if command == crate::color_range_ui::COMMAND {
        return crate::color_range_ui::open(app);
    }
    if let Some(id) = crate::adjust_dialog::open(app, command) {
        return id;
    }
    if crate::filter_dialog::has_dialog(command)
        && let Some(id) = crate::filter_dialog::open(app, command)
    {
        return id;
    }
    let mut fields = serde_json::Map::new();
    fields.insert("__command".into(), json!(command));
    fields.insert("__label".into(), json!(label));
    app.ui.open_dialog(DialogKind::Command, fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dialog opens centred below the title bar (its first frame, when its size isn't known
    /// yet, used to leave it pinned to a corner), and Camera Raw gets the same frame: the same
    /// title bar as every other dialog.
    #[test]
    fn dialogs_open_centred_and_share_one_frame() {
        use egui_kittest::{Harness, kittest::Queryable};

        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.run("file.new", serde_json::json!({"width": 64, "height": 48})).unwrap();
        let mut h = Harness::builder().with_size(egui::vec2(1440.0, 900.0)).build_ui_state(
            |ui, app| {
                show(app, ui.ctx());
                crate::camera_raw_ui::show(app, ui.ctx());
            },
            app,
        );
        PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
        h.state_mut().ui.open_dialog(DialogKind::LayerStyle, serde_json::Map::new());
        h.run_steps(4);
        let bounds = crate::widgets::dialog_bounds(&h.ctx);
        let title = h.get_by_label("Layer Style").rect();
        let ok = h.get_by_label("OK").rect();
        // Centred: the title's left edge and the OK button's right edge are about as far from the
        // window's sides.
        let (left, right) = (title.left() - bounds.left(), bounds.right() - ok.right());
        assert!((left - right).abs() < 24.0 && left > 100.0, "left {left}, right {right}");
        let layer_style_title = title.height();
        h.state_mut().ui.dialogs.clear();
        let ctx = h.ctx.clone();
        crate::camera_raw_ui::menu(h.state_mut(), &ctx, "filter.cameraRaw", &serde_json::json!({})).unwrap().unwrap();
        h.run_steps(4);
        let cr = h.get_by_label_contains("Camera Raw Filter").rect();
        assert!((cr.height() - layer_style_title).abs() < 0.5, "same title font: {} vs {layer_style_title}", cr.height());
        let cr_ok = h.get_by_label("OK").rect();
        let (left, right) = (cr.left() - bounds.left(), bounds.right() - cr_ok.right());
        assert!((left - right).abs() < 24.0 && left > 16.0, "Camera Raw: left {left}, right {right}");
    }

    #[test]
    fn dragging_the_title_bar_moves_the_dialog() {
        use egui_kittest::{Harness, kittest::Queryable};

        let app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        let mut harness = Harness::builder().with_size(egui::vec2(1400.0, 900.0)).build_ui_state(|ui, app| show(app, ui.ctx()), app);
        PhotosuiteApp::setup_context(&harness.ctx, crate::theme::ThemeKind::ALL[0]);
        harness.state_mut().ui.open_dialog(DialogKind::LayerStyle, serde_json::Map::new());
        harness.run_steps(3);
        let before = harness.get_by_label("Layer Style").rect();

        // Grab the title text itself: it must move the dialog, not select the text.
        let from = before.center();
        harness.hover_at(from);
        harness.drag_at(from);
        harness.run_steps(2);
        for i in 1..=10 {
            harness.hover_at(from + egui::vec2(-12.0, 8.0) * i as f32);
            harness.run_steps(1);
        }
        harness.drop_at(from + egui::vec2(-120.0, 80.0));
        harness.run_steps(3);

        let moved = harness.get_by_label("Layer Style").rect().min - before.min;
        assert!((moved - egui::vec2(-120.0, 80.0)).length() < 1.0, "dialog moved by {moved:?}");
        assert_eq!(harness.state().ui.dialogs.len(), 1, "dragging must not close the dialog");

        // Dragged far up, it stops below the title bar (on macOS the system's: under the traffic
        // lights, where a drag moves the window).
        let title = harness.get_by_label("Layer Style").rect();
        let from = title.center();
        harness.hover_at(from);
        harness.drag_at(from);
        harness.run_steps(2);
        for i in 1..=10 {
            harness.hover_at(from + egui::vec2(0.0, -150.0) * i as f32);
            harness.run_steps(1);
        }
        harness.drop_at(from + egui::vec2(0.0, -1500.0));
        harness.run_steps(3);
        let top = harness.get_by_label("Layer Style").rect().top();
        assert!(top >= crate::panels::title_bar_height(&harness.ctx), "title at {top}, under the title bar");
    }
}
