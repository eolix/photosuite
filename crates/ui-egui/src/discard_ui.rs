//! Save / Don't Save / Cancel prompt for actions that would throw away unsaved changes: closing
//! documents, Revert, and leaving the app (File › Exit or the window's close button).
//!
//! egui is immediate-mode, so the action is parked in [`Prompt`] while the modal is up and re-run
//! once every affected document has been answered. Cancel at any point drops it. Documents are
//! tracked by id, not tab index, so closing one elsewhere while the prompt is up can't retarget it.

use egui::Key;
use photosuite_doc::DocId;
use serde_json::{Value, json};

use crate::PhotosuiteApp;
use crate::widgets::{ButtonRole, DialogButton};

const EXIT: &str = "file.exit";

/// An action waiting on the user, and the dirty documents still to ask about.
pub struct Prompt {
    id: String,
    params: Value,
    /// The document the command was aimed at (`document` param, else the active one), if it has one.
    target: Option<DocId>,
    docs: Vec<DocId>,
}

fn index_of(app: &PhotosuiteApp, id: DocId) -> Option<usize> {
    app.session.documents().iter().position(|d| d.doc.id == id)
}

/// Which documents a command discards, relative to its target (the `document` param, else the active one).
#[derive(Clone, Copy)]
enum Reach {
    Target,
    AllButTarget,
    All,
}

/// Every command that can throw away unsaved changes. A new one only needs a row here.
const DISCARDING: &[(&str, Reach)] = &[
    ("file.close", Reach::Target),
    ("file.revert", Reach::Target),
    ("file.closeOthers", Reach::AllButTarget),
    ("file.closeAll", Reach::All),
    (EXIT, Reach::All),
];

/// The command's target document and the unsaved documents it would discard (empty for commands
/// that discard nothing).
fn discarded(app: &PhotosuiteApp, id: &str, params: &Value) -> (Option<DocId>, Vec<DocId>) {
    let docs = app.session.documents();
    let target = params.get("document").and_then(Value::as_u64).map(|i| i as usize).or(app.session.active_index());
    let affected: Vec<usize> = match DISCARDING.iter().find(|(c, _)| *c == id) {
        Some((_, Reach::Target)) => target.into_iter().collect(),
        Some((_, Reach::AllButTarget)) => (0..docs.len()).filter(|&i| Some(i) != target).collect(),
        Some((_, Reach::All)) => (0..docs.len()).collect(),
        None => Vec::new(),
    };
    let dirty = affected.into_iter().filter_map(|i| docs.get(i)).filter(|d| d.is_dirty()).map(|d| d.doc.id).collect();
    (target.and_then(|i| docs.get(i)).map(|d| d.doc.id), dirty)
}

/// Park `id` behind a prompt if it would discard unsaved work. Returns whether it did.
pub fn intercept(app: &mut PhotosuiteApp, id: &str, params: &Value) -> bool {
    let (target, docs) = discarded(app, id, params);
    if docs.is_empty() {
        return false;
    }
    let prompt = Prompt { id: id.to_string(), params: params.clone(), target, docs };
    match &app.discard {
        None => app.discard = Some(prompt),
        // Quitting overrides whatever is pending: it covers every document, so nothing is lost.
        Some(open) if id == EXIT && open.id != EXIT => app.discard = Some(prompt),
        // Repeated quit requests (the X pressed again) keep the prompt, and the answers so far.
        Some(open) if open.id == id => {}
        Some(_) => {
            app.ui.status = tl!("Answer the unsaved-changes prompt first").into();
            app.ui.status_error = true;
        }
    }
    true
}

/// Called once per frame: holds back a window close request while there is unsaved work.
pub fn guard_window_close(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    if app.allow_close || !ctx.input(|i| i.viewport().close_requested()) {
        return;
    }
    if intercept(app, EXIT, &Value::Null) {
        ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
    }
}

/// Moves on to the next document, or runs the parked action once none are left.
fn advance(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let Some(p) = app.discard.as_mut() else { return };
    if !p.docs.is_empty() {
        p.docs.remove(0);
    }
    if !p.docs.is_empty() {
        return;
    }
    let Some(Prompt { id, mut params, target, .. }) = app.discard.take() else { return };
    if id == EXIT {
        app.allow_close = true;
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        return;
    }
    if let Some(target) = target {
        // The tab may have moved since the command was issued; aim it at the same document.
        let Some(i) = index_of(app, target) else { return };
        params = json!({"document": i});
    }
    if let Err(e) = crate::menus::invoke_unguarded(app, ctx, &id, params) {
        app.ui.status = e;
        app.ui.status_error = true;
    }
}

/// Saves `doc` in place; false when it is gone, the save failed or its file dialog was cancelled.
fn save(app: &mut PhotosuiteApp, doc: DocId) -> bool {
    let Some(i) = index_of(app, doc) else { return false };
    app.session.set_active(i);
    // Not File › Save: on a document that can't save in place that opens the Save As screen and
    // returns at once, and the close would go ahead unsaved.
    match crate::menus::save_or_pick(app) {
        Ok(_) => true,
        // Backing out of the file dialog is the user's choice, not an error.
        Err(e) if e == "cancelled" => false,
        Err(e) => {
            app.ui.status = format!("Couldn't save: {e}");
            app.ui.status_error = true;
            false
        }
    }
}

pub fn show(app: &mut PhotosuiteApp, ctx: &egui::Context) {
    let Some(p) = &app.discard else { return };
    let Some(&doc) = p.docs.first() else { return };
    let (exits, reverts) = (p.id == EXIT, p.id == "file.revert");
    let Some(name) = index_of(app, doc).map(|i| app.session.documents()[i].doc.name.clone()) else {
        // Closed by something else while the prompt was up: nothing left to ask about.
        advance(app, ctx);
        return;
    };
    let (title, message) = if reverts {
        ("Revert", crate::i18n::fmt(tl!("Revert “{name}” to the last saved version? Your changes will be lost."), &[("name", &name)]))
    } else {
        let template = if exits {
            tl!("Do you want to save the changes you made to “{name}” before quitting?")
        } else {
            tl!("Do you want to save the changes you made to “{name}” before closing?")
        };
        (tl!("Unsaved changes"), crate::i18n::fmt(template, &[("name", &name)]))
    };
    let mac = ctx.os() == egui::os::OperatingSystem::Mac;
    // The answers in the platform's words; `dialog_buttons` puts them in its order. Windows (and
    // Linux) ask Yes / No / Cancel with Y, N and Esc, as Photoshop does there; macOS asks
    // Don't Save / Cancel / Save. Esc always cancels (the modal closes on it).
    let cancel = (ButtonRole::Cancel, "Cancel", mac.then_some(Key::C), 84.0, Answer::Cancel);
    let buttons = if reverts {
        vec![(ButtonRole::Default, "Revert", Some(Key::R), 84.0, Answer::Discard), cancel]
    } else if mac {
        vec![
            (ButtonRole::Default, "Save", Some(Key::S), 84.0, Answer::Save),
            (ButtonRole::Alternate, "Don't Save", Some(Key::D), 100.0, Answer::Discard),
            cancel,
        ]
    } else {
        vec![(ButtonRole::Default, "Yes", Some(Key::Y), 84.0, Answer::Save), (ButtonRole::Alternate, "No", Some(Key::N), 84.0, Answer::Discard), cancel]
    };
    let mut answer = ctx.input_mut(|i| buttons.iter().find(|b| b.2.is_some_and(|k| i.consume_key(egui::Modifiers::NONE, k))).map(|b| b.4));
    let labels: Vec<String> = buttons.iter().map(|b| b.2.map_or_else(|| tl!(b.1).to_string(), |k| mnemonic(b.1, k))).collect();
    let row: Vec<DialogButton> = buttons.iter().zip(&labels).map(|(b, label)| DialogButton::new(b.0, label, b.3)).collect();
    let modal = egui::Modal::new(egui::Id::new("discard-prompt")).show(ctx, |ui| {
        ui.set_max_width(420.0);
        ui.label(egui::RichText::new(tl!(&title)).font(crate::theme::semibold(15.0)));
        ui.add_space(4.0);
        crate::widgets::hairline(ui);
        ui.add_space(8.0);
        ui.label(message);
        ui.add_space(12.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            if let Some(role) = crate::widgets::dialog_buttons(ui, &row) {
                answer = buttons.iter().find(|b| b.0 == role).map(|b| b.4);
            }
        });
    });
    if modal.should_close() {
        answer = Some(Answer::Cancel);
    }
    // Enter takes the default answer, unless Tab focused a button: that one took the Enter as a click.
    if answer.is_none() && ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::Enter)) {
        answer = buttons.iter().find(|b| b.0 == ButtonRole::Default).map(|b| b.4);
    }
    match answer {
        Some(Answer::Cancel) => app.discard = None,
        Some(Answer::Discard) => advance(app, ctx),
        Some(Answer::Save) if save(app, doc) => advance(app, ctx),
        _ => {}
    }
}

#[derive(Clone, Copy)]
enum Answer {
    Save,
    Discard,
    Cancel,
}

/// "(S)ave": the key in parentheses, or appended ("Guardar (S)") when the translation doesn't start with it.
fn mnemonic(label: &str, key: Key) -> String {
    let (label, k) = (tl!(label), key.name());
    match label.split_at_checked(1) {
        Some((first, rest)) if first.eq_ignore_ascii_case(k) => format!("({first}){rest}"),
        _ => format!("{label} ({k})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with_docs(n: usize) -> PhotosuiteApp {
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), crate::Services::default());
        for _ in 0..n {
            app.run("file.new", json!({"width": 8, "height": 8})).unwrap();
        }
        app.sync_views();
        app
    }

    fn make_dirty(app: &mut PhotosuiteApp, doc: usize) {
        app.session.set_active(doc);
        app.run("layer.new.layer", json!({})).unwrap();
    }

    fn doc_id(app: &PhotosuiteApp, i: usize) -> DocId {
        app.session.documents()[i].doc.id
    }

    #[test]
    fn clean_documents_close_without_asking() {
        let mut app = app_with_docs(2);
        let ctx = egui::Context::default();
        crate::menus::invoke(&mut app, &ctx, "file.close", json!({})).unwrap();
        assert!(app.discard.is_none());
        assert_eq!(app.session.documents().len(), 1);
    }

    #[test]
    fn closing_a_dirty_document_waits_for_an_answer() {
        let mut app = app_with_docs(2);
        let ctx = egui::Context::default();
        make_dirty(&mut app, 1);
        crate::menus::invoke(&mut app, &ctx, "file.close", json!({"document": 1})).unwrap();
        assert_eq!(app.session.documents().len(), 2, "nothing closes before the user answers");
        assert!(app.discard.is_some());
        advance(&mut app, &ctx);
        assert!(app.discard.is_none());
        assert_eq!(app.session.documents().len(), 1);
    }

    #[test]
    fn only_documents_that_would_be_discarded_are_asked_about() {
        let mut app = app_with_docs(3);
        make_dirty(&mut app, 0);
        make_dirty(&mut app, 2);
        let ids = [doc_id(&app, 0), doc_id(&app, 2)];
        assert_eq!(discarded(&app, "file.closeOthers", &json!({"document": 0})), (Some(ids[0]), vec![ids[1]]));
        assert_eq!(discarded(&app, "file.closeAll", &json!({})).1, ids);
        assert_eq!(discarded(&app, EXIT, &json!({})).1, ids);
        assert!(discarded(&app, "view.zoomIn", &json!({})).1.is_empty());
    }

    #[test]
    fn close_all_asks_per_dirty_document_then_runs() {
        let mut app = app_with_docs(3);
        let ctx = egui::Context::default();
        make_dirty(&mut app, 0);
        make_dirty(&mut app, 2);
        crate::menus::invoke(&mut app, &ctx, "file.closeAll", json!({})).unwrap();
        advance(&mut app, &ctx);
        assert_eq!(app.session.documents().len(), 3, "still waiting on the second document");
        advance(&mut app, &ctx);
        assert!(app.session.documents().is_empty());
    }

    #[test]
    fn the_parked_close_still_hits_its_document_after_tabs_move() {
        let mut app = app_with_docs(3);
        let ctx = egui::Context::default();
        make_dirty(&mut app, 2);
        let doomed = doc_id(&app, 2);
        crate::menus::invoke(&mut app, &ctx, "file.close", json!({"document": 2})).unwrap();
        // Another document closes while the prompt is up, shifting the tab to index 1.
        app.run("file.close", json!({"document": 0})).unwrap();
        advance(&mut app, &ctx);
        assert_eq!(app.session.documents().len(), 1);
        assert!(index_of(&app, doomed).is_none());
    }

    #[test]
    fn quitting_replaces_a_pending_close_but_other_requests_are_refused() {
        let mut app = app_with_docs(2);
        make_dirty(&mut app, 0);
        make_dirty(&mut app, 1);
        assert!(intercept(&mut app, "file.close", &json!({"document": 0})));
        assert!(intercept(&mut app, "file.closeAll", &Value::Null));
        assert_eq!(app.discard.as_ref().map(|p| (p.id.as_str(), p.docs.len())), Some(("file.close", 1)));
        assert!(app.ui.status_error);
        assert!(intercept(&mut app, EXIT, &Value::Null));
        assert_eq!(app.discard.as_ref().map(|p| (p.id.as_str(), p.docs.len())), Some((EXIT, 2)));
        // Pressing the window's X again must not restart the questions.
        app.discard.as_mut().unwrap().docs.remove(0);
        assert!(intercept(&mut app, EXIT, &Value::Null));
        assert_eq!(app.discard.as_ref().unwrap().docs.len(), 1);
    }

    #[test]
    fn exit_is_held_back_until_confirmed() {
        let mut app = app_with_docs(1);
        let ctx = egui::Context::default();
        make_dirty(&mut app, 0);
        assert!(intercept(&mut app, EXIT, &Value::Null));
        assert!(!app.allow_close);
        advance(&mut app, &ctx);
        assert!(app.allow_close);
    }

    #[test]
    fn mnemonic_labels_bracket_the_key() {
        assert_eq!(mnemonic("Don't Save", Key::D), "(D)on't Save");
        assert_eq!(mnemonic("Guardar", Key::S), "Guardar (S)");
        assert_eq!(mnemonic("保存", Key::S), "保存 (S)");
    }

    type Prompted = egui_kittest::Harness<'static, PhotosuiteApp>;

    /// The unsaved-changes prompt for Close All over two dirty documents, as `os` draws it.
    fn prompt_on(os: egui::os::OperatingSystem) -> Prompted {
        let mut app = app_with_docs(2);
        make_dirty(&mut app, 0);
        make_dirty(&mut app, 1);
        let mut h = egui_kittest::Harness::builder().with_size(egui::vec2(800.0, 600.0)).build_ui_state(|ui, app| show(app, ui.ctx()), app);
        PhotosuiteApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
        h.ctx.set_os(os);
        assert!(intercept(h.state_mut(), "file.closeAll", &Value::Null));
        h.run_steps(2);
        h
    }

    /// The buttons named `labels`, sorted by where they are drawn, left to right.
    fn drawn_order<'a>(h: &Prompted, labels: [&'a str; 3]) -> Vec<&'a str> {
        use egui_kittest::kittest::Queryable;
        let mut v = labels.map(|l| (h.get_by_label(l).rect().left(), l)).to_vec();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v.into_iter().map(|(_, l)| l).collect()
    }

    /// Tab walks `labels` left to right and wraps; Shift+Tab steps back.
    fn tab_walks(h: &mut Prompted, labels: [&str; 3]) {
        use egui_kittest::kittest::Queryable;
        let focused = |h: &Prompted| labels.into_iter().find(|l| h.get_by_label(l).is_focused());
        for want in [labels[0], labels[1], labels[2], labels[0]] {
            h.key_press(Key::Tab);
            h.run_steps(2);
            assert_eq!(focused(h), Some(want));
        }
        h.key_press_modifiers(egui::Modifiers::SHIFT, Key::Tab);
        h.run_steps(2);
        assert_eq!(focused(h), Some(labels[2]));
    }

    fn docs_left(h: &Prompted) -> Option<usize> {
        h.state().discard.as_ref().map(|p| p.docs.len())
    }

    #[test]
    fn windows_and_linux_ask_yes_no_cancel_with_the_default_first() {
        for os in [egui::os::OperatingSystem::Windows, egui::os::OperatingSystem::Nix] {
            let mut h = prompt_on(os);
            let labels = ["(Y)es", "(N)o", "Cancel"];
            assert_eq!(drawn_order(&h, labels), labels, "{os:?}");
            tab_walks(&mut h, labels);
            h.key_press(Key::N);
            h.run_steps(2);
            assert_eq!(docs_left(&h), Some(1), "N answered the first document");
            // Cancel has no letter here: C does nothing, Esc cancels.
            h.key_press(Key::C);
            h.run_steps(2);
            assert_eq!(docs_left(&h), Some(1));
            h.key_press(Key::Escape);
            h.run_steps(2);
            assert!(h.state().discard.is_none());
            assert_eq!(h.state().session.documents().len(), 2, "Cancel closed nothing");
        }
    }

    #[test]
    fn macos_asks_dont_save_cancel_save_with_the_default_last() {
        let mut h = prompt_on(egui::os::OperatingSystem::Mac);
        let labels = ["(D)on't Save", "(C)ancel", "(S)ave"];
        assert_eq!(drawn_order(&h, labels), labels);
        tab_walks(&mut h, labels);
        h.key_press(Key::D);
        h.run_steps(2);
        assert_eq!(docs_left(&h), Some(1), "D answered the first document");
        h.key_press(Key::C);
        h.run_steps(2);
        assert!(h.state().discard.is_none());
        assert_eq!(h.state().session.documents().len(), 2, "Cancel closed nothing");
    }

    #[test]
    fn enter_takes_the_default_answer_or_the_focused_button() {
        use std::{cell::Cell, rc::Rc};
        let mut h = prompt_on(egui::os::OperatingSystem::Windows);
        let asked = Rc::new(Cell::new(false));
        let seen = asked.clone();
        // Backing out of the save dialog keeps the prompt.
        h.state_mut().services.pick_save = Some(Box::new(move |_| {
            seen.set(true);
            None
        }));
        h.key_press(Key::Enter);
        h.run_steps(2);
        assert!(asked.get(), "Enter answered Yes, which saves");
        assert_eq!(docs_left(&h), Some(2));
        // Tab to No: Enter now presses it.
        for _ in 0..2 {
            h.key_press(Key::Tab);
            h.run_steps(2);
        }
        asked.set(false);
        h.key_press(Key::Enter);
        h.run_steps(2);
        assert!(!asked.get());
        assert_eq!(docs_left(&h), Some(1), "Enter pressed the focused No");
    }

    /// One frame with the window's close button pressed; whether the guard cancelled the close.
    fn press_window_close(app: &mut PhotosuiteApp) -> bool {
        let mut info = egui::ViewportInfo::default();
        info.events.push(egui::ViewportEvent::Close);
        let mut input = egui::RawInput::default();
        input.viewports.insert(egui::ViewportId::ROOT, info);
        let mut out = egui::Context::default().run_ui(input, |ui| guard_window_close(app, ui.ctx()));
        out.textures_delta.clear();
        let commands = &out.viewport_output[&egui::ViewportId::ROOT].commands;
        let cancelled = commands.iter().any(|c| matches!(c, egui::ViewportCommand::CancelClose));
        assert_eq!(commands.iter().any(|c| matches!(c, egui::ViewportCommand::Focus)), cancelled);
        cancelled
    }

    #[test]
    fn window_close_is_cancelled_while_work_is_unsaved() {
        let mut app = app_with_docs(1);
        make_dirty(&mut app, 0);
        assert!(press_window_close(&mut app));
        assert!(app.discard.is_some());
    }

    #[test]
    fn window_close_goes_through_when_nothing_is_unsaved_or_it_was_confirmed() {
        let mut app = app_with_docs(1);
        assert!(!press_window_close(&mut app));
        make_dirty(&mut app, 0);
        app.allow_close = true;
        assert!(!press_window_close(&mut app));
        assert!(app.discard.is_none());
    }
}
