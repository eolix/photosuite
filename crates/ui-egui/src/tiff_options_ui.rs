//! TIFF Options: the prompt File › Save As shows before writing a layered TIFF, as Photoshop
//! does when "Ask Before Saving Layered TIFF Files" is on in Preferences › File Handling.
//!
//! The save is parked in [`Prompt`] while the modal is up (egui is immediate-mode) and written
//! once answered: with the layers (Photoshop layer data in the file), or flattened ("Discard
//! Layers and Save a Copy"). "Don't show again" clears the preference. Cancel drops the save.

use crate::{ExportSettings, PhotosuiteApp};

/// A save waiting on the TIFF Options answer.
pub struct Prompt {
    /// Where the document goes.
    pub path: String,
    /// "Discard Layers and Save a Copy".
    pub discard_layers: bool,
    /// Clears `ask_before_saving_layered_tiff` when the save goes ahead.
    pub dont_ask_again: bool,
}

/// `true` when `path` is a TIFF name (`.tif` / `.tiff`).
pub fn is_tiff_path(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && (ext.eq_ignore_ascii_case("tif") || ext.eq_ignore_ascii_case("tiff")))
}

/// Whether saving the active document to `path` should go through the prompt: a TIFF that
/// would carry layer data, with the preference on.
pub fn wants_prompt(app: &PhotosuiteApp, path: &str) -> bool {
    if !is_tiff_path(path) || !app.session.prefs().file_handling.ask_before_saving_layered_tiff {
        return false;
    }
    app.session.active().is_some_and(|st| photosuite_io::tiff_layers::would_write_layers(&st.doc))
}

/// Parks the save behind the prompt.
pub fn park(app: &mut PhotosuiteApp, path: String) {
    app.tiff_options = Some(Prompt { path, discard_layers: false, dont_ask_again: false });
}

pub fn show(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let Some(p) = &mut app.tiff_options else { return };
    let (mut ok, mut cancel) = (false, false);
    let (mut discard, mut dont_ask) = (p.discard_layers, p.dont_ask_again);
    // PhotoSuite's dialog frame: the same title bar, drag and placement as every other dialog.
    let id = egui::Id::new("tiff-options");
    let modal = crate::dialogs::frame(ctx, id, tl!("TIFF Options"), crate::dialogs::FrameSize::Width(380.0, 420.0), |ui, _| {
        ui.label(tl!("Including layers will increase file size."));
        ui.add_space(8.0);
        crate::widgets::checkbox(ui, &mut discard, tl!("Discard Layers and Save a Copy"));
        crate::widgets::checkbox(ui, &mut dont_ask, tl!("Don't show again"));
        ui.add_space(8.0);
        // Align::Min, as the other dialogs: a centred row keeps last frame's height.
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            ok = crate::widgets::primary_button(ui, tl!("OK"), 84.0).clicked();
            cancel = crate::widgets::secondary_button(ui, tl!("Cancel"), 84.0).clicked();
        });
    });
    cancel |= modal.should_close();
    p.discard_layers = discard;
    p.dont_ask_again = dont_ask;
    if ok || ctx.input(|i| i.key_pressed(egui::Key::Enter)) {
        let Some(p) = app.tiff_options.take() else { return };
        if p.dont_ask_again {
            app.session.edit_prefs(|prefs| prefs.file_handling.ask_before_saving_layered_tiff = false);
        }
        let settings = ExportSettings { tiff_layers: !p.discard_layers, ..Default::default() };
        if let Err(e) = app.write_document(p.path.clone(), &settings) {
            app.ui.status = crate::i18n::fmt(tl!("Save failed: {error}"), &[("error", &e)]);
            app.ui.status_error = true;
        }
    } else if cancel {
        app.tiff_options = None;
        app.ui.status = tl!("Save cancelled").into();
        app.ui.status_error = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiff_names() {
        assert!(is_tiff_path("a.tif"));
        assert!(is_tiff_path("dir/sub/a.TIFF"));
        assert!(is_tiff_path("C:\\x\\y.tiff"));
        assert!(!is_tiff_path("a.tif.psd"));
        assert!(!is_tiff_path(".tif"));
        assert!(!is_tiff_path("tif"));
        assert!(!is_tiff_path("a.png"));
    }
}
