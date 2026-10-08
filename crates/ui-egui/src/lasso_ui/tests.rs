use super::*;
use crate::canvas::tool_event;
use serde_json::json;

fn app() -> PhotosuiteApp {
    let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
    app.run("file.new", json!({"width": 400, "height": 300})).unwrap();
    app.sync_views();
    app.ui.tool = Tool::Lasso;
    app
}

fn event(app: &mut PhotosuiteApp, kind: &str, x: f64, y: f64, mods: Modifiers) {
    let ev = match kind {
        "down" => ToolEvent::Down { x, y, pressure: 1.0 },
        "up" => ToolEvent::Up { x, y },
        _ => ToolEvent::Move { x, y, pressure: 1.0 },
    };
    tool_event(app, ev, mods);
}

fn begin(app: &mut PhotosuiteApp, mods: Modifiers) {
    event(app, "down", 50.0, 50.0, mods);
    event(app, "move", 90.0, 40.0, mods);
    event(app, "move", 120.0, 50.0, mods);
}

#[test]
fn alt_clicks_preserve_outline_and_hover_does_not_draw() {
    let mut app = app();
    begin(&mut app, Modifiers::NONE);
    event(&mut app, "up", 120.0, 50.0, Modifiers::ALT);
    assert!(app.session.active().unwrap().doc.selection.is_none());
    event(&mut app, "move", 170.0, 10.0, Modifiers::ALT);
    event(&mut app, "move", 180.0, 100.0, Modifiers::ALT);
    assert_eq!(app.drag.as_ref().unwrap().points.len(), 3);
    event(&mut app, "down", 180.0, 100.0, Modifiers::ALT);
    event(&mut app, "up", 180.0, 100.0, Modifiers::ALT);
    assert_eq!(app.drag.as_ref().unwrap().points.len(), 4);
    assert_eq!(crate::tool_feedback::badge(&app, Tool::Lasso, Modifiers::ALT), None);
    // Release Alt between clicks, then continue a freehand stroke in the same outline.
    event(&mut app, "move", 140.0, 150.0, Modifiers::NONE);
    assert_eq!(app.drag.as_ref().unwrap().points.len(), 4);
    event(&mut app, "down", 130.0, 140.0, Modifiers::NONE);
    event(&mut app, "move", 90.0, 130.0, Modifiers::NONE);
    event(&mut app, "up", 50.0, 120.0, Modifiers::NONE);
    assert!(!active(&app));
    let sel = app.session.active().unwrap().doc.selection.as_ref().unwrap();
    assert!(sel.sample_channel(100, 80, 0) > 0.9);
    assert!(sel.sample_channel(160, 20, 0) < 0.1, "hover detour must stay outside");
    app.run("edit.undo", json!({})).unwrap();
    assert!(app.session.active().unwrap().doc.selection.is_none(), "one selection undo");
}

#[test]
fn switching_back_while_pressed_fixes_the_straight_endpoint() {
    let mut app = app();
    begin(&mut app, Modifiers::NONE);
    event(&mut app, "move", 180.0, 100.0, Modifiers::ALT);
    assert_eq!(app.drag.as_ref().unwrap().points.len(), 3);
    event(&mut app, "move", 170.0, 130.0, Modifiers::NONE);
    let pts = &app.drag.as_ref().unwrap().points;
    assert_eq!(&pts[3..], &[[180.0, 100.0, 1.0], [170.0, 130.0, 1.0]]);
    event(&mut app, "up", 50.0, 120.0, Modifiers::NONE);
    assert!(app.session.active().unwrap().doc.selection.is_some());
}

#[test]
fn initial_alt_still_subtracts_and_initial_shift_still_adds() {
    for initial in [Modifiers::ALT, Modifiers::SHIFT, Modifiers::SHIFT | Modifiers::ALT] {
        let mut app = app();
        app.run("select.rect", json!({"x": 0, "y": 0, "width": 150, "height": 200})).unwrap();
        begin(&mut app, initial);
        if initial.alt {
            event(&mut app, "move", 120.0, 50.0, Modifiers::NONE);
        }
        event(&mut app, "up", 120.0, 50.0, Modifiers::ALT);
        event(&mut app, "down", 180.0, 150.0, Modifiers::ALT);
        event(&mut app, "up", 180.0, 150.0, Modifiers::ALT);
        commit(&mut app);
        let sel = app.session.active().unwrap().doc.selection.as_ref().unwrap();
        assert_eq!(sel.sample_channel(120, 90, 0) > 0.5, initial.shift);
        assert_eq!(sel.sample_channel(10, 10, 0) > 0.5, !(initial.shift && initial.alt));
    }
}

#[test]
fn tool_or_document_switch_discards_pending_outline() {
    let mut app = app();
    begin(&mut app, Modifiers::NONE);
    event(&mut app, "up", 120.0, 50.0, Modifiers::ALT);
    app.ui.tool = Tool::Brush;
    app.sync_views();
    assert!(!active(&app));
    app.ui.tool = Tool::Lasso;
    begin(&mut app, Modifiers::NONE);
    event(&mut app, "up", 120.0, 50.0, Modifiers::ALT);
    app.run("file.new", json!({"width": 200, "height": 200})).unwrap();
    commit(&mut app);
    assert!(!active(&app));
    assert!(app.session.active().unwrap().doc.selection.is_none());
}

fn harness() -> egui_kittest::Harness<'static, PhotosuiteApp> {
    let mut h = egui_kittest::Harness::builder().with_size(egui::vec2(1000.0, 700.0)).build_ui_state(
        |ui, app: &mut PhotosuiteApp| {
            let ctx = ui.ctx().clone();
            if !ctx.fonts(|f| f.families().contains(&egui::FontFamily::Name("medium".into()))) {
                return;
            }
            crate::shortcuts::handle(app, &ctx);
            egui::CentralPanel::default().show(ui, |ui| crate::canvas::document_area(app, ui));
        },
        app(),
    );
    PhotosuiteApp::setup_context(&h.ctx, Default::default());
    h.run_steps(4);
    let v = &mut h.state_mut().ui.views[0];
    v.zoom = 1.0;
    v.center = [200.0, 150.0];
    v.fit_pending = false;
    h.run_steps(2);
    h
}

fn mouse(h: &mut egui_kittest::Harness<'static, PhotosuiteApp>, kind: &str, x: f32, y: f32, mods: Modifiers) {
    let app = h.state();
    let v = &app.ui.views[0];
    let xf = ViewXform { rect: crate::rulers::content_rect(app, app.last_canvas_rect), zoom: v.zoom, center: v.center, flip: false };
    let pos = xf.to_screen(x, y);
    h.event(Event::ModifiersChanged(mods));
    h.event(Event::PointerMoved(pos));
    if kind != "move" {
        h.event(Event::PointerButton { pos, button: PointerButton::Primary, pressed: kind == "down", modifiers: mods });
    }
    h.run_steps(2);
}

#[test]
fn real_canvas_alt_clicks_enter_escape_and_resume() {
    for finish in ["enter", "escape", "resume", "close"] {
        let mut h = harness();
        mouse(&mut h, "down", 50.0, 50.0, Modifiers::NONE);
        mouse(&mut h, "move", 120.0, 50.0, Modifiers::NONE);
        mouse(&mut h, "up", 120.0, 50.0, Modifiers::ALT);
        assert!(active(h.state()), "Alt release must keep gesture");
        mouse(&mut h, "move", 180.0, 100.0, Modifiers::ALT);
        mouse(&mut h, "down", 180.0, 100.0, Modifiers::ALT);
        mouse(&mut h, "up", 180.0, 100.0, Modifiers::ALT);
        assert_eq!(h.state().drag.as_ref().unwrap().points.len(), 3);
        match finish {
            "resume" => {
                mouse(&mut h, "down", 150.0, 150.0, Modifiers::NONE);
                mouse(&mut h, "move", 90.0, 130.0, Modifiers::NONE);
                mouse(&mut h, "up", 50.0, 120.0, Modifiers::NONE);
            }
            "close" => {
                mouse(&mut h, "down", 50.0, 50.0, Modifiers::ALT);
                mouse(&mut h, "up", 50.0, 50.0, Modifiers::ALT);
            }
            _ => {
                h.event(Event::Key {
                    key: if finish == "escape" { egui::Key::Escape } else { egui::Key::Enter },
                    physical_key: None,
                    pressed: true,
                    repeat: false,
                    modifiers: Modifiers::ALT,
                });
                h.run_steps(2);
            }
        }
        assert!(!active(h.state()), "{finish}");
        assert_eq!(h.state().session.active().unwrap().doc.selection.is_some(), finish != "escape", "{finish}");
    }
}

/// A lasso press inside the selection still drags the selection (`canvas::selection_drag_kind`),
/// both through tool events and through the real canvas.
#[test]
fn a_drag_inside_the_selection_moves_it() {
    let mut app = app();
    app.ui.extras.snap = false;
    app.run("select.rect", json!({"x": 100, "y": 100, "width": 50, "height": 40})).unwrap();
    let bounds = |app: &PhotosuiteApp| app.session.active().unwrap().doc.selection.as_ref().map(|s| s.content_bounds());
    event(&mut app, "down", 120.0, 120.0, Modifiers::NONE);
    event(&mut app, "move", 130.0, 125.0, Modifiers::NONE);
    event(&mut app, "up", 130.0, 125.0, Modifiers::NONE);
    assert!(!active(&app));
    assert_eq!(bounds(&app), Some(photosuite_geom::Rect::new(110, 105, 160, 145)));

    let mut h = harness();
    h.state_mut().ui.extras.snap = false;
    h.state_mut().run("select.rect", json!({"x": 100, "y": 100, "width": 50, "height": 40})).unwrap();
    h.run_steps(1);
    mouse(&mut h, "down", 120.0, 120.0, Modifiers::NONE);
    mouse(&mut h, "move", 125.0, 122.0, Modifiers::NONE);
    mouse(&mut h, "move", 130.0, 125.0, Modifiers::NONE);
    mouse(&mut h, "up", 130.0, 125.0, Modifiers::NONE);
    assert!(h.state().drag.is_none());
    assert_eq!(bounds(h.state()), Some(photosuite_geom::Rect::new(110, 105, 160, 145)));
}
