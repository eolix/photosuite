//! One lasso outline can alternate between freehand strokes and Alt-held straight segments.
//! Selection intent is latched at the first press; Alt pressed later changes drawing mode.

use crate::{
    PhotosuiteApp,
    canvas::{Drag, ToolEvent, ViewXform},
    state::Tool,
};
use egui::{Event, Modifiers, PointerButton};

#[derive(Clone, Debug)]
pub struct Lasso {
    pub cursor: [f64; 2],
    down: bool,
    polygonal: bool,
    document: Option<photosuite_doc::DocId>,
}

pub fn active(app: &PhotosuiteApp) -> bool {
    app.drag.as_ref().is_some_and(|d| d.tool == Tool::Lasso && d.lasso.is_some())
}

/// A lasso drag that moves the selection (started inside it, `canvas::selection_drag_kind`):
/// the canvas's own selection-move path handles it, this module only feeds it the events.
fn moving_selection(app: &PhotosuiteApp) -> bool {
    app.drag.as_ref().is_some_and(|d| d.tool == Tool::Lasso && d.sel_move.is_some())
}

pub fn cancel_stale(app: &mut PhotosuiteApp) {
    if app
        .drag
        .as_ref()
        .and_then(|d| d.lasso.as_ref())
        .is_some_and(|lasso| app.ui.tool != Tool::Lasso || lasso.document != app.session.active().map(|st| st.doc.id))
    {
        app.drag = None;
    }
}

fn append(d: &mut Drag, p: [f64; 2]) {
    if d.points.last().is_none_or(|last| last[0] != p[0] || last[1] != p[1]) {
        d.points.push([p[0], p[1], 1.0]);
    }
}

fn modifiers(app: &mut PhotosuiteApp, mods: Modifiers) {
    let Some(d) = app.drag.as_mut().filter(|d| d.tool == Tool::Lasso) else { return };
    d.track(mods);
    // Alt held before the initial press still means subtract, until released and pressed again.
    let polygonal = mods.alt && (!d.modifiers.alt || d.released.alt);
    if let Some(lasso) = &d.lasso {
        let anchor = (lasso.polygonal && !polygonal && lasso.down).then_some(lasso.cursor);
        if let Some(p) = anchor {
            append(d, p);
        }
    }
    if let Some(lasso) = &mut d.lasso {
        lasso.polygonal = polygonal;
    }
}

pub fn commit(app: &mut PhotosuiteApp) {
    cancel_stale(app);
    if active(app)
        && let Some(d) = app.drag.take()
    {
        crate::canvas::finish_gesture(app, d);
    }
}

pub fn pointer(app: &mut PhotosuiteApp, ev: ToolEvent, mods: Modifiers) -> bool {
    cancel_stale(app);
    if app.ui.tool != Tool::Lasso || moving_selection(app) {
        return false;
    }
    let p = match ev {
        ToolEvent::Down { x, y, .. } | ToolEvent::Move { x, y, .. } | ToolEvent::Up { x, y } => [x, y],
    };
    // A press inside the selection (no outline in progress) drags the selection instead.
    if matches!(ev, ToolEvent::Down { .. })
        && !active(app)
        && p.iter().all(|n| n.is_finite())
        && crate::canvas::selection_drag_kind(app, Tool::Lasso, p, mods).is_some()
    {
        return false;
    }
    if !p.iter().all(|n| n.is_finite()) {
        return true;
    }
    modifiers(app, mods);
    match ev {
        ToolEvent::Down { .. } => {
            if active(app) {
                let close = app
                    .drag
                    .as_ref()
                    .is_some_and(|d| d.points.len() >= 3 && (d.start[0] - p[0]).hypot(d.start[1] - p[1]) < 8.0 / app.current_zoom().max(0.01) as f64);
                if close {
                    commit(app);
                    return true;
                }
                if let Some(d) = &mut app.drag {
                    append(d, p);
                    if let Some(lasso) = &mut d.lasso {
                        lasso.cursor = p;
                        lasso.down = true;
                    }
                }
            } else {
                let mut d = Drag::new(Tool::Lasso, p, vec![[p[0], p[1], 1.0]], mods, false);
                d.lasso = Some(Lasso { cursor: p, down: true, polygonal: false, document: app.session.active().map(|st| st.doc.id) });
                app.drag = Some(d);
            }
        }
        ToolEvent::Move { .. } | ToolEvent::Up { .. } => {
            let up = matches!(ev, ToolEvent::Up { .. });
            let Some(d) = app.drag.as_mut().filter(|d| d.tool == Tool::Lasso) else { return true };
            let Some(lasso) = &d.lasso else { return true };
            let (down, polygonal, previous) = (lasso.down, lasso.polygonal, lasso.cursor);
            if d.reposition {
                // Move relative to the rubber-band endpoint, not the last fixed vertex.
                let last = d.points.last().map_or(d.start, |p| [p[0], p[1]]);
                d.shift_to([last[0] + p[0] - previous[0], last[1] + p[1] - previous[1]]);
            } else if down && (!polygonal || up) {
                append(d, p);
            }
            if let Some(lasso) = &mut d.lasso {
                lasso.cursor = p;
                if up {
                    lasso.down = false;
                }
            }
            if up && down && !polygonal {
                commit(app);
            }
        }
    }
    true
}

/// Read actual presses/releases, including clicks below egui's drag threshold. Hover moves
/// update only the rubber band; they must never become freehand vertices between Alt clicks.
pub fn canvas_input(app: &mut PhotosuiteApp, ctx: &egui::Context, xf: &ViewXform, response: &egui::Response) {
    let events = ctx.input(|i| i.events.clone());
    let mut mods = app.drag.as_ref().map_or(ctx.input(|i| i.modifiers), |d| d.live);
    for ev in events {
        let tool_ev = match ev {
            Event::ModifiersChanged(m) => {
                mods = m;
                modifiers(app, crate::workspace_ui::sticky_mods(app, m));
                None
            }
            Event::PointerButton { pos, button: PointerButton::Primary, pressed, modifiers: m } => {
                mods = m;
                let p = xf.to_doc(pos);
                if pressed && response.contains_pointer() && response.rect.contains(pos) {
                    Some(ToolEvent::Down { x: p[0], y: p[1], pressure: 1.0 })
                } else if !pressed && (active(app) || moving_selection(app)) {
                    Some(ToolEvent::Up { x: p[0], y: p[1] })
                } else {
                    None
                }
            }
            Event::PointerMoved(pos) if active(app) || moving_selection(app) => {
                let p = xf.to_doc(pos);
                Some(ToolEvent::Move { x: p[0], y: p[1], pressure: 1.0 })
            }
            Event::WindowFocused(false) => {
                if active(app) || moving_selection(app) {
                    app.drag = None;
                }
                None
            }
            _ => None,
        };
        if let Some(ev) = tool_ev {
            crate::canvas::tool_event(app, ev, mods);
        }
    }
    if response.double_clicked() {
        commit(app);
    }
}

#[cfg(test)]
mod tests;
