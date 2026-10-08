//! #790: paths can be reshaped after they're drawn, as in Photoshop: the Direct Selection tool
//! (A), and the Pen with ⌘/Ctrl (Direct Selection) or ⌥/Alt (Convert Point).

use egui::Modifiers;
use photosuite_doc::vector::Path;
use photosuite_geom::Point;
use serde_json::json;

use super::{Drag, PathRef};
use crate::PhotosuiteApp;
use crate::canvas::{ToolEvent, tool_event};
use crate::state::Tool;

fn app(tool: Tool) -> PhotosuiteApp {
    let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
    app.session.execute("file.new", json!({"width": 200, "height": 200})).unwrap();
    app.sync_views();
    app.ui.tool = tool;
    app
}

/// A square work path; knot 1 at (120, 40) is smooth with horizontal handles.
fn with_path(app: &mut PhotosuiteApp) {
    let path = json!({"subpaths": [{"closed": true, "knots": [
        [40, 40],
        {"anchor": [120, 40], "in": [100, 40], "out": [140, 40], "smooth": true},
        [120, 120],
        [40, 120],
    ]}]});
    app.run("path.set", json!({"name": "work", "path": path})).unwrap();
}

fn work(app: &PhotosuiteApp) -> Path {
    app.session.active().unwrap().doc.work_path.clone().unwrap()
}

fn anchor(app: &PhotosuiteApp, k: usize) -> Point {
    work(app).subpaths[0].knots[k].anchor
}

fn steps(app: &PhotosuiteApp) -> usize {
    app.session.active().unwrap().history.entries().len()
}

fn drag(app: &mut PhotosuiteApp, from: [f64; 2], to: [f64; 2], mods: Modifiers) {
    tool_event(app, ToolEvent::Down { x: from[0], y: from[1], pressure: 1.0 }, mods);
    let mid = [(from[0] + to[0]) / 2.0, (from[1] + to[1]) / 2.0];
    tool_event(app, ToolEvent::Move { x: mid[0], y: mid[1], pressure: 1.0 }, mods);
    tool_event(app, ToolEvent::Move { x: to[0], y: to[1], pressure: 1.0 }, mods);
    tool_event(app, ToolEvent::Up { x: to[0], y: to[1] }, mods);
}

fn click(app: &mut PhotosuiteApp, at: [f64; 2], mods: Modifiers) {
    drag(app, at, at, mods);
}

#[test]
fn dragging_an_anchor_moves_it_in_one_undoable_step() {
    let mut app = app(Tool::DirectSelection);
    with_path(&mut app);
    let (before, n) = (work(&app), steps(&app));
    drag(&mut app, [40.5, 120.5], [50.5, 130.5], Modifiers::NONE);
    assert_eq!(anchor(&app, 3), Point::new(50.0, 130.0));
    assert_eq!(anchor(&app, 0), Point::new(40.0, 40.0), "only the dragged anchor moved");
    assert_eq!(steps(&app), n + 1, "one history step for the whole drag");
    assert_eq!((app.ui.direct_selection.target, app.ui.direct_selection.anchors.clone()), (Some(PathRef::Work), vec![[0, 3]]));
    assert!(app.session.undo());
    assert_eq!(work(&app), before);
}

#[test]
fn the_preview_is_what_the_drag_commits() {
    let mut app = app(Tool::DirectSelection);
    with_path(&mut app);
    tool_event(&mut app, ToolEvent::Down { x: 80.0, y: 120.0, pressure: 1.0 }, Modifiers::NONE);
    tool_event(&mut app, ToolEvent::Move { x: 80.0, y: 150.0, pressure: 1.0 }, Modifiers::NONE);
    let Some(Drag::Edit { preview: Some(shown), .. }) = app.ui.direct_selection.drag.clone() else { panic!("a segment drag with a preview") };
    assert_ne!(shown, work(&app), "the document changes only on release");
    tool_event(&mut app, ToolEvent::Up { x: 80.0, y: 150.0 }, Modifiers::NONE);
    assert_eq!(work(&app), shown);
    // The straight bottom segment moved with both its anchors.
    assert_eq!((anchor(&app, 2), anchor(&app, 3)), (Point::new(120.0, 150.0), Point::new(40.0, 150.0)));
}

#[test]
fn a_smooth_points_handles_turn_together_and_alt_breaks_them() {
    let mut app = app(Tool::DirectSelection);
    with_path(&mut app);
    click(&mut app, [120.0, 40.0], Modifiers::NONE);
    assert_eq!(app.ui.direct_selection.anchors, vec![[0, 1]], "a click selects the anchor and shows its handles");
    drag(&mut app, [140.0, 40.0], [120.0, 60.0], Modifiers::NONE);
    let k = work(&app).subpaths[0].knots[1];
    assert_eq!(k.out_ctrl, Point::new(120.0, 60.0));
    assert!((k.in_ctrl.x - 120.0).abs() < 1e-9 && (k.in_ctrl.y - 20.0).abs() < 1e-9, "the opposite handle turned with it: {:?}", k.in_ctrl);
    drag(&mut app, [120.0, 20.0], [100.0, 20.0], Modifiers::ALT);
    let k = work(&app).subpaths[0].knots[1];
    assert_eq!((k.in_ctrl, k.out_ctrl, k.smooth), (Point::new(100.0, 20.0), Point::new(120.0, 60.0), false));
}

#[test]
fn marquee_shift_and_empty_clicks_select_like_photoshop() {
    let mut app = app(Tool::DirectSelection);
    with_path(&mut app);
    drag(&mut app, [100.0, 100.0], [180.0, 180.0], Modifiers::NONE);
    assert_eq!(app.ui.direct_selection.anchors, vec![[0, 2]]);
    click(&mut app, [40.0, 120.0], Modifiers::SHIFT);
    assert_eq!(app.ui.direct_selection.anchors, vec![[0, 2], [0, 3]], "⇧-click adds");
    // Dragging one selected anchor moves them all.
    drag(&mut app, [40.0, 120.0], [40.0, 110.0], Modifiers::NONE);
    assert_eq!((anchor(&app, 2), anchor(&app, 3)), (Point::new(120.0, 110.0), Point::new(40.0, 110.0)));
    click(&mut app, [40.0, 110.0], Modifiers::SHIFT);
    assert_eq!(app.ui.direct_selection.anchors, vec![[0, 2]], "⇧-click on a selected anchor deselects it");
    click(&mut app, [80.0, 80.0], Modifiers::NONE);
    assert!(app.ui.direct_selection.anchors.is_empty(), "a click on empty canvas deselects");
    click(&mut app, [80.0, 40.0], Modifiers::ALT);
    assert_eq!(app.ui.direct_selection.anchors.len(), 4, "⌥-click selects the whole subpath");
}

#[test]
fn pen_with_command_edits_paths_and_ends_the_one_being_drawn() {
    let mut app = app(Tool::Pen);
    for p in [[30.0, 30.0], [90.0, 30.0]] {
        click(&mut app, p, Modifiers::NONE);
    }
    assert_eq!(app.ui.pen.as_ref().map(|p| p.knots.len()), Some(2));
    // ⌘-drag (Ctrl-drag off the Mac) on the second anchor: the path is finished and edited.
    drag(&mut app, [90.0, 30.0], [90.0, 70.0], Modifiers::COMMAND);
    assert!(app.ui.pen.is_none());
    assert_eq!(app.ui.tool, Tool::Pen, "the Pen stays the tool");
    let wp = work(&app);
    assert_eq!((wp.subpaths[0].closed, wp.subpaths[0].knots[1].anchor), (false, Point::new(90.0, 70.0)));
    // Without ⌘ the Pen draws again.
    click(&mut app, [150.0, 150.0], Modifiers::NONE);
    assert_eq!(app.ui.pen.as_ref().map(|p| p.knots.len()), Some(1));
}

#[test]
fn pen_with_alt_converts_points() {
    let mut app = app(Tool::Pen);
    with_path(&mut app);
    click(&mut app, [120.0, 40.0], Modifiers::ALT);
    assert_eq!(work(&app).subpaths[0].knots[1], photosuite_doc::Knot::corner(120.0, 40.0), "⌥-click makes a corner");
    drag(&mut app, [40.0, 120.0], [40.0, 140.0], Modifiers::ALT);
    let k = work(&app).subpaths[0].knots[3];
    assert_eq!((k.in_ctrl, k.out_ctrl, k.smooth), (Point::new(40.0, 100.0), Point::new(40.0, 140.0), true), "⌥-drag pulls out smooth handles");
    assert!(app.ui.pen.is_none(), "no pen path was started");
    // ⌥ off the path is a plain Pen click.
    click(&mut app, [170.0, 170.0], Modifiers::ALT);
    assert!(app.ui.pen.is_some());
}

#[test]
fn shape_layer_paths_are_edited_too() {
    let mut app = app(Tool::DirectSelection);
    let id = app.run("shape.create", json!({"kind": "rect", "rect": [20, 20, 60, 60], "fill": "#3070c0"})).unwrap()["layer"].as_u64().unwrap();
    drag(&mut app, [80.0, 80.0], [100.0, 90.0], Modifiers::NONE);
    assert_eq!(app.ui.direct_selection.target, Some(PathRef::Layer(id)));
    let info = app.run("shape.info", json!({"layer": id})).unwrap();
    assert_eq!(info["path"]["subpaths"][0]["knots"][2]["anchor"], json!([100.0, 90.0]));
    let b: [i64; 4] = serde_json::from_value(info["bounds"].clone()).unwrap();
    assert!(b[0] + b[2] >= 100 && b[1] + b[3] >= 90, "the shape re-rendered: {b:?}");
}
