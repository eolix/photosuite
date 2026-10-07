//! Actions panel: record and replay command sequences.
//!
//! The list and the recording flag live on the engine session (`actions.record` / `stop` /
//! `play` / `list` / `get` / `delete`), so the panel, the CLI and MCP share them. This module
//! keeps only which row is selected and which rows are expanded.

use egui::{Align2, Color32, Rect, Sense, Stroke, pos2, vec2};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use photosuite_engine::actions_cmds::{self, Action};

use crate::PhotosuiteApp;
use crate::theme::Tokens;

/// Which row is selected and which rows are expanded. The action list itself is
/// [`photosuite_engine::Session::actions`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ActionsUi {
    pub selected: Option<usize>,
    pub expanded: Vec<bool>,
}

fn label_of(id: &str) -> String {
    photosuite_engine::commands::find(id).map(|c| c.label.trim_end_matches('…').to_string()).unwrap_or_else(|| id.to_string())
}

/// The selected action, or the first one when nothing is selected.
pub fn selected_action(app: &PhotosuiteApp) -> Option<&Action> {
    let list = &app.session.actions.list;
    let idx = app.ui.actions.selected.filter(|i| *i < list.len());
    idx.and_then(|i| list.get(i)).or_else(|| list.first())
}

/// Steps in the `[[id, params], …]` shape batch and droplets already accept.
pub fn action_steps(action: &Action) -> Vec<Value> {
    action.steps.iter().map(|(id, p)| json!([id, p])).collect()
}

fn begin_recording(app: &mut PhotosuiteApp) {
    if app.session.actions.recording.is_some() {
        return;
    }
    let Ok(v) = app.run("actions.record", json!({})) else { return };
    let Some(i) = v.get("index").and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()) else { return };
    app.ui.actions.selected = Some(i);
    if app.ui.actions.expanded.len() <= i {
        app.ui.actions.expanded.resize(i + 1, false);
    }
    app.ui.actions.expanded[i] = true;
}

fn report_play(app: &mut PhotosuiteApp, v: &Value) {
    let Some(failed) = v.get("failed").filter(|f| f.is_object()) else {
        let ran = v.get("ran").and_then(Value::as_u64).unwrap_or(0);
        app.ui.status = format!("Played {ran} steps");
        return;
    };
    let step = failed.get("step").and_then(Value::as_u64).unwrap_or(0);
    let id = failed.get("id").and_then(Value::as_str).unwrap_or("");
    let error = failed.get("error").and_then(Value::as_str).unwrap_or("");
    app.ui.status = format!("Step {} ({id}) failed: {error}", step + 1);
    app.ui.status_error = true;
}

pub fn panel(app: &mut PhotosuiteApp, ui: &mut egui::Ui) {
    let t = Tokens::get(ui.ctx());
    let recording = app.session.actions.recording;
    let live = recording.map(|(from, _)| app.session.journal.iter().skip(from).filter(|(id, _)| actions_cmds::replayable(id)).count()).unwrap_or(0);
    let rows: Vec<(String, Vec<String>)> =
        app.session.actions.list.iter().map(|a| (a.name.clone(), a.steps.iter().map(|(id, _)| id.clone()).collect())).collect();
    if app.ui.actions.selected.is_some_and(|i| i >= rows.len()) {
        app.ui.actions.selected = None;
    }
    if app.ui.actions.expanded.len() > rows.len() {
        app.ui.actions.expanded.truncate(rows.len());
    }
    let max_h = (ui.available_height() - 70.0).clamp(80.0, 320.0);
    let mut play_idx = None;
    egui::ScrollArea::vertical().id_salt("actions-rows").max_height(max_h).auto_shrink([false, true]).show(ui, |ui| {
        if rows.is_empty() {
            ui.label(egui::RichText::new(tl!("Record ● a sequence of edits, then play ▶ it on any document.")).color(t.text_faint).size(11.5));
        }
        for (i, (name, steps)) in rows.iter().enumerate() {
            let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 26.0), Sense::click());
            let sel = app.ui.actions.selected == Some(i);
            if sel {
                ui.painter().rect_filled(rect, 0.0, t.row_selected);
            } else if resp.hovered() {
                ui.painter().rect_filled(rect, 0.0, t.hover.gamma_multiply(0.5));
            }
            let expanded = app.ui.actions.expanded.get(i).copied().unwrap_or(false);
            let tri = Rect::from_center_size(pos2(rect.left() + 12.0, rect.center().y), vec2(8.0, 8.0));
            let pts =
                if expanded { vec![tri.left_top(), tri.right_top(), tri.center_bottom()] } else { vec![tri.left_top(), tri.right_center(), tri.left_bottom()] };
            ui.painter().add(egui::Shape::convex_polygon(pts, t.text_dim, Stroke::NONE));
            crate::icons::paint(ui, Rect::from_center_size(pos2(rect.left() + 30.0, rect.center().y), vec2(16.0, 16.0)), "play", 11.0, t.icon);
            let recording_this = recording.is_some_and(|(_, r)| r == i);
            let nsteps = steps.len() + if recording_this { live } else { 0 };
            ui.painter().text(pos2(rect.left() + 44.0, rect.center().y), Align2::LEFT_CENTER, name, egui::FontId::proportional(12.0), t.text);
            ui.painter().text(
                pos2(rect.right() - 8.0, rect.center().y),
                Align2::RIGHT_CENTER,
                format!("{nsteps} steps"),
                egui::FontId::proportional(11.0),
                t.text_faint,
            );
            if recording_this {
                ui.painter().circle_filled(pos2(rect.right() - 64.0, rect.center().y), 4.0, Color32::from_rgb(230, 60, 60));
            }
            if resp.clicked() {
                app.ui.actions.selected = Some(i);
                if resp.interact_pointer_pos().is_some_and(|p| p.x < rect.left() + 20.0) {
                    if app.ui.actions.expanded.len() <= i {
                        app.ui.actions.expanded.resize(i + 1, false);
                    }
                    app.ui.actions.expanded[i] = !expanded;
                }
            }
            if resp.double_clicked() {
                play_idx = Some(i);
            }
            if expanded {
                for id in steps {
                    let (r, _) = ui.allocate_exact_size(vec2(ui.available_width(), 20.0), Sense::hover());
                    ui.painter().text(pos2(r.left() + 44.0, r.center().y), Align2::LEFT_CENTER, label_of(id), egui::FontId::proportional(11.5), t.text_dim);
                }
            }
        }
    });
    ui.add_space(4.0);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 2.0;
        let recording_now = app.session.actions.recording.is_some();
        if crate::icons::button(ui, "square", 24.0, false, tl!("Stop playing/recording")).clicked() && recording_now {
            let _ = app.run("actions.stop", json!({}));
        }
        let (r, rec) = ui.allocate_exact_size(vec2(24.0, 24.0), Sense::click());
        if rec.hovered() {
            ui.painter().rect_filled(r, 3.0, t.hover);
        }
        ui.painter().circle_filled(r.center(), 5.5, if recording_now { Color32::from_rgb(230, 60, 60) } else { t.icon });
        if rec.on_hover_text(tl!("Begin recording")).clicked() && !recording_now {
            begin_recording(app);
        }
        if crate::icons::button(ui, "play", 24.0, false, tl!("Play selection")).clicked() {
            play_idx = app.ui.actions.selected;
        }
        if crate::icons::button(ui, "plus", 24.0, false, tl!("Create new action")).clicked() && !recording_now {
            begin_recording(app);
        }
        if crate::icons::button(ui, "trash", 24.0, false, tl!("Delete")).clicked()
            && !recording_now
            && let Some(i) = app.ui.actions.selected
            && app.run("actions.delete", json!({"action": i})).is_ok()
        {
            if i < app.ui.actions.expanded.len() {
                app.ui.actions.expanded.remove(i);
            }
            app.ui.actions.selected = None;
        }
    });
    if let Some(i) = play_idx
        && let Ok(v) = app.run("actions.play", json!({"action": i}))
    {
        report_play(app, &v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_replay_on_another_document() {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        app.run("file.new", json!({"width": 40, "height": 40})).unwrap();
        app.sync_views();
        app.run("actions.record", json!({})).unwrap();
        app.run("layer.new.layer", json!({})).unwrap();
        app.run("select.rect", json!({"x": 0, "y": 0, "width": 10, "height": 10})).unwrap();
        app.run("edit.fill", json!({"color": "#ff0000"})).unwrap();
        let _ = app.run("document.pixel", json!({"x": 1, "y": 1}));
        app.run("actions.stop", json!({})).unwrap();
        let a = &app.session.actions.list[0];
        assert_eq!(a.steps.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), ["layer.new.layer", "select.rect", "edit.fill"]);
        app.run("file.new", json!({"width": 40, "height": 40})).unwrap();
        app.sync_views();
        let played = app.run("actions.play", json!({"action": 0})).unwrap();
        assert_eq!(played["ran"], 3);
        assert!(played.get("failed").is_none(), "{played}");
        let d = &app.session.active().unwrap().doc;
        assert_eq!(d.layers.len(), 2);
        assert_eq!(d.layers[1].surface().unwrap().pixel(5, 5), vec![1.0, 0.0, 0.0, 1.0]);
    }
}
