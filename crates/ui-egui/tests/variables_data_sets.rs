use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use photosuite_ui_egui::PhotosuiteApp;
use photosuite_ui_egui::state::DialogKind;
use serde_json::{Map, json};

fn app_with_variables_dialog(cur: u64) -> PhotosuiteApp {
    let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), photosuite_ui_egui::Services::default());
    app.run("file.new", json!({"width": 64, "height": 64})).unwrap();
    app.run("layer.new.layer", json!({})).unwrap();
    let state = json!({
        "defs": [{
            "name": "v1",
            "layer": 0,
            "type": "visibility",
            "method": "fit",
            "align": "center",
            "clip": false
        }],
        "dataSets": [{"name": "A", "values": []}]
    });
    let mut fields = Map::new();
    fields.insert("__variables".into(), state);
    fields.insert("__page".into(), json!("dataSets"));
    fields.insert("__cur".into(), json!(cur));
    app.ui.open_dialog(DialogKind::Command, fields);
    app
}

fn harness(app: PhotosuiteApp) -> Harness<'static, PhotosuiteApp> {
    let mut h = Harness::builder().with_size(egui::vec2(900.0, 700.0)).build_ui_state(
        |ui, app: &mut PhotosuiteApp| {
            let ctx = ui.ctx().clone();
            if !ctx.fonts(|f| f.families().contains(&egui::FontFamily::Name("medium".into()))) {
                return;
            }
            photosuite_ui_egui::dialogs::show(app, &ctx);
        },
        app,
    );
    PhotosuiteApp::setup_context(&h.ctx, photosuite_ui_egui::theme::ThemeKind::ALL[0]);
    h.run_steps(3);
    h
}

#[test]
fn out_of_range_data_set_index_does_not_overflow_during_render() {
    let mut h = harness(app_with_variables_dialog(u64::MAX));
    h.run_steps(2);
}

#[test]
fn out_of_range_data_set_index_is_clamped_before_delete() {
    let mut h = harness(app_with_variables_dialog(999));
    h.get_by_label("Delete").click();
    h.run_steps(2);
}
