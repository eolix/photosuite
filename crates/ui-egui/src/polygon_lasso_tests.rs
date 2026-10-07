//! Polygonal Lasso through the real canvas: a double-click closes the polygon, and a
//! new-selection polygon hides the selection it replaces while it is drawn (⇧ or ⌥ at the first
//! click keep it, to add to or subtract from), replacing it in one history step.

use egui::{Modifiers, PointerButton, Pos2, vec2};
use egui_kittest::Harness;
use photosuite_geom::Rect;
use serde_json::json;

use crate::PhotosuiteApp;
use crate::canvas::ViewXform;
use crate::state::Tool;

fn harness() -> Harness<'static, PhotosuiteApp> {
    let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 400, "height": 300})).unwrap();
    app.sync_views();
    app.ui.extras.rulers = false;
    app.ui.tool = Tool::PolygonLasso;
    // 60 fps, so a double-click's two clicks fall inside egui's 0.3 s window.
    let mut h = Harness::builder().with_size(vec2(1000.0, 700.0)).with_step_dt(1.0 / 60.0).build_ui_state(
        |ui, app: &mut PhotosuiteApp| {
            let ctx = ui.ctx().clone();
            if !ctx.fonts(|f| f.families().contains(&egui::FontFamily::Name("medium".into()))) {
                return;
            }
            crate::shortcuts::handle(app, &ctx);
            egui::CentralPanel::default().show(ui, |ui| crate::canvas::document_area(app, ui));
        },
        app,
    );
    PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
    h.run_steps(4);
    // 100 %: one document pixel per point.
    let v = &mut h.state_mut().ui.views[0];
    v.zoom = 1.0;
    v.center = [200.0, 150.0];
    v.fit_pending = false;
    h.run_steps(2);
    h
}

fn screen(h: &Harness<'static, PhotosuiteApp>, x: f32, y: f32) -> Pos2 {
    let app = h.state();
    let v = &app.ui.views[0];
    let xf = ViewXform { rect: crate::rulers::content_rect(app, app.last_canvas_rect), zoom: v.zoom, center: v.center, flip: app.ui.view.flip_horizontal };
    xf.to_screen(x, y)
}

fn button(h: &mut Harness<'static, PhotosuiteApp>, p: Pos2, down: bool, m: Modifiers) {
    h.event(egui::Event::PointerButton { pos: p, button: PointerButton::Primary, pressed: down, modifiers: m });
    h.run_steps(1);
}

/// A click at document point `(x, y)`, the pointer still between press and release.
fn click(h: &mut Harness<'static, PhotosuiteApp>, x: f32, y: f32, m: Modifiers) {
    let p = screen(h, x, y);
    h.event(egui::Event::PointerMoved(p));
    h.run_steps(1);
    button(h, p, true, m);
    button(h, p, false, m);
}

fn double_click(h: &mut Harness<'static, PhotosuiteApp>, x: f32, y: f32) {
    click(h, x, y, Modifiers::NONE);
    click(h, x, y, Modifiers::NONE);
    h.run_steps(1);
}

fn selection(h: &Harness<'static, PhotosuiteApp>) -> Option<Rect> {
    h.state().session.active().unwrap().doc.selection.as_ref().map(|s| s.content_bounds())
}

fn near(r: Rect, x0: i32, y0: i32, x1: i32, y1: i32) -> bool {
    r.x0.abs_diff(x0) <= 1 && r.y0.abs_diff(y0) <= 1 && r.x1.abs_diff(x1) <= 1 && r.y1.abs_diff(y1) <= 1
}

#[test]
fn double_click_closes_the_polygon_at_the_last_point() {
    let mut h = harness();
    click(&mut h, 50.0, 50.0, Modifiers::NONE);
    h.run_steps(30); // Well past egui's double-click delay: separate clicks.
    click(&mut h, 150.0, 50.0, Modifiers::NONE);
    h.run_steps(30);
    double_click(&mut h, 150.0, 150.0);
    assert!(h.state().ui.polygon.is_empty(), "the polygon closed: {:?}", h.state().ui.polygon);
    let r = selection(&h).expect("a selection");
    assert!(near(r, 50, 50, 150, 150), "the triangle's bounds: {r:?}");
    // Only one vertex was added at the double-click, not a duplicate starting a new polygon.
    h.run_steps(30);
    assert!(h.state().ui.polygon.is_empty());
}

/// Vertices placed quickly: egui counts the double-click's second click as a triple click (the
/// vertex before it was under 0.6 s earlier). It still closes the polygon.
#[test]
fn double_click_closes_the_polygon_after_quickly_placed_vertices() {
    let mut h = harness();
    click(&mut h, 50.0, 50.0, Modifiers::NONE);
    h.run_steps(12);
    click(&mut h, 150.0, 50.0, Modifiers::NONE);
    h.run_steps(12);
    double_click(&mut h, 150.0, 150.0);
    assert!(h.state().ui.polygon.is_empty(), "{:?}", h.state().ui.polygon);
    assert!(selection(&h).is_some_and(|r| near(r, 50, 50, 150, 150)), "{:?}", selection(&h));
}

/// Double-clicking on the first vertex: the first click closes the polygon, and the second must
/// not start a new one (which would deselect what was just made).
#[test]
fn double_click_on_the_first_vertex_keeps_the_new_selection() {
    let mut h = harness();
    for (x, y) in [(50.0, 50.0), (150.0, 50.0), (150.0, 150.0)] {
        click(&mut h, x, y, Modifiers::NONE);
        h.run_steps(30);
    }
    double_click(&mut h, 50.0, 50.0);
    assert!(h.state().ui.polygon.is_empty());
    assert!(selection(&h).is_some_and(|r| near(r, 50, 50, 150, 150)), "{:?}", selection(&h));
}

/// Three clicks and Enter: a triangle with corners at the first three points.
fn triangle(h: &mut Harness<'static, PhotosuiteApp>, x: f32, y: f32, m: Modifiers) {
    h.event(egui::Event::ModifiersChanged(m));
    h.run_steps(1);
    for (dx, dy) in [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)] {
        click(h, x + dx, y + dy, m);
        h.run_steps(30); // Not a double-click with the click before.
    }
    h.event(egui::Event::ModifiersChanged(Modifiers::NONE));
    h.run_steps(1);
    h.key_press(egui::Key::Enter);
    h.run_steps(2);
}

fn steps(h: &Harness<'static, PhotosuiteApp>) -> usize {
    h.state().session.active().unwrap().history.entries().len()
}

/// A new polygon hides the selection it will replace; Esc brings it back untouched.
#[test]
fn a_new_polygon_hides_the_selection_and_esc_restores_it() {
    let mut h = harness();
    h.state_mut().run("select.rect", json!({"x": 200, "y": 150, "width": 100, "height": 100})).unwrap();
    h.run_steps(1);
    let before = steps(&h);
    click(&mut h, 20.0, 20.0, Modifiers::NONE);
    assert_eq!(h.state().ui.polygon.len(), 1);
    assert!(crate::canvas::polygon_replaces_selection(h.state()), "the old outline is hidden");
    assert_eq!(steps(&h), before, "starting a polygon records nothing");
    h.key_press(egui::Key::Escape);
    h.run_steps(2);
    assert!(h.state().ui.polygon.is_empty());
    assert!(!crate::canvas::polygon_replaces_selection(h.state()));
    assert!(selection(&h).is_some_and(|r| near(r, 200, 150, 300, 250)), "{:?}", selection(&h));
    assert_eq!(steps(&h), before);
}

/// Replacing a selection is one history step, and one Undo brings the old selection back.
#[test]
fn replacing_a_selection_is_one_history_step() {
    let mut h = harness();
    h.state_mut().run("select.rect", json!({"x": 200, "y": 150, "width": 100, "height": 100})).unwrap();
    h.run_steps(1);
    let before = steps(&h);
    triangle(&mut h, 20.0, 20.0, Modifiers::NONE);
    assert!(selection(&h).is_some_and(|r| near(r, 20, 20, 120, 120)), "{:?}", selection(&h));
    assert_eq!(steps(&h), before + 1);
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert!(selection(&h).is_some_and(|r| near(r, 200, 150, 300, 250)), "{:?}", selection(&h));
}

/// ⇧ (add) and ⌥ (subtract) at the first click keep the selection in view, and the polygon
/// combines in that mode even when it is closed with a bare Enter.
#[test]
fn modifiers_at_the_first_click_keep_and_combine_the_selection() {
    let mut h = harness();
    h.state_mut().run("select.rect", json!({"x": 200, "y": 150, "width": 100, "height": 100})).unwrap();
    h.run_steps(1);
    for m in [Modifiers::SHIFT, Modifiers::ALT] {
        h.event(egui::Event::ModifiersChanged(m));
        h.run_steps(1);
        click(&mut h, 20.0, 20.0, m);
        h.event(egui::Event::ModifiersChanged(Modifiers::NONE));
        h.run_steps(1);
        assert_eq!(h.state().ui.polygon.len(), 1, "{m:?}");
        assert!(!crate::canvas::polygon_replaces_selection(h.state()), "{m:?}: the selection stays in view");
        h.key_press(egui::Key::Escape);
        h.run_steps(30);
    }
    triangle(&mut h, 20.0, 20.0, Modifiers::SHIFT);
    assert!(selection(&h).is_some_and(|r| near(r, 20, 20, 300, 250)), "added: {:?}", selection(&h));
}

/// A new polygon over no selection records one step: the selection it makes.
#[test]
fn a_new_polygon_without_a_selection_adds_one_step() {
    let mut h = harness();
    let before = steps(&h);
    click(&mut h, 20.0, 20.0, Modifiers::NONE);
    assert_eq!(h.state().ui.polygon.len(), 1);
    assert_eq!(steps(&h), before);
    h.run_steps(30);
    h.key_press(egui::Key::Escape);
    h.run_steps(30);
    triangle(&mut h, 20.0, 20.0, Modifiers::NONE);
    assert_eq!(steps(&h), before + 1);
}
