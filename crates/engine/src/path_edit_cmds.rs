//! Point-level path edits, what Photoshop's Direct Selection (A) and Convert Point tools do on
//! the canvas: move anchors, drag direction handles, bend segments and convert points. The
//! geometry is `photosuite_vector::edit`; the canvas previews a drag with it and commits the
//! whole drag as one command (one history step).
//!
//! Every command targets a path like `path.transform`: `"name":"work"` (default), a saved path's
//! name, or `"layer"` with `"layer":id?` for a shape layer's path (re-rendered; it stops being a
//! live shape) or a layer's vector mask. Knots are addressed by `subpath` and `knot` index, as
//! listed by `path.info`, and the result is `{name, path}` in the compact JSON form.

use photosuite_doc::{LayerContent, Path};
use photosuite_geom::Point;
use photosuite_vector::edit::{self, Handle};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::vector_cmds::{bad, has_doc, layer_id, nums, path_json, path_mut, pt, with_shape};
use crate::{Result, Session};

/// Coordinates and offsets beyond this are mistakes (the same bound as `path.transform`).
const MAX: f64 = 1_000_000.0;

fn finite(v: [f64; 2]) -> bool {
    v.iter().all(|c| c.is_finite() && c.abs() <= MAX)
}

fn offset(cmd: &str, p: &Value) -> Result<[f64; 2]> {
    nums::<2>(p, "move").filter(|d| finite(*d)).ok_or_else(|| bad(cmd, "`move` must be [dx, dy] with finite numbers of magnitude at most 1000000"))
}

fn point(cmd: &str, p: &Value, key: &str) -> Result<Option<Point>> {
    p.get(key)
        .map(|v| {
            pt(v).filter(|q| finite([q.x, q.y])).ok_or_else(|| bad(cmd, format!("`{key}` must be [x, y] with finite numbers of magnitude at most 1000000")))
        })
        .transpose()
}

fn index(cmd: &str, p: &Value, key: &str) -> Result<usize> {
    p.get(key).and_then(Value::as_u64).and_then(|i| usize::try_from(i).ok()).ok_or_else(|| bad(cmd, format!("missing `{key}` index")))
}

fn knot(cmd: &str, p: &Value) -> Result<[usize; 2]> {
    Ok([index(cmd, p, "subpath")?, index(cmd, p, "knot")?])
}

/// Applies `f` to the targeted path in one undoable step labelled `label`.
fn edit_path(s: &mut Session, cmd: &str, p: &Value, label: &str, f: impl FnOnce(&mut Path) -> std::result::Result<(), String>) -> Result<Value> {
    let name = p.get("name").and_then(Value::as_str).unwrap_or("work").to_owned();
    let layer = if name == "layer" { Some(layer_id(s, p)?) } else { None };
    let shape = layer.filter(|id| s.active().and_then(|d| d.doc.layer(*id)).is_some_and(|l| matches!(l.content, LayerContent::Shape(_))));
    let path = match shape {
        Some(id) => with_shape(s, id, label, |sh, _| {
            f(&mut sh.path).map_err(|e| bad(cmd, e))?;
            sh.live = None;
            sh.psd_raw = None;
            Ok(path_json(&sh.path))
        })?,
        None => s.edit(label, |doc, _| {
            let path = path_mut(doc, &name, layer)?;
            f(path).map_err(|e| bad(cmd, e))?;
            Ok(path_json(path))
        })?,
    };
    Ok(json!({ "name": name, "path": path }))
}

fn move_anchors(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "path.moveAnchors";
    let anchors: Vec<[usize; 2]> = p
        .get("anchors")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| bad(CMD, "`anchors` must list [subpath, knot] pairs"))?
        .iter()
        .map(|a| {
            let n = |i: usize| a.get(i).and_then(Value::as_u64).and_then(|v| usize::try_from(v).ok());
            n(0).zip(n(1)).map(|(s, k)| [s, k]).ok_or_else(|| bad(CMD, "each anchor is [subpath, knot]"))
        })
        .collect::<Result<_>>()?;
    let d = offset(CMD, p)?;
    edit_path(s, CMD, p, "Drag Anchor Points", |path| edit::move_anchors(path, &anchors, d))
}

fn move_handle(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "path.moveHandle";
    let k = knot(CMD, p)?;
    let h = p.get("handle").and_then(Value::as_str).and_then(Handle::parse).ok_or_else(|| bad(CMD, "`handle` must be \"in\" or \"out\""))?;
    let to = point(CMD, p, "to")?.ok_or_else(|| bad(CMD, "missing `to`"))?;
    let independent = p.get("independent").and_then(Value::as_bool).unwrap_or(false);
    edit_path(s, CMD, p, "Drag Direction Point", |path| edit::move_handle(path, k, h, to, independent))
}

fn bend_segment(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "path.bendSegment";
    let k = knot(CMD, p)?;
    let t = match p.get("t") {
        Some(v) => v.as_f64().filter(|t| (0.0..=1.0).contains(t)).ok_or_else(|| bad(CMD, "`t` must be between 0 and 1"))?,
        None => 0.5,
    };
    let d = offset(CMD, p)?;
    edit_path(s, CMD, p, "Drag Segment", |path| edit::bend_segment(path, k, t, d))
}

fn convert_point(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "path.convertPoint";
    let k = knot(CMD, p)?;
    let out = point(CMD, p, "out")?;
    edit_path(s, CMD, p, "Convert Point", |path| edit::convert_point(path, k, out))
}

pub fn specs() -> Vec<CommandSpec> {
    const TARGET: &str = r#""name":str|"work"|"layer"="work","layer":id? (with "layer": a shape layer's path or a vector mask)"#;
    let spec = |id: &'static str, label: &'static str, params: String, run: fn(&mut Session, &Value) -> Result<Value>| CommandSpec {
        id,
        label,
        menu: &[],
        shortcut: None,
        params: crate::vector_cmds::leak(format!("{{{TARGET},{params}}} → {{name,path}}")),
        enabled: has_doc,
        run,
        journal: true,
    };
    vec![
        spec("path.moveAnchors", "Drag Anchor Points", r#""anchors":[[subpath,knot],…],"move":[dx,dy] (anchors move with their handles; Direct Selection drag)"#.into(), move_anchors),
        spec(
            "path.moveHandle",
            "Drag Direction Point",
            r#""subpath":i,"knot":j,"handle":"in|out","to":[x,y],"independent":bool=false (a smooth point turns its other handle to stay collinear; independent = ⌥ / Convert Point, makes a corner)"#.into(),
            move_handle,
        ),
        spec(
            "path.bendSegment",
            "Drag Segment",
            r#""subpath":i,"knot":j (the segment leaving it),"t":0..1=0.5 (where it was grabbed),"move":[dx,dy] (a straight segment moves with its anchors; a curve reshapes through the dragged point)"#.into(),
            bend_segment,
        ),
        spec(
            "path.convertPoint",
            "Convert Point",
            r#""subpath":i,"knot":j,"out":[x,y]? (none: corner with retracted handles; given: smooth with this out handle and its mirror)"#.into(),
            convert_point,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use photosuite_doc::{LayerId, ShapeLayer};
    use serde_json::json;

    use crate::Session;

    fn session() -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 120, "height": 100, "background": "white"})).unwrap();
        s
    }

    fn square() -> serde_json::Value {
        json!({"subpaths": [{"closed": true, "knots": [[10, 10], [60, 10], [60, 60], [10, 60]]}]})
    }

    fn anchor(v: &serde_json::Value, k: usize) -> [f64; 2] {
        serde_json::from_value(v["path"]["subpaths"][0]["knots"][k]["anchor"].clone()).unwrap()
    }

    fn work(s: &Session) -> photosuite_doc::Path {
        s.active().unwrap().doc.work_path.clone().unwrap()
    }

    #[test]
    fn anchors_move_in_one_undoable_step() {
        let mut s = session();
        s.execute("path.set", json!({"path": square()})).unwrap();
        let before = work(&s);
        let r = s.execute("path.moveAnchors", json!({"anchors": [[0, 1], [0, 2]], "move": [5, -3]})).unwrap();
        assert_eq!((anchor(&r, 1), anchor(&r, 2), anchor(&r, 0)), ([65.0, 7.0], [65.0, 57.0], [10.0, 10.0]));
        assert_eq!(s.active().unwrap().history.undo_label(), Some("Drag Anchor Points"));
        assert!(s.undo());
        assert_eq!(work(&s), before);
    }

    #[test]
    fn a_coalesced_drag_is_one_history_step() {
        let mut s = session();
        s.execute("path.set", json!({"path": square()})).unwrap();
        let steps = s.active().unwrap().history.entries().len();
        for _ in 0..3 {
            s.execute("path.moveAnchors", json!({"anchors": [[0, 0]], "move": [1, 0], "coalesce": "drag-1"})).unwrap();
        }
        assert_eq!(s.active().unwrap().history.entries().len(), steps + 1);
        assert_eq!(work(&s).subpaths[0].knots[0].anchor.x, 13.0);
    }

    #[test]
    fn handles_segments_and_convert_point() {
        let mut s = session();
        s.execute("path.set", json!({"path": square()})).unwrap();
        // Pull smooth handles out of the corner at (60, 10), then turn one: the other follows.
        s.execute("path.convertPoint", json!({"subpath": 0, "knot": 1, "out": [70, 10]})).unwrap();
        let r = s.execute("path.moveHandle", json!({"subpath": 0, "knot": 1, "handle": "out", "to": [60, 20]})).unwrap();
        let k = &r["path"]["subpaths"][0]["knots"][1];
        assert_eq!((k["in"].clone(), k["smooth"].clone()), (json!([60.0, 0.0]), json!(true)));
        let r = s.execute("path.moveHandle", json!({"subpath": 0, "knot": 1, "handle": "in", "to": [50, 0], "independent": true})).unwrap();
        let k = &r["path"]["subpaths"][0]["knots"][1];
        assert_eq!((k["out"].clone(), k["smooth"].clone()), (json!([60.0, 20.0]), json!(false)));
        // The straight bottom edge (2 → 3) drags with its anchors.
        let r = s.execute("path.bendSegment", json!({"subpath": 0, "knot": 2, "move": [0, 8]})).unwrap();
        assert_eq!((anchor(&r, 2), anchor(&r, 3)), ([60.0, 68.0], [10.0, 68.0]));
        let r = s.execute("path.convertPoint", json!({"subpath": 0, "knot": 1})).unwrap();
        assert_eq!(r["path"]["subpaths"][0]["knots"][1]["out"], json!([60.0, 10.0]));
    }

    #[test]
    fn shape_paths_and_vector_masks_are_edited_and_rerendered() {
        for depth in [8, 16, 32] {
            let mut s = Session::new();
            s.execute("file.new", json!({"width": 120, "height": 100, "depth": depth})).unwrap();
            let id = s.execute("shape.create", json!({"kind": "rect", "rect": [10, 10, 40, 40], "fill": "#ff0000"})).unwrap()["layer"].as_u64().unwrap();
            let r = s.execute("path.moveAnchors", json!({"name": "layer", "layer": id, "anchors": [[0, 1], [0, 2]], "move": [30, 0]})).unwrap();
            assert_eq!(anchor(&r, 1), [80.0, 10.0]);
            let st = s.active().unwrap();
            let photosuite_doc::LayerContent::Shape(ShapeLayer { live, cache, .. }) = &st.doc.layer(LayerId(id)).unwrap().content else { panic!("shape") };
            assert!(live.is_none(), "an edited rectangle is a plain path now");
            assert_eq!(cache.as_ref().unwrap().content_bounds().x1, 80, "depth {depth}: re-rendered");
        }
        let mut s = session();
        let id = s.active().unwrap().active_layer.unwrap().0;
        s.execute("layer.vectorMask.add", json!({"layer": id, "path": square()})).unwrap();
        s.execute("path.moveAnchors", json!({"name": "layer", "layer": id, "anchors": [[0, 0]], "move": [-5, -5]})).unwrap();
        let vm = s.active().unwrap().doc.layer(LayerId(id)).unwrap().vector_mask.clone().unwrap();
        assert_eq!(vm.path.subpaths[0].knots[0].anchor, photosuite_geom::Point::new(5.0, 5.0));
    }

    #[test]
    fn bad_params_fail_without_an_edit() {
        let mut s = session();
        assert!(s.execute("path.moveAnchors", json!({"anchors": [[0, 0]], "move": [1, 1]})).is_err(), "no work path");
        s.execute("path.set", json!({"path": square()})).unwrap();
        let steps = s.active().unwrap().history.entries().len();
        for (id, p) in [
            ("path.moveAnchors", json!({"anchors": [[0, 9]], "move": [1, 1]})),
            ("path.moveAnchors", json!({"anchors": [], "move": [1, 1]})),
            ("path.moveAnchors", json!({"anchors": [[0]], "move": [1, 1]})),
            ("path.moveAnchors", json!({"anchors": [[0, 0]], "move": [1e300, 1]})),
            ("path.moveAnchors", json!({"anchors": [[0, 0]]})),
            ("path.moveHandle", json!({"subpath": 0, "knot": 0, "handle": "up", "to": [1, 1]})),
            ("path.moveHandle", json!({"subpath": 0, "knot": 0, "handle": "in"})),
            ("path.moveHandle", json!({"subpath": -1, "knot": 0, "handle": "in", "to": [1, 1]})),
            ("path.bendSegment", json!({"subpath": 0, "knot": 0, "t": 2, "move": [1, 1]})),
            ("path.bendSegment", json!({"subpath": 5, "knot": 0, "move": [1, 1]})),
            ("path.convertPoint", json!({"subpath": 0, "knot": 4})),
            ("path.convertPoint", json!({"subpath": 0, "knot": 0, "out": "x"})),
            ("path.convertPoint", json!({"name": "nope", "subpath": 0, "knot": 0})),
            ("path.convertPoint", json!({"name": "layer", "subpath": 0, "knot": 0})),
        ] {
            assert!(s.execute(id, p.clone()).is_err(), "{id} {p}");
        }
        assert_eq!(s.active().unwrap().history.entries().len(), steps);
    }
}
