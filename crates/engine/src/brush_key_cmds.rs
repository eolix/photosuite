//! Photoshop's brush keys (#626): `[` / `]` step the brush size and ⇧[ / ⇧] the hardness. Photoshop
//! has no menu item for them but lists them in Edit › Keyboard Shortcuts › Tools ("Decrease Brush
//! Size"…); here they are ordinary commands with default shortcuts, so they can be rebound,
//! recorded and driven by agents. Each one is a `tools.setBrush` on the session brush.

use serde_json::{Value, json};

use crate::commands::{CommandSpec, always};
use crate::{Result, Session};

/// Photoshop's largest brush diameter, in pixels.
pub const MAX_SIZE: f32 = 5000.0;

/// `[` / `]`: 25 % smaller or larger, at least a pixel larger so small brushes still grow.
fn size_step(size: f32, up: bool) -> f32 {
    let next = if up { (size * 1.25).round().max(size + 1.0) } else { (size / 1.25).round() };
    next.clamp(1.0, MAX_SIZE)
}

/// ⇧[ / ⇧]: to the previous or next quarter (0, 25, 50, 75, 100 %).
fn hardness_step(hardness: f32, up: bool) -> f32 {
    let quarter = (hardness * 4.0).round();
    let next = if up { quarter + 1.0 } else { quarter - 1.0 };
    next.clamp(0.0, 4.0) / 4.0
}

fn size(s: &mut Session, up: bool) -> Result<Value> {
    let size = size_step(s.tools.brush.size, up);
    crate::brush_cmds::set_brush(s, &json!({ "brush": { "size": size } }))
}

fn hardness(s: &mut Session, up: bool) -> Result<Value> {
    let hardness = hardness_step(s.tools.brush.hardness, up);
    crate::brush_cmds::set_brush(s, &json!({ "brush": { "hardness": hardness } }))
}

macro_rules! key_cmd {
    ($id:literal, $label:literal, $sc:literal, $run:expr) => {
        CommandSpec { id: $id, label: $label, menu: &[], shortcut: Some($sc), params: "{}", enabled: always, run: $run, journal: true }
    };
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        key_cmd!("tools.decreaseBrushSize", "Decrease Brush Size", "[", |s, _| size(s, false)),
        key_cmd!("tools.increaseBrushSize", "Increase Brush Size", "]", |s, _| size(s, true)),
        key_cmd!("tools.decreaseBrushHardness", "Decrease Brush Hardness", "Shift+[", |s, _| hardness(s, false)),
        key_cmd!("tools.increaseBrushHardness", "Increase Brush Hardness", "Shift+]", |s, _| hardness(s, true)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_like_photoshop() {
        assert_eq!(size_step(1.0, false), 1.0, "never below 1 px");
        assert_eq!(size_step(1.0, true), 2.0, "small brushes still grow");
        assert_eq!(size_step(100.0, true), 125.0);
        assert_eq!(size_step(125.0, false), 100.0);
        assert_eq!(size_step(MAX_SIZE, true), MAX_SIZE, "never past the largest brush");
        assert_eq!(hardness_step(0.5, true), 0.75);
        assert_eq!(hardness_step(0.6, false), 0.25, "snaps to the quarter below the nearest");
        assert_eq!(hardness_step(1.0, true), 1.0);
        assert_eq!(hardness_step(0.0, false), 0.0);
    }

    #[test]
    fn commands_step_the_session_brush_and_journal() {
        let mut s = Session::new();
        s.execute("tools.setBrush", json!({"brush": {"size": 40, "hardness": 0.5}})).unwrap();
        s.execute("tools.increaseBrushSize", json!({})).unwrap();
        assert_eq!(s.tools.brush.size, 50.0);
        s.execute("tools.decreaseBrushSize", Value::Null).unwrap();
        assert_eq!(s.tools.brush.size, 40.0);
        s.execute("tools.increaseBrushHardness", json!({})).unwrap();
        assert_eq!(s.tools.brush.hardness, 0.75);
        s.execute("tools.decreaseBrushHardness", json!({"junk": [1, 2]})).unwrap();
        assert_eq!(s.tools.brush.hardness, 0.5);
        assert_eq!(s.journal.last().map(|(id, _)| id.as_str()), Some("tools.decreaseBrushHardness"));
        // They need no document and are bindable under Tools.
        let sc = |id| crate::commands::find(id).and_then(|c| c.shortcut);
        assert_eq!(sc("tools.decreaseBrushSize"), Some("["));
        assert_eq!(sc("tools.increaseBrushHardness"), Some("Shift+]"));
    }
}
