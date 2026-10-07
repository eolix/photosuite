//! Canvas context actions for selection and Pen tools.

use egui::Context;
use photosuite_doc::LayerContent;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{PhotosuiteApp, state::Tool};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CanvasToolMenu {
    pub pos: [f32; 2],
    pub tool: Tool,
    pub has_selection: bool,
    #[serde(default)]
    pub has_path: bool,
    #[serde(default)]
    pub path_name: Option<String>,
    /// Opened over a Free Transform box: its modes instead of the tool's actions.
    #[serde(default)]
    pub transform: bool,
}

/// Right-click while transforming: what the box's handles do.
pub const TRANSFORM_MENU: &[(&str, &str)] = &[
    ("Free Transform", "edit.freeTransform"),
    ("Scale", "edit.transform.scale"),
    ("Rotate", "edit.transform.rotate"),
    ("Skew", "edit.transform.skew"),
    ("Distort", "edit.transform.distort"),
    ("Perspective", "edit.transform.perspective"),
];

/// Photoshop's Pen context menu order. `None` is a separator. Rows whose operation is not
/// applicable to the current path or layer stay visible and disabled.
pub const PEN_MENU: &[Option<(&str, &str)>] = &[
    Some(("Create Vector Mask", "layer.vectorMask.fromPath")),
    Some(("Delete Path", "path.delete")),
    None,
    Some(("Define Custom Shape…", "edit.defineCustomShape")),
    None,
    Some(("Make Selection…", "path.toSelection")),
    Some(("New Guides From Shape", "view.newGuidesFromShape")),
    Some(("Fill Path…", "path.fill")),
    Some(("Stroke Path…", "path.stroke")),
    None,
    Some(("Clipping Path…", "path.clippingPath.set")),
    None,
    Some(("Free Transform Path", "path.transform")),
    None,
    Some(("Unite Shapes", "layer.combineShapes.unite")),
    Some(("Subtract Front Shape", "layer.combineShapes.subtractFrontShape")),
    Some(("Unite Shapes at Overlap", "layer.combineShapes.intersectShapeAreas")),
    Some(("Subtract Shapes at Overlap", "layer.combineShapes.excludeOverlappingShapes")),
    None,
    Some(("Copy Fill", "path.style.copyFill")),
    Some(("Copy Complete Stroke", "path.style.copyStroke")),
    None,
    Some(("Paste Fill", "path.style.pasteFill")),
    Some(("Paste Complete Stroke", "path.style.pasteStroke")),
    None,
    Some(("Isolate Layers", "select.isolateLayers")),
    None,
    Some(("Make Symmetry Path", "paint.symmetryFromPath")),
    Some(("Disable Symmetry Path", "paint.symmetryDisable")),
];

/// Tools whose plain canvas right-click offers selection actions.
pub fn applies(tool: Tool) -> bool {
    matches!(tool, Tool::RectMarquee | Tool::EllipseMarquee | Tool::Lasso | Tool::PolygonLasso | Tool::MagicWand | Tool::ObjectSelection | Tool::Pen)
}

/// Command ids are shared with the Select menu. Disabled actions remain visible.
pub fn entries(has_selection: bool) -> &'static [(&'static str, &'static str)] {
    if has_selection {
        &[
            ("Deselect", "select.deselect"),
            ("Inverse Selection", "select.inverse"),
            ("Feather…", "select.modify.feather"),
            ("Select and Mask…", "select.selectAndMask"),
            ("Transform Selection", "select.transformSelection"),
        ]
    } else {
        &[("Reselect", "select.reselect")]
    }
}

pub fn menu_entries(menu: &CanvasToolMenu) -> &'static [(&'static str, &'static str)] {
    if menu.transform {
        TRANSFORM_MENU
    } else if menu.tool == Tool::Pen {
        &[]
    } else {
        entries(menu.has_selection)
    }
}

/// Is `command` the transform box's current mode (checked in the transform menu)?
/// Scale and Rotate are Free Transform's mode, so only Free Transform shows it checked.
fn mode_checked(app: &PhotosuiteApp, menu: &CanvasToolMenu, command: &str) -> bool {
    menu.transform
        && !matches!(command, "edit.transform.scale" | "edit.transform.rotate")
        && app.ui.transform.as_ref().is_some_and(|t| t.mode == crate::state::TransformMode::for_command(command))
}

/// Right-click over a Free Transform box: its modes.
pub fn open_transform(app: &mut PhotosuiteApp, pos: [f32; 2]) -> bool {
    if !pos.iter().all(|v| v.is_finite()) {
        return false;
    }
    app.ui.brush_picker = None;
    app.ui.layer_menu = None;
    app.ui.canvas_tool_menu = Some(CanvasToolMenu { pos, tool: app.ui.tool, has_selection: false, has_path: false, path_name: None, transform: true });
    true
}

pub fn entry_enabled(app: &PhotosuiteApp, menu: &CanvasToolMenu, command: &str) -> bool {
    if menu.transform || menu.tool != Tool::Pen {
        return crate::menus::is_enabled(app, command);
    }
    let Some(st) = app.session.active() else { return false };
    let layer = st.active_layer.and_then(|id| st.doc.layer(id));
    let can_paint = layer.is_some_and(|l| matches!(l.content, LayerContent::Raster(_)) && !l.locks.all);
    let shape_layer = layer.and_then(|l| match &l.content {
        LayerContent::Shape(sh) => Some(sh),
        _ => None,
    });
    let shape = shape_layer.is_some();
    let can_mask = layer.is_some_and(|l| !matches!(l.content, LayerContent::Shape(_)) && !l.locks.all);
    let saved = menu.path_name.as_deref().is_some_and(|n| n != "work" && n != "layer");
    let has_path = menu.has_path;
    let pending = app.ui.pen.as_ref().is_some_and(|p| p.knots.len() >= 2);
    let pending_layer = pending && (app.ui.tool_options.vector_mode == "shape" || app.ui.vector_mask_target);
    match command {
        "layer.vectorMask.fromPath" => has_path && can_mask && !pending_layer,
        "path.delete" => has_path && !pending_layer && (pending || menu.path_name.as_deref() != Some("layer")),
        "edit.defineCustomShape" | "path.toSelection" | "path.transform" | "paint.symmetryFromPath" => has_path,
        "view.newGuidesFromShape" => shape && !pending,
        "path.fill" | "path.stroke" => has_path && can_paint && !pending_layer,
        "path.clippingPath.set" => saved && !pending,
        "layer.combineShapes.unite"
        | "layer.combineShapes.subtractFrontShape"
        | "layer.combineShapes.intersectShapeAreas"
        | "layer.combineShapes.excludeOverlappingShapes" => !pending && shape_layer.is_some_and(|sh| sh.path.subpaths.len() > 1),
        "path.style.copyFill" => !pending && shape_layer.is_some_and(|sh| sh.fill.is_some()),
        "path.style.copyStroke" => !pending && shape_layer.is_some_and(|sh| sh.stroke.is_some()),
        "path.style.pasteFill" => !pending && shape && app.session.path_fill_clipboard.is_some(),
        "path.style.pasteStroke" => !pending && shape && app.session.path_stroke_clipboard.is_some(),
        "select.isolateLayers" => layer.is_some(),
        "paint.symmetryDisable" => st.symmetry_path.is_some(),
        _ => false,
    }
}

pub fn open(app: &mut PhotosuiteApp, tool: Tool, pos: [f32; 2]) -> bool {
    if !applies(tool) || !pos.iter().all(|v| v.is_finite()) {
        return false;
    }
    app.ui.brush_picker = None;
    app.ui.layer_menu = None;
    let has_selection = app.session.active().is_some_and(|s| s.doc.selection.is_some());
    let has_path = crate::vector_ui::active_path_name(app).is_some() || app.ui.pen.as_ref().is_some_and(|p| p.knots.len() >= 2);
    let path_name = crate::vector_ui::active_path_name(app);
    app.ui.canvas_tool_menu = Some(CanvasToolMenu { pos, tool, has_selection, has_path, path_name, transform: false });
    true
}

pub fn choose(app: &mut PhotosuiteApp, ctx: &Context, command: &str) {
    let Some(menu) = app.ui.canvas_tool_menu.take() else { return };
    if menu.tool == Tool::Pen && !menu.transform {
        if !PEN_MENU.iter().flatten().any(|(_, id)| *id == command) || !entry_enabled(app, &menu, command) {
            return;
        }
        if let Err(e) = choose_pen(app, ctx, &menu, command) {
            app.ui.status = e;
            app.ui.status_error = true;
        }
        return;
    }
    if !menu_entries(&menu).iter().any(|&(_, id)| id == command) || !crate::menus::is_enabled(app, command) {
        return;
    }
    if let Err(e) = crate::menus::invoke(app, ctx, command, json!({})) {
        app.ui.status = e;
    }
}

fn pen_dialog(app: &mut PhotosuiteApp, command: &str, label: &str, name: &str) {
    let spec = match command {
        "edit.defineCustomShape" => r##"{"name":text}"##,
        "path.toSelection" => r##"{"feather":0..250=0,"antiAlias":bool=true,"mode":"replace|add|subtract|intersect"="replace"}"##,
        "path.fill" => r##"{"color":text,"opacity":0..100=100,"feather":0..250=0,"antiAlias":bool=true}"##,
        "path.stroke" => r##"{"tool":"brush|pencil|eraser"="brush","size":1..500=10,"color":text,"opacity":0..100=100}"##,
        "path.clippingPath.set" => r##"{"flatness":0..100=0}"##,
        "path.transform" => r##"{"translateX":-30000..30000=0,"translateY":-30000..30000=0,"scaleX":0.01..100=1,"scaleY":0.01..100=1,"angle":-360..360=0}"##,
        _ => "{}",
    };
    let mut fields = serde_json::Map::new();
    if command == "edit.defineCustomShape" {
        fields.insert("path".into(), json!(name));
        fields.insert("name".into(), json!(""));
    } else {
        fields.insert("name".into(), json!(name));
    }
    fields.insert("__command".into(), json!(command));
    fields.insert("__label".into(), json!(label));
    fields.insert("__filter".into(), json!(true));
    fields.insert("__spec".into(), json!(spec));
    if matches!(command, "path.fill" | "path.stroke") {
        let fg = app.session.tools.foreground;
        let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        fields.insert("color".into(), json!(format!("#{:02x}{:02x}{:02x}", byte(fg[0]), byte(fg[1]), byte(fg[2]))));
    }
    if command == "path.transform" {
        for (key, value) in [("translateX", 0.0), ("translateY", 0.0), ("scaleX", 1.0), ("scaleY", 1.0), ("angle", 0.0)] {
            fields.insert(key.into(), json!(value));
        }
    }
    app.ui.open_dialog(crate::state::DialogKind::Command, fields);
}

fn choose_pen(app: &mut PhotosuiteApp, ctx: &Context, menu: &CanvasToolMenu, command: &str) -> Result<(), String> {
    if command == "select.isolateLayers" {
        crate::menus::invoke(app, ctx, command, json!({}))?;
        return Ok(());
    }
    if command == "paint.symmetryDisable" {
        app.run(command, json!({}))?;
        return Ok(());
    }
    let pending = app.ui.pen.as_ref().is_some_and(|p| p.knots.len() >= 2);
    let pending_layer = pending && (app.ui.tool_options.vector_mode == "shape" || app.ui.vector_mask_target);
    if pending {
        crate::vector_ui::pen_commit(app, false);
    }
    let name = if pending { Some(if pending_layer { "layer" } else { "work" }.to_string()) } else { menu.path_name.clone() }
        .ok_or_else(|| "No path is available for this action".to_string())?;
    match command {
        "edit.defineCustomShape" | "path.toSelection" | "path.fill" | "path.stroke" | "path.clippingPath.set" | "path.transform" => {
            let label = PEN_MENU.iter().flatten().find(|(_, id)| *id == command).map_or(command, |(label, _)| *label);
            pen_dialog(app, command, label, &name);
        }
        _ => {
            app.run(command, json!({"name": name}))?;
        }
    }
    Ok(())
}

pub fn show(app: &mut PhotosuiteApp, ctx: &Context) {
    let Some(menu) = app.ui.canvas_tool_menu.clone() else { return };
    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) || app.ui.tool != menu.tool || (menu.transform && app.ui.transform.is_none()) {
        app.ui.canvas_tool_menu = None;
        return;
    }
    let id = egui::Id::new("canvas-selection-menu");
    let screen = ctx.content_rect();
    let size = ctx.memory(|m| m.area_rect(id)).map_or(egui::vec2(210.0, 140.0), |r| r.size());
    let pos = egui::pos2(menu.pos[0].min(screen.right() - size.x).max(screen.left()), menu.pos[1].min(screen.bottom() - size.y).max(screen.top()));
    let mut selected = None;
    let area = egui::Area::new(id).order(egui::Order::Foreground).fixed_pos(pos).show(ctx, |ui| {
        egui::Frame::menu(ui.style()).show(ui, |ui| {
            let t = crate::theme::Tokens::get(ui.ctx());
            let v = &mut ui.style_mut().visuals;
            v.widgets.inactive.weak_bg_fill = egui::Color32::TRANSPARENT;
            v.widgets.inactive.bg_stroke = egui::Stroke::NONE;
            v.widgets.hovered.weak_bg_fill = t.accent;
            v.widgets.hovered.bg_fill = t.accent;
            v.widgets.hovered.bg_stroke = egui::Stroke::NONE;
            v.widgets.hovered.fg_stroke = egui::Stroke::new(1.0, egui::Color32::WHITE);
            v.widgets.hovered.corner_radius = egui::CornerRadius::same(3);
            ui.spacing_mut().item_spacing.y = 0.0;
            ui.set_width(200.0);
            if menu.tool == Tool::Pen && !menu.transform {
                for row in PEN_MENU {
                    if let Some((label, command)) = row {
                        let item = egui::Button::selectable(false, tl!(label)).min_size(egui::vec2(200.0, 20.0));
                        if ui.add_enabled(entry_enabled(app, &menu, command), item).clicked() {
                            selected = Some(*command);
                        }
                    } else {
                        ui.separator();
                    }
                }
            } else {
                for &(label, command) in menu_entries(&menu) {
                    let item = egui::Button::selectable(mode_checked(app, &menu, command), tl!(&label)).min_size(egui::vec2(200.0, 22.0));
                    if ui.add_enabled(entry_enabled(app, &menu, command), item).clicked() {
                        selected = Some(command);
                    }
                }
            }
        });
    });
    if let Some(command) = selected {
        choose(app, ctx, command);
    } else if ctx.input(|i| i.pointer.any_pressed() && i.pointer.interact_pos().is_some_and(|p| !area.response.rect.contains(p))) {
        app.ui.canvas_tool_menu = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::{Modifiers, PointerButton, Pos2, vec2};
    use egui_kittest::Harness;

    fn app() -> PhotosuiteApp {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.run("file.new", json!({"width": 32, "height": 32})).unwrap();
        app
    }

    fn work_path(app: &mut PhotosuiteApp) {
        app.run(
            "path.set",
            json!({"name": "work", "path": {"subpaths": [{"closed": true, "knots": [
                {"anchor": [2, 2], "in": [2, 2], "out": [2, 2]},
                {"anchor": [20, 2], "in": [20, 2], "out": [20, 2]},
                {"anchor": [20, 20], "in": [20, 20], "out": [20, 20]}
            ]}]}}),
        )
        .unwrap();
    }

    fn choose_open(app: &mut PhotosuiteApp, command: &str) {
        assert!(open(app, Tool::Pen, [10.0, 10.0]));
        choose(app, &Context::default(), command);
    }

    fn harness(mut app: PhotosuiteApp) -> Harness<'static, PhotosuiteApp> {
        app.sync_views();
        let mut h = Harness::builder().with_size(vec2(1000.0, 700.0)).build_ui_state(
            |ui, app: &mut PhotosuiteApp| {
                let ctx = ui.ctx().clone();
                if !ctx.fonts(|f| f.families().contains(&egui::FontFamily::Name("medium".into()))) {
                    return;
                }
                egui::CentralPanel::default().show(ui, |ui| crate::canvas::document_area(app, ui));
            },
            app,
        );
        PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::default());
        h.run_steps(4);
        h
    }

    fn right_click(h: &mut Harness<'static, PhotosuiteApp>, p: Pos2, modifiers: Modifiers) {
        h.event(egui::Event::ModifiersChanged(modifiers));
        h.event(egui::Event::PointerMoved(p));
        h.run_steps(1);
        h.event(egui::Event::PointerButton { pos: p, button: PointerButton::Secondary, pressed: true, modifiers });
        h.run_steps(1);
        h.event(egui::Event::PointerButton { pos: p, button: PointerButton::Secondary, pressed: false, modifiers });
        h.event(egui::Event::ModifiersChanged(Modifiers::NONE));
        h.run_steps(2);
    }

    #[test]
    fn canvas_gesture_preserves_selection_and_command_override() {
        let mut app = app();
        app.ui.tool = Tool::Lasso;
        app.run("select.rect", json!({"x": 1, "y": 1, "width": 8, "height": 8})).unwrap();
        let mut h = harness(app);
        let center = h.state().last_canvas_rect.center();
        let revision = h.state().session.active().unwrap().revision;
        right_click(&mut h, center, Modifiers::NONE);
        assert!(h.state().ui.canvas_tool_menu.is_some());
        assert_eq!(h.state().session.active().unwrap().revision, revision, "right-click cannot alter selection");
        h.key_press(egui::Key::Escape);
        h.run_steps(2);
        assert!(h.state().ui.canvas_tool_menu.is_none());
        right_click(&mut h, center, Modifiers::COMMAND);
        assert!(h.state().ui.canvas_tool_menu.is_none(), "command right-click belongs to layer picker");
    }

    #[test]
    fn selection_menu_routes_actions_through_commands() {
        let mut app = app();
        app.ui.tool = Tool::RectMarquee;
        app.run("select.rect", json!({"x": 1, "y": 1, "width": 8, "height": 8})).unwrap();
        assert!(open(&mut app, Tool::RectMarquee, [10.0, 10.0]));
        assert!(entries(true).iter().any(|(_, id)| *id == "select.inverse"));
        let before = app.session.journal.len();
        choose(&mut app, &Context::default(), "select.inverse");
        assert!(app.ui.canvas_tool_menu.is_none());
        assert!(app.session.journal[before..].iter().any(|(id, _)| id == "select.inverse"));
        let before = app.session.journal.len();
        assert!(open(&mut app, Tool::RectMarquee, [10.0, 10.0]));
        choose(&mut app, &Context::default(), "select.deselect");
        assert!(app.session.active().unwrap().doc.selection.is_none());
        assert!(app.session.journal[before..].iter().any(|(id, _)| id == "select.deselect"));
        assert_eq!(entries(false), &[("Reselect", "select.reselect")]);
        assert!(open(&mut app, Tool::RectMarquee, [10.0, 10.0]));
        choose(&mut app, &Context::default(), "select.reselect");
        assert!(app.session.active().unwrap().doc.selection.is_some());
        assert!(app.session.journal.iter().any(|(id, _)| id == "select.reselect"));
    }

    #[test]
    fn unsupported_tools_and_nonfinite_positions_do_not_open_menu() {
        let mut app = app();
        assert!(!open(&mut app, Tool::Brush, [1.0, 1.0]));
        assert!(!open(&mut app, Tool::Lasso, [f32::NAN, 1.0]));
        assert!(app.ui.canvas_tool_menu.is_none());
        assert!(open(&mut app, Tool::MagicWand, [1.0, 1.0]));
        let before = app.session.journal.len();
        choose(&mut app, &Context::default(), "file.new");
        assert_eq!(app.session.journal.len(), before, "context menu cannot invoke an unrelated command");
    }

    #[test]
    fn completed_pen_path_right_click_makes_selection() {
        let mut app = app();
        app.ui.tool = Tool::Pen;
        for (x, y) in [(2.0, 2.0), (20.0, 2.0), (20.0, 20.0)] {
            crate::vector_ui::pen_down(&mut app, x, y);
            crate::vector_ui::pen_up(&mut app);
        }
        crate::vector_ui::pen_commit(&mut app, true);
        assert!(app.session.active().unwrap().doc.work_path.is_some());
        let mut h = harness(app);
        let center = h.state().last_canvas_rect.center();
        right_click(&mut h, center, Modifiers::NONE);
        assert!(h.state().ui.canvas_tool_menu.as_ref().is_some_and(|m| m.tool == Tool::Pen && m.has_path));
        let ctx = h.ctx.clone();
        choose(h.state_mut(), &ctx, "path.toSelection");
        let dialog = h.state().ui.dialogs.last().map(|d| d.id).unwrap();
        crate::dialogs::confirm(h.state_mut(), dialog).unwrap();
        assert!(h.state().session.active().unwrap().doc.selection.is_some());
        assert_eq!(h.state().session.journal.last().map(|(id, _)| id.as_str()), Some("path.toSelection"));
    }

    #[test]
    fn pen_menu_finishes_in_progress_path_before_selection() {
        let mut app = app();
        app.ui.tool = Tool::Pen;
        for (x, y) in [(2.0, 2.0), (20.0, 2.0), (20.0, 20.0)] {
            crate::vector_ui::pen_down(&mut app, x, y);
            crate::vector_ui::pen_up(&mut app);
        }
        assert!(app.session.active().unwrap().doc.work_path.is_none());
        assert!(open(&mut app, Tool::Pen, [10.0, 10.0]));
        let menu = app.ui.canvas_tool_menu.as_ref().unwrap();
        assert!(entry_enabled(&app, menu, "path.toSelection"));
        choose(&mut app, &Context::default(), "path.toSelection");
        let dialog = app.ui.dialogs.last().map(|d| d.id).unwrap();
        crate::dialogs::confirm(&mut app, dialog).unwrap();
        assert!(app.session.active().unwrap().doc.work_path.is_some());
        assert!(app.session.active().unwrap().doc.selection.is_some());
    }

    #[test]
    fn pen_menu_has_all_reference_rows_in_order_and_guards_unavailable_actions() {
        let labels: Vec<_> = PEN_MENU.iter().map(|row| row.map(|(label, _)| label)).collect();
        assert_eq!(
            labels,
            vec![
                Some("Create Vector Mask"),
                Some("Delete Path"),
                None,
                Some("Define Custom Shape…"),
                None,
                Some("Make Selection…"),
                Some("New Guides From Shape"),
                Some("Fill Path…"),
                Some("Stroke Path…"),
                None,
                Some("Clipping Path…"),
                None,
                Some("Free Transform Path"),
                None,
                Some("Unite Shapes"),
                Some("Subtract Front Shape"),
                Some("Unite Shapes at Overlap"),
                Some("Subtract Shapes at Overlap"),
                None,
                Some("Copy Fill"),
                Some("Copy Complete Stroke"),
                None,
                Some("Paste Fill"),
                Some("Paste Complete Stroke"),
                None,
                Some("Isolate Layers"),
                None,
                Some("Make Symmetry Path"),
                Some("Disable Symmetry Path"),
            ]
        );
        let mut app = app();
        app.ui.tool = Tool::Pen;
        assert!(open(&mut app, Tool::Pen, [10.0, 10.0]));
        let menu = app.ui.canvas_tool_menu.as_ref().unwrap();
        assert!(!entry_enabled(&app, menu, "path.toSelection"));
        let before = app.session.journal.len();
        choose(&mut app, &Context::default(), "path.toSelection");
        assert_eq!(app.session.journal.len(), before);
        assert!(app.ui.dialogs.is_empty());
    }

    #[test]
    fn pen_menu_creates_mask_deletes_path_and_opens_named_path_dialogs() {
        let mut app = app();
        app.ui.tool = Tool::Pen;
        work_path(&mut app);
        choose_open(&mut app, "layer.vectorMask.fromPath");
        let st = app.session.active().unwrap();
        assert!(st.active_layer.and_then(|id| st.doc.layer(id)).is_some_and(|l| l.vector_mask.is_some()));
        choose_open(&mut app, "edit.defineCustomShape");
        let id = app.ui.dialogs.last().map(|d| d.id).unwrap();
        let fields = &app.ui.dialogs.last().unwrap().fields;
        assert_eq!(fields.get("path"), Some(&json!("work")));
        app.ui.dialog_mut(id).unwrap().fields.insert("name".into(), json!("Menu Shape"));
        crate::dialogs::confirm(&mut app, id).unwrap();
        assert!(app.session.edit_state.custom_shapes.iter().any(|s| s.name == "Menu Shape"));
        choose_open(&mut app, "path.fill");
        let id = app.ui.dialogs.last().map(|d| d.id).unwrap();
        assert_eq!(app.ui.dialogs.last().unwrap().fields.get("name"), Some(&json!("work")));
        crate::dialogs::confirm(&mut app, id).unwrap();
        assert_eq!(app.session.journal.last().map(|(id, _)| id.as_str()), Some("path.fill"));
        choose_open(&mut app, "path.delete");
        assert!(app.session.active().unwrap().doc.work_path.is_none());
    }

    #[test]
    fn pen_menu_saved_path_clipping_and_numeric_transform() {
        let mut app = app();
        app.ui.tool = Tool::Pen;
        work_path(&mut app);
        app.run("path.rename", json!({"name": "work", "to": "Cutout"})).unwrap();
        app.ui.selected_path = Some("Cutout".into());
        assert!(open(&mut app, Tool::Pen, [10.0, 10.0]));
        assert!(entry_enabled(&app, app.ui.canvas_tool_menu.as_ref().unwrap(), "path.clippingPath.set"));
        choose(&mut app, &Context::default(), "path.clippingPath.set");
        let id = app.ui.dialogs.last().map(|d| d.id).unwrap();
        app.ui.dialog_mut(id).unwrap().fields.insert("flatness".into(), json!(2.0));
        crate::dialogs::confirm(&mut app, id).unwrap();
        assert_eq!(app.session.active().unwrap().doc.clipping_path.as_ref().map(|p| p.name.as_str()), Some("Cutout"));
        choose_open(&mut app, "path.transform");
        let id = app.ui.dialogs.last().map(|d| d.id).unwrap();
        app.ui.dialog_mut(id).unwrap().fields.insert("translateX".into(), json!(5.0));
        crate::dialogs::confirm(&mut app, id).unwrap();
        assert_eq!(app.session.journal.last().map(|(id, _)| id.as_str()), Some("path.transform"));
    }

    #[test]
    fn pen_shape_menu_enables_shape_ops_and_style_copy_only_when_applicable() {
        let mut app = app();
        app.ui.tool = Tool::Pen;
        app.run(
            "shape.create",
            json!({"kind":"path", "path":{"subpaths":[
            {"closed":true,"knots":[[2,2],[20,2],[20,20]]},
            {"closed":true,"knots":[[5,5],[10,5],[10,10]]}
        ]}, "fill":"#ff0000", "stroke":{"width":2,"color":"#000000"}}),
        )
        .unwrap();
        assert!(open(&mut app, Tool::Pen, [10.0, 10.0]));
        let menu = app.ui.canvas_tool_menu.as_ref().unwrap();
        assert!(entry_enabled(&app, menu, "layer.combineShapes.unite"));
        assert!(entry_enabled(&app, menu, "path.style.copyFill"));
        assert!(!entry_enabled(&app, menu, "path.style.pasteFill"));
        assert!(!entry_enabled(&app, menu, "path.fill"));
        choose(&mut app, &Context::default(), "path.style.copyFill");
        assert!(app.session.path_fill_clipboard.is_some());
        assert!(open(&mut app, Tool::Pen, [10.0, 10.0]));
        assert!(entry_enabled(&app, app.ui.canvas_tool_menu.as_ref().unwrap(), "path.style.pasteFill"));
    }

    #[test]
    fn unfinished_shape_path_disables_actions_that_would_target_the_previous_layer() {
        let mut app = app();
        app.ui.tool = Tool::Pen;
        app.ui.tool_options.vector_mode = "shape".into();
        for (x, y) in [(2.0, 2.0), (20.0, 2.0), (20.0, 20.0)] {
            crate::vector_ui::pen_down(&mut app, x, y);
            crate::vector_ui::pen_up(&mut app);
        }
        assert!(open(&mut app, Tool::Pen, [10.0, 10.0]));
        let menu = app.ui.canvas_tool_menu.as_ref().unwrap();
        for id in ["layer.vectorMask.fromPath", "path.delete", "path.fill", "path.stroke", "path.clippingPath.set", "view.newGuidesFromShape"] {
            assert!(!entry_enabled(&app, menu, id), "{id} must not act on the layer replaced by the pending shape");
        }
        assert!(entry_enabled(&app, menu, "path.toSelection"));
    }
}
