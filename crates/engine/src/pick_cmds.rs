//! Move tool Auto-Select: pick the topmost visible layer with pixels at a canvas point (Photoshop's
//! options bar "Auto-Select: Layer | Group", ⌘-click with the Move tool, and the canvas right-click
//! layer list).

use photosuite_doc::{Document, LayerContent, LayerId};
use photosuite_geom::Rect;
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::{EngineError, Result, Session};

fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document".into())
}

/// Layers with visible pixels at (x, y), topmost first (hidden layers and hidden groups skipped).
pub fn layers_at(doc: &Document, x: i32, y: i32) -> Vec<LayerId> {
    let rows = doc.walk();
    let mut out = Vec::new();
    for (path, _, l) in rows.iter().rev() {
        // The layer and every enclosing group must be visible.
        if !(1..=path.len()).all(|n| doc.layer_at(&path[..n]).is_some_and(|a| a.visible)) {
            continue;
        }
        if matches!(l.content, LayerContent::Group(_) | LayerContent::Adjustment(_)) {
            continue;
        }
        let alpha = match &l.content {
            // Fill layers cover the canvas (their mask limits them).
            LayerContent::Fill(_) => 1.0,
            _ => match l.surface() {
                Some(s) => {
                    let mut px = [[0.0f32; 4]; 1];
                    s.read_rgba_into(Rect::from_xywh(x, y, 1, 1), &mut px);
                    px[0][3]
                }
                None => 0.0,
            },
        };
        let mask = l.mask.as_ref().filter(|m| m.enabled).map_or(1.0, |m| {
            let mut v = [0.0f32];
            m.surface.read_pixel(x, y, &mut v);
            v[0]
        });
        if alpha * mask > 0.0 {
            out.push(l.id);
        }
    }
    out
}

/// The outermost group containing `id` (the layer itself when it isn't in a group).
fn top_group(doc: &Document, id: LayerId) -> LayerId {
    doc.walk().iter().find(|(_, _, l)| l.id == id).and_then(|(path, _, _)| doc.layer_at(&path[..1])).map_or(id, |l| l.id)
}

fn pick(s: &mut Session, p: &Value) -> Result<Value> {
    let x = p.get("x").and_then(Value::as_f64).ok_or_else(|| EngineError::BadParams { cmd: "layer.pickAt".into(), msg: "missing `x`".into() })?.floor() as i32;
    let y = p.get("y").and_then(Value::as_f64).ok_or_else(|| EngineError::BadParams { cmd: "layer.pickAt".into(), msg: "missing `y`".into() })?.floor() as i32;
    let doc = s.active().ok_or(EngineError::NoDocument)?.doc.clone();
    let hits = layers_at(&doc, x, y);
    if p.get("list").and_then(Value::as_bool).unwrap_or(false) {
        let names: Vec<Value> = hits.iter().filter_map(|id| doc.layer(*id)).map(|l| json!({"layer": l.id.0, "name": l.name})).collect();
        return Ok(json!({ "layers": names }));
    }
    let Some(&hit) = hits.first() else { return Ok(json!({ "layer": null })) };
    let target = if p.get("target").and_then(Value::as_str) == Some("group") { top_group(&doc, hit) } else { hit };
    if p.get("select").and_then(Value::as_bool).unwrap_or(true) {
        let mode = p.get("mode").and_then(Value::as_str).unwrap_or("replace");
        s.execute("layer.select", json!({"layer": target.0, "mode": mode}))?;
    }
    Ok(json!({ "layer": target.0 }))
}

pub fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: "layer.pickAt",
        label: "Auto-Select Layer",
        menu: &[],
        shortcut: None,
        params: r##"{"x":px,"y":px,"target":"layer|group"="layer","select":bool=true,"mode":"replace|toggle|add"="replace","list":bool=false (return every layer with pixels there, topmost first)} → {layer} | {layers}"##,
        enabled: has_doc,
        journal: false,
        run: pick,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_topmost_layer_with_pixels() {
        let mut s = Session::new();
        s.execute("file.new", json!({"width": 40, "height": 40})).unwrap();
        let bg = s.active().unwrap().doc.layers[0].id;
        s.execute("layer.new.layer", json!({"name": "A"})).unwrap();
        s.execute("select.rect", json!({"x": 0, "y": 0, "width": 10, "height": 10})).unwrap();
        s.execute("edit.fill", json!({"color": "#ff0000"})).unwrap();
        let a = s.active().unwrap().active_layer.unwrap();
        s.execute("layer.new.layer", json!({"name": "B"})).unwrap();
        s.execute("select.deselect", json!({})).unwrap();
        // Empty B is skipped; A wins inside its square, the Background elsewhere.
        assert_eq!(s.execute("layer.pickAt", json!({"x": 5, "y": 5})).unwrap()["layer"], a.0);
        assert_eq!(s.active().unwrap().active_layer, Some(a));
        assert_eq!(s.execute("layer.pickAt", json!({"x": 30, "y": 30, "select": false})).unwrap()["layer"], bg.0);
        let list = s.execute("layer.pickAt", json!({"x": 5, "y": 5, "list": true})).unwrap();
        assert_eq!(list["layers"].as_array().unwrap().len(), 2);
        // Hidden layers are ignored.
        s.execute("layer.setProps", json!({"layer": a.0, "visible": false})).unwrap();
        assert_eq!(s.execute("layer.pickAt", json!({"x": 5, "y": 5, "select": false})).unwrap()["layer"], bg.0);
    }
}
